import { useState, useEffect, useRef, useCallback, Component } from "react";
import { createClient } from "@supabase/supabase-js";

// --- Supabase cloud sync ------------------------------------------------------
// Reads keys from Vercel environment variables. If they're absent, the app
// runs exactly as before (browser-only), so nothing breaks without them.
const SB_URL = (import.meta.env.VITE_SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
// Paste Supabase's "Publishable key" (sb_publishable_...) here. It is the modern
// replacement for the old "anon public" key and is safe to use in the browser
// because Row Level Security is enabled on the table.
const SB_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();
const cloudEnabled = !!(SB_URL && SB_KEY);
// Captured before Supabase consumes the URL, so we can tell when someone arrives via
// an invite or password-reset link and needs to set a password.
const INITIAL_HASH = (typeof window !== "undefined" ? (window.location.hash || "") : "");
const INITIAL_SEARCH = (typeof window !== "undefined" ? (window.location.search || "") : "");
// Arriving from the marketing site's "Start free trial" (app.proqure.co.uk/?signup=1):
// open straight on the signup screen and let them past the private-preview gate.
const INITIAL_WANTS_SIGNUP = /[?&]signup\b/.test(INITIAL_SEARCH) || /(^|[#&])signup\b/.test(INITIAL_HASH);
// Arriving on a genuine Supabase auth link (email confirmation, invite, password reset,
// magic link): also let them past the gate so they can finish, without the access code.
const INITIAL_AUTH_CALLBACK = /(access_token|token_hash|[?&]code=|type=(signup|recovery|invite|magiclink|email_change))/.test(INITIAL_HASH + INITIAL_SEARCH);
// Central AI: the OpenRouter key now lives in the /api/ai server function, so the
// app no longer requires the user to supply one. We assume the server route is
// available; callAI still falls back to a user key if present, and surfaces a
// friendly error if neither works.
const AI_VIA_SERVER = true;
// Email also goes through the /api/send-email server function (central Resend key).
const EMAIL_VIA_SERVER = true;

// --- Roles & permissions ------------------------------------------------------
// Hierarchy (high to low): manager > buyer > engineer
const ROLES = {
  manager:  { label: "Manager",  rank: 3, desc: "Full access, manages the team and approves everything", color: "#4A4AB8", bg: "#EEEEFB" },
  buyer:    { label: "Buyer",    rank: 2, desc: "Sends RFQs, handles quotes, raises purchase orders",  color: "#9A5B16", bg: "#FBF3E8" },
  engineer: { label: "Engineer", rank: 1, desc: "Raises the materials list and signs off deliveries",  color: "#5C6B7A", bg: "#EEF1F4" },
};
const roleRank = (r) => (ROLES[r]?.rank || 0);
// Hidden per-request reference for future supplier-reply matching (e.g. PQ-A7F3).
// Invisible to users today; it lets inbound replies be auto-matched to a job once the domain/inbound is live.
function makePqRef() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `PQ-${s}`;
}
// Permission helpers — what each role can do
const can = {
  approvePO:   (role) => roleRank(role) >= 2,   // buyer and above (manager approval is a separate toggle)
  manageTeam:  (role) => roleRank(role) >= 3,   // manager only
  editSettings:(role) => roleRank(role) >= 3,   // manager only
  createRequest:(role)=> roleRank(role) >= 1,   // everyone can raise a materials list
  deleteItems: (role) => roleRank(role) >= 3,   // manager only - archive/delete
  sendRFQ:     (role) => roleRank(role) >= 2,   // buyer and above send RFQs to suppliers
  raisePO:     (role) => roleRank(role) >= 2,   // buyer and above raise purchase orders
  viewCosts:   (role) => roleRank(role) >= 2,   // buyer and above see quote prices and spend
  viewAllJobs: (role) => roleRank(role) >= 2,   // buyer and above see all jobs; engineers see only their own
  manageSuppliers:(role)=> roleRank(role) >= 2, // buyer and above add/edit suppliers (remove stays manager-only)
};

// Per-tier MONTHLY allowances for the metered web-search features (the only
// usage-variable costs). Everything else is unlimited. Catalogue online lookups
// get their own line, separate from Measure and O&M (per Andy, Jun 2026).
// Trial mirrors Sole-Trader allowances.
// `aiBudget` is a HARD monthly ceiling on total AI cost (GBP, OpenRouter spend)
// for the company — the circuit-breaker. When this month's spend reaches it, all
// AI calls are blocked until the 1st (or an upgrade). Models are cheap and web
// search is separately metered, so these are generous safety nets; tune freely.
const ENTITLEMENTS = {
  trial:      { seats: 1,        measureWeb: 100,  omWeb: 5,   catalogueWeb: 50,   aiBudget: 6 },
  sole:       { seats: 1,        measureWeb: 100,  omWeb: 5,   catalogueWeb: 50,   aiBudget: 6 },
  team:       { seats: 10,       measureWeb: 300,  omWeb: 15,  catalogueWeb: 150,  aiBudget: 20 },
  business:   { seats: 50,       measureWeb: 1000, omWeb: 50,  catalogueWeb: 500,  aiBudget: 60 },
  enterprise: { seats: Infinity, measureWeb: 3000, omWeb: 150, catalogueWeb: 1500, aiBudget: 150 },
};
const planOf = (settings) => ENTITLEMENTS[settings && settings.plan] || ENTITLEMENTS.trial;
// OpenRouter reports AI cost in USD; the aiBudget caps above are GBP. This rate
// converts recorded spend for the cap check and the Settings display. Keep in
// sync with /api/ai (server wall) and the admin console.
const USD_TO_GBP = 0.75;
const billingPeriod = () => new Date().toISOString().slice(0, 7); // "YYYY-MM"
const PLAN_LABELS = { trial: "Trial", sole: "Sole Trader", team: "Team", business: "Business", enterprise: "Enterprise" };
const supabase = cloudEnabled ? createClient(SB_URL, SB_KEY) : null;

// The localStorage keys we mirror to the cloud
const SYNC_KEYS = ["piq_requests","piq_orders","piq_hires","piq_suppliers","piq_settings","piq_quote_library","piq_templates","piq_quote_sets","piq_activity","piq_team","piq_usage","piq_catalogues"];

// Pull every key for this user from the cloud into localStorage (on login)
async function cloudPull(userId) {
  if (!supabase || !userId) return false;
  try {
    const { data, error } = await supabase.from("proqure_data").select("store_key,value").eq("user_id", userId);
    if (error) { console.warn("cloudPull", error.message); return false; }
    (data || []).forEach(row => {
      if (SYNC_KEYS.includes(row.store_key) && row.value != null) {
        try { localStorage.setItem(row.store_key, JSON.stringify(row.value)); } catch {}
      }
    });
    return true;
  } catch (e) { console.warn("cloudPull failed", e); return false; }
}

// Push one key's value up to the cloud (on change), debounced by caller
async function cloudPush(userId, storeKey, valueObj) {
  if (!supabase || !userId) return;
  let out = valueObj;
  // Billing truth (plan / subscriptionStatus / stripeCustomerId) is written ONLY by
  // the Stripe webhook and the admin console, server-side. A device holding a stale
  // copy of settings must never overwrite it, so we overlay the cloud's current
  // billing fields onto whatever we push. Best-effort: if the read fails we push
  // as-is (same as before) rather than blocking the save.
  if (storeKey === "piq_settings") {
    try {
      const { data } = await supabase.from("proqure_data").select("value")
        .eq("user_id", userId).eq("store_key", "piq_settings").maybeSingle();
      const cv = data && data.value;
      if (cv && typeof cv === "object") {
        out = { ...valueObj };
        if (cv.plan != null) out.plan = cv.plan;
        if (cv.subscriptionStatus != null) out.subscriptionStatus = cv.subscriptionStatus;
        if (cv.stripeCustomerId != null) out.stripeCustomerId = cv.stripeCustomerId;
      }
    } catch (e) { /* best-effort */ }
  }
  const { error } = await supabase.from("proqure_data").upsert(
    { user_id: userId, store_key: storeKey, value: out, updated_at: new Date().toISOString() },
    { onConflict: "user_id,store_key" }
  );
  if (error) { console.warn("cloudPush failed", storeKey, error); throw error; }
}

// Resolve the signed-in user to their COMPANY scope, so an entire team shares one
// dataset instead of each person having a private silo. The first user of a brand-new
// account becomes the Manager of a new company (company id = their own user id);
// users invited by a Manager are pre-registered in `members` and join that company on
// first sign-in. If the `members` table isn't set up yet (or the lookup fails) this
// returns null and the caller falls back to per-user scope - so nothing breaks before
// the database step is applied.
async function resolveCompany(session) {
  if (!supabase || !session || !session.user) return null;
  const email = (session.user.email || "").toLowerCase();
  const uid = session.user.id;
  try {
    const { data: rows, error } = await supabase.from("members").select("company_id,role,user_id").eq("email", email).limit(1);
    if (error) { console.warn("resolveCompany: members lookup failed - falling back to per-user", error.message); return null; }
    if (rows && rows.length && rows[0].company_id) {
      // First sign-in: stamp their user id + join time so a Manager can see they're Active.
      if (!rows[0].user_id) {
        supabase.from("members").update({ user_id: uid, joined_at: new Date().toISOString() }).eq("email", email)
          .then(({ error: uErr }) => { if (uErr) console.warn("resolveCompany: activate failed", uErr.message); });
      }
      return { companyId: rows[0].company_id, role: rows[0].role || "engineer" };
    }
    // No membership yet: brand-new account = first Manager of a new company.
    const { error: insErr } = await supabase.from("members").insert({ email, company_id: uid, role: "manager", user_id: uid });
    if (insErr) { console.warn("resolveCompany: bootstrap insert failed - falling back", insErr.message); return null; }
    return { companyId: uid, role: "manager" };
  } catch (e) { console.warn("resolveCompany failed", e); return null; }
}


function useIsMobile() {
  const [isMobile, setIsMobile] = useState(typeof window!=="undefined"?window.innerWidth<768:false);
  useEffect(()=>{
    const fn = ()=>setIsMobile(window.innerWidth<768);
    window.addEventListener("resize",fn);
    return ()=>window.removeEventListener("resize",fn);
  },[]);
  return isMobile;
}

// --- Speech recognition hook -------------------------------------------------
function useSpeechRecognition({ onTranscript, onFinal }) {
  const recRef = useRef(null);
  const wantRef = useRef(false);
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  // Keep the latest callbacks in refs so the once-only setup effect below never
  // re-subscribes the mic, yet always invokes the current handler (avoids a
  // stale-closure trap if a caller's onFinal/onTranscript closes over state).
  const onFinalRef = useRef(onFinal);
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => { onFinalRef.current = onFinal; onTranscriptRef.current = onTranscript; });
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    setSupported(true);
    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = "en-GB";
    rec.onresult = (e) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t + " "; else interim += t;
      }
      if (final) onFinalRef.current(final); else onTranscriptRef.current(interim);
    };
    rec.onerror = (e) => {
      // Transient Android errors (no-speech, aborted, network) shouldn't end the
      // session - let onend decide. Only a hard permission/device error stops us.
      const err = e && e.error;
      if (err === "not-allowed" || err === "service-not-allowed" || err === "audio-capture") {
        wantRef.current = false; setListening(false);
      }
    };
    rec.onend = () => {
      // Android Chrome fires onend after every pause even in continuous mode. If the
      // user still wants to dictate, restart automatically so it doesn't cut out.
      if (wantRef.current) { try { rec.start(); } catch (e) { /* already starting */ } }
      else { setListening(false); }
    };
    recRef.current = rec;
    return () => { wantRef.current = false; try { rec.stop(); } catch (e) {} };
  }, []);
  const start = () => { if (recRef.current && !wantRef.current) { wantRef.current = true; try { recRef.current.start(); } catch (e) {} setListening(true); } };
  const stop  = () => { wantRef.current = false; if (recRef.current) { try { recRef.current.stop(); } catch (e) {} } setListening(false); };
  return { listening, supported, start, stop };
}

// --- Constants ----------------------------------------------------------------
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const RESEND_API    = "https://api.resend.com/emails";
const TRADES = ["Plumbing","Heating & Gas","Electrical","HVAC","Ventilation","Mechanical","Joinery & Carpentry","Bricklaying","Groundworks","Roofing","Plastering & Drylining","Decorating","Flooring & Tiling","Drainage","Steel & Fabrication","Landscaping","General"];
const DEFAULT_SUPPLIERS = [
  { id:1, name:"Travis Perkins",         categories:["Plumbing","HVAC","Electrical"],  email:"quotes@travisperkins.co.uk" },
  { id:2, name:"Wolseley UK",             categories:["Plumbing","HVAC"],               email:"rfq@wolseley.co.uk" },
  { id:3, name:"Screwfix Trade",          categories:["Electrical","Plumbing"],         email:"trade@screwfix.com" },
  { id:4, name:"City Electrical Factors", categories:["Electrical"],                    email:"quotes@cef.co.uk" },
  { id:5, name:"Graham",                  categories:["HVAC","Plumbing","Ventilation"], email:"rfq@grahamplumbingheating.co.uk" },
];

// Short, collision-resistant id for contacts/branches.
function genId(prefix="ID"){ return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`; }

// Normalise a supplier to the current shape. A supplier now holds:
//   contacts: [{ id, name, email, branch }]   - multiple named people, each their own email
//   branches: ["Leeds","Geldard Road", ...]   - named branches/depots
// Legacy suppliers stored a single `email`; we migrate that into one (unnamed) contact.
// We also keep a top-level `email` mirrored to the first contact for any older code path.
// This runs on load (covering both localStorage and cloud-pulled data, since cloud pull
// writes into localStorage before the app reads it), so existing suppliers are preserved.
function normSupplier(s){
  if(!s || typeof s!=="object") return s;
  const branches = Array.isArray(s.branches)
    ? s.branches.map(b=>typeof b==="string"?b:((b&&b.name)||"")).map(b=>String(b).trim()).filter(Boolean)
    : [];
  let contacts = Array.isArray(s.contacts) ? s.contacts : null;
  if(!contacts){ contacts = s.email ? [{ id:genId("C"), name:"", email:String(s.email).trim(), branch:"" }] : []; }
  contacts = contacts.filter(c=>c && typeof c==="object").map(c=>({
    id: c.id||genId("C"),
    name: (c.name||"").toString(),
    email: (c.email||"").toString().trim(),
    branch: (c.branch||"").toString()
  }));
  const primaryEmail = (contacts.find(c=>c.email)||{}).email || (s.email||"").toString().trim() || "";
  return { ...s, branches, contacts, email: primaryEmail };
}
function normSuppliers(list){ return Array.isArray(list) ? list.map(normSupplier) : list; }
const STATUS = {
  draft:    { bg:"var(--amber-light)",   text:"#854D0E",         label:"Draft" },
  "awaiting-buyer":    { bg:"var(--indigo-light)", text:"var(--indigo)", label:"With buyer" },
  "awaiting-approval": { bg:"var(--amber-light)",  text:"#854D0E",       label:"Awaiting approval" },
  pending:  { bg:"var(--indigo-light)",  text:"var(--indigo)",   label:"Pending quotes" },
  received: { bg:"#FAF5FF",             text:"#6B21A8",         label:"Quotes received" },
  approved: { bg:"var(--green-light)",   text:"var(--green-deep)",label:"Approved" },
};

// --- AI helpers ---------------------------------------------------------------
// Per-company AI usage metering. The app component registers a recorder on
// mount; callAI / callAIWeb and the raw /api/ai vision callsites report the
// OpenRouter cost so the admin dashboard can show spend per company. The usage
// object is already cloud-synced per tenant (piq_usage), so simply incrementing
// it attributes cost to the right company. No-op until a recorder is registered.
let __usageRecorder = null;
function reportAiUsage(cost, web = false) {
  try { if (__usageRecorder) __usageRecorder(Number(cost) || 0, !!web); } catch (e) { /* never break an AI call over metering */ }
}

// Circuit-breaker gate. The component registers a check that returns false once
// this month's AI spend has reached the plan's aiBudget. The AI helpers consult
// it BEFORE spending, so a runaway loop or accident can never outrun the monthly
// ceiling. No recorder registered (e.g. logged out) => allowed.
let __budgetCheck = null;
function aiBudgetOk() { try { return __budgetCheck ? !!__budgetCheck() : true; } catch (e) { return true; } }
const AI_BUDGET_MSG = "Your team has reached this month's AI limit. It resets on the 1st \u2014 or upgrade your plan for more headroom.";
// The current company id, set by the component. Sent with every /api/ai call so the
// SERVER can enforce the monthly AI budget authoritatively (the client gate above is
// only the fast first line and can be bypassed; the server is the real wall).
let __companyId = null;
// Attach the signed-in user's access token to server calls (/api/ai, /api/send-email,
// billing). The server verifies it and resolves the company from membership, so a
// stranger can't use ProQure's AI/email keys and a tenant can't spoof another tenant.
// Returns {} when logged out so the request still goes (the server then decides).
async function authHeaders() {
  try {
    if (!supabase) return {};
    const { data } = await supabase.auth.getSession();
    const t = data && data.session && data.session.access_token;
    return t ? { Authorization: "Bearer " + t } : {};
  } catch (e) { return {}; }
}

async function callAI(system, user, history=[], temperature=0.1) {
  if (!aiBudgetOk()) throw new Error(AI_BUDGET_MSG);
  const models = [
    "deepseek/deepseek-chat",
    "meta-llama/llama-3.1-8b-instruct",
    "mistralai/mistral-7b-instruct",
    "google/gemini-flash-1.5",
  ];
  const messages = [
    {role:"system",content:system},
    ...history.slice(-8),
    {role:"user",content:user}
  ];

  // Preferred path: central server key via /api/ai (user never needs a key).
  try {
    const res = await fetch("/api/ai", {
      method:"POST",
      headers:{"Content-Type":"application/json", ...(await authHeaders())},
      body: JSON.stringify({ messages, models, temperature, companyId: __companyId })
    });
    if (res.status === 402) throw new Error(AI_BUDGET_MSG);
    if (res.ok) {
      const d = await res.json();
      if (d.blocked) throw new Error(AI_BUDGET_MSG);
      if (d.text) { reportAiUsage(d.cost, false); return d.text; }
      if (d.error && !d.error.includes("not configured")) throw new Error(d.error);
      // if "not configured", fall through to the user-key path below
    }
  } catch(e) { if (e && e.message === AI_BUDGET_MSG) throw e; /* else fall through to direct call */ }

  // Fallback: user-provided key (legacy / if server key isn't set up yet).
  const key = window.__piq_or_key__ || "";
  if (!key) throw new Error("AI is temporarily unavailable \u2014 please try again in a moment.");
  let lastErr = "";
  for (const model of models) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+key,"HTTP-Referer":"https://proqure.app","X-Title":"ProQure"},
        body: JSON.stringify({ model, messages, temperature })
      });
      const d = await res.json();
      if (d.error) { lastErr = d.error.message||"API error"; continue; }
      const text = d.choices?.[0]?.message?.content || "";
      if (text) return text;
    } catch(e) { lastErr = e.message; }
  }
  throw new Error("No models available: "+lastErr);
}
async function parseMaterialList(raw) {
  const sys = `You are a procurement assistant for UK building and trades contractors across all disciplines. Parse a material request into structured JSON. Return ONLY valid JSON, no markdown.
Each item's "category" must be the single best-fit trade from this list: ${TRADES.join("|")}.
Format: {"items":[{"id":1,"description":"...","quantity":N,"unit":"...","category":"...","notes":"..."}],"jobRef":"...","urgency":"standard|urgent|next-day"}`;
  const txt = await callAI(sys, `Parse this material request: ${raw}`);
  try { return JSON.parse(txt.replace(/```json|```/g,"").trim()); } catch { return null; }
}

// ---- AI helpers for Quick PO & Hire features --------------------------------
// Turn a free-text/spoken hire description into structured hire fields.
async function aiParseHire(raw) {
  const sys = `You help a UK trades company log plant and tool hire. From a short description, return ONLY valid JSON, no markdown.
Format: {"description":"the equipment, tidied up","category":"plant|tool","jobRef":"if mentioned else empty","site":"if mentioned else empty","suggestedReturnDays":N or null,"missingReturnDate":true/false}
"plant" = larger machinery (excavators, dumpers, scaffolding, generators). "tool" = smaller items (breakers, drills, saws). missingReturnDate is true if no return/collection date or duration was stated.`;
  const txt = await callAI(sys, `Hire description: ${raw}`);
  try { return JSON.parse(txt.replace(/```json|```/g,"").trim()); } catch { return null; }
}

// Analyse hire history and surface hire-vs-buy suggestions.
async function aiHireVsBuy(hires) {
  // Group by a normalised description
  const summary = {};
  hires.forEach(h => {
    const key = (h.description||"").toLowerCase().trim();
    if (!key) return;
    if (!summary[key]) summary[key] = { description:h.description, count:0, weeklyRate:h.weeklyRate||"", totalWeeks:0 };
    summary[key].count += 1;
  });
  const list = Object.values(summary).filter(s => s.count >= 3);
  if (list.length === 0) return [];
  const sys = `You advise a UK trades company on whether repeatedly-hired equipment would be cheaper to buy. Return ONLY valid JSON, no markdown.
Format: {"suggestions":[{"description":"...","reason":"one short sentence with the numbers","strength":"strong|worth-a-look"}]}
Only include items where repeated hiring plausibly costs more than buying. Be realistic and brief. Do not invent purchase prices you don't know - frame as "worth checking the purchase price".`;
  const txt = await callAI(sys, `Hire history (item, times hired, weekly rate): ${JSON.stringify(list)}`);
  try { const j = JSON.parse(txt.replace(/```json|```/g,"").trim()); return j.suggestions||[]; } catch { return []; }
}

// Turn a spoken/typed emergency order into Quick PO fields.
async function aiParseQuickPO(raw, supplierNames) {
  const sys = `You help a UK trades buyer log an emergency phone order. From a short description, return ONLY valid JSON, no markdown.
Format: {"supplierName":"best match from the known list, or the name said, or empty","items":[{"description":"...","quantity":"...","unitPrice":""}],"total":"the agreed total if stated else empty","summary":"short note"}
Known suppliers: ${(supplierNames||[]).join(", ")||"none"}. Match the supplier loosely (e.g. "Travis" -> "Travis Perkins"). Put per-item prices only if clearly stated, otherwise leave unitPrice empty and rely on total.`;
  const txt = await callAI(sys, `Order: ${raw}`);
  try { return JSON.parse(txt.replace(/```json|```/g,"").trim()); } catch { return null; }
}

// Sanity-check a phone-agreed price against past quotes/orders for similar items.
async function aiPriceCheck(itemsText, total, pastText) {
  if (!pastText) return null;
  const sys = `You are a quiet price sanity-checker for a UK trades buyer. Compare a phone-agreed price to past prices for similar items. Return ONLY valid JSON, no markdown.
Format: {"flag":true/false,"message":"one short sentence, only if flag is true"}
Only flag if the new price looks clearly high (roughly 15%+ above comparable past prices). If you can't compare confidently, flag false. Never block - this is advisory.`;
  const txt = await callAI(sys, `New order: ${itemsText} total ${total}. Past prices for similar items: ${pastText}`);
  try { const j = JSON.parse(txt.replace(/```json|```/g,"").trim()); return j.flag ? j.message : null; } catch { return null; }
}

// Vision: read a hire delivery/collection photo and describe the equipment + visible condition.
async function aiReadHirePhoto(base64, mimeType, kind) {
  const sys = `You read photos of hired construction plant and tools for a UK trades company. Describe what you see factually and briefly for a delivery/condition record. Note the equipment type and any visible damage, missing parts, or notable condition. Return ONLY valid JSON, no markdown.
Format: {"equipment":"short name of the item(s)","condition":"one short factual sentence on visible condition","concerns":"any visible damage/missing parts, or empty string"}`;
  const messages = [
    { role:"system", content: sys },
    { role:"user", content: [
      { type:"image_url", image_url:{ url:`data:${mimeType};base64,${base64}` } },
      { type:"text", text: kind==="collection" ? "This is equipment left on site awaiting collection. Describe it and its condition/location." : "This is hired equipment as delivered to site. Describe it and its condition." }
    ]}
  ];
  try {
    if (!aiBudgetOk()) return null;
    const res = await fetch("/api/ai", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeaders())}, body: JSON.stringify({ messages, models:["google/gemini-flash-1.5"], temperature:0.1, companyId: __companyId }) });
    if (!res.ok) return null;
    const d = await res.json();
    reportAiUsage(d.cost, false);
    if (!d.text) return null;
    return JSON.parse(d.text.replace(/```json|```/g,"").trim());
  } catch { return null; }
}

async function generateRFQ(items, jobRef, company, contactName, fromEmail, deliveryMethod, deliveryDate, altAddress, rfqDeadline, siteAddress, collectFrom) {
  const sys = `You are a professional procurement system for a UK trades company. Generate a professional RFQ email body. Return ONLY the plain text email body, no subject line, no markdown.
IMPORTANT: Do NOT start with a greeting or salutation (no "Dear ...", no "Hello") - the greeting is added separately. Begin directly with the request itself (e.g. "We are requesting a quotation for the following materials..."). Do NOT add a sign-off, "Kind regards", or contact details at the end - a signature is added separately. Just the core request body.`;
  const list = items.map(i=>`- ${i.quantity} ${i.unit} ${i.description}`).join("\n");
  const deliveryLabels = {
    direct: "Delivery direct to site",
    alternative: `Delivery to alternative address: ${altAddress||"to be confirmed"}`,
    collect: `Collection${collectFrom?` from ${collectFrom}`:" from branch"}`,
    tbc: "Delivery method to be confirmed"
  };
  const deliveryStr = deliveryLabels[deliveryMethod]||deliveryMethod;
  const dateStr = deliveryDate ? `Required by: ${deliveryDate}` : "Required date: To be confirmed";
  const deadlineStr = rfqDeadline ? `Please respond by: ${new Date(rfqDeadline).toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}` : "";
  const siteStr = (deliveryMethod==="direct" && siteAddress) ? `\n- Delivery to site: ${siteAddress}` : "";
  return callAI(sys,
    `Generate an RFQ email body for ${company||"our company"}, job ref ${jobRef||"TBC"}.\n\nItems required:\n${list}\n\nDelivery requirements:\n- Method: ${deliveryStr}${siteStr}\n- ${dateStr}\n${deadlineStr?"- "+deadlineStr:""}\n\nAsk for unit prices, availability, lead time, and please ask them to include carriage/delivery charges in their quotation. Keep it concise and professional. Clearly mention the delivery method and required date${siteStr?", including the delivery site address,":""} in the email.${deadlineStr?" Prominently include the response deadline.":""} Remember: no greeting line and no sign-off - body only.`
  );
}
// --- Quote text pre-processor ------------------------------------------------
function preprocessQuoteText(raw) {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(from|regards|thanks|sent from|dear|hi |hello|to:|cc:|subject:|date:).*/gim, "")
    .replace(/[^\x20-\x7E\n\u00A3\u20AC$]/g, " ")
    .trim();
}

// --- Parse price string to float ----------------------------------------------
function parsePrice(s) {
  if (s == null) return null;
  if (typeof s === "number") return isNaN(s) ? null : s;
  if (typeof s !== "string") return null;
  let str = s.trim();
  if (!str) return null;
  // Reject obvious non-prices
  if (/^(poa|tba|tbc|n\/?a|call|on application|see (note|below)|-|—|quoted separately)$/i.test(str)) return null;
  // Detect negative (discounts, credits)
  const negative = /^-|^\(|credit|less|discount/i.test(str) && !/\+/.test(str);
  // Grab the FIRST monetary number only (avoids "£45 (was £60)" merging into 4560)
  // Handles 1,234.56 and 1234.56 and 1.234,56 (European)
  // First strip currency words/symbols around, then find first number token
  // Find the first monetary number. Order matters: try thousands-grouped form first,
  // then a plain decimal/integer. The thousands form REQUIRES a comma group so it
  // won't wrongly truncate "1234.56".
  const m = str.match(/\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/);
  if (!m) return null;
  let num = m[0].replace(/,/g, ""); // remove thousands separators
  const n = parseFloat(num);
  if (isNaN(n)) return null;
  return negative ? -Math.abs(n) : n;
}

// Consistent UK currency formatting: 1234.5 -> "1,234.50"
function fmtMoney(n) {
  const v = typeof n === "number" ? n : parsePrice(String(n));
  if (v == null || isNaN(v)) return "0.00";
  return v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// --- JavaScript post-processor - validates AI output -------------------------
function validateAndFix(analysis, requestedItems) {
  if (!analysis || analysis.error) return analysis;

  const warnings = [...(analysis.warnings||[])];
  const matched = (analysis.matched||[]).map(m => {
    let confidence = "high";
    const unitPrice = parsePrice(m.unitPrice);
    const requestedQty = parseFloat(m.requestedQty) || 0;
    const quotedQty = parseFloat(m.quotedQty) || requestedQty;

    // Recalculate line total from unit price × quoted qty
    let calculatedTotal = null;
    if (unitPrice !== null && quotedQty > 0) {
      calculatedTotal = unitPrice * quotedQty;
      const aiTotal = parsePrice(m.lineTotal);
      if (aiTotal !== null && Math.abs(aiTotal - calculatedTotal) > 0.02) {
        warnings.push(`Maths check: ${m.item} - AI said £${aiTotal.toFixed(2)} but ${quotedQty} × £${unitPrice.toFixed(2)} = £${calculatedTotal.toFixed(2)}`);
        confidence = "low";
      }
    }

    // Flag uncertain prices
    if (!m.unitPrice || m.unitPrice === "Not quoted" || m.unitPrice === "POA" || m.unitPrice === "TBA" || m.unitPrice === "-") {
      confidence = "low";
    }

    // Flag if unit price looks suspiciously high or low (sanity check)
    if (unitPrice !== null) {
      if (unitPrice < 0.01) { warnings.push(`Suspicious price: ${m.item} quoted at £${unitPrice} - please verify`); confidence = "low"; }
      if (unitPrice > 50000) { warnings.push(`Unusually high price: ${m.item} at £${unitPrice} - please verify`); confidence = "low"; }
    }

    // Flag qty mismatch
    if (requestedQty > 0 && quotedQty > 0 && Math.abs(requestedQty - quotedQty) > 0.001) {
      confidence = confidence === "high" ? "medium" : confidence;
    }

    // Vague stock status - downgrade confidence
    if (m.stockQty === "unknown" || (typeof m.inStock !== "boolean")) {
      confidence = confidence === "high" ? "medium" : confidence;
    }

    return {
      ...m,
      lineTotal: calculatedTotal !== null ? `£${calculatedTotal.toFixed(2)}` : m.lineTotal,
      confidence,
    };
  });

  // Recompute subtotal from validated line totals
  const computedSubtotal = matched.reduce((sum, m) => {
    const t = parsePrice(m.lineTotal);
    return sum + (t || 0);
  }, 0);

  const aiSubtotal = parsePrice(analysis.subtotal);
  if (aiSubtotal !== null && computedSubtotal > 0 && Math.abs(aiSubtotal - computedSubtotal) > 0.50) {
    warnings.push(`Subtotal check: AI said ${analysis.subtotal} but line totals add up to £${computedSubtotal.toFixed(2)}`);
  }

  // Use computed subtotal if more reliable
  const finalSubtotal = computedSubtotal > 0 ? `£${computedSubtotal.toFixed(2)}` : analysis.subtotal;

  // Recompute estimated total with carriage
  const carriageAmt = parsePrice(analysis.carriageCharge);
  const finalTotal = carriageAmt !== null && computedSubtotal > 0
    ? `£${(computedSubtotal + carriageAmt).toFixed(2)}`
    : analysis.estimatedTotal || finalSubtotal;

  // Completeness score - verify against actual matched vs requested
  const requestedCount = requestedItems.length;
  const matchedCount = matched.filter(m => m.unitPrice && m.unitPrice !== "Not quoted" && m.unitPrice !== "-").length;
  const missingCount = (analysis.missing||[]).length;
  const computedCompleteness = requestedCount > 0
    ? Math.round((matchedCount / requestedCount) * 100)
    : analysis.completeness;

  // Use the lower of AI completeness or computed - prevents AI over-claiming
  const finalCompleteness = Math.min(analysis.completeness || 0, computedCompleteness);

  // Flag carriage ambiguity
  const carriageRaw = (analysis.carriageCharge||"").toLowerCase();
  if (carriageRaw.includes("over") || carriageRaw.includes("above") || carriageRaw.includes("minimum") || carriageRaw.includes("depending")) {
    warnings.push(`Carriage condition: "${analysis.carriageCharge}" - verify whether this order qualifies for free delivery`);
  }

  // --- Additional money-safety checks ---------------------------------------
  // Unit mismatch (e.g. requested in metres, quoted per box) - real cost risk
  matched.forEach(m => {
    const ru = (m.requestedUnit||"").toLowerCase().trim();
    const qu = (m.quotedUnit||"").toLowerCase().trim();
    if (ru && qu && ru !== qu && !(ru.includes(qu) || qu.includes(ru))) {
      warnings.push(`Unit mismatch: ${m.item} requested in "${m.requestedUnit}" but quoted per "${m.quotedUnit}" - confirm you are comparing like-for-like`);
    }
  });

  // VAT clarity - if no VAT info at all, the true cost is uncertain
  if (!analysis.vatRaw && !analysis.vatNote && !(analysis.vatIncluded === true || analysis.vatIncluded === false)) {
    warnings.push("VAT status unclear - confirm whether quoted prices include or exclude VAT before approving");
  }

  // Duplicate match detection - same quote line matched to two requested items
  const seenProducts = {};
  matched.forEach(m => {
    const key = (m.quotedProduct||"").toLowerCase().trim();
    if (key && key.length > 3) {
      seenProducts[key] = (seenProducts[key]||0) + 1;
      if (seenProducts[key] === 2) warnings.push(`Possible duplicate: "${m.quotedProduct}" appears matched more than once - verify line items`);
    }
  });

  // Low-confidence lines that carry a price are the highest risk - count them
  const riskyPricedLines = matched.filter(m => m.confidence === "low" && parsePrice(m.unitPrice) !== null).length;

  // Hard review flag: any condition that means a human MUST check before trusting totals
  const requiresReview =
    riskyPricedLines > 0 ||
    finalCompleteness < 90 ||
    (aiSubtotal !== null && computedSubtotal > 0 && Math.abs(aiSubtotal - computedSubtotal) > 0.50) ||
    warnings.some(w => /maths check|suspicious|unusually high|unit mismatch/i.test(w));

  // Overall verdict based on validated completeness
  const overallVerdict = finalCompleteness >= 90 ? "excellent"
    : finalCompleteness >= 75 ? "good"
    : finalCompleteness >= 50 ? "partial"
    : "poor";

  return {
    ...analysis,
    matched,
    warnings: [...new Set(warnings)], // deduplicate
    subtotal: finalSubtotal,
    estimatedTotal: finalTotal,
    completeness: finalCompleteness,
    overallVerdict,
    requiresReview,
    riskyPricedLines,
    _validated: true,
  };
}

// --- Stage 1: Extract raw line items from quote -------------------------------
async function extractQuoteLines(quoteText, supplierName) {
  const sys = `You are a data extraction specialist. Your ONLY job is to extract every pricing line from a supplier quote EXACTLY as written. Do not interpret, match, or analyse anything. Just extract the raw lines.

Return ONLY valid JSON - no markdown, no explanation:
{
  "supplierName": "...",
  "lines": [
    {"rawText":"exact line from quote","product":"product name as written","qty":null or number,"unit":"unit as written or null","unitPrice":null or number,"lineTotal":null or number,"currency":"GBP"}
  ],
  "carriageRaw": "exact carriage text or null",
  "leadTimeRaw": "exact lead time text or null",
  "vatRaw": "exact VAT text or null",
  "discountRaw": "exact discount text or null",
  "quoteRef": "supplier quote reference or null"
}

Rules - CRITICAL (money depends on this being exact):
- Copy product names EXACTLY as they appear - do not normalise or interpret
- Copy EVERY digit of every price and quantity precisely. Do not round, estimate, or "tidy" numbers. £1,234.56 must be 1234.56, not 1234 or 1200.
- Keep unitPrice and lineTotal as SEPARATE numbers. Never put a line total in the unitPrice field or vice versa.
- If a price says "POA", "TBA", "Call", "On application" - set unitPrice to null and note in rawText
- If a quantity is ambiguous (e.g. "10 x 3m lengths") - set qty to null and preserve rawText exactly
- ONLY include lines that are clearly products or services being quoted
- Do NOT include lines that are email headers, signatures, addresses, payment terms
- If you cannot find a numeric price - set unitPrice to null, never guess
- A number you are unsure about is worse than null. When in doubt, set the field to null and keep the exact text in rawText.

Before returning, silently re-read each line and check: does unitPrice multiplied by qty roughly equal lineTotal? If a line fails this check, re-read the original text for that line and correct it. Only then return the JSON.`;

  const cleaned = preprocessQuoteText(quoteText);
  const raw = await callAI(sys,
    `Supplier: ${supplierName||"Unknown"}

Quote text:
${cleaned}

Extract all pricing lines as JSON.`
  );
  try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); }
  catch { return { lines:[], error:"extraction_failed", raw }; }
}

// --- Stage 2: Match extracted lines to requested items ------------------------
async function matchQuoteToRequest(requestedItems, extractedLines, supplierName) {
  const reqList = requestedItems.map((item,i) =>
    `${i+1}. ${item.quantity} ${item.unit} of "${item.description}"${item.notes?` [Note: ${item.notes}]`:""}`
  ).join("\n")

  const lineList = (extractedLines.lines||[]).map((l,i) =>
    `${i+1}. "${l.rawText}" | product: ${l.product} | qty: ${l.qty??'?'} | unit: ${l.unit??'?'} | unitPrice: ${l.unitPrice??'?'} | lineTotal: ${l.lineTotal??'?'}`
  ).join("\n")

  const sys = `You are a procurement matching specialist. Match supplier quote lines to requested items. Be STRICT - only match if you are genuinely confident. Return ONLY valid JSON, no markdown.

Output format:
{
  "matched": [
    {
      "requestedItem": "description from request",
      "requestedQty": number,
      "requestedUnit": "unit",
      "quotedProduct": "product name from quote",
      "quotedQty": number or null,
      "quotedUnit": "unit from quote or null",
      "unitPrice": "£X.XX or Not quoted",
      "lineTotal": "£X.XX or null",
      "inStock": true/false/null,
      "stockQty": "number or unknown",
      "leadTime": "string or null",
      "qtyMatch": true/false,
      "matchConfidence": "high|medium|low",
      "matchReason": "brief explanation of why these match",
      "notes": "any relevant notes"
    }
  ],
  "missing": [
    {"item":"description","reason":"not found in quote|out of stock|discontinued|price on application"}
  ],
  "alternatives": [
    {"requestedItem":"...","alternativeOffered":"...","altPrice":"...","reason":"why alternative","recommended":true/false}
  ],
  "unmatchedQuoteLines": ["lines in quote that didn't match any requested item"]
}

Matching rules - CRITICAL:
- Match based on product type, specification, and size - a "22mm compression elbow" matches "22mm elbow compression fitting"
- Do NOT match if the specification is different (e.g. 15mm vs 22mm, copper vs plastic)
- If partially matching (e.g. similar product but different spec) - set matchConfidence to "low" and explain in matchReason
- If a requested item appears NOWHERE in the quote - put it in missing, do not force a match
- qtyMatch is true only if quotedQty equals requestedQty exactly
- inStock: true if quote says "in stock", "available", "ex-stock"; false if "out of stock", "unavailable"; null if not mentioned
- matchConfidence high = clear exact match, medium = likely match with minor differences, low = uncertain`;

  const raw = await callAI(sys,
    `Supplier: ${supplierName||"Unknown"}

Requested items:
${reqList}

Extracted quote lines:
${lineList||"(no lines extracted)"}

Match and return JSON.`
  );
  try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); }
  catch { return { matched:[], missing:requestedItems.map(i=>({item:i.description,reason:"matching_failed"})), error:"matching_failed" }; }
}

// --- Stage 3: Synthesise final analysis --------------------------------------
async function synthesiseAnalysis(requestedItems, extractedData, matchedData, supplierName) {
  const sys = `You are a senior procurement analyst. You have been given pre-extracted and pre-matched quote data. Your job is to produce a final analysis summary. Return ONLY valid JSON, no markdown.

Output:
{
  "supplierName": "...",
  "recommendation": "2-sentence plain-English verdict - be specific about value, completeness, and any concerns",
  "discounts": [{"item":"...","discount":"percent or amount","detail":"condition if any"}],
  "positives": ["specific positive points - max 4"],
  "warnings": ["specific warnings - only real issues, max 5"],
  "vatNote": "exact VAT statement from quote or 'Not stated'",
  "carriageCharge": "£X.XX or Free or Free over £X or Not stated - use exact wording from quote",
  "leadTime": "exact lead time from quote or Not stated"
}

Rules:
- Base EVERYTHING on the provided data - do not invent or assume anything
- If carriageCharge has a condition (e.g. free over £150) - include the full condition
- Discounts only if explicitly stated in the quote - never infer
- Warnings only for real problems: missing items, qty mismatches, unclear prices, conditional carriage
- Positives only for genuinely good things: fast delivery, full availability, competitive pricing
- Recommendation must reference the actual completeness and total`;

  const summary = {
    supplier: supplierName,
    requested: requestedItems.map(i=>`${i.quantity} ${i.unit} ${i.description}`),
    matched: matchedData.matched?.length||0,
    missing: matchedData.missing?.length||0,
    carriageRaw: extractedData.carriageRaw||"not stated",
    leadTimeRaw: extractedData.leadTimeRaw||"not stated",
    vatRaw: extractedData.vatRaw||"not stated",
    discountRaw: extractedData.discountRaw||"none",
    warnings: matchedData.matched?.filter(m=>!m.qtyMatch||m.matchConfidence==="low").map(m=>`${m.requestedItem}: ${m.matchReason}`)||[],
  };

  const raw = await callAI(sys,
    `Data summary:
${JSON.stringify(summary,null,2)}

Produce final analysis JSON.`
  );
  try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); }
  catch { return { recommendation:"Analysis complete.", discounts:[], positives:[], warnings:[], vatNote:"Not stated", carriageCharge:"Not stated", leadTime:"Not stated" }; }
}

// --- Master analyseQuote - orchestrates all stages ---------------------------
async function analyseQuote(items, quoteText, supplierName, onProgress) {
  const progress = onProgress || (()=>{});

  try {
    // Stage 1: Extract
    progress("Extracting quote data...");
    const extracted = await extractQuoteLines(quoteText, supplierName);

    // Stage 2: Match
    progress("Matching items to request...");
    const matched = await matchQuoteToRequest(items, extracted, supplierName);

    // Stage 3: Synthesise
    progress("Validating and calculating...");
    const synthesis = await synthesiseAnalysis(items, extracted, matched, supplierName);

    // Compute subtotal from matched lines
    const lineTotal = (matched.matched||[]).reduce((sum,m)=>{
      const p = parsePrice(m.unitPrice);
      const q = parseFloat(m.quotedQty) || parseFloat(m.requestedQty) || 0;
      return sum + (p !== null && q > 0 ? p * q : parsePrice(m.lineTotal) || 0);
    }, 0);

    const carriageAmt = parsePrice(synthesis.carriageCharge);
    const estimatedTotal = lineTotal > 0
      ? `£${(lineTotal + (carriageAmt||0)).toFixed(2)}`
      : null;

    // Completeness - based on actual matched with real prices
    const pricedItems = (matched.matched||[]).filter(m => parsePrice(m.unitPrice) !== null && m.matchConfidence !== "low");
    const completeness = items.length > 0
      ? Math.round((pricedItems.length / items.length) * 100)
      : 0;

    const overallVerdict = completeness >= 90 ? "excellent"
      : completeness >= 75 ? "good"
      : completeness >= 50 ? "partial" : "poor";

    // Build unified result
    const result = {
      supplierName: extracted.supplierName || supplierName,
      completeness,
      overallVerdict,
      recommendation: synthesis.recommendation || "",
      subtotal: lineTotal > 0 ? `£${lineTotal.toFixed(2)}` : "Not calculated",
      carriageCharge: synthesis.carriageCharge || "Not stated",
      vatNote: synthesis.vatNote || "Not stated",
      estimatedTotal: estimatedTotal || "Not calculated",
      leadTime: synthesis.leadTime || extracted.leadTimeRaw || "Not stated",
      discounts: synthesis.discounts || [],
      matched: (matched.matched||[]).map(m => ({
        item: m.requestedItem,
        requestedQty: m.requestedQty,
        requestedUnit: m.requestedUnit,
        quotedQty: m.quotedQty,
        quotedUnit: m.quotedUnit || m.requestedUnit,
        unitPrice: m.unitPrice || "Not quoted",
        lineTotal: (() => {
          const p = parsePrice(m.unitPrice);
          const q = parseFloat(m.quotedQty) || parseFloat(m.requestedQty) || 0;
          return p !== null && q > 0 ? `£${(p*q).toFixed(2)}` : m.lineTotal || "-";
        })(),
        inStock: m.inStock,
        stockQty: m.stockQty || "unknown",
        qtyMatch: m.qtyMatch,
        confidence: m.matchConfidence,
        notes: [m.matchReason, m.notes].filter(Boolean).join(" · ") || "-",
      })),
      missing: matched.missing || [],
      alternatives: matched.alternatives || [],
      warnings: [
        ...(synthesis.warnings||[]),
        ...(matched.matched||[])
          .filter(m=>m.matchConfidence==="low")
          .map(m=>`Low confidence match: "${m.requestedItem}" > "${m.quotedProduct||"?"}" - please verify`),
      ].slice(0,8),
      positives: synthesis.positives || [],
      quoteRef: extracted.quoteRef || null,
      _validated: true,
      _stages: { extracted: extracted.lines?.length||0, matched: matched.matched?.length||0 },
    };

    // Final JS validation pass
    return validateAndFix(result, items);

  } catch(e) {
    return { error:true, errorMessage: e.message };
  }
}

// --- Extract quote text from uploaded file using AI --------------------------
// Convert a stored base64 data URL (e.g. an emailed supplier attachment) back into a
// File so it can go through the exact same extraction path as a manual upload.
function dataUrlToFile(dataUrl, name) {
  const [meta, b64] = String(dataUrl).split(",");
  const mime = ((meta || "").match(/data:([^;]+)/) || [])[1] || "application/octet-stream";
  const bin = atob(b64 || "");
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name || "attachment", { type: mime });
}
async function extractQuoteFromFile(fileContent, fileName, fileType) {
  const sys = `You are a procurement data extraction specialist. A supplier has sent a quote document. Extract ALL pricing information, stock availability, delivery charges, lead times, and any other relevant procurement data from the document content provided. Return the extracted information as clean, structured plain text that clearly lists each item with its price, availability, and any other details. Preserve all numbers and prices exactly. If the document appears to be a table or spreadsheet, convert it to a clear line-by-line format. Start directly with the extracted data, no preamble.`;
  const prompt = `File name: ${fileName}
File type: ${fileType}

Document content:
${fileContent}

Extract all quote/pricing information as clean structured text.`;
  return callAI(sys, prompt);
}

// --- Read file content for AI extraction -------------------------------------
async function readFileForExtraction(file) {
  return new Promise((resolve, reject) => {
    const ext = file.name.split(".").pop().toLowerCase();
    // For text-based files read directly
    if (["txt","csv","html","htm"].includes(ext)) {
      const reader = new FileReader();
      reader.onload = e => resolve({ content: e.target.result, type: "text" });
      reader.onerror = reject;
      reader.readAsText(file);
      return;
    }
    // For Excel files use SheetJS via CDN
    if (["xlsx","xls","ods"].includes(ext)) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          if (!window.XLSX) {
            await new Promise((res,rej)=>{
              const s=document.createElement("script");
              s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
              s.onload=res; s.onerror=rej;
              document.head.appendChild(s);
            });
          }
          const wb = window.XLSX.read(e.target.result, {type:"binary"});
          let text = "";
          wb.SheetNames.forEach(name => {
            const ws = wb.Sheets[name];
            text += `Sheet: ${name}\n`;
            text += window.XLSX.utils.sheet_to_csv(ws);
            text += "\n\n";
          });
          resolve({ content: text, type: "excel" });
        } catch(err) { reject(err); }
      };
      reader.onerror = reject;
      reader.readAsBinaryString(file);
      return;
    }
    // For PDF and Word - read as base64 and send to AI with note
    // (AI will do its best with the text it can extract)
    const reader = new FileReader();
    reader.onload = e => {
      // For PDFs we extract the raw text portions
      if (ext === "pdf") {
        const text = e.target.result;
        // Try to extract readable text from PDF binary
        const matches = text.match(/\((.*?)\)/g)||[];
        const extracted = matches
          .map(m=>m.slice(1,-1))
          .filter(s=>s.length>1&&/[a-zA-Z0-9£$€.,]/.test(s))
          .join(" ");
        resolve({ content: extracted||text.slice(0,5000), type:"pdf" });
      } else {
        resolve({ content: e.target.result.slice(0,8000), type:"binary" });
      }
    };
    reader.onerror = reject;
    reader.readAsBinaryString(file);
  });
}

// --- Email via Vercel serverless function (no CORS) --------------------------
// Build a branded HTML email from a plain-text body + optional logo
// Email template. Table-based for reliable rendering across Outlook/Gmail/Apple Mail
// (flexbox and many CSS features are stripped by email clients). Accepts an options
// object so the same renderer powers both the live send and the in-app preview.
function buildEmailHtml(bodyText, settings, optsOrToken={}) {
  // Back-compat: older callers passed a jobToken string as the 3rd arg.
  const opts = typeof optsOrToken === "string" ? { jobToken: optsOrToken } : (optsOrToken || {});
  const { supplierName = "", jobToken = "" } = opts;
  const esc = (s) => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  const company = esc(settings.company||"");
  const contactName = esc(settings.contactName||"");
  const accent = "#15824F";       // ProQure green
  const ink = "#1A1A17";
  const muted = "#6B6A62";

  // Header: logo on WHITE (works for any logo colour, including dark artwork).
  // If a logo is set, show it; otherwise show the company name as text.
  const logoImg = settings.logoBase64
    ? `<img src="${settings.logoBase64}" alt="${company||"Company"}" height="44" style="height:44px;max-height:44px;max-width:240px;display:inline-block;border:0;outline:none;text-decoration:none"/>`
    : `<span style="font-size:22px;font-weight:800;color:${ink};letter-spacing:-0.01em">${company||"ProQure"}</span>`;

  // Greeting line - personalised to the supplier when we know their name.
  const greeting = supplierName
    ? `<p style="margin:0 0 14px;font-size:15px;color:${ink}">Dear ${esc(supplierName)},</p>`
    : "";

  // Body: collapse 3+ blank lines, turn paragraph breaks into spaced paragraphs
  // and single breaks into <br> - avoids the over-spaced look from raw \n\n\n.
  const paras = esc(bodyText).trim().replace(/\n{3,}/g,"\n\n").split(/\n\n/);
  const safeBody = paras.map(p => `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:${ink}">${p.replace(/\n/g,"<br/>")}</p>`).join("");

  // Reply nudge: a short, branded line asking the supplier to reply to this email, so
  // their quote is captured automatically against the right job. Always present.
  const replyNudge = `<div style="margin:14px 0;padding:10px 14px;background:#F0F7F3;border-left:3px solid ${accent};border-radius:6px;font-size:13px;line-height:1.5;color:${ink}">Please <strong>reply to this email</strong> with your quotation - it keeps everything tracked against this enquiry.</div>`;

  // Site / delivery address block, if provided.
  const addr = esc(settings.siteAddress||"");
  const addressBlock = addr
    ? `<div style="margin-top:6px;margin-bottom:14px"><span style="font-size:11px;font-weight:700;color:${muted};text-transform:uppercase;letter-spacing:0.04em">Delivery / site address</span><br/><span style="font-size:14px;color:${ink}">${addr}</span></div>`
    : "";

  const terms = settings.poNotes
    ? `<div style="margin-top:18px;padding-top:14px;border-top:1px solid #EAE9E3;font-size:12px;line-height:1.5;color:${muted}">${esc(settings.poNotes)}</div>`
    : "";

  // Signature. If the user pasted one, use it - but neutralise the runaway widths,
  // huge fonts and big margins Outlook bakes in, and cap any image, so it sits neatly.
  let signature;
  if ((settings.emailSignature||"").trim()) {
    let sig = settings.emailSignature.trim();
    const looksHtml = /<[a-z][\s\S]*>/i.test(sig);
    if (looksHtml) {
      sig = sig
        .replace(/(<table[^>]*)\swidth="[^"]*"/gi,'$1')
        .replace(/(<t[dr][^>]*)\swidth="[^"]*"/gi,'$1')
        .replace(/<img/gi,'<img style="max-width:200px;height:auto;display:inline-block"')
        .replace(/font-size\s*:\s*(1[6-9]|[2-9]\d)px/gi,'font-size:14px'); // shrink oversized text
      sig = `<div style="font-size:13px;line-height:1.45;color:${ink}">${sig}</div>`;
    } else {
      sig = `<div style="font-size:13px;line-height:1.5;color:${ink}">${esc(sig).replace(/\n/g,"<br/>")}</div>`;
    }
    signature = `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #EAE9E3">${sig}</div>`;
  } else {
    const bits = [];
    if (contactName) bits.push(`<div style="font-size:14px;font-weight:700;color:${ink}">${contactName}</div>`);
    if (company) bits.push(`<div style="font-size:13px;color:${muted}">${company}</div>`);
    const line2 = [];
    if (settings.phone) line2.push(esc(settings.phone));
    if (settings.fromEmail) line2.push(esc(settings.fromEmail));
    if (line2.length) bits.push(`<div style="font-size:12px;color:${muted};margin-top:3px">${line2.join("&nbsp;&middot;&nbsp;")}</div>`);
    signature = bits.length
      ? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #EAE9E3">${bits.join("")}</div>`
      : "";
  }

  const pqMark = `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${accent};vertical-align:middle;margin-right:5px"></span>`;

  return `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta http-equiv="X-UA-Compatible" content="IE=edge"/></head>
<body style="margin:0;padding:0;background:#F4F4F1;-webkit-text-size-adjust:100%;font-family:'Helvetica Neue',Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F1">
    <tr><td align="center" style="padding:24px 16px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid #E8E7E1;border-radius:12px;overflow:hidden">
        <!-- Header: logo on white, green rule beneath -->
        <tr><td align="left" style="padding:24px 32px 18px 32px;background:#FFFFFF">${logoImg}</td></tr>
        <tr><td style="height:3px;background:${accent};line-height:3px;font-size:0">&nbsp;</td></tr>
        <!-- Body -->
        <tr><td style="padding:26px 32px 28px 32px">
          ${greeting}
          ${safeBody}
          ${replyNudge}
          ${addressBlock}
          ${terms}
          ${signature}
        </td></tr>
      </table>
      <!-- Footer -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
        <tr><td align="center" style="padding:14px 12px 0">
          <span style="font-size:11px;color:#908F86">${pqMark}Sent with <strong style="color:${accent};font-weight:700">ProQure</strong></span>
        </td></tr>
      </table>
      ${jobToken?`<div style="display:none;font-size:0;line-height:0;max-height:0;overflow:hidden;color:#F4F4F1">[ProQure-Ref:${esc(jobToken)}]</div>`:""}
    </td></tr>
  </table>
</body></html>`;
}

// --- Email sending identity (the decided model) ------------------------------
// ProQure sends from its own domain, showing the business as the display name,
// with Reply-To pointing at the user's real inbox. The customer's own email is
// never the sending address. Per-instance subdomains slot in later without
// changing this shape - only SENDING_DOMAIN becomes the instance subdomain.
const SENDING_DOMAIN = "proqure.co.uk"; // later: `${instanceSlug}.proqure.co.uk`
// Inbound reply capture (Resend Inbound). Empty = disabled: replies go to the user's
// own inbox exactly as before. Set the Vercel env var VITE_INBOUND_CAPTURE_DOMAIN to
// turn it on - to the Resend test domain (e.g. "xxxx.resend.app") for testing, or a
// verified subdomain (e.g. "reply.proqure.co.uk") live. It's a catch-all domain, so
// each supplier's reply is addressed to a unique q-<token>@<domain> address that
// api/inbound.js matches back to the right supplier + request.
const INBOUND_CAPTURE_DOMAIN = (import.meta.env.VITE_INBOUND_CAPTURE_DOMAIN || "").trim();
// Support/feedback destination. HARDWIRE the ProQure support mailbox here once it
// exists in Exchange Online (e.g. "support@proqure.co.uk") - Resend will then send
// each submission straight to it for a person to read and reply to. While this is
// blank, the contact form stays fully usable and simply shows a friendly
// confirmation without sending anything. Flip it on by setting this one string.
const FEEDBACK_EMAIL = "";
function buildSender(kind, settings={}) {
  // kind: "quotes" (RFQs) or "orders" (POs)
  const localPart = kind === "orders" ? "orders" : "quotes";
  const address = `${localPart}@${SENDING_DOMAIN}`;
  // Display name = the business, e.g. "Andy (Initial Mechanical)" or just the company.
  const biz = (settings.company || "").trim();
  const person = (settings.contactName || "").trim();
  let display = biz || person || "ProQure";
  if (biz && person) display = `${person} (${biz})`;
  // Strip characters that break the From header's display-name quoting.
  display = display.replace(/["\\<>]/g, "").trim();
  const from = `${display} <${address}>`;
  // Reply-To: where supplier replies should land. For now this is the user's own
  // inbox (so they receive replies during the sending trial). Later, when inbound
  // capture is built, this becomes a unique per-job ProQure capture address and the
  // user is CC'd a copy instead - the autofill then reads the reply.
  const replyTo = (settings.replyToEmail || settings.fromEmail || "").trim() || null;
  return { from, address, replyTo, display };
}

// A short, stable per-job reference embedded (invisibly) in outgoing RFQs so that,
// once inbound capture exists, a supplier's reply can be matched back to its job.
// Groundwork only - harmless now, essential for autofill later.
function jobReplyToken(jobRef, reqId) {
  const base = `${jobRef||""}-${reqId||""}`;
  let h = 0; for (let i=0;i<base.length;i++){ h = ((h<<5)-h + base.charCodeAt(i))|0; }
  return "PQ" + Math.abs(h).toString(36).slice(0,6).toUpperCase();
}

// Per-supplier reply token for inbound capture. Unique, lowercase, email-safe. Stored
// on each sentTo entry so api/inbound.js can match an incoming reply back to the exact
// supplier + request that was sent that address.
function makeReplyToken() {
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toLowerCase();
}
// Build the capture reply address for a token, e.g. q-ab12cd@reply.proqure.co.uk.
// Returns null when capture is disabled (INBOUND_CAPTURE_DOMAIN unset), so callers
// fall back to the user's own inbox exactly as before.
function captureReplyAddress(token) {
  return INBOUND_CAPTURE_DOMAIN ? `q-${token}@${INBOUND_CAPTURE_DOMAIN}` : null;
}

async function sendRFQEmails(suppliers, subject, body, apiKey, fromEmail, settings={}, jobCtx={}, attachments=[]) {
  const results = [];
  const sender = buildSender("quotes", settings);
  const token = jobReplyToken(jobCtx.jobRef, jobCtx.reqId); // hidden reply-matching groundwork (legacy/backup)
  for (const s of suppliers) {
    // Per-supplier reply token: when inbound capture is enabled the supplier's reply
    // is addressed to a unique catch-all address we can match back to this exact
    // supplier + request in api/inbound.js. Falls back to the user's own inbox when
    // capture is disabled (INBOUND_CAPTURE_DOMAIN unset), preserving prior behaviour.
    const replyToken = makeReplyToken();
    const captureAddr = captureReplyAddress(replyToken);
    const replyTo = captureAddr || sender.replyTo || undefined;
    try {
      const res = await fetch("/api/send-email", {
        method:"POST",
        headers:{"Content-Type":"application/json", ...(await authHeaders())},
        body: JSON.stringify({
          from: sender.from,
          company_id: __companyId,
          to:   [s.email],
          reply_to: replyTo,
          subject,
          text: body,
          html: buildEmailHtml(body, settings, { supplierName: s.contactName || s.name, jobToken: token }),
          ...(Array.isArray(attachments) && attachments.length ? { attachments: attachments.map(a => ({ filename: a.filename, content: a.content })) } : {})
        })
      });
      const d = await res.json();
      if (res.ok && d.success) {
        results.push({ supplier:s.name, success:true, id:d.id, replyToken });
      } else {
        results.push({ supplier:s.name, success:false, error:d.error||JSON.stringify(d), statusCode:res.status, replyToken });
      }
    } catch(e) {
      results.push({ supplier:s.name, success:false, error:"Network error: "+e.message, replyToken });
    }
  }
  return results;
}

// --- PDF generation via jsPDF (loaded from CDN on demand) --------------------
// --- Photo helpers: compress in-browser, then upload to Supabase Storage ------
// Keeps files tiny (~150-300KB) so we stay well within the free storage/bandwidth tiers.
function compressImage(file, maxWidth = 1200, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => { if (blob) resolve(blob); else reject(new Error("Compression failed")); },
          "image/jpeg",
          quality
        );
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Turns a user-picked File into a Resend-ready attachment {filename, content(base64)}.
// Images are compressed (JPEG) to keep the email payload small; PDFs/other pass through as-is.
async function fileToAttachment(file) {
  const isImg = (file.type || "").startsWith("image/");
  let blob = file;
  let filename = file.name || (isImg ? "image.jpg" : "document");
  if (isImg) {
    try { blob = await compressImage(file, 1600, 0.72); filename = (file.name || "image").replace(/\.[^.]+$/, "") + ".jpg"; }
    catch { blob = file; }
  }
  const content = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
  const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
  return { id, filename, content, size: Math.round((content.length * 3) / 4), kind: isImg ? "image" : "file" };
}

// Uploads a compressed photo to the 'hire-photos' bucket; returns a public URL.
async function uploadHirePhoto(file, hireId, kind) {
  if (!supabase) throw new Error("Photo storage needs cloud sync enabled");
  const blob = await compressImage(file);
  const path = `${hireId}/${kind}-${Date.now()}.jpg`;
  const { error } = await supabase.storage.from("hire-photos").upload(path, blob, {
    contentType: "image/jpeg",
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from("hire-photos").getPublicUrl(path);
  return data?.publicUrl || null;
}

async function generatePO({ poNumber, jobRef, site, supplier, items, analysis, company, contactName, contactEmail, date, deliveryText, requiredBy, invoiceEmail, logoBase64, totalOverride, output }) {
  if (!window.jspdf) {
    await new Promise((res,rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"mm", format:"a4" });
  const W = 210, M = 18;

  // -- Deep navy header bar --
  doc.setFillColor(15,23,42);
  doc.rect(0,0,W,42,"F");

  // Accent stripe
  doc.setFillColor(59,130,246);
  doc.rect(0,42,W,3,"F");

  // Company & PO title
  doc.setTextColor(255,255,255);
  doc.setFont("helvetica","bold"); doc.setFontSize(22);
  doc.text("PURCHASE ORDER", M, 18);
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.setTextColor(148,163,184);
  doc.text(company||"Your Company", M, 27);
  doc.text("Powered by ProQure", M, 33);

  // PO number & date - right aligned
  doc.setTextColor(255,255,255);
  doc.setFont("helvetica","bold"); doc.setFontSize(11);
  doc.text(poNumber, W-M, 18, {align:"right"});
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.setTextColor(148,163,184);
  doc.text(`Issued: ${date}`, W-M, 27, {align:"right"});

  // -- Optional company logo (top-left of body, aspect-preserved, never fatal) --
  let y = 54;
  if (logoBase64) {
    try {
      const dims = await new Promise((res)=>{ const im=new Image(); im.onload=()=>res({w:im.width,h:im.height}); im.onerror=()=>res(null); im.src=logoBase64; });
      if (dims && dims.h) { const h=12, w=Math.min(54, dims.w*(h/dims.h)); const fmt=/^data:image\/png/i.test(logoBase64)?"PNG":"JPEG"; doc.addImage(logoBase64, fmt, M, 47, w, h); y = 64; }
    } catch(e) {}
  }
  // -- Info boxes --
  // Box backgrounds
  doc.setFillColor(248,250,252); doc.roundedRect(M, y, 80, 32, 2, 2, "F");
  doc.setFillColor(248,250,252); doc.roundedRect(M+86, y, 80, 32, 2, 2, "F");

  // Supplier box
  doc.setFont("helvetica","bold"); doc.setFontSize(7.5); doc.setTextColor(100,116,139);
  doc.text("SUPPLIER", M+4, y+7);
  doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor(15,23,42);
  doc.text(supplier?.name||"-", M+4, y+14);
  doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(71,85,105);
  doc.text(supplier?.email||"-", M+4, y+20);

  // Job box
  doc.setFont("helvetica","bold"); doc.setFontSize(7.5); doc.setTextColor(100,116,139);
  doc.text("JOB DETAILS", M+90, y+7);
  doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor(15,23,42);
  doc.text(`Ref: ${jobRef||"TBC"}`, M+90, y+14);
  doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(71,85,105);
  doc.text(site||"-", M+90, y+20);
  if(contactName) doc.text(`Contact: ${contactName}`, M+90, y+26);

  y += 42;

  // -- Delivery / collection + invoice band --
  if (deliveryText || requiredBy || invoiceEmail) {
    doc.setFont("helvetica","bold"); doc.setFontSize(7.5); doc.setTextColor(100,116,139);
    doc.text("DELIVERY / COLLECTION", M, y);
    doc.setFont("helvetica","normal"); doc.setFontSize(8.5); doc.setTextColor(15,23,42);
    const dlines = doc.splitTextToSize(String(deliveryText||"To be confirmed"), 118);
    doc.text(dlines.slice(0,2), M, y+5);
    if (requiredBy) { doc.setTextColor(100,116,139); doc.setFontSize(8); doc.text(`Required by: ${requiredBy}`, M, y+5+(dlines.length>1?5:5)); }
    if (invoiceEmail) {
      doc.setFont("helvetica","bold"); doc.setFontSize(7.5); doc.setTextColor(100,116,139);
      doc.text("SEND INVOICES TO", W-M-62, y);
      doc.setFont("helvetica","normal"); doc.setFontSize(8.5); doc.setTextColor(15,23,42);
      doc.text(doc.splitTextToSize(String(invoiceEmail),60), W-M-62, y+5);
    }
    y += 18;
  }

  // -- Table header --
  doc.setFillColor(15,23,42);
  doc.rect(M, y, W-M*2, 10, "F");
  doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(148,163,184);
  doc.text("#",    M+3,  y+6.5);
  doc.text("DESCRIPTION", M+12, y+6.5);
  doc.text("QTY",  122,  y+6.5);
  doc.text("UNIT", 136,  y+6.5);
  doc.text("UNIT PRICE", 152, y+6.5);
  doc.text("TOTAL", W-M, y+6.5, {align:"right"});
  y += 10;

  // -- Table rows --
  const rows = analysis?.matched?.length
    ? analysis.matched
    : items.map(i=>{ const p=parseFloat(String(i.unitPrice!=null?i.unitPrice:(i.price!=null?i.price:"")).replace(/[^0-9.]/g,"")); return { item:i.description, requestedQty:i.quantity, requestedUnit:i.unit, quotedPrice: p?`£${p.toFixed(2)}`:"TBC" }; });

  let grandTotal = 0;
  rows.forEach((row,idx) => {
    if (y > 255) { doc.addPage(); y = 20; }
    // Alternating rows
    doc.setFillColor(...(idx%2===0?[255,255,255]:[248,250,252]));
    doc.rect(M, y, W-M*2, 9, "F");
    // Left border accent on even rows
    if(idx%2===0){ doc.setFillColor(59,130,246); doc.rect(M,y,1,9,"F"); }

    const price = parseFloat((row.quotedPrice||"").replace(/[^0-9.]/g,""))||0;
    const qty   = row.requestedQty||0;
    const line  = price&&qty ? `£${(price*qty).toFixed(2)}` : "TBC";
    if (line!=="TBC") grandTotal += price*qty;

    doc.setFont("helvetica","normal"); doc.setFontSize(8.5); doc.setTextColor(71,85,105);
    doc.text(String(idx+1), M+3, y+6);
    doc.setTextColor(15,23,42); doc.setFont("helvetica","normal");
    doc.text(String(row.item||"").slice(0,50), M+12, y+6);
    doc.setTextColor(71,85,105);
    doc.text(String(qty), 122, y+6);
    doc.text(String(row.requestedUnit||""), 136, y+6);
    doc.setFont("helvetica","bold"); doc.setTextColor(15,23,42);
    doc.text(row.quotedPrice||"TBC", 152, y+6);
    doc.setTextColor(59,130,246);
    doc.text(line, W-M, y+6, {align:"right"});
    y += 9;
  });

  // -- Total bar --
  y += 4;
  doc.setFillColor(15,23,42);
  doc.rect(M, y, W-M*2, 12, "F");
  doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(255,255,255);
  doc.text("TOTAL DUE", M+3, y+8);
  doc.setTextColor(59,130,246);
  const _ov = totalOverride!=null ? parseFloat(String(totalOverride).replace(/[^0-9.]/g,"")) : 0;
  const shownTotal = grandTotal ? `£${grandTotal.toFixed(2)}` : (_ov ? `£${_ov.toFixed(2)}` : "TBC");
  doc.text(shownTotal, W-M, y+8, {align:"right"});
  y += 20;

  // -- VAT note --
  doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(100,116,139);
  doc.text("All prices shown exclude VAT unless otherwise stated.", M, y);
  y += 10;

  // -- Footer --
  doc.setDrawColor(226,232,240); doc.setLineWidth(0.3);
  doc.line(M, 275, W-M, 275);
  doc.setFont("helvetica","normal"); doc.setFontSize(7.5); doc.setTextColor(148,163,184);
  doc.text(`${company||"Your Company"}  ·  ${contactEmail||""}  ·  PO ${poNumber}`, M, 280);
  doc.text("Generated by ProQure - AI-powered procurement for trades", W-M, 280, {align:"right"});

  if (output === "base64")  return doc.output("datauristring").split(",")[1];
  if (output === "datauri")  return doc.output("datauristring");
  doc.save(`PO-${poNumber}.pdf`);
}

// ============================================================================
// O&M FILE GENERATOR
// Per project (jobRef), turns the procured materials into a presented O&M pack:
// equipment schedule + manufacturer literature + planned maintenance (PPM).
// ============================================================================

// Web-search-enabled AI call (used to locate manufacturer datasheets online).
// Returns { text, citations:[{url,title}] }. Falls back to a user key if the
// server key isn't configured. Web search is metered, so only used on demand.
async function callAIWeb(system, user, maxResults = 4) {
  if (!aiBudgetOk()) throw new Error(AI_BUDGET_MSG);
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  try {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ messages, web: true, maxResults, temperature: 0, companyId: __companyId }),
    });
    if (res.status === 402) throw new Error(AI_BUDGET_MSG);
    if (res.ok) {
      const d = await res.json();
      if (d.blocked) throw new Error(AI_BUDGET_MSG);
      if (d.text) { reportAiUsage(d.cost, true); return { text: d.text, citations: d.citations || [] }; }
      if (d.error && !d.error.includes("not configured")) throw new Error(d.error);
    }
  } catch (e) { if (e && e.message === AI_BUDGET_MSG) throw e; /* else fall through */ }
  // No web fallback on the user-key path (kept simple): return empty.
  return { text: "", citations: [] };
}

// Collect procured line items for a job, de-duplicated by product name.
function omGatherMaterials(orders, jobRef) {
  const rows = [];
  (orders || []).filter(o => o.jobRef === jobRef && o.status !== "cancelled").forEach(o => {
    (o.items || []).forEach(it => {
      const name = (it.product || it.description || it.rawText || "").trim();
      if (!name) return;
      rows.push({
        product: name,
        qty: it.qty ?? it.requestedQty ?? it.quantity ?? null,
        supplier: o.supplier || "",
        trade: o.trade || it.category || "",
      });
    });
  });
  const map = new Map();
  rows.forEach(m => {
    const k = m.product.toLowerCase();
    if (map.has(k)) { const e = map.get(k); if (m.qty) e.qty = (e.qty || 0) + m.qty; }
    else map.set(k, { ...m });
  });
  return [...map.values()];
}

function omStripFences(t) {
  return (t || "").replace(/```json/gi, "").replace(/```/g, "").trim();
}

// One AI call: classify each material, infer manufacturer/model, group into an
// equipment schedule, draft a literature list and PPM schedules. Defensive — on
// any failure it falls back to a basic structure built from the raw names.
async function omBuildData(materials) {
  const list = materials.slice(0, 80).map((m, i) =>
    `${i + 1}. ${m.product}${m.qty ? ` (qty ${m.qty})` : ""}${m.trade ? ` [${m.trade}]` : ""}`
  ).join("\n");

  const sys = `You are compiling an Operations & Maintenance (O&M) manual for a UK building services contractor, from a list of materials that were procured for one project. For EACH item, infer the likely manufacturer and model/range where you reasonably can (leave blank if unknown — never invent a precise model number you are unsure of). Group the genuine equipment/plant items into sensible building-services systems (e.g. Electrical Distribution, Lighting, Fire & Security, Ventilation & AC, Water Services, Drainage, etc.), carrying a qty/rating where given. Put pure consumables (cable, fixings, sealant, fittings, sundries, ducting offcuts) into a SEPARATE "consumables" list so the equipment schedule reads as an equipment register rather than a shopping list — never silently drop an item. Also draft a Planned Preventative Maintenance (PPM) schedule for the equipment types present, split into Electrical and Mechanical, using realistic UK frequencies (Monthly/Quarterly/6 Monthly/Annually). For each task give the governing standard/reference where one applies (e.g. BS 7671, BS 5266, BS 5839, F-Gas, BS 8558) in a "ref" field, otherwise leave "ref" blank.
Return ONLY valid JSON, no markdown, in exactly this shape:
{"equipment":[{"category":"...","items":[{"item":"...","manufacturer":"...","model":"...","rating":"..."}]}],
 "consumables":[{"item":"...","qty":"..."}],
 "literature":[{"item":"...","manufacturer":"...","model":"...","query":"manufacturer model datasheet pdf"}],
 "ppm":{"electrical":[{"title":"...","rows":[{"freq":"Monthly","activity":"...","ref":"BS 7671"}]}],
        "mechanical":[{"title":"...","rows":[{"freq":"Quarterly","activity":"...","ref":""}]}]}}
Keep "literature" to the distinct equipment products only (not consumables). Every PPM activity must be a real maintenance task. All schedules are drafts for the contractor to sign off.`;

  let data = null;
  try {
    const txt = await callAI(sys, `Materials procured for this project:\n${list}`, [], 0.1);
    data = JSON.parse(omStripFences(txt));
  } catch (e) { data = null; }

  if (!data || !data.equipment) {
    // Fallback: list everything under one heading, no PPM beyond a generic note.
    data = {
      equipment: [{
        category: "Procured materials",
        items: materials.map(m => ({ item: m.product, manufacturer: "", model: "", rating: m.qty ? `qty ${m.qty}` : "" })),
      }],
      consumables: [],
      literature: materials.slice(0, 40).map(m => ({ item: m.product, manufacturer: "", model: "", query: `${m.product} datasheet pdf` })),
      ppm: { electrical: [], mechanical: [] },
      _fallback: true,
    };
  }
  data.equipment = data.equipment || [];
  data.consumables = data.consumables || [];
  data.literature = data.literature || [];
  data.ppm = data.ppm || { electrical: [], mechanical: [] };
  data.ppm.electrical = data.ppm.electrical || [];
  data.ppm.mechanical = data.ppm.mechanical || [];
  return data;
}

// For each literature item, find a direct manufacturer datasheet URL via web
// search. Mutates each item to add .url (and .source). Batched + capped to keep
// cost/latency sane. Silently leaves .url empty on failure.
async function omFindDatasheets(literature, onProgress) {
  const items = (literature || []).slice(0, 24);
  const batchSize = 4;
  let done = 0;
  const sys = `You find the official manufacturer datasheet or product-literature page for a UK building-services product. Reply with ONLY the single best direct URL — strongly prefer the manufacturer's own website and a PDF datasheet. Do NOT return a search-engine results page. If you genuinely cannot find a credible source, reply exactly NONE. No other words.`;
  const BAD_HOST = /(^|\.)(google|bing|duckduckgo|yahoo)\./i;
  const valid = (u) => { try { return /^https?:\/\//.test(u) && !BAD_HOST.test(new URL(u).hostname); } catch { return false; } };
  // Choose the best URL from the model's text + the web plugin's citations,
  // preferring one hosted on the manufacturer's own domain.
  const pickUrl = (text, citations, manufacturer) => {
    const t = (text || "").trim();
    if (/^NONE$/i.test(t)) return "";
    let url = (t.match(/https?:\/\/[^\s)>"']+/) || [""])[0];
    if (!valid(url)) url = "";
    const cites = (citations || []).map(c => c.url).filter(valid);
    const mk = (manufacturer || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (mk.length >= 4) {
      const onBrand = [url, ...cites].filter(Boolean).find(u => {
        try { return new URL(u).hostname.toLowerCase().replace(/[^a-z0-9]/g, "").includes(mk.slice(0, 6)); } catch { return false; }
      });
      if (onBrand) return onBrand;
    }
    return url || cites[0] || "";
  };
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(async (lit) => {
      const q1 = lit.query || `${lit.manufacturer || ""} ${lit.model || lit.item} datasheet pdf`.trim();
      try {
        let { text, citations } = await callAIWeb(sys, `Find the datasheet for: ${q1}`, 4);
        let url = pickUrl(text, citations, lit.manufacturer);
        if (!url) {
          // One broadened retry before giving up (only runs on a miss).
          const q2 = `${lit.manufacturer || ""} ${lit.model || lit.item} official product datasheet`.trim();
          ({ text, citations } = await callAIWeb(sys, `Find the datasheet for: ${q2}`, 4));
          url = pickUrl(text, citations, lit.manufacturer);
        }
        if (url) {
          lit.url = url;
          try { lit.source = new URL(url).hostname.replace(/^www\./, ""); } catch { lit.source = ""; }
        }
      } catch (e) { /* leave blank */ }
      done++; if (onProgress) onProgress(done, items.length);
    }));
  }
  return literature;
}

// ---- jsPDF document builder -------------------------------------------------
const OM_C = {
  green: [21, 130, 79], greenD: [15, 94, 57], dark: [16, 16, 19],
  ink: [35, 35, 31], mute: [107, 107, 99], faint: [144, 143, 134],
  line: [231, 230, 224], wash: [246, 246, 243], greenW: [234, 243, 238],
  amber: [138, 90, 18], amberW: [251, 241, 224], white: [255, 255, 255],
};

async function omLoadJsPDF() {
  if (!window.jspdf) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }
  return window.jspdf.jsPDF;
}

function omFooter(doc, project, hasCover = true) {
  const W = 210, H = 297, M = 16;
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    if (p === 1 && hasCover) continue; // skip cover
    doc.setDrawColor(...OM_C.line); doc.setLineWidth(0.3); doc.line(M, H - 14, W - M, H - 14);
    doc.setFont("courier", "normal"); doc.setFontSize(7); doc.setTextColor(...OM_C.faint);
    doc.text("PROQURE", M, H - 9);
    doc.setFont("helvetica", "normal"); doc.setTextColor(...OM_C.mute);
    doc.text(`O&M Manual · ${project.name || project.jobRef} · v1.0`, W / 2, H - 9, { align: "center" });
    doc.text(`Page ${p}`, W - M, H - 9, { align: "right" });
  }
}

// cursor helper: ensures there's room, else new page. ctx = {doc, y}
function omEnsure(ctx, need) {
  if (ctx.y + need > 297 - 20) { ctx.doc.addPage(); ctx.y = 22; }
}

function omSectionTitle(ctx, num, title, sub) {
  const { doc } = ctx; const M = 16, W = 210;
  omEnsure(ctx, 26);
  doc.setFont("courier", "normal"); doc.setFontSize(9); doc.setTextColor(...OM_C.green);
  doc.text(num, M, ctx.y);
  doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(...OM_C.dark);
  doc.text(title, M + 12, ctx.y);
  ctx.y += 4;
  doc.setDrawColor(...OM_C.green); doc.setLineWidth(1.1); doc.line(M, ctx.y, W - M, ctx.y);
  doc.setDrawColor(...OM_C.line); doc.setLineWidth(0.3); doc.line(M, ctx.y + 1.6, W - M, ctx.y + 1.6);
  ctx.y += 6;
  if (sub) {
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...OM_C.mute);
    doc.text(sub, M, ctx.y); ctx.y += 5;
  }
  ctx.y += 2;
}

function omPill(ctx, text, fg, bg) {
  const { doc } = ctx; const M = 16;
  doc.setFont("courier", "normal"); doc.setFontSize(7.2);
  const w = doc.getTextWidth(text) + 7;
  doc.setFillColor(...bg); doc.roundedRect(M, ctx.y - 4, w, 6, 3, 3, "F");
  doc.setTextColor(...fg); doc.text(text, M + 3.5, ctx.y);
  ctx.y += 7;
}

// Draw a table. cols: [{header, width, mono?, align?}], rows: array of arrays.
function omTable(ctx, cols, rows, headColor) {
  const { doc } = ctx; const M = 16; const lh = 4.2;
  const head = headColor || OM_C.green;
  const drawHeader = () => {
    omEnsure(ctx, 12);
    doc.setFillColor(...head); doc.rect(M, ctx.y - 4.5, cols.reduce((a, c) => a + c.width, 0), 7, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7.4); doc.setTextColor(...OM_C.white);
    let x = M;
    cols.forEach(c => { doc.text(c.header, x + 2, ctx.y); x += c.width; });
    ctx.y += 5;
  };
  drawHeader();
  rows.forEach((r, ri) => {
    // measure wrapped height
    const cells = cols.map((c, ci) => {
      doc.setFont(c.mono ? "courier" : "helvetica", "normal"); doc.setFontSize(c.mono ? 7 : 7.8);
      return doc.splitTextToSize(String(r[ci] == null ? "" : r[ci]), c.width - 4);
    });
    const lines = Math.max(...cells.map(c => c.length), 1);
    const rowH = lines * lh + 2.5;
    if (ctx.y + rowH > 297 - 20) { ctx.doc.addPage(); ctx.y = 22; drawHeader(); }
    if (ri % 2 === 1) { doc.setFillColor(...OM_C.wash); doc.rect(M, ctx.y - 4.2, cols.reduce((a, c) => a + c.width, 0), rowH, "F"); }
    let x = M;
    cols.forEach((c, ci) => {
      doc.setFont(c.mono ? "courier" : "helvetica", "normal"); doc.setFontSize(c.mono ? 7 : 7.8);
      doc.setTextColor(...(c.color || OM_C.ink));
      const tx = c.align === "right" ? x + c.width - 2 : x + 2;
      doc.text(cells[ci], tx, ctx.y, { align: c.align === "right" ? "right" : "left" });
      x += c.width;
    });
    doc.setDrawColor(...OM_C.line); doc.setLineWidth(0.2);
    doc.line(M, ctx.y + rowH - 4.2, M + cols.reduce((a, c) => a + c.width, 0), ctx.y + rowH - 4.2);
    ctx.y += rowH;
  });
  ctx.y += 5;
}

// Render the cover onto the current (first) page.
function omCover(doc, project, settings) {
  const W = 210, M = 16;
  doc.setFillColor(...OM_C.dark); doc.rect(0, 0, W, 118, "F");
  doc.setFillColor(...OM_C.green); doc.rect(0, 116, W, 2, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(20); doc.setTextColor(...OM_C.white);
  doc.text(settings.company || "ProQure", M, 26);
  doc.setFont("courier", "normal"); doc.setFontSize(8); doc.setTextColor(159, 183, 171);
  doc.text("OPERATIONS & MAINTENANCE MANUAL", M, 54);
  doc.setFont("helvetica", "bold"); doc.setFontSize(26); doc.setTextColor(...OM_C.white);
  doc.text(doc.splitTextToSize(project.name || project.jobRef, W - 2 * M), M, 68);
  doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(199, 199, 194);
  if (project.site) doc.text(doc.splitTextToSize(project.site, W - 2 * M), M, 80);
  doc.setFontSize(10); doc.setTextColor(154, 154, 147);
  doc.text(settings.company || "", M, 96);
  // meta cards
  const y = 132, cw = (W - 2 * M - 3 * 4) / 4;
  const cards = [["JOB REF", project.jobRef || "-"], ["REVISION", "v1.0"],
  ["DATE", project.date], ["ITEMS", String(project.items || "-")]];
  cards.forEach(([k, v], i) => {
    const x = M + i * (cw + 4);
    doc.setFillColor(...OM_C.wash); doc.roundedRect(x, y, cw, 20, 2, 2, "F");
    doc.setFillColor(...OM_C.green); doc.rect(x, y, 1.5, 20, "F");
    doc.setFont("courier", "normal"); doc.setFontSize(6.4); doc.setTextColor(...OM_C.faint);
    doc.text(k, x + 4, y + 7);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(...OM_C.dark);
    doc.text(doc.splitTextToSize(v, cw - 6), x + 4, y + 14);
  });
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...OM_C.mute);
  doc.text("Compiled automatically by ProQure from the project procurement record.", M, 270);
  doc.setFont("courier", "normal"); doc.setFontSize(7); doc.setTextColor(...OM_C.faint);
  doc.text(`GENERATED ${(project.date || "").toUpperCase()}`, M, 277);
}

// Body sections, each draws into ctx starting at ctx.y.
function omRenderEquipment(ctx, data) {
  omSectionTitle(ctx, "01", "Equipment schedule", "Items procured for this project, grouped by system.");
  data.equipment.forEach(group => {
    omEnsure(ctx, 14);
    ctx.doc.setFont("helvetica", "bold"); ctx.doc.setFontSize(9.5); ctx.doc.setTextColor(...OM_C.greenD);
    ctx.doc.text(group.category || "Other", 16, ctx.y); ctx.y += 5.5;
    const rows = (group.items || []).map(it => [it.item || "", it.manufacturer || "", it.model || "", it.rating || ""]);
    omTable(ctx, [
      { header: "Item", width: 78 }, { header: "Manufacturer", width: 38 },
      { header: "Model", width: 38, mono: true }, { header: "Rating / Qty", width: 24, color: OM_C.mute },
    ], rows);
  });
  // Spares & consumables: kept separate from the equipment register so the schedule
  // reads cleanly, but listed for completeness (so nothing procured is unaccounted for).
  if ((data.consumables || []).length) {
    omEnsure(ctx, 16);
    ctx.doc.setFont("helvetica", "bold"); ctx.doc.setFontSize(9.5); ctx.doc.setTextColor(...OM_C.greenD);
    ctx.doc.text("Spares & consumables", 16, ctx.y); ctx.y += 3;
    ctx.doc.setFont("helvetica", "normal"); ctx.doc.setFontSize(7.6); ctx.doc.setTextColor(...OM_C.mute);
    ctx.doc.text("Sundry materials procured for the works (not maintainable plant).", 16, ctx.y); ctx.y += 5;
    const crows = (data.consumables || []).map(c => [c.item || "", c.qty != null && c.qty !== "" ? String(c.qty) : ""]);
    omTable(ctx, [{ header: "Item", width: 154 }, { header: "Qty", width: 24, color: OM_C.mute, align: "right" }], crows);
  }
}

function omRenderLiterature(ctx, data, web) {
  omSectionTitle(ctx, "02", "Operating manuals & literature", "Manufacturer datasheets and product literature for each item.");
  omPill(ctx, web ? "AUTO-SOURCED FROM MANUFACTURER" : "MANUFACTURER & MODEL — LINKS ON REQUEST", OM_C.greenD, OM_C.greenW);
  ctx.doc.setFont("helvetica", "normal"); ctx.doc.setFontSize(8); ctx.doc.setTextColor(...OM_C.mute);
  const note = web
    ? "Each link resolves to the manufacturer datasheet located online for the model installed."
    : "Turn on 'find datasheet links online' when generating to attach direct manufacturer links.";
  ctx.doc.text(ctx.doc.splitTextToSize(note, 178), 16, ctx.y); ctx.y += 6;
  const { doc } = ctx; const M = 16; const lh = 4.2;
  const cols = [{ header: "Item", width: 56 }, { header: "Manufacturer", width: 40 },
  { header: "Model", width: 36, mono: true }, { header: "Literature", width: 46 }];
  // custom table to support links in the last column
  const drawHead = () => {
    omEnsure(ctx, 12);
    doc.setFillColor(...OM_C.green); doc.rect(M, ctx.y - 4.5, 178, 7, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7.4); doc.setTextColor(...OM_C.white);
    let x = M; cols.forEach(c => { doc.text(c.header, x + 2, ctx.y); x += c.width; }); ctx.y += 5;
  };
  drawHead();
  (data.literature || []).forEach((lit, ri) => {
    const itemLines = doc.splitTextToSize(lit.item || "", cols[0].width - 4);
    const rowH = Math.max(itemLines.length, 1) * lh + 2.5;
    if (ctx.y + rowH > 297 - 20) { doc.addPage(); ctx.y = 22; drawHead(); }
    if (ri % 2 === 1) { doc.setFillColor(...OM_C.wash); doc.rect(M, ctx.y - 4.2, 178, rowH, "F"); }
    let x = M;
    doc.setFont("helvetica", "bold"); doc.setFontSize(7.8); doc.setTextColor(...OM_C.ink);
    doc.text(itemLines, x + 2, ctx.y); x += cols[0].width;
    doc.setFont("helvetica", "normal"); doc.text(doc.splitTextToSize(lit.manufacturer || "—", cols[1].width - 4), x + 2, ctx.y); x += cols[1].width;
    doc.setFont("courier", "normal"); doc.setFontSize(7); doc.text(lit.model || "—", x + 2, ctx.y); x += cols[2].width;
    doc.setFont("helvetica", "bold"); doc.setFontSize(7.6); doc.setTextColor(...OM_C.green);
    if (lit.url) { doc.textWithLink("View datasheet \u203A", x + 2, ctx.y, { url: lit.url }); }
    else {
      const q = encodeURIComponent(lit.query || `${lit.manufacturer || ""} ${lit.model || lit.item} datasheet`);
      doc.textWithLink("Search \u203A", x + 2, ctx.y, { url: `https://www.google.com/search?q=${q}` });
    }
    doc.setDrawColor(...OM_C.line); doc.setLineWidth(0.2); doc.line(M, ctx.y + rowH - 4.2, M + 178, ctx.y + rowH - 4.2);
    ctx.y += rowH;
  });
  ctx.y += 5;
}

function omRenderPPM(ctx, data) {
  omSectionTitle(ctx, "03", "Maintenance schedules (PPM)", "Planned preventative maintenance for the installed equipment.");
  omPill(ctx, "AI-DRAFTED \u2014 FOR YOUR SIGN-OFF", OM_C.amber, OM_C.amberW);
  ctx.y += 1;
  [["ELECTRICAL", data.ppm.electrical], ["MECHANICAL", data.ppm.mechanical]].forEach(([label, groups]) => {
    if (!groups || !groups.length) return;
    omEnsure(ctx, 12);
    ctx.doc.setFont("courier", "normal"); ctx.doc.setFontSize(8); ctx.doc.setTextColor(...OM_C.green);
    ctx.doc.text(label, 16, ctx.y); ctx.y += 2;
    ctx.doc.setDrawColor(...OM_C.line); ctx.doc.setLineWidth(0.3); ctx.doc.line(16, ctx.y, 194, ctx.y); ctx.y += 5;
    groups.forEach(g => {
      omEnsure(ctx, 14);
      ctx.doc.setFont("helvetica", "bold"); ctx.doc.setFontSize(9.5); ctx.doc.setTextColor(...OM_C.dark);
      ctx.doc.text(g.title || "Equipment", 16, ctx.y); ctx.y += 5.5;
      const rows = (g.rows || []).map(r => [r.freq || "", r.activity || "", r.ref || ""]);
      omTable(ctx, [
        { header: "Frequency", width: 28, color: OM_C.greenD },
        { header: "Maintenance activity", width: 122 },
        { header: "Reference", width: 28, mono: true, color: OM_C.mute },
      ], rows);
    });
    ctx.y += 2;
  });
}

function omContents(ctx, project, settings) {
  omSectionTitle(ctx, "00", "Contents & document control");
  const { doc } = ctx; const M = 16;
  const toc = [["1", "Equipment schedule"], ["2", "Operating manuals & literature"], ["3", "Maintenance schedules (PPM)"]];
  toc.forEach(([n, t]) => {
    doc.setFont("courier", "normal"); doc.setFontSize(8); doc.setTextColor(...OM_C.mute); doc.text(n, M, ctx.y);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...OM_C.ink); doc.text(t, M + 12, ctx.y);
    doc.setDrawColor(...OM_C.line); doc.setLineWidth(0.2); doc.line(M, ctx.y + 2, 194, ctx.y + 2); ctx.y += 8;
  });
  ctx.y += 4;
  doc.setFont("courier", "normal"); doc.setFontSize(7.5); doc.setTextColor(...OM_C.faint); doc.text("VERSION HISTORY", M, ctx.y); ctx.y += 4;
  omTable(ctx, [{ header: "Version", width: 24 }, { header: "Date", width: 34 }, { header: "Prepared by", width: 60 }, { header: "Reason", width: 60 }],
    [["1.0", project.date, (settings.company || "ProQure") + " (auto)", "First issue"]]);
}

// Build the full pack. opts:{split,web}. Downloads the PDF(s).
async function omGeneratePdf(data, project, settings, opts = {}) {
  const jsPDF = await omLoadJsPDF();
  const fname = (project.jobRef || "project").replace(/[^a-z0-9\-]+/gi, "-");

  const buildCombined = () => {
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    omCover(doc, project, settings);
    doc.addPage(); const ctx = { doc, y: 22 };
    omContents(ctx, project, settings);
    doc.addPage(); ctx.y = 22; omRenderEquipment(ctx, data);
    doc.addPage(); ctx.y = 22; omRenderLiterature(ctx, data, opts.web);
    doc.addPage(); ctx.y = 22; omRenderPPM(ctx, data);
    omFooter(doc, project);
    return doc;
  };
  buildCombined().save(`OM-${fname}.pdf`);

  if (opts.split) {
    // Literature only
    const litDoc = new jsPDF({ unit: "mm", format: "a4" });
    const lc = { doc: litDoc, y: 22 }; omRenderLiterature(lc, data, opts.web); omFooter(litDoc, project, false);
    litDoc.save(`OM-${fname}-Literature.pdf`);
    // Maintenance only
    const ppmDoc = new jsPDF({ unit: "mm", format: "a4" });
    const pc = { doc: ppmDoc, y: 22 }; omRenderPPM(pc, data); omFooter(ppmDoc, project, false);
    ppmDoc.save(`OM-${fname}-Maintenance.pdf`);
  }
}


// ============================================================================
// REPORTING + MEASURING TOOL helpers
// ============================================================================

// Best-effort monetary total for an order (POs store prices as strings).
function orderTotal(o) {
  let sum = 0, found = false;
  (o.items || []).forEach(it => {
    let lt = parsePrice(it.lineTotal);
    if (lt == null) {
      const up = parsePrice(it.unitPrice);
      const q = Number(it.qty ?? it.quantity ?? it.requestedQty);
      if (up != null && q) lt = up * q;
    }
    if (lt != null) { sum += lt; found = true; }
  });
  if (!found) { const e = parsePrice(o.estimatedTotal ?? o.total); if (e != null) return e; }
  return sum;
}

// Robust order date (POs may store en-GB "DD/MM/YYYY", or ISO, or none).
function orderDate(o) {
  const s = o.poDate;
  if (s && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split("/").map(Number); return new Date(y, m - 1, d);
  }
  let t = s ? Date.parse(s) : NaN;
  if (isNaN(t) && o.activity && o.activity[0] && o.activity[0].ts) t = Date.parse(o.activity[0].ts);
  return isNaN(t) ? null : new Date(t);
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Aggregate live orders into spend breakdowns by trade / supplier / job / month.
function repBuild(orders) {
  const live = (orders || []).filter(o => o.status !== "cancelled");
  const groupBy = (keyFn) => {
    const m = new Map();
    live.forEach(o => {
      const k = (keyFn(o) || "").toString().trim() || "Unspecified";
      const e = m.get(k) || { label: k, value: 0, count: 0 };
      e.value += orderTotal(o); e.count++; m.set(k, e);
    });
    return [...m.values()].sort((a, b) => b.value - a.value);
  };
  const byTrade = groupBy(o => o.trade);
  const bySupplier = groupBy(o => o.supplier);
  const byJob = groupBy(o => o.jobRef);
  const mm = new Map();
  live.forEach(o => {
    const d = orderDate(o);
    const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` : "9999-99";
    const label = d ? `${MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` : "Undated";
    const e = mm.get(key) || { key, label, value: 0, count: 0 };
    e.value += orderTotal(o); e.count++; mm.set(key, e);
  });
  const byMonth = [...mm.values()].sort((a, b) => a.key < b.key ? -1 : 1);
  const total = live.reduce((s, o) => s + orderTotal(o), 0);
  return { byTrade, bySupplier, byJob, byMonth, total, count: live.length, projects: byJob.length, suppliers: bySupplier.length };
}

// Per-project cross-trade breakdown (the buyer/manager "boss view").
function repProject(orders, jobRef) {
  const live = (orders || []).filter(o => o.status !== "cancelled" && (((o.jobRef || "").toString().trim()) || "Unspecified") === jobRef);
  const byTrade = {}, bySupplier = {};
  let total = 0, site = "";
  live.forEach(o => {
    const t = orderTotal(o); total += t;
    const tr = (o.trade || "Unspecified").trim() || "Unspecified";
    byTrade[tr] = (byTrade[tr] || 0) + t;
    const sup = o.supplier || "Unknown";
    bySupplier[sup] = (bySupplier[sup] || 0) + t;
    if (!site && o.site) site = o.site;
  });
  const toArr = (obj) => Object.entries(obj).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  return { jobRef, site, total, orders: live.length, byTrade: toArr(byTrade), bySupplier: toArr(bySupplier) };
}

function gbp(n) {
  return "£" + (Math.round(n || 0)).toLocaleString("en-GB");
}

// ---- Measuring tool (manual-input phase) ------------------------------------
// Cross-references the material against coverage rates to give a quantity to
// order. When a specific product/brand is given and useDatasheet is on, it first
// web-searches the manufacturer's datasheet for the actual coverage rate, then
// bases the quantity on that rather than a generic rate.
async function measureCompute(material, inputs, opts = {}) {
  const product = (opts.product || "").trim();
  let datasheetNote = "";
  let source = null;
  if (opts.useDatasheet && product) {
    try {
      const dsSys = `You are a UK building-materials researcher. Find the manufacturer's published coverage/spread rate for the named product from its datasheet or official product page. Reply with ONE short line stating the coverage rate and units (e.g. "Dulux Trade Vinyl Matt: 16 m2/L per coat"). If you cannot find it, reply exactly "NONE".`;
      const { text, citations } = await callAIWeb(dsSys, `Product: ${product}\nMaterial type: ${material}\nFind the datasheet coverage rate.`, 4);
      if (text && !/^\s*none\s*$/i.test(text)) {
        datasheetNote = text.trim();
        if (citations && citations.length) source = citations[0].url || null;
      }
    } catch (e) { /* fall back to generic rates */ }
  }
  const sys = `You are a UK building-materials estimator. Given a material and measurements, work out the quantity to order, applying the stated wastage allowance. ${datasheetNote ? "Use this manufacturer coverage rate if relevant: " + datasheetNote + ". " : "Use standard UK coverage/spec rates. "}State the coverage rate you used. Return ONLY valid JSON, no markdown:
{"quantity":number,"unit":"e.g. litres / m2 / bricks / bags","packsNeeded":number or null,"packSize":"e.g. 10L tub / pack of 50 / 25kg bag or null","coverageBasis":"the rate you assumed, e.g. 12 m2/L per coat","assumptions":["..."],"notes":"one short line"}
Be realistic and conservative. Round packsNeeded up to whole packs. Never omit the JSON.`;
  const u = `Material: ${product ? product + " (" + material + ")" : material}\nInputs: ${JSON.stringify(inputs)}`;
  try {
    const txt = await callAI(sys, u, [], 0);
    const data = JSON.parse(omStripFences(txt));
    if (typeof data.quantity !== "number") throw new Error("bad");
    if (datasheetNote) data.datasheet = datasheetNote;
    if (source) data.source = source;
    return data;
  } catch (e) {
    return { error: "Couldn't calculate that one — try rephrasing the material or check the dimensions." };
  }
}

// Lazily load pdf.js (from CDN) so we can rasterise PDF pages to images in the
// browser. Vision models read images, not raw PDF bytes, so for any PDF (drawing
// or scanned document) we render its pages to PNGs and send those instead.
let _pdfjsPromise = null;
function loadPdfJs() {
  if (typeof window !== "undefined" && window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_pdfjsPromise) return _pdfjsPromise;
  _pdfjsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      } catch (e) { reject(e); }
    };
    s.onerror = () => reject(new Error("Could not load the PDF reader."));
    document.head.appendChild(s);
  });
  return _pdfjsPromise;
}

// Render the first `maxPages` pages of a PDF File to PNG data URLs.
async function pdfToImages(file, maxPages = 3) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const n = Math.min(pdf.numPages, maxPages);
  const out = [];
  for (let p = 1; p <= n; p++) {
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const cap = 2000; // keep the longest edge sensible so payloads stay small
    const scale = Math.min(2.2, cap / Math.max(base.width, base.height)) || 1.5;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push(canvas.toDataURL("image/png"));
  }
  return out;
}

// Reads an uploaded drawing (PDF or image) via the central AI and returns a
// materials take-off — the items shown on the drawing. PDFs are rasterised to
// page images first; a true DWG/CAD file can't be read (export it to PDF first).
async function takeoffFromDrawing(file) {
  if (!aiBudgetOk()) return { error: AI_BUDGET_MSG };
  const sys = `You are a quantity surveyor doing a materials take-off from a construction drawing or specification. List the MATERIAL items shown, with quantities where they can reasonably be inferred from counts, schedules, legends or dimensions. Do NOT invent precise quantities you cannot see — use 1 and add a note if unsure. Ignore labour, prices and title-block text. Return ONLY valid JSON, no markdown:
{"items":[{"description":"...","quantity":number,"unit":"e.g. no / m / m2 / each","category":"the trade, e.g. Electrical","notes":"short, e.g. 'counted from legend' or 'scale assumed'"}]}
Always return the JSON, even if the list is short.`;
  try {
    const isImage = (file.type || "").startsWith("image/");
    const isPDF = (file.type || "") === "application/pdf";
    if (!isImage && !isPDF) return { error: "Please upload a PDF or an image of the drawing — a DWG/CAD file can't be read, so export it to PDF first." };
    let imageUrls = [];
    if (isImage) {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file);
      });
      imageUrls = [dataUrl];
    } else {
      imageUrls = await pdfToImages(file, 3);
    }
    if (!imageUrls.length) return { error: "Couldn't read that file — try a clearer PDF or image." };
    const userContent = [
      ...imageUrls.map(url => ({ type: "image_url", image_url: { url } })),
      { type: "text", text: "Do a materials take-off from this drawing." },
    ];
    const r = await fetch("/api/ai", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({
        messages: [{ role: "system", content: sys }, { role: "user", content: userContent }],
        models: ["google/gemini-2.5-flash", "google/gemini-flash-1.5"],
        temperature: 0,
        companyId: __companyId,
      }),
    });
    if (!r.ok) return { error: "The AI couldn't read that drawing — try a clearer PDF or image." };
    const d = await r.json();
    reportAiUsage(d.cost, false);
    const data = JSON.parse(omStripFences(d.text || ""));
    if (!data.items || !Array.isArray(data.items) || !data.items.length) return { error: "No materials could be read from that drawing. Try a clearer copy, or a PDF export." };
    const items = data.items.slice(0, 100).map((it, i) => ({
      id: Date.now() + i,
      description: String(it.description || "").trim() || "Item",
      quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1,
      unit: String(it.unit || "no").trim(),
      category: String(it.category || "General").trim(),
      notes: String(it.notes || "").trim(),
    }));
    return { items };
  } catch (e) {
    return { error: "Couldn't read that drawing — please try a clearer PDF or image." };
  }
}

// Reads an uploaded supplier catalogue (PDF / image / CSV) via the central AI and
// returns a normalised product index — description, part number, manufacturer,
// datasheet link if one is printed. We index the products; we do not re-host the
// file. PDFs are rasterised to page images (first pages only, to bound cost).
async function parseCatalogue(file) {
  if (!aiBudgetOk()) return { error: AI_BUDGET_MSG };
  const sys = `You are reading a SUPPLIER PRODUCT CATALOGUE for UK building / trades materials. Extract the products listed. For each product capture: a clear description, the manufacturer/supplier part or product code if shown, the manufacturer or brand, the pack/unit if shown, and a datasheet or product-page URL ONLY if one is explicitly printed. NEVER invent part numbers or URLs — leave them blank if not shown. Return ONLY valid JSON, no markdown:
{"supplier":"the catalogue's supplier or brand if identifiable, else ''","items":[{"description":"...","partNumber":"...","manufacturer":"...","pack":"...","datasheetUrl":"","notes":""}]}
Always return the JSON, even if the list is short.`;
  try {
    const name = file.name || "catalogue";
    const isImage = (file.type || "").startsWith("image/");
    const isPDF = (file.type || "") === "application/pdf";
    const isCsv = /\.csv$/i.test(name) || (file.type || "").includes("csv") || (file.type || "").startsWith("text/");
    let text = "";
    if (isCsv) {
      const csv = await file.text();
      if (!csv.trim()) return { error: "That file looks empty." };
      text = await callAI(sys, `Catalogue data (CSV / text):\n${csv.slice(0, 60000)}`);
    } else if (isImage || isPDF) {
      let imageUrls = [];
      if (isImage) {
        const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
        imageUrls = [dataUrl];
      } else {
        imageUrls = await pdfToImages(file, 8); // first pages keep cost/latency sensible
      }
      if (!imageUrls.length) return { error: "Couldn't read that file \u2014 try a clearer PDF or image." };
      const userContent = [...imageUrls.map(url => ({ type: "image_url", image_url: { url } })), { type: "text", text: "Extract the products from this catalogue." }];
      const r = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ messages: [{ role: "system", content: sys }, { role: "user", content: userContent }], models: ["google/gemini-2.5-flash", "google/gemini-flash-1.5"], temperature: 0, companyId: __companyId }) });
      if (r.status === 402) return { error: AI_BUDGET_MSG };
      if (!r.ok) return { error: "The AI couldn't read that catalogue \u2014 try a clearer PDF or image." };
      const j = await r.json(); reportAiUsage(j.cost, false); text = j.text || "";
    } else {
      return { error: "Please upload a PDF, image, or CSV catalogue." };
    }
    const data = JSON.parse(omStripFences(text || ""));
    const items = (data.items || []).slice(0, 500).map((it, i) => ({
      id: Date.now() + i,
      description: String(it.description || "").trim() || "Item",
      partNumber: String(it.partNumber || it.part || "").trim(),
      manufacturer: String(it.manufacturer || "").trim(),
      pack: String(it.pack || "").trim(),
      datasheetUrl: /^https?:\/\//i.test(it.datasheetUrl || "") ? String(it.datasheetUrl).trim() : "",
      notes: String(it.notes || "").trim(),
    }));
    if (!items.length) return { error: "No products could be read from that catalogue. Try a clearer copy or a CSV." };
    return { supplier: String(data.supplier || "").trim(), items };
  } catch (e) {
    return { error: "Couldn't read that catalogue \u2014 please try a clearer PDF, image, or CSV." };
  }
}

// Phase 2: on-demand, metered web lookup for a specific product/datasheet not in
// the user's own library. Links to the manufacturer's page (we don't re-host).
async function catalogueFindOnline(query) {
  const sys = `You find a specific UK building / trades product and its OFFICIAL manufacturer datasheet or product page on the web. Strongly prefer the manufacturer's own website and a PDF datasheet; never return a search-engine results page. Return ONLY valid JSON, no markdown:
{"results":[{"description":"...","partNumber":"...","manufacturer":"...","datasheetUrl":"official URL, '' if none found","notes":"one short line"}]}
Return up to 4 of the best matches. If you genuinely find nothing credible, return {"results":[]}.`;
  try {
    const { text } = await callAIWeb(sys, `Find this product and its datasheet: ${query}`, 4);
    const data = JSON.parse(omStripFences(text || ""));
    const results = (data.results || []).slice(0, 4).map((it, i) => ({
      id: Date.now() + i,
      description: String(it.description || query).trim(),
      partNumber: String(it.partNumber || "").trim(),
      manufacturer: String(it.manufacturer || "").trim(),
      datasheetUrl: /^https?:\/\//i.test(it.datasheetUrl || "") ? String(it.datasheetUrl).trim() : "",
      notes: String(it.notes || "").trim(),
    }));
    return { results };
  } catch (e) {
    return { error: "Couldn't search online right now \u2014 please try again." };
  }
}

// --- Tiny shared components ---------------------------------------------------
const Btn = ({ onClick, disabled, color="#15824F", outline=false, children }) => (
  <button onClick={onClick} disabled={disabled} style={{
    background: outline?"transparent": disabled?"var(--bg-subtle2)":color,
    color: outline?"var(--text-secondary)": disabled?"var(--text-muted)":"white",
    border: outline?"1px solid var(--border-solid)":"none",
    borderRadius:"var(--radius-sm)", padding:"10px 18px", fontSize:13, fontWeight:600,
    cursor: disabled?"not-allowed":"pointer", letterSpacing:"-0.01em",
    display:"inline-flex", alignItems:"center", justifyContent:"center", gap:7,
    boxShadow: (outline||disabled)?"none":"0 1px 2px rgba(26,26,23,0.08)",
    opacity: disabled?0.7:1
  }}
  onMouseEnter={e=>{if(!disabled){e.currentTarget.style.filter="brightness(1.06)";e.currentTarget.style.transform="translateY(-1px)";}}}
  onMouseLeave={e=>{e.currentTarget.style.filter="none";e.currentTarget.style.transform="translateY(0)";}}
  >{children}</button>
)
const Badge = ({ children, bg, text }) => (
  <span style={{ background:bg, color:text, fontSize:11, fontWeight:600, padding:"3px 11px", borderRadius:20, whiteSpace:"nowrap", letterSpacing:"0.01em" }}>{children}</span>
);
const Card = ({ children, style={}, hover=false }) => (
  <div className={hover?"card-hover":""} style={{ background:"var(--bg-card-solid)", border:"1px solid var(--border)", borderRadius:"var(--radius-lg)", padding:"24px 28px", boxShadow:"var(--shadow-sm)", position:"relative", overflow:"hidden", ...style }}>{children}</div>
);
const Spinner = () => (
  <span style={{ width:14, height:14, border:"2px solid white", borderTopColor:"transparent", borderRadius:"50%", display:"inline-block", animation:"spin 0.7s linear infinite" }}/>
);

// Gently counts a number up from 0 on mount (respects reduced-motion)
const CountUp = ({ value, duration=650 }) => {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const target = Number(value) || 0;
    if (target === 0) { setDisplay(0); return; }
    const reduce = typeof window!=="undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setDisplay(target); return; }
    let raf, start;
    const tick = (t) => {
      if (!start) start = t;
      const p = Math.min((t - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(eased * target));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{display}</>;
};

// --- Icon system: clean line icons (replaces emojis) -------------------------
const ICON_PATHS = {
  bar_chart: '<path d="M3 3v18h18"/><path d="M7 16V9M12 16V5M17 16v-7"/>',
  ruler: '<path d="M3 7l4-4 14 14-4 4z"/><path d="M7 7l2 2M11 11l2 2M15 15l2 2"/>',
  clipboard: '<path d="M9 2h6a1 1 0 011 1v1h1a2 2 0 012 2v13a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2h1V3a1 1 0 011-1z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a1 1 0 01-1 1H3a1 1 0 01-1-1v-6z"/>',
  check_circle: '<circle cx="12" cy="12" r="9"/><polyline points="8.5 12 11 14.5 16 9"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0M12 17v4"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>',
  package: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3.3 7L12 12l8.7-5M12 12v10"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1"/><line x1="9" y1="7" x2="9" y2="7.01"/><line x1="15" y1="7" x2="15" y2="7.01"/><line x1="9" y1="11" x2="9" y2="11.01"/><line x1="15" y1="11" x2="15" y2="11.01"/><line x1="9" y1="15" x2="15" y2="15"/>',
  paperclip: '<path d="M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8"/>',
  send: '<line x1="21" y1="3" x2="10" y2="14"/><polygon points="21 3 14 21 10 14 3 10 21 3"/>',
  flag: '<path d="M5 21V4a1 1 0 011-1h12l-2.5 4L18 11H6"/>',
  trash: '<polyline points="3 6 21 6"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M6 6l1 14a1 1 0 001 1h8a1 1 0 001-1l1-14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  undo: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 109-9 9 9 0 00-6.4 2.6L3 13"/>',
  rocket: '<path d="M5 13c-2 1-3 5-3 5s4-1 5-3M9 11a8 8 0 015-7 8 8 0 012 8 12 12 0 01-4 4l-4 1-2-2z"/><circle cx="14.5" cy="9.5" r="1.5"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  arrow_right: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  plane: '<path d="M17.8 19.2L16 11l3.5-3.5a2.1 2.1 0 00-3-3L13 8 4.8 6.2a.5.5 0 00-.5.8L8 11l-3 3H3l1.5 2.5L7 18l1-1 3-3 3.5 3.7a.5.5 0 00.8-.5z"/>',
  wave: '<path d="M18 11V6a2 2 0 00-4 0M14 10V4a2 2 0 00-4 0v2M10 10.5V6a2 2 0 00-4 0v8a8 8 0 008 8h2a8 8 0 008-8 2 2 0 00-4 0"/>',
  books: '<path d="M4 19V5a1 1 0 011-1h3a1 1 0 011 1v14M9 19V7a1 1 0 011-1h3a1 1 0 011 1v12"/><path d="M14 19l2.5-13 4 1L18 19"/><line x1="3" y1="20" x2="21" y2="20"/>',
  help_circle: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 0c0 1.5-2.5 2-2.5 3.5"/><line x1="12" y1="17" x2="12" y2="17.01"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 01-4 0v-.1A1.6 1.6 0 007.3 19l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.1-2.7H3a2 2 0 010-4h.1A1.6 1.6 0 004.8 7.3l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9.4a1.6 1.6 0 001-1.5V3a2 2 0 014 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9.4a1.6 1.6 0 001.5 1H21a2 2 0 010 4h-.1a1.6 1.6 0 00-1.5 1z"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  truck: '<path d="M1 3h13v10H1z"/><path d="M14 6h4l3 3v4h-7z"/><circle cx="6" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  store: '<path d="M3 9l1.5-5h15L21 9M4 9v10a1 1 0 001 1h14a1 1 0 001-1V9M3 9h18"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 4"/><line x1="12" y1="17" x2="12" y2="17.01"/>',
  file_check: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 15 11 17 15 13"/>',
};
const Icon = ({ name, size=16, color="currentColor", strokeWidth=2, style={} }) => {
  const path = ICON_PATHS[name];
  if (!path) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={style} dangerouslySetInnerHTML={{__html:path}}/>
  );
};

// --- App ----------------------------------------------------------------------
// Lightweight, on-brand markdown for assistant chat replies (bold, inline code,
// bullet + numbered lists, simple headings). Avoids shipping a markdown library.
const RichInline = ({ text }) => {
  const out = []; const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={k++} style={{fontWeight:700,color:"var(--green)"}}>{tok.slice(2,-2)}</strong>);
    else out.push(<code key={k++} style={{fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",fontSize:"0.9em",background:"var(--green-light)",color:"var(--green-deep)",padding:"1px 5px",borderRadius:5}}>{tok.slice(1,-1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
};
const RichText = ({ text }) => {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const blocks = []; let list = null;
  const flush = () => { if (list) { blocks.push(list); list = null; } };
  lines.forEach(raw => {
    const t = raw.trim();
    const head = t.match(/^#{1,4}\s+(.*)$/);
    const num = t.match(/^(\d+)[.)]\s+(.*)$/);
    const bul = t.match(/^[-*\u2022]\s+(.*)$/);
    if (head) { flush(); blocks.push({ type: "h", text: head[1] }); return; }
    if (num) { if (!list || list.type !== "ol") { flush(); list = { type: "ol", items: [] }; } list.items.push(num[2]); return; }
    if (bul) { if (!list || list.type !== "ul") { flush(); list = { type: "ul", items: [] }; } list.items.push(bul[1]); return; }
    if (!t) { flush(); return; }
    flush(); blocks.push({ type: "p", text: t });
  });
  flush();
  return (
    <div>
      {blocks.map((b, i) => {
        if (b.type === "h") return <div key={i} style={{ fontWeight: 700, fontSize: 13.5, color: "var(--green)", margin: i ? "11px 0 5px" : "0 0 5px" }}><RichInline text={b.text} /></div>;
        if (b.type === "p") return <div key={i} style={{ margin: "0 0 7px" }}><RichInline text={b.text} /></div>;
        if (b.type === "ol") return <div key={i} style={{ margin: "2px 0 8px" }}>{b.items.map((it, j) => (<div key={j} style={{ display: "flex", gap: 9, marginBottom: 5, alignItems: "flex-start" }}><span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: "50%", background: "var(--green)", color: "#fff", fontSize: 10.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>{j + 1}</span><span style={{ flex: 1 }}><RichInline text={it} /></span></div>))}</div>;
        if (b.type === "ul") return <div key={i} style={{ margin: "2px 0 8px" }}>{b.items.map((it, j) => (<div key={j} style={{ display: "flex", gap: 9, marginBottom: 4, alignItems: "flex-start" }}><span style={{ flexShrink: 0, width: 5, height: 5, borderRadius: "50%", background: "var(--green)", marginTop: 7 }} /><span style={{ flex: 1 }}><RichInline text={it} /></span></div>))}</div>;
        return null;
      })}
    </div>
  );
};

function ProQureApp({ session, companyId }) {
  // Cloud scope: the COMPANY id (shared by the whole team) when resolved, else the
  // user id (sole trader / pre-migration fallback). Declared up here because effects
  // and handlers below reference it - a const can't be used before its declaration.
  const cloudUserId = companyId || session?.user?.id || null;
  // Settings persisted to localStorage
  const [settings, setSettings] = useState(() => {
    try { return JSON.parse(localStorage.getItem("piq_settings")||"{}"); } catch { return {}; }
  });
  const [suppliers, setSuppliers] = useState(() => {
    try { return normSuppliers(JSON.parse(localStorage.getItem("piq_suppliers")||"null")||DEFAULT_SUPPLIERS); } catch { return normSuppliers(DEFAULT_SUPPLIERS); }
  });
  // Global activity logger — records everything across the app
  const logActivity = (action, detail, meta={}) => {
    const entry = {
      id: `ACT-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
      ts: new Date().toISOString(),
      action, detail,
      user: settings.contactName || "You",
      ...meta
    };
    setActivityLog(prev => [entry, ...prev].slice(0,500));
    return entry;
  };

  const saveSettings = (patch) => {
    const next = {...settings,...patch}; setSettings(next);
    try {
      localStorage.setItem("piq_settings", JSON.stringify(next));
    } catch(err) {
      showToast("Settings saved but storage is full - try a smaller logo","warn");
    }
  };
  const saveSuppliers = (s) => { setSuppliers(s); try{localStorage.setItem("piq_suppliers",JSON.stringify(s))}catch{} };

  // Nav & toast
  const [view, setView] = useState(() => {
    try { return sessionStorage.getItem("piq_view") || "dashboard"; } catch { return "dashboard"; }
  });
  useEffect(() => { try { sessionStorage.setItem("piq_view", view); } catch {} }, [view]);
  const [toast, setToast] = useState(null);
  const showToast = (msg, type="success") => { setToast({msg,type}); setTimeout(()=>setToast(null),4000); };

  // Requests
  const [requests, setRequests] = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_requests")||"[]")}catch{return []} });
  // Supplier Catalogues: each entry = { id, supplier, name, uploadedAt, uploadedBy, items:[{id,description,partNumber,manufacturer,pack,datasheetUrl,notes}] }
  const [catalogues, setCatalogues] = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_catalogues")||"[]")}catch{return []} });
  const [orders,   setOrders]   = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_orders")||"[]")}catch{return []} });
  const [omJob, setOmJob] = useState(null);       // jobRef being generated
  const [omBusy, setOmBusy] = useState(false);
  const [omStage, setOmStage] = useState("");
  const [omWeb, setOmWeb] = useState(false);       // find datasheet links online (metered)
  const [omSplit, setOmSplit] = useState(false);   // also export sections separately
  const [repMode, setRepMode] = useState("overview");
  const [repOpen, setRepOpen] = useState(null);    // expanded project in reports
  const [mMaterial, setMMaterial] = useState("Emulsion paint");
  const [mLength, setMLength] = useState("");
  const [mHeight, setMHeight] = useState("");
  const [mArea, setMArea] = useState("");
  const [mCoats, setMCoats] = useState("2");
  const [mWastage, setMWastage] = useState("10");
  const [mMeasureType, setMMeasureType] = useState("area"); // "area" (m2) | "volume" (m3)
  const [mDepth, setMDepth] = useState(""); // depth/thickness in mm, for volume
  const [mBusy, setMBusy] = useState(false);
  const [mResult, setMResult] = useState(null);
  const [mProduct, setMProduct] = useState("");
  const [mUseDatasheet, setMUseDatasheet] = useState(false);
  const [mMode, setMMode] = useState("dims"); // "dims" | "drawing"
  const [mDrawBusy, setMDrawBusy] = useState(false);
  const [mDrawName, setMDrawName] = useState("");
  const [mTakeoff, setMTakeoff] = useState(null);
  const [mDrawError, setMDrawError] = useState("");
  const [mDragOver, setMDragOver] = useState(false); // desktop drag-and-drop highlight for the drawing upload zone
  const [hires,    setHires]    = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_hires")||"[]")}catch{return []} });
  const [activityLog, setActivityLog] = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_activity")||"[]")}catch{return []} });
  const [savedQuoteSets, setSavedQuoteSets] = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_quote_sets")||"[]")}catch{return []} });
  // Usage metering: quiet per-instance counters for the future admin dashboard. Invisible to users.
  const [usage, setUsage] = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_usage")||"{}")}catch{return {}} });
  const meter = useCallback((key, n=1) => {
    setUsage(prev => {
      const today = new Date().toISOString().split("T")[0];
      const next = { ...prev };
      next.totals = { ...(next.totals||{}) };
      next.totals[key] = (next.totals[key]||0) + n;
      next.lastActivity = new Date().toISOString();
      next.firstSeen = next.firstSeen || new Date().toISOString();
      next.daily = { ...(next.daily||{}) };
      next.daily[today] = { ...(next.daily[today]||{}) };
      next.daily[today][key] = (next.daily[today][key]||0) + n;
      return next;
    });
  }, []);
  const [team, setTeam] = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_team")||"[]")}catch{return []} });
  const myEmail = (session?.user?.email || "").toLowerCase();
  // Ensure the signed-in user exists in the team. First-ever user becomes Manager.
  useEffect(() => {
    if (!myEmail) return;
    setTeam(prev => {
      // Migration: the old "owner" role was merged into "manager". Rewrite any stragglers.
      let base = prev;
      if (prev.some(m => m.role === "owner")) {
        base = prev.map(m => m.role === "owner" ? { ...m, role: "manager" } : m);
      }
      const exists = base.some(m => (m.email||"").toLowerCase() === myEmail);
      if (exists) return base;
      const isFirst = base.length === 0;
      const me = { email: myEmail, name: "", role: isFirst ? "manager" : "engineer", addedAt: new Date().toISOString(), active: true };
      return [...base, me];
    });
  }, [myEmail]);
  const myMember = team.find(m => (m.email||"").toLowerCase() === myEmail) || null;
  // Defensive: treat the retired "owner" role (or any unknown role) as manager / engineer sensibly.
  const normaliseRole = (r) => r === "owner" ? "manager" : (ROLES[r] ? r : null);
  const myRole = normaliseRole(myMember?.role) || (cloudEnabled ? "engineer" : "manager");
  // A brand-new company's first Manager should set up their workspace before using it.
  // Only fires for a cloud account that is a manager with no company name saved yet, so
  // it never bothers an existing/established company (or invited engineers/buyers).
  const needsOnboarding = cloudEnabled && roleRank(myRole) >= 3 && !settings.onboarded && !((settings.company || "").trim());
  // If the user is on a view their role can't access, send them to the dashboard.
  // Guard against transient demotion: during a background cloud sync the team list
  // can momentarily be empty/re-loading, which would briefly resolve myRole to the
  // default and wrongly kick a manager off Settings. Only redirect once we're
  // confident the team data is actually loaded.
  useEffect(() => {
    // Hard-gated views: if a user lands here below the required rank (e.g. via a
    // shortcut that bypassed handleNav), bounce them to the dashboard. This is the
    // backstop behind handleNav's VIEW_MIN_ROLE check and must list EVERY restricted
    // view. NB: "quotes" is intentionally omitted — engineers get a cost-stripped
    // quotes view reached from dashboard/request cards (prices gated by can.viewCosts).
    const need = ({ suppliers:2, om:2, reports:2, library:2, team:3, settings:3 })[view];
    if (!need) return;
    const teamLoaded = Array.isArray(team) && team.length > 0;
    const meKnown = !!myMember;
    // Only enforce if we actually know who the user is; otherwise wait.
    if (teamLoaded && meKnown && roleRank(myRole) < need) setView("dashboard");
  }, [view, myRole, team, myMember]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("engineer");
  const [inviteName, setInviteName] = useState("");
  const [inviteEmployment, setInviteEmployment] = useState("subcontractor");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [memberStatus, setMemberStatus] = useState({});
  // Reflect who has signed in (Active) vs is still invited (Pending) on the Team list.
  useEffect(() => {
    if (view !== "team" || !cloudEnabled || !supabase || !cloudUserId) return;
    let on = true;
    supabase.from("members").select("email,user_id,joined_at").eq("company_id", cloudUserId).then(({ data, error }) => {
      if (!on || error || !data) return;
      const map = {};
      data.forEach(r => { map[(r.email||"").toLowerCase()] = { active: !!r.user_id, joinedAt: r.joined_at }; });
      setMemberStatus(map);
    });
    return () => { on = false; };
  }, [view, cloudUserId]);
  async function handleInviteMember() {
    if (!can.manageTeam(myRole)) { showToast("Only a Manager can add members.","warn"); return; }
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast("Enter a valid email address.","warn"); return; }
    if (team.some(m => (m.email||"").toLowerCase() === email)) { showToast("That person is already on the team.","warn"); return; }
    if (roleRank(inviteRole) > roleRank(myRole)) { showToast("You can only assign roles up to your own level.","warn"); return; }
    if (inviteBusy) return;
    setInviteBusy(true);
    const member = { email, name: inviteName.trim(), role: inviteRole, employment: inviteEmployment, addedAt: new Date().toISOString(), active: true };
    try {
      let emailed = false;
      if (cloudEnabled && supabase) {
        try {
          const { data: sess } = await supabase.auth.getSession();
          const token = sess?.session?.access_token;
          if (token) {
            const res = await fetch("/api/admin", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
              body: JSON.stringify({ action: "invite", email, name: inviteName.trim(), role: inviteRole, employment: inviteEmployment }),
            });
            const d = await res.json().catch(() => ({}));
            if (res.ok && d.ok) { emailed = true; showToast(d.message || `Invite emailed to ${email}.`); }
            else if (res.status !== 404) { showToast(d.error || "Could not email the invite - added to the team; they can use 'Forgot password' to set one.", "warn"); }
          }
        } catch (e) { /* fall through to the local fallback */ }
        // Fallback (server function not deployed yet): register the membership so the
        // person still joins this company when they sign in / reset their password.
        if (!emailed && cloudUserId) {
          supabase.from("members").upsert({ email, company_id: cloudUserId, role: inviteRole, employment: inviteEmployment, user_id: null }, { onConflict: "email" })
            .then(({ error }) => { if (error) console.warn("invite: members upsert failed", error.message); });
          showToast(`${email} added. They can sign in with this email to join.`);
        }
      } else {
        showToast(`${email} added.`);
      }
      setTeam(prev => [...prev, member]);
      logActivity("Team member added", `${email} added as ${ROLES[inviteRole]?.label||inviteRole}`, { entity:"team" });
      setInviteEmail(""); setInviteName(""); setInviteRole("engineer"); setInviteEmployment("subcontractor");
    } finally { setInviteBusy(false); }
  }
  function handleChangeRole(email, newRole) {
    if (!can.manageTeam(myRole)) { showToast("Only a Manager can change roles.","warn"); return; }
    const target = (email||"").toLowerCase();
    if (roleRank(newRole) > roleRank(myRole)) { showToast("You can only assign roles up to your own level.","warn"); return; }
    // Safety: don't allow removing the last manager
    const managers = team.filter(m => m.role === "manager");
    if (managers.length === 1 && (managers[0].email||"").toLowerCase() === target && newRole !== "manager") {
      showToast("There must be at least one Manager. Promote someone else first.","warn"); return;
    }
    setTeam(prev => prev.map(m => (m.email||"").toLowerCase() === target ? { ...m, role: newRole } : m));
    if (cloudEnabled && supabase && cloudUserId) {
      supabase.from("members").update({ role: newRole }).eq("email", target).eq("company_id", cloudUserId)
        .then(({ error }) => { if (error) console.warn("role change: members update failed", error.message); });
    }
    logActivity("Role changed", `${email} is now ${ROLES[newRole]?.label||newRole}`, { entity:"team" });
    showToast("Role updated.");
  }
  function handleRemoveMember(email) {
    if (!can.manageTeam(myRole)) { showToast("Only a Manager can remove members.","warn"); return; }
    const target = (email||"").toLowerCase();
    const managers = team.filter(m => m.role === "manager");
    if (managers.length === 1 && (managers[0].email||"").toLowerCase() === target) {
      showToast("You can't remove the only Manager.","warn"); return;
    }
    setTeam(prev => prev.filter(m => (m.email||"").toLowerCase() !== target));
    logActivity("Team member removed", `${email} removed from the team`, { entity:"team" });
    showToast("Member removed.");
  }

  // Wizard state
  const [step,     setStep]     = useState(1);
  const [rawInput, setRawInput] = useState("");
  const [interim,  setInterim]  = useState("");
  const [parsed,   setParsed]   = useState(null);
  const [jobRef,   setJobRef]   = useState("");
  const [site,     setSite]     = useState("");
  const [trade,    setTrade]    = useState("Plumbing");
  const [rfqEmail, setRfqEmail] = useState("");
  const [rfqDocs,  setRfqDocs]  = useState([]); // supporting docs sent with the RFQ: {id,filename,content(base64),size,kind}
  const [selSup,   setSelSup]   = useState([]);
  const [contactSel, setContactSel] = useState({}); // { [supplierId]: contactId } - which contact an RFQ goes to
  const [supSearch, setSupSearch] = useState("");    // searchable supplier picker (wizard)
  const [editingReqId, setEditingReqId] = useState(null); // when set, the wizard is revising an existing request (re-send)
  const [loading,  setLoading]  = useState(false);
  const [loadMsg,  setLoadMsg]  = useState("");
  const [emailRes, setEmailRes] = useState(null);
  const [deliveryMethod, setDeliveryMethod] = useState("direct");
  const [deliveryDate,   setDeliveryDate]   = useState("");
  const [altAddress,     setAltAddress]     = useState("");
  const [collectFrom,    setCollectFrom]    = useState("");
  const [requestNotes,   setRequestNotes]   = useState("");
  const [requestBudget,  setRequestBudget]  = useState("");

  // Help AI chat
  const [helpMessages, setHelpMessages] = useState([]);
  const [helpInput, setHelpInput] = useState("");
  const [helpLoading, setHelpLoading] = useState(false);

  // Contact form
  const [contactForm, setContactForm] = useState({name:"",email:"",category:"Bug report",priority:"Normal",description:""});
  const [contactSent, setContactSent] = useState(false);
  const [contactBusy, setContactBusy] = useState(false);

  // Keyboard shortcuts
  useEffect(()=>{
    const handler = e=>{
      const t = e.target;
      if (t.tagName==="INPUT"||t.tagName==="TEXTAREA"||t.tagName==="SELECT"||t.isContentEditable) return;
      if (e.key==="?"||e.key==="/") { setShowShortcuts(p=>!p); return; }
      if (e.key==="n"||e.key==="N") { setView("new"); resetNewRequest(); }
      else if (e.key==="q"||e.key==="Q") setView("quotes");
      else if (e.key==="o"||e.key==="O") setView("orders");
      else if (e.key==="d"||e.key==="D") setView("dashboard");
      else if (e.key==="s"||e.key==="S") setView("settings");
      else if (e.key==="h"||e.key==="H") setView("help");
      else if (e.key==="Escape") { setShowShortcuts(false);
        setDeleteConfirm(null); setEditModal(null); setActivityModal(null);
        setApproveConfirm(null); setApproveSuccess(null); setTemplateModal(false);
        setResetConfirm(false); setShowPoSetup(false); setCancelOrderConfirm(null);
        setTrialResetConfirm(false);
      }
    };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[]);

  // Templates
  const [templates, setTemplates] = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_templates")||"[]")}catch{return []} });
  const saveTemplates = (t) => { setTemplates(t); try{localStorage.setItem("piq_templates",JSON.stringify(t));}catch{} };
  const [templateModal, setTemplateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");

  // RFQ deadline
  const [rfqDeadline, setRfqDeadline] = useState("");

  // Edit modal state
  const [editModal,  setEditModal]  = useState(null); // request being edited
  const [editForm,   setEditForm]   = useState({});
  const [deleteConfirm, setDeleteConfirm] = useState(null); // request id to confirm delete
  const [activityModal, setActivityModal] = useState(null); // request to show log

  // Orders state

  const [activeOrder, setActiveOrder] = useState(null);
  const [sendingOrder, setSendingOrder] = useState(null);
  const [orderFilter, setOrderFilter] = useState("all");
  const [expandedOrder, setExpandedOrder] = useState(null);
  const [expandedQuote, setExpandedQuote] = useState(null);
  const [orderNote, setOrderNote] = useState({});
  const [expectedDelivery, setExpectedDelivery] = useState({}); // {orderId: dateStr}

  function handleOrderConfirmationUpload(file, orderId) {
    if (!file) return;
    // Guard against very large files bloating storage/sync. Images get compressed; others are size-capped.
    const isImage = (file.type||"").startsWith("image/");
    const storeDoc = (dataUrl) => {
      const doc = {
        id: `CONF-${Date.now()}`,
        type: "confirmation",
        label: file.name,
        date: new Date().toLocaleDateString("en-GB"),
        fileSize: `${(file.size/1024).toFixed(1)} KB`,
        dataUrl,
        fileType: file.type,
      };
      const entry = {
        ts: new Date().toISOString(),
        action: "Supplier confirmation attached",
        detail: `${file.name} uploaded`,
        user: settings.contactName||"You"
      };
      setOrders(p=>p.map(o=>o.id===orderId?{
        ...o,
        status:"confirmed",
        confirmationDoc: doc,
        activity:[...(o.activity||[]),entry]
      }:o));
      logActivity("Confirmation uploaded", `${doc.label} attached - order confirmed`, { entity:"order" });
      showToast("Confirmation attached");
    };
    if (isImage) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const image = new Image();
        image.onload = () => {
          const maxW = 1200;
          const scale = Math.min(1, maxW / image.width);
          const cv = document.createElement("canvas");
          cv.width = image.width * scale; cv.height = image.height * scale;
          cv.getContext("2d").drawImage(image, 0, 0, cv.width, cv.height);
          let out; try { out = cv.toDataURL("image/jpeg", 0.7); } catch(err) { out = e.target.result; }
          storeDoc(out);
        };
        image.onerror = () => storeDoc(e.target.result);
        image.src = e.target.result;
      };
      reader.readAsDataURL(file);
      return;
    }
    if (file.size > 4*1024*1024) { showToast("That file is too large (max 4MB). Please attach a smaller PDF.","warn"); return; }
    const reader = new FileReader();
    reader.onload = (e) => storeDoc(e.target.result);
    reader.readAsDataURL(file);
    return;
  }

  // Quote library - persisted
  const [quoteLibrary, setQuoteLibrary] = useState(() => {
    try { return JSON.parse(localStorage.getItem("piq_quote_library")||"[]"); } catch { return []; }
  });
  const saveToLibrary = (qa, reqId, jobRef, site, trade) => {
    const entry = {
      id: `QL-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      savedAt: new Date().toISOString(),
      expiryDate: new Date(Date.now()+(settings.quoteValidityDays||30)*24*3600000).toISOString(),
      reqId, jobRef, site, trade,
      supplierName: qa.supplierName||"Unknown",
      completeness: qa.completeness,
      totalEstimate: qa.estimatedTotal||qa.subtotal||"",
      carriageCharge: qa.carriageCharge||"",
      leadTime: qa.leadTime||"",
      items: qa.matched||[],
      missing: qa.missing||[],
      warnings: qa.warnings||[],
      overallVerdict: qa.overallVerdict||"",
    };
    setQuoteLibrary(prev => {
      const next = [entry, ...prev].slice(0,500);
      try{localStorage.setItem("piq_quote_library", JSON.stringify(next));}catch{}
      return next;
    });
  };

  // Quote analysis state
  const [activeReq,     setActiveReq]     = useState(null);
  const [approvedQuoteId, setApprovedQuoteId] = useState(null);
  const [approveConfirm, setApproveConfirm] = useState(null); // {qa} waiting for confirmation
  const [approveSuccess, setApproveSuccess] = useState(null); // {poNum, supplier, reqId} success state
  const [quoteInput,    setQuoteInput]    = useState("");
  const [quoteSupplierName, setQuoteSupplierName] = useState("");
  const [quoteAnalysis, setQuoteAnalysis] = useState(null);
  const [allAnalyses, setAllAnalyses] = useState([]);
  const [fileExtracting, setFileExtracting] = useState({}); // {supplierIndex: bool}
  const [dragOver, setDragOver] = useState({}); // {supplierIndex: bool}

  // Settings form
  const [sForm, setSForm] = useState({company:"",contactName:"",fromEmail:"",resendKey:"",openRouterKey:"",logoBase64:"",poNotes:"",quoteValidityDays:30,...settings});

  // Supplier form
  const [newSup, setNewSup] = useState({name:"",email:"",categories:""});
  const [quickSup, setQuickSup] = useState({name:"",email:""});
  const [showQuickSup, setShowQuickSup] = useState(false);
  const [editSup, setEditSup] = useState(null); // working copy of the supplier being edited (Suppliers page)

  // Voice
  const { listening, supported:voiceOk, start:micStart, stop:micStop } = useSpeechRecognition({
    onTranscript: t => setInterim(t),
    onFinal:      t => {
      // Just append the transcribed text to the box - let the user review and edit.
      // They tap "Parse with AI" themselves when ready.
      setRawInput(p => (p + t).trim() + " ");
      setInterim("");
    }
  });
  const supported = voiceOk;
  const toggleListen = () => { listening ? micStop() : micStart(); };

  // Active (non-archived) requests power all the normal views; archived are kept but hidden.
  const liveRequests = requests.filter(r=>!r.archived);
  // Engineers only see jobs they created; buyers and managers see everything.
  const visibleRequests = can.viewAllJobs(myRole) ? liveRequests : liveRequests.filter(r=>(r.createdBy||"").toLowerCase()===myEmail);
  // Engineers/subcontractors only see orders for jobs they're involved with: a request
  // they raised, or a Quick PO they raised themselves. Managers/buyers see everything.
  // ONE scoped list powers the rows AND every count (pills, empty-state, nav badge) so
  // the numbers and the visible rows can never disagree. Derived from live state, so it
  // recomputes automatically on account switch and after hydration - no cache to clear.
  const involvedInOrder = (o) => {
    if ((o.createdBy||"").toLowerCase() === myEmail) return true;
    const r = requests.find(rr => rr.id === o.reqId);
    return !!r && (r.createdBy||"").toLowerCase() === myEmail;
  };
  const visibleOrders = can.viewAllJobs(myRole) ? orders : orders.filter(involvedInOrder);
  const stats = {
    total:    visibleRequests.length,
    pending:  visibleRequests.filter(r=>r.status==="pending").length,
    received: visibleRequests.filter(r=>r.status==="received").length,
    approved: visibleRequests.filter(r=>r.status==="approved").length,
  };

  const _tradeSup = suppliers.filter(s=>(s.categories||[]).some(cat=>cat.trim().toLowerCase()===trade.trim().toLowerCase()));
  const filteredSup = _tradeSup.length ? _tradeSup : suppliers;
  // Searchable picker: when there's a search term, search across ALL suppliers
  // (name, trade, or any contact name/email); otherwise show the trade-filtered list.
  const supMatch = (s,q)=> (s.name||"").toLowerCase().includes(q) || (s.categories||[]).some(c=>(c||"").toLowerCase().includes(q)) || (s.contacts||[]).some(c=>(c.name||"").toLowerCase().includes(q)||(c.email||"").toLowerCase().includes(q));
  const pickList = (()=>{ const q=supSearch.trim().toLowerCase(); return q ? suppliers.filter(s=>supMatch(s,q)) : filteredSup; })();
  // Autocomplete suggestions (native datalists) drawn from past requests + supplier branches.
  const pastJobRefs = [...new Set((requests||[]).map(r=>r.jobRef).filter(Boolean))].slice(0,80);
  const pastSites = [...new Set((requests||[]).map(r=>r.site).filter(Boolean))].slice(0,80);
  const collectOptions = [...new Set([].concat(...suppliers.map(s=>s.branches||[])).concat((requests||[]).map(r=>r.collectFrom).filter(Boolean)))].filter(Boolean).slice(0,80);
  const pastAddresses = [...new Set((requests||[]).map(r=>r.altAddress).filter(Boolean))].slice(0,80);

  function logToRequest(reqId, action, detail="") {
    const entry = { ts: new Date().toISOString(), action, detail, user: settings.contactName||"You" };
    setRequests(p=>p.map(r=>r.id===reqId ? {...r, activity:[...(r.activity||[]), entry]} : r));
    // Also record in the global activity log
    const reqObj = requests.find(r=>r.id===reqId);
    logActivity(action, detail, { reqId, jobRef: reqObj?.jobRef||"", entity:"request" });
  }

  function handleDelete(id) {
    if (!can.deleteItems(myRole)) { showToast("Only a Manager can archive requests.","warn"); setDeleteConfirm(null); return; }
    const req = requests.find(r=>r.id===id);
    logToRequest(id, "Archived", "Request archived");
    logActivity("Request archived", `${req?.jobRef||id} archived${req?.trade?` (${req.trade})`:""}`, { entity:"request", reqId:id });
    setRequests(p=>p.map(r=>r.id===id?{...r,archived:true,archivedAt:new Date().toISOString(),archivedBy:myEmail}:r));
    setSavedQuoteSets(prev=>prev.map(s=>s.reqId===id?{...s,archived:true}:s));
    if (activeReq?.id===id) { setActiveReq(null); setAllAnalyses([]); }
    setDeleteConfirm(null);
    showToast("Request archived - find it under Archived in All requests");
  }

  function handleRestore(id) {
    if (!can.deleteItems(myRole)) { showToast("Only a Manager can restore items.","warn"); return; }
    const req = requests.find(r=>r.id===id);
    logActivity("Request restored", `${req?.jobRef||id} restored from archive`, { entity:"request", reqId:id });
    setRequests(p=>p.map(r=>r.id===id?{...r,archived:false,archivedAt:null,archivedBy:null}:r));
    setSavedQuoteSets(prev=>prev.map(s=>s.reqId===id?{...s,archived:false}:s));
    showToast("Request restored");
  }

  function handleResetWorkspace() {
    if (roleRank(myRole) < 3) { showToast("Only a Manager can reset the workspace.","warn"); setResetConfirm(false); return; }
    const stamp = new Date().toISOString();
    setRequests(p=>p.map(r=>r.archived?r:{...r,archived:true,archivedAt:stamp,archivedBy:myEmail}));
    setSavedQuoteSets(p=>p.map(s=>({...s,archived:true})));
    setOrders(p=>p.map(o=>(o.status==="cancelled")?o:{...o,status:"cancelled",cancelledAt:stamp,cancelledBy:myEmail,resetArchived:true}));
    logActivity("Workspace reset", "All requests archived and orders cancelled to start fresh - records retained", { entity:"workspace" });
    setResetConfirm(false);
    setActiveReq(null); setAllAnalyses([]);
    showToast("Workspace reset - everything is archived and recoverable, nothing was deleted");
  }

  // TEMPORARY (trial only): hard-wipe everything except suppliers for a clean start.
  // Remove this function, its button and modal before going live.
  function handleTrialReset() {
    if (roleRank(myRole) < 3) { showToast("Only a Manager can do this.","warn"); setTrialResetConfirm(false); return; }
    setRequests([]);
    setOrders([]);
    setSavedQuoteSets([]);
    setQuoteLibrary([]);
    setTemplates([]);
    setActivityLog([]);
    setActiveReq(null); setAllAnalyses([]); setApprovedQuoteId(null);
    setTrialResetConfirm(false);
    setView("dashboard");
    showToast("Fresh start - everything cleared except your suppliers");
  }

  function markOrderDelivered(order, img) {
    setOrders(p=>p.map(o=>o.id===order.id?{...o,status:"delivered",deliveredAt:new Date().toISOString(),...(img?{deliveryPhoto:img,signedOffBy:myEmail}:{})}:o));
    logActivity(img?"Delivery signed off":"Order delivered",`${order.poNumber} (${order.supplier}) ${img?`signed off by ${myEmail} with delivery photo`:"marked as delivered"}`,{entity:"order",jobRef:order.jobRef});
    if(img) meter("deliveriesSignedOff");
    showToast(img?"Delivery signed off — back to dashboard":"Order delivered — back to dashboard");
    setView("dashboard");
  }
  function deliverWithPhoto(order, file) {
    if(!file) return;
    const rd=new FileReader();
    rd.onload=()=>{ const dataUrl=rd.result; const image=new Image();
      image.onload=()=>{ const maxW=1000; const scale=Math.min(1,maxW/image.width); const cv=document.createElement("canvas"); cv.width=image.width*scale; cv.height=image.height*scale; cv.getContext("2d").drawImage(image,0,0,cv.width,cv.height); let img; try{img=cv.toDataURL("image/jpeg",0.7);}catch(err){img=dataUrl;} markOrderDelivered(order,img); };
      image.onerror=()=>markOrderDelivered(order,dataUrl);
      image.src=dataUrl; };
    rd.readAsDataURL(file);
  }
  function handleCancelOrder(orderId) {
    if (!can.deleteItems(myRole)) { showToast("Only a Manager can cancel orders.","warn"); return; }
    const order = orders.find(o=>o.id===orderId);
    setOrders(p=>p.map(o=>o.id===orderId?{...o,status:"cancelled",cancelledAt:new Date().toISOString(),cancelledBy:myEmail}:o));
    logActivity("Order cancelled", `${order?.poNumber||orderId}${order?.supplier?` (${order.supplier})`:""} cancelled`, { entity:"order", jobRef:order?.jobRef });
    setCancelOrderConfirm(null);
    showToast("Order cancelled - the record is kept for your audit trail");
  }

  function handleEditSave() {
    const r = requests.find(r=>r.id===editModal.id);
    const changes = [];
    if (editForm.jobRef!==r.jobRef) changes.push(`Job ref: ${r.jobRef} > ${editForm.jobRef}`);
    if (editForm.site!==r.site)     changes.push(`Site: ${r.site} > ${editForm.site}`);
    if (editForm.status!==r.status) changes.push(`Status: ${(STATUS[r.status]||{label:r.status}).label} > ${(STATUS[editForm.status]||{label:editForm.status}).label}`);
    if (editForm.notes!==r.notes)   changes.push(`Notes updated`);
    const entry = { ts: new Date().toISOString(), action:"Edited", detail: changes.join(" · ")||"No changes", user: settings.contactName||"You" };
    setRequests(p=>p.map(r=>r.id===editModal.id
      ? {...r, jobRef:editForm.jobRef, site:editForm.site, status:editForm.status, notes:editForm.notes, activity:[...(r.activity||[]), entry]}
      : r
    ));
    if (activeReq?.id===editModal.id) setActiveReq(prev=>({...prev, jobRef:editForm.jobRef, site:editForm.site, status:editForm.status, notes:editForm.notes}));
    setEditModal(null);
    showToast("Request updated");
  }

  // -- Handlers --
  async function handleParse() {
    if (!rawInput.trim()) return;
    if (!AI_VIA_SERVER && !settings.openRouterKey) { showToast("AI is temporarily unavailable. Please try again shortly.","warn"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setLoading(true); setLoadMsg("Parsing your material list...");
    try {
      const data = await parseMaterialList(rawInput);
      if (!data || !data.items || data.items.length===0) {
        showToast("Couldn't read a clear list from that. Try rephrasing, or edit the text and parse again.","warn");
        setLoading(false);
        return;
      }
      setParsed(data);
      if (data?.jobRef && !jobRef) setJobRef(data.jobRef);
      // Auto-detect the trade from the parsed items (majority item category) so the
      // engineer doesn't have to set it. It still powers supplier filtering and the
      // spend-by-trade chart, and can be overridden on Step 2.
      let effectiveTrade = trade;
      const cats = (data.items||[]).map(i=>(i.category||"").trim()).filter(Boolean);
      if (cats.length) {
        const counts = {};
        cats.forEach(c=>{ const m = TRADES.find(t=>t.toLowerCase()===c.toLowerCase()); const key = m||c; counts[key]=(counts[key]||0)+1; });
        const top = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
        if (TRADES.includes(top)) { effectiveTrade = top; setTrade(top); }
      }
      // Duplicate detection
      if (jobRef) {
        const dupe = requests.find(r=>r.jobRef&&r.jobRef.toLowerCase()===jobRef.toLowerCase()&&r.trade===effectiveTrade&&(Date.now()-new Date(r.created||Date.now()).getTime())<30*24*3600000);
        if (dupe) showToast(`Heads up: similar request ${dupe.id} already exists for ${jobRef}`,"warn");
      }
      // Pre-tick only the suppliers matching the detected trade as a convenience; if
      // none match, start with NONE selected so the user chooses who to send to
      // (rather than everyone being auto-selected).
      const matchingIds = suppliers
        .filter(s=>(s.categories||[]).some(cat=>cat.trim().toLowerCase()===effectiveTrade.trim().toLowerCase()))
        .map(s=>s.id);
      setSelSup(matchingIds);
      setStep(2);
    } catch(e) {
      showToast("AI error: "+e.message,"warn");
    }
    setLoading(false);
  }


  async function handleGenRFQ() {
    window.__piq_or_key__ = settings.openRouterKey;
    if (!can.sendRFQ(myRole)) { handleIssueToBuyer(); return; }
    setLoading(true); setLoadMsg("Generating RFQ email...");
    try {
      const email = await generateRFQ(parsed.items, jobRef, settings.company, settings.contactName, settings.fromEmail, deliveryMethod, deliveryDate, altAddress, rfqDeadline, settings.siteAddress, collectFrom);
      setRfqEmail(email);
      setStep(3);
    } catch(e) { showToast("AI error: "+e.message,"warn"); }
    setLoading(false);
  }

  // Count how many times a supplier has been used (any PO or quote) and prompt to promote ad-hoc ones at 5.
  function bumpSupplierUse(supplierId) {
    if (supplierId == null) return;
    setSuppliers(prev => {
      const next = prev.map(s => {
        if (s.id !== supplierId) return s;
        const useCount = (s.useCount || 0) + 1;
        return { ...s, useCount };
      });
      const sup = next.find(s => String(s.id) === String(supplierId));
      if (sup && sup.tier === "ad-hoc" && (sup.useCount || 0) >= 5 && !sup.promoteDismissed) {
        setPromotePrompt(sup);
      }
      try { localStorage.setItem("piq_suppliers", JSON.stringify(next)); } catch {}
      return next;
    });
  }

  function promoteSupplier(supplierId) {
    setSuppliers(prev => {
      const next = prev.map(s => String(s.id) === String(supplierId) ? { ...s, tier: "approved" } : s);
      try { localStorage.setItem("piq_suppliers", JSON.stringify(next)); } catch {}
      return next;
    });
    const sup = suppliers.find(s => String(s.id) === String(supplierId));
    if (sup) logActivity("Supplier approved", `${sup.name} promoted to approved supplier after repeated use`, { entity:"supplier" });
    setPromotePrompt(null);
    showToast("Supplier promoted to approved");
  }

  // Scan a quote/delivery-note/handwritten list into Quick PO fields (vision AI, mirrors the main request scan).
  const scanQuickPO = async (file) => {
    if (!file) return null;
    if (!AI_VIA_SERVER && !settings.openRouterKey) { showToast("AI is temporarily unavailable. Please try again shortly.","warn"); return null; }
    try {
      const isImage = file.type.startsWith("image/");
      const isPDF = file.type==="application/pdf";
      if (!isImage && !isPDF) { const text = await file.text(); return await aiParseQuickPO(text, suppliers.map(s=>s.name)); }
      let imageUrls = [];
      if (isImage) {
        const dataUrl = await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result));r.onerror=rej;r.readAsDataURL(file);});
        imageUrls = [dataUrl];
      } else {
        imageUrls = await pdfToImages(file, 3);
      }
      if (!imageUrls.length) { showToast("Couldn't read that document - try a clearer photo","warn"); return null; }
      const sys = `You read UK construction/trades order documents (supplier quotes, delivery notes, handwritten lists). Extract the order as plain text: one line per item as "[quantity] [unit] [description]". If a supplier name or an agreed total price is visible, add lines "SUPPLIER: <name>" and "TOTAL: <amount>". No preamble, just the lines.`;
      const userMsg = { role:"user", content:[ ...imageUrls.map(url=>({type:"image_url",image_url:{url}})), {type:"text",text:"Extract this order."} ] };
      const models = [ "google/gemini-2.5-flash", "google/gemini-flash-1.5" ];
      let extracted="";
      try {
        if (!aiBudgetOk()) throw new Error(AI_BUDGET_MSG);
        const sres = await fetch("/api/ai",{method:"POST",headers:{"Content-Type":"application/json", ...(await authHeaders())},body:JSON.stringify({messages:[{role:"system",content:sys},userMsg],models,temperature:0.1,companyId:__companyId})});
        if (sres.ok){ const sd=await sres.json(); reportAiUsage(sd.cost,false); if(sd.text) extracted=sd.text; }
      } catch(e){}
      if (!extracted.trim() && settings.openRouterKey) {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+settings.openRouterKey,"HTTP-Referer":"https://proqure.app","X-Title":"ProQure"},body:JSON.stringify({model:models[0],messages:[{role:"system",content:sys},userMsg]})});
        const data=await res.json(); extracted=data.choices?.[0]?.message?.content||"";
      }
      if (!extracted.trim()) { showToast("Couldn't read that document - try a clearer photo","warn"); return null; }
      return await aiParseQuickPO(extracted.trim(), suppliers.map(s=>s.name));
    } catch(e){ showToast("Scan failed: "+e.message,"warn"); return null; }
  };

  // Quick PO - raise a purchase order directly from a phone-agreed price, skipping the RFQ/quote flow.
  // Buyers & Managers only. Skips manager approval (emergency). Logged as a direct/phone order.
  function handleQuickPO(form) {
    if (!can.raisePO(myRole)) { showToast("Only buyers and managers can raise a PO.","warn"); return; }
    const itemsValid = (form.items||[]).some(i => (i.description||"").trim());
    if (!itemsValid && !(form.summary||"").trim()) { showToast("Add at least one item or a description.","warn"); return; }
    const hasSupplier = (form.newSupplier && (form.newSupplierName||"").trim()) || (!form.newSupplier && form.supplierId);
    if (!hasSupplier) { showToast("Pick a supplier (or add one) before raising the PO.","warn"); return; }

    // Resolve or create the supplier
    let supplier = null;
    let supplierId = form.supplierId;
    if (form.newSupplier && (form.newSupplierName||"").trim()) {
      const ns = normSupplier({
        id: `SUP-${Date.now()}`,
        name: form.newSupplierName.trim(),
        email: (form.newSupplierEmail||"").trim(),
        categories: [form.trade || "General"],
        tier: "ad-hoc",
        useCount: 0,
        addedVia: "quick-po",
        addedAt: new Date().toISOString(),
      });
      const updated = [...suppliers, ns];
      saveSuppliers(updated);
      supplier = ns; supplierId = ns.id;
    } else {
      supplier = suppliers.find(s => String(s.id) === String(supplierId)) || null;
    }

    const poNum = `PO-${Date.now().toString().slice(-6)}`;
    const dateStr = new Date().toLocaleDateString("en-GB");
    const lineItems = (form.items||[]).filter(i => (i.description||"").trim()).map(i => ({
      description: i.description.trim(),
      quantity: i.quantity || "",
      unit: i.unit || "",
      unitPrice: i.unitPrice || "",
    }));
    const order = {
      id: poNum, reqId: null, createdBy: myEmail,
      jobRef: (form.jobRef||"").trim() || "Quick PO",
      site: (form.site||"").trim() || "",
      trade: form.trade || "",
      supplier: supplier?.name || form.newSupplierName || "",
      supplierEmail: supplier?.email || form.newSupplierEmail || "",
      items: lineItems,
      analysis: null,
      poNumber: poNum, poDate: dateStr,
      estimatedTotal: (form.total||"").trim() || "",
      status: "pending-send",
      type: "quick",            // marks this as a direct/phone order
      isQuickPO: true,
      summary: (form.summary||"").trim() || "",
      label: `PO ${poNum}`,
      deliveryMethod: form.deliveryMethod||"", deliveryDate: form.deliveryDate||"", collectFrom: (form.collectFrom||"").trim(), total: (form.total||"").trim() || "",
      notes: (form.summary||"").trim() || "",
      activity: [{ ts:new Date().toISOString(), action:"Quick PO raised", detail:`Direct/phone order - ${supplier?.name||form.newSupplierName||"supplier"}${form.total?` - ${form.total}`:""}`, user:settings.contactName||myEmail||"You" }],
    };
    setOrders(p => [order, ...p]);
    if (supplierId != null) bumpSupplierUse(supplierId);
    meter("posRaised");
    meter("posMaterials");
    logActivity("Quick PO raised", `${poNum} - ${supplier?.name||form.newSupplierName||"supplier"} (direct/phone order)${form.total?` - ${form.total}`:""}`, { entity:"order", jobRef:order.jobRef });
    setQuickPO(null);
    showToast(`Quick PO ${poNum} raised`);
    setView("orders");
    // Advisory price sanity-check (non-blocking) - compares to past orders for similar items
    if (form.total && can.viewCosts(myRole)) {
      const itemsText = lineItems.map(i=>`${i.quantity} ${i.description}`).join(", ") || form.summary || "";
      const past = orders.filter(o=>o.estimatedTotal).slice(0,30).map(o=>`${(o.items||[]).map(i=>i.description).join("/")||o.label}: ${o.estimatedTotal}`).join(" | ");
      if (itemsText && past) {
        aiPriceCheck(itemsText, form.total, past).then(msg=>{ if(msg) showToast(msg, "warn"); }).catch(()=>{});
      }
    }
  }

  // ---- Hire lifecycle -------------------------------------------------------
  // Weeks a hire has been on (from delivery/start date to now or to its close date)
  function hireWeeks(h) {
    const start = h.deliveredDate || h.startDate;
    if (!start) return 0;
    const end = h.closedDate ? new Date(h.closedDate) : new Date();
    const ms = end - new Date(start);
    return Math.max(0, Math.floor(ms / (1000*60*60*24*7)));
  }
  function hireRunningCost(h) {
    if (!h.deliveredDate) return null; // no cost until it's actually on hire
    const rate = parseFloat(String(h.weeklyRate||"").replace(/[^0-9.]/g,""));
    if (!rate) return null;
    const weeks = Math.max(1, hireWeeks(h) + 1); // count the current part-week
    return rate * weeks;
  }

  // Raise a new hire directly (the quick path) or from an approved hire-type order.
  function raiseHire(form) {
    if (!can.raisePO(myRole)) { showToast("Only buyers and managers can raise a hire.","warn"); return; }
    if (!(form.description||"").trim()) { showToast("Describe the equipment to hire.","warn"); return; }
    const ref = `HIRE-${Date.now().toString().slice(-6)}`;
    let supplier = form.supplierId ? suppliers.find(s=>String(s.id)===String(form.supplierId)) : null;
    if (form.newSupplier && (form.newSupplierName||"").trim()) {
      const ns = normSupplier({ id:`SUP-${Date.now()}`, name:form.newSupplierName.trim(), email:(form.newSupplierEmail||"").trim(), categories:["Hire"], tier:"ad-hoc", useCount:0, addedVia:"hire", addedAt:new Date().toISOString() });
      saveSuppliers([...suppliers, ns]); supplier = ns;
    }
    const hire = {
      id: ref, hireRef: ref,
      description: form.description.trim(),
      supplier: supplier?.name || form.newSupplierName || "",
      supplierEmail: supplier?.email || form.newSupplierEmail || "",
      supplierId: supplier?.id || null,
      site: (form.site||"").trim(),
      jobRef: (form.jobRef||"").trim() || "Hire",
      weeklyRate: (form.weeklyRate||"").trim(),
      deliveryDate: (form.deliveryDate||"").trim(),
      returnDate: (form.returnDate||"").trim(),
      returnOpen: !!form.returnOpen,
      status: "on-order",        // on-order -> on-hire -> off-hire-requested -> closed
      deliveredDate: null, deliveredPhoto: null, deliveryNote: "",
      offHireDate: null, collectionAddress: "", collectionPhoto: null,
      collectionRef: null, closedDate: null,
      createdAt: new Date().toISOString(),
      activity: [{ ts:new Date().toISOString(), action:"Hire raised", detail:`${form.description.trim()} - ${supplier?.name||form.newSupplierName||"supplier"}`, user:settings.contactName||myEmail||"You" }],
    };
    setHires(p => [hire, ...p]);
    if (supplier?.id) bumpSupplierUse(supplier.id);
    meter("posRaised");
    meter("posHire");
    logActivity("Hire raised", `${ref} - ${form.description.trim()} (${supplier?.name||form.newSupplierName||"supplier"})`, { entity:"hire", jobRef:hire.jobRef });
    showToast(`Hire ${ref} raised`);
    setView("hire");
  }

  function updateHire(id, patch, activity) {
    setHires(prev => prev.map(h => h.id===id ? {
      ...h, ...patch,
      activity: activity ? [...(h.activity||[]), { ts:new Date().toISOString(), ...activity, user:settings.contactName||myEmail||"You" }] : h.activity
    } : h));
  }

  async function markHireDelivered(id, file, note) {
    let photoUrl = null;
    let aiRead = null;
    if (file) {
      try {
        // Compress + read the photo with AI in parallel-ish (read needs base64)
        const base64 = await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(",")[1]); r.onerror=rej; r.readAsDataURL(file); });
        try { aiRead = await aiReadHirePhoto(base64, file.type, "delivery"); } catch {}
        photoUrl = await uploadHirePhoto(file, id, "delivery");
      }
      catch(e){ showToast(`Photo upload failed: ${e.message}`,"warn"); }
    }
    const aiNote = aiRead ? `${aiRead.equipment||""}${aiRead.condition?` - ${aiRead.condition}`:""}${aiRead.concerns?` (Note: ${aiRead.concerns})`:""}`.trim() : "";
    updateHire(id, {
      status:"on-hire",
      deliveredDate: new Date().toISOString(),
      deliveredPhoto: photoUrl,
      deliveryNote: (note||"").trim(),
      deliveryAiNote: aiNote || null,
    }, { action:"Delivered to site", detail:`Marked on hire${photoUrl?" with delivery photo":""}${note?` - ${note}`:""}${aiNote?` [AI: ${aiNote}]`:""}` });
    logActivity("Hire delivered", `${id} marked on hire`, { entity:"hire" });
    showToast(aiNote ? "On hire - AI noted the photo" : "Marked as on hire");
  }

  function extendHire(id, newDate) {
    updateHire(id, { returnDate:newDate, returnOpen:false }, { action:"Hire extended", detail:`New return date: ${newDate?new Date(newDate).toLocaleDateString("en-GB"):"-"}` });
    showToast("Hire extended");
  }

  async function offHireItem(id, collectionDate, collectionAddress) {
    const h = hires.find(x=>x.id===id);
    if (!h) return;
    // Email the supplier requesting collection
    if (h.supplierEmail) {
      const subject = `Off-hire / collection request - ${h.hireRef} - ${h.description}`;
      const body = `Hello ${h.supplier||""}\n\nPlease arrange collection of the following hired equipment:\n\nEquipment: ${h.description}\nHire reference: ${h.hireRef}\nSite: ${h.site||"-"}\nRequested collection date: ${collectionDate?new Date(collectionDate).toLocaleDateString("en-GB"):"ASAP"}\nCollection address: ${collectionAddress||h.site||"-"}\n\nPlease confirm the collection and provide an off-hire / collection reference number.\n\nKind regards\n${settings.contactName||settings.company||"The Procurement Team"}\n${settings.company||""}`;
      try {
        await fetch("/api/send-email", { method:"POST", headers:{"Content-Type":"application/json", ...(await authHeaders())}, body: JSON.stringify({ ...(()=>{const s=buildSender("orders",settings);return {from:s.from, reply_to:s.replyTo||undefined};})(), company_id: cloudUserId, to:[h.supplierEmail], subject, text:body, html:buildEmailHtml(body, settings) }) });
      } catch(e) { showToast("Off-hire email may not have sent; record updated anyway.","warn"); }
    }
    updateHire(id, {
      status:"off-hire-requested",
      offHireDate: collectionDate || "",
      collectionAddress: collectionAddress || h.site || "",
    }, { action:"Off-hire requested", detail:`Collection requested for ${collectionDate?new Date(collectionDate).toLocaleDateString("en-GB"):"ASAP"}${h.supplierEmail?` - emailed ${h.supplier}`:""}` });
    logActivity("Off-hire requested", `${id} - collection ${collectionDate?new Date(collectionDate).toLocaleDateString("en-GB"):"ASAP"}`, { entity:"hire" });
    showToast("Off-hire requested" + (h.supplierEmail?` - emailed ${h.supplier}`:""));
  }

  async function addCollectionPhoto(id, file) {
    if (!file) return;
    try {
      let aiRead = null;
      try {
        const base64 = await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(",")[1]); r.onerror=rej; r.readAsDataURL(file); });
        aiRead = await aiReadHirePhoto(base64, file.type, "collection");
      } catch {}
      const url = await uploadHirePhoto(file, id, "collection");
      const aiNote = aiRead ? `${aiRead.equipment||""}${aiRead.condition?` - ${aiRead.condition}`:""}${aiRead.concerns?` (${aiRead.concerns})`:""}`.trim() : "";
      updateHire(id, { collectionPhoto:url, collectionAiNote: aiNote||null }, { action:"Collection photo added", detail:`Photo of where equipment was left on site${aiNote?` [AI: ${aiNote}]`:""}` });
      showToast(aiNote ? "Collection photo saved - AI noted it" : "Collection photo saved");
    } catch(e){ showToast(`Photo upload failed: ${e.message}`,"warn"); }
  }

  function closeHire(id, collectionRef) {
    updateHire(id, {
      status:"closed",
      collectionRef: (collectionRef||"").trim(),
      closedDate: new Date().toISOString(),
    }, { action:"Hire closed", detail:`Collected${collectionRef?` - ref ${collectionRef}`:""}` });
    logActivity("Hire closed", `${id}${collectionRef?` - collection ref ${collectionRef}`:""}`, { entity:"hire" });
    showToast("Hire closed");
  }

  function handleIssueToBuyer() {
    if (!parsed || !(parsed.items||[]).length) { showToast("Add some materials first.","warn"); return; }
    const newId = `RFQ-${Date.now().toString().slice(-6)}`;
    const r = {
      id: newId,
      pqRef: makePqRef(),
      jobRef:jobRef||"TBC", site:site||"Site TBC", trade, notes:requestNotes, budget:requestBudget,
      status: "awaiting-buyer",
      createdBy: myEmail, createdByRole: myRole,
      buyerNote: requestNotes,
      created: new Date().toISOString().split("T")[0],
      items: parsed.items,
      deliveryMethod, deliveryDate, altAddress, collectFrom, rfqDeadline,
      sentTo: [],
      activity: [{ ts:new Date().toISOString(), action:"List raised", detail:`Materials list raised and issued to the buyer by ${myEmail}`, user:myEmail }],
    };
    setRequests(p=>[r,...p]);
    logActivity("List issued to buyer", `${r.jobRef} raised by ${myEmail}`, { entity:"request", reqId:newId });
    meter("requestsRaised");
    resetNewRequest();
    setView("requests");
    showToast("Issued to your buyer - they'll request the quotes");
  }

  async function handleSendEmails() {
    if (!EMAIL_VIA_SERVER && !settings.resendKey) { showToast("Email is temporarily unavailable. Please try again shortly.","warn"); return; }
    // Resolve each selected supplier to its chosen contact (the dropdown in the wizard).
    // Falls back to the supplier's first contact, then to the legacy top-level email.
    const toSend = suppliers.filter(s=>selSup.includes(s.id)).map(s=>{
      const cid = contactSel[s.id] || (s.contacts && s.contacts[0] && s.contacts[0].id);
      const contact = (s.contacts||[]).find(c=>c.id===cid) || (s.contacts||[])[0] || null;
      return { ...s, email:(contact&&contact.email)||s.email||"", contactName:(contact&&contact.name)||"" };
    });
    const missing = toSend.filter(s=>!s.email);
    if (missing.length){ showToast(`No contact email for: ${missing.map(s=>s.name).join(", ")} - add one on the Suppliers page`,"warn"); return; }
    setLoading(true); setLoadMsg("Sending to suppliers...");
    const subject = `Request for Quotation - ${jobRef||parsed?.jobRef||"TBC"}`;
    let results;
    try {
      results = await sendRFQEmails(toSend, subject, rfqEmail, settings.resendKey, settings.fromEmail||"onboarding@resend.dev", settings, { jobRef: jobRef||parsed?.jobRef||"", reqId: activeReq?.id||"" }, rfqDocs);
    } catch(e) {
      setLoading(false);
      showToast("Couldn't send to suppliers: "+(e?.message||"unknown error"),"warn");
      return;
    }
    setLoading(false);
    const ok = results.filter(r=>r.success).length;
    if (ok > 0) {
      const sentSuppliers = toSend.map((s,i)=>({ id:s.id, name:s.name, email:s.email, contactName:s.contactName||"", quote:"", saved:false, replyToken: results[i]?.replyToken || null }));
      // Count each supplier the RFQ goes to as a "use" (for ad-hoc promotion tracking)
      toSend.forEach(s=>bumpSupplierUse(s.id));

      // REVISE & RE-SEND: update the existing request in place (new revision) instead of
      // creating a new one. Quotes for the re-sent suppliers are reset, since the RFQ changed.
      if (editingReqId) {
        const existing = requests.find(r=>r.id===editingReqId);
        const rev = (existing?.revision||1)+1;
        const reviseEntry = { ts:new Date().toISOString(), action:`RFQ revised (v${rev}) & re-sent`, detail:`Re-sent to ${ok} supplier${ok!==1?"s":""}: ${toSend.map(s=>s.name).join(", ")}${rfqDocs.length?` · ${rfqDocs.length} supporting doc${rfqDocs.length!==1?"s":""}`:""}`, user:settings.contactName||"You" };
        setRequests(p=>p.map(r=>r.id===editingReqId ? {
          ...r,
          jobRef:jobRef||r.jobRef, site:site||r.site, trade, notes:requestNotes,
          items: parsed.items,
          deliveryMethod, deliveryDate, altAddress, collectFrom, rfqDeadline,
          revision: rev,
          status: "pending",
          sentTo: sentSuppliers,
          activity: [...(r.activity||[]), reviseEntry]
        } : r));
        showToast(`v Revised RFQ re-sent to ${ok} supplier${ok!==1?"s":""}`);
        logActivity("RFQ revised & re-sent",`${jobRef||editingReqId} revised to v${rev}, re-sent to ${ok} supplier${ok!==1?"s":""}`,{entity:"request",reqId:editingReqId,jobRef});meter("rfqsSent");meter("emailsSent", ok);
        setEmailRes(results);
        setTimeout(()=>{ resetNewRequest(); setView("requests"); }, 1800);
        return;
      }

      const newId = `RFQ-${Date.now().toString().slice(-6)}`;
      const isEngineer = roleRank(myRole) < 2;
      const r = {
        id: newId,
        pqRef: makePqRef(),
        jobRef:jobRef||"TBC", site:site||"Site TBC", trade, notes:requestNotes, budget:requestBudget,
        status: isEngineer ? "awaiting-buyer" : "pending",
        createdBy: myEmail, createdByRole: myRole,
        buyerNote: isEngineer ? requestNotes : "",
        created: new Date().toISOString().split("T")[0],
        items: parsed.items,
        deliveryMethod, deliveryDate, altAddress, collectFrom, rfqDeadline,
        sentTo: isEngineer ? [] : sentSuppliers,
        activity:[
          { ts:new Date().toISOString(), action:"Request created", detail:`Job: ${jobRef||"TBC"} · Site: ${site||"TBC"} · Trade: ${trade} · ${parsed.items.length} items`, user:settings.contactName||"You" },
          { ts:new Date().toISOString(), action:"RFQ emails sent", detail:`Sent to ${ok} supplier${ok!==1?"s":""}: ${toSend.map(s=>s.name).join(", ")}${rfqDeadline?` · Deadline: ${new Date(rfqDeadline).toLocaleDateString("en-GB")}`:""}${deliveryMethod?` · Delivery: ${deliveryMethod}`:""}${rfqDocs.length?` · ${rfqDocs.length} supporting doc${rfqDocs.length!==1?"s":""}`:""}`, user:settings.contactName||"You" },
        ]
      };
      setRequests(p=>[r,...p]);
      // Show success state briefly then redirect and reset
      showToast(`v ${ok} RFQ${ok!==1?"s":""} sent - ${newId} saved`);
      logActivity("RFQ sent",`${newId} (${jobRef||"job"}) sent to ${ok} supplier${ok!==1?"s":""}`,{entity:"request",reqId:newId,jobRef});meter("rfqsSent");meter("emailsSent", ok);meter("requestsRaised");
      setTimeout(()=>{
        // Full reset - ready for next request
        setStep(1);
        setRawInput(""); setParsed(null); setJobRef(""); setSite(""); setTrade("Plumbing");
        setRfqEmail(""); setRfqDocs([]); setEmailRes(null); setSelSup([]); setContactSel({}); setSupSearch("");
        setDeliveryMethod("direct"); setDeliveryDate(""); setAltAddress(""); setCollectFrom(""); setRfqDeadline(""); setRequestNotes(""); setRequestBudget("");
        setView("dashboard");
      }, 1800);
      setEmailRes(results); // show brief success UI
    } else {
      setEmailRes(results);
      showToast(`Some emails could not be sent - check the supplier email addresses and try again`,"warn");
    }
  }

  // Revise & re-send an existing (already-sent) request: load it back into the wizard,
  // keeping the SAME request id. On send, handleSendEmails updates that request in place
  // (bumps a revision, resets quotes for the re-sent suppliers) rather than creating a new one.
  function handleRevise(r) {
    if (!can.sendRFQ(myRole)) { showToast("Only a Buyer or Manager can re-send RFQs.","warn"); return; }
    setEditingReqId(r.id);
    setJobRef(r.jobRef||"");
    setSite(r.site||"");
    setTrade(r.trade||"Plumbing");
    setRequestNotes(r.notes||"");
    setDeliveryMethod(r.deliveryMethod||"direct");
    setDeliveryDate(r.deliveryDate||"");
    setAltAddress(r.altAddress||""); setCollectFrom(r.collectFrom||"");
    setRfqDeadline(r.rfqDeadline||"");
    const raw = (r.items||[]).map(i=>`${i.quantity} ${i.unit} of ${i.description}${i.notes?` (${i.notes})`:""}`).join(", ");
    setRawInput(raw);
    setParsed({ items: (r.items||[]).map(i=>({...i})), jobRef:r.jobRef||"", urgency:"standard" });
    // Pre-select the suppliers it was sent to, and remember which contact each went to.
    const ids = (r.sentTo||[]).map(s=>s.id).filter(Boolean);
    setSelSup(ids);
    const cs = {};
    (r.sentTo||[]).forEach(st=>{
      const sup = suppliers.find(x=>x.id===st.id);
      if (sup) { const c = (sup.contacts||[]).find(c=>c.email===st.email) || (sup.contacts||[])[0]; if (c) cs[st.id]=c.id; }
    });
    setContactSel(cs);
    setSupSearch("");
    setRfqEmail(""); setRfqDocs([]); setEmailRes(null);
    setStep(2);
    setView("new");
    showToast(`Revising ${r.jobRef||r.id} - edit, then re-send`);
  }

  function handleDuplicate(r) {
    setEditingReqId(null);
    setJobRef(r.jobRef+" (copy)");
    setSite(r.site||"");
    setTrade(r.trade||"Plumbing");
    setDeliveryMethod(r.deliveryMethod||"direct");
    setDeliveryDate(r.deliveryDate||"");
    setAltAddress(r.altAddress||""); setCollectFrom(r.collectFrom||"");
    // Rebuild raw input from items
    const raw = (r.items||[]).map(i=>`${i.quantity} ${i.unit} of ${i.description}${i.notes?` (${i.notes})`:""}`).join(", ");
    setRawInput(raw);
    setParsed({ items: r.items.map(i=>({...i})), jobRef:r.jobRef+" (copy)", urgency:"standard" });
    setStep(2);
    setView("new");
    showToast("Request duplicated - review and send");
  }

  function handleSaveTemplate() {
    if (!parsed||!newTemplateName.trim()) return;
    const t = { id:`TPL-${Date.now()}`, name:newTemplateName.trim(), trade, items:parsed.items, created:new Date().toISOString().split("T")[0], usageCount:0 };
    saveTemplates([t,...templates]);
    setTemplateModal(false);
    setNewTemplateName("");
    showToast(`Template "${t.name}" saved`);
  }

  function handleLoadTemplate(t) {
    setEditingReqId(null);
    setTrade(t.trade||"Plumbing");
    setParsed({ items:(t.items||[]).map(i=>({...i})), jobRef:"", urgency:"standard" });
    setRawInput(t.items.map(i=>`${i.quantity} ${i.unit} of ${i.description}`).join(", "));
    // Increment usage count
    saveTemplates(templates.map(tp=>tp.id===t.id?{...tp,usageCount:(tp.usageCount||0)+1,lastUsed:new Date().toISOString().split("T")[0]}:tp));
    setStep(2);
    setTemplateModal(false);
    showToast(`Template "${t.name}" loaded`);
  }

  function resetNewRequest() {
    setStep(1); setRawInput(""); setParsed(null); setJobRef(""); setSite(""); setTrade("Plumbing"); setEditingReqId(null);
    setRfqEmail(""); setRfqDocs([]); setEmailRes(null); setSelSup([]); setContactSel({}); setSupSearch("");
    setDeliveryMethod("direct"); setDeliveryDate(""); setAltAddress(""); setCollectFrom(""); setRfqDeadline("");
    setInterim(""); setScanning(false);
    setLoading(false); setLoadMsg("");
    setAllAnalyses([]); setExpandedQuote(null);
  }

  // Supporting documents for the RFQ: site photos / layout drawings / specs sent to
  // suppliers for context. Not parsed into the materials list. Capped at 5 (Resend cap)
  // and ~8MB per file; images are compressed by fileToAttachment to keep the payload small.
  async function addRfqDocs(files) {
    const incoming = Array.from(files || []);
    if (!incoming.length) return;
    const room = 5 - rfqDocs.length;
    if (room <= 0) { showToast("You can attach up to 5 supporting documents.", "warn"); return; }
    const take = incoming.slice(0, room);
    if (incoming.length > room) showToast(`Only ${room} more file${room !== 1 ? "s" : ""} can be attached (max 5).`, "warn");
    const built = [];
    for (const f of take) {
      if (f.size > 8 * 1024 * 1024) { showToast(`"${f.name}" is too large (max 8MB).`, "warn"); continue; }
      try { built.push(await fileToAttachment(f)); }
      catch { showToast(`Couldn't read "${f.name}".`, "warn"); }
    }
    if (built.length) setRfqDocs(p => [...p, ...built]);
  }


  function handleFinalise() {
    if (parsed) {
      const r = {
        id:`RFQ-${Date.now().toString().slice(-6)}`,
        jobRef:jobRef||"TBC", site:site||"Site TBC", trade,
        status: "draft",
        created: new Date().toISOString().split("T")[0],
        items: parsed.items,
        activity:[{ ts:new Date().toISOString(), action:"Saved as draft", detail:"No emails sent", user:settings.contactName||"You" }]
      };
      setRequests(p=>[r,...p]);
      showToast("Saved as draft");
    }
    resetNewRequest();
    setView("dashboard");
  }

  async function handleAnalyse() {
    if (!quoteInput.trim()||!activeReq) return;
    if (!AI_VIA_SERVER && !settings.openRouterKey) { showToast("AI is temporarily unavailable. Please try again shortly.","warn"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setLoading(true); setLoadMsg("Analysing quote...");
    try {
      const supplierName = suppliers.find(s=>selSup.includes(s.id))?.name || quoteSupplierName || "Supplier";
      const a = await analyseQuote(activeReq.items, quoteInput, supplierName);
      setQuoteAnalysis(a);
      if (!a.error) {
        const entry = { ts:new Date().toISOString(), action:"Quote analysed", detail:`Completeness: ${a.completeness}%`, user:settings.contactName||"You" };
        setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,status:"received",activity:[...(r.activity||[]),entry]}:r));
      }
    } catch(e) { showToast("AI error: "+e.message,"warn"); }
    setLoading(false);
  }

  async function handleAnalyseAll() {
    if (!activeReq) return;
    const toAnalyse = (activeReq.sentTo||[]).filter(s=>s.quote&&s.quote.trim());
    if (!toAnalyse.length) return;
    if (!AI_VIA_SERVER && !settings.openRouterKey) { showToast("AI is temporarily unavailable. Please try again shortly.","warn"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setLoading(true);
    const results = [];
    for (let i=0; i<toAnalyse.length; i++) {
      const sup = toAnalyse[i];
      setLoadMsg(`Analysing ${sup.name} (${i+1} of ${toAnalyse.length})...`);
      try {
        const a = await analyseQuote(activeReq.items, sup.quote, sup.name);
        if (!a.error) results.push({...a, supplierName:a.supplierName||sup.name, _id:sup.id});
      } catch(e) { showToast(`Error analysing ${sup.name}: ${e.message}`,"warn"); }
    }
    setAllAnalyses(results);
    if (results && results.length) meter("quotesAnalysed", results.length);
    setApprovedQuoteId(null);
    if (results.length>0) setExpandedQuote(results[0]._id);
    // Save/update this analysis as a persistent quote set
    if (results.length>0) {
      const setObj = {
        id: `QS-${activeReq.id}`,
        reqId: activeReq.id,
        jobRef: activeReq.jobRef||"",
        trade: activeReq.trade||"",
        site: activeReq.site||"",
        items: activeReq.items||[],
        analyses: results,
        createdAt: new Date().toISOString(),
        status: "analysed",
        approvedId: null
      };
      setSavedQuoteSets(prev => [setObj, ...prev.filter(s=>s.id!==setObj.id)]);
    }
    logActivity("Quotes analysed",`${results.length} supplier quote${results.length!==1?"s":""} analysed for ${activeReq.jobRef}`,{entity:"quote",reqId:activeReq.id,jobRef:activeReq.jobRef});
    if (results.length>0) {
      const entry = { ts:new Date().toISOString(), action:"AI analysis run", detail:`${results.length} quote${results.length!==1?"s":""} analysed`, user:settings.contactName||"You" };
      setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,status:"received",activity:[...(r.activity||[]),entry]}:r));
      setActiveReq(prev=>({...prev,status:"received"}));
      // Auto-save all quotes to library
      results.forEach(qa => saveToLibrary(qa, activeReq.id, activeReq.jobRef, activeReq.site, activeReq.trade));
    }
    setLoading(false);
    showToast(`Analysis complete - ${results.length} quote${results.length!==1?"s":""} saved to library`);
  }

  async function handleApprovePO(qa) {
    const analysis = qa || quoteAnalysis;
    // Permission: only Buyer and above can approve POs
    if (!can.approvePO(myRole)) {
      showToast("Only a Buyer or Manager can approve purchase orders.","warn");
      setApproveConfirm(null);
      return;
    }
    // Manager-approval workflow: if the company requires it, a Buyer's PO needs a Manager to sign off.
    if (settings.requirePoApproval && roleRank(myRole) < 3) {
      const note = { ts:new Date().toISOString(), action:"PO submitted for approval", detail:`${analysis?.supplierName||"Supplier"} - awaiting Manager approval`, user:myEmail };
      setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,status:"awaiting-approval",pendingApproval:{supplierName:analysis?.supplierName||"",total:analysis?.estimatedTotal||analysis?.subtotal||"",analysisId:qa?._id||null,by:myEmail,ts:new Date().toISOString()},activity:[...(r.activity||[]),note]}:r));
      setActiveReq(prev=>({...prev,status:"awaiting-approval"}));
      logActivity("PO awaiting approval", `${activeReq?.jobRef||activeReq?.id} - ${analysis?.supplierName||"supplier"} submitted by ${myEmail}`, { entity:"request", reqId:activeReq?.id });
      setApproveConfirm(null);
      showToast("Sent to a Manager for approval");
      return;
    }
    // Guard: prevent approving a second quote for a request that already has an approved PO
    const existingApproved = activeReq && (activeReq.status==="approved" || orders.some(o=>o.reqId===activeReq.id));
    if (existingApproved) {
      showToast("This request already has an approved PO. Undo it first to choose a different supplier.","warn");
      setApproveConfirm(null);
      return;
    }
    const sup = suppliers.find(s=>s.name===analysis?.supplierName) || suppliers[0];
    // Prefer the exact contact this quote came in from (the one we emailed the RFQ to),
    // so the PO goes back to the right person; fall back to the supplier's primary email.
    const _sentEntry = (activeReq?.sentTo||[]).find(st=>st.name===(analysis?.supplierName||sup?.name));
    const poEmail = (_sentEntry&&_sentEntry.email) || sup?.email || "";
    const poNum = `PO-${Date.now().toString().slice(-6)}`;
    const dateStr = new Date().toLocaleDateString("en-GB");

    // Auto-save all OTHER quotes to library before approving
    const otherQuotes = allAnalyses.filter(a=>a._id!==qa._id);
    otherQuotes.forEach(a=>{
      const libEntry = {
        id:`QL-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        savedAt:new Date().toISOString(),
        expiryDate: new Date(Date.now()+(settings.quoteValidityDays||30)*24*3600000).toISOString(),
        reqId:activeReq.id, jobRef:activeReq.jobRef, site:activeReq.site, trade:activeReq.trade,
        supplierName:a.supplierName, completeness:a.completeness,
        totalEstimate:a.estimatedTotal||a.subtotal||"",
        carriageCharge:a.carriageCharge||"", leadTime:a.leadTime||"",
        items:a.matched||[], missing:a.missing||[], warnings:a.warnings||[],
        overallVerdict:a.overallVerdict||"", autoSaved:true,
      };
      setQuoteLibrary(prev=>{ const n=[libEntry,...prev].slice(0,500); try{localStorage.setItem("piq_quote_library",JSON.stringify(n));}catch{} return n; });
    });

    await generatePO({ poNumber:poNum, jobRef:activeReq?.jobRef, site:activeReq?.site, supplier:sup, items:activeReq?.items||[], analysis, company:settings.company||"Your Company", contactName:settings.contactName||settings.company||"Your Company", contactEmail:settings.fromEmail||"", date:dateStr });

    const doc = { id:poNum, type:"generated", label:`PO ${poNum}`, supplier:sup?.name||"", supplierEmail:poEmail, date:dateStr, status:"approved" };
    const poEntry = {
      ts:new Date().toISOString(),
      action:"PO approved & generated",
      detail:`PO ${poNum} - ${sup?.name||"supplier"} - Est. ${analysis?.estimatedTotal||"-"} - ${otherQuotes.length} other quote${otherQuotes.length!==1?"s":""} auto-saved to library`,
      user:settings.contactName||"You"
    };
    setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,status:"approved",pendingApproval:null,documents:[...(r.documents||[]),doc],activity:[...(r.activity||[]),poEntry]}:r));
    setActiveReq(prev=>({...prev,status:"approved",documents:[...(prev.documents||[]),doc]}));
    setApprovedQuoteId(qa?._id||null);
    setSavedQuoteSets(prev => prev.map(s => s.reqId===activeReq.id ? {...s, status:"approved", approvedId:qa?._id||null, analyses:allAnalyses.length?allAnalyses:s.analyses} : s));
    // Clear the active in-progress view so the page shows the saved list
    setTimeout(()=>{ setActiveReq(null); setAllAnalyses([]); setExpandedQuote(null); }, 1200);
    logActivity("PO approved & generated",`${poNum} - ${sup?.name||"supplier"} - Est. ${analysis?.estimatedTotal||"-"} (${otherQuotes.length} other quote${otherQuotes.length!==1?"s":""} saved to library)`,{entity:"order",reqId:activeReq.id,jobRef:activeReq.jobRef});meter("posRaised");meter("posMaterials");

    // Remove other quotes from the analysis view
    setAllAnalyses([qa]);

    const order = {
      id:poNum, reqId:activeReq.id,
      jobRef:activeReq?.jobRef||"TBC", site:activeReq?.site||"", trade:activeReq?.trade||"",
      supplier:sup?.name||"", supplierEmail:poEmail,
      items:activeReq?.items||[], analysis, poNumber:poNum, poDate:dateStr,
      estimatedTotal: analysis?.estimatedTotal || analysis?.subtotal || "",
      status:"pending-send", type:"generated", label:`PO ${poNum}`,
      deliveryMethod:activeReq?.deliveryMethod||"", deliveryDate:activeReq?.deliveryDate||"", collectFrom:activeReq?.collectFrom||"",
      notes:"",
      activity:[{ ts:new Date().toISOString(), action:"Order created", detail:`PO ${poNum} approved - ${sup?.name||"supplier"} - ${analysis?.estimatedTotal||"-"}`, user:settings.contactName||"You" }]
    };
    setOrders(p=>[order,...p]);

    // Show success state
    setApproveConfirm(null);
    setApproveSuccess({ poNum, supplier:sup?.name||"", reqId:activeReq.id, jobRef:activeReq.jobRef, estimatedTotal:analysis?.estimatedTotal||"" });
  }

  function handleUndoApproval() {
    if (!activeReq) return;
    setApprovedQuoteId(null);
    setRequests(p=>p.map(r=>r.id===activeReq.id?{
      ...r,
      status:"received",
      documents:(r.documents||[]).filter(d=>d.type!=="generated"||d.id!==r.documents?.slice(-1)[0]?.id),
      activity:[...(r.activity||[]),{ ts:new Date().toISOString(), action:"Approval undone", detail:"PO approval reversed", user:settings.contactName||"You" }]
    }:r));
    // Remove from orders
    setOrders(p=>p.filter(o=>o.reqId!==activeReq.id||o.status==="sent"||o.status==="acknowledged"));
    setActiveReq(prev=>({...prev,status:"received"}));
    // Revert the saved quote set back to "analysed" so it no longer shows as approved
    setSavedQuoteSets(prev=>prev.map(s=>s.reqId===activeReq.id?{...s,status:"analysed",approvedId:null}:s));
    logActivity("Approval undone",`PO approval reversed for ${activeReq.jobRef||activeReq.id}`,{entity:"quote",reqId:activeReq.id});
    showToast("Approval undone - you can re-approve a different quote");
  }

  async function handleHelpChat(question) {
    if (!question.trim()) return;
    if (!AI_VIA_SERVER && !settings.openRouterKey) { showToast("AI is temporarily unavailable. Please try again shortly.","warn"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    const userMsg = {role:"user",content:question};
    setHelpMessages(p=>[...p,userMsg]);
    setHelpInput("");
    setHelpLoading(true);
    const sys = `You are the ProQure AI assistant. ProQure is an AI-powered procurement platform for UK trades contractors (plumbing, HVAC, electrical, mechanical, ventilation). You help users understand and use every part of the platform. Be concise, friendly, and accurate.

COMPLETE FEATURE REFERENCE (you can explain how to do all of these):

CREATING A REQUEST (New request page, 3 steps):
- Three ways to add materials: (1) Voice - tap the mic and speak your list, it transcribes live then you review and tap Proceed; (2) Type the list in plain English and tap Proceed; (3) Scan a document - photograph a scope of works, delivery note or handwritten list, or upload a PDF/image; vision AI extracts the items. (4) Import a materials spreadsheet - upload a CSV with description/quantity/unit columns and it imports instantly with no AI needed.
- After parsing, every item is editable (description, quantity, unit, category). Add/remove rows freely.
- Step 2: set an optional response deadline, choose delivery method (if 'Collect', name the branch to collect from, e.g. "Plumb Centre, Geldard Road"), add request notes, and pick which suppliers to send to. The trade is auto-detected from the items and pre-selects matching suppliers; there is a search box for long supplier lists, and for any supplier with several contacts you choose which contact the request goes to. You can also load a saved template.
- Duplicate detection warns if a similar request for the same job already exists.
- Step 3: review the auto-generated RFQ email and send it to all selected suppliers at once.

QUOTE ANALYSIS:
- Pick a request from the left, paste each supplier's quote into their box, or drag/drop a PDF/Excel file to auto-extract.
- Tap Analyse all quotes. The AI runs a 3-stage analysis (extract, match to your request, synthesise) plus a JavaScript maths-validation layer that recalculates every total.
- Each supplier gets a completeness score (shown in a circular ring), a verdict, estimated total, matched items, missing items, warnings and positives. Cards are collapsible - tap to expand.
- Two views via the Cards/Compare toggle: Cards (one expandable card per supplier) and Compare (side-by-side table, one row per item, lowest price badged automatically).
- Markup calculator: enter a markup % to see cost vs sell price for each supplier.
- Print/Export button opens a print-friendly view (use Save as PDF).
- Approve a quote to generate a PO; all other quotes auto-save to the library. Undo is available.

SUPPLIER REPLY CAPTURE (automatic): When a supplier replies to an RFQ email, their reply is captured automatically and dropped straight into that supplier's quote box, ready to analyse - no copy-pasting. Only the supplier's new text is kept (the quoted-back request and email signatures are stripped out). A copy of every reply is also forwarded to the user's own inbox so nothing is missed. Each RFQ email includes a short line asking suppliers to reply to it - that is what keeps replies tracked. Note: if a supplier ignores the request and sends a brand-new separate email instead, that will not auto-file against the job - it simply arrives in the normal inbox like any email (nothing is lost). Smart matching of those stray emails to the right job is on the roadmap.

ORDERS (status timeline: Ready to send > Sent > Confirmed > Delivered):
- Cards are collapsible - tap any order to expand it.
- Send the PO email to the supplier (needs a Resend key). Add a note and expected delivery date first.
- When Sent: either tap Mark as confirmed / Mark as delivered manually, OR upload the supplier's confirmation document. Both options work.
- Filter by All / Active / Delivered. Export orders to CSV.

QUICK PO (emergency / phone orders): For when an engineer or buyer agrees a price with a supplier on the phone and needs a PO raised immediately, bypassing the full RFQ-and-quote process. There is a 'Quick PO' button on the Orders page and the dashboard quick actions (Buyers and Managers only - engineers cannot raise POs). It opens a form: pick an existing supplier OR add a new one on the spot, enter the item(s) and the phone-agreed price (itemised lines or just a description and total - either works), and generate. It creates a proper numbered PO straight into Orders for normal delivery sign-off, skips manager approval (because it is an emergency), and is logged in the audit trail as a direct/phone order. Suppliers added this way are saved tagged 'Ad-hoc' (vs your established 'Approved' suppliers) and show an amber Ad-hoc badge on the Suppliers page; after a supplier has been used 5 times (any use - PO or quote) you are prompted to promote them to an Approved supplier.

HIRE (plant & tool hire): A dedicated Hire tab tracks hired equipment through its whole life, because hire is different from materials - it comes and goes back, and you are liable while it is on site. Raise a hire (Buyers/Managers) by describing the equipment, picking/adding a supplier, and setting site, job ref, weekly rate, expected delivery and a return/collection date (or tick 'open hire' if the return date is unknown). It appears on the Hire log showing the hire reference, supplier, site, weeks-on-hire, running cost (from the weekly rate, visible to cost-viewers) and return date; overdue items flag red. Lifecycle: (1) Mark delivered - take/attach a photo of how it arrived (protects you in damage/missing-part disputes) and add a condition note; it goes On hire. (2) The dashboard shows a reminder when hires are due back within a week, overdue, or have been on open hire 3+ weeks - prompting Extend or Off-hire. (3) Off-hire - emails the supplier requesting collection with a required date and collection address, and lets the engineer add a second photo of where the kit was left on site (useful when they are not there at collection). (4) Close - enter the supplier's collection/off-hire reference to close the hire and stop the clock. A summary strip shows how many items are on hire, across how many sites, and how many are due back this week. Hires count toward total POs raised, tracked separately as 'hire' vs 'materials' in the workspace stats.

LIBRARY: every non-approved quote auto-saves here with a 30-day expiry (configurable). Shows supplier scorecards (avg completeness), price history, expiry badges. Export to CSV.

SUPPLIERS: manage supplier accounts; each shows RFQ count, response rate, average completeness and PO win count.

SAVED QUOTES: the Quotes page keeps every analysis you run as a saved collapsible card (like the Orders page). After you approve a quote and the order is created, that analysis moves into the saved list automatically; you can re-open any past analysis in full at any time, and it survives a page refresh. When pasting a supplier quote into a box, it turns green and shows 'Quote entered'.
ACTIVITY LOG: the dashboard shows a Recent activity feed logging every action across the app - RFQs sent, quotes analysed, POs approved, orders sent/confirmed/delivered, confirmations uploaded, suppliers added, library changes. Each request also keeps its own activity history (open it from All Requests). DASHBOARD CHARTS: a Spend by trade bar chart appears automatically once you have orders. SUPPLIER QUICK-ADD: on the request wizard supplier step you can add a new supplier inline with '+ Add a supplier' without leaving the page. SUPPLIERS PAGE: each supplier can hold multiple named contacts (each with their own email address) and named branches/depots. Tap Edit on a supplier card to add or change its contacts and branches. When you send an RFQ you choose which contact it goes to, and the supplier picker has a search box for long lists. LIBRARY: you can remove a quote from the library with the bin icon on its row.
OTHER: dark/light theme toggle; keyboard shortcuts (N new, Q quotes, O orders, D dashboard, S settings, H help, ? shows the shortcut list); company branding (logo upload, default PO terms, quote validity days) in Settings - the logo appears on HTML emails; quote expiry warnings on the dashboard; CSV export on library/orders/requests; All Requests has search and status/trade filters; click the ProQure logo to return to the dashboard.
RFQ REVISIONS: a sent request can be revised and re-sent. On All Requests, tap 'Revise' on a sent request (Buyers/Managers) - it reopens in the wizard with everything pre-filled and the original suppliers/contacts selected. Edit anything, then re-send: it updates the SAME request (bumps the version, e.g. v2), re-sends to the chosen suppliers and resets their quote boxes for the new revision, rather than creating a duplicate.
AUTOCOMPLETE: the Job reference and Site fields suggest values from your past requests as you type; the alternative-address field suggests past addresses; and the Collect-from field suggests your suppliers' branches plus places you've collected from before.

O&M FILES (Operations & Maintenance manuals): On the 'O&M files' tab (Buyers/Managers) ProQure turns a project's procured materials into a presented O&M pack as a PDF - cover, contents, equipment schedule (with a separate spares & consumables list), manufacturer literature/datasheets, and planned preventative maintenance (PPM) schedules with their governing standards. Pick a project and tap Generate O&M. Two options: 'find datasheet links online' (searches each manufacturer for the exact datasheet; this uses metered web search, and is off by default) and 'also export sections separately' (download Literature and Maintenance as their own PDFs alongside the combined pack). The equipment grouping and PPM schedules are AI-drafted from the materials and clearly marked for sign-off - always review before issuing to a client.\n\nREPORTS (spend reporting): On the 'Reports' tab (Buyers/Managers) ProQure shows where the money is going - total spend, order count, projects and suppliers - with breakdowns of spend by trade, by supplier and by month, plus an Export CSV button. The 'By project' tab is the manager/boss view: pick any project to see its overall cost broken down across every trade and supplier on it.\n\nMEASURE (materials estimator): On the 'Measure' tab (everyone) enter an area (or a length x height) and pick a material, and ProQure works out how much to order and how many packs, using standard UK coverage rates and applying a wastage allowance, and showing the assumptions it made. You can also tick 'specific product' and have it look up the manufacturer's datasheet for the exact coverage rate (uses web search). And the 'From a drawing' mode lets you upload a scaled PDF/image drawing for a full materials take-off you can edit and turn into a request. Walking a room with the camera is coming with the native app.\n\nSUPPLIER CATALOGUES: On the 'Catalogues' tab (everyone) a user can upload a supplier's product catalogue (PDF, image or CSV) and ProQure reads it with AI into a private, searchable index of products - description, part/product number, manufacturer, pack and any printed datasheet link. Search by product, part number or supplier, then add items straight onto a new request, or open the datasheet link. Catalogues are private to the company (not shared with other companies). If a product isn't in the user's own catalogues, 'Find online' does a metered web search for the product and its official manufacturer datasheet (this uses the catalogue online-lookup allowance, like Measure/O&M web search). ProQure indexes products and keeps datasheet links rather than re-hosting supplier files.\n\nSETUP & ACCOUNTS: AI and email are fully managed for the user - there are NO API keys to enter anywhere. Never tell a user to get or paste an OpenRouter, Resend, or any other API key; that is handled centrally and the key fields no longer exist. Users sign in with email and password; their data is stored securely in the cloud against their login and syncs across all their devices. Everyone in a company shares one live view. The only one-off technical step is that the company domain needs DNS records added so ProQure can send email from the company address - this is done once by whoever manages the domain (IT/web person), not by everyday users.\n\nACCOUNTS, FREE TRIAL & GETTING SET UP: ProQure starts as a free trial - there is no card or payment needed to begin. A business gets started from the ProQure website by tapping 'Get your licence'. You then receive an email, click the link, set a password, then complete a short onboarding (company name, your contact details, main trade, team size, address, and the email address you want quotes and POs to be sent from). The first person to set a company up becomes its Manager, and each company's data is completely separate and private to that company. To bring colleagues in, a Manager opens the team settings and invites them by email as a Buyer or an Engineer; the invited person gets an email, clicks it, sets their own password, and joins the same shared workspace. If an invite email does not arrive, that person can use 'Forgot password' on the sign-in screen to set a password and still get in. There are never any API keys for anyone to enter - AI and email are managed centrally.

TEAMS & ROLES (three roles, high to low: Manager, Buyer, Engineer): The workflow has a clear separation of duties. ENGINEERS raise the materials list (using the AI to parse it) and add notes for the buyer, then issue it - they do NOT see quote prices, costs, spend totals, or jobs that are not their own, and they cannot send RFQs or raise purchase orders. Engineers can later upload a photo of the delivery note and sign off delivery in the Orders tab. BUYERS get notified when an engineer issues a list; they send the RFQ to suppliers, handle the returned quotes, and raise the purchase order (a manager can require manager approval for POs - this is set during setup and can be changed in Settings). Buyers can also raise the materials list themselves if needed. MANAGERS have full access to everything, manage the team (invite by email, assign roles, up to their own level) and edit settings. The first Manager is the top account holder and cannot be removed if they are the last one. There is a first-run guided tour and a Send feedback button in the menu.

GETTING STARTED: brand-new users see a Welcome card on the dashboard with three quick steps (create a request, send to suppliers, analyse & approve) and a button to begin; it disappears once they have any activity. The app works on any device - on a phone it switches to a mobile layout with a bottom tab bar, and you can use the camera to scan documents on site. It has a polished dark and light mode, keyboard shortcuts, smooth animations, and is built to feel calm and professional throughout.

If asked about something ProQure does not do, say so clearly and mention if it is on the roadmap. Already built and available now: cloud sync across devices, multi-user team accounts with roles and permissions, Quick PO for emergency orders, full plant/tool hire tracking with photos, automatic deadline/return reminders on the dashboard, automatic capture of supplier email replies straight into the quote box, per-project O&M manual generation, company-wide spend reporting (by trade, supplier, project and month) with a cross-trade project view, and a materials measuring tool that also reads a scaled PDF/image drawing into an editable materials take-off and can look up a specific product's datasheet coverage rate. The current roadmap (not yet built): a native mobile app with camera room-scanning for on-site measuring; AI reading of hire delivery photos to auto-note condition; hire-vs-buy suggestions based on hire history; smart matching of stray supplier emails to the right job; and accounting integrations (Xero/Sage). If asked when these arrive, say they are planned for future updates. Answer in 2-4 sentences unless a step-by-step is genuinely needed - then use short numbered steps.`;
    const history = [...helpMessages,userMsg].slice(-10).map(m=>({role:m.role,content:m.content}));
    try {
      const raw = await callAI(sys, question, history);
      setHelpMessages(p=>[...p,{role:"assistant",content:raw}]);
    } catch(e) { setHelpMessages(p=>[...p,{role:"assistant",content:"Sorry, I couldn't process that. Please try again."}]); }
    setHelpLoading(false);
  }

  async function handleSaveDraftQuote(qa) {
    const poNum = `DRAFT-${Date.now().toString().slice(-6)}`;
    const dateStr = new Date().toLocaleDateString("en-GB");
    const sup = suppliers.find(s=>s.name===qa?.supplierName) || {name:qa?.supplierName||"Supplier"};
    await generatePO({ poNumber:poNum, jobRef:activeReq?.jobRef, site:activeReq?.site, supplier:sup, items:activeReq?.items||[], analysis:qa, company:settings.company||"Your Company", contactName:settings.contactName||settings.company||"Your Company", contactEmail:settings.fromEmail||"", date:dateStr });
    const doc = { id:poNum, type:"draft", label:`Draft - ${sup.name}`, supplier:sup.name, date:dateStr, status:"draft" };
    const entry = { ts:new Date().toISOString(), action:"Draft quote saved", detail:`Draft PDF saved for ${sup.name} - not yet approved`, user:settings.contactName||"You" };
    setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,documents:[...(r.documents||[]),doc],activity:[...(r.activity||[]),entry]}:r));
    setActiveReq(prev=>({...prev,documents:[...(prev.documents||[]),doc]}));
    showToast(`Draft saved for ${sup.name}`);
    logActivity("Draft PO saved",`Draft for ${sup.name} - ${activeReq?.jobRef||""}`,{entity:"quote",jobRef:activeReq?.jobRef});
  }

  function handleUploadDocument(file) {
    if (!file||!activeReq) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const doc = {
        id:`UPLOAD-${Date.now()}`,
        type:"uploaded",
        label:file.name,
        supplier:"",
        date:new Date().toLocaleDateString("en-GB"),
        status:"uploaded",
        dataUrl: e.target.result,
        fileType: file.type,
        fileSize: `${(file.size/1024).toFixed(1)} KB`
      };
      const entry = { ts:new Date().toISOString(), action:"Document uploaded", detail:`${file.name} (${doc.fileSize}) uploaded`, user:settings.contactName||"You" };
      setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,documents:[...(r.documents||[]),doc],activity:[...(r.activity||[]),entry]}:r));
      setActiveReq(prev=>({...prev,documents:[...(prev.documents||[]),doc]}));
      showToast(`${file.name} uploaded to job`);
    };
    reader.readAsDataURL(file);
  }

  function handleCreateOrderFromDoc(doc, req) {
    if (!doc||!req) return;
    const sup = suppliers.find(s=>req.sentTo?.some(st=>st.name===s.name))||{name:doc.supplier||"Supplier",email:""};
    const _sentEntry = (req.sentTo||[]).find(st=>st.name===(doc.supplier||sup.name)) || (req.sentTo||[]).find(st=>st.name===sup.name);
    const supplierEmail = (_sentEntry&&_sentEntry.email) || sup.email || "";
    const order = {
      id: doc.id,
      reqId: req.id,
      jobRef: req.jobRef||"TBC",
      site: req.site||"",
      trade: req.trade||"",
      supplier: doc.supplier||sup.name||"",
      supplierEmail: supplierEmail,
      items: req.items||[],
      poNumber: doc.id,
      poDate: doc.date,
      status: "pending-send",
      type: doc.type,
      label: doc.label,
      dataUrl: doc.dataUrl||null,
      deliveryMethod: req.deliveryMethod||"",
      deliveryDate: req.deliveryDate||"",
      notes: "",
      activity: [{ ts:new Date().toISOString(), action:"Order created from uploaded document", detail:doc.label, user:settings.contactName||"You" }]
    };
    setOrders(p=>[order,...p.filter(o=>o.id!==doc.id)]);
    showToast(`${doc.label} added to Orders`);
  }

  async function handleSendOrder(order) {
    if (!EMAIL_VIA_SERVER && !settings.resendKey) { showToast("Email is temporarily unavailable. Please try again shortly.","warn"); return; }
    if (!order.supplierEmail) { showToast("No supplier email on this order - edit the order to add one","warn"); return; }
    setSendingOrder(order.id);
    const note = orderNote[order.id]||"";
    const subject = `Purchase Order ${order.poNumber} - ${order.jobRef}`;
    const deliveryLabels = { direct:"Delivery direct to site", alternative:"Delivery to alternative address", collect:`Collection${order.collectFrom?` from ${order.collectFrom}`:" from branch"}`, tbc:"Delivery method to be confirmed" };
    const body = `Dear ${order.supplier},

Please find attached Purchase Order ${order.poNumber} for job reference ${order.jobRef}.

${order.site?`Site: ${order.site}`:""}
${order.deliveryMethod?`Delivery method: ${deliveryLabels[order.deliveryMethod]||order.deliveryMethod}`:""}
${order.deliveryDate?`Required by: ${new Date(order.deliveryDate).toLocaleDateString("en-GB")}`:""}

${note?`Additional notes:
${note}
`:""}
Please confirm receipt of this order and advise of any issues with availability or delivery timescales.

Kind regards
${settings.contactName||settings.company||"The Procurement Team"}
${settings.company||""}`;

    // Build a downloadable PO PDF and attach it (Andy: email must carry the PO).
    let attachments;
    try {
      const deliveryText = order.deliveryMethod
        ? (deliveryLabels[order.deliveryMethod]||order.deliveryMethod) + (order.deliveryMethod==="direct"&&order.site?`: ${order.site}`:"")
        : (order.site?`Deliver to site: ${order.site}`:"");
      const b64 = await generatePO({
        poNumber: order.poNumber, jobRef: order.jobRef, site: order.site,
        supplier: { name: order.supplier, email: order.supplierEmail },
        items: order.items||[], analysis: order.analysis||null,
        company: settings.company||"Your Company",
        contactName: settings.contactName||settings.company||"",
        contactEmail: settings.fromEmail||"",
        date: new Date().toLocaleDateString("en-GB"),
        deliveryText,
        requiredBy: order.deliveryDate?new Date(order.deliveryDate).toLocaleDateString("en-GB"):"",
        invoiceEmail: settings.fromEmail||settings.replyToEmail||"",
        logoBase64: settings.logoBase64||"",
        totalOverride: order.total!=null?order.total:orderTotal(order),
        output: "base64"
      });
      if (b64) attachments = [{ filename:`PO-${order.poNumber}.pdf`, content:b64 }];
    } catch(e) { /* PDF is best-effort; email still sends */ }

    try {
      const res = await fetch("/api/send-email", {
        method:"POST",
        headers:{"Content-Type":"application/json", ...(await authHeaders())},
        body: JSON.stringify({ ...(()=>{const s=buildSender("orders",settings);return {from:s.from, reply_to:s.replyTo||undefined};})(), company_id: cloudUserId, to:[order.supplierEmail], subject, text:body, html:buildEmailHtml(body, settings), ...(attachments?{attachments}:{}) })
      });
      const d = await res.json();
      if (res.ok && d.success) {
        const entry = { ts:new Date().toISOString(), action:"Order sent to supplier", detail:`Sent to ${order.supplierEmail}`, user:settings.contactName||"You" };
        setOrders(p=>p.map(o=>o.id===order.id?{...o,status:"sent",sentAt:new Date().toISOString(),activity:[...(o.activity||[]),entry]}:o));
        showToast(`Order sent to ${order.supplier}`);
        logActivity("Order sent",`${order.poNumber} emailed to ${order.supplier}`,{entity:"order",jobRef:order.jobRef});
      } else {
        showToast(`Send failed: ${d.error||"Unknown error"}`,"warn");
      }
    } catch(e) { showToast(`Send failed: ${e.message}`,"warn"); }
    setSendingOrder(null);
  }

  const isMobile = useIsMobile();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [tourStep, setTourStep] = useState(()=>{ try{ return localStorage.getItem("piq_tour_done")==="1" ? -1 : 0; }catch{ return -1; } });
  const dismissTour = () => { try{localStorage.setItem("piq_tour_done","1")}catch{} setTourStep(-1); };
  const tourBase = [
    { title:"Welcome to ProQure", body:"A quick 30-second tour so you know your way around. You can skip anytime.", icon:"rocket" },
    { title:"Create a request", body:"Tap New request to list the materials you need. You can type, dictate, scan a document, or paste a spreadsheet - the AI turns it into a tidy request.", icon:"clipboard" },
    { title:"Send to suppliers", body:"ProQure drafts a branded email to your chosen suppliers asking them to quote. No copy-paste needed.", icon:"send" },
    { title:"Let the AI analyse quotes", body:"Paste or upload the quotes that come back. The AI checks the maths, compares suppliers and highlights the best value - and flags anything you should double-check.", icon:"search" },
  ];
  const tourRoleStep = can.approvePO(myRole)
    ? { title:"Approve with confidence", body:"When you're happy, approve a quote and ProQure generates the purchase order automatically. Always confirm the figures first.", icon:"check_circle" }
    : { title:"Your part in the flow", body:"You raise requests and review quotes. A Buyer or Manager approves the final purchase order, and you can track delivery in Orders.", icon:"truck" };
  const tourManageStep = can.manageTeam(myRole)
    ? [{ title:"Manage your team", body:"Head to the Team page to invite colleagues and set their roles - Engineers raise requests, Buyers approve, Managers run the team.", icon:"building" }]
    : [];
  const tourSteps = [...tourBase, tourRoleStep, ...tourManageStep];
  const [quoteViewMode, setQuoteViewMode] = useState("cards");
  const [marginPct, setMarginPct] = useState(0);
  const [reqFilterStatus, setReqFilterStatus] = useState("all");
  const [reqFilterTrade, setReqFilterTrade] = useState("all");
  const [reqSearch, setReqSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [cancelOrderConfirm, setCancelOrderConfirm] = useState(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [trialResetConfirm, setTrialResetConfirm] = useState(false);
  const [showPoSetup, setShowPoSetup] = useState(false);
  // Quick PO (emergency direct PO) - skips the RFQ/quote flow for phone-agreed orders
  const [quickPO, setQuickPO] = useState(null); // null = closed; object = form open
  const [promotePrompt, setPromotePrompt] = useState(null); // ad-hoc supplier promotion prompt
  // Hire modals
  const [hireForm, setHireForm] = useState(null);
  const [deliverModal, setDeliverModal] = useState(null);
  const [offHireModal, setOffHireModal] = useState(null);
  const [closeHireModal, setCloseHireModal] = useState(null);
  const [extendModal, setExtendModal] = useState(null);
  const [hireBuyTips, setHireBuyTips] = useState([]);
  const [darkMode, setDarkMode] = useState(()=>{ try{return localStorage.getItem("piq_dark")==="1"}catch{return false} });
  const toggleDark = () => setDarkMode(p=>{ const n=!p; try{localStorage.setItem("piq_dark",n?"1":"0");}catch{} return n; });
  // Keep the page (html/body) background in sync with the theme so no white edges show
  useEffect(() => {
    const pageBg = darkMode ? "#16161A" : "#FAFAF8";
    document.documentElement.style.background = pageBg;
    document.body.style.background = pageBg;
    document.body.style.margin = "0";
  }, [darkMode]);

  // -- Persist to localStorage --
  useEffect(()=>{ try{localStorage.setItem("piq_requests",JSON.stringify(requests))}catch{} },[requests]);
  useEffect(()=>{ try{localStorage.setItem("piq_orders",JSON.stringify(orders))}catch{} },[orders]);
  useEffect(()=>{ try{localStorage.setItem("piq_suppliers",JSON.stringify(suppliers))}catch{} },[suppliers]);
  useEffect(()=>{ try{localStorage.setItem("piq_hires",JSON.stringify(hires))}catch{} },[hires]);
  useEffect(()=>{ try{localStorage.setItem("piq_activity",JSON.stringify(activityLog.slice(0,500)))}catch{} },[activityLog]);
  useEffect(()=>{ try{localStorage.setItem("piq_quote_sets",JSON.stringify(savedQuoteSets.slice(0,100)))}catch{} },[savedQuoteSets]);
  useEffect(()=>{ try{localStorage.setItem("piq_usage",JSON.stringify(usage))}catch{} },[usage]);
  useEffect(()=>{ try{localStorage.setItem("piq_team",JSON.stringify(team))}catch{} },[team]);

  // --- Cloud push: mirror changes up to Supabase (debounced) ----------------
  const pushTimers = useRef({});
  // Becomes true shortly after the initial load. Until then we DON'T push, so simply
  // opening the app never echoes freshly-loaded (or stale) data back up to the cloud
  // and clobbers it. Genuine user edits after load sync normally.
  const hydratedRef = useRef(false);
  const queueCloudPush = useCallback((key, valueObj) => {
    if (!cloudEnabled || !cloudUserId) return;
    if (!hydratedRef.current) return;
    clearTimeout(pushTimers.current[key]);
    pushTimers.current[key] = setTimeout(() => { cloudPush(cloudUserId, key, valueObj).catch(()=>{}); }, 800);
  }, [cloudUserId]);

  useEffect(()=>{ queueCloudPush("piq_requests", requests); }, [requests, queueCloudPush]);
  useEffect(()=>{ try{localStorage.setItem("piq_catalogues",JSON.stringify(catalogues))}catch{} },[catalogues]);
  useEffect(()=>{ queueCloudPush("piq_catalogues", catalogues); }, [catalogues, queueCloudPush]);
  useEffect(()=>{ queueCloudPush("piq_orders", orders); }, [orders, queueCloudPush]);
  useEffect(()=>{ queueCloudPush("piq_hires", hires); }, [hires, queueCloudPush]);
  // Compute hire-vs-buy suggestions (only for cost-viewers, only with enough history)
  useEffect(()=>{
    if (!can.viewCosts(myRole)) { setHireBuyTips([]); return; }
    const counts = {};
    hires.forEach(h=>{ const k=(h.description||"").toLowerCase().trim(); if(k) counts[k]=(counts[k]||0)+1; });
    const hasRepeat = Object.values(counts).some(n=>n>=3);
    if (!hasRepeat) { setHireBuyTips([]); return; }
    let active = true;
    aiHireVsBuy(hires).then(tips=>{ if(active) setHireBuyTips(tips||[]); }).catch(()=>{});
    return ()=>{ active=false; };
  }, [hires, myRole]);
  useEffect(()=>{ queueCloudPush("piq_suppliers", suppliers); }, [suppliers, queueCloudPush]);
  useEffect(()=>{ queueCloudPush("piq_settings", settings); }, [settings, queueCloudPush]);
  // One-time setup: ask a Manager whether buyers need approval to raise POs.
  useEffect(()=>{
    if (roleRank(myRole) >= 3 && !settings.poApprovalConfigured && tourStep < 0) {
      const t = setTimeout(()=>setShowPoSetup(true), 600);
      return ()=>clearTimeout(t);
    }
  }, [myRole, settings.poApprovalConfigured, tourStep]);
  useEffect(()=>{ queueCloudPush("piq_quote_library", quoteLibrary); }, [quoteLibrary, queueCloudPush]);
  useEffect(()=>{ queueCloudPush("piq_templates", templates); }, [templates, queueCloudPush]);
  useEffect(()=>{ queueCloudPush("piq_quote_sets", savedQuoteSets.slice(0,100)); }, [savedQuoteSets, queueCloudPush]);
  useEffect(()=>{ queueCloudPush("piq_usage", usage); }, [usage, queueCloudPush]);
  // Register the module-level AI usage recorder: every AI call increments this
  // company's spend/calls so the admin dashboard shows cost per company.
  useEffect(()=>{
    __usageRecorder = (cost, web)=> setUsage(u=>{
      const p = billingPeriod();
      const base = u.period === p ? u : { ...u, period:p, measureWebUsed:0, omWebUsed:0, catalogueWebUsed:0, addons:{}, costPeriod:0 };
      return {
        ...base, period:p,
        aiSpend: Number(((Number(base.aiSpend)||0) + (Number(cost)||0)).toFixed(6)),   // cumulative, all-time (admin telemetry)
        aiCalls: (Number(base.aiCalls)||0) + 1,
        webCalls: (Number(base.webCalls)||0) + (web ? 1 : 0),
        costPeriod: Number(((Number(base.costPeriod)||0) + (Number(cost)||0)).toFixed(6)), // THIS month only (circuit-breaker)
      };
    });
    return ()=>{ __usageRecorder = null; };
  }, [setUsage]);
  // Register the circuit-breaker gate: blocks AI once this month's spend hits the plan cap.
  useEffect(()=>{
    __budgetCheck = ()=>{
      const cap = (planOf(settings).aiBudget) || 0;
      if (cap <= 0) return true;
      const p = billingPeriod();
      const spentUsd = usage.period === p ? (Number(usage.costPeriod)||0) : 0;
      return spentUsd * USD_TO_GBP < cap; // costPeriod is USD (OpenRouter); cap is GBP
    };
    return ()=>{ __budgetCheck = null; };
  }, [usage, settings]);
  // Tag outgoing AI calls with this company id so the server can meter/enforce per-tenant.
  useEffect(()=>{ __companyId = cloudUserId || null; return ()=>{ __companyId = null; }; }, [cloudUserId]);
  // --- Metered web-search allowances (Measure online, O&M datasheets, Catalogues) ---
  // Counters live on the cloud-synced `usage` object and reset each billing month.
  // allowance = plan entitlement + any purchased add-on blocks for the period.
  const _period = billingPeriod();
  const _samePeriod = usage.period === _period;
  const featureLeft = (feature) => {
    const limit = (planOf(settings)[feature] || 0) + (_samePeriod ? ((usage.addons && usage.addons[feature]) || 0) : 0);
    const used = _samePeriod ? (usage[feature + "Used"] || 0) : 0;
    return Math.max(0, limit - used);
  };
  const featureAllowed = (feature) => featureLeft(feature) > 0;
  const recordFeatureUse = (feature) => setUsage(u => {
    const p = billingPeriod();
    const fresh = u.period === p ? u : { ...u, period: p, measureWebUsed: 0, omWebUsed: 0, catalogueWebUsed: 0, addons: {}, costPeriod: 0 };
    return { ...fresh, period: p, [feature + "Used"]: (fresh[feature + "Used"] || 0) + 1 };
  });
  // --- Billing: send the manager to Stripe-hosted Checkout / Customer Portal ---
  const startCheckout = async (body) => {
    try {
      const r = await fetch("/api/create-checkout-session", { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({ companyId: cloudUserId, email: session && session.user && session.user.email, ...body }) });
      const d = await r.json();
      if (d && d.url) window.location.href = d.url;
      else showToast(d && d.error ? d.error : "Could not start checkout.", "warn");
    } catch (e) { showToast("Billing isn't available right now.", "warn"); }
  };
  const openBillingPortal = async () => {
    try {
      const r = await fetch("/api/create-portal-session", { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({ companyId: cloudUserId }) });
      const d = await r.json();
      if (d && d.url) window.location.href = d.url;
      else showToast(d && d.error ? d.error : "No billing account yet.", "warn");
    } catch (e) { showToast("Billing isn't available right now.", "warn"); }
  };
  useEffect(()=>{ queueCloudPush("piq_team", team); }, [team, queueCloudPush]);
  useEffect(()=>{ queueCloudPush("piq_activity", activityLog.slice(0,500)); }, [activityLog, queueCloudPush]);
  // Allow real changes to sync only after the initial mount pushes above have run (and been skipped).
  useEffect(()=>{ const t = setTimeout(()=>{ hydratedRef.current = true; }, 1000); return ()=>clearTimeout(t); }, []);

  // Spend by trade (from approved orders)
  const spendByTrade = (() => {
    const map = {};
    orders.forEach(o => {
      const v = parseFloat(String(o.analysis?.estimatedTotal||o.estimatedTotal||"").replace(/[^0-9.]/g,""));
      if (!isNaN(v) && v>0) { const t=o.trade||"Other"; map[t]=(map[t]||0)+v; }
    });
    return Object.entries(map).map(([trade,total])=>({trade,total})).sort((a,b)=>b.total-a.total);
  })();
  const maxTradeSpend = spendByTrade.length ? Math.max(...spendByTrade.map(s=>s.total)) : 0;

  // Dashboard: procurement-pipeline donut (where live requests sit right now)
  const pipeline = [
    { label:"Awaiting quotes", value:stats.pending,  color:"#C77D2E" },
    { label:"Quotes in",       value:stats.received, color:"#7E6DD6" },
    { label:"Approved",        value:stats.approved, color:"#1E9E63" },
  ].filter(p=>p.value>0);
  const pipelineTotal = pipeline.reduce((s,p)=>s+p.value,0);

  // Dashboard: activity over the last 7 days (one bar per day)
  const activityWeek = (()=>{
    const days=[];
    for(let i=6;i>=0;i--){ const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-i);
      days.push({ start:d.getTime(), label:d.toLocaleDateString("en-GB",{weekday:"narrow"}), count:0 }); }
    (activityLog||[]).forEach(a=>{ const t=new Date(a.ts).getTime(); if(isNaN(t)) return;
      const day=days.find(x=>t>=x.start && t<x.start+86400000); if(day) day.count++; });
    return days;
  })();
  const activityWeekMax = Math.max(1, ...activityWeek.map(d=>d.count));
  const activityWeekTotal = activityWeek.reduce((s,d)=>s+d.count,0);

  // Budget tracking: jobs with a budget set, vs actual approved spend
  const budgetJobs = requests
    .filter(r => r.budget && parseFloat(r.budget) > 0)
    .map(r => {
      const jobOrders = orders.filter(o => o.jobRef === r.jobRef);
      const actual = jobOrders.reduce((sum,o) => {
        const v = parseFloat(String(o.estimatedTotal||o.analysis?.estimatedTotal||"").replace(/[^0-9.]/g,""));
        return sum + (isNaN(v)?0:v);
      }, 0);
      const budget = parseFloat(r.budget);
      return { id:r.id, jobRef:r.jobRef, budget, actual, pct: budget>0?Math.round(actual/budget*100):0 };
    });

  // Expiring quotes (within 5 days or already expired)
  const expiringQuotes = quoteLibrary.filter(q => {
    if (!q.expiryDate) return false;
    const daysLeft = Math.ceil((new Date(q.expiryDate).getTime() - Date.now()) / 86400000);
    return daysLeft <= 5;
  }).sort((a,b) => new Date(a.expiryDate) - new Date(b.expiryDate));

  // Template modal computed values (used in JSX)
  const templateTradeOrder = ["Plumbing","HVAC","Electrical","Mechanical","Ventilation","Gas","General"];
  const templateGrouped = templateTradeOrder.reduce((acc,tr)=>{
    const matching = templates.filter(t=>t.trade===tr);
    if(matching.length>0) acc[tr]=matching;
    return acc;
  },{});
  templates.filter(t=>!templateTradeOrder.includes(t.trade)).forEach(t=>{
    if(!templateGrouped[t.trade]) templateGrouped[t.trade]=[];
    templateGrouped[t.trade].push(t);
  });
  const templateCurrentTrade = trade||"Plumbing";

  // Generate an O&M pack for one project (jobRef).
  const runOM = async (proj) => {
    if (omBusy) return;
    setOmJob(proj.jobRef); setOmBusy(true);
    try {
      setOmStage("Collecting procured materials\u2026");
      const mats = omGatherMaterials(orders, proj.jobRef);
      if (!mats.length) { showToast("No procured items found for this project yet.","warn"); return; }
      setOmStage("Compiling equipment & maintenance schedules\u2026");
      const data = await omBuildData(mats);
      let omOnline = omWeb;
      if (omWeb && !featureAllowed("omWeb")) {
        omOnline = false;
        showToast("O\u0026M online-datasheet allowance reached this month \u2014 generating without online links. Add an O\u0026M pack or upgrade for more.","warn");
      }
      if (omOnline) {
        recordFeatureUse("omWeb");
        setOmStage("Searching manufacturers for datasheets\u2026");
        await omFindDatasheets(data.literature, (d,t)=>setOmStage(`Finding datasheets \u2026 ${d}/${t}`));
      }
      setOmStage("Building the document\u2026");
      const project = { jobRef: proj.jobRef, name: proj.jobRef, site: proj.site,
        items: mats.length, date: new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"}) };
      await omGeneratePdf(data, project, settings, { split: omSplit, web: omOnline });
      logActivity("O&M file generated", `O&M pack for ${proj.jobRef} (${mats.length} items)`, { entity:"order", jobRef: proj.jobRef });
      showToast("O&M file generated and downloaded.");
    } catch (e) {
      showToast("Could not generate the O&M file: " + (e.message || "error"), "warn");
    } finally {
      setOmBusy(false); setOmStage(""); setOmJob(null);
    }
  };

  const runMeasure = async () => {
    if (mBusy) return;
    const coatsApplies = /paint|render/i.test(mMaterial) || (/plaster|coat/i.test(mMaterial) && !/board/i.test(mMaterial));
    setMBusy(true); setMResult(null);
    try {
      const area = mArea ? Number(mArea) : (mLength && mHeight ? Number(mLength) * Number(mHeight) : null);
      if (!area || isNaN(area) || area <= 0) { showToast("Enter an area, or a length and height.", "warn"); return; }
      const areaR = Math.round(area * 100) / 100;
      let inputs, basis, basisUnit;
      if (mMeasureType === "volume") {
        const depthMm = Number(mDepth);
        if (!depthMm || isNaN(depthMm) || depthMm <= 0) { showToast("Enter a depth / thickness in mm for a volume calculation.", "warn"); return; }
        const volume = Math.round(area * (depthMm / 1000) * 1000) / 1000;
        inputs = { volume_m3: volume, area_m2: areaR, depth_mm: depthMm, wastage_percent: Number(mWastage) || 0 };
        basis = volume; basisUnit = "m\u00B3";
      } else {
        inputs = { area_m2: areaR, wastage_percent: Number(mWastage) || 0 };
        if (coatsApplies) inputs.coats = Number(mCoats) || 1;
        basis = areaR; basisUnit = "m\u00B2";
      }
      let useDS = mUseDatasheet;
      if (mUseDatasheet && !featureAllowed("measureWeb")) {
        useDS = false;
        showToast("Measure online-lookup allowance reached this month \u2014 using standard rates. Add a lookup pack or upgrade for more.","warn");
      }
      if (useDS) recordFeatureUse("measureWeb");
      const res = await measureCompute(mMaterial, inputs, { product: mProduct, useDatasheet: useDS });
      setMResult({ ...res, basis, basisUnit });
    } catch (e) { showToast("Couldn't calculate: " + (e.message || "error"), "warn"); }
    finally { setMBusy(false); }
  };

  const runTakeoff = async (file) => {
    if (!file || mDrawBusy) return;
    setMDrawBusy(true); setMTakeoff(null); setMDrawError(""); setMDrawName(file.name || "drawing");
    try {
      const res = await takeoffFromDrawing(file);
      if (res.error) { setMDrawError(res.error); }
      else { setMTakeoff(res.items); showToast(`Take-off ready - ${res.items.length} item${res.items.length !== 1 ? "s" : ""}. Review before ordering.`); }
    } catch (e) { setMDrawError("Couldn't read that drawing - please try a clearer PDF or image."); }
    finally { setMDrawBusy(false); }
  };

  const takeoffToRequest = () => {
    if (!mTakeoff || !mTakeoff.length) return;
    let t = "General";
    const cats = mTakeoff.map(i => (i.category || "").trim()).filter(Boolean);
    if (cats.length) {
      const counts = {};
      cats.forEach(c => { const m = TRADES.find(x => x.toLowerCase() === c.toLowerCase()); const key = m || c; counts[key] = (counts[key] || 0) + 1; });
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      if (TRADES.includes(top)) t = top;
    }
    setTrade(t);
    setParsed({ jobRef: "", trade: t, items: mTakeoff.map(i => ({ id: i.id, description: i.description, quantity: i.quantity, unit: i.unit, category: i.category || t, notes: i.notes || "" })) });
    setStep(2);
    setView("new");
    showToast("Take-off loaded into a new request - review and send.");
  };

  // --- Supplier Catalogues ---------------------------------------------------
  const [catBusy, setCatBusy] = useState(false);
  const [catErr, setCatErr] = useState("");
  const [catName, setCatName] = useState("");
  const [catSearch, setCatSearch] = useState("");
  const [catSel, setCatSel] = useState([]); // selected items -> basket for a request
  const [catOnlineBusy, setCatOnlineBusy] = useState(false);
  const [catOnlineResults, setCatOnlineResults] = useState(null);

  const runCatalogueUpload = async (file) => {
    if (!file || catBusy) return;
    setCatBusy(true); setCatErr(""); setCatName(file.name || "catalogue");
    try {
      const res = await parseCatalogue(file);
      if (res.error) { setCatErr(res.error); return; }
      const entry = {
        id: Date.now(),
        supplier: res.supplier || "",
        name: file.name || "catalogue",
        uploadedAt: new Date().toISOString(),
        uploadedBy: myEmail,
        items: res.items,
      };
      setCatalogues(p => [entry, ...p]);
      showToast(`Catalogue added \u2014 ${res.items.length} product${res.items.length !== 1 ? "s" : ""} indexed.`);
    } catch (e) {
      setCatErr("Couldn't read that catalogue \u2014 please try a clearer PDF, image, or CSV.");
    } finally { setCatBusy(false); setCatName(""); }
  };

  const deleteCatalogue = (id) => {
    setCatalogues(p => p.filter(c => c.id !== id));
    setCatSel(s => s.filter(it => it._cat !== id));
    showToast("Catalogue removed.");
  };

  const toggleCatSel = (item) => {
    setCatSel(s => s.some(x => x._k === item._k) ? s.filter(x => x._k !== item._k) : [...s, item]);
  };

  const addCatSelToRequest = () => {
    if (!catSel.length) return;
    setTrade("General");
    setParsed({
      jobRef: "", trade: "General",
      items: catSel.map((it, i) => ({
        id: Date.now() + i,
        description: it.partNumber ? `${it.description} (${it.partNumber})` : it.description,
        quantity: 1,
        unit: "no",
        category: it.manufacturer || it._supplier || "General",
        notes: [it.pack ? `Pack: ${it.pack}` : "", it.datasheetUrl ? `Datasheet: ${it.datasheetUrl}` : ""].filter(Boolean).join(" \u00B7 "),
      })),
    });
    setStep(2);
    setView("new");
    const n = catSel.length;
    setCatSel([]);
    showToast(`${n} item${n !== 1 ? "s" : ""} added to a new request \u2014 review and send.`);
  };

  const runCatalogueOnline = async () => {
    const q = catSearch.trim();
    if (!q || catOnlineBusy) return;
    if (!featureAllowed("catalogueWeb")) {
      showToast("Catalogue online-lookup allowance reached this month \u2014 add a pack or upgrade for more.", "warn");
      return;
    }
    setCatOnlineBusy(true); setCatOnlineResults(null);
    try {
      recordFeatureUse("catalogueWeb");
      const res = await catalogueFindOnline(q);
      if (res.error) { showToast(res.error, "warn"); return; }
      setCatOnlineResults(res.results || []);
      if (!res.results || !res.results.length) showToast("Nothing credible found online for that search.", "warn");
    } catch (e) { showToast("Couldn't search online right now \u2014 please try again.", "warn"); }
    finally { setCatOnlineBusy(false); }
  };

  const navItems = [
          {id:"dashboard",label:"Dashboard",      d:"M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z"},
          {id:"new",      label:"New request",    d:"M12 5v14M5 12h14"},
          {id:"requests", label:"All requests",   d:"M4 6h16M4 12h10M4 18h6"},
          {id:"quotes",   label:"Quotes",         min:2, d:"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2"},
          {id:"orders",   label:"Orders",         d:"M20 7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 16H8M12 12H8"},
          {id:"om",       label:"O&M files",      min:2, d:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6M8 13h8M8 17h5"},
          {id:"reports",  label:"Reports",        min:2, d:"M3 3v18h18M7 16V9M12 16V5M17 16v-7"},
          {id:"measure",  label:"Measure",        d:"M3 7l4-4 14 14-4 4zM7 7l2 2M11 11l2 2M15 15l2 2"},
          {id:"catalogues",label:"Catalogues",     d:"M4 5a1 1 0 011-1h5v16H5a1 1 0 01-1-1zM14 4h5a1 1 0 011 1v13a1 1 0 01-1 1h-5z"},
          {id:"hire",     label:"Hire",           d:"M3 9l1-5h16l1 5M3 9h18v10a1 1 0 01-1 1H4a1 1 0 01-1-1V9zM8 13h8"},
          {id:"suppliers",label:"Suppliers",      min:2, d:"M17 20h-2a4 4 0 00-8 0H5m7-10a3 3 0 100-6 3 3 0 000 6z"},
          {id:"team",     label:"Team",           min:3, d:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 7a4 4 0 100 8 4 4 0 000-8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"},
          {id:"library",  label:"Library",        min:2, d:"M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 014 17V5a2 2 0 012-2h12a2 2 0 012 2v12M4 19.5V21"},
          {id:"settings", label:"Settings",       min:3, d:"M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"},
          {id:"help",     label:"Help",           d:"M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01"},
          {id:"contact",  label:"Contact",        d:"M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"},
  ];
  const VIEW_MIN_ROLE = { quotes:2, suppliers:2, library:2, om:2, reports:2, team:3, settings:3 };
  const handleNav = (id) => {
    const need = VIEW_MIN_ROLE[id];
    if (need && roleRank(myRole) < need) { showToast("You don't have access to that section.","warn"); return; }
    setView(id); setMoreMenuOpen(false); if(id==="new")resetNewRequest();
  };
  const pendingOrders = visibleOrders.filter(o=>o.status==="pending-send").length;

  // Overdue requests (for dashboard banner)
  const overdueRequests = (() => {
    const now = Date.now();
    return requests.filter(r => {
      if (r.status !== "pending") return false;
      const sent = r.activity?.find(a => a.action === "RFQ emails sent")?.ts
                || r.activity?.find(a => a.action === "Created")?.ts;
      if (!sent) return false;
      return (now - new Date(sent).getTime()) / 3600000 >= 24;
    });
  })();

  // Quote analysis pending status
  const activeReqSentTs = activeReq?.activity?.find(a => a.action === "RFQ emails sent")?.ts;
  const activeReqHoursAgo = activeReqSentTs ? Math.floor((Date.now() - new Date(activeReqSentTs).getTime()) / 3600000) : 0;

  // Quote library scorecards
  const supplierScoreCards = (() => {
    const bySupplier = {};
    quoteLibrary.forEach(q => {
      if (!bySupplier[q.supplierName]) bySupplier[q.supplierName] = {name:q.supplierName, quotes:[], total:0};
      bySupplier[q.supplierName].quotes.push(q);
      bySupplier[q.supplierName].total += q.completeness || 0;
    });
    return Object.values(bySupplier).map(s => ({
      ...s,
      avgCompleteness: Math.round(s.total / s.quotes.length),
      lastQuoted: s.quotes.sort((a,b) => new Date(b.savedAt)-new Date(a.savedAt))[0]?.savedAt
    })).sort((a,b) => b.avgCompleteness - a.avgCompleteness);
  })();

  // Help page FAQs
  const helpFaqs = [
    {cat:"Getting started", qs:[
      {q:"What is ProQure?", a:"ProQure is an AI-powered procurement platform for trades contractors. It automates the full workflow from creating a material request on site through to sending a PO to your supplier."},
      {q:"What trades are supported?", a:"All the main building trades - Plumbing, Heating & Gas, Electrical, HVAC, Ventilation, Mechanical, Joinery & Carpentry, Bricklaying, Groundworks, Roofing, Plastering & Drylining, Decorating, Flooring & Tiling, Drainage, Steel & Fabrication and Landscaping, with General as a catch-all. The trade is auto-detected from the materials you enter and still powers the spend-by-trade breakdown."},
      {q:"Does it work on mobile?", a:"Yes. ProQure is a web app that works on any device. On mobile you get a dedicated layout with a bottom tab bar and voice input."},
      {q:"I am brand new - where do I start?", a:"When you first open ProQure with no data, the dashboard shows a Welcome card with three quick steps: create a request, send it to suppliers, then analyse and approve the quotes. Tap 'Create your first request' to begin. The card disappears once you have any activity."},
      {q:"Which browsers and phones are supported?", a:"All modern browsers - Chrome, Safari, Firefox and Edge - on both desktop and mobile, including iPhone and Android. The layout adapts automatically to your screen, and on phones you can use the camera to scan documents on site."},
      {q:"Does it respect accessibility settings?", a:"Yes. The app supports a dark and light mode, has clear keyboard focus indicators, and honours your device's reduced-motion setting so animations are minimised if you prefer."},
      {q:"Do I need to install anything?", a:"No. ProQure runs entirely in a browser - Chrome, Safari, Edge. No app download needed."},
      {q:"Where is my data stored?", a:"Securely in the cloud, tied to your login. That is what lets you sign in on any device - phone, tablet or computer - and see the same up-to-date information everywhere. Your whole team shares one live view."},
    ]},
    {cat:"Creating requests", qs:[
      {q:"How does voice input work?", a:"Tap the microphone button on the new request page and speak your list naturally. The app transcribes in real time and the AI structures it into a clean itemised list."},
      {q:"Can I edit the parsed list?", a:"Yes. Every field is editable - description, quantity, unit, category, and notes. You can also add or remove items before sending."},
      {q:"What are templates?", a:"Templates save common material lists for instant reuse. They are grouped by trade so you can find them quickly."},
      {q:"Can I set a response deadline?", a:"Yes. In Step 2 there is a response deadline date picker. The date appears in the RFQ email and as a countdown on the dashboard."},
      {q:"How do I scan a document or photo?", a:"On Step 1, tap 'Take a photo or upload a document'. On mobile this opens your camera. Photograph a scope of works, schedule of materials or handwritten list - the vision AI reads it and extracts the items. PDFs and images both work. Review the extracted list, then tap Proceed."},
      {q:"Can I import a spreadsheet?", a:"Yes. On Step 1 use 'Import a materials spreadsheet'. Upload a CSV with description, quantity and unit columns and it imports instantly - no AI needed, no waiting. It auto-detects your column headers."},
      {q:"What are request notes?", a:"An optional field on Step 2 for access instructions or special requirements. Notes are stored with the request and shown in the All Requests list."},
    ]},
    {cat:"Quotes & analysis", qs:[
      {q:"How do I enter a supplier quote?", a:"Three ways: if the supplier replies to your RFQ email it is captured automatically into their box; or you paste their email response into the box; or you upload their PDF/Excel file (the AI reads documents automatically)."},
      {q:"Do supplier replies fill in automatically?", a:"Yes. When a supplier replies to your RFQ email, their reply is captured and dropped straight into that supplier's quote box, ready to analyse - no copy-pasting. Only their actual quote is kept; the quoted-back request and email signatures are stripped out. A copy of every reply is also forwarded to your own inbox so nothing is missed."},
      {q:"What if a supplier sends a brand-new email instead of replying?", a:"If they reply to the quote request, it is captured automatically. If they ignore it and send a separate new email to your normal address, that will not auto-file against the job - it just arrives in your inbox like any email, so nothing is lost. Each request email asks suppliers to reply to it, which keeps most replies tracked."},
      {q:"What does the AI check?", a:"The AI checks every item for price, stock availability, quantity accuracy, carriage charges, lead times, discounts, and alternatives. It produces a completeness score and recommends the best supplier."},
      {q:"What happens to other quotes when I approve one?", a:"All other quotes are automatically saved to the Quote Library in the background."},
      {q:"Can I undo an approval?", a:"Yes. The approved quote card shows an Undo button that reverses everything."},
      {q:"What is the Compare view?", a:"In the analysis results, the Cards/Compare toggle switches to a side-by-side table - one row per requested item, one column per supplier, so you can scan who is cheapest on each line. The lowest total is badged automatically. You can approve straight from the table."},
      {q:"How does the markup calculator work?", a:"Enter a markup percentage in the analysis results and ProQure shows each supplier's cost alongside the marked-up sell price - useful for quoting the end client. Set it back to 0 for pure cost."},
      {q:"Can I export or print a comparison?", a:"Yes. The Print button in the analysis results opens a print-friendly layout - use your browser's Save as PDF to share it."},
      {q:"How are quotes collapsed?", a:"Each supplier result is a collapsible card. Tap the header to expand the full matched-items table and analysis; tap again to collapse. The first card opens automatically after analysis."},
      {q:"Are my past quote analyses saved?", a:"Yes. Every analysis you run is saved on the Quotes page as a collapsible card, just like orders. After you approve a quote, that analysis moves into the saved list automatically. You can re-open any past analysis in full at any time, and they survive a page refresh."},
      {q:"How do I know a quote has been entered?", a:"When you paste a supplier's quote into their box, it turns green and shows a Quote entered badge, so you can see at a glance which suppliers you have quotes from."},
    ]},
    {cat:"Orders", qs:[
      {q:"How do I send a PO to a supplier?", a:"In the Orders page, find the order and tap Send order. An email is sent to the supplier with the full PO details."},
      {q:"How do I raise an emergency PO without the full quote process?", a:"Use Quick PO - the button on the Orders page and dashboard quick actions (Buyers and Managers only). It is for when you have agreed a price with a supplier on the phone and need a PO straight away. Pick or add a supplier, enter the items and the agreed price, and it generates a numbered PO immediately - skipping the RFQ-and-quote steps and manager approval. It is logged as a direct/phone order."},
      {q:"What is an Ad-hoc supplier?", a:"When you add a new supplier on the spot during a Quick PO or hire (for example, a merchant near a remote site), it is saved tagged 'Ad-hoc' so it is kept separate from your established 'Approved' suppliers - you will see an amber Ad-hoc badge on the Suppliers page. After you have used that supplier 5 times, ProQure asks if you would like to promote them to an Approved supplier."},
      {q:"How does the Hire feature work?", a:"The Hire tab tracks plant and tool hire through its whole life. Raise a hire with the equipment, supplier, site, weekly rate and a return date (or mark it as an open hire). When it arrives, mark it delivered and take a photo of its condition. The hire log shows how many weeks it has been on, the running cost, and flags overdue items. When you are done, off-hire it - this emails the supplier to collect on a set date - take a photo of where it was left, then enter the supplier's collection reference to close it."},
      {q:"Why do I take photos of hire equipment?", a:"Two photos protect you in disputes: one on delivery (showing how the equipment arrived, in case anything is damaged or missing) and one at collection (showing where it was left on site, useful if you are not there when the supplier collects). Photos are compressed automatically so they stay small, and show as thumbnails on the hire log."},
      {q:"How are POs and hires counted in the stats?", a:"Every purchase order and every hire counts toward your total 'POs raised'. The workspace stats also break it down so you can see how many were materials POs versus hire equipment."},
      {q:"How do I attach a supplier confirmation?", a:"When an order is Sent, the right panel shows an upload area. Upload the confirmation PDF and the order moves to Confirmed automatically."},
      {q:"Do completed orders disappear?", a:"No. All orders stay permanently. Use the All / Active / Delivered filter to manage what you see."},
      {q:"Can I mark an order complete without a document?", a:"Yes. When an order is Sent, you can tap Mark as confirmed or Mark as delivered directly, or upload the supplier's confirmation document - whichever suits. Both options are available."},
      {q:"Can I export my orders?", a:"Yes. The Orders page has an Export button that downloads all orders as a CSV, including PO numbers, suppliers, totals, delivery dates and item lists."},
      {q:"Are order cards collapsible?", a:"Yes. Tap any order row to expand its full detail - status timeline, items and actions. Tap again to collapse."},
    ]},
    {cat:"Library, branding & shortcuts", qs:[
      {q:"What is the Quote Library?", a:"Every quote that is not approved is automatically saved to the Library when you generate a PO. It builds a price history per supplier, shows supplier scorecards (average completeness), and flags quotes that are expiring. Export it all to CSV."},
      {q:"Do quotes expire?", a:"Yes. Saved quotes expire after 30 days by default (configurable in Settings). The dashboard warns you when quotes are within 5 days of expiry, and the library shows a colour-coded expiry badge on each."},
      {q:"How do I add my company logo?", a:"In Settings, under Company branding, upload your logo. It is automatically resized and appears at the top of the branded HTML emails sent to suppliers. You can also set default PO terms and the quote validity period there."},
      {q:"Do emails include my branding?", a:"Yes. RFQ and purchase order emails are sent as branded HTML with your logo (or company name) at the top, your message in a clean card, and your PO terms in the footer."},
      {q:"What keyboard shortcuts are there?", a:"Press N for new request, Q for quotes, O for orders, D for dashboard, S for settings, H for help, and ? to show the full shortcuts panel. Esc closes any open dialog."},
      {q:"How do I get back to the dashboard quickly?", a:"Click the ProQure logo at the top of the sidebar, press D, or use the dashboard tab."},
      {q:"Can I search and filter my requests?", a:"Yes. The All Requests page has a search box plus status and trade filters, so you can quickly find any job. The filtered list can be exported to CSV."},
      {q:"Where can I see everything that has happened?", a:"The dashboard has a Recent activity feed that logs every action across the app - RFQs sent, quotes analysed, POs approved, orders sent, confirmed and delivered, confirmations uploaded, suppliers added and library changes. Each individual request also keeps its own activity history, which you can open from the All Requests page."},
      {q:"What charts does the dashboard show?", a:"Once you have approved orders, a Spend by trade bar chart appears, breaking your spend down by trade so you can see where the money goes."},
      {q:"Can I add a supplier while creating a request?", a:"Yes. On the supplier step of the request wizard, tap '+ Add a supplier' to add one inline - it is saved and auto-selected without leaving the page."},
      {q:"Can a supplier have several contacts or branches?", a:"Yes. On the Suppliers page, tap Edit on a supplier to add multiple named contacts - each with their own email - and to add branches/depots (and tag each contact with theirs). When you send an RFQ you pick which contact it goes to, and the supplier list has a search box for long lists."},
      {q:"Can I remove a quote from the library?", a:"Yes. Each row in the Quote Library has a bin icon to remove that quote. The removal is logged in the activity feed."},
    ]},
    {cat:"Settings & troubleshooting", qs:[
      {q:"Why is the AI not working?", a:"AI is built in and managed for you - there is nothing to set up. If a quote analysis ever fails, it is usually a brief hiccup; wait a moment and try again. If it keeps happening, use Send feedback to let us know."},
      {q:"Why are emails not sending?", a:"Email is managed for you, so there are no keys to set up. For ProQure to send from your company address, your domain needs a few one-off DNS records added (your IT or whoever manages your website handles this). If emails are not arriving, check that step has been completed, then use Send feedback if it persists."},
      {q:"My data disappeared after refreshing.", a:"Your data lives in the cloud against your account, so refreshing will not lose it. If something looks missing, make sure you are signed in with the correct email - data is tied to your login. If it still seems wrong, use Send feedback and we will look into it."},
      {q:"Can I export my data?", a:"Yes. The Library, Orders and All Requests pages each have a CSV export button, so you can back up or share your data anytime."},
      {q:"Can I revise and re-send an RFQ?", a:"Yes. On All Requests, tap 'Revise' on a sent request (Buyers and Managers). It reopens in the wizard with everything pre-filled and the original suppliers and contacts already selected. Change whatever you need, then re-send - it updates the same request, bumps the version (v2, v3...), re-sends to your chosen suppliers and clears their quote boxes for the new revision, so you're not left with a duplicate request."},
      {q:"Does it remember my jobs and addresses?", a:"Yes. As you type, the Job reference and Site fields suggest values from your past requests, the alternative-address field suggests addresses you've used before, and the Collect-from field suggests your suppliers' branches plus places you've collected from - so recurring jobs and depots are a quick tap rather than retyping."},
      {q:"What features are coming next?", a:"Recently added: trade auto-detect, multiple named contacts and branches per supplier, automatic capture of supplier email replies into the quote box, revise-and-re-send for RFQs, collect-from branch details, and job/site/branch autocomplete. Recently added: the O&M file generator, spend reporting (by trade, supplier, project and month) with a per-project cross-trade view, and a materials measuring tool. Just added: a 'From a drawing' materials take-off (upload a scaled PDF/image and ProQure lists the materials to order, ready to edit) and manufacturer-datasheet coverage lookup in Measure. On the roadmap next: a native mobile app with camera room-scanning for on-site measuring, smart matching of stray supplier emails to the right job, AI that reads hire delivery photos to note condition automatically, hire-vs-buy suggestions based on your hire history, and accounting integrations like Xero and Sage."},
    ]},
    {cat:"O&M, reports & measure", qs:[
      {q:"What is the O&M file generator?", a:"On the 'O&M files' tab (Buyers and Managers) ProQure builds an Operations & Maintenance pack for a project from the materials you've ordered against it. Pick the project and tap Generate O&M - you get a presented PDF with a cover, contents, an equipment schedule (with a separate spares & consumables list), manufacturer literature, and planned preventative maintenance (PPM) schedules with their governing standards. The equipment details and maintenance schedules are AI-drafted and marked for your sign-off, so review before issuing to a client."},
      {q:"How does it find the datasheets?", a:"Turn on 'find datasheet links online' before generating and ProQure searches each manufacturer for the exact datasheet for the model installed. That option uses web search (a small per-use cost) so it is off by default - with it off, the pack still lists each item's manufacturer and model with a search link."},
      {q:"Can I split the O&M into separate files?", a:"Yes. Tick 'also export sections separately' and ProQure downloads the Literature and Maintenance sections as their own PDFs in addition to the single combined pack."},
      {q:"What's in the Reports tab?", a:"Reports (Buyers and Managers) shows total spend, order count, projects and suppliers, with spend broken down by trade, by supplier and by month, and a CSV export. The 'By project' tab is the manager view: pick a project to see its total cost split across every trade and supplier on it."},
      {q:"How is spend worked out?", a:"From your orders. ProQure adds up the line totals on each PO (falling back to the PO's estimated total), and ignores cancelled orders. Trade comes from the request the order was raised from."},
      {q:"What does the Measure tab do?", a:"Enter an area (or a length and height) and pick a material, and ProQure works out how much to order and how many packs, using standard UK coverage rates and a wastage allowance, and shows the assumptions it used. It's an estimate - always sense-check before ordering. It can also look up a specific product's datasheet for the exact coverage rate, and the 'From a drawing' mode does a full materials take-off from an uploaded PDF/image drawing that you can edit and turn into a request. Camera room-scanning is coming with the native app."},
      {q:"Can ProQure read a drawing and list the materials?", a:"Yes - that's the 'From a drawing' mode on the Measure tab. Upload a scaled PDF or image of the drawing and ProQure does a materials take-off of the items shown, then gives you an editable list you can adjust and turn straight into a request. It reads PDFs and images, not raw DWG/CAD files, so export a DWG to PDF first. The list is an AI draft - always check it against the drawing before ordering."},
      {q:"Can Measure use a specific product's real coverage rate?", a:"Yes. In 'By dimensions', type the product or brand and tick 'look up the manufacturer's datasheet', and ProQure web-searches that product's datasheet for its published coverage rate and bases the quantity on it, with a source link. That option uses web search (a small per-use cost) so it's off by default; left off, it uses standard UK coverage rates."},
    ]},
    {cat:"Account & your team", qs:[
      {q:"Is ProQure free? Is there a trial?", a:"ProQure starts as a free trial - there is no card needed to get going. You will be given plenty of notice before anything about that changes."},
      {q:"How do I set my company up on ProQure?", a:"Tap 'Get your licence' on the ProQure website. You will get an email, click the link, set a password, then run through a short onboarding - company name, your contact details, main trade, team size, address, and the address you want quotes and POs sent from. Whoever sets the company up becomes its Manager."},
      {q:"How do I add my team?", a:"As a Manager, open your team settings and invite each colleague by email, choosing whether they are a Buyer or an Engineer. They receive an email, click it, set their own password, and land in your shared workspace. You can invite people up to your own role level."},
      {q:"Someone I invited did not get the email - what now?", a:"Ask them to go to the sign-in screen and tap 'Forgot password' using the email you invited. They will get a link to set a password and will still join your company when they sign in. Invite emails can occasionally be held up by a company spam filter, so it is worth checking junk too."},
      {q:"Is my company's data separate from other companies?", a:"Yes. Every company on ProQure is completely isolated - your team shares one live view of your own data, and no other company can see it. Roles then control who on your team sees what (for example, Engineers do not see prices or spend)."},
      {q:"What is the difference between Manager, Buyer and Engineer?", a:"Three roles, high to low. Managers have full access, manage the team and edit settings. Buyers send RFQs, handle returned quotes and raise purchase orders. Engineers raise the materials list and sign off deliveries, but do not see prices, costs or jobs that are not their own, and cannot send RFQs or raise POs."},
    ]},
  ];

  // File upload handler for quote entry
  const processQuoteFile = async(file, si, sup, activeReqId) => {
    if (!file) return;
    if (!AI_VIA_SERVER && !settings.openRouterKey) { showToast("AI is temporarily unavailable. Please try again shortly.","warn"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setFileExtracting(prev=>({...prev,[si]:true}));
    showToast(`Reading ${file.name}...`);
    try {
      const { content, type } = await readFileForExtraction(file);
      showToast(`AI extracting data from ${file.name}...`);
      const extracted = await extractQuoteFromFile(content, file.name, type);
      const newQuote = sup.quote?.trim()
        ? sup.quote + "\n\n--- From " + file.name + " ---\n" + extracted
        : "--- Extracted from " + file.name + " ---\n" + extracted;
      setRequests(p=>p.map(r=>r.id===activeReqId?{...r,sentTo:r.sentTo.map((s,i)=>i===si?{...s,quote:newQuote}:s)}:r));
      setActiveReq(prev=>({...prev,sentTo:prev.sentTo.map((s,i)=>i===si?{...s,quote:newQuote}:s)}));
      showToast(`${file.name} extracted - review and save`);
    } catch(err) {
      showToast(`Could not read ${file.name}: ${err.message}`,"warn");
    }
    setFileExtracting(prev=>({...prev,[si]:false}));
  };

  // Auto-read emailed supplier attachments into the quote box using the SAME extractor
  // as a manual upload, so the AI reads everything in the box. Runs when a request is
  // open; each attachment is processed once (extracted flag), sequentially.
  const autoExtractRef = useRef(false);
  useEffect(() => {
    if (!activeReq || autoExtractRef.current) return;
    if (!(AI_VIA_SERVER || settings.openRouterKey)) return;
    const pending = [];
    (activeReq.sentTo||[]).forEach((s,si)=>(s.attachments||[]).forEach((a,ai)=>{
      if (a && a.dataUrl && !a.extracted && !a.extractError) pending.push({si,ai,name:a.name,dataUrl:a.dataUrl});
    }));
    if (!pending.length) return;
    autoExtractRef.current = true;
    const reqId = activeReq.id;
    (async () => {
      window.__piq_or_key__ = settings.openRouterKey;
      for (const job of pending) {
        try {
          setFileExtracting(p=>({...p,[job.si]:true}));
          const { content, type } = await readFileForExtraction(dataUrlToFile(job.dataUrl, job.name));
          const extracted = await extractQuoteFromFile(content, job.name, type);
          const tag = "--- From " + (job.name||"attachment") + " (emailed) ---\n";
          const apply = (s,i)=> i===job.si ? {
            ...s,
            quote: (s.quote && s.quote.trim() ? s.quote + "\n\n" : "") + tag + extracted,
            saved: true,
            attachments: (s.attachments||[]).map((x,xi)=> xi===job.ai ? {...x, extracted:true} : x),
          } : s;
          setRequests(p=>p.map(r=> r.id===reqId ? {...r, sentTo:r.sentTo.map(apply)} : r));
          setActiveReq(p=> p && p.id===reqId ? {...p, sentTo:p.sentTo.map(apply)} : p);
        } catch (err) {
          const mark = (s,i)=> i===job.si ? {...s, attachments:(s.attachments||[]).map((x,xi)=> xi===job.ai ? {...x, extractError:true} : x)} : s;
          setRequests(p=>p.map(r=> r.id===reqId ? {...r, sentTo:r.sentTo.map(mark)} : r));
          setActiveReq(p=> p && p.id===reqId ? {...p, sentTo:p.sentTo.map(mark)} : p);
        } finally {
          setFileExtracting(p=>({...p,[job.si]:false}));
        }
      }
      autoExtractRef.current = false;
    })();
  }, [activeReq, settings]);

  // Bulk CSV/spreadsheet import — parses a materials list directly into items (no AI needed)
  const importMaterialsCSV = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (!lines.length) { showToast("That file looks empty","warn"); return; }
      // Detect header row — look for description/qty/quantity/unit keywords
      const first = lines[0].toLowerCase();
      const hasHeader = /desc|item|material|qty|quantity|unit/.test(first);
      // Split a CSV line respecting simple quoted values
      const splitLine = (line) => {
        const out = []; let cur = ""; let inQ = false;
        for (const ch of line) {
          if (ch === '"') inQ = !inQ;
          else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
          else cur += ch;
        }
        out.push(cur);
        return out.map(s => s.trim().replace(/^"|"$/g, ""));
      };
      // Map header positions if present
      let descIdx = 0, qtyIdx = 1, unitIdx = 2;
      if (hasHeader) {
        const cols = splitLine(first);
        cols.forEach((col, i) => {
          if (/desc|item|material/.test(col)) descIdx = i;
          else if (/qty|quantity|amount/.test(col)) qtyIdx = i;
          else if (/unit|measure/.test(col)) unitIdx = i;
        });
      }
      const dataLines = hasHeader ? lines.slice(1) : lines;
      const items = dataLines.map(line => {
        const cols = splitLine(line);
        return {
          description: cols[descIdx] || cols[0] || "",
          quantity: cols[qtyIdx] || "1",
          unit: cols[unitIdx] || "no",
          category: ""
        };
      }).filter(it => it.description);
      if (!items.length) { showToast("Couldn't find any items in that file","warn"); return; }
      setParsed({ jobRef: jobRef||"", trade, items });
      setStep(2);
      showToast(`Imported ${items.length} item${items.length!==1?"s":""} from spreadsheet`);
    } catch(err) {
      showToast("Could not read that file: " + err.message, "warn");
    }
  };

  // Document scan handler
  const [scanning, setScanning] = useState(false);
  const scanDocumentFile = async (file) => {
    if (!file) return;
    if (!AI_VIA_SERVER && !settings.openRouterKey) { showToast("AI is temporarily unavailable. Please try again shortly.","warn"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setRawInput("");  // Clear previous input before scanning
    setScanning(true);
    setLoading(true);
    setLoadMsg("Reading document...");
    try {
      // Read file as base64 for vision API
      const base64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(",")[1]);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });

      const isImage = file.type.startsWith("image/");
      const isPDF   = file.type === "application/pdf";

      if (!isImage && !isPDF) {
        // Text-based file — read as text and parse normally
        const text = await file.text();
        setRawInput(text);
        setScanning(false);
        setLoading(false);
        showToast("Document loaded. Review, then tap Proceed");
        return;
      }

      setLoadMsg("AI reading document...");

      // Use vision-capable model for images
      const key = settings.openRouterKey;
      const systemPrompt = `You are an expert at reading construction and trades documents.
Extract ALL material items from this document — scope of works, schedule of materials, delivery notes, handwritten lists, anything.
Return ONLY a plain text list in this format, one item per line:
[quantity] [unit] [description]
Example:
20 metres 22mm copper pipe
6 no 22mm compression elbows
1 box PTFE tape

Rules:
- Include every material item you can see, even if quantities are unclear
- If quantity is not clear, use 1 as default
- If unit is not clear, use "no" (number off)
- Do NOT include labour, costs, prices, or non-material items
- Do NOT add any explanation or preamble — just the list`;

      let content;
      if (isImage) {
        content = [
          { type: "image_url", image_url: { url: `data:${file.type};base64,${base64}` } },
          { type: "text", text: "Extract all material items from this document as a plain list." }
        ];
      } else {
        // PDF — send as text extraction prompt
        content = `I have a PDF document. Here is the base64 content. Please extract all material items: ${base64.slice(0, 8000)}`;
      }

      const userMsg = { role: "user", content: isImage ? content : (typeof content === "string" ? content : JSON.stringify(content)) };
      const scanModels = [ isImage ? "google/gemini-flash-1.5" : "deepseek/deepseek-chat" ];
      let extracted = "";
      // Preferred path: central server key via /api/ai (no user key needed).
      try {
        if (!aiBudgetOk()) throw new Error(AI_BUDGET_MSG);
        const sres = await fetch("/api/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await authHeaders()) },
          body: JSON.stringify({ messages: [{ role: "system", content: systemPrompt }, userMsg], models: scanModels, temperature: 0.1, companyId: __companyId })
        });
        if (sres.ok) {
          const sd = await sres.json();
          reportAiUsage(sd.cost, false);
          if (sd.text) extracted = sd.text;
          else if (sd.error && !sd.error.includes("not configured")) throw new Error(sd.error);
        }
      } catch (e) { /* fall through to the user-key path */ }
      // Fallback: user-provided key (legacy / if the server key isn't set up yet).
      if (!extracted.trim() && key) {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key, "HTTP-Referer": "https://proqure.app", "X-Title": "ProQure" },
          body: JSON.stringify({ model: scanModels[0], messages: [{ role: "system", content: systemPrompt }, userMsg] })
        });
        const data = await res.json();
        extracted = data.choices?.[0]?.message?.content || "";
      }
      if (!extracted.trim()) throw new Error("No items found in document");

      setRawInput(extracted.trim());
      setScanning(false);
      setLoading(false);
      const itemCount = extracted.trim().split("\n").filter(Boolean).length;
      showToast(`Document scanned - ${itemCount} item${itemCount!==1?"s":""} found. Review, then Proceed`);

    } catch(err) {
      setScanning(false);
      setLoading(false);
      setLoadMsg("");
      showToast("Could not read document: " + err.message, "warn");
    }
  };

  // CSV export helper
  const downloadCSV = (filename, rows) => {
    if (!rows.length) { showToast("Nothing to export","warn"); return; }
    const headers = Object.keys(rows[0]);
    const escape = (v) => {
      const s = (v==null?"":String(v)).replace(/"/g,'""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csv = [
      headers.join(","),
      ...rows.map(r => headers.map(h => escape(r[h])).join(","))
    ].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${rows.length} row${rows.length!==1?"s":""}`);
  };

  // -- Render --
  return (
    <div data-theme={darkMode?"dark":"light"} style={{fontFamily:"'Plus Jakarta Sans','Helvetica Neue',sans-serif",background:"var(--bg-page)",color:"var(--text-primary)",transition:"background 0.3s,color 0.2s"}} className="app-shell">
      {/* Ambient background layer - subtle brand shape + soft orbs */}
      <div className="app-bg-layer">
        <div className="orb orb-green" style={{width:560,height:560,top:-180,right:-120}}/>
        <div className="orb orb-indigo" style={{width:480,height:480,bottom:-160,left:-100}}/>
        <div className="orb orb-green" style={{width:400,height:400,top:"45%",left:"55%"}}/>
      </div>
      {/* Large translucent ProQure mark, bottom-right */}
      <svg className="app-bg-mark" width="640" height="640" viewBox="0 0 20 20" fill="none" style={{bottom:-140,right:-120}} preserveAspectRatio="xMidYMid meet">
        <rect x="3" y="3" width="3" height="14" rx="1.5" fill="var(--green-dark)"/>
        <rect x="6" y="3" width="8" height="3" rx="1.5" fill="var(--green-dark)"/>
        <rect x="14" y="3" width="3" height="8" rx="1.5" fill="var(--green-dark)"/>
        <rect x="6" y="10" width="8" height="3" rx="1.5" fill="var(--green)"/>
        <circle cx="16.5" cy="15.5" r="2" fill="var(--green-dark)"/>
      </svg>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      <style>{`
      /* -- LIGHT THEME (default) -- */
      :root {
        --bg-page:        #FAFAF8;
        --bg-card:        rgba(255,255,255,0.82);
        --bg-card-solid:  #FFFFFF;
        --bg-input:       #FFFFFF;
        --bg-subtle:      #F6F6F3;
        --bg-subtle2:     #EFEFEA;
        --bg-header:      #FFFFFF;
        --border:         #EAE9E3;
        --border-solid:   #E2E1DA;
        --text-primary:   #1A1A17;
        --text-secondary: #5C5B54;
        --text-tertiary:  #908F86;
        --text-muted:     #C4C3BA;
        --green:          #1E9E63;
        --green-dark:     #15824F;
        --green-deep:     #0E5C38;
        --green-light:    #DFF3E8;
        --green-mint:     #F2FAF5;
        --indigo:         #5B5BD6;
        --indigo-light:   #EEEEFB;
        --violet:         #7E6DD6;
        --violet-light:   #EFEDFB;
        --amber:          #C77D2E;
        --amber-light:    #FBF3E8;
        --red:            #D14343;
        --red-light:      #FBEDED;
        --shadow-sm:      0 1px 2px rgba(26,26,23,0.04), 0 1px 1px rgba(26,26,23,0.03);
        --shadow-md:      0 2px 4px rgba(26,26,23,0.04), 0 6px 16px rgba(26,26,23,0.06);
        --shadow-lg:      0 4px 8px rgba(26,26,23,0.04), 0 16px 40px rgba(26,26,23,0.10);
        --sidebar-bg:     #18181B;
        --sidebar-border: #27272A;
        --sidebar-text:   #A1A1AA;
        --sidebar-active: #34D399;
        --sidebar-activebg: rgba(52,211,153,0.12);
        --topbar-bg:      #18181B;
        --bottombar-bg:   #18181B;
        --radius-sm:      10px;
        --radius-md:      14px;
        --radius-lg:      20px;
      }
      /* -- DARK THEME -- */
      [data-theme="dark"] {
        --bg-page:        #16161A;
        --bg-card:        rgba(28,28,33,0.82);
        --bg-card-solid:  #1C1C21;
        --bg-input:       #232328;
        --bg-subtle:      #232328;
        --bg-subtle2:     #2E2E35;
        --bg-header:      #1C1C21;
        --border:         #2E2E35;
        --border-solid:   #3A3A42;
        --text-primary:   #F4F4F2;
        --text-secondary: #B4B4AE;
        --text-tertiary:  #87877F;
        --text-muted:     #5C5C56;
        --green:          #3DD68C;
        --green-dark:     #2BB873;
        --green-deep:     #7FE8B5;
        --green-light:    rgba(61,214,140,0.14);
        --green-mint:     rgba(61,214,140,0.07);
        --indigo:         #8B8BF0;
        --indigo-light:   rgba(139,139,240,0.14);
        --violet:         #A99CF0;
        --violet-light:   rgba(169,156,240,0.14);
        --amber:          #E0A04D;
        --amber-light:    rgba(224,160,77,0.12);
        --red:            #E66B6B;
        --red-light:      rgba(230,107,107,0.12);
        --shadow-sm:      0 1px 2px rgba(0,0,0,0.4);
        --shadow-md:      0 2px 4px rgba(0,0,0,0.3), 0 8px 20px rgba(0,0,0,0.4);
        --shadow-lg:      0 4px 8px rgba(0,0,0,0.3), 0 20px 48px rgba(0,0,0,0.55);
        --sidebar-bg:     #111114;
        --sidebar-border: #26262C;
        --sidebar-text:   #87877F;
        --sidebar-active: #3DD68C;
        --sidebar-activebg: rgba(61,214,140,0.10);
        --topbar-bg:      #111114;
        --bottombar-bg:   #111114;
      }
      [data-theme="dark"] input,[data-theme="dark"] textarea,[data-theme="dark"] select {
        background:var(--bg-input)!important;color:var(--text-primary)!important;border-color:var(--border-solid)!important;
      }
      [data-theme="dark"] input::placeholder,[data-theme="dark"] textarea::placeholder { color:var(--text-muted)!important; }
      *{box-sizing:border-box;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
      html,body{margin:0;padding:0;background:var(--bg-page);min-height:100%}
      .app-shell{min-height:100vh;min-height:100dvh}
      .main-content{min-height:100vh;min-height:100dvh}
      body{letter-spacing:-0.011em}
      .app-bg-layer{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
      .app-bg-layer .orb{position:absolute;border-radius:50%;filter:blur(60px)}
      .app-bg-mark{position:fixed;pointer-events:none;z-index:0}
      [data-theme="light"] .app-bg-mark{opacity:0.035}
      [data-theme="dark"] .app-bg-mark{opacity:0.05}
      [data-theme="light"] .orb-green{background:radial-gradient(circle,rgba(30,158,99,0.10),transparent 70%)}
      [data-theme="dark"] .orb-green{background:radial-gradient(circle,rgba(61,214,140,0.08),transparent 70%)}
      [data-theme="light"] .orb-indigo{background:radial-gradient(circle,rgba(91,91,214,0.07),transparent 70%)}
      [data-theme="dark"] .orb-indigo{background:radial-gradient(circle,rgba(139,139,240,0.06),transparent 70%)}
      h1,h2,h3{letter-spacing:-0.022em}
      @keyframes spin{to{transform:rotate(360deg)}}
      @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      @keyframes slideUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
      @keyframes cardExpand{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
      @keyframes scaleIn{from{opacity:0;transform:scale(0.97)}to{opacity:1;transform:scale(1)}}
      @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
      .skeleton{background:linear-gradient(90deg,var(--bg-subtle) 25%,var(--bg-subtle2) 50%,var(--bg-subtle) 75%);background-size:200% 100%;animation:shimmer 1.4s ease-in-out infinite;border-radius:8px}
      @keyframes typingDot{0%,60%,100%{opacity:0.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
      .stagger-in{animation:slideUp 0.5s cubic-bezier(0.16,1,0.3,1) backwards}
      @keyframes donutSeg{from{stroke-dasharray:0 9999}to{stroke-dasharray:var(--len) var(--gap)}}
      @keyframes barGrow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
      ::-webkit-scrollbar{width:8px;height:8px}
      ::-webkit-scrollbar-track{background:transparent}
      ::-webkit-scrollbar-thumb{background:var(--bg-subtle2);border-radius:99px;border:2px solid transparent;background-clip:padding-box}
      ::-webkit-scrollbar-thumb:hover{background:var(--text-muted);background-clip:padding-box}
      ::selection{background:var(--green-light);color:var(--green-deep)}
      html{scroll-behavior:smooth}
      .num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
      *:focus{outline:none}
      *:focus-visible{outline:2px solid var(--green);outline-offset:2px;border-radius:4px}
      @media (prefers-reduced-motion: reduce){
        *,*::before,*::after{animation-duration:0.001ms!important;animation-iteration-count:1!important;transition-duration:0.001ms!important;scroll-behavior:auto!important}
      }
      input,textarea,select{font-family:'Plus Jakarta Sans','Helvetica Neue',sans-serif!important}
      input:focus,textarea:focus,select:focus{border-color:var(--green-dark)!important;box-shadow:0 0 0 3px var(--green-light)!important}
      input,textarea,select{transition:border-color 0.15s,box-shadow 0.15s}
      button{transition:all 0.18s cubic-bezier(0.16,1,0.3,1)!important}
      details summary::-webkit-details-marker{display:none}
      .card-hover{transition:transform 0.2s cubic-bezier(0.16,1,0.3,1),box-shadow 0.2s,border-color 0.2s}
      .card-hover:hover{transform:translateY(-2px);box-shadow:var(--shadow-md);border-color:var(--border-solid)}
      @media(max-width:768px){.desktop-only{display:none!important}.mobile-only{display:flex!important}}
      @media(min-width:769px){.mobile-only{display:none!important}.desktop-only{display:flex!important}}
      @media print{
        .no-print{display:none!important}
        body{background:white!important}
        .print-only{display:block!important}
        @page{margin:15mm;size:A4}
      }
      .print-only{display:none}
      `}</style>

      {/* Toast */}
      {toast&&(
        <div style={{position:"fixed",top:isMobile?16:24,right:isMobile?16:24,left:isMobile?16:"auto",zIndex:9999,background:toast.type==="warn"?"var(--amber-light)":"var(--sidebar-bg)",color:toast.type==="warn"?"var(--amber)":"white",padding:"13px 20px",borderRadius:"var(--radius-md)",fontSize:14,fontWeight:600,letterSpacing:"-0.01em",boxShadow:"var(--shadow-lg)",display:"flex",alignItems:"center",gap:10,animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)",border:"1px solid",borderColor:toast.type==="warn"?"var(--amber)":"rgba(255,255,255,0.08)",maxWidth:360}}>
          <span style={{flexShrink:0,display:"inline-flex"}}>{toast.type==="warn"
            ?<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/><circle cx="12" cy="12" r="10"/></svg>
            :<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3DD68C" strokeWidth="2.6" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}</span>
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Desktop sidebar */}
      {!isMobile&&(
        <div style={{position:"fixed",top:0,left:0,bottom:0,width:240,background:"var(--sidebar-bg)",display:"flex",flexDirection:"column",zIndex:100,borderRight:"1px solid var(--sidebar-border)"}}>
          <div onClick={()=>setView("dashboard")} style={{padding:"20px 20px 16px",borderBottom:"1px solid var(--sidebar-border)",display:"flex",alignItems:"center",gap:10,cursor:"pointer"}} title="Back to dashboard">
            <div style={{width:32,height:32,background:"linear-gradient(135deg,#1E9E63,#15824F)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="3" height="14" rx="1.5" fill="white"/><rect x="6" y="3" width="8" height="3" rx="1.5" fill="white"/><rect x="14" y="3" width="3" height="8" rx="1.5" fill="white"/><rect x="6" y="10" width="8" height="3" rx="1.5" fill="rgba(255,255,255,0.45)"/><circle cx="16.5" cy="15.5" r="2" fill="white"/></svg>
            </div>
            <span style={{fontSize:16,fontWeight:800,color:"white",fontFamily:"inherit"}}>Pro<span style={{color:"#1E9E63"}}>Qure</span></span>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"12px 12px"}}>
            <div style={{fontSize:10,color:"var(--sidebar-text)",letterSpacing:"0.1em",textTransform:"uppercase",fontWeight:600,marginBottom:8,paddingLeft:4,opacity:0.7}}>Navigation</div>
            {navItems.filter(item=>!item.min||roleRank(myRole)>=item.min).map(item=>(
              <button key={item.id} onClick={()=>handleNav(item.id)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:"0 8px 8px 0",border:"none",background:view===item.id?"var(--sidebar-activebg)":"transparent",color:view===item.id?"var(--sidebar-active)":"var(--sidebar-text)",cursor:"pointer",fontSize:13,fontWeight:view===item.id?600:400,marginBottom:1,textAlign:"left",borderLeft:view===item.id?"3px solid var(--sidebar-active)":"3px solid transparent",transition:"all 0.2s cubic-bezier(0.16,1,0.3,1)"}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={item.d}/></svg>
                {item.label}
                {item.id==="orders"&&pendingOrders>0&&(
                  <span style={{marginLeft:"auto",background:"var(--green)",color:"white",fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:99}}>{pendingOrders}</span>
                )}
              </button>
            ))}
          </div>
          <div style={{padding:"14px 20px",borderTop:"1px solid var(--sidebar-border)"}}>
            <button onClick={()=>handleNav("contact")} aria-label="Send feedback" title="Send feedback" style={{width:"100%",display:"flex",alignItems:"center",gap:8,background:"transparent",border:"1px solid var(--sidebar-border)",borderRadius:"var(--radius-sm)",padding:"9px 14px",cursor:"pointer",marginBottom:8,color:"var(--sidebar-text)"}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
              <span style={{fontSize:13,fontWeight:600}}>Send feedback</span>
            </button>
            <button onClick={toggleDark} aria-label="Toggle dark mode" title="Toggle dark mode" style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--bg-subtle2)",border:"1px solid var(--sidebar-border)",borderRadius:"var(--radius-sm)",padding:"9px 14px",cursor:"pointer",marginBottom:8}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  {darkMode
                    ?<><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></>
                    :<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  }
                </svg>
                <span style={{fontSize:12,color:darkMode?"#FCD34D":"#6B7280",fontWeight:500}}>{darkMode?"Light mode":"Dark mode"}</span>
              </div>
              <div style={{width:38,height:22,background:darkMode?"var(--green)":"rgba(255,255,255,0.12)",borderRadius:11,position:"relative",transition:"background 0.3s",flexShrink:0}}>
                <div style={{position:"absolute",top:3,left:darkMode?19:3,width:16,height:16,background:"white",borderRadius:"50%",transition:"left 0.3s",boxShadow:"0 1px 4px rgba(0,0,0,0.4)"}}/>
              </div>
            </button>
            {session && cloudEnabled && (
              <button onClick={async()=>{ try{ await supabase.auth.signOut(); }catch{} window.location.reload(); }} aria-label="Sign out" title="Sign out"
                style={{width:"100%",display:"flex",alignItems:"center",gap:8,background:"transparent",border:"1px solid var(--sidebar-border)",borderRadius:"var(--radius-sm)",padding:"9px 14px",cursor:"pointer",marginBottom:8,color:"var(--sidebar-text)"}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
                <span style={{fontSize:13,fontWeight:600}}>Sign out</span>
              </button>
            )}
      
          </div>
        </div>
      )}

      {/* Mobile top bar */}
      {isMobile&&(
        <div style={{position:"fixed",top:0,left:0,right:0,height:60,background:"var(--topbar-bg)",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 16px",zIndex:100,borderBottom:"1px solid var(--sidebar-border)"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:28,height:28,background:"linear-gradient(135deg,#1E9E63,#15824F)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="3" height="14" rx="1.5" fill="white"/><rect x="6" y="3" width="8" height="3" rx="1.5" fill="white"/><rect x="14" y="3" width="3" height="8" rx="1.5" fill="white"/><rect x="6" y="10" width="8" height="3" rx="1.5" fill="rgba(255,255,255,0.45)"/><circle cx="16.5" cy="15.5" r="2" fill="white"/></svg>
            </div>
            <span style={{fontSize:15,fontWeight:800,color:"white"}}>Pro<span style={{color:"#1E9E63"}}>Qure</span></span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <button onClick={toggleDark} aria-label="Toggle dark mode" title="Toggle dark mode" style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:8,padding:"6px 10px",cursor:"pointer",color:"white",fontSize:13}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">{darkMode?<><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></>:<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>}</svg></button>
          </div>
        </div>
      )}

      {/* Main content */}
      <div style={{marginLeft:isMobile?0:240,padding:isMobile?"76px 16px 88px":"32px 40px",animation:"fadeIn 0.2s ease",position:"relative",zIndex:1}} className="main-content">

        {view==="dashboard"&&(
          <div style={{animation:"fadeIn 0.25s ease",maxWidth:1280}}>

            {/* Buyer notification: lists issued by engineers, awaiting action */}
            {can.sendRFQ(myRole)&&liveRequests.filter(r=>r.status==="awaiting-buyer").length>0&&(
              <div onClick={()=>setView("requests")} style={{cursor:"pointer",background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderLeft:"4px solid #4A4AB8",borderRadius:"var(--radius-md)",padding:"14px 18px",marginBottom:20,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div><div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)"}}>{liveRequests.filter(r=>r.status==="awaiting-buyer").length} materials list{liveRequests.filter(r=>r.status==="awaiting-buyer").length!==1?"s":""} waiting for you</div><div style={{fontSize:12,color:"var(--text-secondary)"}}>Issued by an engineer - ready for you to send the RFQ</div></div>
                <span style={{fontSize:12,fontWeight:600,color:"#4A4AB8"}}>View &rarr;</span>
              </div>
            )}

            {/* Manager notification: POs awaiting approval */}
            {roleRank(myRole)>=3&&liveRequests.filter(r=>r.status==="awaiting-approval").length>0&&(
              <div onClick={()=>setView("requests")} style={{cursor:"pointer",background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderLeft:"4px solid #9A5B16",borderRadius:"var(--radius-md)",padding:"14px 18px",marginBottom:20,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div><div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)"}}>{liveRequests.filter(r=>r.status==="awaiting-approval").length} purchase order{liveRequests.filter(r=>r.status==="awaiting-approval").length!==1?"s":""} awaiting your approval</div><div style={{fontSize:12,color:"var(--text-secondary)"}}>A buyer has selected a quote - review and approve to issue the PO</div></div>
                <span style={{fontSize:12,fontWeight:600,color:"#9A5B16"}}>Review &rarr;</span>
              </div>
            )}

            {/* Hero */}
            <div className="stagger-in" style={{background:"linear-gradient(140deg,#101013 0%,#1a1a20 55%,#15211b 100%)",borderRadius:"var(--radius-lg)",padding:isMobile?"26px 24px":"40px 44px",marginBottom:24,position:"relative",overflow:"hidden",boxShadow:"0 1px 2px rgba(0,0,0,0.1), 0 20px 50px rgba(16,16,19,0.25)",border:"1px solid rgba(255,255,255,0.04)"}}>
              <div style={{position:"absolute",top:-80,right:-80,width:340,height:340,background:"radial-gradient(circle,rgba(61,214,140,0.18) 0%,transparent 65%)",borderRadius:"50%",pointerEvents:"none"}}/>
              <div style={{position:"absolute",bottom:-120,left:-60,width:280,height:280,background:"radial-gradient(circle,rgba(91,91,214,0.10) 0%,transparent 70%)",borderRadius:"50%",pointerEvents:"none"}}/>
              <div style={{position:"relative",zIndex:1,display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:16}}>
                <div>
                  <div style={{fontSize:11,fontWeight:600,color:"#5BE3A0",letterSpacing:"0.18em",textTransform:"uppercase",marginBottom:8}}>{new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</div>
                  <h1 style={{fontSize:isMobile?27:38,fontWeight:800,letterSpacing:"-0.03em",margin:0,color:"white",lineHeight:1.1,marginBottom:10}}>Good {new Date().getHours()<12?"morning":new Date().getHours()<17?"afternoon":"evening"}</h1>
                  <p style={{fontSize:isMobile?13:15,color:"rgba(148,163,184,0.9)",margin:0,lineHeight:1.6}}>
                    {requests.length===0?"Welcome to ProQure - create your first material request to get started":`You have ${stats.pending} pending quote${stats.pending!==1?"s":""} waiting${stats.received>0?` and ${stats.received} ready to analyse`:""}.`}
                  </p>
                </div>
                <button aria-label="Voice input" title="Tap to speak your list" onClick={()=>{setView("new");resetNewRequest();}} style={{display:"flex",alignItems:"center",gap:8,background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:14,padding:isMobile?"11px 18px":"14px 26px",fontSize:isMobile?13:15,fontWeight:700,cursor:"pointer",boxShadow:"0 4px 24px rgba(34,197,94,0.4)",flexShrink:0}}>
                  + New request
                </button>
              </div>
            </div>

            {/* First-run welcome - only when no activity yet */}
            {requests.length===0&&orders.length===0&&(
              <div className="stagger-in" style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:isMobile?"22px":"28px 32px",marginBottom:24,boxShadow:"var(--shadow-sm)",animationDelay:"0.1s"}}>
                <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
                  <div style={{width:42,height:42,borderRadius:12,background:"linear-gradient(135deg,#1E9E63,#15824F)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    <Icon name="wave" size={22} color="white"/>
                  </div>
                  <div>
                    <div style={{fontSize:17,fontWeight:800,color:"var(--text-primary)",letterSpacing:"-0.02em"}}>Welcome to ProQure</div>
                    <div style={{fontSize:13,color:"var(--text-secondary)"}}>Three quick steps to your first purchase order.</div>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr 1fr",gap:12,marginBottom:18}}>
                  {[
                    {n:"1",t:"Create a request",d:"Speak, type, photograph or import your material list.",ic:"mic"},
                    {n:"2",t:"Send to suppliers",d:"ProQure emails a branded RFQ to your chosen suppliers.",ic:"send"},
                    {n:"3",t:"Analyse & approve",d:"Let the AI compare the quotes, then approve the best.",ic:"check_circle"},
                  ].map(s=>(
                    <div key={s.n} style={{background:"var(--bg-subtle)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"16px 18px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:8}}>
                        <div style={{width:24,height:24,borderRadius:"50%",background:"var(--green-mint)",color:"var(--green-dark)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,flexShrink:0}}>{s.n}</div>
                        <Icon name={s.ic} size={16} color="var(--green-dark)"/>
                      </div>
                      <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:3}}>{s.t}</div>
                      <div style={{fontSize:12,color:"var(--text-secondary)",lineHeight:1.5}}>{s.d}</div>
                    </div>
                  ))}
                </div>
                <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
                  <button onClick={()=>{setView("new");resetNewRequest();}} style={{background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"11px 22px",fontSize:13,fontWeight:700,cursor:"pointer",boxShadow:"0 2px 8px rgba(30,158,99,0.25)"}}>Create your first request</button>
                  
                </div>
              </div>
            )}

            {/* Overdue banner */}
            {overdueRequests.length>0&&(
              <div style={{background:"#FFF7ED",border:"1px solid #FED7AA",borderRadius:14,padding:"14px 20px",marginBottom:20}}>
                <div style={{fontSize:13,fontWeight:700,color:"#9A3412",marginBottom:10}}>Suppliers have not responded yet</div>
                {overdueRequests.map(r=>{
                  const sentEntry = r.activity?.find(a=>a.action==="RFQ emails sent")||r.activity?.find(a=>a.action==="Created");
                  const hoursAgo = sentEntry?Math.floor((Date.now()-new Date(sentEntry.ts).getTime())/3600000):0;
                  const daysAgo = Math.floor(hoursAgo/24);
                  const pendingSups = (r.sentTo||[]).filter(s=>!s.saved).map(s=>s.name);
                  return(
                    <div key={r.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #FED7AA"}}>
                      <div>
                        <span style={{fontSize:13,fontWeight:600,color:"#7C2D12"}}>{r.jobRef}</span>
                        <span style={{fontSize:12,color:"#C2410C",marginLeft:8}}>{pendingSups.length>0?`${pendingSups.join(", ")} hasn't responded`:"No quotes received"}</span>
                        <span style={{fontSize:11,color:"#EA580C",marginLeft:8}}>{daysAgo>0?`${daysAgo}d ago`:`${hoursAgo}h ago`}</span>
                      </div>
                      <button onClick={()=>{setActiveReq(r);setView("quotes");}} style={{fontSize:11,color:"#EA580C",background:"#FEF3C7",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontWeight:600}}>View</button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Hire due-back / overdue reminder */}
            {(()=>{
              const onHire = hires.filter(h=>h.status==="on-hire");
              const flagged = onHire.filter(h=>{ if(h.returnOpen){ const d=h.deliveredDate?(Date.now()-new Date(h.deliveredDate))/(1000*60*60*24):0; return d>=21; } if(!h.returnDate)return false; const days=(new Date(h.returnDate)-new Date())/(1000*60*60*24); return days<=7; });
              if(flagged.length===0) return null;
              return (
                <div style={{background:"#FFF7ED",border:"1px solid #FED7AA",borderRadius:14,padding:"14px 20px",marginBottom:20}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#9A3412",marginBottom:10}}>Hire equipment to review - extend or off-hire?</div>
                  {flagged.map(h=>{
                    const overdue = !h.returnOpen && h.returnDate && (new Date(h.returnDate)<new Date());
                    const wk = hireWeeks(h);
                    return (
                      <div key={h.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #FED7AA"}}>
                        <div>
                          <span style={{fontSize:13,fontWeight:600,color:"#7C2D12"}}>{h.description}</span>
                          <span style={{fontSize:12,color:"#C2410C",marginLeft:8}}>{h.supplier||"supplier"}{h.site?` · ${h.site}`:""}</span>
                          <span style={{fontSize:11,color:"#EA580C",marginLeft:8}}>{h.returnOpen?`open hire · ${wk}wk on`:overdue?"overdue":`due ${new Date(h.returnDate).toLocaleDateString("en-GB")}`}</span>
                        </div>
                        <button onClick={()=>setView("hire")} style={{fontSize:11,color:"#EA580C",background:"#FEF3C7",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontWeight:600}}>Review</button>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* Expiring quotes banner */}
            {expiringQuotes.length>0&&(
              <div style={{background:"#FFF7ED",border:"1px solid #FED7AA",borderRadius:14,padding:"14px 20px",marginBottom:20}}>
                <div style={{fontSize:13,fontWeight:700,color:"#9A3412",marginBottom:8}}>
                  {expiringQuotes.length} quote{expiringQuotes.length!==1?"s":""} expiring soon
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                  {expiringQuotes.map(q=>{
                    const daysLeft = Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000);
                    return(
                      <span key={q.id} style={{fontSize:11,padding:"3px 10px",borderRadius:99,background:daysLeft<=0?"var(--red-light)":daysLeft<=2?"var(--amber-light)":"#FEF3C7",color:daysLeft<=0?"var(--red)":daysLeft<=2?"var(--amber)":"#92400E",fontWeight:600}}>
                        {q.supplierName} · {q.jobRef} · {daysLeft<=0?"Expired":`${daysLeft}d left`}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Budget tracking */}
            {budgetJobs.length>0&&(
              <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"18px 22px",marginBottom:20,boxShadow:"var(--shadow-sm)"}}>
                <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:14}}>Budget tracking</div>
                <div style={{display:"flex",flexDirection:"column",gap:14}}>
                  {budgetJobs.map(b=>{
                    const over = b.actual>b.budget;
                    const barColor = over?"var(--red)":b.pct>=85?"var(--amber)":"var(--green-dark)";
                    return(
                      <div key={b.id}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:5}}>
                          <span style={{fontSize:13,fontWeight:600,color:"var(--text-primary)"}}>{b.jobRef}</span>
                          <span style={{fontSize:12,fontFamily:"'JetBrains Mono',monospace",color:over?"var(--red)":"var(--text-secondary)"}}>
                            £{fmtMoney(b.actual)} / £{fmtMoney(b.budget)}
                            {over&&<span style={{marginLeft:8,fontWeight:700,color:"var(--red)"}}>over by £{fmtMoney(b.actual-b.budget)}</span>}
                          </span>
                        </div>
                        <div style={{height:8,background:"var(--bg-subtle2)",borderRadius:99,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${Math.min(100,b.pct)}%`,background:barColor,borderRadius:99,transition:"width 0.4s"}}/>
                        </div>
                        <div style={{fontSize:10,color:"var(--text-tertiary)",marginTop:3}}>{b.pct}% of budget used{b.actual===0?" · no orders approved yet":""}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Spend by trade chart */}
            {spendByTrade.length>0&&(
              <div className="stagger-in" style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"20px 24px",marginBottom:20,boxShadow:"var(--shadow-sm)",animationDelay:"0.15s"}}>
                <div style={{fontSize:15,fontWeight:700,color:"var(--text-primary)",marginBottom:16}}>Spend by trade</div>
                <div style={{display:"flex",flexDirection:"column",gap:12}}>
                  {spendByTrade.map(s=>{
                    const pct = maxTradeSpend>0?Math.round(s.total/maxTradeSpend*100):0;
                    const tradeColors={Plumbing:"#5B5BD6",HVAC:"#1E9E63",Electrical:"#C77D2E",Mechanical:"#7E6DD6",Ventilation:"#2BB873",Gas:"#D14343",Other:"#908F86"};
                    const col=tradeColors[s.trade]||"#5B5BD6";
                    return(
                      <div key={s.trade}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                          <span style={{fontSize:13,fontWeight:600,color:"var(--text-primary)"}}>{s.trade}</span>
                          <span style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace"}} className="num">£{s.total.toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        </div>
                        <div style={{height:10,background:"var(--bg-subtle2)",borderRadius:99,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${pct}%`,background:col,borderRadius:99,transition:"width 0.5s cubic-bezier(0.16,1,0.3,1)"}}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Stat cards */}
            <div style={{display:"grid",gridTemplateColumns:isMobile?"repeat(2,1fr)":"repeat(4,1fr)",gap:isMobile?10:14,marginBottom:isMobile?18:24}}>
              {[
                {label:"Total requests",  value:stats.total,    accent:"var(--indigo)", tint:"var(--indigo-light)", icon:"clipboard", sub:"across all jobs", nav:()=>setView("requests")},
                {label:"Awaiting quotes", value:stats.pending,  accent:"var(--amber)",  tint:"var(--amber-light)",  icon:"clock", sub:"need supplier quotes", nav:()=>setView("quotes")},
                {label:"Quotes received", value:stats.received, accent:"var(--violet)", tint:"var(--violet-light)", icon:"inbox", sub:"ready to compare", nav:()=>{setView("quotes");}},
                {label:"Approved POs",    value:stats.approved, accent:"var(--green)",  tint:"var(--green-light)",  icon:"check_circle", sub:"sent to suppliers", nav:()=>setView("orders")},
              ].map((s,si)=>(
                <button key={s.label} onClick={s.nav} title={`View ${s.label.toLowerCase()}`} aria-label={`View ${s.label.toLowerCase()}`} className="stagger-in" style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-md)",padding:isMobile?"16px 16px 14px":"18px 20px 16px",border:"1px solid var(--border)",boxShadow:"var(--shadow-sm)",textAlign:"left",cursor:"pointer",width:"100%",display:"block",transition:"transform 0.2s cubic-bezier(0.16,1,0.3,1),box-shadow 0.2s,border-color 0.2s",animationDelay:`${si*0.05}s`}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor=s.accent;e.currentTarget.style.boxShadow="var(--shadow-md)";e.currentTarget.style.transform="translateY(-3px)";}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.boxShadow="var(--shadow-sm)";e.currentTarget.style.transform="translateY(0)";}}>
                  <div style={{width:isMobile?34:38,height:isMobile?34:38,borderRadius:11,background:s.tint,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:isMobile?10:14}}>
                    <Icon name={s.icon} size={isMobile?17:19} color={s.accent}/>
                  </div>
                  <div style={{fontSize:isMobile?26:34,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",lineHeight:1,letterSpacing:"-0.02em",color:s.value>0?"var(--text-primary)":"var(--text-muted)"}} className="num"><CountUp value={s.value}/></div>
                  <div style={{fontSize:12.5,color:"var(--text-secondary)",fontWeight:600,marginTop:7}}>{s.label}</div>
                  <div style={{fontSize:11.5,color:"var(--text-tertiary)",marginTop:2}}>{s.sub}</div>
                </button>
              ))}
            </div>

            {/* Insights: pipeline donut + activity trend */}
            {(pipelineTotal>0 || activityWeekTotal>0) && (
              <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?12:16,marginBottom:isMobile?18:24}}>
                {pipelineTotal>0 && (
                  <div className="stagger-in" style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"20px 24px",boxShadow:"var(--shadow-sm)",animationDelay:"0.1s"}}>
                    <div style={{fontSize:14,fontWeight:700,color:"var(--text-primary)"}}>Procurement pipeline</div>
                    <div style={{fontSize:11.5,color:"var(--text-tertiary)",marginBottom:14}}>Where your live requests sit right now</div>
                    <div style={{display:"flex",alignItems:"center",gap:20,flexWrap:"wrap"}}>
                      <div style={{position:"relative",width:132,height:132,flexShrink:0}}>
                        <svg width="132" height="132" viewBox="0 0 120 120" style={{transform:"rotate(-90deg)"}}>
                          <circle cx="60" cy="60" r="44" fill="none" stroke="var(--bg-subtle2)" strokeWidth="15"/>
                          {(()=>{ const C=2*Math.PI*44; let acc=0; return pipeline.map((p,i)=>{ const len=p.value/pipelineTotal*C; const off=acc; acc+=len; return (
                            <circle key={p.label} cx="60" cy="60" r="44" fill="none" stroke={p.color} strokeWidth="15" strokeLinecap="butt"
                              strokeDasharray="0 9999" strokeDashoffset={-off}
                              style={{"--len":`${len}px`,"--gap":`${C-len}px`,animation:`donutSeg 0.85s cubic-bezier(0.16,1,0.3,1) ${0.15+i*0.12}s forwards`}}/>
                          ); }); })()}
                        </svg>
                        <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
                          <div style={{fontSize:26,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--text-primary)",lineHeight:1}} className="num"><CountUp value={pipelineTotal}/></div>
                          <div style={{fontSize:9,color:"var(--text-tertiary)",textTransform:"uppercase",letterSpacing:"0.1em",marginTop:3}}>live</div>
                        </div>
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:10,flex:1,minWidth:120}}>
                        {pipeline.map(p=>(
                          <div key={p.label} style={{display:"flex",alignItems:"center",gap:9}}>
                            <span style={{width:10,height:10,borderRadius:3,background:p.color,flexShrink:0}}/>
                            <span style={{fontSize:12.5,color:"var(--text-secondary)",flex:1}}>{p.label}</span>
                            <span style={{fontSize:13,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--text-primary)"}}>{p.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                {activityWeekTotal>0 && (
                  <div className="stagger-in" style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"20px 24px",boxShadow:"var(--shadow-sm)",animationDelay:"0.15s"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                      <div style={{fontSize:14,fontWeight:700,color:"var(--text-primary)"}}>Activity this week</div>
                      <div style={{fontSize:13,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--green-dark)"}}>{activityWeekTotal}</div>
                    </div>
                    <div style={{fontSize:11.5,color:"var(--text-tertiary)",marginBottom:16}}>Actions across the last 7 days</div>
                    <div style={{display:"flex",alignItems:"flex-end",gap:isMobile?6:9,height:96}}>
                      {activityWeek.map((d,i)=>{ const h=Math.round(d.count/activityWeekMax*100); const today=i===6; return (
                        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:7,height:"100%",justifyContent:"flex-end"}}>
                          <div title={`${d.count} event${d.count!==1?"s":""}`} style={{width:"100%",maxWidth:34,height:`${d.count>0?Math.max(14,h):4}%`,background:d.count>0?(today?"linear-gradient(180deg,#1E9E63,#15824F)":"rgba(30,158,99,0.45)"):"var(--bg-subtle2)",borderRadius:6,transformOrigin:"bottom",animation:`barGrow 0.55s cubic-bezier(0.16,1,0.3,1) ${0.2+i*0.06}s backwards`}}/>
                          <span style={{fontSize:10,color:today?"var(--green-dark)":"var(--text-muted)",fontWeight:today?700:500}}>{d.label}</span>
                        </div>
                      ); })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Quick actions */}
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:isMobile?8:12,marginBottom:isMobile?18:24}}>
              {[
                {label:"New request",  sub:"Voice or type",         icon:"mic", action:()=>{setView("new");resetNewRequest();}, accent:"#5B5BD6"},
                {label:"Analyse",      sub:"Compare quotes",        icon:"search", action:()=>{setView("quotes");}, accent:"#7E6DD6"},
                {label:"Orders",       sub:`${orders.filter(o=>o.status==="pending-send").length} ready to send`, icon:"package", action:()=>setView("orders"), accent:"#1E9E63"},
                ...(can.raisePO(myRole) ? [{label:"Quick PO", sub:"Phone-agreed order", icon:"clock", action:()=>setQuickPO({items:[{description:"",quantity:"",unitPrice:""}]}), accent:"#D97706"}] : [{label:"Measure", sub:"Estimate materials", icon:"ruler", action:()=>setView("measure"), accent:"#C77D2E"}]),
              ].map((q,qi)=>(
                <button key={q.label} onClick={q.action} className="stagger-in" style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:8,padding:isMobile?"14px 16px":"18px 22px",background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",cursor:"pointer",textAlign:"left",boxShadow:"var(--shadow-sm)",transition:"transform 0.2s cubic-bezier(0.16,1,0.3,1),box-shadow 0.2s",position:"relative",overflow:"hidden",minHeight:isMobile?90:104,animationDelay:`${0.2+qi*0.04}s`}}
                  onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-3px)";e.currentTarget.style.boxShadow="var(--shadow-md)";}}
                  onMouseLeave={e=>{e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.boxShadow="var(--shadow-sm)";}}>
                  <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:q.accent,borderRadius:"var(--radius-lg) var(--radius-lg) 0 0"}}/>
                  <div style={{marginTop:2,display:"flex"}}><Icon name={q.icon} size={20} color={q.accent}/></div>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:2}}>{q.label}</div>
                    <div style={{fontSize:11,color:"var(--text-tertiary)",lineHeight:1.4}}>{q.sub}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* Recent requests */}
            {requests.length>0&&(
              <div className="stagger-in" style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",overflow:"hidden",boxShadow:"var(--shadow-sm)",animationDelay:"0.35s"}}>
                <div style={{padding:"18px 24px",borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",alignItems:"center",background:darkMode?"rgba(34,197,94,0.04)":"linear-gradient(135deg,#FAFFFE,#F0FDF4)"}}>
                  <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)"}}>Recent requests</div>
                  <button onClick={()=>setView("requests")} style={{fontSize:12,color:"var(--indigo)",background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View all</button>
                </div>
                {requests.slice(0,8).map((r,idx)=>{
                  const sc = STATUS[r.status]||STATUS.draft;
                  return(
                    <div key={r.id}
                      onClick={()=>{setActiveReq(r);setView("quotes");}}
                      onMouseEnter={e=>e.currentTarget.style.background=darkMode?"rgba(34,197,94,0.04)":"rgba(34,197,94,0.02)"}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}
                      style={{display:"flex",alignItems:"center",gap:16,padding:"12px 24px",borderTop:idx===0?"none":"1px solid var(--border)",cursor:"pointer",transition:"background 0.15s"}}>
                      <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",minWidth:80,fontFamily:"'JetBrains Mono',monospace"}}>{r.id}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:500,color:"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.jobRef}</div>
                        <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.site} · {r.trade}</div>
                      </div>
                      <div>
                        <Badge bg={sc.bg} text={sc.text}>{sc.label}</Badge>
                        {r.rfqDeadline&&r.status==="pending"&&(
                          <div style={{fontSize:10,marginTop:3,color:Math.ceil((new Date(r.rfqDeadline).getTime()-Date.now())/86400000)<=0?"var(--red)":Math.ceil((new Date(r.rfqDeadline).getTime()-Date.now())/86400000)<=1?"var(--amber)":"var(--green-dark)",fontWeight:600}}>
                            {Math.ceil((new Date(r.rfqDeadline).getTime()-Date.now())/86400000)<=0?"Deadline passed":`${Math.ceil((new Date(r.rfqDeadline).getTime()-Date.now())/86400000)}d left`}
                          </div>
                        )}
                      </div>
                      <div style={{fontSize:11,color:"var(--text-muted)",flexShrink:0}}>{r.created}</div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Recent activity feed */}
            {activityLog.length>0&&(
              <div className="stagger-in" style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",overflow:"hidden",boxShadow:"var(--shadow-sm)",marginTop:20,animationDelay:"0.4s"}}>
                <div style={{padding:"18px 24px",borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{fontSize:15,fontWeight:700,color:"var(--text-primary)"}}>Recent activity</div>
                  <span style={{fontSize:11,color:"var(--text-tertiary)"}}>{activityLog.length} event{activityLog.length!==1?"s":""}</span>
                </div>
                <div style={{maxHeight:340,overflowY:"auto"}}>
                  {activityLog.slice(0,40).map((a,i)=>{
                    const iconMap = {
                      "RFQ sent":"send","Quotes analysed":"search","PO approved & generated":"check_circle","Order sent":"package","Order confirmed":"check","Order delivered":"flag","Confirmation uploaded":"paperclip","Draft PO saved":"edit","Deleted":"trash","Edited":"edit","Approval undone":"undo","Document attached":"paperclip","Supplier confirmation attached":"paperclip","Supplier added":"building","Library quote removed":"trash"};
                    const iconName = iconMap[a.action]||"clipboard";
                    const when = new Date(a.ts);
                    const mins = Math.floor((Date.now()-when.getTime())/60000);
                    const timeLabel = mins<1?"just now":mins<60?`${mins}m ago`:mins<1440?`${Math.floor(mins/60)}h ago`:when.toLocaleDateString("en-GB",{day:"numeric",month:"short"});
                    return(
                      <div key={a.id||i} style={{display:"flex",gap:12,padding:"12px 24px",borderBottom:i<activityLog.slice(0,40).length-1?"1px solid var(--border)":"none",alignItems:"flex-start"}}>
                        <div style={{width:30,height:30,borderRadius:8,background:"var(--bg-subtle)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={iconName} size={15} color="var(--text-secondary)"/></div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)"}}>{a.action}</div>
                          <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:1,overflow:"hidden",textOverflow:"ellipsis"}}>{a.detail}</div>
                        </div>
                        <div style={{fontSize:11,color:"var(--text-muted)",flexShrink:0,whiteSpace:"nowrap"}}>{timeLabel}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {requests.length===0&&(
              <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"40px 32px",textAlign:"center",boxShadow:"var(--shadow-sm)"}}>
                <div style={{marginBottom:16,display:"flex",justifyContent:"center"}}><svg width="40" height="40" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="3" height="14" rx="1.5" fill="var(--green-dark)"/><rect x="6" y="3" width="8" height="3" rx="1.5" fill="var(--green-dark)"/><rect x="14" y="3" width="3" height="8" rx="1.5" fill="var(--green-dark)"/><rect x="6" y="10" width="8" height="3" rx="1.5" fill="var(--green)"/><circle cx="16.5" cy="15.5" r="2" fill="var(--green-dark)"/></svg></div>
                <div style={{fontSize:16,fontWeight:600,color:"var(--text-primary)",marginBottom:8}}>Ready to get started</div>
                <div style={{fontSize:14,color:"var(--text-secondary)",marginBottom:24}}>Create your first material request to start procuring with AI</div>
                <button onClick={()=>{setView("new");resetNewRequest();}} style={{background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:"var(--radius-md)",padding:"12px 28px",fontSize:14,fontWeight:700,cursor:"pointer"}}>Create first request</button>
              </div>
            )}
          </div>
        )}

        {view==="new"&&(
          <div className="stagger-in" style={{maxWidth:860}}>
            <div style={{marginBottom:24}}>
              <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",margin:0,color:"var(--text-primary)"}}>New material request</h1>
              <p style={{fontSize:14,color:"var(--text-secondary)",marginTop:4}}>Step {step} of 3 - {step===1?"Describe your materials":step===2?"Review and configure":"Review and send"}</p>
            </div>

            {/* Step indicator */}
            <div style={{display:"flex",alignItems:"center",marginBottom:24,gap:0}}>
              {[{n:1,l:"Describe"},{n:2,l:"Review"},{n:3,l:"Send"}].map((s,i)=>(
                <div key={s.n} style={{display:"flex",alignItems:"center",flex:i<2?1:"none"}}>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                    <div style={{width:32,height:32,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,background:step>=s.n?"var(--green-dark)":"var(--bg-subtle2)",color:step>=s.n?"white":"var(--text-muted)",boxShadow:step===s.n?"0 0 0 4px var(--green-light)":"none",transition:"all 0.3s cubic-bezier(0.16,1,0.3,1)"}}>{step>s.n?<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>:s.n}</div>
                    <span style={{fontSize:11,color:step===s.n?"var(--green-dark)":"var(--text-muted)",fontWeight:step===s.n?600:400}}>{s.l}</span>
                  </div>
                  {i<2&&<div style={{flex:1,height:2,background:step>s.n?"var(--green-dark)":"var(--bg-subtle2)",margin:"0 4px",marginBottom:14}}/>}
                </div>
              ))}
            </div>

            {step===1&&(
              <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"24px",boxShadow:"var(--shadow-sm)"}}>
                <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr 1fr",gap:12,marginBottom:20}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Job reference</label>
                    <input value={jobRef} onChange={e=>setJobRef(e.target.value)} list="dl-jobrefs" placeholder="e.g. JOB-2025-012" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    <datalist id="dl-jobrefs">{pastJobRefs.map(v=><option key={v} value={v}/>)}</datalist>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Site / Location</label>
                    <input value={site} onChange={e=>setSite(e.target.value)} list="dl-sites" placeholder="e.g. Unit 4, High Street" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    <datalist id="dl-sites">{pastSites.map(v=><option key={v} value={v}/>)}</datalist>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Trade <span style={{textTransform:"none",fontWeight:400,color:"var(--text-tertiary)"}}>· auto-detected, change if needed</span></label>
                    <select value={trade} onChange={e=>setTrade(e.target.value)} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}>
                      {TRADES.map(t=><option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>

                <div style={{background:listening?"linear-gradient(135deg,#FEF2F2,#FFF5F5)":"linear-gradient(135deg,var(--green-mint),var(--green-light))",border:listening?"2px solid var(--red)":"2px dashed var(--green-dark)",borderRadius:"var(--radius-md)",padding:"24px",textAlign:"center",marginBottom:16,cursor:"pointer"}} onClick={()=>supported&&toggleListen()}>
                  <div style={{fontSize:28,marginBottom:8}}>{listening
                      ?<svg width="28" height="28" viewBox="0 0 24 24" fill="var(--red)" stroke="var(--red)" strokeWidth="1"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                      :<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M19 10a7 7 0 01-14 0"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>}</div>
                  <div style={{fontSize:14,fontWeight:600,color:listening?"var(--red)":"var(--green-deep)"}}>{listening?"Listening - tap to stop":"Tap to speak your material list"}</div>
                  <div style={{fontSize:12,color:listening?"var(--red)":"var(--green-dark)",marginTop:4}}>{listening?"Speak now - your words appear below. Review, then tap Proceed":"Or type your list below"}</div>
                  {listening&&interim&&(
                    <div style={{fontSize:13,color:"var(--text-primary)",marginTop:10,padding:"8px 12px",background:"var(--bg-card-solid)",borderRadius:8,fontStyle:"italic",border:"1px solid var(--border)"}}>"{interim}"</div>
                  )}
                </div>

                <textarea value={rawInput} onChange={e=>setRawInput(e.target.value)} placeholder="Type or dictate your materials, e.g. 10 sheets of 18mm OSB, 25 metres of 4mm twin and earth, 5L matt emulsion, 2 boxes of 100mm screws..." style={{width:"100%",height:100,padding:"10px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",resize:"vertical",fontFamily:"inherit",lineHeight:1.6,marginBottom:16}}></textarea>

                {/* Scan document button */}
                <div style={{marginBottom:14}}>
                  <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginBottom:8}}>Or scan a document</div>
                  <label style={{display:"flex",alignItems:"center",gap:10,padding:"14px 16px",background:scanning?"var(--indigo-light)":"var(--bg-subtle)",border:scanning?"2px solid var(--indigo)":"1px dashed var(--border)",borderRadius:"var(--radius-md)",cursor:scanning?"not-allowed":"pointer",transition:"all 0.2s"}}>
                    <input type="file" accept="image/*,.pdf" style={{display:"none"}} disabled={scanning||loading} onChange={e=>{if(e.target.files[0])scanDocumentFile(e.target.files[0]);e.target.value="";}}/>
                    <div style={{width:40,height:40,borderRadius:12,background:scanning?"var(--indigo)":"linear-gradient(135deg,#5B5BD6,#4A4AB8)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:"0 4px 12px rgba(99,102,241,0.3)"}}>
                      {scanning
                        ?<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" style={{animation:"spin 1s linear infinite"}}><circle cx="12" cy="12" r="10" strokeOpacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke="white"/></svg>
                        :<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
                      }
                    </div>
                    <div>
                      <div style={{fontSize:13,fontWeight:600,color:scanning?"var(--indigo)":"var(--text-primary)",marginBottom:2}}>{scanning?loadMsg:"Take a photo or upload a document"}</div>
                      <div style={{fontSize:11,color:"var(--text-tertiary)"}}>Scope of works, schedule of materials, handwritten list · Photo, PDF, or image</div>
                    </div>
                    {!scanning&&(
                      <div style={{marginLeft:"auto",display:"flex",gap:6,flexShrink:0}}>
                        <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:"var(--indigo-light)",color:"var(--indigo)"}}>PHOTO</span>
                        <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:"var(--bg-subtle2)",color:"var(--text-tertiary)"}}>PDF</span>
                      </div>
                    )}
                  </label>

                  {/* Bulk spreadsheet import */}
                  <label style={{display:"flex",alignItems:"center",gap:10,padding:"14px 16px",marginTop:10,background:"var(--bg-subtle)",border:"1px dashed var(--border)",borderRadius:"var(--radius-md)",cursor:"pointer"}}>
                    <input type="file" accept=".csv,.txt,.tsv" style={{display:"none"}} onChange={e=>{if(e.target.files[0])importMaterialsCSV(e.target.files[0]);e.target.value="";}}/>
                    <div style={{width:40,height:40,borderRadius:12,background:"linear-gradient(135deg,#1E9E63,#15824F)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:"0 4px 12px rgba(30,158,99,0.25)"}}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
                    </div>
                    <div>
                      <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",marginBottom:2}}>Import a materials spreadsheet</div>
                      <div style={{fontSize:11,color:"var(--text-tertiary)"}}>CSV with columns: description, quantity, unit · imports instantly, no AI needed</div>
                    </div>
                    <div style={{marginLeft:"auto",flexShrink:0}}>
                      <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:"var(--green-light)",color:"var(--green-dark)"}}>CSV</span>
                    </div>
                  </label>
                </div>

                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <button onClick={()=>setTemplateModal(true)} style={{fontSize:12,color:"var(--green-dark)",background:"var(--green-mint)",border:"1px solid var(--green-light)",borderRadius:"var(--radius-sm)",padding:"8px 14px",cursor:"pointer",fontWeight:500}}>Load template</button>
                  <Btn onClick={handleParse} disabled={!rawInput.trim()||loading||scanning} color="#15824F">
                    {loading||scanning?loadMsg||"Processing...":"Proceed"}
                  </Btn>
                </div>
              </div>
            )}

            {step===2&&parsed&&(
              <div>
                <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"24px",boxShadow:"var(--shadow-sm)",marginBottom:16}}>
                  <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>AI parsed {parsed.items?.length||0} items</div>
                  <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:14}}>Review and edit before sending - all fields are editable</div>
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",minWidth:600}}>
                      <thead>
                        <tr style={{background:"var(--bg-subtle)"}}>
                          {["#","Description","Qty","Unit","Category","Notes (editable)",""].map(h=>(
                            <th key={h} style={{padding:"9px 12px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--text-tertiary)",textTransform:"uppercase",letterSpacing:"0.05em"}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {parsed.items?.map((item,i)=>{
                          const updateItem = (field,val) => setParsed(p=>({...p,items:p.items.map((it,ii)=>ii===i?{...it,[field]:val}:it)}));
                          const cellStyle = {padding:"5px 8px",border:"1px solid transparent",borderRadius:6,fontSize:13,outline:"none",fontFamily:"inherit",background:"transparent",color:"var(--text-primary)",width:"100%",transition:"all 0.15s"};
                          return(
                            <tr key={i} style={{borderTop:"1px solid var(--border)"}}>
                              <td style={{padding:"8px 12px",fontSize:12,color:"var(--text-muted)",fontFamily:"monospace"}}>{i+1}</td>
                              <td style={{padding:"4px 6px",minWidth:160}}>
                                <input value={item.description||""} onChange={e=>updateItem("description",e.target.value)}
                                  style={{...cellStyle,fontWeight:500}}
                                  onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--green-dark)",background:"var(--bg-subtle)"})}
                                  onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}/>
                              </td>
                              <td style={{padding:"4px 6px",width:70}}>
                                <input type="number" value={item.quantity||""} onChange={e=>updateItem("quantity",e.target.value)}
                                  style={{...cellStyle,fontFamily:"'JetBrains Mono',monospace",width:60}}
                                  onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--green-dark)",background:"var(--bg-subtle)"})}
                                  onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}/>
                              </td>
                              <td style={{padding:"4px 6px",width:80}}>
                                <input value={item.unit||""} onChange={e=>updateItem("unit",e.target.value)}
                                  style={{...cellStyle,width:70}}
                                  onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--green-dark)",background:"var(--bg-subtle)"})}
                                  onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}/>
                              </td>
                              <td style={{padding:"4px 6px",width:120}}>
                                <select value={item.category||"General"} onChange={e=>updateItem("category",e.target.value)}
                                  style={{...cellStyle,width:110,cursor:"pointer"}}
                                  onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--green-dark)",background:"var(--bg-subtle)"})}
                                  onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}>
                                  {["Plumbing","HVAC","Electrical","Mechanical","Ventilation","Gas","General"].map(cat=>(<option key={cat} value={cat}>{cat}</option>))}
                                </select>
                              </td>
                              <td style={{padding:"4px 6px"}}>
                                <input value={item.notes||""} onChange={e=>updateItem("notes",e.target.value)}
                                  placeholder="Add note..."
                                  style={{...cellStyle,color:"var(--text-secondary)",fontSize:12}}
                                  onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--border)",background:"var(--bg-subtle)"})}
                                  onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}/>
                              </td>
                              <td style={{padding:"4px 6px",width:30}}>
                                <button onClick={()=>setParsed(p=>({...p,items:p.items.filter((_,ii)=>ii!==i)}))}
                                  style={{background:"none",border:"none",cursor:"pointer",color:"var(--text-muted)",fontSize:14}}
                                  onMouseEnter={e=>e.target.style.color="var(--red)"}
                                  onMouseLeave={e=>e.target.style.color="var(--text-muted)"}>x</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <button onClick={()=>setParsed(p=>({...p,items:[...p.items,{id:Date.now(),description:"",quantity:1,unit:"pcs",category:"General",notes:""}]}))}
                    style={{marginTop:10,fontSize:12,color:"var(--green-dark)",background:"none",border:"1px dashed var(--green-dark)",borderRadius:6,padding:"5px 14px",cursor:"pointer"}}>
                    + Add item
                  </button>
                </div>

                {/* Request notes */}
                <div style={{marginBottom:12}}>
                  <div style={{background:"var(--bg-subtle)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"14px 16px"}}>
                    <div style={{fontSize:12,fontWeight:700,color:"var(--text-secondary)",marginBottom:8}}>Request notes (optional)</div>
                    <textarea value={requestNotes} onChange={e=>setRequestNotes(e.target.value)} placeholder="Any special instructions, access notes, or additional context for suppliers..." style={{width:"100%",height:60,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12,outline:"none",resize:"none",fontFamily:"inherit",lineHeight:1.6}}></textarea>
                  </div>
                </div>

                {/* Deadline + Delivery */}
                <div style={{background:"var(--amber-light)",border:"1px solid var(--amber)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
                  <div>
                    <div style={{fontSize:12,fontWeight:700,color:"var(--amber)",marginBottom:2}}>Response deadline (optional)</div>
                    <div style={{fontSize:11,color:"var(--amber)"}}>Ask suppliers to respond before this date</div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <input type="date" value={rfqDeadline} onChange={e=>setRfqDeadline(e.target.value)} min={new Date().toISOString().split("T")[0]}
                      style={{padding:"8px 12px",border:"1px solid var(--amber)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    {rfqDeadline&&<button onClick={()=>setRfqDeadline("")} style={{fontSize:11,color:"var(--amber)",background:"none",border:"none",cursor:"pointer"}}>Clear</button>}
                  </div>
                </div>

                <div style={{background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:12}}>
                  <div style={{fontSize:12,fontWeight:700,color:"var(--indigo)",marginBottom:10}}>Delivery requirements</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                    {[{val:"direct",label:"To site",icon:"truck"},{val:"alternative",label:"Alt. address",icon:"building"},{val:"collect",label:"Collect",icon:"store"},{val:"tbc",label:"TBC",icon:"question"}].map(opt=>(
                      <label key={opt.val} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6,padding:"10px 8px",borderRadius:"var(--radius-sm)",border:`1.5px solid ${deliveryMethod===opt.val?"var(--green-dark)":"var(--border)"}`,background:deliveryMethod===opt.val?"var(--green-mint)":"var(--bg-card-solid)",cursor:"pointer",textAlign:"center"}}>
                        <input type="radio" name="dm" value={opt.val} checked={deliveryMethod===opt.val} onChange={()=>setDeliveryMethod(opt.val)} style={{accentColor:"var(--green-dark)"}}/>
                        <Icon name={opt.icon} size={18} color={deliveryMethod===opt.val?"var(--green-dark)":"var(--text-tertiary)"}/>
                        <span style={{fontSize:11,fontWeight:deliveryMethod===opt.val?600:400,color:"var(--text-primary)"}}>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                  {deliveryMethod==="alternative"&&(<>
                    <input value={altAddress} onChange={e=>setAltAddress(e.target.value)} list="dl-addresses" placeholder="Enter alternative delivery address" style={{width:"100%",marginTop:10,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    <datalist id="dl-addresses">{pastAddresses.map(v=><option key={v} value={v}/>)}</datalist>
                  </>)}
                  {deliveryMethod==="collect"&&(<>
                    <input value={collectFrom} onChange={e=>setCollectFrom(e.target.value)} list="dl-collect" placeholder="Collect from (e.g. Plumb Centre, Geldard Road)" style={{width:"100%",marginTop:10,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    <datalist id="dl-collect">{collectOptions.map(v=><option key={v} value={v}/>)}</datalist>
                  </>)}
                  <div style={{marginTop:10,display:"flex",gap:10,flexWrap:"wrap"}}>
                    <div>
                      <label style={{fontSize:11,color:"var(--text-secondary)",display:"block",marginBottom:4}}>Required by date</label>
                      <input type="date" value={deliveryDate} onChange={e=>setDeliveryDate(e.target.value)} style={{padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    </div>
                  </div>
                </div>

                {/* Suppliers */}
                <div style={{background:"var(--bg-subtle)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"16px",marginBottom:16}}>
                  <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",marginBottom:10}}>Suppliers to receive RFQ <span style={{color:"var(--text-secondary)",fontWeight:400}}>({trade})</span></div>
                  {!can.sendRFQ(myRole)&&<div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:10,padding:"8px 12px",background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)"}}>As an engineer you don't need to pick suppliers - just raise the list and your buyer will request the quotes. You can skip this section.</div>}
                  {suppliers.length>6&&(
                    <input value={supSearch} onChange={e=>setSupSearch(e.target.value)} placeholder="Search suppliers by name, trade or contact..." style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",marginBottom:10}}/>
                  )}
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    {pickList.map(s=>{
                      const sel=selSup.includes(s.id);
                      const contacts=s.contacts||[];
                      const chosenId=contactSel[s.id]||contacts[0]?.id;
                      return (
                      <div key={s.id} style={{background:sel?"var(--green-mint)":"var(--bg-card-solid)",border:`1px solid ${sel?"var(--green-dark)":"var(--border)"}`,borderRadius:"var(--radius-sm)",padding:"10px 14px",transition:"all 0.15s"}}>
                        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer"}}>
                          <input type="checkbox" checked={sel} onChange={e=>{ setSelSup(p=>e.target.checked?[...p,s.id]:p.filter(id=>id!==s.id)); if(e.target.checked&&!contactSel[s.id]&&contacts[0]) setContactSel(p=>({...p,[s.id]:contacts[0].id})); }} style={{accentColor:"var(--green-dark)"}}/>
                          <span style={{fontWeight:600,color:"var(--text-primary)"}}>{s.name}</span>
                          {contacts.length===0&&<span style={{fontSize:11,color:"var(--amber)"}}>no contact - add on Suppliers page</span>}
                          {contacts.length>0&&!sel&&<span style={{fontSize:11,color:"var(--text-tertiary)"}}>{contacts.length===1?(contacts[0].email):`${contacts.length} contacts`}</span>}
                        </label>
                        {sel&&contacts.length>0&&(
                          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8,paddingLeft:26}}>
                            <span style={{fontSize:11,color:"var(--text-secondary)"}}>Send to:</span>
                            {contacts.length===1?(
                              <span style={{fontSize:12,color:"var(--text-primary)"}}>{contacts[0].name?`${contacts[0].name} · ${contacts[0].email}`:contacts[0].email}</span>
                            ):(
                              <select value={chosenId} onChange={e=>setContactSel(p=>({...p,[s.id]:e.target.value}))} style={{flex:1,maxWidth:320,padding:"6px 10px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12,outline:"none",background:"var(--bg-card-solid)"}}>
                                {contacts.map(c=><option key={c.id} value={c.id}>{c.name?`${c.name} - ${c.email}`:c.email}{c.branch?` (${c.branch})`:""}</option>)}
                              </select>
                            )}
                          </div>
                        )}
                      </div>
                      );
                    })}
                    {pickList.length===0&&<div style={{fontSize:13,color:"var(--text-tertiary)"}}>{supSearch.trim()?`No suppliers match "${supSearch}"`:`No ${trade} suppliers yet - add one below`}</div>}
                  </div>
                  {/* Quick-add supplier inline */}
                  {showQuickSup?(
                    <div style={{marginTop:12,padding:"14px 16px",background:"var(--bg-subtle)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)"}}>
                      <div style={{fontSize:12,fontWeight:700,color:"var(--text-secondary)",marginBottom:10}}>Add a new supplier</div>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                        <input value={quickSup.name} onChange={e=>setQuickSup(p=>({...p,name:e.target.value}))} placeholder="Supplier name" style={{flex:"1 1 140px",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                        <input value={quickSup.email} onChange={e=>setQuickSup(p=>({...p,email:e.target.value}))} placeholder="quotes@supplier.co.uk" style={{flex:"1 1 180px",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                        <Btn onClick={()=>{
                          if(!quickSup.name.trim()||!quickSup.email.trim()){showToast("Enter a name and email","warn");return;}
                          const ns=normSupplier({id:`SUP-${Date.now()}`,name:quickSup.name.trim(),email:quickSup.email.trim(),categories:[trade]});
                          const updated=[...suppliers,ns];
                          saveSuppliers(updated);
                          setSelSup(p=>[...p,ns.id]);
                          setContactSel(p=>({...p,[ns.id]:ns.contacts[0]?.id}));
                          logActivity("Supplier added",`${ns.name} added from request wizard`,{entity:"supplier"});
                          setQuickSup({name:"",email:""});setShowQuickSup(false);
                          showToast(`${ns.name} added and selected`);
                        }} color="#15824F">Add</Btn>
                        <Btn outline onClick={()=>{setShowQuickSup(false);setQuickSup({name:"",email:""});}}>Cancel</Btn>
                      </div>
                    </div>
                  ):(
                    <button onClick={()=>setShowQuickSup(true)} style={{marginTop:10,fontSize:13,color:"var(--green-dark)",background:"var(--green-mint)",border:"1px solid var(--green-light)",borderRadius:"var(--radius-sm)",padding:"8px 14px",cursor:"pointer",fontWeight:600}}>+ Add a supplier</button>
                  )}
                </div>

                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                  <Btn outline onClick={()=>setStep(1)}>Back</Btn>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                    <button onClick={()=>setTemplateModal(true)} style={{fontSize:12,color:"var(--indigo)",background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"8px 14px",cursor:"pointer",fontWeight:500}}>Save as template</button>
                    <Btn onClick={handleGenRFQ} disabled={loading||(can.sendRFQ(myRole)&&selSup.length===0)} color="#15824F">
                      {loading?loadMsg:(can.sendRFQ(myRole)?"Generate RFQ email":"Issue to buyer")}
                    </Btn>
                  </div>
                </div>
              </div>
            )}

            {step===3&&(
              <div>
                <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"24px",boxShadow:"var(--shadow-sm)",marginBottom:16}}>
                  <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>Review RFQ email</div>
                  {editingReqId&&<div style={{fontSize:12,fontWeight:600,color:"var(--amber)",background:"var(--amber-light)",border:"1px solid var(--amber)",borderRadius:"var(--radius-sm)",padding:"8px 12px",marginBottom:10}}>Revising {jobRef||editingReqId} - sending this will re-send to the selected suppliers and reset their quotes for this revision.</div>}
                  <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:14}}>This is exactly how the email will look to your {selSup.length} supplier{selSup.length!==1?"s":""}. Edit the wording below if you'd like.</div>
                  <div style={{border:"1px solid var(--border)",borderRadius:"var(--radius-md)",overflow:"hidden",marginBottom:14,background:"#F4F4F1"}}>
                    <iframe
                      title="Email preview"
                      style={{width:"100%",height:420,border:"none",display:"block",background:"#F4F4F1"}}
                      srcDoc={buildEmailHtml(rfqEmail, settings, { supplierName: (()=>{ const s=suppliers.find(x=>selSup.includes(x.id)); if(!s) return ""; const c=(s.contacts||[]).find(c=>c.id===(contactSel[s.id]||s.contacts[0]?.id))||(s.contacts||[])[0]; return (c&&c.name)||s.name; })() })}
                    />
                  </div>
                  <details style={{marginBottom:16}}>
                    <summary style={{fontSize:12,fontWeight:600,color:"var(--green-dark)",cursor:"pointer",marginBottom:8}}>Edit the email wording</summary>
                    <textarea value={rfqEmail} onChange={e=>setRfqEmail(e.target.value)} rows={10} style={{width:"100%",boxSizing:"border-box",background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)",padding:"14px 16px",fontSize:13,lineHeight:1.7,color:"var(--text-primary)",border:"1px solid var(--border)",resize:"vertical",fontFamily:"inherit",marginTop:8}}/>
                    <div style={{fontSize:11,color:"var(--text-muted)",marginTop:4}}>This is the message body. The greeting (Dear [supplier]) and your signature are added automatically.</div>
                  </details>
                  {/* Supporting documents — site photos, layout drawings or specs, sent to suppliers with the RFQ for context. Not parsed into the materials list. */}
                  <div style={{marginBottom:16,padding:"14px 16px",background:"var(--bg-subtle)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)"}}>
                    <div style={{fontSize:12.5,fontWeight:600,color:"var(--text-primary)",marginBottom:2}}>Supporting documents <span style={{fontWeight:400,color:"var(--text-muted)"}}>(optional)</span></div>
                    <div style={{fontSize:11.5,color:"var(--text-muted)",marginBottom:10,lineHeight:1.5}}>Site photos, a layout drawing or a spec — attached to the RFQ email to help suppliers quote. These are <strong>not</strong> added to the materials list.</div>
                    {rfqDocs.length>0&&(
                      <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:10}}>
                        {rfqDocs.map(d=>(
                          <div key={d.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)"}}>
                            <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:99,background:d.kind==="image"?"var(--indigo-light)":"var(--green-light)",color:d.kind==="image"?"var(--indigo)":"var(--green-dark)",flexShrink:0}}>{d.kind==="image"?"IMG":"PDF"}</span>
                            <span style={{fontSize:12.5,color:"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{d.filename}</span>
                            <span style={{fontSize:11,color:"var(--text-muted)",flexShrink:0}}>{d.size<1048576?`${Math.max(1,Math.round(d.size/1024))} KB`:`${(d.size/1048576).toFixed(1)} MB`}</span>
                            <button onClick={()=>setRfqDocs(p=>p.filter(x=>x.id!==d.id))} title="Remove" style={{background:"none",border:"none",color:"var(--text-muted)",cursor:"pointer",fontSize:18,lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>
                          </div>
                        ))}
                      </div>
                    )}
                    {rfqDocs.length<5&&(
                      <label style={{display:"inline-flex",alignItems:"center",gap:8,padding:"9px 14px",background:"var(--bg-card)",border:"1px dashed var(--border)",borderRadius:"var(--radius-sm)",cursor:"pointer",fontSize:12.5,fontWeight:600,color:"var(--green-dark)"}}>
                        <input type="file" accept="image/*,.pdf" multiple style={{display:"none"}} onChange={e=>{addRfqDocs(e.target.files);e.target.value="";}}/>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                        {rfqDocs.length?"Add another":"Attach a photo, drawing or PDF"}
                      </label>
                    )}
                    {(()=>{ const total=rfqDocs.reduce((a,d)=>a+(d.size||0),0); return total>3.5*1048576?(
                      <div style={{fontSize:11,color:"var(--amber)",marginTop:8}}>These attachments total {(total/1048576).toFixed(1)} MB — large emails can bounce. Consider removing one or sending a lighter file.</div>
                    ):rfqDocs.length>=5?(
                      <div style={{fontSize:11,color:"var(--text-muted)",marginTop:8}}>Maximum of 5 supporting documents reached.</div>
                    ):null; })()}
                  </div>
                  {selSup.length>0&&(
                    <div style={{marginBottom:14}}>
                      <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginBottom:8}}>Will be sent to:</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                        {suppliers.filter(s=>selSup.includes(s.id)).map(s=>{
                          const c=(s.contacts||[]).find(c=>c.id===(contactSel[s.id]||s.contacts[0]?.id))||(s.contacts||[])[0];
                          const to=c?(c.name?`${c.name} · ${c.email}`:c.email):(s.email||"no contact email");
                          return (
                          <span key={s.id} style={{fontSize:12,color:"var(--green-dark)",background:"var(--green-light)",padding:"3px 10px",borderRadius:99}}>{s.name} <span style={{opacity:0.7}}>→ {to}</span></span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {emailRes&&emailRes.some(r=>r.success)&&(
                    <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--green-light)",border:"1px solid var(--green-dark)",borderRadius:"var(--radius-sm)",padding:"12px 16px"}}>
                      <span style={{fontSize:16}}>ok</span>
                      <div>
                        <div style={{fontSize:13,fontWeight:600,color:"var(--green-dark)"}}>Quotes sent successfully</div>
                        <div style={{fontSize:12,color:"var(--green-dark)",opacity:0.8}}>Redirecting to dashboard...</div>
                      </div>
                    </div>
                  )}
                  {!emailRes&&(
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                      <Btn outline onClick={()=>setStep(2)}>Back</Btn>
                      <div style={{display:"flex",gap:10}}>
                        {(EMAIL_VIA_SERVER||settings.resendKey)?(
                          <Btn onClick={handleSendEmails} disabled={loading||selSup.length===0} color="#15824F">
                            {loading?loadMsg:`${editingReqId?"Re-send to":"Send to"} ${selSup.length} supplier${selSup.length!==1?"s":""}`}
                          </Btn>
                        ):(
                          <div style={{fontSize:13,color:"var(--text-tertiary)"}}>
                            Configure Resend in <button onClick={()=>setView("settings")} style={{color:"var(--indigo)",background:"none",border:"none",cursor:"pointer",fontWeight:600,fontSize:13,padding:0}}>Settings</button> to send emails
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {view==="quotes"&&(
          <div style={{display:"flex",gap:20,alignItems:"flex-start",animation:"fadeIn 0.25s ease",minHeight:"60vh"}}>

            {/* Left sidebar - request selector */}
            {!isMobile&&(
              <div style={{width:220,flexShrink:0,background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",border:"1px solid var(--border)",overflow:"hidden",boxShadow:"var(--shadow-sm)",position:"sticky",top:16}}>
                <div style={{padding:"14px 16px",borderBottom:"1px solid var(--border)",fontSize:12,fontWeight:700,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.08em"}}>Requests</div>
                {visibleRequests.filter(r=>r.status==="pending"||r.status==="received").length===0?(
                  <div style={{padding:"20px 16px",fontSize:12,color:"var(--text-tertiary)",textAlign:"center"}}>No active requests</div>
                ):(
                  <div>
                    {visibleRequests.filter(r=>r.status==="pending"||r.status==="received").map(r=>{
                      const quotesIn = (r.sentTo||[]).filter(s=>s.saved).length;
                      const quotesTotal = (r.sentTo||[]).length;
                      const isActive = activeReq?.id===r.id;
                      return(
                        <button key={r.id} onClick={()=>{const qs=savedQuoteSets.find(s=>s.reqId===r.id);setActiveReq(r);setAllAnalyses(qs?.analyses||[]);setApprovedQuoteId(qs?.approvedId||null);setExpandedQuote(null);}}
                          style={{width:"100%",textAlign:"left",background:isActive?"var(--green-mint)":"transparent",border:"none",borderLeft:isActive?"3px solid var(--green-dark)":"3px solid transparent",padding:"12px 16px",cursor:"pointer",borderBottom:"1px solid var(--border)",transition:"all 0.15s"}}>
                          <div style={{fontSize:12,fontWeight:700,color:isActive?"var(--green-dark)":"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace",marginBottom:2}}>{r.id}</div>
                          <div style={{fontSize:11,color:"var(--text-secondary)",marginBottom:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.jobRef}</div>
                          <div style={{fontSize:10,color:"var(--text-tertiary)"}}>{quotesIn}/{quotesTotal} quotes</div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Main area */}
            <div style={{flex:1,minWidth:0}}>
              {!activeReq?(
                <>
                <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"48px 32px",textAlign:"center",boxShadow:"var(--shadow-sm)"}}>
                  <div style={{fontSize:14,color:"var(--text-secondary)",marginBottom:16}}>Select a request to start analysing quotes</div>
                  {visibleRequests.filter(r=>r.status==="pending"||r.status==="received").length===0&&(
                    <button onClick={()=>{setView("new");resetNewRequest();}} style={{background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"10px 24px",fontSize:13,fontWeight:700,cursor:"pointer"}}>Create a request</button>
                  )}
                  {isMobile&&requests.filter(r=>r.status==="pending"||r.status==="received").length>0&&(
                    <div style={{display:"flex",flexDirection:"column",gap:8,maxWidth:400,margin:"0 auto"}}>
                      {requests.filter(r=>r.status==="pending"||r.status==="received").map(r=>(
                        <button key={r.id} onClick={()=>{const qs=savedQuoteSets.find(s=>s.reqId===r.id);setActiveReq(r);setAllAnalyses(qs?.analyses||[]);setApprovedQuoteId(qs?.approvedId||null);}} style={{textAlign:"left",padding:"12px 16px",background:"var(--bg-subtle)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",cursor:"pointer"}}>
                          <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",fontFamily:"monospace"}}>{r.id}</div>
                          <div style={{fontSize:12,color:"var(--text-secondary)"}}>{r.jobRef} · {r.site}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {savedQuoteSets.length>0&&(
                  <div style={{marginTop:20}}>
                    <div style={{fontSize:13,fontWeight:700,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:12}}>Saved quote analyses</div>
                    {savedQuoteSets.map(qs=>{
                      const approved = qs.analyses.find(a=>a._id===qs.approvedId);
                      const best = approved || [...qs.analyses].sort((a,b)=>(b.completeness||0)-(a.completeness||0))[0];
                      const openFull = ()=>{
                        const req = requests.find(r=>r.id===qs.reqId) || {
                          id:qs.reqId, jobRef:qs.jobRef, trade:qs.trade, site:qs.site||"",
                          items:qs.items||[], sentTo:[], status:qs.status==="approved"?"approved":"received"
                        };
                        setActiveReq(req);
                        setAllAnalyses(qs.analyses);
                        setApprovedQuoteId(qs.approvedId);
                        setExpandedQuote(qs.analyses[0]?._id||null);
                        setQuoteViewMode("cards");
                        window.scrollTo({top:0,behavior:"smooth"});
                      };
                      return(
                        <div key={qs.id} style={{marginBottom:10,background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",border:"1px solid var(--border)",overflow:"hidden",boxShadow:"var(--shadow-sm)",transition:"box-shadow 0.2s,transform 0.2s"}}
                          onMouseEnter={e=>{e.currentTarget.style.boxShadow="var(--shadow-md)";e.currentTarget.style.transform="translateY(-1px)";}}
                          onMouseLeave={e=>{e.currentTarget.style.boxShadow="var(--shadow-sm)";e.currentTarget.style.transform="translateY(0)";}}>
                          <div onClick={openFull} style={{padding:"15px 18px",display:"flex",alignItems:"center",gap:14,cursor:"pointer"}}>
                            <div style={{width:42,height:42,borderRadius:12,background:qs.status==="approved"?"linear-gradient(135deg,#1E9E63,#15824F)":"var(--bg-subtle2)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                              <Icon name={qs.status==="approved"?"check_circle":"search"} size={21} color={qs.status==="approved"?"white":"var(--text-secondary)"}/>
                            </div>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                                <span style={{fontSize:14,fontWeight:700,color:"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace"}}>{qs.jobRef||qs.reqId}</span>
                                {qs.status==="approved"
                                  ?<span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99,background:"var(--green-light)",color:"var(--green-deep)"}}>Approved</span>
                                  :<span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99,background:"var(--indigo-light)",color:"var(--indigo)"}}>Analysed</span>}
                              </div>
                              <div style={{fontSize:12,color:"var(--text-secondary)"}}>{qs.trade} &middot; {qs.analyses.length} quote{qs.analyses.length!==1?"s":""}{best?` &middot; best: ${best.supplierName} (${best.completeness||0}%)`:""}</div>
                            </div>
                            <div style={{textAlign:"right",flexShrink:0}}>
                              {best&&best.estimatedTotal&&<div style={{fontSize:14,fontWeight:800,color:"var(--green-dark)",fontFamily:"'JetBrains Mono',monospace"}} className="num">{best.estimatedTotal}</div>}
                              <div style={{fontSize:10,color:"var(--text-muted)"}}>{new Date(qs.createdAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"2-digit"})}</div>
                            </div>
                            <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0,fontSize:12,fontWeight:600,color:"var(--green-dark)"}}>
                              View<Icon name="arrow_right" size={15} color="var(--green-dark)"/>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                </>
              ):(
                <div>
                  {/* Back to saved list */}
                  <button onClick={()=>{setActiveReq(null);setAllAnalyses([]);setExpandedQuote(null);}} style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,fontWeight:600,color:"var(--text-secondary)",background:"transparent",border:"none",cursor:"pointer",padding:"4px 0",marginBottom:12}}>
                    <Icon name="arrow_right" size={15} style={{transform:"rotate(180deg)"}}/> Back to all quotes
                  </button>
                  {/* Request header */}
                  <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"18px 22px",marginBottom:16,boxShadow:"var(--shadow-sm)"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10}}>
                      <div>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4,flexWrap:"wrap"}}>
                          <span style={{fontSize:16,fontWeight:800,color:"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace"}}>{activeReq.id}</span>
                          <span style={{fontSize:11,fontWeight:700,padding:"2px 10px",borderRadius:99,background:"var(--indigo-light)",color:"var(--indigo)"}}>{activeReq.trade}</span>
                          {approvedQuoteId&&<span style={{fontSize:11,fontWeight:700,padding:"2px 10px",borderRadius:99,background:"var(--green-light)",color:"var(--green-deep)"}}>PO Approved</span>}
                        </div>
                        <div style={{fontSize:13,color:"var(--text-secondary)"}}>{activeReq.jobRef} · {activeReq.site}</div>
                        <div style={{fontSize:12,color:"var(--text-tertiary)",marginTop:3}}>{activeReq.items?.length||0} items · {(activeReq.sentTo||[]).length} suppliers</div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                        {activeReq.rfqDeadline&&(
                          Math.ceil((new Date(activeReq.rfqDeadline).getTime()-Date.now())/86400000)<=0
                          ?<span style={{fontSize:11,fontWeight:700,padding:"4px 12px",borderRadius:99,background:"var(--red-light)",color:"var(--red)"}}>Deadline passed</span>
                          :<span style={{fontSize:11,fontWeight:700,padding:"4px 12px",borderRadius:99,background:"var(--amber-light)",color:"var(--amber)"}}>Respond by {new Date(activeReq.rfqDeadline).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Buyer sees who issued it + the engineer's note */}
                  {can.viewCosts(myRole)&&activeReq.createdByRole==="engineer"&&(
                    <div style={{marginTop:16,padding:"14px 18px",background:"var(--blue-light, #EEEEFB)",borderRadius:"var(--radius-md)",border:"1px solid var(--border)",borderLeft:"4px solid #4A4AB8"}}>
                      <div style={{fontSize:12.5,fontWeight:700,color:"var(--text-primary)",marginBottom:activeReq.buyerNote?4:0}}>Issued by {activeReq.createdBy||"an engineer"}</div>
                      {activeReq.buyerNote&&<div style={{fontSize:12.5,color:"var(--text-secondary)",lineHeight:1.5}}>"{activeReq.buyerNote}"</div>}
                    </div>
                  )}

                  {/* Engineer hand-off panel (no cost access) */}
                  {!can.viewCosts(myRole)&&(
                    <div style={{marginTop:16,padding:"16px 18px",background:"var(--bg-subtle2)",borderRadius:"var(--radius-md)",border:"1px solid var(--border)"}}>
                      <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:4}}>Issued to your buyer</div>
                      <div style={{fontSize:12.5,color:"var(--text-secondary)",lineHeight:1.5,marginBottom:12}}>You've raised this materials list and it's been issued to the buyer, who will request and compare quotes. You can add a note for them below. When materials arrive, you can sign off the delivery from the Orders tab.</div>
                      <div style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.06em"}}>Note for the buyer</div>
                      <textarea value={activeReq.buyerNote||""} onChange={e=>{const v=e.target.value;setActiveReq(p=>({...p,buyerNote:v}));setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,buyerNote:v}:r));}} placeholder="e.g. needed on site by Friday, prefer collection from the trade counter..." style={{width:"100%",minHeight:70,padding:"10px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",background:"var(--bg-card-solid)",resize:"vertical",fontFamily:"inherit"}}></textarea>
                    </div>
                  )}
                  {/* Quote entry */}
                  {can.viewCosts(myRole)&&allAnalyses.length===0&&(
                    <div>
                      <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginBottom:12,textTransform:"uppercase",letterSpacing:"0.08em"}}>Enter supplier quotes</div>
                      {(activeReq.sentTo||[]).length===0&&(
                        <div style={{background:"var(--bg-subtle2)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:16}}>
                          <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:8}}>Add suppliers to request quotes from</div>
                          {suppliers.length===0
                            ? <div style={{fontSize:12.5,color:"var(--text-secondary)"}}>You have no suppliers yet. Add some on the Suppliers page first.</div>
                            : <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                                {suppliers.map(s=>(
                                  <button key={s.id} onClick={()=>{const add={id:s.id,name:s.name,email:s.email,quote:"",saved:false};setActiveReq(p=>({...p,sentTo:[...(p.sentTo||[]),add]}));setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,sentTo:[...(r.sentTo||[]),add],status:r.status==="awaiting-buyer"?"pending":r.status}:r));}} style={{fontSize:12,fontWeight:600,padding:"7px 13px",borderRadius:99,border:"1px solid var(--border)",background:"var(--bg-card-solid)",color:"var(--text-primary)",cursor:"pointer"}}>+ {s.name}</button>
                                ))}
                              </div>}
                        </div>
                      )}
                      <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:16}}>
                        {(activeReq.sentTo||[]).map((sup,si)=>(
                          <div key={sup.id||si} style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"16px 20px",boxShadow:"var(--shadow-sm)"}}>
                            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
                              <div style={{width:34,height:34,borderRadius:10,background:"linear-gradient(135deg,var(--indigo),#4A4AB8)",display:"flex",alignItems:"center",justifyContent:"center",color:"white",fontWeight:700,fontSize:14,flexShrink:0}}>{(sup.name||"?")[0]}</div>
                              <div style={{flex:1}}>
                                <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)"}}>{sup.name}</div>
                                <div style={{fontSize:11,color:"var(--text-tertiary)"}}>{sup.contactName?`${sup.contactName} · ${sup.email}`:sup.email}</div>
                              </div>
                              {(sup.saved||(sup.quote&&sup.quote.trim()))&&<span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99,background:"var(--green-light)",color:"var(--green-deep)",display:"inline-flex",alignItems:"center",gap:4}}><Icon name="check" size={10} color="var(--green-deep)" strokeWidth={3}/>Quote entered</span>}
                            </div>
                            <textarea
                              value={sup.quote||""}
                              onChange={e=>{
                                const val=e.target.value;
                                setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,sentTo:r.sentTo.map((s,i)=>i===si?{...s,quote:val,saved:!!val.trim()}:s)}:r));
                                setActiveReq(p=>({...p,sentTo:p.sentTo.map((s,i)=>i===si?{...s,quote:val,saved:!!val.trim()}:s)}));
                              }}
                              placeholder={`Paste ${sup.name||"supplier"}'s quote here...`}
                              style={{width:"100%",height:90,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12,outline:"none",resize:"vertical",fontFamily:"inherit",lineHeight:1.6,marginBottom:8}}
                            ></textarea>
                            <div
                              onDragOver={e=>{e.preventDefault();setDragOver(p=>({...p,[si]:true}));}}
                              onDragLeave={e=>{e.preventDefault();setDragOver(p=>({...p,[si]:false}));}}
                              onDrop={e=>{e.preventDefault();setDragOver(p=>({...p,[si]:false}));const f=e.dataTransfer.files[0];if(f)processQuoteFile(f,si,sup,activeReq.id);}}
                              style={{padding:"10px 12px",background:dragOver[si]?"var(--indigo-light)":"var(--bg-subtle)",borderRadius:"var(--radius-sm)",border:dragOver[si]?"2px dashed var(--indigo)":"1px dashed var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,transition:"all 0.15s"}}>
                              <span style={{fontSize:12,color:dragOver[si]?"var(--indigo)":fileExtracting[si]?"var(--indigo)":"var(--text-tertiary)"}}>
                                {fileExtracting[si]?"Extracting...":dragOver[si]?"Drop to extract":"Drag document or"}
                              </span>
                              <label style={{fontSize:11,color:"var(--indigo)",background:"var(--indigo-light)",borderRadius:6,padding:"4px 10px",cursor:fileExtracting[si]?"not-allowed":"pointer",fontWeight:500,flexShrink:0}}>
                                {fileExtracting[si]?"Reading...":"Browse file"}
                                <input type="file" accept=".pdf,.doc,.docx,.xlsx,.xls,.csv,.txt" style={{display:"none"}} disabled={!!fileExtracting[si]} onChange={e=>{if(e.target.files[0])processQuoteFile(e.target.files[0],si,sup,activeReq.id);e.target.value="";}}/>
                              </label>
                            </div>
                            {(sup.attachments||[]).length>0&&(
                              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8}}>
                                {sup.attachments.map((a,ai)=>a.dataUrl?(
                                  <a key={ai} href={a.dataUrl} download={a.name} style={{fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:8,background:"var(--green-light)",color:"var(--green-deep)",textDecoration:"none",display:"inline-flex",alignItems:"center",gap:5,border:"1px solid var(--green-deep)"}}><Icon name="paperclip" size={11} color="var(--green-deep)" strokeWidth={2.5}/>{a.name}{a.extracted?<span style={{opacity:.7,fontWeight:500}}> · read in</span>:a.extractError?<span style={{opacity:.7,fontWeight:500}}> · couldn't read</span>:fileExtracting[si]?<span style={{opacity:.7,fontWeight:500}}> · reading...</span>:null}</a>
                                ):(
                                  <span key={ai} style={{fontSize:11,fontWeight:500,padding:"4px 10px",borderRadius:8,background:"var(--bg-subtle)",color:"var(--text-tertiary)",border:"1px solid var(--border)"}}>{a.name} {a.tooLarge?"(too large to attach)":"(unavailable)"}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                        <Btn onClick={handleAnalyseAll} disabled={loading||!(activeReq.sentTo||[]).some(s=>s.quote&&s.quote.trim())||!(AI_VIA_SERVER||settings.openRouterKey)} color="#15824F">
                          {loading?<span>Analysing... {loadMsg}</span>:"Analyse all quotes"}
                        </Btn>
                        
                      </div>
                    </div>
                  )}

                  {/* Skeleton loaders while analysing */}
                  {can.viewCosts(myRole)&&loading&&allAnalyses.length===0&&(
                    <div style={{marginTop:4}}>
                      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
                        <Spinner/>
                        <span style={{fontSize:13,fontWeight:600,color:"var(--text-secondary)"}}>{loadMsg||"Analysing quotes..."}</span>
                      </div>
                      {[0,1].map(i=>(
                        <div key={i} style={{marginBottom:10,background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",border:"1px solid var(--border)",padding:"16px 18px",boxShadow:"var(--shadow-sm)"}}>
                          <div style={{display:"flex",alignItems:"center",gap:14}}>
                            <div className="skeleton" style={{width:46,height:46,borderRadius:"50%",flexShrink:0}}/>
                            <div style={{flex:1}}>
                              <div className="skeleton" style={{width:"40%",height:14,marginBottom:8}}/>
                              <div className="skeleton" style={{width:"70%",height:11}}/>
                            </div>
                            <div className="skeleton" style={{width:64,height:28,borderRadius:8,flexShrink:0}}/>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Results */}
                  {can.viewCosts(myRole)&&allAnalyses.length>0&&(
                    <div>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:10}} className="no-print">
                        <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.08em"}}>Results - {allAnalyses.length} supplier{allAnalyses.length!==1?"s":""}</div>
                        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                          {/* View toggle */}
                          <div style={{display:"flex",background:"var(--bg-subtle2)",borderRadius:8,padding:2}}>
                            <button onClick={()=>setQuoteViewMode("cards")} style={{fontSize:12,fontWeight:600,padding:"5px 12px",borderRadius:6,border:"none",cursor:"pointer",background:quoteViewMode==="cards"?"var(--bg-card-solid)":"transparent",color:quoteViewMode==="cards"?"var(--text-primary)":"var(--text-tertiary)",boxShadow:quoteViewMode==="cards"?"var(--shadow-sm)":"none"}}>Cards</button>
                            <button onClick={()=>setQuoteViewMode("compare")} style={{fontSize:12,fontWeight:600,padding:"5px 12px",borderRadius:6,border:"none",cursor:"pointer",background:quoteViewMode==="compare"?"var(--bg-card-solid)":"transparent",color:quoteViewMode==="compare"?"var(--text-primary)":"var(--text-tertiary)",boxShadow:quoteViewMode==="compare"?"var(--shadow-sm)":"none"}}>Compare</button>
                          </div>
                          {/* Margin calculator */}
                          <div style={{display:"flex",alignItems:"center",gap:6,background:"var(--green-mint)",border:"1px solid var(--green-light)",borderRadius:8,padding:"4px 10px"}}>
                            <span style={{fontSize:11,fontWeight:600,color:"var(--green-deep)"}}>Markup</span>
                            <input type="number" min="0" max="200" value={marginPct} onChange={e=>setMarginPct(Math.max(0,Math.min(200,parseInt(e.target.value)||0)))} style={{width:46,padding:"3px 6px",border:"1px solid var(--green-light)",borderRadius:5,fontSize:12,outline:"none",fontFamily:"monospace",textAlign:"center"}}/>
                            <span style={{fontSize:11,fontWeight:600,color:"var(--green-deep)"}}>%</span>
                          </div>
                          <button onClick={()=>{
                            if (allAnalyses.length>0) setExpandedQuote(allAnalyses[0]._id);
                            setTimeout(()=>window.print(),300);
                          }} style={{fontSize:12,color:"var(--indigo)",background:"var(--indigo-light)",border:"none",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontWeight:500}}><Icon name="printer" size={13} style={{marginRight:5,verticalAlign:"-2px"}}/>Print</button>
                          <button onClick={()=>{setAllAnalyses([]);setExpandedQuote(null);setQuoteViewMode("cards");setMarginPct(0);}} style={{fontSize:12,color:"var(--text-secondary)",background:"none",border:"none",cursor:"pointer"}}>Re-analyse</button>
                        </div>
                      </div>

                      {/* Margin summary bar - shows when markup is set */}
                      {marginPct>0&&(
                        <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:12,padding:"10px 14px",background:"var(--green-mint)",border:"1px solid var(--green-light)",borderRadius:10}}>
                          <span style={{fontSize:12,fontWeight:700,color:"var(--green-deep)"}}>At {marginPct}% markup:</span>
                          {allAnalyses.map(qa=>{
                            const cost = parsePrice(qa.estimatedTotal)||parsePrice(qa.subtotal);
                            if (!cost) return null;
                            const sell = cost*(1+marginPct/100);
                            return(
                              <span key={qa._id} style={{fontSize:12,color:"var(--text-secondary)"}}>
                                <strong style={{color:"var(--text-primary)"}}>{qa.supplierName}:</strong> £{fmtMoney(cost)} <Icon name="arrow_right" size={12} style={{verticalAlign:"-1px",margin:"0 2px"}}/> <strong style={{color:"var(--green-dark)"}}>£{fmtMoney(sell)}</strong> <span style={{color:"var(--text-tertiary)"}}>(+£{fmtMoney(sell-cost)})</span>
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {quoteViewMode==="cards"&&allAnalyses.map((qa,qi)=>{
                        const vMap = {
                          excellent:{bg:"var(--green-light)",  border:"var(--green-dark)", text:"var(--green-deep)", label:"Excellent"},
                          good:     {bg:"var(--indigo-light)", border:"var(--indigo)",     text:"var(--indigo)",     label:"Good"},
                          partial:  {bg:"var(--amber-light)",  border:"var(--amber)",      text:"var(--amber)",      label:"Partial"},
                          poor:     {bg:"var(--red-light)",    border:"var(--red)",        text:"var(--red)",        label:"Poor"},
                        };
                        const vc = vMap[qa.overallVerdict||"good"]||vMap.good;
                        const isOpen = expandedQuote===qa._id;
                        const sc = qa.completeness>=80?"var(--green-dark)":qa.completeness>=60?"var(--amber)":"var(--red)";
                        const isApproved = approvedQuoteId===qa._id;
                        return(
                          <div key={qa._id||qi} style={{marginBottom:10,background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",border:"1px solid var(--border)",borderTop:`3px solid ${vc.border}`,overflow:"hidden",boxShadow:isOpen?"var(--shadow-md)":"var(--shadow-sm)",transition:"box-shadow 0.2s cubic-bezier(0.16,1,0.3,1)"}}>
                            <div onClick={()=>setExpandedQuote(isOpen?null:qa._id)} style={{padding:"14px 18px",display:"flex",alignItems:"center",gap:14,cursor:"pointer",background:isOpen?vc.bg:"var(--bg-card-solid)",transition:"background 0.2s"}}>
                              <div style={{width:46,height:46,borderRadius:"50%",background:`conic-gradient(${sc} ${qa.completeness*3.6}deg, var(--bg-subtle2) 0deg)`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                                <div style={{width:34,height:34,borderRadius:"50%",background:"var(--bg-card-solid)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                                  <span style={{fontSize:11,fontWeight:800,color:sc,fontFamily:"monospace"}}>{qa.completeness}%</span>
                                </div>
                              </div>
                              <div style={{flex:1,minWidth:0}}>
                                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                                  <span style={{fontSize:14,fontWeight:700,color:"var(--text-primary)"}}>{qa.supplierName}</span>
                                  <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:99,background:vc.bg,color:vc.text}}>{vc.label}</span>
                                  {isApproved&&<span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:99,background:"var(--green-light)",color:"var(--green-deep)"}}>Approved</span>}
                                </div>
                                <div style={{fontSize:12,color:"var(--text-secondary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{qa.recommendation}</div>
                              </div>
                              <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
                                {qa.estimatedTotal&&qa.estimatedTotal!=="Not calculated"&&(
                                  <div style={{textAlign:"right"}}>
                                    <div style={{fontSize:10,color:"var(--text-muted)"}}>Total</div>
                                    <div style={{fontSize:13,fontWeight:700,color:"var(--green-dark)",fontFamily:"monospace"}}>{qa.estimatedTotal}</div>
                                  </div>
                                )}
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" style={{transform:isOpen?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.2s"}}><polyline points="6 9 12 15 18 9"/></svg>
                              </div>
                            </div>
                            {isOpen&&(
                              <div style={{borderTop:"1px solid var(--border)",padding:"18px",animation:"cardExpand 0.2s ease"}}>
                                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:16,padding:"12px 14px",background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)"}}>
                                  {[
                                    {l:"Completeness",v:`${qa.completeness}%`,c:sc},
                                    {l:"Subtotal",    v:qa.subtotal||"—",    c:"var(--text-primary)"},
                                    {l:"Carriage",    v:qa.carriageCharge||"—",c:"var(--text-secondary)"},
                                    {l:"Lead time",   v:qa.leadTime||"—",    c:"var(--text-secondary)"},
                                  ].map(s=>(
                                    <div key={s.l}>
                                      <div style={{fontSize:10,color:"var(--text-muted)",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:3}}>{s.l}</div>
                                      <div style={{fontSize:14,fontWeight:700,color:s.c}}>{s.v}</div>
                                    </div>
                                  ))}
                                </div>
                                {qa.matched?.length>0&&(
                                  <div style={{marginBottom:14}}>
                                    <div style={{fontSize:12,fontWeight:600,color:"var(--green-dark)",marginBottom:8}}>Matched items ({qa.matched.length})</div>
                                    <div style={{overflowX:"auto"}}>
                                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:600}}>
                                        <thead>
                                          <tr style={{background:"var(--green-mint)"}}>
                                            {["Item","Req","Quoted","Unit price","Total","Stock","Qty ok","Notes"].map(h=>(
                                              <th key={h} style={{padding:"7px 10px",textAlign:"left",fontWeight:600,color:"var(--green-deep)",fontSize:11}}>{h}</th>
                                            ))}
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {qa.matched.map((m,i)=>(
                                            <tr key={i} style={{borderTop:"1px solid var(--border)",background:i%2===0?"transparent":"var(--bg-subtle)"}}>
                                              <td style={{padding:"7px 10px",fontWeight:500,color:"var(--text-primary)"}}>{m.item}</td>
                                              <td style={{padding:"7px 10px",color:"var(--text-secondary)",fontFamily:"monospace",fontSize:11}}>{m.requestedQty} {m.requestedUnit}</td>
                                              <td style={{padding:"7px 10px",color:"var(--text-secondary)",fontFamily:"monospace",fontSize:11}}>{m.quotedQty||m.requestedQty} {m.quotedUnit||m.requestedUnit}</td>
                                              <td style={{padding:"7px 10px",color:"var(--green-dark)",fontFamily:"monospace",fontWeight:600}}>{m.unitPrice||"—"}</td>
                                              <td style={{padding:"7px 10px",fontFamily:"monospace"}}>{m.lineTotal||"—"}</td>
                                              <td style={{padding:"7px 10px"}}><span style={{fontSize:10,fontWeight:600,padding:"1px 6px",borderRadius:99,background:m.inStock===true?"var(--green-light)":m.inStock===false?"var(--red-light)":"var(--bg-subtle2)",color:m.inStock===true?"var(--green-dark)":m.inStock===false?"var(--red)":"var(--text-muted)"}}>{m.inStock===true?"In stock":m.inStock===false?"No stock":"—"}</span></td>
                                              <td style={{padding:"7px 10px"}}>{m.qtyMatch===false?<span style={{fontSize:10,color:"var(--amber)",fontWeight:700}}>!</span>:<span style={{fontSize:10,color:"var(--green-dark)"}}>ok</span>}</td>
                                              <td style={{padding:"7px 10px",fontSize:11,color:"var(--text-secondary)",maxWidth:140}}>{m.notes||"—"}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                )}
                                {qa.missing?.length>0&&(
                                  <div style={{marginBottom:12}}>
                                    <div style={{fontSize:12,fontWeight:600,color:"var(--red)",marginBottom:8}}>Missing ({qa.missing.length})</div>
                                    {qa.missing.map((m,i)=>(
                                      <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"4px 0",borderBottom:"1px solid var(--border)"}}>
                                        <span style={{color:"var(--text-primary)"}}>{m.item}</span>
                                        <span style={{color:"var(--red)",fontSize:11}}>{m.reason}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {(qa.warnings?.length>0||qa.positives?.length>0)&&(
                                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                                    {qa.positives?.length>0&&(
                                      <div style={{background:"var(--green-mint)",borderRadius:"var(--radius-sm)",padding:"10px 12px"}}>
                                        <div style={{fontSize:11,fontWeight:700,color:"var(--green-dark)",marginBottom:6}}>Positives</div>
                                        {qa.positives.map((p,i)=><div key={i} style={{fontSize:12,color:"var(--green-deep)",marginBottom:2}}>+ {p}</div>)}
                                      </div>
                                    )}
                                    {qa.requiresReview&&(
                                      <div style={{background:"#FFF7ED",border:"1px solid #FED7AA",borderLeft:"4px solid #C77D2E",borderRadius:"var(--radius-sm)",padding:"12px 14px",marginBottom:10,display:"flex",gap:10,alignItems:"flex-start"}}>
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C77D2E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0,marginTop:1}}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17.01"/></svg>
                                        <div>
                                          <div style={{fontSize:12.5,fontWeight:700,color:"#9A5B16",marginBottom:2}}>Check before approving</div>
                                          <div style={{fontSize:12,color:"#9A5B16",lineHeight:1.5}}>The AI flagged something that needs a human eye{qa.riskyPricedLines>0?` (${qa.riskyPricedLines} priced line${qa.riskyPricedLines!==1?"s":""} with low confidence)`:""}. Review the points below and confirm the figures against the original quote before generating a PO.</div>
                                        </div>
                                      </div>
                                    )}
                                    {qa.warnings?.length>0&&(
                                      <div style={{background:"var(--amber-light)",borderRadius:"var(--radius-sm)",padding:"10px 12px"}}>
                                        <div style={{fontSize:11,fontWeight:700,color:"var(--amber)",marginBottom:6}}>Warnings</div>
                                        {qa.warnings.map((w,i)=><div key={i} style={{fontSize:12,color:"var(--amber)",marginBottom:2}}>! {w}</div>)}
                                      </div>
                                    )}
                                  </div>
                                )}
                                <div style={{paddingTop:12,borderTop:"1px solid var(--border)",display:"flex",gap:10,flexWrap:"wrap"}}>
                                  {isApproved?(
                                    <>
                                      <div style={{display:"flex",alignItems:"center",gap:8,background:"var(--green-light)",border:"1px solid var(--green-dark)",borderRadius:"var(--radius-sm)",padding:"8px 14px"}}>
                                        <span style={{fontSize:13,fontWeight:700,color:"var(--green-dark)"}}><Icon name="check_circle" size={14} color="var(--green-dark)" style={{marginRight:5,verticalAlign:"-2px"}}/>PO Approved</span>
                                      </div>
                                      <Btn outline onClick={handleUndoApproval}>Undo</Btn>
                                      <Btn onClick={()=>setView("orders")} color="#15824F">View in Orders</Btn>
                                    </>
                                  ):(
                                    <>
                                      {can.approvePO(myRole)
                                        ? <Btn onClick={()=>setApproveConfirm(qa)} color="#15824F">Approve & generate PO</Btn>
                                        : <div style={{fontSize:12,color:"var(--text-tertiary)",padding:"8px 12px",background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)"}}>A Buyer or Manager approves the PO</div>}
                                      <Btn outline onClick={()=>handleSaveDraftQuote(qa)}>Save to library</Btn>
                                    </>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* SIDE-BY-SIDE COMPARISON VIEW */}
                      {quoteViewMode==="compare"&&(
                        <div style={{overflowX:"auto",background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",boxShadow:"var(--shadow-sm)"}}>
                          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:Math.max(500, 200+allAnalyses.length*160)}}>
                            <thead>
                              <tr>
                                <th style={{padding:"14px 16px",textAlign:"left",position:"sticky",left:0,background:"var(--bg-subtle)",zIndex:2,minWidth:180,borderBottom:"2px solid var(--border)",fontSize:11,fontWeight:700,color:"var(--text-tertiary)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Requested item</th>
                                {allAnalyses.map(qa=>{
                                  const sc = qa.completeness>=80?"var(--green-dark)":qa.completeness>=60?"var(--amber)":"var(--red)";
                                  return(
                                    <th key={qa._id} style={{padding:"14px 16px",textAlign:"center",minWidth:160,borderBottom:"2px solid var(--border)",borderLeft:"1px solid var(--border)",background:"var(--bg-subtle)"}}>
                                      <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:4}}>{qa.supplierName}</div>
                                      <div style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:11,fontWeight:700,color:sc}}>
                                        <span style={{width:7,height:7,borderRadius:"50%",background:sc,display:"inline-block"}}/>
                                        {qa.completeness}% complete
                                      </div>
                                    </th>
                                  );
                                })}
                              </tr>
                            </thead>
                            <tbody>
                              {/* One row per requested item */}
                              {(activeReq.items||[]).map((reqItem,ri)=>(
                                <tr key={ri} style={{borderBottom:"1px solid var(--border)"}}>
                                  <td style={{padding:"10px 16px",position:"sticky",left:0,background:"var(--bg-card-solid)",zIndex:1,fontWeight:500,color:"var(--text-primary)",borderRight:"1px solid var(--border)"}}>
                                    {reqItem.description}
                                    <span style={{display:"block",fontSize:10,color:"var(--text-tertiary)",marginTop:1}}>{reqItem.quantity} {reqItem.unit}</span>
                                  </td>
                                  {allAnalyses.map(qa=>{
                                    const match = (qa.matched||[]).find(m=>m.item&&reqItem.description&&m.item.toLowerCase().includes(reqItem.description.toLowerCase().slice(0,12)) || (m.item&&reqItem.description&&reqItem.description.toLowerCase().includes(m.item.toLowerCase().slice(0,12))));
                                    const missing = (qa.missing||[]).find(m=>m.item&&reqItem.description&&(m.item.toLowerCase().includes(reqItem.description.toLowerCase().slice(0,12))||reqItem.description.toLowerCase().includes(m.item.toLowerCase().slice(0,12))));
                                    return(
                                      <td key={qa._id} style={{padding:"10px 16px",textAlign:"center",borderLeft:"1px solid var(--border)",background:!match&&missing?"var(--red-light)":"transparent"}}>
                                        {match?(
                                          <div>
                                            <div style={{fontSize:13,fontWeight:700,color:"var(--green-dark)",fontFamily:"monospace"}}>{match.unitPrice||match.lineTotal||"-"}</div>
                                            {match.inStock===false&&<div style={{fontSize:9,color:"var(--red)",fontWeight:600,marginTop:1}}>Out of stock</div>}
                                            {match.qtyMatch===false&&<div style={{fontSize:9,color:"var(--amber)",fontWeight:600,marginTop:1}}>Qty differs</div>}
                                          </div>
                                        ):missing?(
                                          <span style={{fontSize:11,color:"var(--red)",fontWeight:600}}>Not quoted</span>
                                        ):(
                                          <span style={{fontSize:11,color:"var(--text-muted)"}}>-</span>
                                        )}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                              {/* Summary rows */}
                              <tr style={{borderTop:"2px solid var(--border)",background:"var(--bg-subtle)"}}>
                                <td style={{padding:"10px 16px",position:"sticky",left:0,background:"var(--bg-subtle)",zIndex:1,fontWeight:700,color:"var(--text-secondary)",fontSize:11,textTransform:"uppercase",letterSpacing:"0.05em"}}>Carriage</td>
                                {allAnalyses.map(qa=>(
                                  <td key={qa._id} style={{padding:"10px 16px",textAlign:"center",borderLeft:"1px solid var(--border)",fontSize:12,color:qa.carriageCharge==="Free"?"var(--green-dark)":"var(--text-secondary)",fontWeight:qa.carriageCharge==="Free"?600:400}}>{qa.carriageCharge||"-"}</td>
                                ))}
                              </tr>
                              <tr style={{background:"var(--bg-subtle)"}}>
                                <td style={{padding:"10px 16px",position:"sticky",left:0,background:"var(--bg-subtle)",zIndex:1,fontWeight:700,color:"var(--text-secondary)",fontSize:11,textTransform:"uppercase",letterSpacing:"0.05em"}}>Lead time</td>
                                {allAnalyses.map(qa=>(
                                  <td key={qa._id} style={{padding:"10px 16px",textAlign:"center",borderLeft:"1px solid var(--border)",fontSize:12,color:"var(--text-secondary)"}}>{qa.leadTime||"-"}</td>
                                ))}
                              </tr>
                              <tr style={{background:"var(--green-mint)",borderTop:"2px solid var(--green-light)"}}>
                                <td style={{padding:"12px 16px",position:"sticky",left:0,background:"var(--green-mint)",zIndex:1,fontWeight:700,color:"var(--green-deep)",fontSize:12}}>Estimated total{marginPct>0?` (+ ${marginPct}% markup)`:""}</td>
                                {allAnalyses.map(qa=>{
                                  const cost = parsePrice(qa.estimatedTotal)||parsePrice(qa.subtotal);
                                  const allCosts = allAnalyses.map(a=>parsePrice(a.estimatedTotal)||parsePrice(a.subtotal)).filter(x=>x!=null);
                                  const isCheapest = cost!=null && allCosts.length>1 && cost===Math.min(...allCosts);
                                  const display = cost!=null ? (marginPct>0 ? cost*(1+marginPct/100) : cost) : null;
                                  return(
                                    <td key={qa._id} style={{padding:"12px 16px",textAlign:"center",borderLeft:"1px solid var(--green-light)"}}>
                                      <div style={{fontSize:15,fontWeight:800,color:"var(--green-dark)",fontFamily:"monospace"}}>{display!=null?`£${display.toFixed(2)}`:(qa.estimatedTotal||"-")}</div>
                                      {isCheapest&&<div style={{fontSize:9,fontWeight:700,color:"var(--green-deep)",background:"var(--green-light)",borderRadius:99,padding:"1px 8px",marginTop:4,display:"inline-block"}}>LOWEST</div>}
                                    </td>
                                  );
                                })}
                              </tr>
                              {/* Action row */}
                              <tr>
                                <td style={{padding:"12px 16px",position:"sticky",left:0,background:"var(--bg-card-solid)",zIndex:1}}></td>
                                {allAnalyses.map(qa=>{
                                  const isApproved = approvedQuoteId===qa._id;
                                  return(
                                    <td key={qa._id} style={{padding:"12px 16px",textAlign:"center",borderLeft:"1px solid var(--border)"}}>
                                      {isApproved?(
                                        <span style={{fontSize:11,fontWeight:700,color:"var(--green-dark)",background:"var(--green-light)",borderRadius:6,padding:"6px 12px",display:"inline-block"}}>Approved</span>
                                      ):(
                                        <button onClick={()=>setApproveConfirm(qa)} style={{fontSize:11,fontWeight:700,color:"white",background:"var(--green-dark)",border:"none",borderRadius:6,padding:"7px 14px",cursor:"pointer"}}>Approve</button>
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {view==="hire"&&(
          <div className="stagger-in" style={{maxWidth:980}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,flexWrap:"wrap",gap:12}}>
              <div>
                <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",margin:0,color:"var(--text-primary)"}}>Hire</h1>
                <p style={{fontSize:14,color:"var(--text-secondary)",marginTop:4}}>Plant &amp; tool hire - on-hire register with delivery, returns and collection tracking</p>
              </div>
              {can.raisePO(myRole)&&(
                <button onClick={()=>setHireForm({})} style={{display:"inline-flex",alignItems:"center",gap:7,fontSize:14,color:"#fff",background:"#15824F",border:"none",borderRadius:"var(--radius-sm)",padding:"10px 18px",cursor:"pointer",fontWeight:700}}>
                  <Icon name="clipboard" size={14} style={{verticalAlign:"-2px"}}/>Raise a hire
                </button>
              )}
            </div>

            {/* Summary strip */}
            {hires.length>0&&(()=>{
              const onHire = hires.filter(h=>h.status==="on-hire");
              const sites = new Set(onHire.map(h=>h.site).filter(Boolean));
              const dueSoon = onHire.filter(h=>{ if(h.returnOpen||!h.returnDate)return false; const d=new Date(h.returnDate); const days=(d-new Date())/(1000*60*60*24); return days<=7; });
              return (
                <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(3,1fr)",gap:12,marginBottom:22,marginTop:14}}>
                  <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"14px 16px"}}>
                    <div style={{fontSize:24,fontWeight:800,color:"var(--text-primary)"}}>{onHire.length}</div>
                    <div style={{fontSize:12,color:"var(--text-secondary)"}}>currently on hire</div>
                  </div>
                  <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"14px 16px"}}>
                    <div style={{fontSize:24,fontWeight:800,color:"var(--text-primary)"}}>{sites.size}</div>
                    <div style={{fontSize:12,color:"var(--text-secondary)"}}>site{sites.size!==1?"s":""} with kit</div>
                  </div>
                  <div style={{background:dueSoon.length?"var(--amber-light)":"var(--bg-card-solid)",border:`1px solid ${dueSoon.length?"var(--amber)":"var(--border)"}`,borderRadius:"var(--radius-md)",padding:"14px 16px"}}>
                    <div style={{fontSize:24,fontWeight:800,color:dueSoon.length?"var(--amber)":"var(--text-primary)"}}>{dueSoon.length}</div>
                    <div style={{fontSize:12,color:dueSoon.length?"var(--amber)":"var(--text-secondary)"}}>due back this week</div>
                  </div>
                </div>
              );
            })()}

            {hireBuyTips.length>0&&(
              <div style={{background:"#FEF6E7",border:"1px solid #F5D9A0",borderRadius:14,padding:"16px 20px",marginBottom:20}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  <span style={{fontSize:11,fontWeight:800,color:"#9A6212",background:"#FBEAC6",borderRadius:99,padding:"2px 9px",textTransform:"uppercase",letterSpacing:"0.04em"}}>AI insight</span>
                  <span style={{fontSize:13,fontWeight:700,color:"#7A4E0E"}}>Hiring often - worth buying?</span>
                </div>
                {hireBuyTips.map((t,i)=>(
                  <div key={i} style={{fontSize:12.5,color:"#5C4410",lineHeight:1.6,marginBottom:i<hireBuyTips.length-1?6:0}}>
                    <strong>{t.description}</strong> — {t.reason}{t.strength==="strong"?" ":""}
                  </div>
                ))}
                <div style={{fontSize:11,color:"#9A6212",marginTop:8,fontStyle:"italic"}}>A suggestion based on your hire history - always check current purchase prices before deciding.</div>
              </div>
            )}

            {hires.length===0?(
              <div style={{textAlign:"center",padding:"60px 20px",color:"var(--text-secondary)"}}>
                <div style={{marginBottom:12,display:"flex",justifyContent:"center"}}><Icon name="clipboard" size={40} color="var(--text-tertiary)"/></div>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>No hire equipment yet</div>
                <div style={{fontSize:13}}>Raise a hire to start tracking plant and tool hire on your sites.</div>
              </div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {hires.map(h=>{
                  const weeks = hireWeeks(h);
                  const cost = hireRunningCost(h);
                  const overdue = h.status==="on-hire" && !h.returnOpen && h.returnDate && (new Date(h.returnDate) < new Date());
                  const statusMap = {
                    "on-order":{label:"On order",bg:"var(--indigo-light)",col:"var(--indigo)"},
                    "on-hire":{label:overdue?"Overdue":"On hire",bg:overdue?"var(--red-light)":"var(--green-light)",col:overdue?"var(--red)":"var(--green-deep)"},
                    "off-hire-requested":{label:"Off-hire requested",bg:"var(--amber-light)",col:"var(--amber)"},
                    "closed":{label:"Closed",bg:"var(--bg-subtle2)",col:"var(--text-secondary)"},
                  };
                  const st = statusMap[h.status]||statusMap["on-order"];
                  return (
                    <div key={h.id} style={{background:"var(--bg-card-solid)",border:`1px solid ${overdue?"var(--red)":"var(--border)"}`,borderRadius:"var(--radius-md)",padding:"16px 18px",boxShadow:"var(--shadow-sm)"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,flexWrap:"wrap"}}>
                        <div style={{flex:1,minWidth:200}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                            <span style={{fontSize:15,fontWeight:700,color:"var(--text-primary)"}}>{h.description}</span>
                            <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99,background:st.bg,color:st.col,textTransform:"uppercase",letterSpacing:"0.03em"}}>{st.label}</span>
                          </div>
                          <div style={{fontSize:12.5,color:"var(--text-secondary)",lineHeight:1.7}}>
                            <strong>{h.hireRef}</strong> · {h.supplier||"supplier TBC"}{h.site?` · ${h.site}`:""}{h.jobRef?` · ${h.jobRef}`:""}
                          </div>
                          <div style={{fontSize:12.5,color:"var(--text-secondary)",lineHeight:1.7}}>
                            {h.status==="on-hire"&&<>On hire <strong>{weeks} week{weeks!==1?"s":""}</strong>{can.viewCosts(myRole)&&cost!=null?` · ~£${cost.toFixed(2)} so far`:""}{" · "}</>}
                            {h.returnOpen?"Return: open / TBC":(h.returnDate?`Return by ${new Date(h.returnDate).toLocaleDateString("en-GB")}`:"Return date not set")}
                            {h.weeklyRate&&can.viewCosts(myRole)?` · ${h.weeklyRate}/wk`:""}
                          </div>
                          {h.deliveryAiNote&&<div style={{fontSize:11.5,color:"var(--text-secondary)",marginTop:4,padding:"6px 10px",background:"var(--bg-subtle2)",borderRadius:6,borderLeft:"3px solid #15824F"}}><span style={{fontWeight:700,color:"#15824F"}}>AI read photo:</span> {h.deliveryAiNote}</div>}
                          {h.collectionRef&&<div style={{fontSize:12,color:"var(--text-tertiary)",marginTop:2}}>Collection ref: {h.collectionRef}</div>}
                        </div>
                        {(h.deliveredPhoto||h.collectionPhoto)&&(
                          <div style={{display:"flex",gap:6}}>
                            {h.deliveredPhoto&&<a href={h.deliveredPhoto} target="_blank" rel="noreferrer"><img src={h.deliveredPhoto} alt="delivery" style={{width:54,height:54,objectFit:"cover",borderRadius:8,border:"1px solid var(--border)"}}/></a>}
                            {h.collectionPhoto&&<a href={h.collectionPhoto} target="_blank" rel="noreferrer"><img src={h.collectionPhoto} alt="collection" style={{width:54,height:54,objectFit:"cover",borderRadius:8,border:"1px solid var(--border)"}}/></a>}
                          </div>
                        )}
                      </div>

                      {/* Lifecycle actions */}
                      {can.raisePO(myRole)&&h.status!=="closed"&&(
                        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12,paddingTop:12,borderTop:"1px solid var(--border)"}}>
                          {h.status==="on-order"&&(
                            <button onClick={()=>setDeliverModal({hireId:h.id})} style={{fontSize:12.5,fontWeight:600,color:"#15824F",background:"var(--green-light)",border:"none",borderRadius:"var(--radius-sm)",padding:"7px 13px",cursor:"pointer"}}>Mark delivered + photo</button>
                          )}
                          {h.status==="on-hire"&&(<>
                            <button onClick={()=>setOffHireModal({hireId:h.id})} style={{fontSize:12.5,fontWeight:600,color:"var(--amber)",background:"var(--amber-light)",border:"none",borderRadius:"var(--radius-sm)",padding:"7px 13px",cursor:"pointer"}}>Off-hire / request collection</button>
                            <button onClick={()=>setExtendModal({hireId:h.id, current:h.returnDate||""})} style={{fontSize:12.5,fontWeight:600,color:"var(--text-secondary)",background:"var(--bg-subtle2)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"7px 13px",cursor:"pointer"}}>Extend</button>
                          </>)}
                          {h.status==="off-hire-requested"&&(<>
                            <label style={{fontSize:12.5,fontWeight:600,color:"#15824F",background:"var(--green-light)",borderRadius:"var(--radius-sm)",padding:"7px 13px",cursor:"pointer"}}>
                              Add collection photo
                              <input type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={e=>{ if(e.target.files?.[0]) addCollectionPhoto(h.id, e.target.files[0]); }}/>
                            </label>
                            <button onClick={()=>setCloseHireModal({hireId:h.id})} style={{fontSize:12.5,fontWeight:600,color:"#fff",background:"#15824F",border:"none",borderRadius:"var(--radius-sm)",padding:"7px 13px",cursor:"pointer"}}>Enter collection ref &amp; close</button>
                          </>)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {view==="orders"&&(
          <div className="stagger-in" style={{maxWidth:900}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24,flexWrap:"wrap",gap:12}}>
              <div>
                <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",margin:0,color:"var(--text-primary)"}}>Orders</h1>
                <p style={{fontSize:14,color:"var(--text-secondary)",marginTop:4}}>{visibleOrders.length} {can.viewAllJobs(myRole)?"total orders":"of your deliveries"}</p>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                {can.raisePO(myRole)&&(
                  <button onClick={()=>setQuickPO({items:[{description:"",quantity:"",unitPrice:""}]})} style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,color:"#fff",background:"#D97706",border:"none",borderRadius:"var(--radius-sm)",padding:"8px 15px",cursor:"pointer",fontWeight:700}}>
                    <Icon name="clock" size={13} style={{verticalAlign:"-2px"}}/>Quick PO
                  </button>
                )}
                {orders.length>0&&(
                  <button onClick={()=>downloadCSV(`orders-${new Date().toISOString().split("T")[0]}.csv`, orders.map(o=>({
                    PO: o.poNumber, Status: o.status, Supplier: o.supplier||"", Job: o.jobRef||"", Site: o.site||"",
                    EstimatedTotal: o.estimatedTotal||o.analysis?.estimatedTotal||"", PODate: o.poDate||"",
                    ExpectedDelivery: o.expectedDelivery?new Date(o.expectedDelivery).toLocaleDateString("en-GB"):"",
                    Items: (o.items||[]).map(i=>`${i.quantity} ${i.unit} ${i.description}`).join("; ")
                  })))} style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,color:"var(--indigo)",background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"7px 14px",cursor:"pointer",fontWeight:500}}>
                    <Icon name="download" size={13} style={{marginRight:5,verticalAlign:"-2px"}}/>Export
                  </button>
                )}
                {[
                  {id:"all",      label:"All",       count:visibleOrders.length},
                  {id:"active",   label:"Active",    count:visibleOrders.filter(o=>o.status!=="delivered").length},
                  {id:"delivered",label:"Delivered", count:visibleOrders.filter(o=>o.status==="delivered").length},
                ].map(f=>(
                  <button key={f.id} onClick={()=>setOrderFilter(f.id)}
                    style={{padding:"7px 16px",borderRadius:"var(--radius-sm)",border:`1px solid ${orderFilter===f.id?"var(--green-dark)":"var(--border)"}`,background:orderFilter===f.id?"var(--green-mint)":"var(--bg-card-solid)",color:orderFilter===f.id?"var(--green-deep)":"var(--text-secondary)",fontSize:13,fontWeight:orderFilter===f.id?600:400,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
                    {f.label}
                    {f.count>0&&<span style={{fontSize:10,fontWeight:700,background:orderFilter===f.id?"var(--green-dark)":"var(--bg-subtle2)",color:orderFilter===f.id?"white":"var(--text-muted)",padding:"1px 6px",borderRadius:99}}>{f.count}</span>}
                  </button>
                ))}
              </div>
            </div>

            {visibleOrders.filter(o=>{
              if(orderFilter==="active") return o.status!=="delivered";
              if(orderFilter==="delivered") return o.status==="delivered";
              return true;
            }).length===0?(
              <Card style={{textAlign:"center",padding:"48px 32px",color:"var(--text-tertiary)"}}>
                <div style={{fontSize:15,marginBottom:8}}>No orders yet</div>
                <div style={{fontSize:13}}>Approve a supplier quote to generate a purchase order</div>
              </Card>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {visibleOrders.filter(o=>{
                  if(orderFilter==="active") return o.status!=="delivered";
                  if(orderFilter==="delivered") return o.status==="delivered";
                  return true;
                }).map(order=>{
                  const STATUS_STEPS = [
                    {key:"pending-send",label:"Ready to send",color:"var(--green-dark)",  bg:"var(--green-mint)"},
                    {key:"sent",        label:"Sent",          color:"var(--green-dark)",  bg:"var(--green-light)"},
                    {key:"confirmed",   label:"Confirmed",     color:"var(--green-dark)",  bg:"var(--green-light)"},
                    {key:"delivered",   label:"Delivered",     color:"var(--green-dark)",  bg:"var(--green-light)"},
                  ];
                  const stepIdx   = STATUS_STEPS.findIndex(s=>s.key===order.status);
                  const curStep   = STATUS_STEPS[stepIdx]||STATUS_STEPS[0];
                  const isExpanded = expandedOrder===order.id;

                  return(
                    <div key={order.id} style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",border:`1px solid ${isExpanded?"var(--green-dark)":"var(--border)"}`,overflow:"hidden",boxShadow:isExpanded?"var(--shadow-md)":"var(--shadow-sm)",transition:"box-shadow 0.2s cubic-bezier(0.16,1,0.3,1),border-color 0.2s"}}>

                      {/* Clickable header row */}
                      <div onClick={()=>setExpandedOrder(isExpanded?null:order.id)}
                        style={{padding:"14px 20px",display:"flex",alignItems:"center",gap:14,cursor:"pointer",background:isExpanded?"var(--green-mint)":"var(--bg-card-solid)",transition:"background 0.2s"}}>
                        <div style={{width:38,height:38,borderRadius:10,background:order.status==="pending-send"?"linear-gradient(135deg,#1E9E63,#15824F)":order.status==="sent"?"linear-gradient(135deg,#5B5BD6,#4A4AB8)":order.status==="confirmed"?"linear-gradient(135deg,#15824F,#047857)":"linear-gradient(135deg,#4B5563,#374151)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>
                          <Icon name={order.status==="pending-send"?"package":order.status==="sent"?"plane":order.status==="confirmed"?"check_circle":"flag"} size={18} color="white"/>
                        </div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2,flexWrap:"wrap"}}>
                            <span style={{fontSize:14,fontWeight:700,color:"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace"}}>{order.poNumber}</span>
                            <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99,background:curStep.bg,color:curStep.color}}>{curStep.label}</span>
                          </div>
                          <div style={{fontSize:12,color:"var(--text-secondary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{order.supplier} · {order.jobRef} · {order.site}</div>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:12,flexShrink:0}}>
                          {order.expectedDelivery&&order.status!=="delivered"&&(
                            <span style={{fontSize:11,color:"var(--green-dark)",background:"var(--green-light)",padding:"3px 10px",borderRadius:99,fontWeight:500}}>{new Date(order.expectedDelivery).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</span>
                          )}
                          <span style={{fontSize:11,color:"var(--text-muted)"}}>{order.poDate}</span>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" style={{transform:isExpanded?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.2s",flexShrink:0}}><polyline points="6 9 12 15 18 9"/></svg>
                        </div>
                      </div>

                      {/* Expanded body */}
                      {isExpanded&&(
                        <div style={{borderTop:"1px solid var(--border)",animation:"cardExpand 0.2s ease"}}>

                          {/* Status timeline */}
                          <div style={{padding:"16px 20px",borderBottom:"1px solid var(--border)",background:"var(--bg-subtle)"}}>
                            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:4}}>
                              {STATUS_STEPS.map((s,i)=>(
                                <div key={s.key} style={{display:"flex",alignItems:"center",flex:i<STATUS_STEPS.length-1?1:"none"}}>
                                  <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                                    <div style={{width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,background:stepIdx>i?s.color:stepIdx===i?s.color:"var(--bg-subtle2)",color:stepIdx>=i?"white":"var(--text-muted)",border:`2px solid ${stepIdx>=i?s.color:"var(--border)"}`}}>
                                      {stepIdx>i?<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>:i+1}
                                    </div>
                                    <span style={{fontSize:9,color:stepIdx===i?s.color:"var(--text-muted)",fontWeight:stepIdx===i?700:400,whiteSpace:"nowrap"}}>{s.label}</span>
                                  </div>
                                  {i<STATUS_STEPS.length-1&&<div style={{flex:1,height:2,background:stepIdx>i?s.color:"var(--bg-subtle2)",margin:"0 4px",marginBottom:14}}/>}
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Order details */}
                          <div style={{padding:"16px 20px",display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:16}}>
                            {/* Left: items */}
                            <div>
                              <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginBottom:10,textTransform:"uppercase",letterSpacing:"0.08em"}}>Order items</div>
                              {(order.items||[]).map((item,i)=>(
                                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid var(--border)"}}>
                                  <div style={{fontSize:13,color:"var(--text-primary)",flex:1}}>{item.description}</div>
                                  <div style={{fontSize:12,color:"var(--text-secondary)",fontFamily:"monospace",flexShrink:0,marginLeft:12}}>{item.quantity} {item.unit}</div>
                                </div>
                              ))}
                              <div style={{marginTop:12}}>
                                <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0"}}><span style={{fontSize:12,color:"var(--text-secondary)"}}>Supplier</span><span style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{order.supplier}</span></div>
                                <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0"}}><span style={{fontSize:12,color:"var(--text-secondary)"}}>Job ref</span><span style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{order.jobRef}</span></div>
                                {order.estimatedTotal&&<div style={{display:"flex",justifyContent:"space-between",padding:"4px 0"}}><span style={{fontSize:12,color:"var(--text-secondary)"}}>Total</span><span style={{fontSize:12,fontWeight:700,color:"var(--green-dark)",fontFamily:"monospace"}}>{order.estimatedTotal}</span></div>}
                              </div>
                            </div>

                            {/* Right: actions */}
                            <div>
                              <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginBottom:10,textTransform:"uppercase",letterSpacing:"0.08em"}}>Actions</div>

                              {order.status==="pending-send"&&!can.viewCosts(myRole)&&(
                                <div style={{fontSize:12.5,color:"var(--text-secondary)",padding:"10px 14px",background:"var(--bg-subtle2)",borderRadius:"var(--radius-sm)",border:"1px solid var(--border)"}}>The buyer is arranging this order. You'll be able to sign off the delivery here once it's on its way.</div>
                              )}
                              {order.status==="pending-send"&&can.viewCosts(myRole)&&(
                                <div>
                                  <div style={{marginBottom:10}}>
                                    <label style={{fontSize:11,color:"var(--text-secondary)",display:"block",marginBottom:5}}>Note to supplier (optional)</label>
                                    <textarea value={orderNote[order.id]||""} onChange={e=>setOrderNote(p=>({...p,[order.id]:e.target.value}))} placeholder="Any special instructions..." style={{width:"100%",height:70,padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12,outline:"none",resize:"none",fontFamily:"inherit"}}></textarea>
                                  </div>
                                  <div style={{marginBottom:12}}>
                                    <label style={{fontSize:11,color:"var(--text-secondary)",display:"block",marginBottom:5}}>Delivery or collection</label>
                                    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8}}>
                                      {[["direct","Deliver to site"],["collect","Collection"],["alternative","Alternative address"]].map(([val,lab])=>{
                                        const active=(order.deliveryMethod||"direct")===val;
                                        return <button key={val} onClick={()=>setOrders(p=>p.map(o=>o.id===order.id?{...o,deliveryMethod:val}:o))} style={{padding:"7px 13px",borderRadius:"var(--radius-sm)",border:`1px solid ${active?"#15824F":"var(--border)"}`,background:active?"var(--green-light)":"var(--bg-card-solid)",color:active?"var(--green-dark)":"var(--text-secondary)",fontSize:12.5,fontWeight:active?700:500,cursor:"pointer"}}>{lab}</button>;
                                      })}
                                    </div>
                                    {(order.deliveryMethod||"direct")==="direct" && (
                                      <input value={order.site||""} onChange={e=>setOrders(p=>p.map(o=>o.id===order.id?{...o,site:e.target.value}:o))} placeholder="Site delivery address" style={{width:"100%",boxSizing:"border-box",padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                                    )}
                                    {order.deliveryMethod==="alternative" && (
                                      <input value={order.collectFrom||""} onChange={e=>setOrders(p=>p.map(o=>o.id===order.id?{...o,collectFrom:e.target.value}:o))} placeholder="Alternative delivery address" style={{width:"100%",boxSizing:"border-box",padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                                    )}
                                    {order.deliveryMethod==="collect" && (
                                      <input value={order.collectFrom||""} onChange={e=>setOrders(p=>p.map(o=>o.id===order.id?{...o,collectFrom:e.target.value}:o))} placeholder="Collect from (branch / depot)" style={{width:"100%",boxSizing:"border-box",padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                                    )}
                                  </div>
                                  <div style={{marginBottom:12}}>
                                    <label style={{fontSize:11,color:"var(--text-secondary)",display:"block",marginBottom:5}}>Required by (delivery date)</label>
                                    <input type="date" value={order.deliveryDate||expectedDelivery[order.id]||""} onChange={e=>{const v=e.target.value;setExpectedDelivery(p=>({...p,[order.id]:v}));setOrders(p=>p.map(o=>o.id===order.id?{...o,deliveryDate:v,expectedDelivery:v}:o));}} style={{padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                                  </div>
                                  <div style={{fontSize:11,color:"var(--text-tertiary)",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
                                    A branded PO PDF (items, delivery, job ref, invoicing email) will be attached automatically.
                                  </div>
                                  {(EMAIL_VIA_SERVER||settings.resendKey)?(
                                    <Btn onClick={()=>handleSendOrder(order)} disabled={sendingOrder===order.id} color="#15824F">
                                      {sendingOrder===order.id?<><Spinner/> Sending...</>:"Send order to supplier"}
                                    </Btn>
                                  ):(
                                    <div style={{fontSize:12,color:"var(--text-tertiary)"}}>Email sending is being set up</div>
                                  )}
                                </div>
                              )}

                              {order.status==="sent"&&(
                                <div>
                                  <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:10}}>{can.viewCosts(myRole)?"Mark this order as confirmed manually, or upload the supplier's confirmation document.":"When the materials arrive, take a photo of the delivery note to sign off this delivery."}</div>
                                  <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                                    {can.viewCosts(myRole)&&<Btn onClick={()=>{setOrders(p=>p.map(o=>o.id===order.id?{...o,status:"confirmed",confirmedAt:new Date().toISOString()}:o));logActivity("Order confirmed",`${order.poNumber} (${order.supplier}) marked as confirmed`,{entity:"order",jobRef:order.jobRef});}} color="#15824F">Mark as confirmed</Btn>}
                                    <label style={{fontSize:13,fontWeight:600,color:"white",background:"#15824F",borderRadius:"var(--radius-sm)",padding:"8px 14px",cursor:"pointer",display:"inline-flex",alignItems:"center",gap:7}}>
                                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
                                      {order.deliveryPhoto?"Replace delivery photo":"Photo + sign off delivery"}
                                      <input type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={e=>{const f=e.target.files&&e.target.files[0];deliverWithPhoto(order,f);e.target.value="";}}/>
                                    </label>
                                    <Btn outline onClick={()=>markOrderDelivered(order,null)}>Mark delivered (no photo)</Btn>
                                    {can.deleteItems(myRole) && order.status!=="cancelled" && <Btn outline onClick={()=>setCancelOrderConfirm(order)} style={{color:"var(--red)"}}>Cancel order</Btn>}
                                  </div>
                                  <label style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:"var(--bg-subtle)",border:"1px dashed var(--border)",borderRadius:"var(--radius-sm)",cursor:"pointer",marginBottom:10}}>
                                    <input type="file" accept=".pdf,.jpg,.png,.doc,.docx" style={{display:"none"}} onChange={e=>handleOrderConfirmationUpload(e.target.files[0],order.id)}/>
                                    <span style={{fontSize:13,color:"var(--text-secondary)"}}>Or upload confirmation document</span>
                                    <span style={{fontSize:12,color:"var(--text-muted)"}}>PDF, Word, or image</span>
                                  </label>
                                  <div style={{fontSize:11,color:"var(--text-tertiary)"}}>Expected delivery: {order.expectedDelivery?new Date(order.expectedDelivery).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"}):"Not set"}</div>
                                </div>
                              )}

                              {order.status==="confirmed"&&(
                                <div>
                                  {order.confirmationDoc&&<div style={{fontSize:12,color:"var(--green-dark)",marginBottom:10}}>Confirmation received: {order.confirmationDoc.label||"document"}</div>}
                                  <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:12}}>Expected delivery: {order.expectedDelivery?new Date(order.expectedDelivery).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"}):"Not set"}</div>
                                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                                    <label style={{fontSize:13,fontWeight:600,color:"white",background:"#15824F",borderRadius:"var(--radius-sm)",padding:"8px 14px",cursor:"pointer",display:"inline-flex",alignItems:"center",gap:7}}>
                                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
                                      {order.deliveryPhoto?"Replace delivery photo":"Photo + sign off delivery"}
                                      <input type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={e=>{const f=e.target.files&&e.target.files[0];deliverWithPhoto(order,f);e.target.value="";}}/>
                                    </label>
                                    <Btn outline onClick={()=>markOrderDelivered(order,null)}>Mark delivered (no photo)</Btn>
                                  </div>
                                </div>
                              )}

                              {order.status==="delivered"&&(
                                <div>
                                  <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--green-light)",border:"1px solid var(--green-dark)",borderRadius:"var(--radius-sm)",padding:"12px 16px"}}>
                                    <span style={{fontSize:16}}>D</span>
                                    <div>
                                      <div style={{fontSize:13,fontWeight:600,color:"var(--green-dark)"}}>Order delivered</div>
                                      {order.deliveredAt&&<div style={{fontSize:11,color:"var(--green-dark)",opacity:0.8}}>{new Date(order.deliveredAt).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}{order.signedOffBy?` - signed off by ${order.signedOffBy}`:""}</div>}
                                    </div>
                                  </div>
                                  {order.deliveryPhoto&&(
                                    <div style={{marginTop:10}}>
                                      <div style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.06em"}}>Delivery note</div>
                                      <a href={order.deliveryPhoto} target="_blank" rel="noreferrer"><img src={order.deliveryPhoto} alt="Delivery note" style={{maxWidth:220,maxHeight:220,borderRadius:"var(--radius-sm)",border:"1px solid var(--border)",cursor:"pointer"}}/></a>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {view==="suppliers"&&(
          <div className="stagger-in" style={{maxWidth:900}}>
            <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",marginBottom:4,color:"var(--text-primary)"}}>Suppliers</h1>
            <p style={{fontSize:14,color:"var(--text-secondary)",marginBottom:24}}>Manage your supplier accounts and contact details</p>
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"repeat(auto-fill,minmax(280px,1fr))",gap:12,marginBottom:24}}>
              {suppliers.map(s=>(
                <Card key={s.id}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div style={{width:40,height:40,background:"linear-gradient(135deg,var(--green),var(--green-dark))",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",color:"white",fontWeight:700,fontSize:16,flexShrink:0}}>{(s.name||"?")[0]}</div>
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={()=>{ const n=normSupplier(s); setEditSup({ ...n, branches:[...n.branches], contacts:n.contacts.map(c=>({...c})) }); }} style={{fontSize:11,color:"var(--green-dark)",background:"var(--green-light)",border:"none",borderRadius:6,padding:"3px 8px",cursor:"pointer",fontWeight:600}}>Edit</button>
                      <button onClick={()=>{ if(!can.deleteItems(myRole)){showToast("Only a Manager can remove suppliers.","warn");return;} logActivity("Supplier removed",`${s.name} removed from suppliers`,{entity:"supplier"}); setSuppliers(p=>p.filter(x=>x.id!==s.id)); showToast("Supplier removed"); }} style={{fontSize:11,color:"var(--red)",background:"var(--red-light)",border:"none",borderRadius:6,padding:"3px 8px",cursor:"pointer"}}>Remove</button>
                    </div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3,flexWrap:"wrap"}}>
                    <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)"}}>{s.name}</div>
                    {s.tier==="ad-hoc"
                      ? <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99,background:"var(--amber-light)",color:"var(--amber)",textTransform:"uppercase",letterSpacing:"0.03em"}}>Ad-hoc</span>
                      : <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99,background:"var(--green-light)",color:"var(--green-deep)",textTransform:"uppercase",letterSpacing:"0.03em"}}>Approved</span>}
                  </div>
                  {(s.contacts&&s.contacts.length)?(
                    <div style={{marginBottom:8}}>
                      {s.contacts.slice(0,3).map(c=>(
                        <div key={c.id} style={{fontSize:12,color:"var(--text-secondary)",lineHeight:1.5}}>
                          {c.name&&<strong style={{color:"var(--text-primary)",fontWeight:600}}>{c.name}</strong>}{c.name&&" · "}{c.email||<span style={{color:"var(--amber)"}}>no email</span>}{c.branch&&<span style={{color:"var(--text-tertiary)"}}> ({c.branch})</span>}
                        </div>
                      ))}
                      {s.contacts.length>3&&<div style={{fontSize:11,color:"var(--text-tertiary)"}}>+{s.contacts.length-3} more contact{s.contacts.length-3!==1?"s":""}</div>}
                    </div>
                  ):(
                    <div style={{fontSize:12,color:"var(--amber)",marginBottom:8}}>No contact yet - tap Edit to add one</div>
                  )}
                  {(s.branches&&s.branches.length>0)&&(
                    <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>
                      {s.branches.map(b=><span key={b} style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:"var(--bg-subtle2)",color:"var(--text-tertiary)"}}>{b}</span>)}
                    </div>
                  )}
                  <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>
                    {(s.categories||[]).map(cat=><Badge key={cat} bg="var(--green-light)" text="var(--green-deep)">{cat}</Badge>)}
                  </div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:4}}>
                  {requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length>0&&(
                    <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:"var(--bg-subtle2)",color:"var(--text-tertiary)"}}>
                      {requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length} RFQ{requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length!==1?"s":""}
                    </span>
                  )}
                  {requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length>0&&(
                    <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:Math.round(requests.filter(r=>r.sentTo?.some(st=>st.id===s.id&&st.saved)).length/requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length*100)>=80?"var(--green-light)":Math.round(requests.filter(r=>r.sentTo?.some(st=>st.id===s.id&&st.saved)).length/requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length*100)>=50?"var(--amber-light)":"var(--red-light)",color:Math.round(requests.filter(r=>r.sentTo?.some(st=>st.id===s.id&&st.saved)).length/requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length*100)>=80?"var(--green-dark)":Math.round(requests.filter(r=>r.sentTo?.some(st=>st.id===s.id&&st.saved)).length/requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length*100)>=50?"var(--amber)":"var(--red)"}}>
                      {Math.round(requests.filter(r=>r.sentTo?.some(st=>st.id===s.id&&st.saved)).length/requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length*100)}% response
                    </span>
                  )}
                  {quoteLibrary.filter(q=>q.supplierName===s.name).length>0&&(
                    <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:Math.round(quoteLibrary.filter(q=>q.supplierName===s.name).reduce((a,q)=>a+(q.completeness||0),0)/quoteLibrary.filter(q=>q.supplierName===s.name).length)>=80?"var(--green-light)":Math.round(quoteLibrary.filter(q=>q.supplierName===s.name).reduce((a,q)=>a+(q.completeness||0),0)/quoteLibrary.filter(q=>q.supplierName===s.name).length)>=60?"var(--amber-light)":"var(--red-light)",color:Math.round(quoteLibrary.filter(q=>q.supplierName===s.name).reduce((a,q)=>a+(q.completeness||0),0)/quoteLibrary.filter(q=>q.supplierName===s.name).length)>=80?"var(--green-dark)":Math.round(quoteLibrary.filter(q=>q.supplierName===s.name).reduce((a,q)=>a+(q.completeness||0),0)/quoteLibrary.filter(q=>q.supplierName===s.name).length)>=60?"var(--amber)":"var(--red)"}}>
                      avg {Math.round(quoteLibrary.filter(q=>q.supplierName===s.name).reduce((a,q)=>a+(q.completeness||0),0)/quoteLibrary.filter(q=>q.supplierName===s.name).length)}%
                    </span>
                  )}
                  {orders.filter(o=>o.supplier===s.name).length>0&&(
                    <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:"var(--indigo-light)",color:"var(--indigo)"}}>
                      {orders.filter(o=>o.supplier===s.name).length} PO{orders.filter(o=>o.supplier===s.name).length!==1?"s":""}
                    </span>
                  )}
                  {requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length===0&&quoteLibrary.filter(q=>q.supplierName===s.name).length===0&&(
                    <span style={{fontSize:11,color:"var(--text-muted)"}}>No activity yet</span>
                  )}
                </div>
                </Card>
              ))}
            </div>
            <Card>
              <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)",marginBottom:14}}>Add a supplier</div>
              <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr 1fr auto",gap:10,alignItems:"end"}}>
                {[
                  {label:"Company name",val:"name",ph:"e.g. BSS Industrial"},
                  {label:"Quote email",val:"email",ph:"quotes@supplier.co.uk"},
                  {label:"Trades (comma-sep)",val:"categories",ph:"Plumbing, HVAC"},
                ].map(f=>(
                  <div key={f.val}>
                    <label style={{fontSize:11,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:5}}>{f.label}</label>
                    <input value={newSup[f.val]||""} onChange={e=>setNewSup(p=>({...p,[f.val]:e.target.value}))} placeholder={f.ph} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                  </div>
                ))}
                <Btn onClick={()=>{
                  if(!can.manageSuppliers(myRole)){showToast("Only a Buyer or Manager can add suppliers.","warn");return;}
                  if(!newSup.name?.trim()||!newSup.email?.trim()){showToast("Name and email required","warn");return;}
                  const ns=normSupplier({id:Date.now(),name:newSup.name.trim(),email:newSup.email.trim(),categories:(newSup.categories||"General").split(",").map(s=>s.trim()).filter(Boolean)});
                  setSuppliers(p=>[...p,ns]);setNewSup({name:"",email:"",categories:""});showToast(`${ns.name} added`);
                }} color="#15824F">Add</Btn>
              </div>
              <div style={{fontSize:11,color:"var(--text-muted)",marginTop:10}}>Tip: after adding, tap Edit on a supplier to add more named contacts (each with their own email) and branches.</div>
            </Card>
          </div>
        )}

        {view==="requests"&&(
          <div className="stagger-in" style={{maxWidth:1000}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
              <div>
                <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",margin:0,color:"var(--text-primary)"}}>All requests</h1>
                <p style={{fontSize:14,color:"var(--text-secondary)",marginTop:4}}>{requests.length} total requests</p>
              </div>
              <div style={{display:"flex",gap:8}}>
                {requests.length>0&&(
                  <button onClick={()=>downloadCSV(`requests-${new Date().toISOString().split("T")[0]}.csv`, requests.map(r=>({
                    ID:r.id, JobRef:r.jobRef||"", Site:r.site||"", Trade:r.trade||"", Status:r.status||"",
                    Created:r.created||"", Items:(r.items||[]).length, Suppliers:(r.sentTo||[]).length,
                    QuotesIn:(r.sentTo||[]).filter(s=>s.saved).length, Notes:r.notes||""
                  })))} style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,color:"var(--indigo)",background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"9px 14px",cursor:"pointer",fontWeight:500}}><Icon name="download" size={13} style={{marginRight:5,verticalAlign:"-2px"}}/>Export</button>
                )}
                <Btn onClick={()=>{setView("new");resetNewRequest();}} color="#15824F">+ New request</Btn>
              </div>
            </div>

            {/* Filter bar */}
            {requests.length>0&&(
              <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
                <input value={reqSearch} onChange={e=>setReqSearch(e.target.value)} placeholder="Search job ref or site..." style={{flex:"1 1 200px",minWidth:160,padding:"9px 14px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                <select value={reqFilterStatus} onChange={e=>setReqFilterStatus(e.target.value)} style={{padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",cursor:"pointer"}}>
                  <option value="all">All statuses</option>
                  <option value="draft">Draft</option>
                  <option value="pending">Pending quotes</option>
                  <option value="received">Quotes received</option>
                  <option value="approved">Approved</option>
                </select>
                <select value={reqFilterTrade} onChange={e=>setReqFilterTrade(e.target.value)} style={{padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",cursor:"pointer"}}>
                  <option value="all">All trades</option>
                  {TRADES.map(t=><option key={t} value={t}>{t}</option>)}
                </select>
                {(reqFilterStatus!=="all"||reqFilterTrade!=="all"||reqSearch)&&(
                  <button onClick={()=>{setReqFilterStatus("all");setReqFilterTrade("all");setReqSearch("");}} style={{fontSize:12,color:"var(--text-secondary)",background:"var(--bg-subtle2)",border:"none",borderRadius:"var(--radius-sm)",padding:"9px 14px",cursor:"pointer"}}>Clear</button>
                )}
              </div>
            )}
            <div style={{display:"flex",gap:8,marginBottom:14}}>
              <button onClick={()=>setShowArchived(false)} style={{fontSize:12,fontWeight:600,padding:"7px 16px",borderRadius:99,border:"1px solid var(--border)",cursor:"pointer",background:!showArchived?"var(--green-dark)":"var(--bg-card-solid)",color:!showArchived?"white":"var(--text-secondary)"}}>Active</button>
              <button onClick={()=>setShowArchived(true)} style={{fontSize:12,fontWeight:600,padding:"7px 16px",borderRadius:99,border:"1px solid var(--border)",cursor:"pointer",background:showArchived?"var(--green-dark)":"var(--bg-card-solid)",color:showArchived?"white":"var(--text-secondary)"}}>Archived ({requests.filter(r=>r.archived).length})</button>
            </div>
            <Card>
              {requests.length===0?(
                <div style={{textAlign:"center",padding:"40px 0",color:"var(--text-tertiary)"}}>
                  <div style={{fontSize:15,marginBottom:8}}>No requests yet</div>
                  <div style={{fontSize:13}}>Create your first material request to get started</div>
                </div>
              ):(
                <div>
                  <div style={{display:"grid",gridTemplateColumns:"80px 1fr 120px 100px 80px 140px",gap:8,padding:"10px 16px",background:"var(--bg-subtle)",fontSize:11,fontWeight:600,color:"var(--text-tertiary)",textTransform:"uppercase",letterSpacing:"0.05em",borderRadius:"var(--radius-sm) var(--radius-sm) 0 0"}}>
                    <span>ID</span><span>Job ref</span><span>Trade</span><span>Status</span><span>Quotes</span><span>Actions</span>
                  </div>
                  {(can.viewAllJobs(myRole)?requests:requests.filter(r=>(r.createdBy||"").toLowerCase()===myEmail)).filter(r=>{
                    if(showArchived ? !r.archived : r.archived) return false;
                    if(reqFilterStatus!=="all"&&r.status!==reqFilterStatus) return false;
                    if(reqFilterTrade!=="all"&&r.trade!==reqFilterTrade) return false;
                    if(reqSearch){
                      const q=reqSearch.toLowerCase();
                      if(!((r.jobRef||"").toLowerCase().includes(q)||(r.site||"").toLowerCase().includes(q)||(r.id||"").toLowerCase().includes(q))) return false;
                    }
                    return true;
                  }).map((r,idx)=>{
                    const sc = STATUS[r.status]||STATUS.draft;
                    const quotesIn = (r.sentTo||[]).filter(s=>s.saved).length;
                    const quotesTotal = (r.sentTo||[]).length;
                    return(
                      <div key={r.id} style={{display:"grid",gridTemplateColumns:"80px 1fr 120px 100px 80px 140px",gap:8,padding:"12px 16px",borderTop:"1px solid var(--border)",alignItems:"center",fontSize:13}}>
                        <span style={{fontFamily:"'JetBrains Mono',monospace",color:"var(--green-dark)",fontWeight:600,fontSize:12}}>{r.id}</span>
                        <div>
                          <div style={{fontWeight:500,color:"var(--text-primary)"}}>{r.jobRef}</div>
                          <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:1}}>{r.site}{r.notes&&<span style={{marginLeft:6,color:"var(--amber)",fontStyle:"italic"}}>· {r.notes.slice(0,35)}{r.notes.length>35?"...":""}</span>}</div>
                        </div>
                        <span style={{fontSize:12,color:"var(--text-secondary)"}}>{r.trade}</span>
                        <Badge bg={sc.bg} text={sc.text}>{sc.label}</Badge>
                        <span style={{fontSize:12,color:"var(--text-secondary)"}}>{quotesIn}/{quotesTotal}</span>
                        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                          <button onClick={()=>{
                            const savedSet = savedQuoteSets.find(s=>s.reqId===r.id);
                            if(savedSet){
                              setActiveReq(r);
                              setAllAnalyses(savedSet.analyses);
                              setApprovedQuoteId(savedSet.approvedId);
                              setExpandedQuote(savedSet.analyses[0]?._id||null);
                              setQuoteViewMode("cards");
                            } else {
                              setActiveReq(r);
                              setAllAnalyses([]);
                            }
                            setView("quotes");
                          }} style={{fontSize:11,color:"var(--indigo)",background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View</button>
                          <button onClick={()=>handleDuplicate(r)} style={{fontSize:11,color:"var(--green-dark)",background:"none",border:"none",cursor:"pointer"}}>Duplicate</button>
                          {can.sendRFQ(myRole)&&(r.sentTo||[]).length>0&&!r.archived&&(
                            <button onClick={()=>handleRevise(r)} style={{fontSize:11,color:"var(--green-dark)",background:"none",border:"none",cursor:"pointer",fontWeight:600}}>Revise{r.revision?` (v${r.revision})`:""}</button>
                          )}
                          <button onClick={()=>{setEditModal(r);setEditForm({jobRef:r.jobRef,site:r.site,status:r.status,notes:r.notes||""});}} style={{fontSize:11,color:"var(--text-secondary)",background:"none",border:"none",cursor:"pointer"}}>Edit</button>
                          <button onClick={()=>setActivityModal(r)} style={{fontSize:11,color:"var(--text-secondary)",background:"none",border:"none",cursor:"pointer"}}>Log{r.activity?.length?` (${r.activity.length})`:""}</button>
                          {can.deleteItems(myRole) && (r.archived
                            ? <button onClick={()=>handleRestore(r.id)} style={{fontSize:11,color:"var(--green-dark)",background:"none",border:"none",cursor:"pointer",fontWeight:600}}>Restore</button>
                            : <button onClick={()=>setDeleteConfirm(r)} style={{fontSize:11,color:"var(--red)",background:"none",border:"none",cursor:"pointer"}}>Archive</button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        )}

        {view==="library"&&(
          <div className="stagger-in" style={{maxWidth:1000}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24,flexWrap:"wrap",gap:12}}>
              <div>
                <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",margin:0,color:"var(--text-primary)"}}>Quote library</h1>
                <p style={{fontSize:14,color:"var(--text-secondary)",marginTop:4}}>{quoteLibrary.length} quotes saved · Supplier price history</p>
              </div>
              {quoteLibrary.length>0&&(
                <button onClick={()=>downloadCSV(`quote-library-${new Date().toISOString().split("T")[0]}.csv`, quoteLibrary.map(q=>({
                  Date: q.savedAt?new Date(q.savedAt).toLocaleDateString("en-GB"):"",
                  Supplier: q.supplierName, Job: q.jobRef||"", Site: q.site||"", Trade: q.trade||"",
                  Completeness: (q.completeness||0)+"%", EstimatedTotal: q.totalEstimate||"",
                  Carriage: q.carriageCharge||"", Expiry: q.expiryDate?new Date(q.expiryDate).toLocaleDateString("en-GB"):""
                })))} style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,color:"var(--indigo)",background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"9px 16px",cursor:"pointer",fontWeight:500}}>
                  <Icon name="download" size={13} style={{marginRight:5,verticalAlign:"-2px"}}/>Export CSV
                </button>
              )}
            </div>
            {supplierScoreCards.length>0&&(
              <div style={{marginBottom:24}}>
                <div style={{fontSize:13,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:12}}>Supplier scorecards</div>
                <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"repeat(3,1fr)",gap:12}}>
                  {supplierScoreCards.map(sc=>(
                    <Card key={sc.name}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                        <div>
                          <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)"}}>{sc.name}</div>
                          <div style={{fontSize:11,color:"var(--text-tertiary)"}}>{sc.quotes.length} quotes</div>
                        </div>
                        <div style={{fontSize:26,fontWeight:800,color:sc.avgCompleteness>=80?"var(--green-dark)":sc.avgCompleteness>=60?"var(--amber)":"var(--red)",fontFamily:"monospace"}}>{sc.avgCompleteness}%</div>
                      </div>
                      <div style={{height:4,background:"var(--bg-subtle2)",borderRadius:99,overflow:"hidden"}}>
                        <div style={{height:"100%",width:`${sc.avgCompleteness}%`,background:sc.avgCompleteness>=80?"var(--green-dark)":sc.avgCompleteness>=60?"var(--amber)":"var(--red)",borderRadius:99}}/>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}
            <Card>
              {quoteLibrary.length===0?(
                <div style={{textAlign:"center",padding:"40px 0",color:"var(--text-tertiary)"}}>
                  <div style={{fontSize:15,marginBottom:8}}>No quotes in library yet</div>
                  <div style={{fontSize:13}}>Quotes are saved here when you approve a PO or save a draft</div>
                </div>
              ):(
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead>
                      <tr style={{background:"var(--bg-subtle)"}}>
                        {["Date","Supplier","Job","Trade","Completeness","Est. Total","Carriage","Expiry",""].map(h=>(
                          <th key={h} style={{padding:"9px 12px",textAlign:"left",fontWeight:600,color:"var(--text-tertiary)",textTransform:"uppercase",letterSpacing:"0.05em"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {quoteLibrary.map((q,i)=>(
                        <tr key={q.id||i} style={{borderTop:"1px solid var(--border)"}}>
                          <td style={{padding:"9px 12px",color:"var(--text-tertiary)"}}>{q.savedAt?new Date(q.savedAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"2-digit"}):"—"}</td>
                          <td style={{padding:"9px 12px",fontWeight:500,color:"var(--text-primary)"}}>{q.supplierName}</td>
                          <td style={{padding:"9px 12px",fontFamily:"monospace",color:"var(--indigo)",fontSize:11}}>{q.jobRef}</td>
                          <td style={{padding:"9px 12px"}}><Badge bg="var(--bg-subtle2)" text="var(--text-secondary)">{q.trade}</Badge></td>
                          <td style={{padding:"9px 12px"}}>
                            <div style={{display:"flex",alignItems:"center",gap:6}}>
                              <div style={{width:50,height:4,background:"var(--bg-subtle2)",borderRadius:99,overflow:"hidden"}}>
                                <div style={{height:"100%",width:`${q.completeness}%`,background:q.completeness>=80?"var(--green-dark)":q.completeness>=60?"var(--amber)":"var(--red)",borderRadius:99}}/>
                              </div>
                              <span style={{fontSize:11,fontWeight:600,color:q.completeness>=80?"var(--green-dark)":q.completeness>=60?"var(--amber)":"var(--red)"}}>{q.completeness}%</span>
                            </div>
                          </td>
                          <td style={{padding:"9px 12px",fontFamily:"monospace",color:"var(--green-dark)",fontWeight:600}}>{q.totalEstimate||"—"}</td>
                          <td style={{padding:"9px 12px",fontSize:11,color:q.carriageCharge==="Free"?"var(--green-dark)":"var(--text-secondary)"}}>{q.carriageCharge||"—"}</td>
                          <td style={{padding:"9px 12px"}}>
                            {q.expiryDate&&(
                              <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000)<=0?"var(--red-light)":Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000)<=5?"var(--amber-light)":"var(--green-light)",color:Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000)<=0?"var(--red)":Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000)<=5?"var(--amber)":"var(--green-dark)"}}>
                                {Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000)<=0?"Expired":`${Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000)}d left`}
                              </span>
                            )}
                          </td>
                          <td style={{padding:"9px 12px",textAlign:"right"}}>
                            <button onClick={()=>{
                              if(!can.deleteItems(myRole)){showToast("Only a Manager can remove library quotes.","warn");return;}
                              setQuoteLibrary(prev=>{const n=prev.filter(x=>x.id!==q.id);try{localStorage.setItem("piq_quote_library",JSON.stringify(n))}catch{};return n;});
                              logActivity("Library quote removed",`${q.supplierName} - ${q.jobRef||""} removed from library`,{entity:"quote"});
                              showToast("Quote removed from library");
                            }} title="Remove from library" aria-label="Remove from library" style={{background:"none",border:"none",cursor:"pointer",color:"var(--text-muted)",padding:4,borderRadius:6,display:"inline-flex"}}>
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )}

        {view==="om"&&(()=>{
          const projects = Object.values((orders||[]).filter(o=>o.status!=="cancelled").reduce((acc,o)=>{
            const k=(o.jobRef||"").trim()||"(no job reference)";
            if(!acc[k]) acc[k]={jobRef:k, site:o.site||"", pos:0, items:0};
            acc[k].pos++; acc[k].items+=(o.items||[]).length;
            if(!acc[k].site && o.site) acc[k].site=o.site;
            return acc;
          },{})).sort((a,b)=>b.items-a.items);
          return (
          <div style={{maxWidth:860,margin:"0 auto",padding:isMobile?"4px 0 40px":"8px 0 60px"}}>
            <div style={{marginBottom:6}}>
              <h1 style={{fontSize:isMobile?22:26,fontWeight:800,color:"var(--text-primary)",letterSpacing:"-0.02em",margin:0}}>O&amp;M files</h1>
              <p style={{fontSize:14,color:"var(--text-muted)",margin:"6px 0 0",maxWidth:620,lineHeight:1.5}}>
                Turn a project&rsquo;s procured materials into a presented Operations &amp; Maintenance pack &mdash; equipment schedule, manufacturer literature, and planned maintenance schedules &mdash; in one PDF.
              </p>
            </div>

            {/* Options */}
            <div style={{display:"flex",flexDirection:isMobile?"column":"row",gap:10,margin:"18px 0 22px"}}>
              <label style={{flex:1,display:"flex",gap:10,alignItems:"flex-start",padding:"13px 15px",background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",cursor:"pointer"}}>
                <input type="checkbox" checked={omWeb} disabled={omBusy} onChange={e=>setOmWeb(e.target.checked)} style={{marginTop:2,accentColor:"var(--green)",width:16,height:16}}/>
                <span>
                  <span style={{display:"block",fontSize:13.5,fontWeight:600,color:"var(--text-primary)"}}>Find datasheet links online</span>
                  <span style={{display:"block",fontSize:12,color:"var(--text-muted)",marginTop:2,lineHeight:1.45}}>Searches each manufacturer for the exact datasheet. Uses web search &mdash; a small per-use cost. Off = manufacturer &amp; model listed with a search link.</span>
                </span>
              </label>
              <label style={{flex:1,display:"flex",gap:10,alignItems:"flex-start",padding:"13px 15px",background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",cursor:"pointer"}}>
                <input type="checkbox" checked={omSplit} disabled={omBusy} onChange={e=>setOmSplit(e.target.checked)} style={{marginTop:2,accentColor:"var(--green)",width:16,height:16}}/>
                <span>
                  <span style={{display:"block",fontSize:13.5,fontWeight:600,color:"var(--text-primary)"}}>Also export sections separately</span>
                  <span style={{display:"block",fontSize:12,color:"var(--text-muted)",marginTop:2,lineHeight:1.45}}>In addition to the combined pack, download Literature and Maintenance as their own PDFs.</span>
                </span>
              </label>
            </div>

            {projects.length===0 ? (
              <div style={{textAlign:"center",padding:"60px 20px",background:"var(--bg-card)",border:"1px dashed var(--border)",borderRadius:"var(--radius-lg)"}}>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)"}}>No projects to build from yet</div>
                <div style={{fontSize:13,color:"var(--text-muted)",marginTop:6,maxWidth:420,marginLeft:"auto",marginRight:"auto",lineHeight:1.5}}>O&amp;M packs are built from materials you&rsquo;ve ordered. Once a project has orders against a job reference, it&rsquo;ll appear here.</div>
              </div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {projects.map(p=>{
                  const active = omBusy && omJob===p.jobRef;
                  return (
                  <div key={p.jobRef} style={{display:"flex",flexDirection:isMobile?"column":"row",alignItems:isMobile?"stretch":"center",gap:14,padding:"15px 17px",background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",boxShadow:"var(--shadow-sm)"}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:15,fontWeight:700,color:"var(--text-primary)",letterSpacing:"-0.01em",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.jobRef}</div>
                      <div style={{fontSize:12.5,color:"var(--text-muted)",marginTop:3}}>
                        {p.site?`${p.site} · `:""}{p.items} item{p.items===1?"":"s"} across {p.pos} order{p.pos===1?"":"s"}
                      </div>
                      {active && <div style={{fontSize:12,color:"var(--green)",marginTop:7,fontWeight:600}}>{omStage||"Working\u2026"}</div>}
                    </div>
                    <button onClick={()=>runOM(p)} disabled={omBusy} style={{flexShrink:0,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:8,padding:"10px 18px",background:active?"var(--bg-subtle2)":"var(--green)",color:active?"var(--text-muted)":"white",border:"none",borderRadius:"var(--radius-sm)",fontSize:13.5,fontWeight:600,cursor:omBusy?"default":"pointer",opacity:omBusy&&!active?0.5:1,minWidth:isMobile?"100%":150}}>
                      {active ? "Generating\u2026" : "Generate O&M"}
                    </button>
                  </div>);
                })}
              </div>
            )}

            <p style={{fontSize:11.5,color:"var(--text-muted)",marginTop:18,lineHeight:1.5}}>
              Equipment details and maintenance schedules are AI-drafted from the procured materials and marked for your sign-off. Always review before issuing to a client.
            </p>
          </div>);
        })()}
        {view==="reports"&&(()=>{
          const R = repBuild(orders);
          const COLORS=["#15824F","#2E9E68","#46B97F","#5FA8D3","#E0A458","#C45D5D","#8A7CC2","#6B8E23"];
          const barRow=(x,max,i)=>(
            <div key={x.label} style={{display:"flex",alignItems:"center",gap:12,padding:"7px 0"}}>
              <div style={{width:isMobile?100:150,flexShrink:0,fontSize:12.5,color:"var(--text-primary)",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={x.label}>{x.label}</div>
              <div style={{flex:1,background:"var(--bg-subtle2)",borderRadius:5,height:18,overflow:"hidden",position:"relative"}}>
                <div style={{width:`${Math.max(2,(x.value/max)*100)}%`,height:"100%",background:COLORS[i%COLORS.length],borderRadius:5,transition:"width .5s cubic-bezier(0.16,1,0.3,1)"}}/>
              </div>
              <div style={{width:isMobile?72:96,flexShrink:0,textAlign:"right",fontSize:12.5,fontFamily:"'JetBrains Mono',monospace",color:"var(--text-primary)",fontWeight:600}}>{gbp(x.value)}</div>
            </div>);
          const section=(title,arr)=>{ const max=Math.max(1,...arr.map(a=>a.value)); return (
            <div style={{background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:isMobile?"16px":"18px 20px",marginBottom:14}}>
              <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:10,letterSpacing:"-0.01em"}}>{title}</div>
              {arr.length?arr.slice(0,12).map((x,i)=>barRow(x,max,i)):<div style={{fontSize:13,color:"var(--text-muted)"}}>No data yet.</div>}
            </div>); };
          const exportCsv=()=>{
            const rows=[["Breakdown","Label","Spend (GBP)","Orders"]];
            R.byTrade.forEach(x=>rows.push(["Trade",x.label,Math.round(x.value),x.count]));
            R.bySupplier.forEach(x=>rows.push(["Supplier",x.label,Math.round(x.value),x.count]));
            R.byJob.forEach(x=>rows.push(["Project",x.label,Math.round(x.value),x.count]));
            R.byMonth.forEach(x=>rows.push(["Month",x.label,Math.round(x.value),x.count]));
            const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
            const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"}); const url=URL.createObjectURL(blob);
            const a=document.createElement("a"); a.href=url; a.download="ProQure-spend-report.csv"; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
          };
          const kpis=[["Total spend",gbp(R.total)],["Orders",String(R.count)],["Projects",String(R.projects)],["Suppliers",String(R.suppliers)]];
          return (
          <div style={{maxWidth:920,margin:"0 auto",padding:isMobile?"4px 0 40px":"8px 0 60px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,flexWrap:"wrap",marginBottom:14}}>
              <div>
                <h1 style={{fontSize:isMobile?22:26,fontWeight:800,color:"var(--text-primary)",letterSpacing:"-0.02em",margin:0}}>Reports</h1>
                <p style={{fontSize:14,color:"var(--text-muted)",margin:"6px 0 0"}}>Where the money&rsquo;s going &mdash; spend by trade, supplier, project and month.</p>
              </div>
              <button onClick={exportCsv} style={{flexShrink:0,padding:"9px 15px",background:"var(--bg-card)",color:"var(--text-primary)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,fontWeight:600,cursor:"pointer"}}>Export CSV</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:10,marginBottom:18}}>
              {kpis.map(([k,v])=>(
                <div key={k} style={{background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"14px 16px"}}>
                  <div style={{fontSize:10.5,color:"var(--text-muted)",textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:600}}>{k}</div>
                  <div style={{fontSize:isMobile?20:24,fontWeight:800,color:"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace",marginTop:4,letterSpacing:"-1px"}}>{v}</div>
                </div>))}
            </div>
            <div style={{display:"inline-flex",background:"var(--bg-subtle2)",borderRadius:"var(--radius-sm)",padding:3,marginBottom:16}}>
              {[["overview","Overview"],["projects","By project"]].map(([id,lbl])=>(
                <button key={id} onClick={()=>setRepMode(id)} style={{padding:"7px 16px",border:"none",borderRadius:6,background:repMode===id?"var(--bg-card)":"transparent",color:repMode===id?"var(--text-primary)":"var(--text-muted)",fontWeight:600,fontSize:13,cursor:"pointer",boxShadow:repMode===id?"var(--shadow-sm)":"none"}}>{lbl}</button>))}
            </div>
            {repMode==="overview" ? (
              <div>
                {section("Spend by trade",R.byTrade)}
                {section("Spend by supplier",R.bySupplier)}
                {section("Spend by month",R.byMonth)}
              </div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {R.byJob.length===0 && <div style={{fontSize:13,color:"var(--text-muted)",padding:"40px",textAlign:"center",background:"var(--bg-card)",border:"1px dashed var(--border)",borderRadius:"var(--radius-lg)"}}>No projects with orders yet.</div>}
                {R.byJob.map(j=>{
                  const open=repOpen===j.label; const P=open?repProject(orders,j.label):null;
                  const tmax=P?Math.max(1,...P.byTrade.map(t=>t.value)):1;
                  return (
                  <div key={j.label} style={{background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",overflow:"hidden"}}>
                    <button onClick={()=>setRepOpen(open?null:j.label)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:"14px 17px",background:"transparent",border:"none",cursor:"pointer",textAlign:"left"}}>
                      <div style={{minWidth:0}}>
                        <div style={{fontSize:14.5,fontWeight:700,color:"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{j.label}</div>
                        <div style={{fontSize:12,color:"var(--text-muted)",marginTop:2}}>{j.count} order{j.count===1?"":"s"}</div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
                        <span style={{fontSize:15,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--green)"}}>{gbp(j.value)}</span>
                        <span style={{fontSize:12,color:"var(--text-muted)",transform:open?"rotate(180deg)":"none",transition:"transform .2s"}}>&#9660;</span>
                      </div>
                    </button>
                    {open&&P&&(
                      <div style={{padding:"4px 17px 16px",borderTop:"1px solid var(--border)"}}>
                        {P.site&&<div style={{fontSize:12,color:"var(--text-muted)",margin:"10px 0 8px"}}>{P.site}</div>}
                        <div style={{fontSize:11.5,fontWeight:700,color:"var(--text-muted)",textTransform:"uppercase",letterSpacing:"0.06em",margin:"6px 0 4px"}}>Cost across trades</div>
                        {P.byTrade.map((t,i)=>barRow(t,tmax,i))}
                        <div style={{fontSize:11.5,fontWeight:700,color:"var(--text-muted)",textTransform:"uppercase",letterSpacing:"0.06em",margin:"12px 0 4px"}}>By supplier</div>
                        {P.bySupplier.map((t,i)=>barRow(t,Math.max(1,...P.bySupplier.map(x=>x.value)),i))}
                      </div>)}
                  </div>);
                })}
              </div>
            )}
          </div>);
        })()}
        {view==="measure"&&(()=>{
          const materials=["Emulsion paint","Gloss / satinwood paint","Plaster (skim coat)","Bonding plaster","Plasterboard","Bricks","Concrete blocks","Tile adhesive","Floor screed","Self-levelling compound","Insulation board","Sand & cement render"];
          const coatsApplies=/paint|render/i.test(mMaterial)||(/plaster|coat/i.test(mMaterial)&&!/board/i.test(mMaterial));
          const tabBtn=(id,label)=>(
            <button onClick={()=>setMMode(id)} style={{flex:1,padding:"10px",fontSize:13,fontWeight:600,cursor:"pointer",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",background:mMode===id?"var(--green)":"var(--bg-card)",color:mMode===id?"white":"var(--text-primary)"}}>{label}</button>
          );
          const updTake=(i,field,v)=>setMTakeoff(p=>p.map((it,ii)=>ii===i?{...it,[field]:v}:it));
          return (
          <div style={{maxWidth:760,margin:"0 auto",padding:isMobile?"4px 0 40px":"8px 0 60px"}}>
            <h1 style={{fontSize:isMobile?22:26,fontWeight:800,color:"var(--text-primary)",letterSpacing:"-0.02em",margin:0}}>Measure</h1>
            <p style={{fontSize:14,color:"var(--text-muted)",margin:"6px 0 18px",maxWidth:580,lineHeight:1.5}}>Work out what to order &mdash; from measurements, or from a drawing.</p>
            <div style={{display:"flex",gap:8,marginBottom:18}}>{tabBtn("dims","By dimensions")}{tabBtn("drawing","From a drawing")}</div>

            {mMode==="dims"&&(<>
              <div style={{background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:isMobile?"16px":"20px 22px"}}>
                <label style={{display:"block",fontSize:12.5,fontWeight:600,color:"var(--text-primary)",marginBottom:6}}>Material</label>
                <select value={mMaterial} onChange={e=>setMMaterial(e.target.value)} style={{width:"100%",padding:"10px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-card)",color:"var(--text-primary)",fontSize:14,marginBottom:14}}>
                  {materials.map(m=><option key={m} value={m}>{m}</option>)}
                </select>
                <label style={{display:"block",fontSize:12.5,fontWeight:600,color:"var(--text-primary)",marginBottom:6}}>Specific product / brand <span style={{color:"var(--text-muted)",fontWeight:400}}>(optional)</span></label>
                <input type="text" placeholder="e.g. Dulux Trade Vinyl Matt" value={mProduct} onChange={e=>setMProduct(e.target.value)} style={{width:"100%",padding:"10px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-card)",color:"var(--text-primary)",fontSize:14,marginBottom:10}}/>
                <label style={{display:"flex",alignItems:"flex-start",gap:9,fontSize:12.5,color:"var(--text-primary)",marginBottom:16,cursor:"pointer"}}>
                  <input type="checkbox" checked={mUseDatasheet} onChange={e=>setMUseDatasheet(e.target.checked)} style={{marginTop:2}}/>
                  <span>Look up the manufacturer&rsquo;s datasheet for the exact coverage rate <span style={{color:"var(--text-muted)"}}>(uses web search; needs a product/brand above)</span></span>
                </label>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:6,flexWrap:"wrap"}}>
                  <span style={{fontSize:12.5,fontWeight:600,color:"var(--text-primary)"}}>{mMeasureType==="volume"?"Area to cover":"Area"}</span>
                  <div style={{display:"inline-flex",background:"var(--bg-subtle2)",borderRadius:"var(--radius-sm)",padding:3}}>
                    {[["area","Area (m\u00B2)"],["volume","Volume (m\u00B3)"]].map(([id,lab])=>(
                      <button key={id} type="button" onClick={()=>setMMeasureType(id)} style={{padding:"6px 12px",border:"none",borderRadius:6,background:mMeasureType===id?"var(--bg-card)":"transparent",color:mMeasureType===id?"var(--text-primary)":"var(--text-muted)",fontWeight:600,fontSize:12,cursor:"pointer",boxShadow:mMeasureType===id?"var(--shadow-sm)":"none"}}>{lab}</button>
                    ))}
                  </div>
                </div>
                <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:6}}>
                  <input type="number" inputMode="decimal" placeholder="Area (m²)" value={mArea} onChange={e=>setMArea(e.target.value)} style={{flex:"1 1 120px",padding:"10px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-card)",color:"var(--text-primary)",fontSize:14}}/>
                  <span style={{fontSize:12,color:"var(--text-muted)"}}>or</span>
                  <input type="number" inputMode="decimal" placeholder="Length (m)" value={mLength} onChange={e=>setMLength(e.target.value)} style={{flex:"1 1 90px",padding:"10px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-card)",color:"var(--text-primary)",fontSize:14}}/>
                  <span style={{fontSize:13,color:"var(--text-muted)"}}>×</span>
                  <input type="number" inputMode="decimal" placeholder="Height (m)" value={mHeight} onChange={e=>setMHeight(e.target.value)} style={{flex:"1 1 90px",padding:"10px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-card)",color:"var(--text-primary)",fontSize:14}}/>
                </div>
                {mMeasureType==="volume"&&(
                  <div style={{marginTop:10}}>
                    <label style={{display:"block",fontSize:12.5,fontWeight:600,color:"var(--text-primary)",marginBottom:6}}>Depth / thickness (mm)</label>
                    <input type="number" inputMode="decimal" placeholder="e.g. 50" value={mDepth} onChange={e=>setMDepth(e.target.value)} style={{width:"100%",padding:"10px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-card)",color:"var(--text-primary)",fontSize:14}}/>
                    <div style={{fontSize:11.5,color:"var(--text-muted)",marginTop:5}}>Volume = area &times; depth &mdash; good for screed, levelling compound, concrete.</div>
                  </div>
                )}
                <div style={{display:"flex",gap:14,flexWrap:"wrap",margin:"14px 0 4px"}}>
                  {coatsApplies&&mMeasureType==="area"&&(
                  <div style={{flex:"1 1 120px"}}>
                    <label style={{display:"block",fontSize:12.5,fontWeight:600,color:"var(--text-primary)",marginBottom:6}}>Coats</label>
                    <input type="number" inputMode="numeric" value={mCoats} onChange={e=>setMCoats(e.target.value)} style={{width:"100%",padding:"10px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-card)",color:"var(--text-primary)",fontSize:14}}/>
                  </div>
                  )}
                  <div style={{flex:"1 1 120px"}}>
                    <label style={{display:"block",fontSize:12.5,fontWeight:600,color:"var(--text-primary)",marginBottom:6}}>Wastage %</label>
                    <input type="number" inputMode="numeric" value={mWastage} onChange={e=>setMWastage(e.target.value)} style={{width:"100%",padding:"10px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-card)",color:"var(--text-primary)",fontSize:14}}/>
                  </div>
                </div>
                <button onClick={runMeasure} disabled={mBusy} style={{marginTop:18,width:"100%",padding:"12px",background:"var(--green)",color:"white",border:"none",borderRadius:"var(--radius-sm)",fontSize:14,fontWeight:600,cursor:mBusy?"default":"pointer",opacity:mBusy?0.6:1}}>{mBusy?(mUseDatasheet?"Checking datasheet…":"Calculating…"):"Calculate quantity"}</button>
              </div>
              {mResult&&(mResult.error?(
                <div style={{marginTop:14,padding:"14px 16px",background:"var(--amber-light)",border:"1px solid var(--amber)",borderRadius:"var(--radius-md)",fontSize:13,color:"var(--text-primary)"}}>{mResult.error}</div>
              ):(
                <div style={{marginTop:14,background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:isMobile?"16px":"20px 22px"}}>
                  <div style={{fontSize:11,color:"var(--text-muted)",textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:600}}>You&rsquo;ll need (for ~{mResult.basis} {mResult.basisUnit})</div>
                  <div style={{fontSize:isMobile?26:32,fontWeight:800,color:"var(--green)",fontFamily:"'JetBrains Mono',monospace",margin:"6px 0",letterSpacing:"-1px"}}>{mResult.quantity} {mResult.unit}</div>
                  {mResult.packsNeeded!=null&&<div style={{fontSize:14,color:"var(--text-primary)",fontWeight:600}}>{mResult.packsNeeded} × {mResult.packSize||"pack"}</div>}
                  {mResult.coverageBasis&&<div style={{fontSize:12.5,color:"var(--text-muted)",marginTop:8}}>Based on: {mResult.coverageBasis}</div>}
                  {mResult.datasheet&&<div style={{fontSize:12,color:"var(--green-dark)",marginTop:6}}>Datasheet: {mResult.datasheet}{mResult.source&&<> &middot; <a href={mResult.source} target="_blank" rel="noreferrer" style={{color:"var(--green-dark)"}}>source</a></>}</div>}
                  {Array.isArray(mResult.assumptions)&&mResult.assumptions.length>0&&(
                    <ul style={{margin:"10px 0 0",paddingLeft:18,fontSize:12.5,color:"var(--text-muted)",lineHeight:1.6}}>{mResult.assumptions.map((a,i)=><li key={i}>{a}</li>)}</ul>)}
                  <div style={{marginTop:12,fontSize:11.5,color:"var(--text-muted)",fontStyle:"italic"}}>Estimate only — always sense-check before ordering.</div>
                </div>))}
            </>)}

            {mMode==="drawing"&&(<>
              <div style={{background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:isMobile?"16px":"20px 22px"}}>
                <p style={{fontSize:13,color:"var(--text-muted)",margin:"0 0 14px",lineHeight:1.5}}>Upload a scaled drawing or specification (PDF or image) and ProQure does a materials take-off of the items shown. A true DWG/CAD file can&rsquo;t be read &mdash; export it to PDF first.</p>
                <label
                  onDragOver={e=>{if(!mDrawBusy){e.preventDefault();setMDragOver(true);}}}
                  onDragLeave={e=>{e.preventDefault();setMDragOver(false);}}
                  onDrop={e=>{e.preventDefault();setMDragOver(false);if(mDrawBusy)return;const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];if(f){const ok=/^image\//.test(f.type)||/\.pdf$/i.test(f.name||"")||f.type==="application/pdf";if(ok)runTakeoff(f);else setMDrawError("Please drop an image or PDF — a DWG/CAD file must be exported to PDF first.");}}}
                  style={{display:"flex",alignItems:"center",gap:12,padding:"16px",background:mDrawBusy?"var(--indigo-light)":(mDragOver?"var(--indigo-light)":"var(--bg-subtle)"),border:mDrawBusy?"2px solid var(--indigo)":(mDragOver?"2px solid var(--indigo)":"1px dashed var(--border)"),borderRadius:"var(--radius-md)",cursor:mDrawBusy?"not-allowed":"pointer",transition:"all 0.15s"}}>
                  <input type="file" accept="image/*,.pdf" style={{display:"none"}} disabled={mDrawBusy} onChange={e=>{if(e.target.files[0])runTakeoff(e.target.files[0]);e.target.value="";}}/>
                  <div style={{width:42,height:42,borderRadius:12,background:mDrawBusy?"var(--indigo)":"linear-gradient(135deg,#5B5BD6,#4A4AB8)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:"white"}}>
                    {mDrawBusy?<Spinner/>:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>}
                  </div>
                  <div>
                    <div style={{fontSize:13.5,fontWeight:600,color:mDrawBusy?"var(--indigo)":"var(--text-primary)"}}>{mDrawBusy?"Reading the drawing…":(mDrawName?`Re-upload (last: ${mDrawName})`:"Upload a drawing (PDF or image)")}</div>
                    <div style={{fontSize:12,color:"var(--text-muted)",marginTop:2}}>The AI lists what it can see &mdash; you review and edit before ordering.</div>
                  </div>
                </label>
                {mDrawError&&<div style={{marginTop:12,padding:"12px 14px",background:"var(--amber-light)",border:"1px solid var(--amber)",borderRadius:"var(--radius-md)",fontSize:13,color:"var(--text-primary)"}}>{mDrawError}</div>}
              </div>

              {mTakeoff&&mTakeoff.length>0&&(
                <div style={{marginTop:14,background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:isMobile?"14px":"18px 20px"}}>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:10}}>Materials take-off <span style={{color:"var(--text-muted)",fontWeight:400}}>({mTakeoff.length} items &mdash; AI draft, edit as needed)</span></div>
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    {mTakeoff.map((it,i)=>(
                      <div key={it.id||i} style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                        <input type="number" inputMode="decimal" value={it.quantity} onChange={e=>updTake(i,"quantity",Number(e.target.value)||0)} style={{width:64,padding:"8px 10px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-card)",color:"var(--text-primary)",fontSize:13}}/>
                        <input type="text" value={it.unit} onChange={e=>updTake(i,"unit",e.target.value)} style={{width:64,padding:"8px 10px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-card)",color:"var(--text-primary)",fontSize:13}}/>
                        <input type="text" value={it.description} onChange={e=>updTake(i,"description",e.target.value)} style={{flex:"1 1 160px",padding:"8px 10px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-card)",color:"var(--text-primary)",fontSize:13}}/>
                        <button onClick={()=>setMTakeoff(p=>p.filter((_,ii)=>ii!==i))} style={{background:"none",border:"none",color:"var(--text-muted)",cursor:"pointer",fontSize:18,lineHeight:1,padding:"0 4px"}} title="Remove">×</button>
                      </div>
                    ))}
                  </div>
                  <button onClick={()=>setMTakeoff(p=>[...p,{id:Date.now(),description:"",quantity:1,unit:"no",category:"General",notes:""}])} style={{marginTop:10,background:"none",border:"1px dashed var(--border)",borderRadius:"var(--radius-sm)",padding:"8px 14px",fontSize:12.5,color:"var(--text-secondary)",cursor:"pointer"}}>+ Add item</button>
                  <button onClick={takeoffToRequest} style={{marginTop:14,width:"100%",padding:"12px",background:"var(--green)",color:"white",border:"none",borderRadius:"var(--radius-sm)",fontSize:14,fontWeight:600,cursor:"pointer"}}>Create a request from this take-off</button>
                  <div style={{marginTop:10,fontSize:11.5,color:"var(--text-muted)",fontStyle:"italic"}}>AI-read from the drawing — always check against the drawing before sending to suppliers.</div>
                </div>
              )}
            </>)}

            <p style={{fontSize:11.5,color:"var(--text-muted)",marginTop:16,lineHeight:1.5}}>Coming with the native app: walk a room with the camera and have ProQure capture the area automatically.</p>
          </div>);
        })()}
        {view==="catalogues"&&(()=>{
          const allCatItems = catalogues.flatMap(c => (c.items||[]).map(it => ({ ...it, _cat:c.id, _supplier:c.supplier||c.name, _k:c.id+"-"+it.id })));
          const q = catSearch.trim().toLowerCase();
          const filtered = q ? allCatItems.filter(it => (it.description+" "+it.partNumber+" "+it.manufacturer+" "+it._supplier).toLowerCase().includes(q)).slice(0,80) : [];
          const isSel = (it) => catSel.some(x => x._k === it._k);
          const onlineLeft = featureLeft("catalogueWeb");
          const itemRow = (it, online) => (
            <div key={it._k||it.id} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 0",borderBottom:"1px solid var(--border)"}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13.5,fontWeight:600,color:"var(--text-primary)"}}>{it.description}</div>
                <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2,display:"flex",gap:10,flexWrap:"wrap"}}>
                  {it.partNumber && <span style={{fontFamily:"ui-monospace,monospace",background:"var(--green-light)",color:"var(--green-deep)",padding:"1px 6px",borderRadius:5}}>{it.partNumber}</span>}
                  {(it.manufacturer||it._supplier) && <span>{it.manufacturer||it._supplier}</span>}
                  {it.pack && <span>{it.pack}</span>}
                  {it.datasheetUrl && <a href={it.datasheetUrl} target="_blank" rel="noopener noreferrer" style={{color:"var(--green)",fontWeight:600,textDecoration:"none"}}>Datasheet &rsaquo;</a>}
                </div>
              </div>
              <button onClick={()=>toggleCatSel(online?{...it,_k:it._k||("online-"+it.id),_supplier:it.manufacturer||"Found online"}:it)} style={{flexShrink:0,padding:"7px 13px",fontSize:12.5,fontWeight:600,borderRadius:"var(--radius-sm)",cursor:"pointer",border:"1px solid var(--green)",background:isSel(online?{_k:it._k||("online-"+it.id)}:it)?"var(--green)":"transparent",color:isSel(online?{_k:it._k||("online-"+it.id)}:it)?"#fff":"var(--green-dark)"}}>{isSel(online?{_k:it._k||("online-"+it.id)}:it)?"\u2713 Added":"Add to list"}</button>
            </div>
          );
          return (
          <div className="stagger-in" style={{maxWidth:980,paddingBottom:catSel.length?70:0}}>
            <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",marginBottom:4,color:"var(--text-primary)"}}>Supplier Catalogues</h1>
            <p style={{fontSize:14,color:"var(--text-secondary)",marginBottom:24}}>Upload a supplier's catalogue and ProQure indexes the products, so you can search them, grab datasheets, and drop items straight onto a request.</p>

            <div style={{display:"grid",gap:16}}>
              <Card>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:14}}>Add a catalogue</div>
                <label onDragOver={e=>{e.preventDefault();}} onDrop={e=>{e.preventDefault(); if(e.dataTransfer.files&&e.dataTransfer.files[0]) runCatalogueUpload(e.dataTransfer.files[0]);}} style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:8,padding:"30px 20px",border:"2px dashed var(--border)",borderRadius:"var(--radius-md)",background:"var(--bg-subtle)",cursor:catBusy?"default":"pointer",textAlign:"center"}}>
                  <input type="file" accept="application/pdf,image/*,.csv,text/csv" disabled={catBusy} onChange={e=>{ const f=e.target.files&&e.target.files[0]; if(f) runCatalogueUpload(f); e.target.value=""; }} style={{display:"none"}}/>
                  <div style={{fontSize:14,fontWeight:600,color:catBusy?"var(--text-secondary)":"var(--green-dark)"}}>{catBusy?`Reading ${catName}\u2026`:"Drag a catalogue here, or tap to choose"}</div>
                  <div style={{fontSize:12,color:"var(--text-secondary)"}}>PDF, image or CSV</div>
                </label>
                {catErr && <div style={{marginTop:10,fontSize:12.5,color:"#B42318",background:"#FEF3F2",border:"1px solid #FDA29B",borderRadius:8,padding:"9px 12px"}}>{catErr}</div>}
                <div style={{fontSize:11.5,color:"var(--text-muted)",marginTop:12,lineHeight:1.5}}>ProQure indexes the products and keeps datasheet links \u2014 it doesn't store a copy of your file. Your catalogues are private to your company. Large PDFs are read from their first pages.</div>
              </Card>

              <Card>
                <input value={catSearch} onChange={e=>setCatSearch(e.target.value)} placeholder="Search by product, part number or supplier\u2026" style={{width:"100%",padding:"11px 14px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:14,outline:"none",background:"var(--bg-subtle)",color:"var(--text-primary)"}}/>
                {q && (
                  <div style={{marginTop:14}}>
                    {filtered.length>0
                      ? <>{filtered.map(it=>itemRow(it,false))}<div style={{fontSize:11.5,color:"var(--text-muted)",marginTop:10}}>{filtered.length} match{filtered.length!==1?"es":""} in your catalogues{filtered.length===80?" (showing first 80)":""}.</div></>
                      : <div style={{fontSize:13,color:"var(--text-secondary)",padding:"10px 0"}}>Nothing in your catalogues matches \u201C{catSearch}\u201D.</div>}
                    <div style={{marginTop:14,paddingTop:14,borderTop:"1px solid var(--border)",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                      <button onClick={runCatalogueOnline} disabled={catOnlineBusy||onlineLeft<=0} style={{padding:"9px 16px",fontSize:13,fontWeight:600,borderRadius:"var(--radius-sm)",border:"1px solid var(--green)",background:"transparent",color:"var(--green-dark)",cursor:(catOnlineBusy||onlineLeft<=0)?"default":"pointer",opacity:(catOnlineBusy||onlineLeft<=0)?0.55:1}}>{catOnlineBusy?"Searching online\u2026":"Find online"}</button>
                      <span style={{fontSize:11.5,color:"var(--text-muted)"}}>{onlineLeft>0?`${onlineLeft} online lookup${onlineLeft!==1?"s":""} left this month`:"No online lookups left this month \u2014 add a pack or upgrade"}</span>
                    </div>
                    {catOnlineResults && catOnlineResults.length>0 && (
                      <div style={{marginTop:12,padding:"4px 14px 8px",background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)"}}>
                        <div style={{fontSize:11,fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",color:"var(--green-dark)",margin:"10px 0 2px"}}>Found online</div>
                        {catOnlineResults.map(r=>itemRow({...r,_k:"online-"+r.id},true))}
                      </div>
                    )}
                  </div>
                )}
                {!q && <div style={{marginTop:12,fontSize:12.5,color:"var(--text-secondary)"}}>{allCatItems.length>0?`${allCatItems.length} products indexed across ${catalogues.length} catalogue${catalogues.length!==1?"s":""}. Start typing to search.`:"Upload a catalogue above to start building your searchable library."}</div>}
              </Card>

              {catalogues.length>0 && (
                <Card>
                  <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:12}}>Your catalogues ({catalogues.length})</div>
                  {catalogues.map(c=>(
                    <div key={c.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:"1px solid var(--border)"}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13.5,fontWeight:600,color:"var(--text-primary)"}}>{c.supplier||c.name}</div>
                        <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>{(c.items||[]).length} products \u00B7 {new Date(c.uploadedAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}</div>
                      </div>
                      <button onClick={()=>deleteCatalogue(c.id)} style={{flexShrink:0,padding:"6px 12px",fontSize:12,fontWeight:600,borderRadius:"var(--radius-sm)",border:"1px solid var(--border)",background:"transparent",color:"var(--text-secondary)",cursor:"pointer"}}>Remove</button>
                    </div>
                  ))}
                </Card>
              )}
            </div>

            {catSel.length>0 && (
              <div style={{position:"fixed",left:0,right:0,bottom:0,background:"var(--bg-card-solid)",borderTop:"1px solid var(--border)",boxShadow:"0 -4px 20px rgba(0,0,0,0.08)",padding:"12px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,zIndex:40}}>
                <span style={{fontSize:13.5,fontWeight:600,color:"var(--text-primary)"}}>{catSel.length} item{catSel.length!==1?"s":""} selected</span>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>setCatSel([])} style={{padding:"9px 14px",fontSize:13,fontWeight:600,borderRadius:"var(--radius-sm)",border:"1px solid var(--border)",background:"transparent",color:"var(--text-secondary)",cursor:"pointer"}}>Clear</button>
                  <button onClick={addCatSelToRequest} style={{padding:"9px 18px",fontSize:13,fontWeight:700,borderRadius:"var(--radius-sm)",border:"none",background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"#fff",cursor:"pointer"}}>Add to a request</button>
                </div>
              </div>
            )}
          </div>);
        })()}
        {view==="help"&&(
          <div className="stagger-in" style={{maxWidth:900}}>
            <div style={{background:"linear-gradient(135deg,#0A0F1E,#1a2744)",borderRadius:20,padding:"36px 40px",marginBottom:28,position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:-40,right:-40,width:200,height:200,background:"radial-gradient(circle,rgba(34,197,94,0.12),transparent 70%)",borderRadius:"50%"}}/>
              <div style={{position:"relative",zIndex:1}}>
                <div style={{fontSize:11,color:"#5BE3A0",letterSpacing:"0.18em",textTransform:"uppercase",fontWeight:600,marginBottom:8}}>ProQure Help Centre</div>
                <h1 style={{fontSize:30,fontWeight:800,color:"white",margin:0,letterSpacing:"-0.03em",marginBottom:8}}>How can we help?</h1>
                <p style={{fontSize:14,color:"rgba(148,163,184,0.9)",margin:0}}>Ask the AI assistant or browse the FAQ below</p>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:20,marginBottom:28}}>
              <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",boxShadow:"var(--shadow-sm)",overflow:"hidden",display:"flex",flexDirection:"column"}}>
                {/* Chat header */}
                <div style={{display:"flex",alignItems:"center",gap:12,padding:"16px 18px",borderBottom:"1px solid var(--border)",background:"linear-gradient(135deg,#1E9E63,#15824F)"}}>
                  <div style={{position:"relative",flexShrink:0}}>
                    <div style={{width:40,height:40,borderRadius:"50%",background:"rgba(255,255,255,0.18)",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(4px)",WebkitBackdropFilter:"blur(4px)"}}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/><circle cx="8.5" cy="14.5" r="1.5" fill="white"/><circle cx="15.5" cy="14.5" r="1.5" fill="white"/></svg>
                    </div>
                    {(AI_VIA_SERVER||settings.openRouterKey)&&<div style={{position:"absolute",bottom:0,right:0,width:11,height:11,borderRadius:"50%",background:"#4ADE80",border:"2px solid #15824F"}}/>}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:15,fontWeight:700,color:"white"}}>ProQure Assistant</div>
                    <div style={{fontSize:12,color:"rgba(255,255,255,0.85)",display:"flex",alignItems:"center",gap:5}}>
                      {settings.openRouterKey?<><span style={{width:6,height:6,borderRadius:"50%",background:"#4ADE80",display:"inline-block"}}/>Online · ready to help</>:<>Online · ready to help</>}
                    </div>
                  </div>
                </div>

                {/* Messages */}
                <div style={{flex:1,minHeight:300,maxHeight:380,overflowY:"auto",display:"flex",flexDirection:"column",gap:12,padding:"18px"}}>
                  {helpMessages.length===0&&(
                    <div style={{display:"flex",flexDirection:"column",gap:14,paddingTop:8}}>
                      <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                        <div style={{width:30,height:30,borderRadius:"50%",background:"linear-gradient(135deg,#1E9E63,#15824F)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name="wave" size={16} color="white"/></div>
                        <div style={{background:"var(--bg-subtle)",borderRadius:"4px 14px 14px 14px",padding:"12px 16px",fontSize:13,lineHeight:1.6,color:"var(--text-primary)",maxWidth:"85%"}}>
                          Hi! I'm your ProQure assistant. Ask me anything about creating requests, analysing quotes, managing orders, or any feature in the app.
                        </div>
                      </div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:8,paddingLeft:40}}>
                        {["How do I send an RFQ?","How does quote analysis work?","Where are my saved quotes?","How do I import a spreadsheet?"].map(q=>(
                          <button key={q} onClick={()=>handleHelpChat(q)} style={{fontSize:12,padding:"7px 13px",borderRadius:99,border:"1px solid var(--green-light)",background:"var(--green-mint)",color:"var(--green-deep)",cursor:settings.openRouterKey?"pointer":"not-allowed",fontWeight:500}}>{q}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {helpMessages.map((m,i)=>(
                    <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start",flexDirection:m.role==="user"?"row-reverse":"row"}}>
                      <div style={{width:30,height:30,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,background:m.role==="user"?"var(--bg-subtle2)":"linear-gradient(135deg,#1E9E63,#15824F)",color:m.role==="user"?"var(--text-secondary)":"white",fontWeight:700}}>
                        {m.role==="user"?(settings.contactName?settings.contactName[0].toUpperCase():"Y"):"AI"}
                      </div>
                      {m.role==="user" ? (
                        <div style={{maxWidth:"82%",padding:"11px 15px",borderRadius:"14px 4px 14px 14px",background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",fontSize:13,lineHeight:1.6,whiteSpace:"pre-wrap",boxShadow:"var(--shadow-sm)"}}>
                          {m.content}
                        </div>
                      ) : (
                        <div style={{maxWidth:"87%",padding:"13px 16px 9px",borderRadius:"4px 16px 16px 16px",background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderLeft:"3px solid var(--green)",color:"var(--text-primary)",fontSize:13,lineHeight:1.6,boxShadow:"var(--shadow-sm)"}}>
                          <RichText text={m.content}/>
                        </div>
                      )}
                    </div>
                  ))}
                  {helpLoading&&(
                    <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                      <div style={{width:30,height:30,borderRadius:"50%",background:"linear-gradient(135deg,#1E9E63,#15824F)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:11,fontWeight:700,color:"white"}}>AI</div>
                      <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderLeft:"3px solid var(--green)",borderRadius:"4px 16px 16px 16px",padding:"14px 16px",display:"flex",gap:4,alignItems:"center",boxShadow:"var(--shadow-sm)"}}>
                        <span style={{width:7,height:7,borderRadius:"50%",background:"var(--text-tertiary)",animation:"typingDot 1.2s infinite 0s"}}/>
                        <span style={{width:7,height:7,borderRadius:"50%",background:"var(--text-tertiary)",animation:"typingDot 1.2s infinite 0.2s"}}/>
                        <span style={{width:7,height:7,borderRadius:"50%",background:"var(--text-tertiary)",animation:"typingDot 1.2s infinite 0.4s"}}/>
                      </div>
                    </div>
                  )}
                </div>

                {/* Input */}
                <div style={{display:"flex",gap:8,padding:"14px 16px",borderTop:"1px solid var(--border)",background:"var(--bg-subtle)"}}>
                  <input value={helpInput} onChange={e=>setHelpInput(e.target.value)}
                    onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&handleHelpChat(helpInput)}
                    placeholder={"Type your question..."}
                    style={{flex:1,padding:"11px 15px",border:"1px solid var(--border)",borderRadius:99,fontSize:13,outline:"none",background:"var(--bg-card-solid)"}}
                  />
                  <button onClick={()=>handleHelpChat(helpInput)} disabled={!helpInput.trim()||helpLoading} aria-label="Send message" title="Send" style={{width:42,height:42,borderRadius:"50%",border:"none",background:(!helpInput.trim()||helpLoading)?"var(--bg-subtle2)":"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",cursor:(!helpInput.trim()||helpLoading)?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  </button>
                </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <Card>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:10}}>Quick actions</div>
                  {[
                    {label:"Create a new request",action:()=>{setView("new");resetNewRequest();}},
                    {label:"Analyse supplier quotes",min:2,action:()=>handleNav("quotes")},
                    {label:"View & send orders",action:()=>setView("orders")},
                    {label:"Manage suppliers",min:2,action:()=>handleNav("suppliers")},
                    {label:"Configure settings",min:3,action:()=>handleNav("settings")},
                  ].filter(l=>!l.min||roleRank(myRole)>=l.min).map(l=>(
                    <button key={l.label} onClick={l.action} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:"var(--radius-sm)",border:"none",background:"transparent",cursor:"pointer",textAlign:"left",marginBottom:2,fontSize:13,color:"var(--text-primary)",transition:"background 0.15s"}}
                      onMouseEnter={e=>e.currentTarget.style.background="var(--bg-subtle)"}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      {l.label}
                    </button>
                  ))}
                </Card>
                <Card>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:10}}>Keyboard shortcuts</div>
                  {[["N","New request"],["Q","Quote analysis"],["O","Orders"],["D","Dashboard"],["S","Settings"],["H","Help"],["Esc","Close modals"]].map(([k,l])=>(
                    <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid var(--border)"}}>
                      <span style={{fontSize:12,color:"var(--text-secondary)"}}>{l}</span>
                      <kbd style={{background:"var(--bg-subtle2)",color:"var(--text-primary)",border:"1px solid var(--border)",borderRadius:5,padding:"2px 8px",fontSize:11,fontFamily:"monospace",fontWeight:600}}>{k}</kbd>
                    </div>
                  ))}
                </Card>
              </div>
            </div>
            <Card>
              <div style={{fontSize:15,fontWeight:700,color:"var(--text-primary)",marginBottom:20}}>Frequently asked questions</div>
              {helpFaqs.map((section,si)=>(
                <div key={si} style={{marginBottom:20}}>
                  <div style={{fontSize:12,fontWeight:700,color:"var(--green-dark)",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10,paddingBottom:6,borderBottom:"2px solid var(--green-light)"}}>{section.cat}</div>
                  {section.qs.map((faq,i)=>(
                    <details key={i} style={{marginBottom:6}}>
                      <summary style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",cursor:"pointer",padding:"10px 12px",background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)",listStyle:"none",display:"flex",justifyContent:"space-between",alignItems:"center",userSelect:"none"}}>
                        {faq.q}
                        <span style={{color:"var(--text-muted)",fontSize:12}}>+</span>
                      </summary>
                      <div style={{fontSize:13,color:"var(--text-secondary)",padding:"10px 12px",lineHeight:1.7,borderLeft:"3px solid var(--green-dark)",marginLeft:4,marginTop:4}}>{faq.a}</div>
                    </details>
                  ))}
                </div>
              ))}
            </Card>
            <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"14px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12,marginTop:16}}>
              <span style={{fontSize:13,fontWeight:700,color:"var(--text-primary)"}}>Pro<span style={{color:"var(--green-dark)"}}>Qure</span> v1.0</span>
              <button onClick={()=>setView("contact")} style={{fontSize:12,color:"var(--green-dark)",background:"none",border:"none",cursor:"pointer",fontWeight:500}}>Contact support</button>
            </div>
          </div>
        )}

        {view==="team"&&(
          <div className="stagger-in" style={{maxWidth:820}}>
            <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",marginBottom:4,color:"var(--text-primary)"}}>Team</h1>
            <p style={{fontSize:14,color:"var(--text-secondary)",marginBottom:24}}>Manage who has access and what they can do. Your role: <strong style={{color:"var(--green-dark)"}}>{ROLES[myRole]?.label||"Member"}</strong></p>

            {can.manageTeam(myRole) && (
              <Card>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>Invite someone</div>
                <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:14}}>Add a colleague by name and email and choose their role - we email them a link to set a password and join. Subcontractor vs internal is a label only; it does not change what they can see.</div>
                <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                  <input value={inviteName} onChange={e=>setInviteName(e.target.value)} placeholder="Name (optional)" type="text"
                    style={{flex:"1 1 140px",padding:"10px 13px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                  <input value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)} placeholder="colleague@company.co.uk" type="email"
                    style={{flex:"1 1 220px",padding:"10px 13px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                  <select value={inviteRole} onChange={e=>setInviteRole(e.target.value)}
                    style={{padding:"10px 13px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",background:"var(--bg-card-solid)",color:"var(--text-primary)"}}>
                    {Object.keys(ROLES).filter(r=>roleRank(r)<=roleRank(myRole)).sort((a,b)=>roleRank(a)-roleRank(b)).map(r=>(
                      <option key={r} value={r}>{ROLES[r].label}</option>
                    ))}
                  </select>
                  <select value={inviteEmployment} onChange={e=>setInviteEmployment(e.target.value)}
                    style={{padding:"10px 13px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",background:"var(--bg-card-solid)",color:"var(--text-primary)"}}>
                    <option value="subcontractor">Subcontractor</option>
                    <option value="internal">Internal</option>
                  </select>
                  <Btn color="#15824F" onClick={handleInviteMember}>{inviteBusy ? "Sending..." : "Create account & invite"}</Btn>
                </div>
                <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:10,lineHeight:1.5}}>Engineers raise the materials list and sign off deliveries. Buyers send RFQs, handle quotes and raise purchase orders. Managers manage the team and have full access.</div>
              </Card>
            )}

            <Card>
              <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:14}}>Team members ({team.length})</div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {team.map((m,mi)=>{
                  const isMe = (m.email||"").toLowerCase()===myEmail;
                  const memStat = memberStatus[(m.email||"").toLowerCase()];
                  return (
                    <div key={m.email||mi} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",background:"var(--bg-subtle)",borderRadius:"var(--radius-md)",border:"1px solid var(--border)",flexWrap:"wrap"}}>
                      <div style={{width:38,height:38,borderRadius:"50%",background:ROLES[m.role]?.bg||"var(--green-mint)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontWeight:700,color:ROLES[m.role]?.color||"var(--green-dark)",fontSize:15}}>
                        {(m.email||"?")[0].toUpperCase()}
                      </div>
                      <div style={{flex:"1 1 200px",minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.email}{isMe&&<span style={{fontSize:11,color:"var(--text-tertiary)",fontWeight:400}}> (you)</span>}</div>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginTop:2,flexWrap:"wrap"}}>
                          {(((m.employment) || (roleRank(m.role)>=2 ? "internal" : "subcontractor")) === "internal")
                            ? <span style={{fontSize:10,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",padding:"2px 8px",borderRadius:99,background:"var(--green-light)",color:"var(--green-deep)"}}>Internal</span>
                            : <span style={{fontSize:10,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",padding:"2px 8px",borderRadius:99,background:"#FBF3E8",color:"#9A5B16"}}>Subcontractor</span>}
                          {cloudEnabled && !isMe && ((memStat && memStat.active)
                            ? <span style={{fontSize:10,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",padding:"2px 8px",borderRadius:99,background:"var(--green-light)",color:"var(--green-deep)"}}>Active</span>
                            : <span style={{fontSize:10,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",padding:"2px 8px",borderRadius:99,background:"#FBF3E8",color:"#9A5B16"}} title="Invited - hasn't signed in yet">Pending</span>)}
                          <span style={{fontSize:11,color:"var(--text-secondary)"}}>{ROLES[m.role]?.desc||""}</span>
                        </div>
                      </div>
                      {can.manageTeam(myRole) && !isMe ? (
                        <select value={m.role} onChange={e=>handleChangeRole(m.email,e.target.value)}
                          style={{padding:"7px 10px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12,outline:"none",background:"var(--bg-card-solid)",color:"var(--text-primary)"}}>
                          {Object.keys(ROLES).filter(r=>roleRank(r)<=roleRank(myRole)||r===m.role).sort((a,b)=>roleRank(a)-roleRank(b)).map(r=>(
                            <option key={r} value={r}>{ROLES[r].label}</option>
                          ))}
                        </select>
                      ) : (
                        <span style={{fontSize:11,fontWeight:700,padding:"4px 12px",borderRadius:99,background:ROLES[m.role]?.bg||"var(--green-light)",color:ROLES[m.role]?.color||"var(--green-deep)"}}>{ROLES[m.role]?.label||"Member"}</span>
                      )}
                      {can.manageTeam(myRole) && !isMe && (
                        <button onClick={()=>handleRemoveMember(m.email)} aria-label="Remove member"
                          style={{background:"var(--red-light)",color:"var(--red)",border:"none",borderRadius:"var(--radius-sm)",padding:"7px 10px",cursor:"pointer",fontSize:12,fontWeight:600}}>Remove</button>
                      )}
                    </div>
                  );
                })}
              </div>
              {!can.manageTeam(myRole) && (
                <div style={{fontSize:12,color:"var(--text-tertiary)",marginTop:14,lineHeight:1.5}}>Only a Manager can invite people or change roles. Speak to your admin if you need access changed.</div>
              )}
            </Card>
          </div>
        )}

        {view==="contact"&&(
          <div className="stagger-in" style={{maxWidth:760}}>
            <div style={{background:"var(--green-mint)",border:"1px solid var(--green-light)",borderRadius:"var(--radius-md)",padding:"12px 16px",marginBottom:20,fontSize:13,color:"var(--green-deep)",lineHeight:1.5}}>
              <strong>We're keen to hear from you.</strong> Spotted a bug, or have an idea to make ProQure better? Tell us below - your feedback during this trial directly shapes the product.
            </div>
            <div style={{background:"linear-gradient(135deg,#0A0F1E,#1a2744)",borderRadius:20,padding:"36px 40px",marginBottom:28,position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:-40,right:-40,width:200,height:200,background:"radial-gradient(circle,rgba(99,102,241,0.12),transparent 70%)",borderRadius:"50%"}}/>
              <div style={{position:"relative",zIndex:1}}>
                <div style={{fontSize:11,color:"#818CF8",letterSpacing:"0.15em",textTransform:"uppercase",fontWeight:600,marginBottom:8}}>ProQure Support</div>
                <h1 style={{fontSize:30,fontWeight:800,color:"white",margin:0,letterSpacing:"-0.03em",marginBottom:8}}>Contact us</h1>
                <p style={{fontSize:14,color:"rgba(148,163,184,0.9)",margin:0}}>Raise a support request, report a bug, or suggest a feature</p>
              </div>
            </div>
            {contactSent?(
              <Card style={{textAlign:"center",padding:"48px 40px"}}>
                <div style={{width:60,height:60,borderRadius:"50%",background:"var(--green-mint)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}><Icon name="check_circle" size={30} color="var(--green-dark)"/></div>
                <div style={{fontSize:20,fontWeight:700,color:"var(--text-primary)",marginBottom:8}}>Request sent</div>
                <div style={{fontSize:14,color:"var(--text-secondary)",marginBottom:24}}>Thank you for getting in touch. We will respond as soon as possible.</div>
                <div style={{display:"flex",gap:10,justifyContent:"center"}}>
                  <button onClick={()=>setContactSent(false)} style={{background:"var(--bg-subtle2)",color:"var(--text-secondary)",border:"none",borderRadius:"var(--radius-sm)",padding:"9px 20px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Send another</button>
                  <button onClick={()=>setView("dashboard")} style={{background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"9px 20px",fontSize:13,fontWeight:700,cursor:"pointer"}}>Back to dashboard</button>
                </div>
              </Card>
            ):(
              <Card>
                <div style={{fontSize:15,fontWeight:700,color:"var(--text-primary)",marginBottom:20}}>Submit a support request</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Your name</label>
                    <input value={contactForm.name} onChange={e=>setContactForm(p=>({...p,name:e.target.value}))} placeholder="Your name" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Email address</label>
                    <input type="email" value={contactForm.email} onChange={e=>setContactForm(p=>({...p,email:e.target.value}))} placeholder="your@email.co.uk" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Category</label>
                    <select value={contactForm.category} onChange={e=>setContactForm(p=>({...p,category:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}>
                      {["Bug report","Feature request","Account issue","General enquiry"].map(o=><option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Priority</label>
                    <select value={contactForm.priority} onChange={e=>setContactForm(p=>({...p,priority:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}>
                      {["Low","Normal","High","Urgent"].map(o=><option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{marginBottom:14}}>
                  <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Description</label>
                  <textarea value={contactForm.description} onChange={e=>setContactForm(p=>({...p,description:e.target.value}))} placeholder="Please describe your issue in as much detail as possible..." style={{width:"100%",height:120,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",resize:"vertical",fontFamily:"inherit",lineHeight:1.6}}></textarea>
                </div>
                <button
                  onClick={async ()=>{
                    if(!contactForm.name.trim()||!contactForm.email.trim()){showToast("Please add your name and email","warn");return;}
                    if(!contactForm.description.trim()){showToast("Please add a description","warn");return;}
                    // No support mailbox wired yet: keep the form fully usable and just confirm.
                    if(!FEEDBACK_EMAIL){
                      showToast("Thanks - we've got it");
                      setContactSent(true);
                      setContactForm(p=>({...p,description:""}));
                      return;
                    }
                    setContactBusy(true);
                    try {
                      const sender = buildSender("quotes", settings);
                      const subject = `[ProQure] ${contactForm.category} (${contactForm.priority}) - ${contactForm.name||"User"}`;
                      const body = [
                        `Category: ${contactForm.category}`,
                        `Priority: ${contactForm.priority}`,
                        `From: ${contactForm.name} <${contactForm.email}>`,
                        session?.user?.email ? `Account: ${session.user.email}` : "",
                        `Company: ${settings.company||"-"}`,
                        `Sent: ${new Date().toLocaleString("en-GB")}`,
                        "",
                        contactForm.description.trim(),
                      ].filter(Boolean).join("\n");
                      const res = await fetch("/api/send-email",{method:"POST",headers:{"Content-Type":"application/json", ...(await authHeaders())},
                        body: JSON.stringify({ from:sender.from, company_id: cloudUserId, to:[FEEDBACK_EMAIL], reply_to:contactForm.email||undefined, subject, text:body })});
                      if(!res.ok) throw new Error("send failed");
                      showToast("Support request sent");
                      setContactSent(true);
                      setContactForm(p=>({...p,description:""}));
                    } catch(e) {
                      showToast("Couldn't send right now - please try again","warn");
                    } finally { setContactBusy(false); }
                  }}
                  disabled={contactBusy||!contactForm.name.trim()||!contactForm.email.trim()||!contactForm.description.trim()}
                  style={{background:"linear-gradient(135deg,#5B5BD6,#4A4AB8)",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"11px 24px",fontSize:14,fontWeight:700,cursor:contactBusy?"wait":"pointer",opacity:(contactBusy||!contactForm.name.trim()||!contactForm.email.trim()||!contactForm.description.trim())?0.5:1}}>
                  {contactBusy?"Sending...":"Submit request"}
                </button>
              </Card>
            )}
          </div>
        )}

        {view==="settings"&&(
          <div className="stagger-in" style={{maxWidth:720}}>
            <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",marginBottom:4,color:"var(--text-primary)"}}>Settings</h1>
            <p style={{fontSize:14,color:"var(--text-secondary)",marginBottom:24}}>Configure your company details, branding and preferences</p>
            {session && cloudEnabled && (
              <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"18px 22px",marginBottom:20,boxShadow:"var(--shadow-sm)",display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <div style={{width:38,height:38,borderRadius:"50%",background:"var(--green-mint)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                    <Icon name="check_circle" size={20} color="var(--green-dark)"/>
                  </div>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)"}}>Signed in &amp; syncing to the cloud</div>
                    <div style={{fontSize:12,color:"var(--text-secondary)",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                      <span>{session.user?.email}</span>
                      <span style={{fontSize:10,fontWeight:700,padding:"2px 9px",borderRadius:99,background:ROLES[myRole]?.bg||"var(--green-light)",color:ROLES[myRole]?.color||"var(--green-deep)"}}>{ROLES[myRole]?.label||"Member"}</span>
                    </div>
                  </div>
                </div>
                
              </div>
            )}
            <div style={{display:"grid",gap:16}}>
              {roleRank(myRole) >= 3 && (
              <Card>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",flexWrap:"wrap",gap:8}}>
                  <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)"}}>Plan &amp; billing</div>
                  <div style={{fontSize:12.5,color:"var(--text-secondary)"}}>Current plan: <b style={{color:"var(--green-dark)"}}>{PLAN_LABELS[settings.plan]||"Trial"}</b>{settings.subscriptionStatus&&settings.subscriptionStatus!=="active"?` \u00B7 ${settings.subscriptionStatus}`:""}</div>
                </div>
                {settings.subscriptionStatus==="past_due" && (
                  <div style={{background:"#fbf3df",border:"1px solid #e6d6a8",color:"#7a5a12",borderRadius:8,padding:"9px 12px",fontSize:12.5,margin:"10px 0 4px"}}>Your last payment failed. Tap <b>Manage billing</b> to update your card and keep your plan active.</div>
                )}
                <div style={{display:"grid",gap:7,margin:"14px 0 16px"}}>
                  {[["measureWeb","Measure online lookups"],["omWeb","O\u0026M datasheet packs"],["catalogueWeb","Catalogue online lookups"]].map(([f,lbl])=>{
                    const sp=usage.period===billingPeriod();
                    const limit=(planOf(settings)[f]||0)+(sp&&usage.addons?(usage.addons[f]||0):0);
                    const used=sp?(usage[f+"Used"]||0):0;
                    return (
                      <div key={f} style={{display:"flex",justifyContent:"space-between",fontSize:12.5}}>
                        <span style={{color:"var(--text-secondary)"}}>{lbl} <span style={{opacity:.65}}>this month</span></span>
                        <span style={{fontFamily:"ui-monospace,monospace",fontWeight:600,color:"var(--text-primary)"}}>{used} / {limit===Infinity?"\u221E":limit}</span>
                      </div>
                    );
                  })}
                </div>
                {(()=>{ const sp=usage.period===billingPeriod(); const cap=planOf(settings).aiBudget||0; const spent=(sp?(Number(usage.costPeriod)||0):0)*USD_TO_GBP; const pctv=cap>0?Math.min(100,Math.round(spent/cap*100)):0; const col=pctv>=100?"#B42318":pctv>=80?"#B45309":"var(--green)"; return cap>0?(
                  <div style={{margin:"0 0 16px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:12.5,marginBottom:5}}>
                      <span style={{color:"var(--text-secondary)"}}>AI usage <span style={{opacity:.65}}>this month</span></span>
                      <span style={{fontFamily:"ui-monospace,monospace",fontWeight:600,color:col}}>&pound;{spent.toFixed(2)} / &pound;{cap}</span>
                    </div>
                    <div style={{height:6,borderRadius:99,background:"var(--bg-subtle)",overflow:"hidden"}}><div style={{height:"100%",width:pctv+"%",background:col,borderRadius:99}}/></div>
                    {pctv>=100 && <div style={{fontSize:11.5,color:"#B42318",marginTop:5}}>Monthly AI limit reached \u2014 AI features pause until the 1st, or upgrade for more.</div>}
                  </div>
                ):null; })()}
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {["sole","team","business"].map(p=>(
                    <button key={p} onClick={()=>startCheckout({plan:p})} style={{padding:"8px 14px",background:settings.plan===p?"var(--green)":"var(--bg-subtle)",color:settings.plan===p?"#fff":"var(--text-primary)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>{settings.plan===p?"\u2713 ":""}{PLAN_LABELS[p]}</button>
                  ))}
                  <button onClick={openBillingPortal} style={{padding:"8px 14px",background:"transparent",color:"var(--green-dark)",border:"1px solid var(--green)",borderRadius:"var(--radius-sm)",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Manage billing</button>
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:8}}>
                  <button onClick={()=>startCheckout({kind:"measure_block"})} style={{padding:"7px 12px",background:"var(--bg-subtle)",color:"var(--text-secondary)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12,fontWeight:600,cursor:"pointer"}}>+100 Measure &middot; \u00A39</button>
                  <button onClick={()=>startCheckout({kind:"catalogue_block"})} style={{padding:"7px 12px",background:"var(--bg-subtle)",color:"var(--text-secondary)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12,fontWeight:600,cursor:"pointer"}}>+100 Catalogue &middot; \u00A39</button>
                  <button onClick={()=>startCheckout({kind:"om_block"})} style={{padding:"7px 12px",background:"var(--bg-subtle)",color:"var(--text-secondary)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12,fontWeight:600,cursor:"pointer"}}>+10 O&amp;M &middot; \u00A329</button>
                </div>
                <div style={{fontSize:11,color:"var(--text-secondary)",marginTop:12}}>Secure checkout by Stripe. In test mode use card 4242 4242 4242 4242, any future expiry and CVC.</div>
              </Card>
              )}
              <Card>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:16}}>Company details</div>
                <div style={{display:"grid",gap:12}}>
                  {[
                    {label:"Company name",k:"company",ph:"e.g. Initial Mechanical"},
                    {label:"Contact name",k:"contactName",ph:"e.g. Andy Hammill"},
                    {label:"Reply-to email (your inbox)",k:"fromEmail",ph:"e.g. andy@initialmechanical.co.uk"},
                    {label:"Phone",k:"phone",ph:"e.g. 0115 123 4567"},
                    {label:"Site address",k:"siteAddress",ph:"e.g. 52 Stretton Street"},
                  ].map(f=>(
                    <div key={f.k}>
                      <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:5}}>{f.label}</label>
                      <input value={sForm[f.k]||""} onChange={e=>setSForm(p=>({...p,[f.k]:e.target.value}))} placeholder={f.ph} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    </div>
                  ))}
                </div>
                <div style={{marginTop:12,fontSize:11.5,color:"var(--text-tertiary)",lineHeight:1.6,paddingTop:12,borderTop:"1px solid var(--border)"}}>
                  Quote requests and orders are sent from ProQure on your behalf, showing your business as the sender. When a supplier replies, it comes to the reply-to inbox above. Your logo and signature (set below under "How your emails look") control how the email itself looks. You never need to set up your own email to send.
                </div>
              </Card>
              <Card>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>How your emails look</div>
                <div style={{fontSize:12.5,color:"var(--text-secondary)",marginBottom:16,lineHeight:1.6}}>Two things shape every email you send to suppliers: your <strong>logo at the top</strong>, and your <strong>signature at the bottom</strong>. Set them once here.</div>
                <div style={{display:"grid",gap:18}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:700,color:"var(--green-dark)",display:"block",marginBottom:2,textTransform:"uppercase",letterSpacing:"0.05em"}}>1 · Logo (top of the email)</label>
                    <div style={{fontSize:11.5,color:"var(--text-muted)",marginBottom:8,lineHeight:1.5}}>Your company logo, shown in the header of every email.</div>
                    <div style={{display:"flex",alignItems:"center",gap:12}}>
                      {sForm.logoBase64&&(
                        <img src={sForm.logoBase64} alt="Logo" style={{height:48,maxWidth:120,objectFit:"contain",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:4}}/>
                      )}
                      <label style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:12,color:"var(--indigo)",background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"7px 14px",cursor:"pointer",fontWeight:500}}>
                        <Icon name="paperclip" size={14} style={{marginRight:6,verticalAlign:"-2px"}}/>{sForm.logoBase64?"Change logo":"Upload logo"}
                        <input type="file" accept="image/*" style={{display:"none"}} onChange={e=>{
                          const file = e.target.files[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = ev => {
                            // Resize logo to max 240px wide to keep localStorage small
                            const img = new Image();
                            img.onload = () => {
                              const maxW = 240;
                              const scale = Math.min(1, maxW / img.width);
                              const canvas = document.createElement("canvas");
                              canvas.width = img.width * scale;
                              canvas.height = img.height * scale;
                              const ctx2 = canvas.getContext("2d");
                              ctx2.drawImage(img, 0, 0, canvas.width, canvas.height);
                              const compressed = canvas.toDataURL("image/png");
                              setSForm(p=>({...p,logoBase64:compressed}));
                            };
                            img.onerror = () => showToast("Could not read that image","warn");
                            img.src = ev.target.result;
                          };
                          reader.readAsDataURL(file);
                        }}/>
                      </label>
                      {sForm.logoBase64&&<button onClick={()=>setSForm(p=>({...p,logoBase64:""}))} style={{fontSize:11,color:"var(--red)",background:"var(--red-light)",border:"none",borderRadius:6,padding:"5px 10px",cursor:"pointer"}}>Remove</button>}
                    </div>
                  </div>
                  <div style={{borderTop:"1px solid var(--border)",paddingTop:16}}>
                    <label style={{fontSize:11,fontWeight:700,color:"var(--green-dark)",display:"block",marginBottom:2,textTransform:"uppercase",letterSpacing:"0.05em"}}>2 · Signature (bottom of the email)</label>
                    <div style={{fontSize:11.5,color:"var(--text-muted)",marginBottom:8,lineHeight:1.5}}>Copy your signature straight from Outlook or Gmail and paste it in below - the formatting is kept. This is what appears at the bottom of every email. If you leave it blank, we'll use your name, company and contact details instead.</div>
                    <SignatureEditor value={sForm.emailSignature||""} onChange={(html)=>setSForm(p=>({...p,emailSignature:html}))}/>
                  </div>
                  <div style={{borderTop:"1px solid var(--border)",paddingTop:16}}>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Default PO terms</label>
                    <input value={sForm.poNotes||""} onChange={e=>setSForm(p=>({...p,poNotes:e.target.value}))} placeholder="e.g. 30 day payment terms" style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    <div style={{fontSize:11,color:"var(--text-muted)",marginTop:4}}>Optional terms shown on purchase orders.</div>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Quote validity (days)</label>
                    <input type="number" min="1" max="90" value={sForm.quoteValidityDays||30} onChange={e=>setSForm(p=>({...p,quoteValidityDays:parseInt(e.target.value)||30}))} style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    <div style={{fontSize:11,color:"var(--text-muted)",marginTop:4}}>Quotes saved to library expire after this many days.</div>
                  </div>
                </div>
              </Card>

              <Card>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <div style={{width:40,height:40,borderRadius:11,background:"var(--green-mint)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    <Icon name="check_circle" size={21} color="var(--green-dark)"/>
                  </div>
                  <div>
                    <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)"}}>AI &amp; email are managed for you</div>
                    <div style={{fontSize:13,color:"var(--text-secondary)",marginTop:2}}>Quote analysis, document scanning and email sending all work out of the box. There are no keys to set up.</div>
                  </div>
                </div>
              </Card>
              <div style={{display:"flex",gap:10}}>
                <Btn onClick={async()=>{ if(!can.editSettings(myRole)){showToast("Only a Manager can change company settings.","warn");return;} const next={...settings,...sForm}; saveSettings(sForm); if(cloudEnabled&&cloudUserId){ try{ await cloudPush(cloudUserId,"piq_settings",next); showToast("Settings saved"); }catch{ showToast("Saved on this device, but cloud sync failed - check connection","warn"); } } else { showToast("Settings saved"); } }} color="#5B5BD6">Save settings</Btn>
                <Btn outline onClick={()=>setSForm({...settings})}>Reset</Btn>
              </div>
            </div>
            {roleRank(myRole) >= 3 && (
              <Card>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                  <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)"}}>Activity overview</div>
                  <span style={{fontSize:10,fontWeight:800,letterSpacing:"0.05em",textTransform:"uppercase",color:"#4A4AB8",background:"#EEEEFB",borderRadius:99,padding:"2px 9px"}}>This workspace</span>
                </div>
                <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:14,lineHeight:1.5}}>A quiet running tally of activity in this workspace.</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                  {[["Requests raised","requestsRaised"],["Quotes analysed","quotesAnalysed"],["RFQs sent","rfqsSent"],["POs raised (total)","posRaised"],["— of which materials","posMaterials"],["— of which hire","posHire"],["Deliveries signed off","deliveriesSignedOff"],["Emails sent","emailsSent"]].map(([label,key])=>(
                    <div key={key} style={{background:"var(--bg-subtle2)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"11px 13px"}}>
                      <div style={{fontSize:20,fontWeight:800,color:"var(--text-primary)"}}>{(usage.totals&&usage.totals[key])||0}</div>
                      <div style={{fontSize:11,color:"var(--text-secondary)"}}>{label}</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
            {roleRank(myRole) >= 3 && (
              <Card>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>Purchase order approval</div>
                <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:14,lineHeight:1.5}}>When a Buyer selects a winning quote, require a Manager to approve before the PO is issued.</div>
                <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",fontSize:13,fontWeight:600,color:"var(--text-primary)"}}>
                  <input type="checkbox" checked={!!settings.requirePoApproval} onChange={e=>saveSettings({...settings,requirePoApproval:e.target.checked,poApprovalConfigured:true})} style={{width:16,height:16,cursor:"pointer"}}/>
                  Buyers need Manager approval to raise a PO
                </label>
              </Card>
            )}
            {roleRank(myRole) >= 3 && (
              <Card>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>Start fresh</div>
                <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:14,lineHeight:1.5}}>Clears your workspace to begin again - all current requests are archived and all orders are cancelled. <strong>Nothing is deleted</strong>; everything stays recoverable under Archived and in your activity log. Manager only.</div>
                <button onClick={()=>setResetConfirm(true)} style={{fontSize:13,fontWeight:600,color:"var(--red)",background:"var(--red-light)",border:"1px solid var(--red)",borderRadius:"var(--radius-sm)",padding:"10px 18px",cursor:"pointer"}}>Reset workspace</button>
              </Card>
            )}
            {roleRank(myRole) >= 3 && (
              <Card>
                <div style={{display:"inline-block",fontSize:10,fontWeight:800,letterSpacing:"0.08em",textTransform:"uppercase",color:"#9A5B16",background:"#FBF3E8",borderRadius:99,padding:"3px 10px",marginBottom:8}}>Temporary - trial only</div>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>Clear everything (keep suppliers)</div>
                <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:14,lineHeight:1.5}}>A true fresh start for testing: <strong>permanently deletes</strong> all requests, orders, quotes, saved quote sets, templates and activity history. Your <strong>suppliers, team and settings are kept</strong>. Unlike "Start fresh" above, this is <strong>not recoverable</strong>. This button will be removed before going live.</div>
                <button onClick={()=>setTrialResetConfirm(true)} style={{fontSize:13,fontWeight:600,color:"#fff",background:"var(--red)",border:"1px solid var(--red)",borderRadius:"var(--radius-sm)",padding:"10px 18px",cursor:"pointer"}}>Clear everything except suppliers</button>
              </Card>
            )}
          </div>
        )}

      </div>

      {/* Mobile bottom bar */}
      {isMobile&&(
        <div style={{position:"fixed",bottom:0,left:0,right:0,height:68,background:"var(--bottombar-bg)",borderTop:"1px solid var(--sidebar-border)",display:"flex",alignItems:"center",justifyContent:"space-around",zIndex:100}}>
          {[
            {id:"dashboard",label:"Home",    d:"M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"},
            {id:"new",      label:"Request", d:"M12 5v14M5 12h14"},
            {id:"quotes",   label:"Quotes",  min:2, d:"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2"},
            {id:"orders",   label:"Orders",  d:"M20 7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 16H8M12 12H8"},
            {id:"settings", label:"More",    d:"M4 6h16M4 12h16M4 18h16"},
          ].filter(tab=>!tab.min||roleRank(myRole)>=tab.min).map(tab=>(
            <button key={tab.id}
              onClick={()=>{
                if(tab.id==="settings"){setMoreMenuOpen(p=>!p);return;}
                setMoreMenuOpen(false);
                handleNav(tab.id);
              }}
              style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,background:"none",border:"none",cursor:"pointer",padding:"8px 14px",borderRadius:10,minWidth:56,position:"relative",flex:1}}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                stroke={tab.id==="settings"?moreMenuOpen?"var(--green)":"var(--sidebar-text)":view===tab.id?"var(--green)":"var(--sidebar-text)"}
                strokeWidth={view===tab.id||tab.id==="settings"&&moreMenuOpen?2.2:1.8}
                strokeLinecap="round" strokeLinejoin="round"><path d={tab.d}/></svg>
              <span style={{fontSize:10,fontWeight:(tab.id==="settings"?moreMenuOpen:view===tab.id)?700:400,color:(tab.id==="settings"?moreMenuOpen:view===tab.id)?"var(--green)":"var(--sidebar-text)"}}>{tab.label}</span>
              {tab.id==="orders"&&pendingOrders>0&&(
                <span style={{position:"absolute",top:4,right:"20%",background:"var(--green)",color:"white",fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:99}}>{pendingOrders}</span>
              )}
            </button>
          ))}
          {moreMenuOpen&&(
            <div style={{position:"fixed",bottom:68,left:0,right:0,zIndex:200,animation:"fadeIn 0.15s ease"}}>
              <div onClick={()=>setMoreMenuOpen(false)} style={{position:"fixed",inset:0,bottom:68,background:"rgba(0,0,0,0.6)",zIndex:198}}/>
              <div style={{position:"relative",zIndex:199,background:"var(--topbar-bg)",borderRadius:"20px 20px 0 0",padding:"8px 0 calc(12px + env(safe-area-inset-bottom))",boxShadow:"0 -8px 40px rgba(0,0,0,0.5)",border:"1px solid var(--sidebar-border)"}}>
                <div style={{width:36,height:4,background:"rgba(255,255,255,0.15)",borderRadius:99,margin:"0 auto 16px"}}/>
                <div style={{padding:"0 8px",maxHeight:"65vh",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
                  {[
                    {id:"requests", label:"All requests",   sub:"View and manage all RFQs",         icon:"clipboard"},
                    {id:"hire",     label:"Hire",            sub:"Plant & tool hire tracking",       icon:"truck"},
                    {id:"om",       label:"O&M files",       sub:"Generate O&M packs per project",    icon:"file_check", min:2},
                    {id:"reports",  label:"Reports",         sub:"Spend by trade, supplier, project", icon:"bar_chart", min:2},
                    {id:"measure",  label:"Measure",         sub:"Work out quantities to order",      icon:"ruler"},
                    {id:"suppliers",label:"Suppliers",       sub:"Manage your supplier accounts",    icon:"building", min:2},
                    {id:"team",     label:"Team",            sub:"People and roles",                icon:"building", min:3},
                    {id:"library",  label:"Quote library",   sub:"Price history and supplier scores",icon:"books", min:2},
                    {id:"help",     label:"Help & FAQ",       sub:"Guides and AI assistant",          icon:"help_circle"},
                    {id:"contact",  label:"Contact support",  sub:"Raise a request",                  icon:"mail"},
                    {id:"settings", label:"Settings",         sub:"Company details and account",      icon:"settings", min:3},
                  ].filter(item=>!item.min||roleRank(myRole)>=item.min).map(item=>(
                    <button key={item.id} onClick={()=>{handleNav(item.id);setMoreMenuOpen(false);}} style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"12px 16px",background:view===item.id?"rgba(34,197,94,0.1)":"transparent",border:"none",borderRadius:12,cursor:"pointer",textAlign:"left",marginBottom:2}}>
                      <div style={{width:40,height:40,background:view===item.id?"rgba(34,197,94,0.2)":"rgba(255,255,255,0.06)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0,color:view===item.id?"var(--green)":"var(--sidebar-text)"}}><Icon name={item.icon} size={18}/></div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:14,fontWeight:600,color:view===item.id?"var(--green)":"white"}}>{item.label}</div>
                        <div style={{fontSize:11,color:"#64748B",marginTop:2}}>{item.sub}</div>
                      </div>
                    </button>
                  ))}
                  {session && cloudEnabled && (
                    <button onClick={async()=>{ try{ await supabase.auth.signOut(); }catch{} window.location.reload(); }}
                      style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"12px 16px",background:"transparent",border:"none",borderRadius:12,cursor:"pointer",textAlign:"left",marginTop:4,borderTop:"1px solid var(--sidebar-border)"}}>
                      <div style={{width:40,height:40,background:"rgba(255,255,255,0.06)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:"var(--sidebar-text)"}}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
                      </div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:14,fontWeight:600,color:"white"}}>Sign out</div>
                        <div style={{fontSize:11,color:"#64748B",marginTop:2}}>{session.user?.email}</div>
                      </div>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {approveConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:440,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{textAlign:"center",marginBottom:20}}>
              <div style={{marginBottom:12,display:"flex",justifyContent:"center"}}><Icon name="clipboard" size={40} color="var(--text-tertiary)"/></div>
              <div style={{fontSize:18,fontWeight:700,color:"var(--text-primary)",marginBottom:6}}>Approve this quote?</div>
              <div style={{fontSize:13,color:"var(--text-secondary)",lineHeight:1.6}}>This will generate the PO, create an order, and save all other quotes to the library.</div>
            </div>
            {approveConfirm.requiresReview&&(
              <div style={{background:"#FFF7ED",border:"1px solid #FED7AA",borderRadius:"var(--radius-sm)",padding:"11px 14px",marginBottom:16,fontSize:12.5,color:"#9A5B16",lineHeight:1.5,display:"flex",gap:9,alignItems:"flex-start"}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C77D2E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0,marginTop:1}}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17.01"/></svg>
                <span>This quote had items the AI wasn't fully sure about. Please confirm the prices and totals match the supplier's original quote before approving.</span>
              </div>
            )}
            <div style={{background:"var(--bg-subtle)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:20}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div><div style={{fontSize:11,color:"var(--text-muted)",marginBottom:3}}>SUPPLIER</div><div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)"}}>{approveConfirm.supplierName||"—"}</div></div>
                <div><div style={{fontSize:11,color:"var(--text-muted)",marginBottom:3}}>ESTIMATED TOTAL</div><div style={{fontSize:14,fontWeight:600,color:"var(--green-dark)"}}>{approveConfirm.estimatedTotal||approveConfirm.subtotal||"—"}</div></div>
                <div><div style={{fontSize:11,color:"var(--text-muted)",marginBottom:3}}>COMPLETENESS</div><div style={{fontSize:14,fontWeight:600,color:approveConfirm.completeness>=80?"var(--green-dark)":"var(--amber)"}}>{approveConfirm.completeness||0}%</div></div>
                <div><div style={{fontSize:11,color:"var(--text-muted)",marginBottom:3}}>OTHER QUOTES</div><div style={{fontSize:14,fontWeight:600,color:"var(--text-secondary)"}}>{allAnalyses.length-1} saved to library</div></div>
              </div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <Btn outline onClick={()=>setApproveConfirm(null)}>Cancel</Btn>
              <Btn color="#15824F" onClick={()=>handleApprovePO(approveConfirm)}>Confirm approval</Btn>
            </div>
          </div>
        </div>
      )}

      {approveSuccess&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.6)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",zIndex:1001,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"36px 40px",maxWidth:420,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--green-dark)",textAlign:"center",animation:"fadeIn 0.3s ease"}}>
            <div style={{width:64,height:64,background:"linear-gradient(135deg,var(--green),var(--green-dark))",borderRadius:20,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 20px",boxShadow:"0 8px 24px rgba(34,197,94,0.3)"}}><Icon name="check" size={32} color="white" strokeWidth={2.5}/></div>
            <div style={{fontSize:22,fontWeight:800,color:"var(--text-primary)",letterSpacing:"-0.5px",marginBottom:6}}>PO Approved</div>
            <div style={{fontSize:15,fontWeight:600,color:"var(--green-dark)",marginBottom:16,fontFamily:"'JetBrains Mono',monospace"}}>{approveSuccess.poNum}</div>
            <div style={{background:"var(--bg-subtle)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:20,textAlign:"left"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontSize:12,color:"var(--text-secondary)"}}>Supplier</span><span style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{approveSuccess.supplier}</span></div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontSize:12,color:"var(--text-secondary)"}}>Job reference</span><span style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{approveSuccess.jobRef}</span></div>
              {approveSuccess.estimatedTotal&&<div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:12,color:"var(--text-secondary)"}}>Total</span><span style={{fontSize:12,fontWeight:600,color:"var(--green-dark)"}}>{approveSuccess.estimatedTotal}</span></div>}
            </div>
            <div style={{fontSize:12,color:"var(--text-tertiary)",marginBottom:20}}>Other quotes saved to library. Order created in Orders page.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <button onClick={()=>{setApproveSuccess(null);setView("orders");}} style={{background:"linear-gradient(135deg,var(--green),var(--green-dark))",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"10px 24px",fontSize:13,fontWeight:700,cursor:"pointer"}}>View in Orders</button>
              <button onClick={()=>setApproveSuccess(null)} style={{background:"var(--bg-subtle2)",color:"var(--text-secondary)",border:"none",borderRadius:"var(--radius-sm)",padding:"10px 20px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Stay here</button>
            </div>
          </div>
        </div>
      )}

      {showPoSetup&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 30px",maxWidth:440,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
            <div style={{fontSize:17,fontWeight:700,marginBottom:8,color:"var(--text-primary)"}}>One quick setup choice</div>
            <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:20,lineHeight:1.6}}>When a <strong>Buyer</strong> picks a winning quote, should they need a <strong>Manager</strong> to approve before the purchase order is issued? You can change this anytime in Settings.</div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <button onClick={()=>{saveSettings({...settings,requirePoApproval:true,poApprovalConfigured:true});setShowPoSetup(false);showToast("Buyers will need Manager approval for POs");}} style={{textAlign:"left",padding:"13px 16px",borderRadius:"var(--radius-md)",border:"1px solid var(--border)",background:"var(--bg-subtle2)",cursor:"pointer"}}>
                <div style={{fontSize:13.5,fontWeight:700,color:"var(--text-primary)"}}>Yes - Managers approve POs</div>
                <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>Buyers select a quote; a Manager signs it off. More control.</div>
              </button>
              <button onClick={()=>{saveSettings({...settings,requirePoApproval:false,poApprovalConfigured:true});setShowPoSetup(false);showToast("Buyers can raise POs directly");}} style={{textAlign:"left",padding:"13px 16px",borderRadius:"var(--radius-md)",border:"1px solid var(--border)",background:"var(--bg-subtle2)",cursor:"pointer"}}>
                <div style={{fontSize:13.5,fontWeight:700,color:"var(--text-primary)"}}>No - Buyers raise POs directly</div>
                <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>Buyers complete the purchase themselves. Faster.</div>
              </button>
            </div>
          </div>
        </div>
      )}

      {quickPO&&(
        <QuickPOModal
          form={quickPO}
          setForm={setQuickPO}
          suppliers={suppliers}
          isMobile={isMobile}
          onSubmit={handleQuickPO}
          onClose={()=>setQuickPO(null)}
          onAiFill={aiParseQuickPO}
          onScan={scanQuickPO}
        />
      )}

      {editSup&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1002,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={()=>setEditSup(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"24px",width:"100%",maxWidth:560,maxHeight:"86vh",overflowY:"auto",boxShadow:"var(--shadow-lg)"}}>
            <div style={{fontSize:18,fontWeight:800,color:"var(--text-primary)",marginBottom:16,letterSpacing:"-0.02em"}}>Edit supplier</div>

            <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"}}>Company name</label>
            <input value={editSup.name||""} onChange={e=>setEditSup(p=>({...p,name:e.target.value}))} style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",marginBottom:16}}/>

            <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"}}>Trades <span style={{textTransform:"none",fontWeight:400,color:"var(--text-tertiary)"}}>(comma-separated)</span></label>
            <input value={(editSup.categories||[]).join(", ")} onChange={e=>setEditSup(p=>({...p,categories:e.target.value.split(",").map(x=>x.trim()).filter(Boolean)}))} placeholder="Plumbing, HVAC" style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",marginBottom:16}}/>

            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Branches</label>
              <button onClick={()=>setEditSup(p=>({...p,branches:[...(p.branches||[]),""]}))} style={{fontSize:12,color:"var(--green-dark)",background:"var(--green-light)",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontWeight:600}}>+ Add branch</button>
            </div>
            {(editSup.branches||[]).length===0&&<div style={{fontSize:12,color:"var(--text-tertiary)",marginBottom:12}}>No branches yet. Add depots like "Leeds" or "Geldard Road" - you can then tag each contact with theirs.</div>}
            {(editSup.branches||[]).map((b,bi)=>(
              <div key={bi} style={{display:"flex",gap:8,marginBottom:8}}>
                <input value={b} onChange={e=>setEditSup(p=>{const br=[...(p.branches||[])];br[bi]=e.target.value;return{...p,branches:br};})} placeholder="Branch name" style={{flex:1,boxSizing:"border-box",padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                <button onClick={()=>setEditSup(p=>({...p,branches:(p.branches||[]).filter((_,i)=>i!==bi)}))} style={{fontSize:11,color:"var(--red)",background:"var(--red-light)",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer"}}>Remove</button>
              </div>
            ))}

            <div style={{height:1,background:"var(--border)",margin:"16px 0"}}/>

            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Contacts</label>
              <button onClick={()=>setEditSup(p=>({...p,contacts:[...(p.contacts||[]),{id:genId("C"),name:"",email:"",branch:""}]}))} style={{fontSize:12,color:"var(--green-dark)",background:"var(--green-light)",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontWeight:600}}>+ Add contact</button>
            </div>
            {(editSup.contacts||[]).length===0&&<div style={{fontSize:12,color:"var(--amber)",marginBottom:12}}>Add at least one contact with an email so you can send this supplier RFQs.</div>}
            {(editSup.contacts||[]).map((c)=>(
              <div key={c.id} style={{background:"var(--bg-subtle)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"12px",marginBottom:8}}>
                <div style={{display:"flex",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                  <input value={c.name} onChange={e=>setEditSup(p=>({...p,contacts:p.contacts.map(x=>x.id===c.id?{...x,name:e.target.value}:x)}))} placeholder="Contact name (optional)" style={{flex:"1 1 140px",boxSizing:"border-box",padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                  <input value={c.email} onChange={e=>setEditSup(p=>({...p,contacts:p.contacts.map(x=>x.id===c.id?{...x,email:e.target.value}:x)}))} placeholder="email@supplier.co.uk" style={{flex:"1 1 180px",boxSizing:"border-box",padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  {(editSup.branches||[]).filter(Boolean).length>0&&(
                    <select value={c.branch||""} onChange={e=>setEditSup(p=>({...p,contacts:p.contacts.map(x=>x.id===c.id?{...x,branch:e.target.value}:x)}))} style={{padding:"7px 10px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12,outline:"none",background:"var(--bg-card-solid)"}}>
                      <option value="">No branch</option>
                      {(editSup.branches||[]).filter(Boolean).map((b,i)=><option key={i} value={b}>{b}</option>)}
                    </select>
                  )}
                  <button onClick={()=>setEditSup(p=>({...p,contacts:p.contacts.filter(x=>x.id!==c.id)}))} style={{marginLeft:"auto",fontSize:11,color:"var(--red)",background:"var(--red-light)",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer"}}>Remove contact</button>
                </div>
              </div>
            ))}

            <div style={{display:"flex",gap:10,marginTop:18}}>
              <Btn outline onClick={()=>setEditSup(null)}>Cancel</Btn>
              <Btn onClick={()=>{
                if(!can.manageSuppliers(myRole)){showToast("Only a Buyer or Manager can edit suppliers.","warn");return;}
                if(!editSup.name||!editSup.name.trim()){showToast("Company name required","warn");return;}
                const clean={...editSup,name:editSup.name.trim(),branches:(editSup.branches||[]).map(b=>(b||"").trim()).filter(Boolean),contacts:(editSup.contacts||[]).map(c=>({...c,name:(c.name||"").trim(),email:(c.email||"").trim()})).filter(c=>c.email||c.name)};
                const norm=normSupplier(clean);
                setSuppliers(p=>p.map(x=>x.id===norm.id?norm:x));
                logActivity("Supplier updated",`${norm.name} updated (${norm.contacts.length} contact${norm.contacts.length!==1?"s":""})`,{entity:"supplier"});
                setEditSup(null); showToast("Supplier updated");
              }} color="#15824F">Save changes</Btn>
            </div>
          </div>
        </div>
      )}

      {promotePrompt&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1002,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={()=>{ setSuppliers(prev=>{const n=prev.map(s=>s.id===promotePrompt.id?{...s,promoteDismissed:true}:s);try{localStorage.setItem("piq_suppliers",JSON.stringify(n));}catch{}return n;}); setPromotePrompt(null); }}>
          <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"26px 28px",maxWidth:420,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
            <div style={{display:"inline-flex",alignItems:"center",gap:8,padding:"4px 10px",borderRadius:99,background:"rgba(21,130,79,0.12)",marginBottom:14}}>
              <span style={{fontSize:11,fontWeight:700,color:"#15824F",letterSpacing:"0.04em",textTransform:"uppercase"}}>Frequently used</span>
            </div>
            <div style={{fontSize:17,fontWeight:700,marginBottom:8,color:"var(--text-primary)"}}>Promote {promotePrompt.name} to an approved supplier?</div>
            <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:20,lineHeight:1.6}}>You've used <strong>{promotePrompt.name}</strong> {promotePrompt.useCount||5} times. They started as an ad-hoc supplier - would you like to add them to your approved suppliers?</div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>promoteSupplier(promotePrompt.id)} style={{flex:1,padding:"11px",borderRadius:"var(--radius-md)",border:"none",background:"#15824F",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>Yes, approve</button>
              <button onClick={()=>{ setSuppliers(prev=>{const n=prev.map(s=>s.id===promotePrompt.id?{...s,promoteDismissed:true}:s);try{localStorage.setItem("piq_suppliers",JSON.stringify(n));}catch{}return n;}); setPromotePrompt(null); }} style={{flex:1,padding:"11px",borderRadius:"var(--radius-md)",border:"1px solid var(--border)",background:"var(--bg-subtle2)",color:"var(--text-primary)",fontSize:14,fontWeight:600,cursor:"pointer"}}>Not now</button>
            </div>
          </div>
        </div>
      )}

      {hireForm&&(
        <HireFormModal form={hireForm} setForm={setHireForm} suppliers={suppliers} onSubmit={(f)=>{raiseHire(f);setHireForm(null);}} onClose={()=>setHireForm(null)} canViewCosts={can.viewCosts(myRole)} onAiFill={aiParseHire}/>
      )}
      {deliverModal&&(
        <DeliverModal data={deliverModal} onSubmit={async(file,note)=>{ await markHireDelivered(deliverModal.hireId,file,note); setDeliverModal(null); }} onClose={()=>setDeliverModal(null)}/>
      )}
      {offHireModal&&(
        <OffHireModal data={offHireModal} hire={hires.find(h=>h.id===offHireModal.hireId)} onSubmit={async(date,addr)=>{ await offHireItem(offHireModal.hireId,date,addr); setOffHireModal(null); }} onClose={()=>setOffHireModal(null)}/>
      )}
      {closeHireModal&&(
        <CloseHireModal onSubmit={(ref)=>{ closeHire(closeHireModal.hireId,ref); setCloseHireModal(null); }} onClose={()=>setCloseHireModal(null)}/>
      )}
      {extendModal&&(
        <ExtendModal current={extendModal.current} onSubmit={(d)=>{ extendHire(extendModal.hireId,d); setExtendModal(null); }} onClose={()=>setExtendModal(null)}/>
      )}

      {resetConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={()=>setResetConfirm(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 30px",maxWidth:420,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
            <div style={{fontSize:16,fontWeight:600,marginBottom:8,textAlign:"center",color:"var(--text-primary)"}}>Reset the workspace?</div>
            <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:24,textAlign:"center",lineHeight:1.6}}>This archives every current request and cancels every order, giving you a clean slate. Nothing is destroyed - it all stays under Archived and in your activity log, and can be restored. This is logged against your account.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <Btn outline onClick={()=>setResetConfirm(false)}>Keep everything</Btn>
              <Btn color="#D14343" onClick={handleResetWorkspace}>Reset workspace</Btn>
            </div>
          </div>
        </div>
      )}

      {trialResetConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={()=>setTrialResetConfirm(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 30px",maxWidth:440,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
            <div style={{fontSize:16,fontWeight:600,marginBottom:8,textAlign:"center",color:"var(--text-primary)"}}>Clear everything except suppliers?</div>
            <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:24,textAlign:"center",lineHeight:1.6}}>This <strong>permanently deletes</strong> all requests, orders, quotes, saved quote sets, templates and activity history - it cannot be undone. Your <strong>suppliers, team and settings stay.</strong> Use this only to start the trial from scratch.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <Btn outline onClick={()=>setTrialResetConfirm(false)}>Cancel</Btn>
              <Btn color="#D14343" onClick={handleTrialReset}>Yes, clear everything</Btn>
            </div>
          </div>
        </div>
      )}

      {cancelOrderConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={()=>setCancelOrderConfirm(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 30px",maxWidth:400,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
            <div style={{fontSize:16,fontWeight:600,marginBottom:8,textAlign:"center",color:"var(--text-primary)"}}>Cancel this order?</div>
            <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:24,textAlign:"center",lineHeight:1.6}}>The order will be marked as cancelled but kept on record for your audit trail. It won't be deleted. If you've already sent the PO to the supplier, remember to let them know separately.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <Btn outline onClick={()=>setCancelOrderConfirm(null)}>Keep order</Btn>
              <Btn color="#D14343" onClick={()=>handleCancelOrder(cancelOrderConfirm.id)}>Cancel order</Btn>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:400,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{marginBottom:12,display:"flex",justifyContent:"center"}}><Icon name="trash" size={34} color="var(--red)"/></div>
            <div style={{fontSize:16,fontWeight:600,marginBottom:8,textAlign:"center",color:"var(--text-primary)"}}>Archive this request?</div>
            <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:24,textAlign:"center",lineHeight:1.6}}>It will be hidden from your active list but kept safely under Archived, so you can restore it later if needed.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <Btn outline onClick={()=>setDeleteConfirm(null)}>Cancel</Btn>
              <Btn color="#D14343" onClick={()=>handleDelete(deleteConfirm.id)}>Archive</Btn>
            </div>
          </div>
        </div>
      )}

      {editModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:540,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{fontSize:16,fontWeight:600,marginBottom:20,color:"var(--text-primary)"}}>Edit request - {editModal.id}</div>
            <div style={{display:"grid",gap:14}}>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Job Reference</label>
                <input value={editForm.jobRef||""} onChange={e=>setEditForm(p=>({...p,jobRef:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Site</label>
                <input value={editForm.site||""} onChange={e=>setEditForm(p=>({...p,site:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Status</label>
                <select value={editForm.status||"draft"} onChange={e=>setEditForm(p=>({...p,status:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}>
                  <option value="draft">Draft</option>
                  <option value="pending">Pending quotes</option>
                  <option value="received">Quotes received</option>
                  <option value="approved">Approved</option>
                </select>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Notes</label>
                <textarea value={editForm.notes||""} onChange={e=>setEditForm(p=>({...p,notes:e.target.value}))} placeholder="Add any notes about this request..." style={{width:"100%",height:80,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",resize:"vertical",fontFamily:"inherit"}}></textarea>
              </div>
            </div>
            <div style={{display:"flex",gap:10,marginTop:20,justifyContent:"flex-end"}}>
              <Btn outline onClick={()=>setEditModal(null)}>Cancel</Btn>
              <Btn onClick={handleEditSave}>Save changes</Btn>
            </div>
          </div>
        </div>
      )}

      {activityModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:560,width:"100%",maxHeight:"80vh",overflow:"auto",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontSize:16,fontWeight:600,color:"var(--text-primary)"}}>{activityModal.id} - Activity log</div>
                <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>{activityModal.jobRef} · {activityModal.site}</div>
              </div>
              <button onClick={()=>setActivityModal(null)} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"var(--text-muted)"}}>x</button>
            </div>
            {(!activityModal.activity||activityModal.activity.length===0)?(
              <div style={{textAlign:"center",padding:"40px 0",color:"var(--text-tertiary)",fontSize:13}}>No activity logged yet</div>
            ):(
              <div>
                {[...(activityModal.activity||[])].reverse().map((entry,i)=>(
                  <div key={i} style={{display:"flex",gap:14,padding:"12px 0",borderBottom:"1px solid var(--border)"}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:"var(--green-dark)",marginTop:5,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                        <span style={{fontSize:13,fontWeight:500,color:"var(--text-primary)"}}>{entry.action}</span>
                        <span style={{fontSize:11,color:"var(--text-muted)",whiteSpace:"nowrap",marginLeft:12}}>{new Date(entry.ts).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</span>
                      </div>
                      {entry.detail&&<div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>{entry.detail}</div>}
                      <div style={{fontSize:11,color:"var(--text-muted)",marginTop:2}}>by {entry.user||"System"}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {needsOnboarding && (
        <CompanyOnboarding session={session} initial={settings} onComplete={(vals)=>{ saveSettings(vals); }} />
      )}

      {!needsOnboarding && tourStep>=0&&tourStep<tourSteps.length&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.6)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",zIndex:2500,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"30px 32px",maxWidth:420,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{display:"flex",justifyContent:"center",marginBottom:16}}>
              <div style={{width:54,height:54,borderRadius:16,background:"linear-gradient(135deg,var(--green),var(--green-dark))",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 8px 24px rgba(34,197,94,0.25)"}}>
                <Icon name={tourSteps[tourStep].icon} size={26} color="white"/>
              </div>
            </div>
            <div style={{fontSize:18,fontWeight:800,color:"var(--text-primary)",textAlign:"center",marginBottom:8,letterSpacing:"-0.02em"}}>{tourSteps[tourStep].title}</div>
            <div style={{fontSize:13.5,color:"var(--text-secondary)",textAlign:"center",lineHeight:1.6,marginBottom:22}}>{tourSteps[tourStep].body}</div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginBottom:20}}>
              {tourSteps.map((_,i)=>(
                <div key={i} style={{width:i===tourStep?20:7,height:7,borderRadius:99,background:i===tourStep?"var(--green-dark)":"var(--border-solid)",transition:"all 0.2s"}}/>
              ))}
            </div>
            <div style={{display:"flex",gap:10}}>
              <Btn outline onClick={dismissTour}>Skip</Btn>
              <Btn color="#15824F" onClick={()=>{ if(tourStep>=tourSteps.length-1) dismissTour(); else setTourStep(s=>s+1); }}>{tourStep>=tourSteps.length-1?"Get started":"Next"}</Btn>
            </div>
          </div>
        </div>
      )}

      {showShortcuts&&(
        <div onClick={()=>setShowShortcuts(false)} style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.6)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:480,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div style={{fontSize:16,fontWeight:700,color:"var(--text-primary)"}}>Keyboard shortcuts</div>
              <kbd style={{background:"var(--bg-subtle2)",border:"1px solid var(--border)",borderRadius:5,padding:"2px 8px",fontSize:11,color:"var(--text-secondary)",cursor:"pointer"}} onClick={()=>setShowShortcuts(false)}>Esc</kbd>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {[
                ["N","New request"],["Q","Quote analysis"],["O","Orders"],
                ["D","Dashboard"],["S","Settings"],["H","Help"],
                ["?","Toggle shortcuts"],["Esc","Close modals"],
              ].map(([k,l])=>(
                <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)"}}>
                  <span style={{fontSize:13,color:"var(--text-secondary)"}}>{l}</span>
                  <kbd style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:5,padding:"2px 10px",fontSize:12,fontFamily:"monospace",fontWeight:700,color:"var(--text-primary)",boxShadow:"0 1px 0 var(--border)"}}>{k}</kbd>
                </div>
              ))}
            </div>
            <div style={{marginTop:16,padding:"10px 12px",background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)"}}>
              <div style={{fontSize:11,color:"var(--text-muted)",textAlign:"center"}}>Press <strong>?</strong> or <strong>/</strong> at any time to show this panel</div>
            </div>
          </div>
        </div>
      )}

      {templateModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"24px 28px",maxWidth:560,width:"100%",maxHeight:"85vh",overflow:"auto",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontSize:17,fontWeight:700,color:"var(--text-primary)"}}>Request templates</div>
                <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>Material list templates grouped by trade</div>
              </div>
              <button onClick={()=>setTemplateModal(false)} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"var(--text-muted)"}}>x</button>
            </div>
            {parsed&&(
              <div style={{background:"var(--green-mint)",border:"1px solid var(--green-dark)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:20}}>
                <div style={{fontSize:12,fontWeight:600,color:"var(--green-deep)",marginBottom:8}}>Save current list - {templateCurrentTrade}</div>
                <div style={{display:"flex",gap:10}}>
                  <input value={newTemplateName} onChange={e=>setNewTemplateName(e.target.value)}
                    placeholder={`Name e.g. Standard ${templateCurrentTrade} pack`}
                    style={{flex:1,padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}
                    onKeyDown={e=>e.key==="Enter"&&handleSaveTemplate()}
                  />
                  <Btn onClick={handleSaveTemplate} disabled={!newTemplateName.trim()} color="#15824F">Save</Btn>
                </div>
              </div>
            )}
            {templates.length===0?(
              <div style={{textAlign:"center",padding:"40px 0",color:"var(--text-tertiary)"}}>
                <div style={{fontSize:36,marginBottom:12}}>list</div>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-secondary)"}}>No templates yet</div>
                <div style={{fontSize:12,marginTop:6,lineHeight:1.6}}>Create a request then save it as a template from Step 2</div>
              </div>
            ):(
              <div>
                {Object.keys(templateGrouped).sort((a,b)=>a===templateCurrentTrade?-1:b===templateCurrentTrade?1:0).map(tradeName=>(
                  <div key={tradeName} style={{marginBottom:16}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                      <span style={{fontSize:11,fontWeight:700,color:tradeName===templateCurrentTrade?"var(--green-dark)":"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.1em"}}>
                        {tradeName===templateCurrentTrade?"* ":""}{tradeName}
                      </span>
                      <span style={{fontSize:10,color:"var(--text-muted)",background:"var(--bg-subtle2)",padding:"1px 7px",borderRadius:99}}>{templateGrouped[tradeName].length}</span>
                    </div>
                    {templateGrouped[tradeName].map(t=>(
                      <div key={t.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",background:tradeName===templateCurrentTrade?"var(--green-mint)":"var(--bg-subtle)",borderRadius:"var(--radius-md)",marginBottom:6,border:"1px solid",borderColor:tradeName===templateCurrentTrade?"var(--green-dark)":"var(--border)"}}>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                            <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.name}</div>
                            {t.usageCount>0&&<span style={{fontSize:9,color:"var(--text-muted)",background:"var(--bg-subtle2)",padding:"1px 6px",borderRadius:99,flexShrink:0}}>used {t.usageCount}x</span>}
                          </div>
                          <div style={{fontSize:11,color:"var(--text-secondary)"}}>{t.items.length} items{t.lastUsed?` · last used ${t.lastUsed}`:` · saved ${t.created}`}</div>
                        </div>
                        <div style={{display:"flex",gap:6,flexShrink:0}}>
                          <button onClick={()=>handleLoadTemplate(t)} style={{fontSize:12,color:"white",background:"var(--green-dark)",border:"none",borderRadius:"var(--radius-sm)",padding:"7px 14px",cursor:"pointer",fontWeight:600}}>Load</button>
                          <button onClick={()=>saveTemplates(templates.filter(x=>x.id!==t.id))} style={{fontSize:12,color:"var(--red)",background:"var(--red-light)",border:"none",borderRadius:"var(--radius-sm)",padding:"7px 10px",cursor:"pointer"}}>x</button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

// --- Quick PO modal (emergency direct PO) ------------------------------------
function QuickPOModal({ form, setForm, suppliers, isMobile, onSubmit, onClose, onAiFill, onScan }) {
  const upd = (patch) => setForm(f => ({ ...f, ...patch }));
  const items = form.items || [{ description:"", quantity:"", unit:"", unitPrice:"" }];
  const setItem = (idx, patch) => {
    const next = items.map((it,i) => i===idx ? { ...it, ...patch } : it);
    upd({ items: next });
  };
  const addItem = () => upd({ items: [...items, { description:"", quantity:"", unit:"", unitPrice:"" }] });
  const removeItem = (idx) => upd({ items: items.filter((_,i)=>i!==idx) });

  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const inputStyle = { width:"100%", boxSizing:"border-box", padding:"9px 12px", border:"1px solid var(--border)", borderRadius:"var(--radius-sm)", fontSize:13, outline:"none", background:"var(--bg-card-solid)", color:"var(--text-primary)" };
  const labelStyle = { fontSize:11, fontWeight:700, color:"var(--text-secondary)", textTransform:"uppercase", letterSpacing:"0.04em", marginBottom:5, display:"block" };

  const approvedSuppliers = suppliers.filter(s => s.tier !== "ad-hoc");
  const adhocSuppliers = suppliers.filter(s => s.tier === "ad-hoc");

  const applyAi = (r) => {
    if (!r) return;
    const patch = {};
    if (r.items && r.items.length) patch.items = r.items.map(it=>({description:it.description||"",quantity:it.quantity||"",unit:it.unit||"",unitPrice:it.unitPrice||""}));
    if (r.total) patch.total = r.total;
    if (r.summary) patch.summary = r.summary;
    if (r.supplierName) {
      const match = suppliers.find(s => s.name.toLowerCase() === r.supplierName.toLowerCase())
                 || suppliers.find(s => s.name.toLowerCase().includes(r.supplierName.toLowerCase()) || r.supplierName.toLowerCase().includes(s.name.toLowerCase()));
      if (match) { patch.supplierId = match.id; patch.newSupplier = false; }
      else { patch.newSupplier = true; patch.newSupplierName = r.supplierName; }
    }
    upd(patch);
  };
  const runAi = async () => {
    if (!aiText.trim() || !onAiFill) return;
    setAiBusy(true);
    try { applyAi(await onAiFill(aiText.trim(), suppliers.map(s=>s.name))); } catch {}
    setAiBusy(false);
  };
  const [scanBusy, setScanBusy] = useState(false);
  const [supOpen, setSupOpen] = useState(false);
  const runScan = async (file) => {
    if (!file || !onScan) return;
    setScanBusy(true);
    try { applyAi(await onScan(file)); } catch {}
    setScanBusy(false);
  };
  const { listening, supported:voiceOk, start:micStart, stop:micStop } = useSpeechRecognition({
    onTranscript:(t)=>setAiText(t),
    onFinal:(t)=>setAiText(t)
  });

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1001,display:"flex",alignItems:isMobile?"stretch":"flex-start",justifyContent:"center",padding:isMobile?0:"20px",overflowY:"auto"}}>
      <div style={{background:"var(--bg-card-solid)",borderRadius:isMobile?0:"var(--radius-lg)",maxWidth:isMobile?"100%":640,width:"100%",boxShadow:"var(--shadow-lg)",border:isMobile?"none":"1px solid var(--border)",margin:isMobile?0:"20px 0",display:"flex",flexDirection:"column",maxHeight:isMobile?"100dvh":"calc(100vh - 40px)"}}>
        <div style={{padding:isMobile?"18px 18px 0":"26px 28px 0",overflowY:"auto",flex:1,minHeight:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:8,padding:"4px 10px",borderRadius:99,background:"rgba(217,119,6,0.12)"}}>
            <span style={{fontSize:11,fontWeight:700,color:"#D97706",letterSpacing:"0.04em",textTransform:"uppercase"}}>Quick PO</span>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:20,color:"var(--text-secondary)",lineHeight:1}}>&times;</button>
        </div>
        <div style={{fontSize:17,fontWeight:700,marginBottom:4,color:"var(--text-primary)"}}>Raise a quick purchase order</div>
        <div style={{fontSize:12.5,color:"var(--text-secondary)",marginBottom:14,lineHeight:1.55}}>For phone-agreed orders that skip the quote process. This creates a numbered PO straight away and logs it as a direct/phone order.</div>

        {/* AI quick-fill: type, dictate, or scan */}
        <div style={{background:"var(--bg-subtle2)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"10px 12px",marginBottom:16}}>
          <div style={{fontSize:11,fontWeight:700,color:"#D97706",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.04em"}}>Say, type or scan the order - AI fills it in</div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <input value={aiText} onChange={e=>setAiText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")runAi();}} placeholder='e.g. "10 lengths 22mm copper, £340 with Travis Perkins"' style={{...inputStyle,flex:1}}/>
            {voiceOk && (
              <button onClick={()=>listening?micStop():micStart()} title={listening?"Stop dictation":"Dictate"} style={{padding:"9px 11px",borderRadius:"var(--radius-sm)",border:"1px solid var(--border)",background:listening?"#DC2626":"var(--bg-card-solid)",color:listening?"#fff":"var(--text-secondary)",cursor:"pointer",display:"flex",alignItems:"center"}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              </button>
            )}
            <label title="Scan a quote or delivery note" style={{padding:"9px 11px",borderRadius:"var(--radius-sm)",border:"1px solid var(--border)",background:scanBusy?"var(--border)":"var(--bg-card-solid)",color:"var(--text-secondary)",cursor:scanBusy?"wait":"pointer",display:"flex",alignItems:"center"}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>
              <input type="file" accept="image/*,.pdf" capture="environment" disabled={scanBusy} style={{display:"none"}} onChange={e=>{if(e.target.files?.[0])runScan(e.target.files[0]);e.target.value="";}}/>
            </label>
            <button onClick={runAi} disabled={aiBusy||!aiText.trim()} style={{padding:"9px 14px",borderRadius:"var(--radius-sm)",border:"none",background:aiBusy||!aiText.trim()?"var(--border)":"#D97706",color:"#fff",fontSize:12.5,fontWeight:700,cursor:aiBusy?"wait":"pointer",whiteSpace:"nowrap"}}>{aiBusy?"...":"AI fill"}</button>
          </div>
          {listening && <div style={{fontSize:11,color:"#DC2626",marginTop:6,fontWeight:600}}>Listening… speak the order, then tap the mic again.</div>}
          {scanBusy && <div style={{fontSize:11,color:"var(--text-secondary)",marginTop:6}}>Reading document…</div>}
        </div>

        {/* Supplier */}
        <label style={labelStyle}>Supplier</label>
        {!form.newSupplier ? (
          <select value={form.supplierId||""} onChange={e=>{ const v=e.target.value; if(v==="__new__"){upd({newSupplier:true,supplierId:null});} else {upd({supplierId:v,newSupplier:false});} }} style={{...inputStyle,marginBottom:8,cursor:"pointer",appearance:"auto"}}>
            <option value="">Select a supplier...</option>
            {approvedSuppliers.length>0&&(<optgroup label="Approved suppliers">{approvedSuppliers.map(sp=><option key={sp.id} value={String(sp.id)}>{sp.name}</option>)}</optgroup>)}
            {adhocSuppliers.length>0&&(<optgroup label="Ad-hoc suppliers">{adhocSuppliers.map(sp=><option key={sp.id} value={String(sp.id)}>{sp.name} (ad-hoc)</option>)}</optgroup>)}
            <option value="__new__">+ Add a new supplier on the spot</option>
          </select>
        ) : (
          <div style={{marginBottom:8,padding:"12px",border:"1px dashed var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-subtle2)"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <span style={{fontSize:12,fontWeight:700,color:"#D97706"}}>New ad-hoc supplier</span>
              <button onClick={()=>upd({newSupplier:false,newSupplierName:"",newSupplierEmail:""})} style={{background:"none",border:"none",color:"var(--text-secondary)",fontSize:12,cursor:"pointer",textDecoration:"underline"}}>pick existing instead</button>
            </div>
            <input value={form.newSupplierName||""} onChange={e=>upd({newSupplierName:e.target.value})} placeholder="Supplier name" style={{...inputStyle,marginBottom:8}}/>
            <input value={form.newSupplierEmail||""} onChange={e=>upd({newSupplierEmail:e.target.value})} placeholder="Email (optional)" style={inputStyle}/>
            <div style={{fontSize:11,color:"var(--text-secondary)",marginTop:7,lineHeight:1.45}}>Saved as an <strong>ad-hoc</strong> supplier you can reuse. After 5 uses you'll be asked whether to add them to your approved list.</div>
          </div>
        )}

        {/* Job ref + site */}
        <div style={{display:"flex",gap:10,marginTop:12}}>
          <div style={{flex:1}}>
            <label style={labelStyle}>Job ref</label>
            <input value={form.jobRef||""} onChange={e=>upd({jobRef:e.target.value})} placeholder="e.g. JOB-104" style={inputStyle}/>
          </div>
          <div style={{flex:1}}>
            <label style={labelStyle}>Site (optional)</label>
            <input value={form.site||""} onChange={e=>upd({site:e.target.value})} placeholder="Site / address" style={inputStyle}/>
          </div>
        </div>

        {/* Items */}
        <div style={{marginTop:16,marginBottom:6,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <label style={{...labelStyle,marginBottom:0}}>Items</label>
          <button onClick={addItem} style={{background:"none",border:"none",color:"#15824F",fontSize:12,fontWeight:700,cursor:"pointer"}}>+ Add line</button>
        </div>
        {items.map((it,idx)=>(
          <div key={idx} style={{border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:8,marginBottom:8,background:"var(--bg-subtle2)"}}>
            <div style={{display:"flex",gap:6,alignItems:"flex-start"}}>
              <input value={it.description||""} onChange={e=>setItem(idx,{description:e.target.value})} placeholder="Item description" style={{...inputStyle,flex:1,background:"var(--bg-card-solid)"}}/>
              {items.length>1 && <button onClick={()=>removeItem(idx)} title="Remove line" style={{background:"none",border:"none",color:"var(--text-secondary)",fontSize:20,cursor:"pointer",lineHeight:1,padding:"4px 4px 0"}}>&times;</button>}
            </div>
            <div style={{display:"flex",gap:6,marginTop:6}}>
              <input value={it.quantity||""} onChange={e=>setItem(idx,{quantity:e.target.value})} placeholder="Qty" style={{...inputStyle,flex:1,minWidth:0,background:"var(--bg-card-solid)"}}/>
              <input value={it.unit||""} onChange={e=>setItem(idx,{unit:e.target.value})} placeholder="Unit" style={{...inputStyle,flex:1,minWidth:0,background:"var(--bg-card-solid)"}}/>
              <input value={it.unitPrice||""} onChange={e=>setItem(idx,{unitPrice:e.target.value})} placeholder="Price" style={{...inputStyle,flex:1,minWidth:0,background:"var(--bg-card-solid)"}}/>
            </div>
          </div>
        ))}
        <div style={{fontSize:11,color:"var(--text-secondary)",marginTop:2,marginBottom:10}}>Or just describe it below and enter a total - whichever is quicker.</div>

        {/* Summary + total */}
        <label style={labelStyle}>Description / notes (optional)</label>
        <textarea value={form.summary||""} onChange={e=>upd({summary:e.target.value})} placeholder="e.g. Replacement pump agreed on phone with branch manager" style={{...inputStyle,minHeight:54,resize:"vertical",marginBottom:12,fontFamily:"inherit"}}></textarea>

        <label style={labelStyle}>Agreed total (the phone-quoted price)</label>
        <input value={form.total||""} onChange={e=>upd({total:e.target.value})} placeholder="e.g. £420.00" style={{...inputStyle,marginBottom:16}}/>

        {/* Delivery / collection */}
        <label style={labelStyle}>Delivery or collection</label>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8}}>
          {[["direct","Deliver to site"],["collect","Collection"],["alternative","Alternative address"]].map(([val,lab])=>{
            const active=(form.deliveryMethod||"direct")===val;
            return <button key={val} onClick={()=>upd({deliveryMethod:val})} style={{padding:"7px 13px",borderRadius:"var(--radius-sm)",border:`1px solid ${active?"#15824F":"var(--border)"}`,background:active?"var(--green-light)":"var(--bg-card-solid)",color:active?"var(--green-dark)":"var(--text-secondary)",fontSize:12.5,fontWeight:active?700:500,cursor:"pointer"}}>{lab}</button>;
          })}
        </div>
        {(form.deliveryMethod||"direct")==="direct" && <div style={{fontSize:11.5,color:"var(--text-secondary)",marginBottom:8}}>Delivered to the site address entered above.</div>}
        {form.deliveryMethod==="alternative" && <input value={form.collectFrom||""} onChange={e=>upd({collectFrom:e.target.value})} placeholder="Alternative delivery address" style={{...inputStyle,marginBottom:8}}/>}
        {form.deliveryMethod==="collect" && <input value={form.collectFrom||""} onChange={e=>upd({collectFrom:e.target.value})} placeholder="Collect from (branch / depot)" style={{...inputStyle,marginBottom:8}}/>}
        <label style={labelStyle}>Required by (optional)</label>
        <input type="date" value={form.deliveryDate||""} onChange={e=>upd({deliveryDate:e.target.value})} style={{...inputStyle,marginBottom:18}}/>
        </div>
        <div style={{display:"flex",gap:10,padding:isMobile?"12px 18px":"16px 28px",borderTop:"1px solid var(--border)",background:"var(--bg-card-solid)"}}>
          <button onClick={()=>onSubmit(form)} style={{flex:1,padding:"12px",borderRadius:"var(--radius-md)",border:"none",background:"#15824F",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>Raise PO</button>
          <button onClick={onClose} style={{flex:1,padding:"12px",borderRadius:"var(--radius-md)",border:"1px solid var(--border)",background:"var(--bg-subtle2)",color:"var(--text-primary)",fontSize:14,fontWeight:600,cursor:"pointer"}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// --- Hire modals -------------------------------------------------------------
function HireFormModal({ form, setForm, suppliers, onSubmit, onClose, canViewCosts, onAiFill }) {
  const upd = (patch)=>setForm(f=>({...f,...patch}));
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const runAi = async () => {
    if (!aiText.trim() || !onAiFill) return;
    setAiBusy(true);
    try {
      const r = await onAiFill(aiText.trim());
      if (r) upd({ description: r.description||form.description||"", jobRef: r.jobRef||form.jobRef||"", site: r.site||form.site||"", _aiCategory: r.category, _aiMissingDate: r.missingReturnDate });
    } catch {}
    setAiBusy(false);
  };
  const inputStyle = { width:"100%", boxSizing:"border-box", padding:"9px 12px", border:"1px solid var(--border)", borderRadius:"var(--radius-sm)", fontSize:13, outline:"none", background:"var(--bg-card-solid)", color:"var(--text-primary)" };
  const labelStyle = { fontSize:11, fontWeight:700, color:"var(--text-secondary)", textTransform:"uppercase", letterSpacing:"0.04em", marginBottom:5, display:"block" };
  const approved = suppliers.filter(s=>s.tier!=="ad-hoc");
  const adhoc = suppliers.filter(s=>s.tier==="ad-hoc");
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1001,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"20px",overflowY:"auto"}}>
      <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"26px 28px",maxWidth:520,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",margin:"20px 0"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
          <div style={{fontSize:17,fontWeight:700,color:"var(--text-primary)"}}>Raise a hire</div>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:20,color:"var(--text-secondary)",lineHeight:1}}>&times;</button>
        </div>
        <div style={{fontSize:12.5,color:"var(--text-secondary)",marginBottom:14,lineHeight:1.55}}>Add plant or tool hire to the register. It will appear on the hire log so you can track delivery, returns and collection.</div>

        {/* AI quick-fill */}
        <div style={{background:"var(--bg-subtle2)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"10px 12px",marginBottom:16}}>
          <div style={{fontSize:11,fontWeight:700,color:"#15824F",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.04em"}}>Describe it - AI fills the form</div>
          <div style={{display:"flex",gap:6}}>
            <input value={aiText} onChange={e=>setAiText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")runAi();}} placeholder='e.g. "digger for the Elm Street job for 2 weeks"' style={{...inputStyle,flex:1}}/>
            <button onClick={runAi} disabled={aiBusy||!aiText.trim()} style={{padding:"9px 14px",borderRadius:"var(--radius-sm)",border:"none",background:aiBusy||!aiText.trim()?"var(--border)":"#15824F",color:"#fff",fontSize:12.5,fontWeight:700,cursor:aiBusy?"wait":"pointer",whiteSpace:"nowrap"}}>{aiBusy?"...":"AI fill"}</button>
          </div>
          {form._aiMissingDate&&<div style={{fontSize:11,color:"var(--amber)",marginTop:6}}>No return date mentioned - set one below or tick "open hire".</div>}
        </div>

        <label style={labelStyle}>Equipment</label>
        <input value={form.description||""} onChange={e=>upd({description:e.target.value})} placeholder="e.g. 3-tonne excavator, or 2x 110v breakers" style={{...inputStyle,marginBottom:12}}/>

        <label style={labelStyle}>Supplier</label>
        {!form.newSupplier ? (
          <select value={form.supplierId||""} onChange={e=>{ if(e.target.value==="__new__"){upd({newSupplier:true,supplierId:null});} else {upd({supplierId:e.target.value});} }} style={{...inputStyle,marginBottom:12}}>
            <option value="">Select a supplier...</option>
            {approved.length>0&&<optgroup label="Approved suppliers">{approved.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>}
            {adhoc.length>0&&<optgroup label="Ad-hoc suppliers">{adhoc.map(s=><option key={s.id} value={s.id}>{s.name} (ad-hoc)</option>)}</optgroup>}
            <option value="__new__">+ Add a new supplier on the spot</option>
          </select>
        ) : (
          <div style={{marginBottom:12,padding:"12px",border:"1px dashed var(--border)",borderRadius:"var(--radius-sm)",background:"var(--bg-subtle2)"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <span style={{fontSize:12,fontWeight:700,color:"#D97706"}}>New ad-hoc supplier</span>
              <button onClick={()=>upd({newSupplier:false,newSupplierName:"",newSupplierEmail:""})} style={{background:"none",border:"none",color:"var(--text-secondary)",fontSize:12,cursor:"pointer",textDecoration:"underline"}}>pick existing instead</button>
            </div>
            <input value={form.newSupplierName||""} onChange={e=>upd({newSupplierName:e.target.value})} placeholder="Supplier name" style={{...inputStyle,marginBottom:8}}/>
            <input value={form.newSupplierEmail||""} onChange={e=>upd({newSupplierEmail:e.target.value})} placeholder="Email (for off-hire requests)" style={inputStyle}/>
          </div>
        )}

        <div style={{display:"flex",gap:10}}>
          <div style={{flex:1}}><label style={labelStyle}>Job ref</label><input value={form.jobRef||""} onChange={e=>upd({jobRef:e.target.value})} placeholder="e.g. JOB-104" style={inputStyle}/></div>
          <div style={{flex:1}}><label style={labelStyle}>Site</label><input value={form.site||""} onChange={e=>upd({site:e.target.value})} placeholder="Site / address" style={inputStyle}/></div>
        </div>

        {canViewCosts&&(<div style={{marginTop:12}}><label style={labelStyle}>Weekly hire rate (optional)</label><input value={form.weeklyRate||""} onChange={e=>upd({weeklyRate:e.target.value})} placeholder="e.g. £80" style={inputStyle}/></div>)}

        <div style={{display:"flex",gap:10,marginTop:12}}>
          <div style={{flex:1}}><label style={labelStyle}>Expected delivery</label><input type="date" value={form.deliveryDate||""} onChange={e=>upd({deliveryDate:e.target.value})} style={inputStyle}/></div>
          <div style={{flex:1}}><label style={labelStyle}>Return / collection date</label><input type="date" disabled={form.returnOpen} value={form.returnDate||""} onChange={e=>upd({returnDate:e.target.value})} style={{...inputStyle,opacity:form.returnOpen?0.5:1}}/></div>
        </div>
        <label style={{display:"flex",alignItems:"center",gap:8,marginTop:10,marginBottom:18,fontSize:12.5,color:"var(--text-secondary)",cursor:"pointer"}}>
          <input type="checkbox" checked={!!form.returnOpen} onChange={e=>upd({returnOpen:e.target.checked})}/>
          Return date unknown - log as an open hire (you'll be reminded to review it)
        </label>

        <div style={{display:"flex",gap:10}}>
          <button onClick={()=>onSubmit(form)} style={{flex:1,padding:"12px",borderRadius:"var(--radius-md)",border:"none",background:"#15824F",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>Raise hire</button>
          <button onClick={onClose} style={{flex:1,padding:"12px",borderRadius:"var(--radius-md)",border:"1px solid var(--border)",background:"var(--bg-subtle2)",color:"var(--text-primary)",fontSize:14,fontWeight:600,cursor:"pointer"}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function DeliverModal({ data, onSubmit, onClose }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const pick = (f) => { setFile(f); if(f) setPreview(URL.createObjectURL(f)); };
  const inputStyle = { width:"100%", boxSizing:"border-box", padding:"9px 12px", border:"1px solid var(--border)", borderRadius:"var(--radius-sm)", fontSize:13, outline:"none", background:"var(--bg-card-solid)", color:"var(--text-primary)" };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1001,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"26px 28px",maxWidth:440,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
        <div style={{fontSize:17,fontWeight:700,marginBottom:6,color:"var(--text-primary)"}}>Mark as delivered</div>
        <div style={{fontSize:12.5,color:"var(--text-secondary)",marginBottom:16,lineHeight:1.55}}>Take or attach a photo of how the equipment was delivered. This protects you if anything is missing or damaged.</div>
        <label style={{display:"block",border:"1px dashed var(--border)",borderRadius:"var(--radius-sm)",padding:preview?8:"22px 12px",textAlign:"center",cursor:"pointer",marginBottom:12,background:"var(--bg-subtle2)"}}>
          {preview ? <img src={preview} alt="preview" style={{maxWidth:"100%",maxHeight:200,borderRadius:6}}/> : <span style={{fontSize:13,color:"var(--text-secondary)"}}>Tap to take / choose a photo</span>}
          <input type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={e=>pick(e.target.files?.[0]||null)}/>
        </label>
        <textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Any issues on arrival? (optional)" style={{...inputStyle,minHeight:50,resize:"vertical",marginBottom:16,fontFamily:"inherit"}}></textarea>
        <div style={{display:"flex",gap:10}}>
          <button disabled={busy} onClick={async()=>{ setBusy(true); try { await onSubmit(file,note); } finally { setBusy(false); } }} style={{flex:1,padding:"12px",borderRadius:"var(--radius-md)",border:"none",background:"#15824F",color:"#fff",fontSize:14,fontWeight:700,cursor:busy?"wait":"pointer",opacity:busy?0.7:1}}>{busy?"Saving...":"Confirm delivered"}</button>
          <button disabled={busy} onClick={onClose} style={{flex:1,padding:"12px",borderRadius:"var(--radius-md)",border:"1px solid var(--border)",background:"var(--bg-subtle2)",color:"var(--text-primary)",fontSize:14,fontWeight:600,cursor:"pointer"}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function OffHireModal({ data, hire, onSubmit, onClose }) {
  const [date, setDate] = useState("");
  const [addr, setAddr] = useState(hire?.site||"");
  const [busy, setBusy] = useState(false);
  const inputStyle = { width:"100%", boxSizing:"border-box", padding:"9px 12px", border:"1px solid var(--border)", borderRadius:"var(--radius-sm)", fontSize:13, outline:"none", background:"var(--bg-card-solid)", color:"var(--text-primary)" };
  const labelStyle = { fontSize:11, fontWeight:700, color:"var(--text-secondary)", textTransform:"uppercase", letterSpacing:"0.04em", marginBottom:5, display:"block" };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1001,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"26px 28px",maxWidth:440,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
        <div style={{fontSize:17,fontWeight:700,marginBottom:6,color:"var(--text-primary)"}}>Off-hire &amp; request collection</div>
        <div style={{fontSize:12.5,color:"var(--text-secondary)",marginBottom:16,lineHeight:1.55}}>This emails {hire?.supplier||"the supplier"} to collect the equipment. Give them a date and the collection address.</div>
        <label style={labelStyle}>Collection date required</label>
        <input type="date" value={date} onChange={e=>setDate(e.target.value)} style={{...inputStyle,marginBottom:12}}/>
        <label style={labelStyle}>Collection address</label>
        <textarea value={addr} onChange={e=>setAddr(e.target.value)} placeholder="Where should they collect from?" style={{...inputStyle,minHeight:50,resize:"vertical",marginBottom:16,fontFamily:"inherit"}}></textarea>
        <div style={{display:"flex",gap:10}}>
          <button disabled={busy} onClick={async()=>{ setBusy(true); try { await onSubmit(date,addr); } finally { setBusy(false); } }} style={{flex:1,padding:"12px",borderRadius:"var(--radius-md)",border:"none",background:"var(--amber)",color:"#fff",fontSize:14,fontWeight:700,cursor:busy?"wait":"pointer",opacity:busy?0.7:1}}>{busy?"Sending...":"Request collection"}</button>
          <button disabled={busy} onClick={onClose} style={{flex:1,padding:"12px",borderRadius:"var(--radius-md)",border:"1px solid var(--border)",background:"var(--bg-subtle2)",color:"var(--text-primary)",fontSize:14,fontWeight:600,cursor:"pointer"}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ExtendModal({ current, onSubmit, onClose }) {
  const [date, setDate] = useState(current||"");
  const inputStyle = { width:"100%", boxSizing:"border-box", padding:"9px 12px", border:"1px solid var(--border)", borderRadius:"var(--radius-sm)", fontSize:13, outline:"none", background:"var(--bg-card-solid)", color:"var(--text-primary)" };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1001,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"26px 28px",maxWidth:380,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
        <div style={{fontSize:17,fontWeight:700,marginBottom:6,color:"var(--text-primary)"}}>Extend hire</div>
        <div style={{fontSize:12.5,color:"var(--text-secondary)",marginBottom:16,lineHeight:1.55}}>Set the new expected return / collection date for this equipment.</div>
        <input type="date" value={date} onChange={e=>setDate(e.target.value)} style={{...inputStyle,marginBottom:16}}/>
        <div style={{display:"flex",gap:10}}>
          <button onClick={()=>onSubmit(date)} style={{flex:1,padding:"12px",borderRadius:"var(--radius-md)",border:"none",background:"#15824F",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>Save</button>
          <button onClick={onClose} style={{flex:1,padding:"12px",borderRadius:"var(--radius-md)",border:"1px solid var(--border)",background:"var(--bg-subtle2)",color:"var(--text-primary)",fontSize:14,fontWeight:600,cursor:"pointer"}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function CloseHireModal({ onSubmit, onClose }) {
  const [ref, setRef] = useState("");
  const inputStyle = { width:"100%", boxSizing:"border-box", padding:"9px 12px", border:"1px solid var(--border)", borderRadius:"var(--radius-sm)", fontSize:13, outline:"none", background:"var(--bg-card-solid)", color:"var(--text-primary)" };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1001,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"26px 28px",maxWidth:400,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
        <div style={{fontSize:17,fontWeight:700,marginBottom:6,color:"var(--text-primary)"}}>Close hire</div>
        <div style={{fontSize:12.5,color:"var(--text-secondary)",marginBottom:16,lineHeight:1.55}}>Once collected, enter the supplier's collection / off-hire reference number to close this hire and stop the clock.</div>
        <input value={ref} onChange={e=>setRef(e.target.value)} placeholder="Collection / off-hire reference" style={{...inputStyle,marginBottom:16}}/>
        <div style={{display:"flex",gap:10}}>
          <button onClick={()=>onSubmit(ref)} style={{flex:1,padding:"12px",borderRadius:"var(--radius-md)",border:"none",background:"#15824F",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>Close hire</button>
          <button onClick={onClose} style={{flex:1,padding:"12px",borderRadius:"var(--radius-md)",border:"1px solid var(--border)",background:"var(--bg-subtle2)",color:"var(--text-primary)",fontSize:14,fontWeight:600,cursor:"pointer"}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// --- Auth gate + login screen ------------------------------------------------
// Rich signature editor: paste a formatted signature (e.g. from Outlook) and it
// keeps the formatting. Stores cleaned HTML. Handles images and warns on the one
// case that can't carry across (Outlook's embedded cid: images).
function SignatureEditor({ value, onChange }) {
  const ref = useRef(null);
  const [warn, setWarn] = useState("");
  const [empty, setEmpty] = useState(!((value||"").trim()));

  // Seed the editable area when it's not being actively edited (avoids cursor jumps).
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current && ref.current.innerHTML !== (value||"")) {
      ref.current.innerHTML = value || "";
      setEmpty(!((value||"").trim()));
    }
  }, [value]);

  // Strip anything unsafe/unwanted but KEEP formatting, colours, links and images.
  const clean = (html) => {
    const div = document.createElement("div");
    div.innerHTML = html;
    div.querySelectorAll("script,style,meta,link,title,head,o\\:p").forEach(n=>n.remove());
    let brokenImg = false;
    div.querySelectorAll("img").forEach(img => {
      const src = img.getAttribute("src") || "";
      // cid: images are Outlook-embedded - they only exist inside that email.
      if (src.startsWith("cid:") || src.startsWith("file:")) { img.remove(); brokenImg = true; return; }
      // Stop oversized logos overflowing the box / email - cap display width, keep ratio.
      img.removeAttribute("width");
      img.removeAttribute("height");
      const existing = img.getAttribute("style") || "";
      img.setAttribute("style", `${existing};max-width:220px;height:auto`);
    });
    div.querySelectorAll("*").forEach(el => {
      // Remove event handlers and class/id noise; keep inline style.
      [...el.attributes].forEach(a => {
        if (/^on/i.test(a.name) || a.name === "class" || a.name === "id") el.removeAttribute(a.name);
      });
      // Outlook signatures use fixed-width tables/cells that overflow narrow boxes.
      // Strip hard widths so the signature flows to fit wherever it's shown.
      const tag = el.tagName.toLowerCase();
      if (tag === "table" || tag === "td" || tag === "tr" || tag === "div") {
        el.removeAttribute("width");
        let st = el.getAttribute("style") || "";
        st = st.replace(/(^|;)\s*(min-)?width\s*:[^;]+/gi, "");
        st = st.replace(/(^|;)\s*max-width\s*:[^;]+/gi, "");
        if (tag === "table") st += ";max-width:100%;width:auto";
        el.setAttribute("style", st);
      }
    });
    return { html: div.innerHTML, brokenImg };
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (html) {
      const { html: cleaned, brokenImg } = clean(html);
      document.execCommand("insertHTML", false, cleaned);
      setWarn(brokenImg ? "Your signature's logo couldn't be carried across (Outlook embeds it inside the email). Use the Company logo upload above, or a signature whose logo is a web link." : "");
    } else {
      document.execCommand("insertText", false, text);
    }
    sync();
  };

  const sync = () => {
    if (!ref.current) return;
    const html = ref.current.innerHTML;
    setEmpty(!ref.current.textContent.trim() && !ref.current.querySelector("img"));
    // Guard against a huge embedded (base64) logo bloating saved settings.
    if (html.length > 200000) {
      setWarn("That signature is very large (likely a big embedded logo). It may slow syncing - consider using the Company logo upload above and a text-only signature here.");
    }
    onChange(html);
  };

  return (
    <div>
      <div style={{position:"relative"}}>
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          onPaste={handlePaste}
          onInput={sync}
          onBlur={sync}
          style={{minHeight:90,height:"auto",overflowX:"hidden",width:"100%",boxSizing:"border-box",padding:"10px 12px",border:"1px solid #d8d8d0",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",background:"#ffffff",color:"#1a1a17",lineHeight:1.5,wordBreak:"break-word"}}
        />
        {empty&&(
          <div style={{position:"absolute",top:10,left:13,fontSize:13,color:"#9a9a90",pointerEvents:"none"}}>
            Paste your signature here (copy it straight from Outlook or Gmail)
          </div>
        )}
      </div>
      <div style={{fontSize:10.5,color:"var(--text-muted)",marginTop:6,lineHeight:1.4}}>Shown on white &mdash; exactly how it appears at the bottom of your emails.</div>
      {warn && <div style={{fontSize:11,color:"var(--amber)",marginTop:6,lineHeight:1.5}}>{warn}</div>}
      {!empty && (
        <button onClick={()=>{ if(ref.current) ref.current.innerHTML=""; onChange(""); setEmpty(true); setWarn(""); }}
          style={{fontSize:11,color:"var(--red)",background:"var(--red-light)",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer",marginTop:8}}>
          Clear signature
        </button>
      )}
    </div>
  );
}

function LoginScreen({ onLoggedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [screen, setScreen] = useState(INITIAL_WANTS_SIGNUP ? "signup" : "signin"); // signin | signup | sent
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [showForgot, setShowForgot] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  // Shares the same theme setting as the app (piq_dark)
  const [dark, setDark] = useState(()=>{ try{return localStorage.getItem("piq_dark")==="1"}catch{return false} });
  const toggleTheme = () => setDark(p => { const n=!p; try{localStorage.setItem("piq_dark",n?"1":"0")}catch{} return n; });

  // Keep the page background in sync so there are no white edges
  useEffect(() => {
    const bg = dark ? "#0E0E11" : "#0E1512";
    try { document.body.style.background = bg; document.documentElement.style.background = bg; } catch {}
  }, [dark]);

  const openForgot = () => { setShowForgot(true); setResetEmail(email); setMsg(""); };
  const sendReset = async () => {
    const em = resetEmail.trim();
    if (!em) { setMsg("Enter your email address first."); return; }
    setResetBusy(true); setMsg("");
    try {
      await supabase.auth.resetPasswordForEmail(em, { redirectTo: window.location.origin });
      setMsg("If that email has an account, a reset link is on its way. Check your inbox (and spam).");
      setShowForgot(false);
    } catch (e) { setMsg("Couldn't send a reset link just now - please try again shortly."); }
    finally { setResetBusy(false); }
  };
  const submit = async () => {
    if (!email.trim() || !password) { setMsg("Enter an email and password."); return; }
    setBusy(true); setMsg("");
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) { setMsg(error.message); setBusy(false); return; }
      if (data?.session) { onLoggedIn(data.session); return; }
    } catch (e) { setMsg("Something went wrong. Please try again."); }
    setBusy(false);
  };
  // Self-serve company creation. The new user becomes the first Manager of a brand-new,
  // isolated company (resolveCompany bootstraps that on first sign-in). Name + company
  // ride along in user_metadata so the in-app onboarding can pre-fill them.
  const submitSignup = async () => {
    if (!name.trim() || !company.trim()) { setMsg("Enter your name and your company name."); return; }
    if (!email.trim() || !password) { setMsg("Enter an email and a password."); return; }
    if (password.length < 6) { setMsg("Use a password of at least 6 characters."); return; }
    setBusy(true); setMsg("");
    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(), password,
        options: { data: { name: name.trim(), company: company.trim(), is_owner: true }, emailRedirectTo: window.location.origin },
      });
      if (error) { setMsg(error.message); setBusy(false); return; }
      // If email confirmation is ON there's no session yet - point them to their inbox.
      if (data?.session) { onLoggedIn(data.session); return; }
      setScreen("sent");
    } catch (e) { setMsg("Something went wrong. Please try again."); }
    setBusy(false);
  };

  // Theme-aware palette
  const t = dark ? {
    page1:"#0E0E11", page2:"#15211b", card:"#16161A", cardBorder:"rgba(255,255,255,0.08)",
    title:"#F4F4F2", sub:"rgba(255,255,255,0.55)", label:"rgba(255,255,255,0.5)",
    inputBg:"#1C1C22", inputBorder:"rgba(255,255,255,0.12)", inputText:"#F4F4F2",
    orbGreen:"rgba(61,214,140,0.10)", orbIndigo:"rgba(91,91,214,0.08)", markFill:"rgba(61,214,140,0.06)",
    toggleBg:"rgba(255,255,255,0.08)", toggleBorder:"rgba(255,255,255,0.14)", toggleIcon:"#E8E8E8",
  } : {
    page1:"#0E1512", page2:"#15211b", card:"#FFFFFF", cardBorder:"rgba(0,0,0,0.06)",
    title:"#1A1A17", sub:"#5C5B54", label:"#5C5B54",
    inputBg:"#FFFFFF", inputBorder:"#E2E1DA", inputText:"#1A1A17",
    orbGreen:"rgba(30,158,99,0.14)", orbIndigo:"rgba(91,91,214,0.10)", markFill:"rgba(255,255,255,0.05)",
    toggleBg:"rgba(255,255,255,0.10)", toggleBorder:"rgba(255,255,255,0.18)", toggleIcon:"#FFFFFF",
  };

  return (
    <div style={{position:"fixed",inset:0,minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",
      background:`linear-gradient(150deg, ${t.page1} 0%, #101013 55%, ${t.page2} 100%)`,
      padding:"24px",fontFamily:"'Plus Jakarta Sans','Helvetica Neue',sans-serif",overflow:"hidden"}}>

      {/* Ambient background: soft orbs + ProQure mark */}
      <div style={{position:"absolute",inset:0,pointerEvents:"none",overflow:"hidden",zIndex:0}}>
        <div style={{position:"absolute",width:560,height:560,top:-180,right:-120,borderRadius:"50%",filter:"blur(60px)",background:`radial-gradient(circle, ${t.orbGreen}, transparent 70%)`}}/>
        <div style={{position:"absolute",width:480,height:480,bottom:-160,left:-120,borderRadius:"50%",filter:"blur(60px)",background:`radial-gradient(circle, ${t.orbIndigo}, transparent 70%)`}}/>
        <div style={{position:"absolute",width:400,height:400,top:"40%",left:"60%",borderRadius:"50%",filter:"blur(60px)",background:`radial-gradient(circle, ${t.orbGreen}, transparent 70%)`}}/>
        <svg width="600" height="600" viewBox="0 0 20 20" fill="none" style={{position:"absolute",bottom:-150,right:-130,pointerEvents:"none"}} preserveAspectRatio="xMidYMid meet">
          <rect x="3" y="3" width="3" height="14" rx="1.5" fill={t.markFill}/><rect x="6" y="3" width="8" height="3" rx="1.5" fill={t.markFill}/><rect x="14" y="3" width="3" height="8" rx="1.5" fill={t.markFill}/><rect x="6" y="10" width="8" height="3" rx="1.5" fill={t.markFill}/><circle cx="16.5" cy="15.5" r="2" fill={t.markFill}/>
        </svg>
      </div>

      {/* Theme toggle, top-right */}
      <button onClick={toggleTheme} aria-label="Toggle dark mode" title="Toggle dark mode"
        style={{position:"absolute",top:20,right:20,zIndex:2,width:40,height:40,borderRadius:"50%",background:t.toggleBg,border:`1px solid ${t.toggleBorder}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
        {dark
          ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={t.toggleIcon} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={t.toggleIcon} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>}
      </button>

      {/* Card */}
      <div style={{position:"relative",zIndex:1,width:"100%",maxWidth:380,background:t.card,border:`1px solid ${t.cardBorder}`,borderRadius:20,padding:"34px 30px",boxShadow:"0 20px 60px rgba(0,0,0,0.35)"}}>
        <div style={{display:"flex",alignItems:"center",gap:11,marginBottom:24}}>
          <div style={{width:42,height:42,borderRadius:12,background:"linear-gradient(135deg,#1E9E63,#15824F)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <svg width="24" height="24" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="3" height="14" rx="1.5" fill="white"/><rect x="6" y="3" width="8" height="3" rx="1.5" fill="white"/><rect x="14" y="3" width="3" height="8" rx="1.5" fill="white"/><rect x="6" y="10" width="8" height="3" rx="1.5" fill="rgba(255,255,255,0.45)"/><circle cx="16.5" cy="15.5" r="2" fill="white"/></svg>
          </div>
          <span style={{fontSize:22,fontWeight:800,color:t.title,letterSpacing:"-0.02em"}}>Pro<span style={{color:dark?"#3DD68C":"#15824F"}}>Qure</span></span>
        </div>
        <div style={{fontSize:18,fontWeight:800,color:t.title,marginBottom:4}}>{screen==="signup"?"Set up your company":screen==="sent"?"Check your email":"Welcome back"}</div>
        <div style={{fontSize:13,color:t.sub,marginBottom:20}}>{screen==="signup"?"Create your ProQure workspace - it only takes a minute.":screen==="sent"?"One quick step to verify it's you.":"Sign in to access your procurement dashboard."}</div>

        {screen === "sent" ? (
          <div>
            <div style={{fontSize:13.5,color:t.sub,lineHeight:1.6,marginBottom:18}}>
              We&rsquo;ve sent a confirmation link to <strong style={{color:t.title}}>{email.trim()||"your email"}</strong>. Open it to verify your account, then come back here and sign in to finish setting up your company.
            </div>
            {msg && <div style={{fontSize:12.5,color:"#9A5B16",background:"#FFF7ED",border:"1px solid #FED7AA",borderRadius:8,padding:"9px 12px",marginBottom:14}}>{msg}</div>}
            <button onClick={()=>{ setScreen("signin"); setMsg(""); setPassword(""); }}
              style={{width:"100%",padding:"12px",background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer"}}>
              Back to sign in
            </button>
          </div>
        ) : (<>
        {screen === "signup" && (<>
          <label style={{fontSize:11,fontWeight:600,color:t.label,textTransform:"uppercase",letterSpacing:"0.05em",display:"block",marginBottom:6}}>Your name</label>
          <input type="text" value={name} onChange={e=>setName(e.target.value)} autoComplete="name" placeholder="Jane Smith"
            style={{width:"100%",boxSizing:"border-box",padding:"11px 13px",border:`1px solid ${t.inputBorder}`,background:t.inputBg,color:t.inputText,borderRadius:10,fontSize:14,marginBottom:14,outline:"none"}}/>
          <label style={{fontSize:11,fontWeight:600,color:t.label,textTransform:"uppercase",letterSpacing:"0.05em",display:"block",marginBottom:6}}>Company name</label>
          <input type="text" value={company} onChange={e=>setCompany(e.target.value)} autoComplete="organization" placeholder="Your company Ltd"
            style={{width:"100%",boxSizing:"border-box",padding:"11px 13px",border:`1px solid ${t.inputBorder}`,background:t.inputBg,color:t.inputText,borderRadius:10,fontSize:14,marginBottom:14,outline:"none"}}/>
        </>)}

        <label style={{fontSize:11,fontWeight:600,color:t.label,textTransform:"uppercase",letterSpacing:"0.05em",display:"block",marginBottom:6}}>Email</label>
        <input type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" placeholder="you@company.co.uk"
          style={{width:"100%",boxSizing:"border-box",padding:"11px 13px",border:`1px solid ${t.inputBorder}`,background:t.inputBg,color:t.inputText,borderRadius:10,fontSize:14,marginBottom:14,outline:"none"}}/>

        <label style={{fontSize:11,fontWeight:600,color:t.label,textTransform:"uppercase",letterSpacing:"0.05em",display:"block",marginBottom:6}}>Password</label>
        <input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete={screen==="signup"?"new-password":"current-password"} placeholder={screen==="signup"?"Create a password":"Your password"}
          onKeyDown={e=>{ if(e.key==="Enter") (screen==="signup"?submitSignup:submit)(); }}
          style={{width:"100%",boxSizing:"border-box",padding:"11px 13px",border:`1px solid ${t.inputBorder}`,background:t.inputBg,color:t.inputText,borderRadius:10,fontSize:14,marginBottom:18,outline:"none"}}/>

        {msg && <div style={{fontSize:12.5,color:"#9A5B16",background:"#FFF7ED",border:"1px solid #FED7AA",borderRadius:8,padding:"9px 12px",marginBottom:14}}>{msg}</div>}

        <button onClick={screen==="signup"?submitSignup:submit} disabled={busy}
          style={{width:"100%",padding:"12px",background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:busy?"default":"pointer",opacity:busy?0.7:1,marginBottom:14}}>
          {busy ? "Please wait..." : (screen==="signup"?"Create company":"Sign in")}
        </button>
        {screen==="signin" && !showForgot && (
          <div style={{textAlign:"center",marginBottom:12}}>
            <button onClick={openForgot} style={{background:"none",border:"none",color:dark?"#3DD68C":"#15824F",fontWeight:600,cursor:"pointer",fontSize:12.5}}>Forgot password?</button>
          </div>
        )}
        {showForgot && (
          <div style={{marginTop:4,marginBottom:14,padding:"14px",border:`1px solid ${t.inputBorder}`,borderRadius:12,background:t.inputBg}}>
            <div style={{fontSize:13,fontWeight:700,color:t.title,marginBottom:4}}>Reset your password</div>
            <div style={{fontSize:12,color:t.sub,marginBottom:10,lineHeight:1.5}}>Enter your email and we&rsquo;ll send you a link to set a new password.</div>
            <input type="email" value={resetEmail} onChange={e=>setResetEmail(e.target.value)} autoComplete="email" placeholder="you@company.co.uk"
              onKeyDown={e=>{ if(e.key==="Enter") sendReset(); }}
              style={{width:"100%",boxSizing:"border-box",padding:"11px 13px",border:`1px solid ${t.inputBorder}`,background:t.card,color:t.inputText,borderRadius:10,fontSize:14,marginBottom:10,outline:"none"}}/>
            <button onClick={sendReset} disabled={resetBusy}
              style={{width:"100%",padding:"11px",background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:10,fontSize:13.5,fontWeight:700,cursor:resetBusy?"default":"pointer",opacity:resetBusy?0.7:1,marginBottom:8}}>
              {resetBusy?"Sending...":"Send reset link"}
            </button>
            <div style={{textAlign:"center"}}>
              <button onClick={()=>{ setShowForgot(false); setMsg(""); }} style={{background:"none",border:"none",color:t.sub,fontWeight:600,cursor:"pointer",fontSize:12}}>Cancel</button>
            </div>
          </div>
        )}

        {screen==="signup" ? (
          <div style={{textAlign:"center",fontSize:12.5,color:t.sub}}>
            Already have an account?{" "}
            <button onClick={()=>{ setScreen("signin"); setMsg(""); }} style={{background:"none",border:"none",color:dark?"#3DD68C":"#15824F",fontWeight:700,cursor:"pointer",fontSize:12.5}}>Sign in</button>
          </div>
        ) : (
          <div style={{textAlign:"center",fontSize:12,color:t.sub,lineHeight:1.6}}>
            <div>Invited to an existing company? Use the link in your email to set a password.</div>
          </div>
        )}
        </>)}
      </div>
    </div>
  );
}

function CompanyOnboarding({ session, initial, onComplete }) {
  const meta = (session && session.user && session.user.user_metadata) || {};
  const [f, setF] = useState({
    company: (initial && initial.company) || meta.company || "",
    contactName: (initial && initial.contactName) || meta.name || "",
    phone: (initial && initial.phone) || "",
    primaryTrade: (initial && initial.primaryTrade) || "",
    teamSize: (initial && initial.teamSize) || "business",
    companyAddress: (initial && initial.companyAddress) || "",
    fromEmail: (initial && initial.fromEmail) || (session && session.user && session.user.email) || "",
    vat: (initial && initial.vat) || "",
    companyReg: (initial && initial.companyReg) || "",
  });
  const [err, setErr] = useState("");
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const TRADES = ["Plumbing", "Heating & HVAC", "Electrical", "Mechanical", "Building / General", "Other"];
  const finish = () => {
    if (!f.company.trim()) { setErr("Your company name is needed to set up the workspace."); return; }
    onComplete({ ...f, company: f.company.trim(), contactName: f.contactName.trim(), plan: "trial", onboarded: true });
  };
  const inputStyle = { width: "100%", boxSizing: "border-box", padding: "10px 12px", border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--text-primary)", borderRadius: "var(--radius-sm)", fontSize: 14, outline: "none" };
  const labelStyle = { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 5, marginTop: 12 };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(20,20,18,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "var(--bg-card-solid)", borderRadius: "var(--radius-lg)", padding: "28px 30px", maxWidth: 480, width: "100%", maxHeight: "88vh", overflowY: "auto", boxShadow: "var(--shadow-lg)", border: "1px solid var(--border)", animation: "scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 6 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "linear-gradient(135deg,var(--green),var(--green-dark))", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Icon name="rocket" size={22} color="white" />
          </div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>Welcome to ProQure</div>
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>A few details to set up your company workspace.</div>
          </div>
        </div>

        <label style={labelStyle}>Company name</label>
        <input style={inputStyle} value={f.company} onChange={e => set("company", e.target.value)} placeholder="Your company Ltd" />
        <label style={labelStyle}>Your name</label>
        <input style={inputStyle} value={f.contactName} onChange={e => set("contactName", e.target.value)} placeholder="Jane Smith" />
        <label style={labelStyle}>Phone (optional)</label>
        <input style={inputStyle} value={f.phone} onChange={e => set("phone", e.target.value)} placeholder="01234 567890" />
        <label style={labelStyle}>Primary trade</label>
        <select style={inputStyle} value={f.primaryTrade} onChange={e => set("primaryTrade", e.target.value)}>
          <option value="">Select a trade...</option>
          {TRADES.map(tr => <option key={tr} value={tr}>{tr}</option>)}
        </select>
        <label style={labelStyle}>Team size</label>
        <div style={{ display: "flex", gap: 8 }}>
          {[["solo", "Just me"], ["business", "A team"]].map(([v, l]) => (
            <button key={v} onClick={() => set("teamSize", v)} style={{ flex: 1, padding: "9px", borderRadius: "var(--radius-sm)", border: `1px solid ${f.teamSize === v ? "var(--green-dark)" : "var(--border)"}`, background: f.teamSize === v ? "var(--green-mint)" : "var(--bg-card-solid)", color: f.teamSize === v ? "var(--green-deep)" : "var(--text-secondary)", fontSize: 13, fontWeight: f.teamSize === v ? 700 : 500, cursor: "pointer" }}>{l}</button>
          ))}
        </div>
        <label style={labelStyle}>Company address (optional)</label>
        <input style={inputStyle} value={f.companyAddress} onChange={e => set("companyAddress", e.target.value)} placeholder="Unit 1, Industrial Estate, Town" />
        <label style={labelStyle}>Email your RFQs &amp; POs reply to (optional)</label>
        <input style={inputStyle} value={f.fromEmail} onChange={e => set("fromEmail", e.target.value)} placeholder="orders@yourcompany.co.uk" />
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>VAT no. (optional)</label>
            <input style={inputStyle} value={f.vat} onChange={e => set("vat", e.target.value)} placeholder="GB123456789" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Company reg. (optional)</label>
            <input style={inputStyle} value={f.companyReg} onChange={e => set("companyReg", e.target.value)} placeholder="12345678" />
          </div>
        </div>

        {err && <div style={{ fontSize: 12.5, color: "#9A5B16", background: "var(--amber-light)", border: "1px solid var(--amber)", borderRadius: 8, padding: "9px 12px", marginTop: 14 }}>{err}</div>}

        <button onClick={finish} style={{ width: "100%", marginTop: 18, padding: "12px", background: "linear-gradient(135deg,#1E9E63,#15824F)", color: "white", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Create my workspace</button>
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", textAlign: "center", marginTop: 10, lineHeight: 1.5 }}>You can change any of this later in Settings &rsaquo; Company.</div>
      </div>
    </div>
  );
}

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error, info) { try { console.error("ProQure error:", error, info); } catch(e){} }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Plus Jakarta Sans',system-ui,sans-serif",background:"#101013",color:"#fff",padding:24}}>
          <div style={{maxWidth:420,textAlign:"center"}}>
            <div style={{fontSize:18,fontWeight:700,marginBottom:10}}>Something went wrong</div>
            <div style={{fontSize:14,color:"rgba(255,255,255,0.7)",lineHeight:1.6,marginBottom:20}}>ProQure hit an unexpected error. Your data is safe in the cloud - reloading usually fixes it.</div>
            <button onClick={()=>window.location.reload()} style={{background:"#15824F",color:"#fff",border:"none",borderRadius:10,padding:"11px 22px",fontSize:14,fontWeight:600,cursor:"pointer"}}>Reload ProQure</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Temporary private-access gate (free pre-launch privacy) ---
// A simple shared site password shown before the login screen, so the public
// cannot see the app while it is in private testing. Set SITE_GATE_PASSWORD
// to "" at launch to disable the gate entirely.
const SITE_GATE_PASSWORD = "TKQM-9XJR-VP4H-WBEB-3FN7";
function SiteGate({ onUnlock }) {
  const [val, setVal] = useState("");
  const [err, setErr] = useState(false);
  const submit = () => {
    if (val === SITE_GATE_PASSWORD) {
      try { sessionStorage.setItem("pq_gate_ok", "1"); } catch {}
      onUnlock();
    } else { setErr(true); }
  };
  const wrap = {position:"fixed",inset:0,minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(150deg,#0E1512,#101013 55%,#15211b)",fontFamily:"'Plus Jakarta Sans',sans-serif",padding:20};
  const card = {background:"#fff",borderRadius:18,padding:"34px 30px",width:"100%",maxWidth:380,boxShadow:"0 24px 60px rgba(0,0,0,0.4)"};
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
          <div style={{width:40,height:40,background:"linear-gradient(135deg,#1E9E63,#15824F)",borderRadius:11,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M4 12h10M4 17h7"/></svg>
          </div>
          <span style={{fontSize:22,fontWeight:800,color:"#101013",letterSpacing:"-0.02em"}}>Pro<span style={{color:"#15824F"}}>Qure</span></span>
        </div>
        <div style={{fontSize:18,fontWeight:800,color:"#101013",marginBottom:4}}>Private preview</div>
        <div style={{fontSize:13,color:"#5C5B54",marginBottom:18,lineHeight:1.5}}>ProQure is currently in private testing. Enter the access password to continue.</div>
        <input
          type="password"
          value={val}
          onChange={e=>{setVal(e.target.value);setErr(false);}}
          onKeyDown={e=>{if(e.key==="Enter")submit();}}
          placeholder="Access password"
          autoFocus
          style={{width:"100%",boxSizing:"border-box",padding:"12px 14px",border:err?"1px solid #C0392B":"1px solid #E2E0D9",borderRadius:10,fontSize:14,marginBottom:err?6:14,outline:"none"}}
        />
        {err && <div style={{fontSize:12,color:"#C0392B",marginBottom:12}}>Incorrect password. Please try again.</div>}
        <button onClick={submit} style={{width:"100%",padding:"12px",background:"#15824F",color:"#fff",border:"none",borderRadius:10,fontSize:15,fontWeight:700,cursor:"pointer"}}>Enter</button>
      </div>
    </div>
  );
}

function SetPassword({ onDone }) {
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState("");
  const save = async () => {
    if (pw.length < 8) { setMsg("Use at least 8 characters."); return; }
    if (pw !== pw2) { setMsg("The two passwords don't match."); return; }
    setBusy(true); setMsg("");
    try {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) { setMsg(error.message); setBusy(false); return; }
      onDone();
    } catch (e) { setMsg("Something went wrong. Please try again."); setBusy(false); }
  };
  const wrap = {position:"fixed",inset:0,minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(150deg,#0E1512,#101013 55%,#15211b)",fontFamily:"'Plus Jakarta Sans',sans-serif",padding:20};
  const card = {background:"#fff",borderRadius:18,padding:"34px 30px",width:"100%",maxWidth:380,boxShadow:"0 24px 60px rgba(0,0,0,0.4)"};
  const inp = {width:"100%",boxSizing:"border-box",padding:"12px 14px",border:"1px solid #E2E0D9",borderRadius:10,fontSize:14,marginBottom:12,outline:"none"};
  return (<div style={wrap}><div style={card}>
    <div style={{fontSize:18,fontWeight:800,color:"#101013",marginBottom:4}}>Set your password</div>
    <div style={{fontSize:13,color:"#5C5B54",marginBottom:18,lineHeight:1.5}}>Choose a password to finish setting up your ProQure account.</div>
    <input type="password" value={pw} onChange={e=>{setPw(e.target.value);setMsg("");}} placeholder="New password (min 8 characters)" autoFocus style={inp}/>
    <input type="password" value={pw2} onChange={e=>{setPw2(e.target.value);setMsg("");}} placeholder="Confirm password" onKeyDown={e=>{if(e.key==="Enter")save();}} style={inp}/>
    {msg && <div style={{fontSize:12.5,color:"#9A5B16",background:"#FFF7ED",border:"1px solid #FED7AA",borderRadius:8,padding:"9px 12px",marginBottom:12}}>{msg}</div>}
    <button onClick={save} disabled={busy} style={{width:"100%",padding:"12px",background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:busy?"default":"pointer",opacity:busy?0.7:1}}>{busy?"Saving...":"Save password & continue"}</button>
  </div></div>);
}

function AppInner() {
  const [session, setSession] = useState(null);
  const [companyId, setCompanyId] = useState(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [checking, setChecking] = useState(true);
  const [ready, setReady] = useState(false);
  const [gateOk, setGateOk] = useState(() => {
    if (!SITE_GATE_PASSWORD) return true;
    // Trial signups (from the website) and anyone on a real auth link skip the gate,
    // so the signup -> email -> onboarding flow works without sharing the access code.
    if (INITIAL_WANTS_SIGNUP || INITIAL_AUTH_CALLBACK) return true;
    try { return sessionStorage.getItem("pq_gate_ok") === "1"; } catch { return false; }
  });

  // On mount, check for an existing session and subscribe to changes
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data?.session || null);
      setChecking(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      // Supabase fires this on tab refocus (token refresh) with the SAME user.
      // Only update session state when the user actually changes, otherwise a
      // harmless refresh would re-trigger cloudPull and remount the app, throwing
      // the user back to the dashboard.
      setSession(prev => {
        const prevId = prev?.user?.id || null;
        const nextId = s?.user?.id || null;
        if (prevId === nextId) return prev; // no real change - keep the same object
        return s || null;
      });
    });
    return () => { active = false; sub?.subscription?.unsubscribe(); };
  }, []);

  // Detect arrival via an invite or password-reset link, so we can prompt for a new password.
  useEffect(() => {
    if (!supabase) return;
    if (/type=(recovery|invite)/.test(INITIAL_HASH)) setNeedPassword(true);
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setNeedPassword(true);
    });
    return () => { sub?.subscription?.unsubscribe(); };
  }, []);

  // When a session appears, pull cloud data into localStorage before showing the app
  useEffect(() => {
    let active = true;
    if (session?.user?.id) {
      setReady(false);
      (async () => {
        const co = await resolveCompany(session);
        const scope = (co && co.companyId) || session.user.id; // fallback: per-user scope
        // Account-aware reset: if the data cached in THIS browser belongs to a different
        // account/company, clear it before loading - so we never display, or push up,
        // another account's data. (Same account => keep any unsynced local changes.)
        try {
          if (localStorage.getItem("piq_scope") !== scope) {
            SYNC_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
            localStorage.setItem("piq_scope", scope);
          }
        } catch (e) {}
        if (active) setCompanyId(scope);
        await cloudPull(scope);
        if (active) setReady(true);
      })();
    } else {
      setReady(false); setCompanyId(null);
    }
    return () => { active = false; };
  }, [session]);

  const loadStyle = {position:"fixed",inset:0,minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(150deg,#0E1512,#101013 55%,#15211b)",color:"rgba(255,255,255,0.85)",fontFamily:"'Plus Jakarta Sans',sans-serif",fontSize:14};
  if (!gateOk) {
    return <SiteGate onUnlock={() => setGateOk(true)} />;
  }
  if (checking) {
    return <div style={loadStyle}>Loading...</div>;
  }
  if (!session) return <LoginScreen onLoggedIn={setSession} />;
  if (needPassword) return <SetPassword onDone={() => { setNeedPassword(false); try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {} }} />;
  if (!ready) {
    return <div style={loadStyle}>Syncing your data...</div>;
  }
  return <ProQureApp session={session} companyId={companyId} />;
}

export default function App() {
  // If cloud isn't configured, run the app exactly as before (browser-only).
  // This branch lives here (before AppInner) so AppInner's hooks are never conditional.
  if (!cloudEnabled) return <ErrorBoundary><ProQureApp session={null} /></ErrorBoundary>;
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}
