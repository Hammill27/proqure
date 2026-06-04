// Serverless function: receives inbound supplier replies from Resend and files them
// into the matching supplier's quote box in Supabase.
//
// Flow: a supplier replies to q-<token>@<inbound-domain>  ->  Resend parses the email
// and POSTs an `email.received` event here  ->  we verify it's genuinely from Resend,
// fetch the full body, match <token> back to the exact supplier + request that was sent
// that reply address, and write the reply text into that supplier's quote box.
// Best-effort: also forwards a copy to the user's own inbox so they still see replies.
//
// The capture domain is a CATCH-ALL, so this same endpoint serves every client and
// every job - the token in the address is what routes it. Nothing here is tied to a
// specific domain, so switching the test ".resend.app" address for a live
// "reply.proqure.co.uk" subdomain later needs no change in this file.
//
// Required Vercel env vars (server-only - never exposed to the browser):
//   RESEND_API_KEY            - same key used for sending
//   RESEND_WEBHOOK_SECRET     - signing secret from the webhook (whsec_...)
//   SUPABASE_URL              - Supabase project URL (falls back to VITE_SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY - service-role key (server-only; bypasses RLS to write)
//
// The email.received payload is metadata only, so the body is retrieved via the
// Received Emails API (resend.emails.receiving.get).

import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

// Vercel: we need the RAW request body to verify the webhook signature, so the
// built-in JSON body parser must be disabled for this route.
export const config = { api: { bodyParser: false } };

const resend = new Resend(process.env.RESEND_API_KEY);
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = (SUPABASE_URL && SERVICE_KEY) ? createClient(SUPABASE_URL, SERVICE_KEY) : null;

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Pull a plain-text body out of the retrieved email (prefer text; strip HTML if not).
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

// Extract our capture token from any recipient address: q-<token>@<domain>.
// Handles a "to" field that's a string, an array of strings, or an array of objects.
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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let raw = "";
  try { raw = await readRaw(req); } catch { return res.status(400).json({ error: "No body" }); }

  // Verify the webhook is genuinely from Resend (svix signature). If no secret is
  // configured yet (early testing), proceed but log a warning.
  let event;
  if (process.env.RESEND_WEBHOOK_SECRET) {
    try {
      event = resend.webhooks.verify({
        payload: raw,
        headers: {
          "svix-id": req.headers["svix-id"],
          "svix-timestamp": req.headers["svix-timestamp"],
          "svix-signature": req.headers["svix-signature"],
        },
        secret: process.env.RESEND_WEBHOOK_SECRET,
      });
    } catch (e) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  } else {
    try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: "Bad JSON" }); }
    console.warn("api/inbound: RESEND_WEBHOOK_SECRET not set - skipping signature verification");
  }

  // Only act on inbound emails; acknowledge everything else so Resend doesn't retry.
  if (!event || event.type !== "email.received") return res.status(200).json({ ok: true });

  try {
    const data = event.data || {};
    const emailId = data.email_id || data.id;
    if (!emailId) return res.status(200).json({ ok: true, note: "no email id" });

    // The webhook is metadata-only; fetch the full parsed email for its body.
    let email;
    try {
      const got = await resend.emails.receiving.get(emailId);
      email = (got && got.data) ? got.data : got;
    } catch (e) {
      email = data; // fall back to whatever metadata the event carried
    }

    const token = extractToken((email && email.to) || data.to);
    if (!token) return res.status(200).json({ ok: true, note: "no capture token" });

    if (!supabase) {
      console.error("api/inbound: Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
      return res.status(200).json({ ok: true, note: "storage not configured" });
    }

    const replyText = bodyText(email);
    const fromAddr = (email && email.from) || data.from || "supplier";
    const subject = (email && email.subject) || data.subject || "";

    // Find which user's requests contain a supplier with this reply token.
    const { data: rows, error } = await supabase
      .from("proqure_data")
      .select("user_id,value")
      .eq("store_key", "piq_requests");
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

    if (!target) return res.status(200).json({ ok: true, note: "token not matched" });

    // Append the reply into that supplier's quote box and mark it received.
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

    const { error: upErr } = await supabase
      .from("proqure_data")
      .upsert({ user_id: userId, store_key: "piq_requests", value: requests, updated_at: stamp }, { onConflict: "user_id,store_key" });
    if (upErr) { console.error("api/inbound: save error", upErr.message); return res.status(200).json({ ok: true }); }

    // Best-effort: forward a copy to the user's own inbox so they still see replies.
    try {
      const { data: sRows } = await supabase
        .from("proqure_data")
        .select("value")
        .eq("store_key", "piq_settings")
        .eq("user_id", userId)
        .limit(1);
      const settings = (sRows && sRows[0]) ? sRows[0].value : null;
      const inbox = settings && (settings.replyToEmail || settings.fromEmail);
      if (inbox) {
        await resend.emails.send({
          from: "ProQure <quotes@proqure.co.uk>",
          to: [inbox],
          reply_to: fromAddr,
          subject: `[ProQure] Supplier reply: ${subject || sup.name || "quote"}`,
          text: `${sup.name || fromAddr} has replied to your quote request. It's been added to the quote box in ProQure.\n\n${replyText || ""}`,
        });
      }
    } catch (e) {
      console.warn("api/inbound: forward failed (non-fatal)", e && e.message);
    }

    return res.status(200).json({ ok: true, matched: true });
  } catch (e) {
    console.error("api/inbound: handler error", e && e.message);
    // Still ack with 200 so Resend doesn't hammer retries on a transient bug - logged above.
    return res.status(200).json({ ok: true });
  }
}
