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
import { FEATURE_LIST } from "../feature-flags.js";

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY      = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const ADMIN_EMAILS  = (process.env.ADMIN_CONSOLE_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const COUNT_KEYS = ["piq_orders", "piq_requests", "piq_suppliers", "piq_hires", "piq_activity", "piq_quote_sets", "piq_quote_library", "piq_templates", "piq_costs", "piq_invoices"];

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
export function assembleSummary({ members = [], authUsers = [], settingsRows = [], countRows = [], usageRows = [], emailStatsRows = [], storageRows = [], meterRows = [], excludeEmails = [] }) {
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

  // per-company Supabase data size (bytes), from the proqure_storage_stats RPC.
  // Rows: { user_id, store_key, bytes }. Summed per company with a per-store breakdown.
  const storageByCo = new Map();
  for (const r of storageRows) {
    const id = r.user_id; const b = Number(r.bytes || 0);
    if (!storageByCo.has(id)) storageByCo.set(id, { bytes: 0, byKey: {} });
    const e = storageByCo.get(id);
    e.bytes += b;
    e.byKey[r.store_key] = (e.byKey[r.store_key] || 0) + b;
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

  // Invoice three-way-match metadata, derived from piq_invoices. As with replies,
  // the records are read ONLY to tally status/result/value; no invoice content is
  // ever copied into the output. status: matched|unmatched (awaiting a decision)
  // then approved|queried|rejected; match.result: clean|review|mismatch.
  const invByCo = new Map();
  for (const r of countRows) {
    if (r.store_key !== "piq_invoices") continue;
    const invs = Array.isArray(r.value) ? r.value : [];
    let captured = invs.length, clean = 0, flagged = 0, approved = 0, queried = 0, rejected = 0, toReview = 0, flaggedOpen = 0, valueMatchedGbp = 0;
    for (const iv of invs) {
      const isClean = !!(iv && iv.match && iv.match.result === "clean");
      if (isClean) clean++; else flagged++;
      const st = iv && iv.status;
      if (st === "approved") {
        approved++;
        if (String((iv && iv.currency) || "GBP").toUpperCase() === "GBP") {
          valueMatchedGbp += Number((iv && iv.total) || (iv && iv.match && iv.match.total) || 0) || 0;
        }
      } else if (st === "queried") { queried++; }
      else if (st === "rejected") { rejected++; }
      else { toReview++; if (!isClean) flaggedOpen++; }
    }
    invByCo.set(r.user_id, { captured, clean, flagged, approved, queried, rejected, toReview, flaggedOpen, valueMatchedGbp: Number(valueMatchedGbp.toFixed(2)) });
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
      id: m.user_id || (au && au.id) || null,
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
      id: u.id,
      email: u.email, role: "manager", employment: null,
      joinedAt: u.created_at || null, active: !!u.last_sign_in_at,
      confirmed: !!(u.email_confirmed_at || u.confirmed_at), lastSignIn: u.last_sign_in_at || null,
      isOwner: true, pendingSetup: true,
    });
  }

  // Billing: tier prices (GBP/mo) and which plans count as paying, for MRR/ARR.
  const PLAN_PRICE = { sole: 29, team: 79, business: 199, enterprise: 399 };
  const PAID_TIERS = new Set(["sole", "team", "business", "enterprise"]);
  // Mirrors of the app's ENTITLEMENTS + the AI circuit-breaker budgets (GBP) and the
  // USD->GBP display rate. KEEP IN SYNC with procurement-dashboard.jsx and /api/ai.
  const AI_BUDGET = { trial: 6, sole: 6, team: 20, business: 60, enterprise: 150 };
  const ALLOWANCES = {
    trial:      { measureWeb: 100,  omWeb: 5,   catalogueWeb: 50 },
    sole:       { measureWeb: 100,  omWeb: 5,   catalogueWeb: 50 },
    team:       { measureWeb: 300,  omWeb: 15,  catalogueWeb: 150 },
    business:   { measureWeb: 1000, omWeb: 50,  catalogueWeb: 500 },
    enterprise: { measureWeb: 3000, omWeb: 150, catalogueWeb: 1500 },
  };
  const USD_TO_GBP = 0.75;
  const CUR_PERIOD = new Date().toISOString().slice(0, 7);
  const meterByCo = new Map();
  for (const r of meterRows) {
    const v = r.value || {};
    meterByCo.set(r.user_id, (v.period === CUR_PERIOD) ? (Number(v.costPeriod) || 0) : 0);
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
      subscriptionStatus: sv.subscriptionStatus || ((sv.plan && sv.plan !== "trial") ? "active" : "trial"),
      mrr: PAID_TIERS.has(sv.plan) ? (PLAN_PRICE[sv.plan] || 0) : 0,
      stripeCustomerId: sv.stripeCustomerId || null,
      webAllowanceUsed: (() => {
        const u = usageByCo.get(c.companyId) || {};
        return { period: u.period || null, measureWeb: Number(u.measureWebUsed || 0), omWeb: Number(u.omWebUsed || 0), catalogueWeb: Number(u.catalogueWebUsed || 0), addons: u.addons || {} };
      })(),
      onboarded: !!sv.onboarded,
      featureFlags: (sv.featureFlags && typeof sv.featureFlags === "object") ? sv.featureFlags : {},
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
        costs: counts.piq_costs || 0,
        invoices: counts.piq_invoices || 0,
      },
      invoiceStats: invByCo.get(c.companyId) || null,
      trialEndsAt: sv.trialEndsAt || sv.trialEnd || null,
      aiUsage: usageByCo.get(c.companyId) || null,
      // This-month AI cost from the SERVER-authoritative meter (piq_ai_meter, USD),
      // converted to GBP, against the plan's circuit-breaker budget.
      aiMonthGbp: Number(((meterByCo.get(c.companyId) || 0) * USD_TO_GBP).toFixed(4)),
      aiBudgetGbp: AI_BUDGET[sv.plan] != null ? AI_BUDGET[sv.plan] : AI_BUDGET.trial,
      allowanceLimits: (() => {
        const ent = ALLOWANCES[sv.plan] || ALLOWANCES.trial;
        const u = usageByCo.get(c.companyId) || {};
        const add = (u.period === CUR_PERIOD && u.addons) ? u.addons : {};
        return {
          measureWeb: ent.measureWeb + (Number(add.measureWeb) || 0),
          omWeb: ent.omWeb + (Number(add.omWeb) || 0),
          catalogueWeb: ent.catalogueWeb + (Number(add.catalogueWeb) || 0),
        };
      })(),
      aiSpend: Number((usageByCo.get(c.companyId) || {}).aiSpend || 0),
      aiCalls: Number((usageByCo.get(c.companyId) || {}).aiCalls || 0),
      webCalls: Number((usageByCo.get(c.companyId) || {}).webCalls || 0),
      email: emailByCo.get(c.companyId) || { sent: 0, delivered: 0, bounced: 0, complained: 0, received: 0, receivedAttachments: 0, lastEventAt: null },
      replies: replyByCo.get(c.companyId) || { suppliersEmailed: 0, suppliersReplied: 0, rfqsSent: 0, repliesByAddress: 0, lastReplyAt: null },
      storageBytes: (storageByCo.get(c.companyId) || {}).bytes || 0,
      storageByKey: (storageByCo.get(c.companyId) || {}).byKey || {},
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
  const totalCostEntries = list.reduce((n, c) => n + (c.counts.costs || 0), 0);
  const companiesUsingCosts = list.filter(c => (c.counts.costs || 0) > 0).length;
  const pendingInvites = list.reduce((n, c) => n + c.pendingInvites, 0);
  const unconfirmedUsers = list.reduce((n, c) => n + c.unconfirmed, 0);
  const onboardedCount = list.filter(c => c.onboarded).length;
  const activeTrials = list.filter(c => (c.plan || "trial") === "trial").length;
  const paid = list.filter(c => PAID_TIERS.has(c.plan)).length;
  const pastDue = list.filter(c => c.subscriptionStatus === "past_due").length;
  const cancelledSubs = list.filter(c => c.subscriptionStatus === "cancelled").length;
  const mrr = list.reduce((n, c) => n + (c.mrr || 0), 0);
  const planDist = list.reduce((m, c) => { const p = c.plan || "trial"; m[p] = (m[p] || 0) + 1; return m; }, {});
  const signupsLast30d = authUsers.filter(u => u.created_at && (now - Date.parse(u.created_at)) < 30 * DAY).length;
  const activeLast7d = list.filter(c => c.lastActive && (now - Date.parse(c.lastActive)) < 7 * DAY).length;
  const staleCompanies = list.filter(c => c.onboarded && (!c.lastActive || (now - Date.parse(c.lastActive)) > 30 * DAY)).length;

  for (const c of list) c.aiBudgetPct = c.aiBudgetGbp > 0 ? Math.round((c.aiMonthGbp / c.aiBudgetGbp) * 100) : 0;
  const aiSpendMonthGbp = Number(list.reduce((n, c) => n + (c.aiMonthGbp || 0), 0).toFixed(2));
  const nearAiCap = list.filter(c => c.aiBudgetPct >= 80).length;
  const companiesNew30d = list.filter(c => c.createdAt && (now - Date.parse(c.createdAt)) < 30 * DAY).length;

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
  const totalStorageBytes = list.reduce((n, c) => n + (c.storageBytes || 0), 0);
  // invoice three-way-match rollups
  const invoicesTotal       = list.reduce((n, c) => n + ((c.invoiceStats && c.invoiceStats.captured) || 0), 0);
  const invoicesClean       = list.reduce((n, c) => n + ((c.invoiceStats && c.invoiceStats.clean) || 0), 0);
  const invoicesFlagged     = list.reduce((n, c) => n + ((c.invoiceStats && c.invoiceStats.flagged) || 0), 0);
  const invoicesApproved    = list.reduce((n, c) => n + ((c.invoiceStats && c.invoiceStats.approved) || 0), 0);
  const invoicesToReview    = list.reduce((n, c) => n + ((c.invoiceStats && c.invoiceStats.toReview) || 0), 0);
  const invoicesFlaggedOpen = list.reduce((n, c) => n + ((c.invoiceStats && c.invoiceStats.flaggedOpen) || 0), 0);
  const invoiceValueMatchedGbp = Number(list.reduce((n, c) => n + ((c.invoiceStats && c.invoiceStats.valueMatchedGbp) || 0), 0).toFixed(2));
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
      totalCompanies: list.length, totalUsers, activeTrials, paid, pastDue, cancelledSubs,
      mrr, arr: mrr * 12,
      signupsLast30d, activeLast7d, staleCompanies, onboardedCount,
      totalOrders, totalRequests, totalSuppliers, totalHires, totalQuotes,
      totalCostEntries, companiesUsingCosts,
      pendingInvites, unconfirmedUsers, planDist,
      totalAiSpend, totalAiCalls, totalWebCalls,
      aiSpendMonthGbp, nearAiCap, companiesNew30d,
      emailsSent, emailsDelivered, emailsBounced, emailsComplained,
      totalSuppliersEmailed, totalSupplierReplies,
      totalReceivedMatched, totalReceivedUnmatched, totalReceivedAttachments,
      totalStorageBytes,
      invoicesTotal, invoicesClean, invoicesFlagged, invoicesApproved, invoicesToReview, invoicesFlaggedOpen, invoiceValueMatchedGbp,
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
const INBOUND_CAPTURE_DOMAIN = (process.env.VITE_INBOUND_CAPTURE_DOMAIN || process.env.INBOUND_CAPTURE_DOMAIN || "").trim();
function makeReplyToken() { return (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toLowerCase(); }
function supportCaptureAddress(token) { return INBOUND_CAPTURE_DOMAIN && token ? `s-${token}@${INBOUND_CAPTURE_DOMAIN}` : null; }
function escapeHtml(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
async function sendSupportEmail(to, subject, html, replyTo) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return false;
  try {
    const payload = { from: "ProQure Support <support@proqure.co.uk>", to: [to], subject, html };
    if (replyTo) payload.reply_to = replyTo;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch (e) { return false; }
}
function supportReplyEmailHtml({ ref, name, message, replyText, status }) {
  const statusLabel = status === "resolved" ? "Resolved" : status === "on-hold" ? "On hold" : "In progress";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#F4F4F1;font-family:'Helvetica Neue',Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F1"><tr><td align="center" style="padding:24px 16px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid #E8E7E1;border-radius:12px;overflow:hidden">
      <tr><td style="padding:22px 32px 16px;font-size:18px;font-weight:800;color:#15824F"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:#15824F;vertical-align:middle;margin-right:6px"></span>ProQure Support</td></tr>
      <tr><td style="height:3px;background:#15824F;font-size:0;line-height:3px">&nbsp;</td></tr>
      <tr><td style="padding:24px 32px 26px">
        <p style="margin:0 0 14px;font-size:15px;color:#1A1A17">Hi ${escapeHtml(name || "there")},</p>
        <p style="margin:0 0 8px;font-size:13px;color:#6B6A63">An update on your request <strong style="color:#1A1A17">${escapeHtml(ref || "")}</strong> &mdash; status: <strong style="color:#15824F">${statusLabel}</strong></p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#F8F8F5;border:1px solid #EAE9E3;border-radius:10px;margin:12px 0 16px"><tr><td style="padding:14px 16px;font-size:14px;line-height:1.55;color:#1A1A17;white-space:pre-wrap">${escapeHtml(replyText || "")}</td></tr></table>
        ${message ? `<p style="margin:0 0 4px;font-size:11px;color:#908F86;text-transform:uppercase;letter-spacing:.05em">Your original request</p><div style="font-size:12.5px;color:#6B6A63;line-height:1.5;white-space:pre-wrap;border-left:3px solid #EAE9E3;padding-left:12px">${escapeHtml(message)}</div>` : ""}
      </td></tr>
    </table>
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%"><tr><td align="center" style="padding:14px 12px 0"><span style="font-size:11px;color:#908F86">Sent with <strong style="color:#15824F">ProQure</strong></span></td></tr></table>
  </td></tr></table>
</body></html>`;
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

      // server-authoritative this-month AI meter (written only by /api/ai)
      const { data: meterRows } = await admin
        .from("proqure_data").select("user_id,value").eq("store_key", "piq_ai_meter");

      // per-company Supabase data size (RPC; sizes server-side without pulling the blobs).
      // Gracefully empty until the proqure_storage_stats function is installed.
      let storageRows = [];
      try {
        const { data: srows, error: stErr } = await admin.rpc("proqure_storage_stats");
        if (!stErr && Array.isArray(srows)) storageRows = srows;
      } catch { /* RPC not installed yet */ }

      const summary = assembleSummary({ members: members || [], authUsers, settingsRows: settingsRows || [], countRows, usageRows: usageRows || [], emailStatsRows: emailStatsRows || [], storageRows, meterRows: meterRows || [], excludeEmails: ADMIN_EMAILS });
      res.status(200).json({ ok: true, ...summary, features: FEATURE_LIST, viewer: callerEmail });
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

    if (action === "activity") {
      // Unified account timeline: usage telemetry (piq_events:<uid>) + the business
      // activity log (piq_activity). Per-company when companyId is supplied, else
      // platform-wide. Also returns a per-company last-active map (max ts seen).
      const companyId = (body.companyId || "").trim();
      const items = [];
      const evCutoff = Date.now() - 90 * 864e5; // retention: ignore telemetry older than 90 days
      let q1 = admin.from("proqure_data").select("user_id,store_key,value").like("store_key", "piq_events:%");
      if (companyId) q1 = q1.eq("user_id", companyId);
      const { data: ev } = await q1;
      for (const r of (ev || [])) {
        const uid = (r.store_key || "").slice("piq_events:".length) || null;
        if (Array.isArray(r.value)) for (const e of r.value) {
          if (e && e.ts && Date.parse(e.ts) < evCutoff) continue;
          items.push({ companyId: r.user_id, uid, ts: e.ts, kind: e.t, role: e.r || null, view: e.v || null, errName: e.n || null, plan: e.plan || null });
        }
      }
      let q2 = admin.from("proqure_data").select("user_id,value").eq("store_key", "piq_activity");
      if (companyId) q2 = q2.eq("user_id", companyId);
      const { data: ac } = await q2;
      for (const r of (ac || [])) { if (Array.isArray(r.value)) for (const a of r.value) items.push({ companyId: r.user_id, ts: a.ts, kind: "action", label: a.action || null, detail: a.detail || null, user: a.user || null }); }
      items.sort((x, y) => Date.parse(y.ts || 0) - Date.parse(x.ts || 0));
      const lastActive = {};
      for (const it of items) { const c = it.companyId; if (it.ts && (!lastActive[c] || it.ts > lastActive[c])) lastActive[c] = it.ts; }
      res.status(200).json({ ok: true, items: items.slice(0, companyId ? 400 : 1200), lastActive });
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
      const allowed = ["trial", "sole", "team", "business", "enterprise", "active", "paid", "suspended", "cancelled"];
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

    if (action === "set-flags") {
      const companyId = (body.companyId || "").trim();
      const key = (body.key || "").trim();
      const value = body.value; // "on" | "off" | "default"
      if (!companyId || !FEATURE_LIST.some(f => f.key === key)) { res.status(400).json({ error: "companyId and a valid feature key are required." }); return; }
      if (!["on", "off", "default"].includes(value)) { res.status(400).json({ error: "value must be on, off, or default." }); return; }
      const { data: existing, error: rErr } = await admin
        .from("proqure_data").select("value").eq("user_id", companyId).eq("store_key", "piq_settings").maybeSingle();
      if (rErr) { res.status(400).json({ error: rErr.message }); return; }
      const cur = (existing && existing.value) || {};
      const flags = (cur.featureFlags && typeof cur.featureFlags === "object") ? { ...cur.featureFlags } : {};
      if (value === "default") delete flags[key]; else flags[key] = value;
      const merged = { ...cur, featureFlags: flags };
      const { error: wErr } = await admin.from("proqure_data").upsert(
        { user_id: companyId, store_key: "piq_settings", value: merged, updated_at: new Date().toISOString() },
        { onConflict: "user_id,store_key" });
      if (wErr) { res.status(400).json({ error: wErr.message }); return; }
      await writeAudit(admin, caller, { action: "set-flags", target: companyId, detail: `${key}=${value}` });
      res.status(200).json({ ok: true, message: `Feature "${key}" set to ${value}.`, featureFlags: flags });
      return;
    }

    if (action === "erase-activity") {
      // Right to erasure: permanently delete this tenant's usage telemetry
      // (piq_events:<uid> rows). Does not touch business data. Audited.
      const companyId = (body.companyId || "").trim();
      if (!companyId) { res.status(400).json({ error: "companyId is required." }); return; }
      const { error } = await admin.from("proqure_data").delete().like("store_key", "piq_events:%").eq("user_id", companyId);
      if (error) { res.status(400).json({ error: error.message }); return; }
      await writeAudit(admin, caller, { action: "erase-activity", target: companyId, detail: "usage telemetry erased" });
      res.status(200).json({ ok: true, message: "Activity telemetry erased for this company." });
      return;
    }

    if (action === "reset-onboarding") {
      const companyId = (body.companyId || "").trim();
      if (!companyId) { res.status(400).json({ error: "companyId required." }); return; }
      const { data: existing, error: rErr } = await admin
        .from("proqure_data").select("value").eq("user_id", companyId).eq("store_key", "piq_settings").maybeSingle();
      if (rErr) { res.status(400).json({ error: rErr.message }); return; }
      const merged = { ...((existing && existing.value) || {}), onboarded: false };
      const { error: wErr } = await admin.from("proqure_data").upsert(
        { user_id: companyId, store_key: "piq_settings", value: merged, updated_at: new Date().toISOString() },
        { onConflict: "user_id,store_key" }
      );
      if (wErr) { res.status(400).json({ error: wErr.message }); return; }
      await writeAudit(admin, caller, { action: "reset-onboarding", target: companyId });
      res.status(200).json({ ok: true, message: "Onboarding reset — the company sees setup again on next load." });
      return;
    }

    if (action === "reset-trial") {
      const companyId = (body.companyId || "").trim();
      if (!companyId) { res.status(400).json({ error: "companyId required." }); return; }
      const days = Number(body.days) > 0 ? Number(body.days) : 14;
      const ends = new Date(Date.now() + days * 86400000).toISOString();
      const { data: existing, error: rErr } = await admin
        .from("proqure_data").select("value").eq("user_id", companyId).eq("store_key", "piq_settings").maybeSingle();
      if (rErr) { res.status(400).json({ error: rErr.message }); return; }
      const merged = { ...((existing && existing.value) || {}), trialEndsAt: ends };
      const { error: wErr } = await admin.from("proqure_data").upsert(
        { user_id: companyId, store_key: "piq_settings", value: merged, updated_at: new Date().toISOString() },
        { onConflict: "user_id,store_key" }
      );
      if (wErr) { res.status(400).json({ error: wErr.message }); return; }
      await writeAudit(admin, caller, { action: "reset-trial", target: companyId, detail: `+${days}d` });
      res.status(200).json({ ok: true, message: `Trial reset to ${days} days from now.` });
      return;
    }

    // ----- support inbox: list every tenant's feedback (newest first) -----
    if (action === "feedback") {
      const { data: rows } = await admin
        .from("proqure_data").select("user_id,value").eq("store_key", "piq_feedback");
      const items = [];
      for (const r of (rows || [])) { if (Array.isArray(r.value)) for (const it of r.value) if (it && it.id) items.push({ ...it, companyId: r.user_id }); }
      items.sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0));
      res.status(200).json({ ok: true, items: items.slice(0, 300) });
      return;
    }

    // ----- support inbox: set status and/or reply (reply also goes in-app) -----
    if (action === "feedback-action") {
      const companyId = (body.companyId || "").trim();
      const id = (body.id || "").trim();
      const status = ["new", "open", "on-hold", "resolved"].includes(body.status) ? body.status : null;
      const reply = (body.reply || "").trim();
      if (!companyId || !id) { res.status(400).json({ error: "companyId and id are required." }); return; }
      const { data: ex, error: rErr } = await admin
        .from("proqure_data").select("value").eq("user_id", companyId).eq("store_key", "piq_feedback").maybeSingle();
      if (rErr) { res.status(400).json({ error: rErr.message }); return; }
      const arr = Array.isArray(ex && ex.value) ? ex.value : [];
      let ticket = null;
      const next = arr.map(it => {
        if (it && it.id === id) {
          const u = { ...it };
          if (!u.replyToken) u.replyToken = makeReplyToken();
          if (!Array.isArray(u.replies)) u.replies = u.reply ? [u.reply] : []; // migrate legacy single reply
          if (!Array.isArray(u.log)) u.log = [];
          delete u.reply;
          const prevStatus = u.status || "new";
          if (reply) { u.replies = [...u.replies, { ts: new Date().toISOString(), by: callerEmail, dir: "out", message: reply }]; u.status = u.status === "resolved" ? u.status : "open"; }
          if (status && status !== prevStatus) { u.log = [...u.log, { ts: new Date().toISOString(), by: callerEmail, type: "status", from: prevStatus, to: status }]; u.status = status; }
          u.updatedAt = new Date().toISOString();
          ticket = u; return u;
        }
        return it;
      });
      if (!ticket) { res.status(404).json({ error: "That request no longer exists." }); return; }
      const { error: wErr } = await admin.from("proqure_data").upsert(
        { user_id: companyId, store_key: "piq_feedback", value: next, updated_at: new Date().toISOString() },
        { onConflict: "user_id,store_key" });
      if (wErr) { res.status(400).json({ error: wErr.message }); return; }
      let emailed = false;
      if (reply) {
        if (ticket.email) emailed = await sendSupportEmail(
          ticket.email, `Update on your request [${ticket.ref || id}]`,
          supportReplyEmailHtml({ ref: ticket.ref || "", name: ticket.name, message: ticket.message, replyText: reply, status: ticket.status }),
          supportCaptureAddress(ticket.replyToken));
        try {
          await admin.from("notifications").insert([{ company_id: companyId, type: "info", category: "announcement",
            title: "Update on your support request", body: reply, dedupe_key: "fbreply-" + id + "-" + Date.now(), meta: { feedbackId: id } }]);
        } catch (e) { /* best-effort in-app copy */ }
      }
      await writeAudit(admin, caller, { action: reply ? "feedback-reply" : "feedback-status", target: companyId, detail: reply ? ("replied" + (emailed ? "+emailed" : "")) : ("status=" + status) });
      res.status(200).json({ ok: true, message: reply ? (emailed ? "Reply sent and emailed to the customer." : "Reply saved (email could not be sent).") : "Updated.", emailed });
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

    if (action === "export-tenant") {
      const companyId = (body.companyId || "").trim();
      if (!companyId) { res.status(400).json({ error: "companyId required." }); return; }
      const { data: rows, error } = await admin
        .from("proqure_data").select("store_key,value,updated_at").eq("user_id", companyId);
      if (error) { res.status(400).json({ error: error.message }); return; }
      const { data: mem } = await admin
        .from("members").select("email,role,user_id,joined_at,employment").eq("company_id", companyId);
      const stores = {};
      for (const r of (rows || [])) stores[r.store_key] = { value: r.value, updated_at: r.updated_at };
      await writeAudit(admin, caller, { action: "export-tenant", target: companyId, detail: `${(rows || []).length} stores` });
      res.status(200).json({ ok: true, data: { companyId, exportedAt: new Date().toISOString(), exportedBy: callerEmail, members: mem || [], stores } });
      return;
    }

    if (action === "delete-tenant") {
      const companyId = (body.companyId || "").trim();
      if (!companyId) { res.status(400).json({ error: "companyId required." }); return; }
      // GDPR erasure: remove the tenant's stored data and memberships. Auth user
      // ACCOUNTS ARE LEFT INTACT on purpose - a person may belong to other
      // companies, and removing the membership already severs access to this one.
      const { error: dErr, count: dCount } = await admin
        .from("proqure_data").delete({ count: "exact" }).eq("user_id", companyId);
      if (dErr) { res.status(400).json({ error: dErr.message }); return; }
      const { error: mErr, count: mCount } = await admin
        .from("members").delete({ count: "exact" }).eq("company_id", companyId);
      if (mErr) { res.status(400).json({ error: mErr.message }); return; }
      await writeAudit(admin, caller, { action: "delete-tenant", target: companyId, detail: `${dCount || 0} stores, ${mCount || 0} memberships` });
      res.status(200).json({ ok: true, message: `Tenant erased \u2014 ${dCount || 0} data stores and ${mCount || 0} memberships removed. Login accounts left intact.` });
      return;
    }

    res.status(400).json({ error: `Unknown action "${action}".` });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || "Server error." });
  }
}
