// api/create-company.js — in-app "create another company" (Step 5a).
// ----------------------------------------------------------------------------
// Lets an already-signed-in user spin up a brand-new, fully isolated company
// that they own as Manager — the in-app counterpart to the marketing site's
// "Get your licence" signup, but for someone who already has an account.
//
// Why this runs on the server: a new tenant needs a fresh company_id that the
// caller is not yet a member of, and both the members row and the active_company
// switch are privileged writes. The browser can only bootstrap a company keyed
// to its OWN uid (resolveCompany's first-Manager path); it cannot mint an
// arbitrary new company_id under row-level security. This endpoint does it with
// the service-role key, but ONLY after verifying the caller's session, so it can
// never be used to act for anyone else.
//
// It deliberately does NOT write piq_settings: when the client reloads, the
// app's normal onboarding wizard runs for the new company (the Manager fills in
// trade / address / sending email, and the initial free trial is set there — the
// proqure_billing_guard trigger allows that first trial set). active_company is
// pointed at the new company so the reload lands straight inside it.
//
// Auth + env mirror api/notify-event.js. No DB change required.
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

// A generous ceiling so a real operator can run several businesses, while a single
// account still cannot mint unlimited trial tenants.
const MAX_OWNED_COMPANIES = 25;

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

  const name = clip(body.name, 120).trim();
  if (!name) { res.status(400).json({ error: "Enter a company name." }); return; }

  const callerEmail = (caller.email || "").toLowerCase();
  if (!callerEmail) { res.status(400).json({ error: "Your account has no email address." }); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // 2) cap the number of companies a single account can own (anti-abuse).
  try {
    const { count, error } = await admin.from("members")
      .select("company_id", { count: "exact", head: true })
      .eq("user_id", caller.id).eq("role", "manager");
    if (!error && typeof count === "number" && count >= MAX_OWNED_COMPANIES) {
      res.status(429).json({ error: "You've reached the limit on companies for one account. Contact support if you need more." });
      return;
    }
  } catch { /* fail-open on the count; the insert below is the real action */ }

  // 3) mint a fresh, isolated company and make the caller its Manager.
  const newId = randomUUID();
  try {
    const { error: insErr } = await admin.from("members").insert({
      email: callerEmail,
      company_id: newId,
      role: "manager",
      user_id: caller.id,
      company_name: name,
    });
    if (insErr) { res.status(500).json({ error: "Could not create the company: " + insErr.message }); return; }
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || "Could not create the company." }); return;
  }

  // 4) point the caller's validated active company at the new one, so the client
  //    reload lands straight in it and runs onboarding.
  try {
    await admin.from("active_company").upsert(
      { user_id: caller.id, company_id: newId, set_at: new Date().toISOString() },
      { onConflict: "user_id" });
  } catch { /* non-fatal: the chooser/switcher can still select it afterwards */ }

  res.status(200).json({ ok: true, company_id: newId });
}
