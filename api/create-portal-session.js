// api/create-portal-session.js
// Opens the Stripe-hosted Customer Portal so a manager can change plan, update
// their card, see invoices, or cancel — zero billing UI for us to build.
//
// ENV: STRIPE_SECRET_KEY, APP_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const APP = (process.env.APP_URL || "https://app.proqure.co.uk").replace(/\/+$/, "");
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = (SUPABASE_URL && SERVICE_KEY) ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { cors(res); return res.status(200).end(); }
  cors(res);
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!stripe || !supabase) return res.status(500).json({ error: "Billing is not configured yet." });

  const { companyId } = req.body || {};
  if (!companyId) return res.status(400).json({ error: "Missing companyId" });

  try {
    const { data } = await supabase.from("proqure_billing")
      .select("stripe_customer_id").eq("company_id", companyId).maybeSingle();
    const customer = data && data.stripe_customer_id;
    if (!customer) return res.status(400).json({ error: "No billing account yet — start a plan first." });
    const sess = await stripe.billingPortal.sessions.create({
      customer,
      return_url: `${APP}/?billing=portal`,
    });
    return res.status(200).json({ url: sess.url });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Stripe error" });
  }
}
