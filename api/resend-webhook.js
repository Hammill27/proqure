// api/resend-webhook.js
// Receives Resend email events (sent / delivered / bounced / complained) and records
// per-company deliverability counters for the admin cost & usage dashboard.
//
// HOW ATTRIBUTION WORKS
// - send-email.js tags each outgoing email with { company_id }.
// - Resend echoes that tag back on every event for the email.
// - We increment a small counter object stored at proqure_data(user_id=company_id,
//   store_key="piq_email_stats"). Events with no company tag are counted under a
//   shared "platform" bucket so totals still add up.
//
// SECURITY: verified with the Svix scheme (same as inbound.js) using the webhook
// signing secret. Service-role key is server-only.
//
// ENV: RESEND_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// SETUP: add this URL as a Resend webhook (https://app.proqure.co.uk/api/resend-webhook)
//        subscribed to email.sent, email.delivered, email.bounced, email.complained.

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || "";
const SKIP_VERIFY = process.env.INBOUND_SKIP_VERIFY === "1";
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = (SUPABASE_URL && SERVICE_KEY) ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

const STATS_KEY = "piq_email_stats";
const PLATFORM_BUCKET = "platform-email"; // for events with no company tag

async function readRaw(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "string") return req.body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw) return raw;
  } catch (e) { /* fall through */ }
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  return "";
}

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

// Map a Resend event type to the counter field we increment.
function fieldFor(type) {
  if (type === "email.sent") return "sent";
  if (type === "email.delivered") return "delivered";
  if (type === "email.bounced") return "bounced";
  if (type === "email.complained") return "complained";
  return null; // ignore opened/clicked/delivery_delayed for now
}

async function bump(companyId, field) {
  if (!supabase) return;
  const { data } = await supabase.from("proqure_data")
    .select("value").eq("user_id", companyId).eq("store_key", STATS_KEY).maybeSingle();
  const v = (data && data.value) || {};
  v[field] = Number(v[field] || 0) + 1;
  v.lastEventAt = new Date().toISOString();
  await supabase.from("proqure_data").upsert(
    { user_id: companyId, store_key: STATS_KEY, value: v, updated_at: new Date().toISOString() },
    { onConflict: "user_id,store_key" }
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const raw = await readRaw(req);
  if (!SKIP_VERIFY) {
    const v = verifySvix(raw, req.headers, WEBHOOK_SECRET);
    if (!v.ok) { res.status(401).json({ error: "Invalid signature: " + v.reason }); return; }
  }

  let evt;
  try { evt = JSON.parse(raw); } catch { res.status(400).json({ error: "Bad JSON" }); return; }

  const field = fieldFor(evt && evt.type);
  if (!field) { res.status(200).json({ ok: true, ignored: (evt && evt.type) || "unknown" }); return; }

  // Resend echoes our send-time tags on the event as an object: { company_id: "..." }
  const data = evt.data || {};
  const tags = data.tags || {};
  const companyId = (tags.company_id && String(tags.company_id)) || PLATFORM_BUCKET;

  try {
    await bump(companyId, field);
    res.status(200).json({ ok: true, recorded: { company: companyId, field } });
  } catch (e) {
    // Never make Resend retry storms over a transient write error.
    res.status(200).json({ ok: true, warn: (e && e.message) || "write failed" });
  }
}
