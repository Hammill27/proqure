// Serverless function: sends email via Resend using a central API key.
// The key lives in the Vercel environment variable RESEND_API_KEY and is never
// exposed to the browser.
//
// Supports the decided email model:
//   from        - "Display Name <quotes@proqure.co.uk>" (ProQure domain, business display name)
//   reply_to    - the user's own inbox, so supplier replies reach them
//   html        - the branded ProQure email template (falls back to text if absent)
//   attachments - optional array of { filename, content } where content is base64
//                 (used to attach the PO PDF to purchase-order emails)
//
// NOTE: the "from" domain (proqure.co.uk) must be verified in Resend to deliver.

import { createClient } from "@supabase/supabase-js";

// Caller verification: this endpoint sends mail from ProQure's own domain with a
// central key, so left open it is an open relay (anyone could spam AS proqure.co.uk
// and torch the domain's reputation). With the Supabase env present, a valid
// signed-in session is required and the company tag is resolved server-side from
// membership. Without the env, behaviour falls back to the previous open mode.
const SB_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
const SB_ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbAnon = (SB_URL && SB_ANON) ? createClient(SB_URL, SB_ANON, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const sbAdmin = (SB_URL && SB_SERVICE) ? createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } }) : null;
// Only these envelope addresses may ever be used in "from".
const ALLOWED_FROM = ["quotes@proqure.co.uk", "orders@proqure.co.uk", "support@proqure.co.uk"];

async function verifyCaller(req, requestedCompanyId) {
  if (!sbAnon) return { mode: "open" };
  const h = req.headers.authorization || req.headers.Authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : null;
  if (!token) return { mode: "deny" };
  try {
    const { data, error } = await sbAnon.auth.getUser(token);
    if (error || !data || !data.user) return { mode: "deny" };
    const uid = data.user.id;
    // Attribute the send to the company the caller is ACTING IN (passed by the client),
    // confirmed against membership - so a multi-company identity's email usage lands on the
    // right tenant. Fall back to their first membership if none is passed (older client).
    const want = (requestedCompanyId && typeof requestedCompanyId === "string") ? requestedCompanyId.trim() : "";
    let companyId = uid;
    if (sbAdmin) {
      if (want && want !== uid) {
        try {
          const { data: m } = await sbAdmin.from("members").select("company_id").eq("user_id", uid).eq("company_id", want).limit(1).maybeSingle();
          if (m && m.company_id) companyId = want;
          else return { mode: "deny" };
        } catch (e) { /* fall back to uid */ }
      } else if (!want) {
        try {
          const { data: m } = await sbAdmin.from("members").select("company_id").eq("user_id", uid).limit(1).maybeSingle();
          if (m && m.company_id) companyId = m.company_id;
        } catch (e) { /* fall back to uid */ }
      }
    }
    return { mode: "ok", companyId };
  } catch (e) { return { mode: "deny" }; }
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { to, subject, text, html, from, reply_to, attachments, company_id } = req.body || {};

  if (!from || !to || !subject) {
    return res.status(400).json({ error: "Missing from, to, or subject" });
  }

  // 1) Caller must be a signed-in ProQure user. This endpoint sends from a
  //    reputation-critical domain, so unlike the AI proxy it FAILS CLOSED: if
  //    verification isn't configured (no anon key), we refuse rather than revert
  //    to an open relay.
  const who = await verifyCaller(req, company_id);
  if (who.mode !== "ok") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const msg = who.mode === "open"
      ? "Email sending is not configured (missing auth)."
      : "Please sign in to send email.";
    return res.status(who.mode === "open" ? 500 : 401).json({ error: msg });
  }
  // 2) The envelope address must be one of ProQure's own (display name is free).
  const addrMatch = String(from).match(/<([^>]+)>/);
  const fromAddr = (addrMatch ? addrMatch[1] : String(from)).trim().toLowerCase();
  if (!ALLOWED_FROM.includes(fromAddr)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(400).json({ error: "Unsupported from address." });
  }
  // 3) Validate + cap recipients so a real account can't be used to blast mail.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const toList = (Array.isArray(to) ? to : [to])
    .map(x => String(x || "").trim())
    .filter(Boolean);
  if (!toList.length || toList.length > 25 || !toList.every(e => EMAIL_RE.test(e))) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(400).json({ error: "Invalid or too many recipients (max 25)." });
  }
  // reply_to, if present, must be a single valid address.
  let replyToClean;
  if (reply_to != null && reply_to !== "") {
    replyToClean = String(reply_to).trim();
    if (!EMAIL_RE.test(replyToClean)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(400).json({ error: "Invalid reply-to address." });
    }
  }
  // 4) Attribute the send to the VERIFIED company, not whatever the body claims.
  const effectiveCompany = who.companyId;

  try {
    // Build payload; only include optional fields when present.
    const payload = {
      from,
      to: toList,
      subject,
    };
    if (text) payload.text = text;
    if (html) payload.html = html;
    if (replyToClean) payload.reply_to = replyToClean;

    // Tag the send with the company id so the Resend webhook can attribute
    // delivered/bounced/complained events per company. Resend tags allow only
    // [A-Za-z0-9_-]; a UUID passes cleanly.
    if (effectiveCompany && typeof effectiveCompany === "string") {
      const v = effectiveCompany.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
      if (v) payload.tags = [{ name: "company_id", value: v }];
    }

    // Attachments: Resend expects [{ filename, content }] with content as a
    // base64 string. We pass through only well-formed entries and cap the count
    // and size defensively so a malformed client call can't wedge the request.
    if (Array.isArray(attachments) && attachments.length) {
      const clean = attachments
        .filter(a => a && a.filename && typeof a.content === "string" && a.content.length)
        .slice(0, 5)
        .map(a => ({ filename: String(a.filename).slice(0, 200), content: a.content }));
      if (clean.length) payload.attachments = clean;
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (!response.ok) {
      console.error("send-email: Resend rejected", { status: response.status, from: fromAddr, to: toList.length, error: data && data.message });
      return res.status(response.status).json({ error: data.message || "Resend error" });
    }
    return res.status(200).json({ id: data.id, success: true });
  } catch (err) {
    console.error("send-email: exception", err && err.message);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: err.message });
  }
}
