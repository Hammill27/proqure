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
// Debug escape hatch for signature issues - HARD-DISABLED in production so a stray
// env var can never make the live deploy process unverified inbound mail.
const SKIP_VERIFY = process.env.INBOUND_SKIP_VERIFY === "1" && process.env.VERCEL_ENV !== "production";
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

// Support-ticket reply token: customers reply to s-<token>@<capture-domain>.
function extractSupportToken(toField) {
  const list = Array.isArray(toField) ? toField : [toField];
  for (const entry of list) {
    let addr = "";
    if (entry && typeof entry === "object") addr = entry.address || entry.email || entry.to || "";
    else addr = entry || "";
    const m = String(addr).toLowerCase().match(/s-([a-z0-9]+)@/);
    if (m) return m[1];
  }
  return null;
}

// Pull the bare email address out of a "Name <addr@x>" string.
function extractEmail(str) {
  const m = String(str || "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return m ? m[0] : "";
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

// ---- supplier quote attachments (PDF / Excel / CSV / image) -----------------
// Inbound webhook payloads carry attachment METADATA only; the bytes are fetched
// from Resend. We pull the quote documents a supplier attaches and store them on
// the supplier's sentTo entry so they show in the quote box. Base64 in-record
// (capped) keeps it dependency-free and matches the app's existing file handling.
const ATT_MAX = 4 * 1024 * 1024; // 4MB per file cap for base64-in-record
function isQuoteAttachment(type, name) {
  type = (type || "").toLowerCase(); name = (name || "").toLowerCase();
  if (/pdf|excel|spreadsheet|csv|image\//.test(type)) return true;
  return /\.(pdf|xls|xlsx|csv|png|jpe?g|webp)$/.test(name);
}
// Fetch attachment bytes, with an SSRF guard: only https, and never a private/
// internal host. The attachment URLs come from Resend's verified payload, but we
// defend in depth in case a field is influenced by the sender.
function safeFetchUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1") return false;
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return false;
    if (h.endsWith(".internal") || h.endsWith(".local")) return false;
    // Reject IP-literal and non-DNS hosts: closes the IPv6 (incl. ::ffff: mapped, fe80::, fd00::)
    // and decimal/hex/octal IP encodings that bypass the dotted-decimal string checks above.
    // Legitimate attachment hosts are named https domains, which always contain a letter.
    if (h.includes(":")) return false;            // IPv6 literal
    if (/^0x/i.test(h)) return false;             // hex-encoded IP
    if (!/[a-z]/.test(h)) return false;           // all-numeric (dotted/decimal/octal) -> not a hostname
    return true;
  } catch { return false; }
}
async function bytesFromUrl(url) {
  if (!safeFetchUrl(url)) return null;
  try { const r = await fetch(url); if (!r.ok) return null; return Buffer.from(await r.arrayBuffer()); }
  catch { return null; }
}
async function fetchQuoteAttachments(emailId, email) {
  let list = Array.isArray(email && email.attachments) ? email.attachments.slice() : [];
  // If the receiving object didn't include attachments, ask the attachments API.
  if (!list.length && emailId && RESEND_API_KEY) {
    try {
      const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}/attachments`, { headers: { Authorization: `Bearer ${RESEND_API_KEY}` } });
      if (r.ok) { const j = await r.json(); const d = (j && (j.data || j)) || []; list = Array.isArray(d) ? d : []; }
    } catch { /* ignore */ }
  }
  const out = [];
  for (const a of list) {
    const name = a.filename || a.name || "attachment";
    const type = a.content_type || a.contentType || "";
    if (!isQuoteAttachment(type, name)) continue;
    let bytes = null;
    try {
      if (a.content) bytes = Buffer.from(a.content, "base64");
      else if (a.download_url || a.url) bytes = await bytesFromUrl(a.download_url || a.url);
      else if (a.id && emailId && RESEND_API_KEY) {
        const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}/attachments/${a.id}`, { headers: { Authorization: `Bearer ${RESEND_API_KEY}` } });
        if (r.ok) { const j = await r.json(); const d = (j && j.data) || j; if (d && d.content) bytes = Buffer.from(d.content, "base64"); else if (d && (d.download_url || d.url)) bytes = await bytesFromUrl(d.download_url || d.url); }
      }
    } catch { /* skip this one */ }
    const size = bytes ? bytes.length : Number(a.size || 0);
    if (!bytes) { out.push({ name, type, size, dataUrl: null, note: "fetch failed" }); continue; }
    if (size > ATT_MAX) { out.push({ name, type, size, dataUrl: null, tooLarge: true }); continue; }
    out.push({ name, type, size, dataUrl: `data:${type || "application/octet-stream"};base64,${bytes.toString("base64")}`, receivedAt: new Date().toISOString(), extracted: false });
  }
  return out;
}

const STATS_KEY = "piq_email_stats";
const EVENTS_KEY = "piq_email_events";
const PLATFORM_BUCKET = "platform-email";
const EVENTS_CAP = 200;

// Metadata-only observability writes. These never carry subjects or body/quote text —
// only counts, the supplier address, a matched-by flag and an attachment count. They
// must never block reply capture, so all errors are swallowed.
async function bumpStat(companyId, fields) {
  if (!supabase) return;
  // Atomic path: row-locked increments so concurrent inbound events can't lose a count.
  try {
    const { error } = await supabase.rpc("proqure_stats_bump", { p_company: companyId, p_key: STATS_KEY, p_fields: fields });
    if (!error) return;
  } catch (e) { /* fall through to legacy path */ }
  try {
    const { data } = await supabase.from("proqure_data").select("value").eq("user_id", companyId).eq("store_key", STATS_KEY).maybeSingle();
    const v = (data && data.value) || {};
    for (const [k, n] of Object.entries(fields)) v[k] = Number(v[k] || 0) + Number(n || 0);
    v.lastEventAt = new Date().toISOString();
    await supabase.from("proqure_data").upsert({ user_id: companyId, store_key: STATS_KEY, value: v, updated_at: v.lastEventAt }, { onConflict: "user_id,store_key" });
  } catch (e) { /* non-fatal */ }
}
async function pushEvent(companyId, evt) {
  if (!supabase) return;
  const event = { ts: new Date().toISOString(), ...evt };
  try {
    const { error } = await supabase.rpc("proqure_event_push", { p_company: companyId, p_key: EVENTS_KEY, p_event: event, p_cap: EVENTS_CAP });
    if (!error) return;
  } catch (e) { /* fall through to legacy path */ }
  try {
    const { data } = await supabase.from("proqure_data").select("value").eq("user_id", companyId).eq("store_key", EVENTS_KEY).maybeSingle();
    const log = Array.isArray(data && data.value) ? data.value : [];
    log.push(event);
    await supabase.from("proqure_data").upsert({ user_id: companyId, store_key: EVENTS_KEY, value: log.slice(-EVENTS_CAP), updated_at: new Date().toISOString() }, { onConflict: "user_id,store_key" });
  } catch (e) { /* non-fatal */ }
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
    const attN = Array.isArray(email && email.attachments) ? email.attachments.length : 0;

    const token = extractToken((email && email.to) || data.to);
    if (!supabase) { console.error("api/inbound: Supabase not configured (URL / SERVICE key)"); return res.status(200).json({ ok: true, note: "storage not configured" }); }

    const replyText = stripQuotedReply(bodyText(email));
    const fromAddr = (email && email.from) || data.from || "supplier";
    const fromEmail = extractEmail(fromAddr);
    const subject = (email && email.subject) || data.subject || "";
    console.log("api/inbound: emailId", emailId, "| token", token, "| from", fromEmail, "| bodyLen", (replyText || "").length);

    // --- Support-ticket replies (s-<token>@<capture-domain>) ---------------------
    // A customer replying to one of our support emails lands here. Match the token to
    // the ticket and append their message to the thread so it shows in the admin
    // Support tab and flips the ticket back to "open".
    const supTok = extractSupportToken((email && email.to) || data.to);
    if (supTok) {
      try {
        const { data: fbRows, error: fbErr } = await supabase.from("proqure_data").select("user_id,value").eq("store_key", "piq_feedback");
        if (fbErr) { console.error("api/inbound: feedback load error", fbErr.message); return res.status(200).json({ ok: true }); }
        let hit = null;
        for (const row of (fbRows || [])) {
          const list = Array.isArray(row.value) ? row.value : [];
          const ix = list.findIndex((t) => t && t.replyToken === supTok);
          if (ix !== -1) { hit = { userId: row.user_id, list, ix }; break; }
        }
        if (!hit) { console.warn("api/inbound: support reply not matched - token", supTok, "from", fromEmail); return res.status(200).json({ ok: true, note: "support not matched" }); }
        // Re-read fresh immediately before writing so a concurrent admin reply isn't lost.
        let wList = hit.list, wIx = hit.ix;
        try {
          const { data: fresh } = await supabase.from("proqure_data").select("value").eq("user_id", hit.userId).eq("store_key", "piq_feedback").maybeSingle();
          const fl = Array.isArray(fresh && fresh.value) ? fresh.value : null;
          if (fl) { const fi = fl.findIndex((t) => t && t.replyToken === supTok); if (fi !== -1) { wList = fl; wIx = fi; } }
        } catch (e) { /* fall back to scanned copy */ }
        const t = wList[wIx];
        if (!Array.isArray(t.replies)) t.replies = t.reply ? [t.reply] : [];
        delete t.reply;
        t.replies = [...t.replies, { ts: new Date().toISOString(), by: fromEmail || "customer", dir: "in", message: replyText || "(no readable text in reply)" }];
        t.status = "open";
        t.updatedAt = new Date().toISOString();
        wList[wIx] = t;
        const { error: upErr } = await supabase.from("proqure_data").upsert({ user_id: hit.userId, store_key: "piq_feedback", value: wList, updated_at: t.updatedAt }, { onConflict: "user_id,store_key" });
        if (upErr) { console.error("api/inbound: support save error", upErr.message); return res.status(200).json({ ok: true }); }
        console.log("api/inbound: SUPPORT reply filed | ticket", t.ref || t.id, "| from", fromEmail);
      } catch (e) { console.error("api/inbound: support handler error", e && e.message); }
      return res.status(200).json({ ok: true, support: true });
    }

    const { data: rows, error } = await supabase.from("proqure_data").select("user_id,value").eq("store_key", "piq_requests");
    if (error) { console.error("api/inbound: load error", error.message); return res.status(200).json({ ok: true }); }

    // 1) Preferred: match the unique per-supplier reply token (q-<token>@...).
    let target = null, matchedBy = "token";
    if (token) {
      for (const row of (rows || [])) {
        const requests = Array.isArray(row.value) ? row.value : [];
        for (let ri = 0; ri < requests.length; ri++) {
          const sentTo = (requests[ri] && requests[ri].sentTo) || [];
          const si = sentTo.findIndex((s) => s && s.replyToken && s.replyToken === token);
          if (si !== -1) { target = { userId: row.user_id, requests, ri, si }; break; }
        }
        if (target) break;
      }
    }
    // 2) Fallback: some mail clients reply to the visible From address instead of our
    //    unique Reply-To, so the token is lost. Match the sender's email address against
    //    a supplier we sent this job to - preferring a request still awaiting that
    //    supplier's reply, then the most recent. Never guesses: only an exact email match.
    if (!target && fromEmail) {
      let best = null;
      for (const row of (rows || [])) {
        const requests = Array.isArray(row.value) ? row.value : [];
        for (let ri = 0; ri < requests.length; ri++) {
          const sentTo = (requests[ri] && requests[ri].sentTo) || [];
          for (let si = 0; si < sentTo.length; si++) {
            const s = sentTo[si];
            const addr = extractEmail((s && (s.email || s.contactEmail)) || "");
            if (addr && addr === fromEmail) {
              const sentAt = new Date(requests[ri].created || requests[ri].sentAt || 0).getTime();
              const score = (s && s.replyReceivedAt ? 0 : 1e15) + sentAt;
              if (!best || score > best.score) best = { userId: row.user_id, requests, ri, si, score };
            }
          }
        }
      }
      if (best) { target = best; matchedBy = "sender address"; }
    }
    if (!target) { console.warn("api/inbound: not matched - token", token, "from", fromEmail); await bumpStat(PLATFORM_BUCKET, { receivedUnmatched: 1 }); await pushEvent(PLATFORM_BUCKET, { type: "received-unmatched", from: fromEmail, att: attN }); return res.status(200).json({ ok: true, note: "not matched" }); }

    const { userId, requests, ri, si } = target;

    // Fetch attachments BEFORE the write so the slow network work (can be seconds)
    // sits outside the read-modify-write window.
    const quoteAtts = await fetchQuoteAttachments(emailId, email);

    // Re-read this user's row FRESH immediately before writing. The scan above may be
    // seconds old by now; if the user edited their requests in the app meanwhile, a
    // write based on the stale copy would silently drop their change (or this reply).
    // Re-locate the matched supplier entry in the fresh copy — by reply token first,
    // then by request id + supplier email. If anything about the re-read fails, fall
    // back to the original scanned copy so a reply is never lost.
    let wRequests = requests, wRi = ri, wSi = si;
    try {
      const { data: freshRow } = await supabase.from("proqure_data")
        .select("value").eq("user_id", userId).eq("store_key", "piq_requests").maybeSingle();
      const fresh = Array.isArray(freshRow && freshRow.value) ? freshRow.value : null;
      if (fresh) {
        const origReq = requests[ri] || {};
        const origSup = (origReq.sentTo || [])[si] || {};
        const origTok = origSup.replyToken || null;
        const origEmail = extractEmail(origSup.email || origSup.contactEmail || "");
        let fri = -1, fsi = -1;
        for (let i = 0; i < fresh.length && fri === -1; i++) {
          const st = (fresh[i] && fresh[i].sentTo) || [];
          for (let j = 0; j < st.length; j++) {
            const s = st[j] || {};
            const tokMatch = origTok && s.replyToken === origTok;
            const idMatch = origReq.id != null && fresh[i].id === origReq.id &&
              origEmail && extractEmail(s.email || s.contactEmail || "") === origEmail;
            if (tokMatch || idMatch) { fri = i; fsi = j; break; }
          }
        }
        if (fri !== -1) { wRequests = fresh; wRi = fri; wSi = fsi; }
      }
    } catch (e) { /* fall back to the scanned copy */ }

    const sup = wRequests[wRi].sentTo[wSi];
    const stamp = new Date().toISOString();
    const header = `--- Reply from ${sup.name || fromAddr}${subject ? ` (re: ${subject})` : ""} received ${new Date().toLocaleString("en-GB")} ---\n`;
    sup.quote = (sup.quote && sup.quote.trim() ? sup.quote + "\n\n" : "") + header + (replyText || "(no readable text in reply)");
    sup.saved = true;
    sup.replyReceivedAt = stamp;
    if (quoteAtts.length) sup.attachments = [...(Array.isArray(sup.attachments) ? sup.attachments : []), ...quoteAtts];
    const keptAtts = quoteAtts.filter(a => a.dataUrl).length;
    wRequests[wRi].sentTo[wSi] = sup;
    wRequests[wRi].activity = [
      ...(wRequests[wRi].activity || []),
      { ts: stamp, action: "Supplier reply captured", detail: `${sup.name || fromAddr} replied - dropped into the quote box${keptAtts ? ` with ${keptAtts} attachment${keptAtts === 1 ? "" : "s"}` : ""}${matchedBy === "sender address" ? " (matched by sender address)" : ""}`, user: "Inbound" },
    ];

    const { error: upErr } = await supabase.from("proqure_data").upsert({ user_id: userId, store_key: "piq_requests", value: wRequests, updated_at: stamp }, { onConflict: "user_id,store_key" });
    if (upErr) { console.error("api/inbound: save error", upErr.message); return res.status(200).json({ ok: true }); }
    console.log("api/inbound: MATCHED & SAVED | user", userId, "| req", wRi, "| supplier", wSi);
    await bumpStat(userId, { received: 1, receivedAttachments: attN });
    await pushEvent(userId, { type: "received", from: fromEmail, matchedBy, att: attN });

    // Notify the buying team that a quote landed. Server-side via proqure_notify
    // (service role -> bypasses RLS); category "workflow" so buyers + managers see it.
    // Deduped on the inbound email id so a redelivered webhook can't double-post.
    try {
      const jobRef = (wRequests[wRi] && wRequests[wRi].jobRef) || "";
      await supabase.rpc("proqure_notify", {
        p_company: userId,
        p_type: "success",
        p_category: "workflow",
        p_title: `${sup.name || "A supplier"} replied to your RFQ`,
        p_body: `Their quote has been added to the quote box${jobRef ? ` for ${jobRef}` : ""}.`,
        p_dedupe: `workflow:reply:${emailId || (userId + ":" + wRi + ":" + wSi + ":" + stamp)}`,
        p_cta_label: "Open ProQure",
        p_cta_href: "https://app.proqure.co.uk",
        p_meta: { kind: "supplier-reply", supplier: sup.name || null, jobRef: jobRef || null, matchedBy },
      });
    } catch (e) { console.warn("api/inbound: notify failed (non-fatal)", e && e.message); }

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
