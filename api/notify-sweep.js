// api/notify-sweep.js — daily operational sweep (Vercel Cron).
//
// Scans every company's live hires and purchase orders and emits "workflow"
// notifications for time-based events that have no single trigger moment:
//   • a hire is overdue back (you're liable while it's on site)
//   • a hire is due back within 7 days
//   • a sent/confirmed PO is past its expected delivery and not yet delivered
//
// Server-side via proqure_notify (service role -> bypasses RLS); category
// "workflow" so buyers + managers see it. IDEMPOTENT: each dedupe key includes the
// relevant date, so an item alerts ONCE and only re-alerts if that date changes —
// it never nags daily, and the in-app red flag persists regardless.
//
// Scheduled an hour before the digest (vercel.json) so a morning's overdue items
// are already present and roll into that day's digest email.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;
const MAX_COMPANIES = 200;       // per run; paginate as the tenant base grows
const DAY = 86400000;
// PO statuses that mean "sent to the supplier and awaiting delivery". Deliberately
// conservative (excludes drafts / not-yet-sent) so we never raise a false overdue.
const PO_AWAITING = ["sent", "confirmed"];

const fmt = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long" });

function workflowArgs(company, n) {
  return {
    p_company: company, p_type: n.type, p_category: "workflow",
    p_title: n.title, p_body: n.body, p_dedupe: n.dedupe,
    p_cta_label: "Open ProQure", p_cta_href: "https://app.proqure.co.uk",
    p_meta: n.meta || {},
  };
}

export default async function handler(req, res) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!CRON_SECRET) return res.status(500).json({ error: "Sweep not configured (set CRON_SECRET)." });
  if (bearer !== CRON_SECRET) return res.status(401).json({ error: "Unauthorised." });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured." });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const now = Date.now();
  let companies = 0, emitted = 0;

  try {
    const [{ data: hireRows }, { data: orderRows }] = await Promise.all([
      admin.from("proqure_data").select("user_id,value").eq("store_key", "piq_hires"),
      admin.from("proqure_data").select("user_id,value").eq("store_key", "piq_orders"),
    ]);

    const byCo = {};
    for (const r of (hireRows || []))  (byCo[r.user_id] = byCo[r.user_id] || {}).hires  = Array.isArray(r.value) ? r.value : [];
    for (const r of (orderRows || [])) (byCo[r.user_id] = byCo[r.user_id] || {}).orders = Array.isArray(r.value) ? r.value : [];

    for (const company of Object.keys(byCo).slice(0, MAX_COMPANIES)) {
      const { hires = [], orders = [] } = byCo[company];
      const calls = [];

      for (const h of hires) {
        if (h.status !== "on-hire" || h.returnOpen || !h.returnDate) continue;
        const due = Date.parse(h.returnDate); if (isNaN(due)) continue;
        const day10 = new Date(due).toISOString().slice(0, 10);
        const label = h.description || "Hired equipment";
        if (due < now) {
          calls.push(workflowArgs(company, {
            type: "warning", title: `Hire overdue: ${label}`,
            body: `This hire was due back on ${fmt(due)}. You're liable while it's on site \u2014 off-hire or extend it.`,
            dedupe: `workflow:hire-overdue:${h.id}:${day10}`, meta: { kind: "hire-overdue", hireId: h.id },
          }));
        } else if (due - now <= 7 * DAY) {
          calls.push(workflowArgs(company, {
            type: "info", title: `Hire due back soon: ${label}`,
            body: `Due back on ${fmt(due)}. Off-hire or extend it before then.`,
            dedupe: `workflow:hire-due:${h.id}:${day10}`, meta: { kind: "hire-due-soon", hireId: h.id },
          }));
        }
      }

      for (const o of orders) {
        if (!PO_AWAITING.includes(o.status) || !o.expectedDelivery) continue;
        const due = Date.parse(o.expectedDelivery); if (isNaN(due) || due >= now) continue;
        const day10 = new Date(due).toISOString().slice(0, 10);
        const ref = o.id || o.poNumber || "po";
        calls.push(workflowArgs(company, {
          type: "warning", title: `Delivery overdue${o.poNumber ? `: ${o.poNumber}` : ""}`,
          body: `${o.supplier ? o.supplier + " \u2014 " : ""}expected ${fmt(due)} and not marked delivered yet.`,
          dedupe: `workflow:po-overdue:${ref}:${day10}`, meta: { kind: "po-overdue", orderId: ref },
        }));
      }

      if (!calls.length) continue;
      companies++;
      for (let i = 0; i < calls.length; i += 10) {
        await Promise.all(calls.slice(i, i + 10).map(args =>
          admin.rpc("proqure_notify", args).then(r => { if (!r.error) emitted++; }, () => {})));
      }
    }

    res.status(200).json({ ok: true, companies, emitted });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || "Sweep failed.", companies, emitted });
  }
}
