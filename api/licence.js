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
// STRIPE: payment is intentionally left out for now (the website button just proceeds).
// When you add it, take the payment immediately BEFORE the inviteUserByEmail call below
// and only send the link once it succeeds - nothing else here needs to change.
//
// Required Vercel env vars (server-only - never exposed to the browser):
//   SUPABASE_URL                - project URL (falls back to VITE_SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (Project Settings > API)
//   APP_URL                     - where the setup link lands, e.g. https://app.proqure.co.uk
//   LICENCE_SIGNUP_KEY          - OPTIONAL shared guard; if set, the website must send a
//                                 matching `key`. Leave unset while it's just you + Andy.
//
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const APP_URL = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
const LICENCE_KEY = process.env.LICENCE_SIGNUP_KEY || "";

const admin = (SUPABASE_URL && SERVICE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { cors(res); return res.status(200).end(); }
  cors(res);
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!admin) return res.status(500).json({ error: "Signups aren't configured on the server yet." });

  const body = req.body || {};

  // Honeypot: a hidden field real users never fill. If it's populated it's a bot -
  // pretend success and do nothing.
  if (body.company_url) return res.status(200).json({ ok: true });

  // Optional shared-key guard (enable by setting LICENCE_SIGNUP_KEY in Vercel + the site).
  if (LICENCE_KEY && body.key !== LICENCE_KEY) return res.status(403).json({ error: "Not authorised" });

  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim();
  const company = String(body.company || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
  if (!company) return res.status(400).json({ error: "Enter your company name" });

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
        // Already has an account: send a sign-in/reset link so they can still get in.
        try { await admin.auth.resetPasswordForEmail(email, { redirectTo }); } catch (e) {}
        return res.status(200).json({ ok: true, note: "existing-user" });
      }
      return res.status(500).json({ error: "Could not send your setup email: " + error.message });
    }
  } catch (e) {
    return res.status(500).json({ error: "Could not send your setup email just now - please try again." });
  }

  return res.status(200).json({ ok: true });
}
