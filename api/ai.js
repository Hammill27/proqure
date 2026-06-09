// Serverless function: proxies AI requests to OpenRouter using a central key.
// The key lives in the Vercel environment variable OPENROUTER_API_KEY and is
// never exposed to the browser. The app calls this endpoint instead of calling
// OpenRouter directly.
//
// Web search (added for the O&M file generator): when the request body sets
//   web: true
// the request is run with OpenRouter's web plugin enabled (Exa-backed) so the
// model can ground its answer in live web results — used to locate manufacturer
// datasheets/literature. Web search is METERED on the OpenRouter account
// (billed per result), so it is OFF unless the caller explicitly asks for it.

import { createClient } from "@supabase/supabase-js";

// Server-authoritative monthly AI budget (the circuit-breaker's real wall).
// Mirrors the client ENTITLEMENTS.aiBudget — KEEP THE TWO IN SYNC. It is a GBP
// ceiling on OpenRouter cost per company per calendar month; at/over it, this
// endpoint refuses to spend. Per-company and per-plan: each tenant is measured
// only against its own plan and its own spend — never any global total.
const AI_BUDGET = { trial: 6, sole: 6, team: 20, business: 60, enterprise: 150 };
// OpenRouter reports cost in USD; the budgets above are GBP. Keep this rate in
// sync with the client (procurement-dashboard.jsx) and admin console.
const USD_TO_GBP = 0.75;
const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const sb = (SB_URL && SB_SERVICE) ? createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } }) : null;
const sbAnon = (SB_URL && SB_ANON) ? createClient(SB_URL, SB_ANON, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const aiPeriod = () => new Date().toISOString().slice(0, 7); // "YYYY-MM"

// Verify the caller is a signed-in ProQure user and resolve their REAL company id
// from the members table (never trusted from the request body, so one tenant can
// neither drain another tenant's AI budget nor dodge their own). If auth can't be
// verified server-side (anon key not configured), behaviour falls back to the
// previous open mode so nothing breaks — but with the env set, no token = no AI.
async function verifyCaller(req) {
  if (!sbAnon) return { mode: "open" }; // verification not configured: legacy behaviour
  const h = req.headers.authorization || req.headers.Authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : null;
  if (!token) return { mode: "deny" };
  try {
    const { data, error } = await sbAnon.auth.getUser(token);
    if (error || !data || !data.user) return { mode: "deny" };
    const uid = data.user.id;
    let companyId = uid; // a brand-new signup is their own company
    if (sb) {
      try {
        const { data: m } = await sb.from("members").select("company_id").eq("user_id", uid).limit(1).maybeSingle();
        if (m && m.company_id) companyId = m.company_id;
      } catch (e) { /* fall back to uid */ }
    }
    return { mode: "ok", companyId };
  } catch (e) { return { mode: "deny" }; }
}


// Read the company's plan + this-month authoritative spend (server-owned meter,
// store_key piq_ai_meter — the client cannot write it once the RLS lock is run).
async function meterRead(companyId) {
  const { data } = await sb.from("proqure_data").select("store_key,value")
    .eq("user_id", companyId).in("store_key", ["piq_settings", "piq_ai_meter"]);
  let plan = "trial", spent = 0;
  for (const row of (data || [])) {
    if (row.store_key === "piq_settings" && row.value) plan = row.value.plan || "trial";
    if (row.store_key === "piq_ai_meter" && row.value && row.value.period === aiPeriod()) spent = Number(row.value.costPeriod) || 0;
  }
  return { plan, spent };
}
// Add a call's cost to the server-owned meter (auto-resets on a new month).
async function meterAdd(companyId, cost) {
  const p = aiPeriod();
  const { data } = await sb.from("proqure_data").select("value")
    .eq("user_id", companyId).eq("store_key", "piq_ai_meter").maybeSingle();
  const cur = (data && data.value && data.value.period === p) ? (Number(data.value.costPeriod) || 0) : 0;
  const value = { period: p, costPeriod: Number((cur + (Number(cost) || 0)).toFixed(6)) };
  await sb.from("proqure_data").upsert(
    { user_id: companyId, store_key: "piq_ai_meter", value, updated_at: new Date().toISOString() },
    { onConflict: "user_id,store_key" });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "AI is not configured on the server." });
  }

  try {
    const { messages, models, temperature, web, maxResults, user, companyId } = req.body || {};
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Missing messages" });
    }

    // Caller verification (closes the open-proxy hole): a valid signed-in session
    // is required, and the company is resolved SERVER-SIDE from membership.
    const who = await verifyCaller(req);
    if (who.mode === "deny") {
      return res.status(401).json({ error: "Please sign in to use AI features." });
    }
    const effectiveCompany = who.mode === "ok" ? who.companyId : (companyId || null);

    // Circuit-breaker (server-authoritative): refuse to spend if this company is
    // already at/over its plan's monthly AI cost cap. Per-tenant, per-plan only.
    // The meter stores USD (OpenRouter's unit); budgets are GBP, so convert.
    if (sb && effectiveCompany) {
      try {
        const { plan, spent } = await meterRead(effectiveCompany);
        const cap = AI_BUDGET[plan] != null ? AI_BUDGET[plan] : AI_BUDGET.trial;
        if (cap > 0 && spent * USD_TO_GBP >= cap) {
          return res.status(402).json({ error: "Monthly AI limit reached for this plan.", blocked: true });
        }
      } catch (e) { /* fail-open: never break the app over a metering read */ }
    }

    // When web search is requested we need a tool/plugin-capable model. Flash-tier
    // Gemini handles the web plugin well and is cheap, so we prefer it for web
    // requests; otherwise use the caller's list (or the standard fallbacks).
    // Listed newest-first; the loop below falls through to the next if a slug has
    // been retired, so this keeps working when OpenRouter rotates model versions.
    // All are routed through OpenRouter - no other provider is used.
    const webModels = ["google/gemini-2.5-flash", "google/gemini-3.1-flash-lite"];
    const standardModels = [
      "deepseek/deepseek-chat",
      "meta-llama/llama-3.1-8b-instruct",
      "mistralai/mistral-7b-instruct",
      "google/gemini-flash-1.5",
    ];
    const modelList = web
      ? (Array.isArray(models) && models.length ? models : webModels)
      : (Array.isArray(models) && models.length ? models : standardModels);

    // OpenRouter web plugin (Exa-backed). Default 4 results keeps cost low.
    const plugins = web
      ? [{ id: "web", max_results: Math.min(Math.max(parseInt(maxResults, 10) || 4, 1), 8) }]
      : undefined;

    let lastErr = "";
    for (const model of modelList) {
      try {
        const body = {
          model,
          messages,
          temperature: typeof temperature === "number" ? temperature : 0.1,
        };
        if (plugins) body.plugins = plugins;
        // Optional end-user/company tag for OpenRouter's own reporting.
        if (typeof user === "string" && user) body.user = user.slice(0, 128);
        // Ask OpenRouter to include usage accounting (cost) in the response.
        body.usage = { include: true };

        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
            "HTTP-Referer": "https://proqure.app",
            "X-Title": "ProQure",
          },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (d.error) { lastErr = d.error.message || "API error"; continue; }
        const msg = d.choices?.[0]?.message || {};
        const text = msg.content || "";
        // url_citation annotations carry the source URLs the web plugin found.
        const citations = (msg.annotations || [])
          .filter(a => a && (a.type === "url_citation" || a.url_citation))
          .map(a => (a.url_citation || a))
          .map(c => ({ url: c.url, title: c.title || "" }))
          .filter(c => c.url);
        if (text) {
          // Usage accounting: OpenRouter returns token counts and the actual
          // request cost (USD) in `usage`. We surface it so the app can record
          // per-company spend for the admin cost dashboard.
          const usage = d.usage || null;
          const cost = usage && usage.cost != null ? Number(usage.cost) : null;
          // Record authoritative spend so the cap can't be bypassed client-side.
          if (sb && effectiveCompany && cost != null) { try { await meterAdd(effectiveCompany, cost); } catch (e) { /* never break on meter write */ } }
          return res.status(200).json({ text, citations, usage, cost, model, web: !!web });
        }
      } catch (e) {
        lastErr = e.message;
      }
    }
    return res.status(502).json({ error: "No models available: " + lastErr });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
