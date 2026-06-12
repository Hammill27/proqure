// api/admin-health.js
// ProQure infrastructure health board backend.
//
// SECURITY MODEL (identical to admin-metrics.js)
// - Every provider secret (Vercel token, Resend key, OpenRouter key, Supabase
//   service key, Stripe key) lives ONLY here, server-side, in env vars. None is ever
//   sent to the browser. This endpoint calls each provider with those keys and returns
//   ONLY the result of each check (up/down, a few numbers) - never the keys themselves.
// - Every request must carry the caller's Supabase access token (Bearer). We validate
//   it and check the caller's email against ADMIN_CONSOLE_EMAILS. Anyone not on that
//   allow-list gets 403 - even with a valid ProQure login.
// - All outbound checks are read-only (GET / HEAD style). Nothing here changes state.
// - Each check is wrapped so one provider being down can never crash the board; it
//   just shows that provider as "down" with the reason.
//
// ENV (the provider keys are already in Vercel; ADMIN_CONSOLE_EMAILS you already added):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY)
//   ADMIN_CONSOLE_EMAILS
//   RESEND_API_KEY, OPENROUTER_API_KEY, STRIPE_SECRET_KEY
//   Optional, to enable the Vercel panel: VERCEL_API_TOKEN (read-only), VERCEL_PROJECT_ID, VERCEL_TEAM_ID

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const ADMIN_EMAILS = (process.env.ADMIN_CONSOLE_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const RESEND_KEY     = process.env.RESEND_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const STRIPE_KEY     = process.env.STRIPE_SECRET_KEY;
const VERCEL_TOKEN   = process.env.VERCEL_API_TOKEN;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM    = process.env.VERCEL_TEAM_ID;
const USD_TO_GBP     = 0.75; // keep in sync with /api/ai and the app

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

// fetch with a hard timeout so a hanging provider can't hang the whole board.
async function timedFetch(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const started = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return { res: r, ms: Date.now() - started };
  } finally { clearTimeout(t); }
}

// Shape every check returns: { name, status: "up"|"degraded"|"down"|"unconfigured", detail, metrics:[{label,value}], latencyMs }
function mk(name, status, detail, metrics = [], latencyMs = null) {
  return { name, status, detail, metrics, latencyMs };
}

async function checkSupabase() {
  if (!SUPABASE_URL || !SERVICE_KEY) return mk("Supabase", "unconfigured", "Database env vars not set.");
  try {
    // Lightweight authenticated REST ping - HEAD on a tiny table, no rows returned.
    const url = SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/proqure_data?select=user_id&limit=1";
    const { res, ms } = await timedFetch(url, {
      method: "HEAD",
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY },
    });
    if (res.ok || res.status === 206) return mk("Supabase", "up", "Database & auth reachable.", [], ms);
    return mk("Supabase", "down", "Responded " + res.status + ".", [], ms);
  } catch (e) {
    return mk("Supabase", "down", e.name === "AbortError" ? "Timed out." : "Unreachable.");
  }
}

async function checkOpenRouter() {
  if (!OPENROUTER_KEY) return mk("OpenRouter (AI)", "unconfigured", "OPENROUTER_API_KEY not set.");
  try {
    const { res, ms } = await timedFetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: "Bearer " + OPENROUTER_KEY },
    });
    if (!res.ok) {
      // Fall back to the key endpoint (still proves reachability/auth)
      const k = await timedFetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: "Bearer " + OPENROUTER_KEY } });
      if (k.res.ok) return mk("OpenRouter (AI)", "up", "Reachable; balance unavailable on this key.", [], k.ms);
      return mk("OpenRouter (AI)", "down", "Responded " + res.status + ".", [], ms);
    }
    const j = await res.json().catch(() => ({}));
    const d = (j && j.data) || {};
    const purchased = Number(d.total_credits || 0);
    const used = Number(d.total_usage || 0);
    const remaining = purchased - used;
    const metrics = [
      { label: "Credit remaining", value: "$" + remaining.toFixed(2) },
      { label: "≈ GBP", value: "£" + (remaining * USD_TO_GBP).toFixed(2) },
    ];

    // Spend trend: the /key endpoint exposes current period spend for this key.
    // We use the weekly figure to estimate a daily burn rate and a rough
    // "days of credit left" so the warning is actionable, not just a balance.
    let weekSpend = null, daysLeft = null;
    try {
      const kr = await timedFetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: "Bearer " + OPENROUTER_KEY } }, 5000);
      if (kr.res.ok) {
        const kj = await kr.res.json().catch(() => ({}));
        const kd = (kj && kj.data) || {};
        // Field names vary by account; try the common ones, else fall back to usage.
        const wk = kd.usage_weekly ?? kd.weekly_usage ?? (kd.usage && kd.usage.weekly);
        if (wk != null && !isNaN(Number(wk))) weekSpend = Number(wk);
      }
    } catch { /* trend is best-effort; balance still shown */ }

    if (weekSpend != null) {
      metrics.push({ label: "Spent this week", value: "$" + weekSpend.toFixed(2) });
      const perDay = weekSpend / 7;
      if (perDay > 0 && remaining > 0) {
        daysLeft = Math.floor(remaining / perDay);
        metrics.push({ label: "At this rate", value: daysLeft + " days left" });
      }
    } else {
      metrics.push({ label: "Used to date", value: "$" + used.toFixed(2) });
    }

    // Degraded if balance low OR burn rate would exhaust it within ~7 days.
    const lowBalance = remaining <= 0 ? "down" : remaining < 10 ? "degraded" : "up";
    const lowRunway = (daysLeft != null && daysLeft <= 7 && remaining > 0) ? "degraded" : "up";
    const rank = { up: 0, degraded: 1, down: 2 };
    const status = rank[lowRunway] > rank[lowBalance] ? lowRunway : lowBalance;
    const detail = remaining <= 0 ? "Out of credit - AI will fail."
      : status === "degraded" && lowRunway === "degraded" && lowBalance !== "degraded" ? "Spending fast - about " + daysLeft + " days of credit left at this rate."
      : remaining < 10 ? "Credit running low - top up soon."
      : "Reachable, credit healthy.";
    return mk("OpenRouter (AI)", status, detail, metrics, ms);
  } catch (e) {
    return mk("OpenRouter (AI)", "down", e.name === "AbortError" ? "Timed out." : "Unreachable.");
  }
}

async function checkResend() {
  if (!RESEND_KEY) return mk("Resend (email)", "unconfigured", "RESEND_API_KEY not set.");
  try {
    const { res, ms } = await timedFetch("https://api.resend.com/domains", {
      headers: { Authorization: "Bearer " + RESEND_KEY },
    });
    if (!res.ok) return mk("Resend (email)", "down", "Responded " + res.status + ".", [], ms);
    const j = await res.json().catch(() => ({}));
    const domains = Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []);
    const verified = domains.filter(d => (d.status || "").toLowerCase() === "verified").length;
    const metrics = [
      { label: "Domains", value: String(domains.length) },
      { label: "Verified", value: String(verified) },
    ];
    const status = domains.length && verified === 0 ? "degraded" : "up";
    const detail = status === "degraded" ? "Reachable, but no verified sending domain." : "Reachable; sending domain verified.";
    return mk("Resend (email)", status, detail, metrics, ms);
  } catch (e) {
    return mk("Resend (email)", "down", e.name === "AbortError" ? "Timed out." : "Unreachable.");
  }
}

async function checkStripe() {
  if (!STRIPE_KEY) return mk("Stripe (billing)", "unconfigured", "STRIPE_SECRET_KEY not set.");
  try {
    const { res, ms } = await timedFetch("https://api.stripe.com/v1/balance", {
      headers: { Authorization: "Bearer " + STRIPE_KEY },
    });
    if (!res.ok) return mk("Stripe (billing)", "down", "Responded " + res.status + ".", [], ms);
    const live = !/^sk_test_/.test(STRIPE_KEY);
    return mk("Stripe (billing)", "up", live ? "Reachable (LIVE mode)." : "Reachable (test mode).",
      [{ label: "Mode", value: live ? "Live" : "Test" }], ms);
  } catch (e) {
    return mk("Stripe (billing)", "down", e.name === "AbortError" ? "Timed out." : "Unreachable.");
  }
}

async function checkVercel() {
  if (!VERCEL_TOKEN || !VERCEL_PROJECT) {
    return mk("Vercel (hosting)", "unconfigured",
      "Add a read-only VERCEL_API_TOKEN and VERCEL_PROJECT_ID to enable.");
  }
  try {
    const team = VERCEL_TEAM ? ("&teamId=" + encodeURIComponent(VERCEL_TEAM)) : "";
    const url = "https://api.vercel.com/v6/deployments?projectId=" + encodeURIComponent(VERCEL_PROJECT) + "&limit=5&target=production" + team;
    const { res, ms } = await timedFetch(url, { headers: { Authorization: "Bearer " + VERCEL_TOKEN } });
    if (!res.ok) return mk("Vercel (hosting)", "down", "API responded " + res.status + ".", [], ms);
    const j = await res.json().catch(() => ({}));
    const deps = j.deployments || [];
    const latest = deps[0];
    if (!latest) return mk("Vercel (hosting)", "up", "Reachable; no recent deployments.", [], ms);
    const st = (latest.readyState || latest.state || "").toUpperCase();
    const errored = deps.filter(d => (d.readyState || d.state || "").toUpperCase() === "ERROR").length;
    const ago = latest.created ? Math.round((Date.now() - latest.created) / 60000) : null;
    const metrics = [
      { label: "Last deploy", value: st || "?" },
      { label: "When", value: ago == null ? "-" : (ago < 60 ? ago + "m ago" : Math.round(ago / 60) + "h ago") },
      { label: "Errored (last 5)", value: String(errored) },
    ];
    const status = st === "ERROR" ? "down" : errored > 0 ? "degraded" : "up";
    const detail = st === "ERROR" ? "Latest production build errored." : errored > 0 ? "A recent build errored." : "Latest production build is live.";
    return mk("Vercel (hosting)", status, detail, metrics, ms);
  } catch (e) {
    return mk("Vercel (hosting)", "down", e.name === "AbortError" ? "Timed out." : "Unreachable.");
  }
}

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

  // Authenticate the caller (same guard as admin-metrics).
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

  // Run all checks in parallel; each is individually guarded so one failure can't
  // break the others or the response.
  const settle = (p, name) => p.catch(e => mk(name, "down", "Check failed: " + (e && e.message ? e.message : "error")));
  const services = await Promise.all([
    settle(checkSupabase(), "Supabase"),
    settle(checkVercel(), "Vercel (hosting)"),
    settle(checkOpenRouter(), "OpenRouter (AI)"),
    settle(checkResend(), "Resend (email)"),
    settle(checkStripe(), "Stripe (billing)"),
  ]);

  // Overall = worst of the configured services (unconfigured doesn't drag it down).
  const rank = { up: 0, degraded: 1, down: 2 };
  let worst = "up";
  for (const s of services) {
    if (s.status === "unconfigured") continue;
    if (rank[s.status] > rank[worst]) worst = s.status;
  }
  res.status(200).json({ ok: true, overall: worst, services, generatedAt: new Date().toISOString() });
}
