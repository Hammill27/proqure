// Serverless function: self-serve licence / free-trial signup from the marketing site.
//
// Flow: a visitor on the marketing website fills in the "Get your licence" form and
// submits. The site POSTs { name, company, email } here. We create the new business
// owner's account with Supabase's service-role key and email them an invite link to
// set a password. When they click it they land in the app, set a password, and the
// app's existing onboarding wizard collects the rest - leaving them as the Manager of
// a brand-new, fully isolated company (resolveCompany bootstraps that on first sign-in,
// because we deliberately do NOT pre-register them into any existing company).
//
// ABUSE CONTROLS (this endpoint is public + unauthenticated, so it is hardened in depth):
//   1. Honeypot       - a hidden field real users never fill; if set, pretend success.
//   2. Optional key   - LICENCE_SIGNUP_KEY, if set, must match.
//   3. Turnstile      - if TURNSTILE_SECRET_KEY is set, a valid Cloudflare Turnstile
//                       token is required (invisible CAPTCHA). Gated on the env var so
//                       nothing breaks until the widget is live on the site.
//   4. Disposable mail - reject throwaway inbox domains used for trial-farming.
//   5. Per-IP throttle - a small number of signups per IP per hour (best-effort,
//                       fail-open). A Vercel WAF rate-limit rule on /api/licence is the
//                       recommended edge-layer complement (see deployment notes).
// Even past all of these, a completed trial can spend at most its plan's AI budget,
// and the proqure_billing_guard DB trigger makes that plan/trial window
// server-authoritative so a trial cannot promote itself or extend its own clock.
//
// STRIPE: payment is intentionally left out for now (the website button just proceeds).
// When you add it, take the payment immediately BEFORE the inviteUserByEmail call below
// and only send the link once it succeeds - nothing else here needs to change.
//
// Required Vercel env vars (server-only - never exposed to the browser):
//   SUPABASE_URL                - project URL (falls back to VITE_SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (Project Settings > API)
//   APP_URL                     - where the setup link lands, e.g. https://app.proqure.co.uk
//   LICENCE_SIGNUP_KEY          - OPTIONAL shared guard; if set, the website must send a
//                                 matching `key`. Leave unset for open self-serve signup.
//   TURNSTILE_SECRET_KEY        - OPTIONAL; if set, a valid Cloudflare Turnstile token
//                                 (sent as `turnstileToken`) is required.
//
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const APP_URL = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
const LICENCE_KEY = process.env.LICENCE_SIGNUP_KEY || "";
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || "";

const admin = (SUPABASE_URL && SERVICE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// --- Abuse-control tunables -------------------------------------------------
const MAX_SIGNUPS_PER_IP_PER_HOUR = 3;   // generous for a real person, lethal to a script
const THROTTLE_UID = "platform-signup";  // synthetic row owner for the throttle ledger
const THROTTLE_KEY = "piq_signup_throttle";
const THROTTLE_WINDOW_MS = 60 * 60 * 1000;
const THROTTLE_MAX_IPS = 5000;           // cap the ledger size

// Throwaway-inbox domains commonly used to farm free trials. Not exhaustive by
// design - the goal is to raise the cost of mass abuse, not to be a perfect list.
// Extend freely, or swap for a maintained list later.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com",
  "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org",
  "tempmail.net", "throwawaymail.com", "yopmail.com", "getnada.com", "nada.email",
  "trashmail.com", "trashmail.net", "maildrop.cc", "dispostable.com", "mintemail.com",
  "fakeinbox.com", "spam4.me", "mailnesia.com", "mohmal.com", "moakt.com",
  "emailondeck.com", "tempinbox.com", "burnermail.io", "mailcatch.com",
  "inboxbear.com", "tempr.email", "discard.email", "anonbox.net", "spamgourmet.com",
]);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function clientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.headers["x-real-ip"] || null;
}

// Best-effort per-IP throttle on the signup ledger. Uses the service-role client
// (so it works without a user session). FAIL-OPEN: a bookkeeping error must never
// block a genuine signup - the Turnstile + WAF layers are the hard stops.
async function tooManySignups(ip) {
  if (!admin || !ip) return false;
  try {
    const { data } = await admin.from("proqure_data").select("value")
      .eq("user_id", THROTTLE_UID).eq("store_key", THROTTLE_KEY).maybeSingle();
    const map = (data && data.value && data.value.ips) || {};
    const cutoff = Date.now() - THROTTLE_WINDOW_MS;
    const recent = (map[ip] || []).filter(t => t >= cutoff);
    if (recent.length >= MAX_SIGNUPS_PER_IP_PER_HOUR) return true;
    recent.push(Date.now());
    map[ip] = recent;
    // Prune expired IPs and cap the ledger so it can't grow without bound.
    const pruned = {};
    let n = 0;
    for (const k of Object.keys(map)) {
      const r = (map[k] || []).filter(t => t >= cutoff);
      if (r.length) { pruned[k] = r; n++; }
      if (n >= THROTTLE_MAX_IPS) break;
    }
    await admin.from("proqure_data").upsert(
      { user_id: THROTTLE_UID, store_key: THROTTLE_KEY, value: { ips: pruned }, updated_at: new Date().toISOString() },
      { onConflict: "user_id,store_key" });
    return false;
  } catch (e) {
    return false; // fail-open
  }
}

// Verify a Cloudflare Turnstile token. Only called when TURNSTILE_SECRET is set.
async function turnstileOk(token, ip) {
  try {
    const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token || "" });
    if (ip) form.set("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const j = await r.json().catch(() => ({}));
    return !!(j && j.success);
  } catch (e) {
    return false; // if Cloudflare is unreachable we treat it as not-verified (fail-closed on the captcha)
  }
}

// An existing identity buying ANOTHER company. Identity is independent of any company,
// so we provision a brand-new, fully isolated tenant they own as Manager and let them
// sign in with their existing account to set it up - we do NOT create a second auth user.
// resolveCompany matches memberships by email, so the new company shows up for them on
// next sign-in; pointing active_company at it lands them straight in onboarding.
const MAX_OWNED_COMPANIES = 25;
async function provisionCompanyForExisting(email, company) {
  // Find their existing user id from any already-bound membership (e.g. their first company).
  let uid = null;
  try {
    const { data } = await admin.from("members")
      .select("user_id").eq("email", email).not("user_id", "is", null).limit(1).maybeSingle();
    uid = (data && data.user_id) || null;
  } catch (e) { /* fall through - an email-bound membership still resolves on sign-in */ }

  // Soft cap so one account can't mint unlimited trial tenants.
  if (uid) {
    try {
      const { count } = await admin.from("members")
        .select("company_id", { count: "exact", head: true })
        .eq("user_id", uid).eq("role", "manager");
      if (typeof count === "number" && count >= MAX_OWNED_COMPANIES) {
        return { status: 429, error: "You've reached the limit on companies for one account. Contact support if you need more." };
      }
    } catch (e) { /* fail-open on the count */ }
  }

  const newId = randomUUID();
  try {
    const { error: mErr } = await admin.from("members").insert({
      email, company_id: newId, role: "manager", user_id: uid, company_name: company,
    });
    if (mErr) return { status: 500, error: "Could not create your company: " + mErr.message };
  } catch (e) { return { status: 500, error: "Could not create your company just now - please try again." }; }

  // Point their validated active company at the new one so signing in lands straight in
  // its onboarding wizard (we deliberately write no piq_settings, so onboarding runs).
  if (uid) {
    try {
      await admin.from("active_company").upsert(
        { user_id: uid, company_id: newId, set_at: new Date().toISOString() },
        { onConflict: "user_id" });
    } catch (e) { /* non-fatal: the chooser will still offer the new company */ }
  }
  return { company_id: newId };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { cors(res); return res.status(200).end(); }
  cors(res);
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!admin) return res.status(500).json({ error: "Signups aren't configured on the server yet." });

  const body = req.body || {};

  // 1) Honeypot: a hidden field real users never fill. If it's populated it's a bot -
  // pretend success and do nothing.
  if (body.company_url) return res.status(200).json({ ok: true });

  // 2) Optional shared-key guard (enable by setting LICENCE_SIGNUP_KEY in Vercel + the site).
  if (LICENCE_KEY && body.key !== LICENCE_KEY) return res.status(403).json({ error: "Not authorised" });

  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim();
  const company = String(body.company || "").trim();

  // 3) Basic validation.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
  if (!company) return res.status(400).json({ error: "Enter your company name" });

  // 4) Reject disposable / throwaway inbox domains (trial-farming defence).
  const domain = email.split("@")[1] || "";
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return res.status(400).json({ error: "Please sign up with your business email address." });
  }

  const ip = clientIp(req);

  // 5) Turnstile (only enforced once TURNSTILE_SECRET_KEY is set + the widget is live).
  if (TURNSTILE_SECRET) {
    const token = body.turnstileToken || body.cf_turnstile_response || "";
    if (!token) return res.status(400).json({ error: "Please complete the verification and try again." });
    const ok = await turnstileOk(token, ip);
    if (!ok) return res.status(403).json({ error: "Verification failed - please try again." });
  }

  // 6) Per-IP throttle (checked just before the expensive invite/email step).
  if (await tooManySignups(ip)) {
    return res.status(429).json({ error: "Too many signups from this connection. Please try again later." });
  }

  // --- Stripe payment would be taken HERE, before the link is sent (left out for now). ---

  const redirectTo = APP_URL || undefined;
  try {
    const { error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      // name + company ride along so the in-app onboarding wizard pre-fills them.
      data: { name, company, is_owner: true, plan: "trial" },
    });
    if (error) {
      const msg = (error.message || "").toLowerCase();
      if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
        // Existing identity buying another company: provision a new tenant they own and
        // let them sign in with their existing account to set it up (no new auth user,
        // no confusing password-reset email).
        const made = await provisionCompanyForExisting(email, company);
        if (made.error) return res.status(made.status || 500).json({ error: made.error });
        return res.status(200).json({ ok: true, existing: true, company_id: made.company_id });
      }
      return res.status(500).json({ error: "Could not send your setup email: " + error.message });
    }
  } catch (e) {
    return res.status(500).json({ error: "Could not send your setup email just now - please try again." });
  }

  return res.status(200).json({ ok: true });
}
