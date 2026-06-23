// api/notify-event.js — member-raised operational notifications (Phase 5 follow-up).
// ----------------------------------------------------------------------------
// Lets a signed-in company member raise a small, fixed set of WORKFLOW
// notifications for THEIR OWN company (asset assignment/transfer requests and
// damage reports). Managers/buyers then see them in the bell (RLS shows the
// workflow category to rank >= 2) and in their daily digest email.
//
// Why this exists: the browser deliberately cannot emit a managers-only category
// (notif_role_guard RLS blocks an engineer inserting a workflow row, and the
// proqure_notify RPC has client EXECUTE revoked). This endpoint is the safe
// bridge — it runs the privileged emit on the server, but ONLY after:
//   1. verifying the caller's session, and
//   2. confirming the caller is a member of the company they're notifying
//      (this closes the cross-tenant injection hole the RPC lockdown protects),
// and it builds the title/body/category itself (the client never supplies the
// category, title or CTA), so it cannot be used for in-app phishing.
//
// Auth + env mirror api/notifications.js. Emit uses the service-role
// proqure_notify() RPC (the intended server channel). No DB change required.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

// Server-defined events. Content is built HERE, never taken from the client, so
// this endpoint can only ever raise these specific operational notices.
function buildEvent(event, d) {
  const who   = clip(d.actor || "A teammate", 80);
  const asset = clip(d.asset || "an asset", 80);
  const to    = clip(d.toEngineer || "", 80);
  switch (event) {
    case "asset_request":
      return { type: "info",    title: "Asset request awaiting approval",  body: `${who} has requested ${asset}.` };
    case "asset_transfer":
      return { type: "info",    title: "Asset transfer awaiting approval", body: `${who} wants to transfer ${asset}${to ? ` to ${to}` : ""}.` };
    case "asset_damage":
      return { type: "warning", title: "Damage reported",                  body: `${who} reported damage to ${asset}.` };
    default:
      return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://app.proqure.co.uk");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    res.status(500).json({ error: "Server not configured (missing Supabase env vars)." }); return;
  }

  const body  = readBody(req);
  const token = getBearer(req) || body.token;
  if (!token) { res.status(401).json({ error: "Not signed in." }); return; }

  // 1) verify the session
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let caller;
  try {
    const { data, error } = await anon.auth.getUser(token);
    if (error || !data || !data.user) { res.status(401).json({ error: "Session invalid or expired." }); return; }
    caller = data.user;
  } catch { res.status(401).json({ error: "Could not verify session." }); return; }

  const companyId = clip(body.company_id, 64).trim();
  if (!companyId) { res.status(400).json({ error: "Missing company_id." }); return; }

  const built = buildEvent(clip(body.event, 40), body.data || {});
  if (!built) { res.status(400).json({ error: "Unknown event." }); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // 2) the caller MUST be a member of the company they are notifying
  const callerEmail = (caller.email || "").toLowerCase();
  let isMember = false;
  try {
    const byId = await admin.from("members").select("company_id").eq("company_id", companyId).eq("user_id", caller.id).limit(1);
    isMember = !!(byId.data && byId.data.length);
    if (!isMember && callerEmail) {
      const byEmail = await admin.from("members").select("company_id").eq("company_id", companyId).ilike("email", callerEmail).limit(1);
      isMember = !!(byEmail.data && byEmail.data.length);
    }
  } catch { res.status(500).json({ error: "Membership check failed." }); return; }
  if (!isMember) { res.status(403).json({ error: "You are not a member of that company." }); return; }

  // 3) emit via the service-role RPC (bypasses notif_role_guard so a managers-only
  //    category can be raised on an engineer's behalf). Category is fixed to workflow.
  const dedupe = `evt:${clip(body.event, 40)}:${clip(body.data && body.data.ref, 64)}:${Date.now()}`;
  try {
    const { error } = await admin.rpc("proqure_notify", {
      p_company:   companyId,
      p_type:      built.type,
      p_category:  "workflow",
      p_title:     built.title,
      p_body:      built.body,
      p_dedupe:    dedupe,
      p_cta_label: null,
      p_cta_href:  null,
      p_meta:      { kind: clip(body.event, 40), asset: clip(body.data && body.data.asset, 80), by: callerEmail },
    });
    if (error) throw error;
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || "Notify failed." });
  }
}
