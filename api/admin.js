// Serverless function: privileged account actions that need Supabase's SERVICE ROLE
// key (which must NEVER be exposed to the browser). Currently supports inviting a
// teammate: it verifies the CALLER is a Manager of their own company, sends them an
// invite email, and registers their membership so they join the right company with
// the right role on first sign-in. A caller can only ever invite into their OWN company.
//
// Required Vercel env vars:
//   SUPABASE_URL                  - your project URL (https://xxxx.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY     - service role key (Project Settings > API)
//   APP_URL                       - where invite links land, e.g. https://app.proqure.co.uk
//
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const APP_URL = (process.env.APP_URL || "").trim().replace(/\/+$/, "");

const admin = (SUPABASE_URL && SERVICE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

const ROLE_RANK = { engineer: 1, buyer: 2, manager: 3 };

// --- Security audit (shared shape with the admin console endpoints) -----------
const AUDIT_KEY = "piq_admin_audit";
const SEC_AUDIT_UID = "platform-audit";
const SEC_CAP = 2000;
function clientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.headers["x-real-ip"] || null;
}
function clientUa(req) { return (req.headers["user-agent"] || "").slice(0, 300) || null; }
async function writeSecurityEvent(svc, { email, action, detail, req }) {
  try {
    if (!svc) return;
    const { data } = await svc.from("proqure_data")
      .select("value").eq("user_id", SEC_AUDIT_UID).eq("store_key", AUDIT_KEY).maybeSingle();
    const log = Array.isArray(data && data.value) ? data.value : [];
    log.push({ ts: new Date().toISOString(), actor: (email || "").toLowerCase(), action,
      target: null, detail: detail || null, ip: clientIp(req), ua: clientUa(req) });
    await svc.from("proqure_data").upsert(
      { user_id: SEC_AUDIT_UID, store_key: AUDIT_KEY, value: log.slice(-SEC_CAP), updated_at: new Date().toISOString() },
      { onConflict: "user_id,store_key" });
  } catch { /* never block on logging */ }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!admin) return res.status(500).json({ error: "Admin not configured (missing SUPABASE_URL / SERVICE_ROLE key)" });

  // The caller must present their Supabase access token so we can verify who they are.
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Not signed in" });

  let caller;
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Invalid session" });
    caller = data.user;
  } catch (e) { return res.status(401).json({ error: "Invalid session" }); }

  const callerEmail = (caller.email || "").toLowerCase();

  // Look up the caller's membership (company + role).
  let callerCompany = null, callerRole = null;
  try {
    const { data: rows } = await admin.from("members").select("company_id,role").eq("email", callerEmail).limit(1);
    if (rows && rows.length) { callerCompany = rows[0].company_id; callerRole = rows[0].role; }
  } catch (e) { /* ignore */ }
  // A brand-new manager bootstrapping their own company: company id = their user id.
  if (!callerCompany) { callerCompany = caller.id; callerRole = callerRole || "manager"; }

  const body = req.body || {};
  const action = body.action || "invite";

  if (action === "invite") {
    const email = String(body.email || "").trim().toLowerCase();
    const role = ["engineer", "buyer", "manager"].includes(body.role) ? body.role : "engineer";
    const employment = body.employment === "internal" ? "internal" : (body.employment === "subcontractor" ? "subcontractor" : "");
    const name = String(body.name || "").trim();
    // A caller can only ever invite into their OWN company.
    const companyId = callerCompany;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
    // Only Managers can create accounts.
    if (callerRole !== "manager") {
      await writeSecurityEvent(admin, { email: callerEmail, action: "invite-DENIED", detail: "caller is not a manager", req });
      return res.status(403).json({ error: "Only a Manager can create accounts" });
    }
    // You cannot grant a role above your own.
    if (ROLE_RANK[role] > ROLE_RANK[callerRole || "engineer"]) {
      await writeSecurityEvent(admin, { email: callerEmail, action: "invite-DENIED", detail: `attempted role ${role} above own level`, req });
      return res.status(403).json({ error: "You can only assign roles up to your own level" });
    }

    // Guard: refuse to reassign an email that already belongs to a DIFFERENT company.
    //    onConflict:"email" would otherwise silently move that person out of their
    //    existing company (a griefing / integrity hazard). A genuine company change
    //    must remove them from the old company first.
    try {
      const { data: existing } = await admin.from("members")
        .select("company_id").eq("email", email).limit(1).maybeSingle();
      if (existing && existing.company_id && existing.company_id !== companyId) {
        return res.status(409).json({ error: "That email already belongs to another company. They must be removed from it before being invited here." });
      }
    } catch (e) { /* lookup failed - fall through; the upsert below still binds them */ }

    // 1) Register the membership first so that, however they sign in, they land in the
    //    right company with the right role.
    try {
      const { error: mErr } = await admin.from("members").upsert(
        { email, company_id: companyId, role, employment: employment || null },
        { onConflict: "email" }
      );
      if (mErr) return res.status(500).json({ error: "Could not save membership: " + mErr.message });
    } catch (e) { return res.status(500).json({ error: "Could not save membership" }); }

    // 2) Send the invite email (creates the auth user in a pending state). If the user
    //    already exists, fall back to a password-reset style email so they can still
    //    get in - the membership above is what binds them to the company either way.
    const redirectTo = APP_URL || undefined;
    try {
      const { error: iErr } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo,
        data: { role, company_id: companyId, name },
      });
      if (iErr) {
        const msg = (iErr.message || "").toLowerCase();
        if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
          // Existing user: send a recovery email so they can set/keep a password and sign in.
          try { await admin.auth.resetPasswordForEmail(email, { redirectTo }); } catch (e) {}
          await writeSecurityEvent(admin, { email: callerEmail, action: "invite-account", detail: `${email} as ${role} (existing user, company ${companyId})`, req });
          return res.status(200).json({ ok: true, note: "existing-user", message: "Account already exists - sent them a sign-in link." });
        }
        return res.status(500).json({ error: "Invite email failed: " + iErr.message });
      }
    } catch (e) { return res.status(500).json({ error: "Invite email failed" }); }

    await writeSecurityEvent(admin, { email: callerEmail, action: "invite-account", detail: `${email} as ${role} (company ${companyId})`, req });
    return res.status(200).json({ ok: true, message: `Invite sent to ${email}` });
  }

  return res.status(400).json({ error: "Unknown action" });
}
