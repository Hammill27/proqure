// api/notify-digest.js — daily email digest (Vercel Cron).
//
// Once a day, gather the last 24h of DIGEST-cadence notifications per company,
// group them by recipient (filtered by role + the user's email preferences via the
// shared policy), and send each eligible user ONE branded digest email. Immediate
// categories (maintenance, billing, system) are emailed at emit time, not here.
//
// Triggered by Vercel Cron (see vercel.json). Protected by CRON_SECRET: Vercel sends
// `Authorization: Bearer <CRON_SECRET>` when that env var is set.
import { createClient } from "@supabase/supabase-js";
import { cadenceOf, emailEligible, canSeeInApp } from "../notify-policy.js";
import { renderNotificationEmail, sendMail } from "./notify-mail.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;
const MAX_COMPANIES = 80;   // per run; raise / paginate as the tenant base grows

export default async function handler(req, res) {
  // Auth: Vercel Cron bearer, or an explicit ?secret= for manual runs. Fail CLOSED —
  // this endpoint sends email, so it must never run unauthenticated. If CRON_SECRET
  // isn't set, refuse rather than expose a publicly-triggerable mail sender.
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const qsecret = (req.query && req.query.secret) || "";
  if (!CRON_SECRET) return res.status(500).json({ error: "Digest not configured (set CRON_SECRET)." });
  if (bearer !== CRON_SECRET && qsecret !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorised." });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured." });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const now = Date.now();
  const since = new Date(now - 24 * 3600 * 1000).toISOString();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

  let companiesProcessed = 0, emailsSent = 0;
  try {
    // Companies with any notification in the window.
    const { data: recent } = await admin.from("notifications")
      .select("company_id").gte("created_at", since);
    const companyIds = [...new Set((recent || []).map(r => r.company_id))].slice(0, MAX_COMPANIES);

    for (const companyId of companyIds) {
      const [{ data: notifs }, { data: members }, { data: anns }] = await Promise.all([
        admin.from("notifications").select("*").eq("company_id", companyId).gte("created_at", since).order("created_at", { ascending: false }),
        admin.from("members").select("email,role,user_id,company_id").eq("company_id", companyId),
        admin.from("announcements").select("*").eq("category", "release").is("recalled_at", null).gte("created_at", since),
      ]);
      // System notifications (the notifications table) have no real-time email path yet,
      // so the daily digest is their ONLY email channel: include everything emailable
      // (immediate + digest), not just digest-cadence — otherwise mandatory billing /
      // system emails would never be delivered. Admin announcements that are "immediate"
      // already emailed at send time and live in the announcements table, so widening
      // this filter can't double-send them.
      const digestNotifs = (notifs || []).filter(n => cadenceOf(n.category) !== "off");
      // Release announcements that target this company and are in-window.
      const inWin = (a) => (!a.starts_at || Date.parse(a.starts_at) <= now) && (!a.ends_at || Date.parse(a.ends_at) >= now);
      const relAnns = (anns || []).filter(a => inWin(a) && (a.target === "all" || (Array.isArray(a.company_ids) && a.company_ids.includes(companyId))))
        .map(a => ({ ...a, _ann: true }));
      const pool = [...digestNotifs, ...relAnns];
      if (!pool.length || !(members || []).length) continue;

      // Per-user state (prefs + last digest).
      const { data: states } = await admin.from("notification_state")
        .select("user_id,company_id,email_prefs,last_digest_at").eq("company_id", companyId);
      const stMap = {}; (states || []).forEach(s => { stMap[s.user_id] = s; });
      companiesProcessed++;

      let companyName = "";
      try { const { data: st } = await admin.from("proqure_data").select("value").eq("user_id", companyId).eq("store_key", "piq_settings").maybeSingle(); companyName = (st && st.value && st.value.company) || ""; } catch (e) {}

      for (const m of members) {
        if (!m.email) continue;
        const state = stMap[m.user_id] || {};
        if (state.last_digest_at && new Date(state.last_digest_at) >= startOfDay) continue; // already digested today
        const prefs = state.email_prefs || {};
        const mine = pool.filter(n => {
          const minRole = n._ann ? n.min_role : null;
          return canSeeInApp(n.category, m.role, minRole) && emailEligible(n.category, m.role, prefs, minRole);
        });
        if (!mine.length) continue;
        const items = mine.slice(0, 20).map(n => ({ type: n.type, title: n.title, body: n.body, cta_label: n.cta_label, cta_href: n.cta_href }));
        const html = renderNotificationEmail({
          heading: `Your ProQure summary`,
          intro: `${items.length} update${items.length === 1 ? "" : "s"} from the last 24 hours.`,
          items, companyName,
        });
        const r = await sendMail({ to: m.email, subject: "ProQure \u2014 your daily summary", html, companyId });
        if (r.ok) emailsSent++;
        try {
          await admin.from("notification_state").upsert(
            { user_id: m.user_id, company_id: companyId, last_digest_at: new Date().toISOString() },
            { onConflict: "user_id,company_id" });
        } catch (e) {}
      }
    }
    res.status(200).json({ ok: true, companiesProcessed, emailsSent });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || "Digest failed.", companiesProcessed, emailsSent });
  }
}
