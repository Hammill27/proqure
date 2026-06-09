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

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
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
    const sess = await stripe.checkout.sessions.create({
      ...base,
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      metadata: { companyId, plan },
      subscription_data: { trial_period_days: 14, metadata: { companyId } },
      allow_promotion_codes: true,
      success_url: `${APP}/?billing=success`,
    });
    return res.status(200).json({ url: sess.url });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Stripe error" });
  }
}
