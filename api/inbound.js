// Serverless function: receives inbound supplier replies from Resend and files them
// into the matching supplier's quote box in Supabase.
//
// Flow: a supplier replies to q-<token>@<inbound-domain>  ->  Resend parses the email
// and POSTs an `email.received` event here  ->  we verify it's genuinely from Resend,
// retrieve the full body, match <token> back to the exact supplier + request that was
// sent that reply address, and write the reply text into that supplier's quote box.
// Best-effort: also forwards a copy to the user's own inbox so they still see replies.
//
// The capture domain is a CATCH-ALL, so this same endpoint serves every client and
// every job - the token in the address is what routes it. Switching the test
// ".resend.app" address for a live "reply.proqure.co.uk" subdomain later needs NO
// change here.
//
// Verification: Resend signs webhooks with the Svix scheme. We verify it manually with
// Node's built-in crypto (no SDK, no svix dependency) so it can't break on library or
// version differences. If you ever need to prove the rest of the pipeline while sorting
// the signing secret, set INBOUND_SKIP_VERIFY=1 in Vercel TEMPORARILY - it processes
// unverified events and logs loudly. Remove it once verification passes.
//
// Required Vercel env vars (server-only - never exposed to the browser):
//   RESEND_API_KEY            - same key used for sending
//   RESEND_WEBHOOK_SECRET     - signing secret from the webhook (whsec_...)
//   SUPABASE_URL              - Supabase project URL (falls back to VITE_SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY - service/secret key (server-only; bypasses RLS to write)

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// We need the RAW request body to verify the signature, so disable Vercel's parser.
export const config = { api: { bodyParser: false } };

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || "";
const SKIP_VERIFY = process.env.INBOUND_SKIP_VERIFY === "1";
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = (SUPABASE_URL && SERVICE_KEY) ? createClient(SUPABASE_URL, SERVICE_KEY) : null;

// Read the raw body robustly across Vercel parsing behaviours.
async function readRaw(req) {
  if (Buffer.isBuffer(req.body)) return { raw: req.body.toString("utf8"), src: "buffer" };
  if (typeof req.body === "string") return { raw: req.body, src: "string" };
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw) return { raw, src: "stream" };
  } catch (e) { /* fall through */ }
  if (req.body && typeof req.body === "object") return { raw: JSON.stringify(req.body), src: "json-fallback" };
  return { raw: "", src: "empty" };
}

// Verify the Svix signature with HMAC-SHA256 (no external library).
function verifySvix(raw, headers, secret) {
  const id = headers["svix-id"] || headers["webhook-id"];
  const ts = headers["svix-timestamp"] || headers["webhook-timestamp"];
  const sigHeader = headers["svix-signature"] || headers["webhook-signature"];
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  if (!id || !ts || !sigHeader) return { ok: false, reason: "missing svix headers" };
  const key = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let secretBytes;
  try { secretBytes = Buffer.from(key, "base64"); } catch { return { ok: false, reason: "secret not base64" }; }
  const expected = crypto.createHmac("sha256", secretBytes).update(`${id}.${ts}.${raw}`).digest("base64");
  const provided = String(sigHeader).split(" ").map((p) => (p.includes(",") ? p.split(",")[1] : p));
  const ok = provided.some((p) => {
    try { return p.length === expected.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(expected)); }
    catch { return false; }
  });
  return { ok, reason: ok ? "ok" : "signature mismatch" };
}

// Retrieve the full parsed inbound email (the webhook payload is metadata only).
async function getEmail(emailId) {
  try {
    const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    });
    if (r.ok) { const j = await r.json(); return j && j.data ? j.data : j; }
    console.warn("api/inbound: receiving GET status", r.status);
  } catch (e) {
    console.warn("api/inbound: receiving GET failed", e && e.message);
  }
  return null;
}

// Plain-text body from the email (prefer text; strip HTML if that's all there is).
function bodyText(email) {
  if (email && typeof email.text === "string" && email.text.trim()) return email.text;
  const html = (email && email.html) || "";
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Trim the quoted original email from a reply, keeping only the supplier's new text.
// Conservative: only cuts at a confident divider; if none is found it returns the text
// unchanged, so a genuine reply is never lost. Also won't over-cut to near-nothing.
function stripQuotedReply(text) {
  if (!text) return text;
  const lines = text.split("\n");
  const markers = [
    /^_{5,}\s*$/,                              // Outlook underscore divider
    /^\s*-{2,}\s*Original Message\s*-{2,}/i,   // "-----Original Message-----"
    /^\s*On\b.+\bwrote:/i,                     // Gmail/Apple "On <date> <name> wrote:"
    /^\s*From:\s.*@/i,                         // quoted header block "From: name <a@b>"
    /^\s*Sent with ProQure\b/i,                // our own footer (safety net)
    /^\s*\[ProQure-Ref:/i,                     // our hidden ref (safety net)
  ];
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    if (markers.some((re) => re.test(lines[i]))) { cut = i; break; }
  }
  if (cut === -1) return text.trim();
  const kept = lines.slice(0, cut).join("\n").trim();
  return kept.length >= 3 ? kept : text.trim();
}

// Extract our capture token from any recipient address: q-<token>@<domain>.
function extractToken(toField) {
  const list = Array.isArray(toField) ? toField : [toField];
  for (const entry of list) {
    let addr = "";
    if (entry && typeof entry === "object") addr = entry.address || entry.email || entry.to || "";
    else addr = entry || "";
    const m = String(addr).toLowerCase().match(/q-([a-z0-9]+)@/);
    if (m) return m[1];
  }
  return null;
}

async function forwardCopy(inbox, supName, fromAddr, subject, replyText) {
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "ProQure <quotes@proqure.co.uk>",
        to: [inbox],
        reply_to: fromAddr,
        subject: `[ProQure] Supplier reply: ${subject || supName || "quote"}`,
        text: `${supName || fromAddr} has replied to your quote request. It's been added to the quote box in ProQure.\n\n${replyText || ""}`,
      }),
    });
  } catch (e) { console.warn("api/inbound: forward failed (non-fatal)", e && e.message); }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { raw, src } = await readRaw(req);
  console.log("api/inbound: POST received | rawLen", raw.length, "| src", src);

  let event;
  try { event = JSON.parse(raw); } catch { console.error("api/inbound: bad JSON | rawLen", raw.length, "| src", src); return res.status(400).json({ error: "Bad JSON" }); }

  if (!SKIP_VERIFY) {
    const v = verifySvix(raw, req.headers, WEBHOOK_SECRET);
    if (!v.ok) {
      console.error("api/inbound: signature verify FAILED -", v.reason, "| rawLen", raw.length, "| src", src);
      return res.status(401).json({ error: "Invalid signature", reason: v.reason });
    }
    console.log("api/inbound: signature verified ok");
  } else {
    console.warn("api/inbound: INBOUND_SKIP_VERIFY=1 - processing WITHOUT signature verification");
  }

  if (!event || event.type !== "email.received") return res.status(200).json({ ok: true, note: "ignored type" });

  try {
    const data = event.data || {};
    const emailId = data.email_id || data.id;
    let email = emailId ? await getEmail(emailId) : null;
    if (!email) email = data;

    const token = extractToken((email && email.to) || data.to);
    console.log("api/inbound: emailId", emailId, "| token", token);
    if (!token) return res.status(200).json({ ok: true, note: "no capture token" });
    if (!supabase) { console.error("api/inbound: Supabase not configured (URL / SERVICE key)"); return res.status(200).json({ ok: true, note: "storage not configured" }); }

    const replyText = stripQuotedReply(bodyText(email));
    console.log("api/inbound: bodyTextLen", (replyText || "").length);
    const fromAddr = (email && email.from) || data.from || "supplier";
    const subject = (email && email.subject) || data.subject || "";

    const { data: rows, error } = await supabase.from("proqure_data").select("user_id,value").eq("store_key", "piq_requests");
    if (error) { console.error("api/inbound: load error", error.message); return res.status(200).json({ ok: true }); }

    let target = null;
    for (const row of (rows || [])) {
      const requests = Array.isArray(row.value) ? row.value : [];
      for (let ri = 0; ri < requests.length; ri++) {
        const sentTo = (requests[ri] && requests[ri].sentTo) || [];
        const si = sentTo.findIndex((s) => s && s.replyToken && s.replyToken === token);
        if (si !== -1) { target = { userId: row.user_id, requests, ri, si }; break; }
      }
      if (target) break;
    }
    if (!target) { console.warn("api/inbound: token not matched -", token); return res.status(200).json({ ok: true, note: "token not matched" }); }

    const { userId, requests, ri, si } = target;
    const sup = requests[ri].sentTo[si];
    const stamp = new Date().toISOString();
    const header = `--- Reply from ${sup.name || fromAddr}${subject ? ` (re: ${subject})` : ""} received ${new Date().toLocaleString("en-GB")} ---\n`;
    sup.quote = (sup.quote && sup.quote.trim() ? sup.quote + "\n\n" : "") + header + (replyText || "(no readable text in reply)");
    sup.saved = true;
    sup.replyReceivedAt = stamp;
    requests[ri].sentTo[si] = sup;
    requests[ri].activity = [
      ...(requests[ri].activity || []),
      { ts: stamp, action: "Supplier reply captured", detail: `${sup.name || fromAddr} replied - dropped into the quote box`, user: "Inbound" },
    ];

    const { error: upErr } = await supabase.from("proqure_data").upsert({ user_id: userId, store_key: "piq_requests", value: requests, updated_at: stamp }, { onConflict: "user_id,store_key" });
    if (upErr) { console.error("api/inbound: save error", upErr.message); return res.status(200).json({ ok: true }); }
    console.log("api/inbound: MATCHED & SAVED | user", userId, "| req", ri, "| supplier", si);

    try {
      const { data: sRows } = await supabase.from("proqure_data").select("value").eq("store_key", "piq_settings").eq("user_id", userId).limit(1);
      const settings = (sRows && sRows[0]) ? sRows[0].value : null;
      const inbox = settings && (settings.replyToEmail || settings.fromEmail);
      if (inbox) await forwardCopy(inbox, sup.name, fromAddr, subject, replyText);
    } catch (e) { console.warn("api/inbound: forward lookup failed", e && e.message); }

    return res.status(200).json({ ok: true, matched: true });
  } catch (e) {
    console.error("api/inbound: handler error", e && e.message);
    return res.status(200).json({ ok: true });
  }
}
