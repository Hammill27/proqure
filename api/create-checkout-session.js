// api/create-checkout-session.js
// Creates a Stripe Checkout session — either a SUBSCRIPTION (a plan) or a
// one-time PAYMENT (an add-on block). The browser never sees card data; Stripe
// hosts the page. The company is tracked via client_reference_id + metadata so
// the webhook can attribute the result back to the right tenant.
//
// ENV: STRIPE_SECRET_KEY, APP_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      STRIPE_PRICE_SOLE / _TEAM / _BUSINESS / _ENTERPRISE (recurring prices),
//      STRIPE_PRICE_MEASURE_BLOCK / _OM_BLOCK / _CATALOGUE_BLOCK (one-time prices)
// Use TEST keys/prices first (sk_test_…, price_… created in test mode).

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" }) : null;
const APP = (process.env.APP_URL || "https://app.proqure.co.uk").replace(/\/+$/, "");
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = (SUPABASE_URL && SERVICE_KEY) ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

const PLAN_PRICES = {
  sole: process.env.STRIPE_PRICE_SOLE,
  team: process.env.STRIPE_PRICE_TEAM,
  business: process.env.STRIPE_PRICE_BUSINESS,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};
// One-time add-on blocks. qty = how many of that feature's allowance to credit.
const ADDONS = {
  measure_block:   { price: process.env.STRIPE_PRICE_MEASURE_BLOCK,   feature: "measureWeb",   qty: 100 },
  om_block:        { price: process.env.STRIPE_PRICE_OM_BLOCK,        feature: "omWeb",        qty: 10  },
  catalogue_block: { price: process.env.STRIPE_PRICE_CATALOGUE_BLOCK, feature: "catalogueWeb", qty: 100 },
};


// Read the assurance level (aal1 = password only, aal2 = password + MFA) straight
// from the verified JWT, so the server can require MFA was actually completed.
function tokenAal(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return (payload && payload.aal) ? String(payload.aal) : null;
  } catch { return null; }
}

// Caller verification: billing actions must come from a signed-in MANAGER of the
// company in question (when the anon key is configured; otherwise legacy open mode).
const SB_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const sbAnon = (SUPABASE_URL && SB_ANON_KEY) ? createClient(SUPABASE_URL, SB_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
async function verifyManager(req, companyId) {
  if (!sbAnon) return { ok: false, reason: "Billing verification unavailable." };
  const h = req.headers.authorization || req.headers.Authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : null;
  if (!token) return { ok: false, reason: "Please sign in." };
  try {
    const { data, error } = await sbAnon.auth.getUser(token);
    if (error || !data || !data.user) return { ok: false, reason: "Session invalid or expired." };
    const uid = data.user.id;
    let isManager = (uid === companyId); // the company owner account itself
    if (!isManager && supabase) {
      const { data: m } = await supabase.from("members").select("role").eq("user_id", uid).eq("company_id", companyId).limit(1).maybeSingle();
      if (m && m.role === "manager") isManager = true;
    }
    if (!isManager) return { ok: false, reason: "Only a manager of this company can manage billing." };
    // Phase 2 — server-side MFA enforcement. Billing is a privileged action, so the
    // session must have actually cleared two-factor (aal2), exactly like the admin
    // console. Managers enrol 2FA at sign-in (Phase 1), so this is normally already
    // satisfied; it stops a password-only (aal1) session acting on billing even if
    // the in-app gate was bypassed or failed open.
    if (tokenAal(token) !== "aal2") {
      return { ok: false, code: "mfa_required", reason: "Two-factor authentication is required to manage billing. Complete the second step and try again." };
    }
    return { ok: true };
  } catch (e) { return { ok: false, reason: "Could not verify session." }; }
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function existingCustomer(companyId) {
  if (!supabase) return null;
  try {
    const { data } = await supabase.from("proqure_billing")
      .select("stripe_customer_id").eq("company_id", companyId).maybeSingle();
    return (data && data.stripe_customer_id) || null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { cors(res); return res.status(200).end(); }
  cors(res);
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!stripe) return res.status(500).json({ error: "Billing is not configured yet." });

  const { companyId, plan, kind, email } = req.body || {};
  if (!companyId) return res.status(400).json({ error: "Missing companyId" });
  const ver = await verifyManager(req, companyId);
  if (!ver.ok) return res.status(ver.code === "mfa_required" ? 403 : 401).json({ error: ver.reason, code: ver.code });

  try {
    const customer = await existingCustomer(companyId);
    const base = {
      client_reference_id: companyId,
      customer: customer || undefined,
      customer_email: customer ? undefined : (email || undefined),
      cancel_url: `${APP}/?billing=cancel`,
    };

    // One-time add-on block
    if (kind) {
      const a = ADDONS[kind];
      if (!a || !a.price) return res.status(400).json({ error: "Unknown or unconfigured add-on" });
      const meta = { companyId, kind, feature: a.feature, qty: String(a.qty) };
      const sess = await stripe.checkout.sessions.create({
        ...base,
        mode: "payment",
        line_items: [{ price: a.price, quantity: 1 }],
        metadata: meta,
        payment_intent_data: { metadata: meta },
        success_url: `${APP}/?billing=addon_ok`,
      });
      return res.status(200).json({ url: sess.url });
    }

    // Subscription (a plan)
    const price = PLAN_PRICES[plan];
    if (!price) return res.status(400).json({ error: "Unknown or unconfigured plan" });
    // Guard against double subscriptions: if this customer already has a live
    // subscription, send them to the Customer Portal to CHANGE plan instead of
    // creating a second concurrent subscription (which would double-bill them).
    if (customer) {
      try {
        const subs = await stripe.subscriptions.list({ customer, status: "all", limit: 10 });
        const live = (subs.data || []).some(su => ["active", "trialing", "past_due", "unpaid"].includes(su.status));
        if (live) {
          return res.status(409).json({ error: "You already have a subscription. Use ‘Manage billing’ to change your plan.", alreadySubscribed: true });
        }
      } catch (e) { /* if the check fails, fall through rather than block a genuine purchase */ }
    }
    const sess = await stripe.checkout.sessions.create({
      ...base,
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      metadata: { companyId, plan },
      // No Stripe-side trial: ProQure's own free trial is the single trial, so
      // paying here starts billing immediately (no confusing second trial email).
      subscription_data: { metadata: { companyId } },
      allow_promotion_codes: true,
      success_url: `${APP}/?billing=success`,
    });
    return res.status(200).json({ url: sess.url });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Stripe error" });
  }
}
