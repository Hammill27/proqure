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
import { cadenceOf, emailEligible } from "../notify-policy.js";
import { renderNotificationEmail, sendMail } from "../lib/notify-mail.js";

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

// Resolve recipients for an announcement and email the eligible ones (per-recipient
// for privacy; capped + lightly concurrent to stay within the function budget — very
// large "all companies" broadcasts should move to a queue, but targeted company
// notices are small). Filtered by the policy: role rank, the announcement's optional
// min_role restriction, and each user's saved email preferences.
async function dispatchAnnouncementEmail(admin, ann) {
  let mq = admin.from("members").select("email,role,user_id,company_id");
  if (ann.target === "companies" && Array.isArray(ann.company_ids) && ann.company_ids.length)
    mq = mq.in("company_id", ann.company_ids);
  const { data: members } = await mq;
  const list = (members || []).filter(m => m && m.email);
  if (!list.length) return;
  let prefMap = {};
  try {
    const { data: states } = await admin.from("notification_state")
      .select("user_id,company_id,email_prefs").in("user_id", list.map(m => m.user_id));
    (states || []).forEach(st => { prefMap[`${st.user_id}:${st.company_id}`] = st.email_prefs || {}; });
  } catch (e) { /* no prefs => defaults */ }
  const eligible = list
    .filter(m => emailEligible(ann.category, m.role, prefMap[`${m.user_id}:${m.company_id}`], ann.min_role))
    .map(m => ({ email: m.email, companyId: m.company_id }))
    .slice(0, 100);
  if (!eligible.length) return;
  const items = [{ type: ann.type, title: ann.title, body: ann.body, cta_label: ann.cta_label, cta_href: ann.cta_href }];
  const heading = ann.category === "maintenance" ? "Planned maintenance"
    : ann.category === "release" ? "Product update" : "Announcement";
  const intro = ann.category === "maintenance" ? "Scheduled maintenance affecting your ProQure workspace." : "";
  const subject = ann.category === "maintenance" ? "ProQure \u2014 planned maintenance" : `ProQure \u2014 ${ann.title}`;
  const html = renderNotificationEmail({ heading, intro, items });
  for (let i = 0; i < eligible.length; i += 10) {
    const batch = eligible.slice(i, i + 10);
    await Promise.all(batch.map(r => sendMail({ to: r.email, subject, html, companyId: r.companyId })));
  }
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

    // ----- per-announcement in-app read stats (admin-only aggregate) -----
    // Real reads come from notification_state.read_ids. The "eligible" figure is an
    // estimate from members + target + min_role (in-app visibility), so it is labelled
    // approximate in the UI rather than presented as an exact denominator.
    if (action === "stats") {
      const RANK = { engineer: 1, buyer: 2, manager: 3, owner: 3 };
      const minRank = (mr) => mr === "manager" ? 3 : mr === "buyer" ? 2 : 1;
      const [annRes, stateRes, memRes] = await Promise.all([
        admin.from("announcements").select("id,target,company_ids,min_role").order("created_at", { ascending: false }).limit(50),
        admin.from("notification_state").select("user_id,read_ids"),
        admin.from("members").select("user_id,company_id,role"),
      ]);
      const anns = annRes.data || [], states = stateRes.data || [], members = (memRes.data || []).filter(m => m && m.user_id);
      const readers = {};
      for (const s of states) {
        const ids = Array.isArray(s.read_ids) ? s.read_ids : [];
        for (const id of ids) { (readers[id] = readers[id] || new Set()).add(s.user_id); }
      }
      const stats = {};
      for (const a of anns) {
        const need = minRank(a.min_role);
        let pool = members.filter(m => (RANK[m.role] || 1) >= need);
        if (a.target === "companies") { const set = new Set(a.company_ids || []); pool = pool.filter(m => set.has(m.company_id)); }
        stats[a.id] = { read: readers[a.id] ? readers[a.id].size : 0, eligible: new Set(pool.map(m => m.user_id)).size };
      }
      res.status(200).json({ stats }); return;
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
        min_role: ["buyer","manager"].includes(body.min_role) ? body.min_role : null,
        starts_at: body.starts_at || null,
        ends_at: body.ends_at || null,
        created_by: callerEmail,
      };
      const { data, error } = await admin.from("announcements").insert(row).select().single();
      if (error) throw error;
      const scope = target === "all" ? "all companies" : `${companyIds.length} compan${companyIds.length === 1 ? "y" : "ies"}`;
      await writeAudit(admin, caller, { action: "send-notification", target: scope, detail: `${type}: ${title}` });
      try { if (cadenceOf(data.category) === "immediate") await dispatchAnnouncementEmail(admin, data); } catch (e) { /* email never blocks the send */ }
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
