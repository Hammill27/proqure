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


// Caller verification: billing actions must come from a signed-in MANAGER of the
// company in question (when the anon key is configured; otherwise legacy open mode).
const SB_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const sbAnon = (SUPABASE_URL && SB_ANON_KEY) ? createClient(SUPABASE_URL, SB_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
async function verifyManager(req, companyId) {
  if (!sbAnon) return { ok: true, open: true };
  const h = req.headers.authorization || req.headers.Authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : null;
  if (!token) return { ok: false, reason: "Please sign in." };
  try {
    const { data, error } = await sbAnon.auth.getUser(token);
    if (error || !data || !data.user) return { ok: false, reason: "Session invalid or expired." };
    const uid = data.user.id;
    if (uid === companyId) return { ok: true }; // the company owner account itself
    if (supabase) {
      const { data: m } = await supabase.from("members").select("role").eq("user_id", uid).eq("company_id", companyId).limit(1).maybeSingle();
      if (m && m.role === "manager") return { ok: true };
    }
    return { ok: false, reason: "Only a manager of this company can manage billing." };
  } catch (e) { return { ok: false, reason: "Could not verify session." }; }
}

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
  const ver = await verifyManager(req, companyId);
  if (!ver.ok) return res.status(401).json({ error: ver.reason });

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
