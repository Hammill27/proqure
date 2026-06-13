// api/notifications.js — Admin Centre notifications (Phase 1).
// Creates / lists / recalls / expires global ANNOUNCEMENTS (the broadcast class).
// Per-company system notifications are emitted client-side (RLS-checked) or via the
// proqure_notify() service-role RPC; this endpoint owns the admin-authored broadcasts.
//
// Auth mirrors api/admin-metrics.js exactly: a valid signed-in session whose email is
// on ADMIN_CONSOLE_EMAILS. Writes use the service role (announcements has no write
// policy, so only the service role can insert). Every send is written to the same
// piq_admin_audit feed the Audit tab reads.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const ADMIN_EMAILS = (process.env.ADMIN_CONSOLE_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const AUDIT_KEY = "piq_admin_audit";
const AUDIT_CAP = 500;
const TYPES = ["info", "warning", "success", "critical"];

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}
async function writeAudit(admin, actor, entry) {
  try {
    const actorId = actor && actor.id;
    if (!actorId) return;
    const { data } = await admin.from("proqure_data")
      .select("value").eq("user_id", actorId).eq("store_key", AUDIT_KEY).maybeSingle();
    const log = Array.isArray(data && data.value) ? data.value : [];
    log.push({
      ts: new Date().toISOString(),
      actor: (actor.email || "").toLowerCase(),
      action: entry.action, target: entry.target || null, detail: entry.detail || null,
    });
    await admin.from("proqure_data").upsert(
      { user_id: actorId, store_key: AUDIT_KEY, value: log.slice(-AUDIT_CAP), updated_at: new Date().toISOString() },
      { onConflict: "user_id,store_key" }
    );
  } catch { /* audit must never break the action */ }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://app.proqure.co.uk");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    res.status(500).json({ error: "Server not configured (missing Supabase env vars)." }); return;
  }
  if (!ADMIN_EMAILS.length) {
    res.status(500).json({ error: "No admins configured. Set ADMIN_CONSOLE_EMAILS." }); return;
  }

  // 1) authenticate + authorise the caller
  const body = readBody(req);
  const token = getBearer(req) || body.token;
  if (!token) { res.status(401).json({ error: "Not signed in." }); return; }

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let caller;
  try {
    const { data, error } = await anon.auth.getUser(token);
    if (error || !data || !data.user) { res.status(401).json({ error: "Session invalid or expired." }); return; }
    caller = data.user;
  } catch { res.status(401).json({ error: "Could not verify session." }); return; }

  const callerEmail = (caller.email || "").toLowerCase();
  if (!ADMIN_EMAILS.includes(callerEmail)) {
    res.status(403).json({ error: "This account is not authorised for the admin console." }); return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const action = (req.query && req.query.action) || body.action || "list";

  try {
    // ----- list recent announcements (for the Sent panel) -----
    if (action === "list") {
      const { data, error } = await admin.from("announcements")
        .select("*").order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      res.status(200).json({ announcements: data || [] }); return;
    }

    // ----- create / send an announcement -----
    if (action === "announce") {
      const type = TYPES.includes(body.type) ? body.type : "info";
      const title = (body.title || "").trim();
      if (!title) { res.status(400).json({ error: "A title is required." }); return; }
      const target = body.target === "companies" ? "companies" : "all";
      const companyIds = Array.isArray(body.company_ids) ? body.company_ids.filter(Boolean) : [];
      if (target === "companies" && companyIds.length === 0) {
        res.status(400).json({ error: "Pick at least one company, or target all companies." }); return;
      }
      const row = {
        type,
        category: ["maintenance", "release", "announcement"].includes(body.category) ? body.category : "announcement",
        title,
        body: (body.body || "").toString(),
        cta_label: body.cta_label || null,
        cta_href: body.cta_href || null,
        target,
        company_ids: target === "companies" ? companyIds : [],
        persistent: !!body.persistent,
        starts_at: body.starts_at || null,
        ends_at: body.ends_at || null,
        created_by: callerEmail,
      };
      const { data, error } = await admin.from("announcements").insert(row).select().single();
      if (error) throw error;
      const scope = target === "all" ? "all companies" : `${companyIds.length} compan${companyIds.length === 1 ? "y" : "ies"}`;
      await writeAudit(admin, caller, { action: "send-notification", target: scope, detail: `${type}: ${title}` });
      res.status(200).json({ announcement: data }); return;
    }

    // ----- recall (soft unsend) -----
    if (action === "recall") {
      const id = body.id;
      if (!id) { res.status(400).json({ error: "Missing id." }); return; }
      const { error } = await admin.from("announcements").update({ recalled_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
      await writeAudit(admin, caller, { action: "recall-notification", target: id });
      res.status(200).json({ ok: true }); return;
    }

    // ----- expire now (end the display window immediately) -----
    if (action === "expire") {
      const id = body.id;
      if (!id) { res.status(400).json({ error: "Missing id." }); return; }
      const { error } = await admin.from("announcements").update({ ends_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
      await writeAudit(admin, caller, { action: "expire-notification", target: id });
      res.status(200).json({ ok: true }); return;
    }

    res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || "Notification action failed." });
  }
}
