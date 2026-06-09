// api/admin-metrics.js
// ProQure platform admin console backend.
//
// SECURITY MODEL
// - The service-role key (full DB access) lives ONLY here, server-side. It is never
//   sent to the browser.
// - Every request must carry the caller's Supabase access token (Bearer). We validate
//   it and then check the caller's email against ADMIN_CONSOLE_EMAILS. Anyone not on
//   that allow-list gets 403 - even with a valid ProQure login.
// - This endpoint returns ONLY metadata and aggregates (company names, plans, user
//   lists, counts, timestamps). It never returns the contents of any company's orders,
//   quotes, requests or suppliers. The server reads those rows server-side purely to
//   COUNT them; the contents are dropped before responding.
//
// ENV (all already in Vercel except ADMIN_CONSOLE_EMAILS, which you add):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY)
//   ADMIN_CONSOLE_EMAILS = comma-separated list of owner emails allowed in.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY      = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const ADMIN_EMAILS  = (process.env.ADMIN_CONSOLE_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const COUNT_KEYS = ["piq_orders", "piq_requests", "piq_suppliers", "piq_hires", "piq_activity", "piq_quote_sets", "piq_quote_library", "piq_templates"];

// Owner-tooling stores (proqure_data store_keys).
// - Audit log: append-only, written under the ACTING ADMIN's own user_id so it
//   needs no new table or magic UUID; the console merges every admin's rows.
// - Email stats: per-company deliverability counters, written by the Resend webhook.
const AUDIT_KEY = "piq_admin_audit";
const EMAIL_STATS_KEY = "piq_email_stats";
const EVENTS_KEY = "piq_email_events";
const AUDIT_CAP = 1000; // keep the most recent N entries per admin row

// ---- Pure assembly: turn raw rows into the metadata-only summary the UI needs -------
// Exported so it can be unit-tested without a live database.
export function assembleSummary({ members = [], authUsers = [], settingsRows = [], countRows = [], usageRows = [], emailStatsRows = [], excludeEmails = [] }) {
  const now = Date.now();
  const DAY = 86400000;

  // Admin-console accounts are platform operators, not tenants - keep them out of
  // every company/user/signup view so the admin's own login never shows as a "company".
  const ex = new Set(excludeEmails.map(e => (e || "").toLowerCase()));
  if (ex.size) {
    members = members.filter(m => !ex.has((m.email || "").toLowerCase()));
    authUsers = authUsers.filter(u => !ex.has((u.email || "").toLowerCase()));
  }

  // index auth users by id and by email
  const userById = new Map();
  const userByEmail = new Map();
  for (const u of authUsers) {
    userById.set(u.id, u);
    if (u.email) userByEmail.set(u.email.toLowerCase(), u);
  }

  // settings + counts keyed by company_id (= proqure_data.user_id)
  const settingsByCo = new Map();
  for (const r of settingsRows) settingsByCo.set(r.user_id, { value: r.value || {}, updated_at: r.updated_at });

  const countsByCo = new Map(); // companyId -> { piq_orders: n, ... , _lastActive }
  const lastActiveByCo = new Map();
  for (const r of countRows) {
    const co = r.user_id;
    if (!countsByCo.has(co)) countsByCo.set(co, {});
    const n = Array.isArray(r.value) ? r.value.length : 0;
    countsByCo.get(co)[r.store_key] = n;
    const ts = r.updated_at ? Date.parse(r.updated_at) : 0;
    if (ts && (!lastActiveByCo.has(co) || ts > lastActiveByCo.get(co))) lastActiveByCo.set(co, ts);
  }
  const usageByCo = new Map();
  for (const r of usageRows) usageByCo.set(r.user_id, r.value || {});
  const emailByCo = new Map();
  let platformEmail = { receivedUnmatched: 0 };
  for (const r of emailStatsRows) {
    const v = r.value || {};
    if (r.user_id === "platform-email") { platformEmail = { receivedUnmatched: Number(v.receivedUnmatched || 0) }; continue; }
    emailByCo.set(r.user_id, {
      sent: Number(v.sent || 0), delivered: Number(v.delivered || 0),
      bounced: Number(v.bounced || 0), complained: Number(v.complained || 0),
      received: Number(v.received || 0), receivedAttachments: Number(v.receivedAttachments || 0),
      lastEventAt: v.lastEventAt || null,
    });
  }

  // Supplier-reply metadata, derived from piq_requests. We read the request data
  // ONLY to count — supplier counts, reply counts, timestamps — and never copy any
  // quote text into the output. Pure metadata for the compliance/observability view.
  const replyByCo = new Map();
  for (const r of countRows) {
    if (r.store_key !== "piq_requests") continue;
    const requests = Array.isArray(r.value) ? r.value : [];
    let emailed = 0, replied = 0, rfqs = 0, byAddress = 0, lastReply = 0;
    for (const req of requests) {
      const sentTo = (req && Array.isArray(req.sentTo)) ? req.sentTo : [];
      if (sentTo.length) rfqs++;
      emailed += sentTo.length;
      for (const s of sentTo) {
        if (s && s.replyReceivedAt) {
          replied++;
          const t = Date.parse(s.replyReceivedAt) || 0;
          if (t > lastReply) lastReply = t;
        }
      }
      const acts = (req && Array.isArray(req.activity)) ? req.activity : [];
      for (const a of acts) {
        if (a && a.action === "Supplier reply captured" && /sender address/i.test(a.detail || "")) byAddress++;
      }
    }
    replyByCo.set(r.user_id, {
      suppliersEmailed: emailed, suppliersReplied: replied, rfqsSent: rfqs,
      repliesByAddress: byAddress, lastReplyAt: lastReply ? new Date(lastReply).toISOString() : null,
    });
  }

  // group members into companies
  const companies = new Map(); // company_id -> company object
  for (const m of members) {
    const co = m.company_id;
    if (!co) continue;
    if (!companies.has(co)) companies.set(co, { companyId: co, users: [] });
    const c = companies.get(co);
    const au = m.user_id ? userById.get(m.user_id) : userByEmail.get((m.email || "").toLowerCase());
    c.users.push({
      email: m.email,
      role: m.role || "engineer",
      employment: m.employment || null,
      joinedAt: m.joined_at || (au && au.created_at) || null,
      active: !!m.user_id,
      confirmed: !!(au && (au.email_confirmed_at || au.confirmed_at)),
      lastSignIn: (au && au.last_sign_in_at) || null,
      isOwner: m.user_id ? (m.user_id === co) : !!(au && au.user_metadata && au.user_metadata.is_owner),
    });
  }

  // also surface auth users who signed up but have no members row yet (edge case)
  for (const u of authUsers) {
    const inMembers = members.some(m => (m.email || "").toLowerCase() === (u.email || "").toLowerCase());
    if (inMembers) continue;
    const co = u.id; // a brand-new signup becomes their own company on first resolve
    if (!companies.has(co)) companies.set(co, { companyId: co, users: [] });
    companies.get(co).users.push({
      email: u.email, role: "manager", employment: null,
      joinedAt: u.created_at || null, active: !!u.last_sign_in_at,
      confirmed: !!(u.email_confirmed_at || u.confirmed_at), lastSignIn: u.last_sign_in_at || null,
      isOwner: true, pendingSetup: true,
    });
  }

  // finalise each company with settings metadata + counts
  const list = [];
  for (const c of companies.values()) {
    const s = settingsByCo.get(c.companyId);
    const sv = (s && s.value) || {};
    const counts = countsByCo.get(c.companyId) || {};
    const owner = c.users.find(u => u.isOwner) || c.users[0] || null;
    const ownerAuth = owner ? (userByEmail.get((owner.email || "").toLowerCase())) : null;
    const lastActiveTs = lastActiveByCo.get(c.companyId) || (s && s.updated_at ? Date.parse(s.updated_at) : 0);
    list.push({
      companyId: c.companyId,
      name: (sv.company || "").trim()
        || (ownerAuth && ownerAuth.user_metadata && ownerAuth.user_metadata.company)
        || (owner && owner.email) || "(unnamed)",
      plan: sv.plan || "trial",
      onboarded: !!sv.onboarded,
      trade: sv.primaryTrade || sv.trade || null,
      teamSize: sv.teamSize || null,
      fromEmail: sv.fromEmail || null,
      address: sv.companyAddress || sv.siteAddress || null,
      vat: sv.vat || null,
      companyReg: sv.companyReg || null,
      createdAt: (ownerAuth && ownerAuth.created_at) || (owner && owner.joinedAt) || null,
      lastActive: lastActiveTs ? new Date(lastActiveTs).toISOString() : null,
      userCount: c.users.length,
      pendingInvites: c.users.filter(u => !u.active).length,
      unconfirmed: c.users.filter(u => !u.confirmed).length,
      users: c.users,
      counts: {
        orders: counts.piq_orders || 0,
        requests: counts.piq_requests || 0,
        suppliers: counts.piq_suppliers || 0,
        hires: counts.piq_hires || 0,
        activity: counts.piq_activity || 0,
        quotes: counts.piq_quote_sets || 0,
        library: counts.piq_quote_library || 0,
        templates: counts.piq_templates || 0,
      },
      aiUsage: usageByCo.get(c.companyId) || null,
      aiSpend: Number((usageByCo.get(c.companyId) || {}).aiSpend || 0),
      aiCalls: Number((usageByCo.get(c.companyId) || {}).aiCalls || 0),
      webCalls: Number((usageByCo.get(c.companyId) || {}).webCalls || 0),
      email: emailByCo.get(c.companyId) || { sent: 0, delivered: 0, bounced: 0, complained: 0, received: 0, receivedAttachments: 0, lastEventAt: null },
      replies: replyByCo.get(c.companyId) || { suppliersEmailed: 0, suppliersReplied: 0, rfqsSent: 0, repliesByAddress: 0, lastReplyAt: null },
    });
  }
  list.sort((a, b) => (Date.parse(b.lastActive || 0) || 0) - (Date.parse(a.lastActive || 0) || 0));

  // KPIs
  const totalUsers = list.reduce((n, c) => n + c.userCount, 0);
  const totalOrders = list.reduce((n, c) => n + c.counts.orders, 0);
  const totalRequests = list.reduce((n, c) => n + c.counts.requests, 0);
  const totalSuppliers = list.reduce((n, c) => n + c.counts.suppliers, 0);
  const totalHires = list.reduce((n, c) => n + c.counts.hires, 0);
  const totalQuotes = list.reduce((n, c) => n + c.counts.quotes, 0);
  const pendingInvites = list.reduce((n, c) => n + c.pendingInvites, 0);
  const unconfirmedUsers = list.reduce((n, c) => n + c.unconfirmed, 0);
  const onboardedCount = list.filter(c => c.onboarded).length;
  const activeTrials = list.filter(c => c.plan === "trial").length;
  const paid = list.filter(c => c.plan === "active" || c.plan === "paid").length;
  const planDist = list.reduce((m, c) => { const p = c.plan || "trial"; m[p] = (m[p] || 0) + 1; return m; }, {});
  const signupsLast30d = authUsers.filter(u => u.created_at && (now - Date.parse(u.created_at)) < 30 * DAY).length;
  const activeLast7d = list.filter(c => c.lastActive && (now - Date.parse(c.lastActive)) < 7 * DAY).length;
  const staleCompanies = list.filter(c => c.onboarded && (!c.lastActive || (now - Date.parse(c.lastActive)) > 30 * DAY)).length;

  // cost & deliverability totals
  const totalAiSpend = list.reduce((n, c) => n + (c.aiSpend || 0), 0);
  const totalAiCalls = list.reduce((n, c) => n + (c.aiCalls || 0), 0);
  const totalWebCalls = list.reduce((n, c) => n + (c.webCalls || 0), 0);
  const emailsSent = list.reduce((n, c) => n + (c.email.sent || 0), 0);
  const emailsDelivered = list.reduce((n, c) => n + (c.email.delivered || 0), 0);
  const emailsBounced = list.reduce((n, c) => n + (c.email.bounced || 0), 0);
  const emailsComplained = list.reduce((n, c) => n + (c.email.complained || 0), 0);
  // inbound / supplier-reply totals (metadata only)
  const totalSuppliersEmailed = list.reduce((n, c) => n + (c.replies.suppliersEmailed || 0), 0);
  const totalSupplierReplies = list.reduce((n, c) => n + (c.replies.suppliersReplied || 0), 0);
  const totalReceivedMatched = list.reduce((n, c) => n + (c.email.received || 0), 0);
  const totalReceivedAttachments = list.reduce((n, c) => n + (c.email.receivedAttachments || 0), 0);
  const totalReceivedUnmatched = platformEmail.receivedUnmatched || 0;
  // companies ranked by spend (then email volume) — the "who costs us most" view
  const costRanking = [...list]
    .filter(c => (c.aiSpend || 0) > 0 || (c.email.sent || 0) > 0)
    .sort((a, b) => (b.aiSpend || 0) - (a.aiSpend || 0) || (b.email.sent || 0) - (a.email.sent || 0))
    .slice(0, 25)
    .map(c => ({ companyId: c.companyId, name: c.name, plan: c.plan, aiSpend: c.aiSpend, aiCalls: c.aiCalls, webCalls: c.webCalls, email: c.email }));

  // recent signups feed
  const recentSignups = [...authUsers]
    .filter(u => u.created_at)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, 12)
    .map(u => ({
      email: u.email,
      name: (u.user_metadata && u.user_metadata.name) || null,
      company: (u.user_metadata && u.user_metadata.company) || null,
      createdAt: u.created_at,
      confirmed: !!(u.email_confirmed_at || u.confirmed_at),
      lastSignIn: u.last_sign_in_at || null,
    }));

  // simple 14-day signups histogram for a sparkline
  const days = 14;
  const hist = Array.from({ length: days }, (_, i) => {
    const dayStart = now - (days - 1 - i) * DAY;
    return { d: new Date(dayStart).toISOString().slice(0, 10), n: 0 };
  });
  for (const u of authUsers) {
    if (!u.created_at) continue;
    const age = Math.floor((now - Date.parse(u.created_at)) / DAY);
    const idx = days - 1 - age;
    if (idx >= 0 && idx < days) hist[idx].n++;
  }

  return {
    kpis: {
      totalCompanies: list.length, totalUsers, activeTrials, paid,
      signupsLast30d, activeLast7d, staleCompanies, onboardedCount,
      totalOrders, totalRequests, totalSuppliers, totalHires, totalQuotes,
      pendingInvites, unconfirmedUsers, planDist,
      totalAiSpend, totalAiCalls, totalWebCalls,
      emailsSent, emailsDelivered, emailsBounced, emailsComplained,
      totalSuppliersEmailed, totalSupplierReplies,
      totalReceivedMatched, totalReceivedUnmatched, totalReceivedAttachments,
    },
    costRanking,
    signupHistogram: hist,
    recentSignups,
    companies: list,
    generatedAt: new Date().toISOString(),
  };
}

// ---- helpers ----------------------------------------------------------------
function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return null;
}
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

// Append one entry to the acting admin's audit row (read-merge-write, capped).
// Failures here must never block the action itself, so this swallows errors.
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
      action: entry.action,
      target: entry.target || null,
      detail: entry.detail || null,
    });
    const trimmed = log.slice(-AUDIT_CAP);
    await admin.from("proqure_data").upsert(
      { user_id: actorId, store_key: AUDIT_KEY, value: trimmed, updated_at: new Date().toISOString() },
      { onConflict: "user_id,store_key" }
    );
  } catch { /* audit must not break the action */ }
}

// Resolve an auth user by email (paginates; small N in practice).
async function findUserByEmail(admin, email) {
  email = (email || "").toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    const users = (data && data.users) || [];
    const hit = users.find(u => (u.email || "").toLowerCase() === email);
    if (hit) return hit;
    if (users.length < 1000) break;
  }
  return null;
}

// ---- handler ----------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    res.status(500).json({ error: "Server not configured (missing Supabase env vars)." });
    return;
  }
  if (!ADMIN_EMAILS.length) {
    res.status(500).json({ error: "No admins configured. Set ADMIN_CONSOLE_EMAILS." });
    return;
  }

  // 1) authenticate the caller
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
    res.status(403).json({ error: "This account is not authorised for the admin console." });
    return;
  }

  // 2) service-role client for the privileged reads/actions
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const action = (req.query && req.query.action) || body.action || "summary";

  try {
    if (action === "summary") {
      // members
      const { data: members, error: mErr } = await admin
        .from("members").select("email,company_id,role,user_id,joined_at,employment");
      if (mErr) throw mErr;

      // auth users (paginate; small N in practice)
      let authUsers = [];
      for (let page = 1; page <= 10; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        const batch = (data && data.users) || [];
        authUsers = authUsers.concat(batch);
        if (batch.length < 1000) break;
      }

      // settings (full value -> metadata only)
      const { data: settingsRows, error: sErr } = await admin
        .from("proqure_data").select("user_id,value,updated_at").eq("store_key", "piq_settings");
      if (sErr) throw sErr;

      // countable stores (value read server-side only to length them, then dropped)
      const { data: countRowsRaw, error: cErr } = await admin
        .from("proqure_data").select("user_id,store_key,value,updated_at").in("store_key", COUNT_KEYS);
      if (cErr) throw cErr;
      const countRows = (countRowsRaw || []).map(r => ({
        user_id: r.user_id, store_key: r.store_key,
        value: Array.isArray(r.value) ? r.value : [], updated_at: r.updated_at,
      }));

      // ai usage metadata
      const { data: usageRows } = await admin
        .from("proqure_data").select("user_id,value").eq("store_key", "piq_usage");

      // per-company email deliverability counters (written by the Resend webhook)
      const { data: emailStatsRows } = await admin
        .from("proqure_data").select("user_id,value").eq("store_key", EMAIL_STATS_KEY);

      const summary = assembleSummary({ members: members || [], authUsers, settingsRows: settingsRows || [], countRows, usageRows: usageRows || [], emailStatsRows: emailStatsRows || [], excludeEmails: ADMIN_EMAILS });
      res.status(200).json({ ok: true, ...summary, viewer: callerEmail });
      return;
    }

    if (action === "audit") {
      // merge every admin's audit row into one reverse-chronological feed
      const { data: rows } = await admin
        .from("proqure_data").select("value").eq("store_key", AUDIT_KEY);
      const entries = [];
      for (const r of (rows || [])) {
        if (Array.isArray(r.value)) for (const e of r.value) entries.push(e);
      }
      entries.sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0));
      res.status(200).json({ ok: true, entries: entries.slice(0, 500) });
      return;
    }

    if (action === "events") {
      // recent webhook events (delivered/bounced/received/...) — platform-wide,
      // or for one company when companyId is supplied. Metadata only.
      const companyId = (body.companyId || "").trim();
      let q = admin.from("proqure_data").select("user_id,value").eq("store_key", EVENTS_KEY);
      if (companyId) q = q.eq("user_id", companyId);
      const { data: rows } = await q;
      const out = [];
      for (const r of (rows || [])) {
        if (Array.isArray(r.value)) for (const e of r.value) out.push({ company: r.user_id, ...e });
      }
      out.sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0));
      res.status(200).json({ ok: true, events: out.slice(0, companyId ? 100 : 300) });
      return;
    }

    if (action === "resend-invite") {
      const email = (body.email || "").trim().toLowerCase();
      if (!email) { res.status(400).json({ error: "Email required." }); return; }
      const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: process.env.APP_URL || undefined });
      if (error) { res.status(400).json({ error: error.message }); return; }
      await writeAudit(admin, caller, { action: "resend-invite", target: email });
      res.status(200).json({ ok: true, message: `Invite re-sent to ${email}.` });
      return;
    }

    if (action === "send-reset") {
      const email = (body.email || "").trim().toLowerCase();
      if (!email) { res.status(400).json({ error: "Email required." }); return; }
      const { error } = await anon.auth.resetPasswordForEmail(email, { redirectTo: process.env.APP_URL || undefined });
      if (error) { res.status(400).json({ error: error.message }); return; }
      await writeAudit(admin, caller, { action: "send-reset", target: email });
      res.status(200).json({ ok: true, message: `Password-reset link sent to ${email}.` });
      return;
    }

    if (action === "set-plan") {
      const companyId = (body.companyId || "").trim();
      const plan = (body.plan || "").trim();
      const allowed = ["trial", "active", "paid", "suspended", "cancelled"];
      if (!companyId || !allowed.includes(plan)) { res.status(400).json({ error: "companyId and a valid plan are required." }); return; }
      // read-merge-write so we only change the plan flag, never clobber other settings
      const { data: existing, error: rErr } = await admin
        .from("proqure_data").select("value").eq("user_id", companyId).eq("store_key", "piq_settings").maybeSingle();
      if (rErr) { res.status(400).json({ error: rErr.message }); return; }
      const merged = { ...((existing && existing.value) || {}), plan };
      const { error: wErr } = await admin.from("proqure_data").upsert(
        { user_id: companyId, store_key: "piq_settings", value: merged, updated_at: new Date().toISOString() },
        { onConflict: "user_id,store_key" }
      );
      if (wErr) { res.status(400).json({ error: wErr.message }); return; }
      await writeAudit(admin, caller, { action: "set-plan", target: companyId, detail: `plan=${plan}` });
      res.status(200).json({ ok: true, message: `Plan set to "${plan}".`, plan });
      return;
    }

    if (action === "verify-email") {
      const email = (body.email || "").trim().toLowerCase();
      if (!email) { res.status(400).json({ error: "Email required." }); return; }
      const u = await findUserByEmail(admin, email);
      if (!u) { res.status(404).json({ error: "No account found for " + email + "." }); return; }
      const { error } = await admin.auth.admin.updateUserById(u.id, { email_confirm: true });
      if (error) { res.status(400).json({ error: error.message }); return; }
      await writeAudit(admin, caller, { action: "verify-email", target: email });
      res.status(200).json({ ok: true, message: `Email confirmed for ${email}.` });
      return;
    }

    if (action === "force-logout") {
      const email = (body.email || "").trim().toLowerCase();
      if (!email) { res.status(400).json({ error: "Email required." }); return; }
      const u = await findUserByEmail(admin, email);
      if (!u) { res.status(404).json({ error: "No account found for " + email + "." }); return; }
      // GoTrue admin logout: revokes the user's refresh tokens so they're signed
      // out everywhere (existing access tokens lapse at their normal expiry).
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}/logout`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY },
      });
      if (!r.ok && r.status !== 204) {
        const t = await r.text().catch(() => "");
        res.status(400).json({ error: `Force-logout failed (${r.status}). If this persists, use Disable then Re-enable. ${t.slice(0, 100)}` });
        return;
      }
      await writeAudit(admin, caller, { action: "force-logout", target: email });
      res.status(200).json({ ok: true, message: `Signed ${email} out of all sessions.` });
      return;
    }

    if (action === "disable-account" || action === "enable-account") {
      const email = (body.email || "").trim().toLowerCase();
      if (!email) { res.status(400).json({ error: "Email required." }); return; }
      const u = await findUserByEmail(admin, email);
      if (!u) { res.status(404).json({ error: "No account found for " + email + "." }); return; }
      const disable = action === "disable-account";
      const { error } = await admin.auth.admin.updateUserById(u.id, { ban_duration: disable ? "876000h" : "none" });
      if (error) { res.status(400).json({ error: error.message }); return; }
      await writeAudit(admin, caller, { action, target: email });
      res.status(200).json({ ok: true, message: disable
        ? `${email} disabled — they can no longer sign in. Reversible.`
        : `${email} re-enabled.` });
      return;
    }

    res.status(400).json({ error: `Unknown action "${action}".` });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || "Server error." });
  }
}
