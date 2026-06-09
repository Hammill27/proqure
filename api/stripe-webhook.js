// api/stripe-webhook.js
// The single source of truth for billing state. Stripe calls this on every
// billing event; we verify the signature, then sync the result into Supabase:
//   - proqure_data(piq_settings)  -> plan + subscriptionStatus (so the app reflects it)
//   - proqure_billing             -> customer/subscription/plan/status map (server-only)
//   - proqure_data(piq_usage)     -> credit add-on allowance blocks
// The plan is NEVER trusted from the browser — only from these verified events.
//
// ENV: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL,
//      SUPABASE_SERVICE_ROLE_KEY, STRIPE_PRICE_SOLE/_TEAM/_BUSINESS/_ENTERPRISE
// SETUP: register https://app.proqure.co.uk/api/stripe-webhook in Stripe (test
//        mode first) for: checkout.session.completed, customer.subscription.updated,
//        customer.subscription.deleted, invoice.payment_failed, invoice.paid.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", { apiVersion: "2024-06-20" });
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET || "";
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = (SUPABASE_URL && SERVICE_KEY) ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

const PRICE_TO_PLAN = {
  [process.env.STRIPE_PRICE_SOLE || "_s"]: "sole",
  [process.env.STRIPE_PRICE_TEAM || "_t"]: "team",
  [process.env.STRIPE_PRICE_BUSINESS || "_b"]: "business",
  [process.env.STRIPE_PRICE_ENTERPRISE || "_e"]: "enterprise",
};
const period = () => new Date().toISOString().slice(0, 7);

async function readRaw(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "string") return req.body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw) return raw;
  } catch (e) { /* fall through */ }
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  return "";
}

function normStatus(s) {
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid") return "past_due";
  if (s === "canceled") return "cancelled";
  return s || "active";
}
function planFromSub(sub) {
  try { return PRICE_TO_PLAN[sub.items.data[0].price.id]; } catch { return undefined; }
}

async function companyByCustomer(customer) {
  if (!supabase || !customer) return null;
  const { data } = await supabase.from("proqure_billing")
    .select("company_id").eq("stripe_customer_id", customer).maybeSingle();
  return (data && data.company_id) || null;
}

async function mergeBilling(companyId, fields) {
  if (!supabase || !companyId) return;
  const { data } = await supabase.from("proqure_billing")
    .select("*").eq("company_id", companyId).maybeSingle();
  const row = { ...(data || {}), company_id: companyId, updated_at: new Date().toISOString() };
  if (fields.customer) row.stripe_customer_id = fields.customer;
  if (fields.sub) row.stripe_subscription_id = fields.sub;
  if (fields.plan) row.plan = fields.plan;
  if (fields.status) row.status = fields.status;
  await supabase.from("proqure_billing").upsert(row, { onConflict: "company_id" });
}

async function mergeSettings(companyId, fields) {
  if (!supabase || !companyId) return;
  const { data } = await supabase.from("proqure_data")
    .select("value").eq("user_id", companyId).eq("store_key", "piq_settings").maybeSingle();
  const v = (data && data.value) || {};
  if (fields.plan) v.plan = fields.plan;
  if (fields.subscriptionStatus) v.subscriptionStatus = fields.subscriptionStatus;
  if (fields.stripeCustomerId) v.stripeCustomerId = fields.stripeCustomerId;
  await supabase.from("proqure_data").upsert({ user_id: companyId, store_key: "piq_settings", value: v }, { onConflict: "user_id,store_key" });
}

async function creditAddon(companyId, meta) {
  if (!supabase || !companyId || !meta) return;
  const feature = meta.feature; const qty = Number(meta.qty) || 0;
  if (!feature || !qty) return;
  const { data } = await supabase.from("proqure_data")
    .select("value").eq("user_id", companyId).eq("store_key", "piq_usage").maybeSingle();
  const u = (data && data.value) || {};
  const p = period();
  const base = (u.period === p) ? u : { ...u, period: p, measureWebUsed: 0, omWebUsed: 0, catalogueWebUsed: 0, addons: {} };
  base.addons = { ...(base.addons || {}) };
  base.addons[feature] = (base.addons[feature] || 0) + qty;
  await supabase.from("proqure_data").upsert({ user_id: companyId, store_key: "piq_usage", value: base }, { onConflict: "user_id,store_key" });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const raw = await readRaw(req);
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, WHSEC);
  } catch (e) {
    return res.status(400).send(`Webhook signature verification failed: ${e.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        const companyId = s.client_reference_id || (s.metadata && s.metadata.companyId);
        if (s.mode === "payment") {
          await creditAddon(companyId, s.metadata);
        } else if (s.mode === "subscription" && s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          const plan = planFromSub(sub);
          await mergeBilling(companyId, { customer: s.customer, sub: sub.id, plan, status: normStatus(sub.status) });
          await mergeSettings(companyId, { plan, subscriptionStatus: normStatus(sub.status), stripeCustomerId: s.customer });
        }
        break;
      }
      case "customer.subscription.updated": {
        const evtSub = event.data.object;
        const companyId = (evtSub.metadata && evtSub.metadata.companyId) || await companyByCustomer(evtSub.customer);
        if (companyId) {
          // Stripe does not guarantee event ordering. Re-fetch the subscription so
          // we always apply its CURRENT state, never a stale snapshot from a
          // delayed/out-of-order event (which could otherwise re-activate a
          // just-cancelled sub, or vice-versa). Fall back to the event on failure.
          let sub = evtSub;
          try { sub = await stripe.subscriptions.retrieve(evtSub.id); } catch (e) { /* use event copy */ }
          const plan = planFromSub(sub);
          await mergeBilling(companyId, { customer: sub.customer, sub: sub.id, plan, status: normStatus(sub.status) });
          await mergeSettings(companyId, { plan, subscriptionStatus: normStatus(sub.status) });
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const companyId = (sub.metadata && sub.metadata.companyId) || await companyByCustomer(sub.customer);
        if (companyId) {
          await mergeBilling(companyId, { status: "cancelled" });
          await mergeSettings(companyId, { plan: "trial", subscriptionStatus: "cancelled" });
        }
        break;
      }
      case "invoice.payment_failed": {
        const companyId = await companyByCustomer(event.data.object.customer);
        if (companyId) { await mergeBilling(companyId, { status: "past_due" }); await mergeSettings(companyId, { subscriptionStatus: "past_due" }); }
        break;
      }
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const companyId = await companyByCustomer(event.data.object.customer);
        if (companyId) { await mergeBilling(companyId, { status: "active" }); await mergeSettings(companyId, { subscriptionStatus: "active" }); }
        break;
      }
      default: break;
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("stripe-webhook processing error:", e);
    return res.status(500).json({ error: e.message }); // 5xx -> Stripe retries
  }
}
