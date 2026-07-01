// api/retention-sweep.js — daily data-retention sweep (Vercel Cron).
//
// Permanently deletes usage-telemetry events (proqure_data store_key
// "piq_events:<uid>") older than the retention window from EVERY tenant — including
// dormant accounts that never write again — so the "automatically deleted after 90
// days" commitment in the privacy notice actually holds. Telemetry is also pruned
// client-side on write and filtered on read; this is the backstop that guarantees it.
//
// Touches ONLY the telemetry store. It never reads or deletes orders, quotes,
// requests, suppliers, the business activity log, or any other company data.
//
// Service role (bypasses RLS); secured by CRON_SECRET exactly like notify-sweep /
// notify-digest. Scheduled in vercel.json.
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
// Constant-time secret comparison so the CRON_SECRET can't be recovered by timing
// how long a wrong guess takes (a plain !== leaks a match byte-by-byte).
function secretEq(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;
const RETAIN_DAYS  = 90;
const DAY = 86400000;

export default async function handler(req, res) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!CRON_SECRET) return res.status(500).json({ error: "Sweep not configured (set CRON_SECRET)." });
  if (!secretEq(bearer, CRON_SECRET)) return res.status(401).json({ error: "Unauthorised." });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured." });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const cutoff = Date.now() - RETAIN_DAYS * DAY;
  let rows = 0, changed = 0, removed = 0, emptied = 0;

  try {
    const { data, error } = await admin
      .from("proqure_data").select("user_id,store_key,value").like("store_key", "piq_events:%");
    if (error) return res.status(500).json({ error: error.message });

    for (const r of (data || [])) {
      rows++;
      const arr = Array.isArray(r.value) ? r.value : [];
      const kept = arr.filter(e => e && e.ts && Date.parse(e.ts) >= cutoff);
      if (kept.length === arr.length) continue; // nothing stale in this row
      changed++; removed += (arr.length - kept.length);
      if (kept.length === 0) {
        emptied++;
        await admin.from("proqure_data").delete().eq("user_id", r.user_id).eq("store_key", r.store_key);
      } else {
        await admin.from("proqure_data").upsert(
          { user_id: r.user_id, store_key: r.store_key, value: kept, updated_at: new Date().toISOString() },
          { onConflict: "user_id,store_key" });
      }
    }
    res.status(200).json({ ok: true, retainDays: RETAIN_DAYS, rows, changed, removed, emptied });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || "Retention sweep failed.", rows, changed, removed });
  }
}
