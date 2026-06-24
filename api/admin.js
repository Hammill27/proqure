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
// Read the assurance level (aal1 = password only, aal2 = password + MFA) from the
// verified JWT, so privileged actions can require that MFA was actually completed.
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

  // Privileged account actions (inviting teammates, assigning roles) require the
  // caller's session to have actually cleared two-factor (aal2) — the same bar as
  // billing and the admin console. Managers/buyers enrol 2FA at sign-in, so this is
  // normally already met; it stops a stolen password-only (aal1) session from
  // creating accounts or assigning roles.
  const callerAal = tokenAal(token);
  if (callerAal !== "aal2") {
    await writeSecurityEvent(admin, { email: callerEmail, action: "invite-MFA-REQUIRED", detail: "token aal=" + (callerAal || "unknown"), req });
    return res.status(403).json({ error: "Two-factor authentication is required for this action.", code: "mfa_required" });
  }

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

    // Multi-tenancy is intentional: an identity can belong to several companies
    // (e.g. a subcontractor invited by two contractors, or a sole trader later
    // invited elsewhere). The membership write below uses onConflict
    // "company_id,email", so it only ever ADDS this company's membership and can
    // never disturb the person's membership of any other company. No cross-company
    // block is therefore needed or wanted.

    // 1) Register the membership first so that, however they sign in, they land in the
    //    right company with the right role.
    try {
      const { error: mErr } = await admin.from("members").upsert(
        { email, company_id: companyId, role, employment: employment || null },
        { onConflict: "company_id,email" }
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

  if (action === "remove") {
    // Revoke a member's access. The membership row is the ONLY thing that grants access to
    // a company's data (RLS keys on proqure_member_rank, which reads `members`), so removal
    // MUST delete that row - editing the display list alone leaves full access intact.
    // The caller must be a Manager of the SAME company; we resolve that company from the
    // request and validate it, rather than assuming the caller's first membership (which is
    // wrong for a multi-company identity).
    const email = String(body.email || "").trim().toLowerCase();
    const companyId = String(body.company_id || "").trim();
    if (!email) return res.status(400).json({ error: "No member specified" });
    if (!companyId) return res.status(400).json({ error: "No company specified" });

    // Authorise: the caller must be a Manager of THIS company.
    let actingRole = null;
    try {
      const { data: me } = await admin.from("members").select("role").eq("company_id", companyId).eq("email", callerEmail).maybeSingle();
      actingRole = me && me.role;
    } catch (e) { /* treated as not-a-member below */ }
    if (actingRole !== "manager") {
      await writeSecurityEvent(admin, { email: callerEmail, action: "remove-DENIED", detail: `not a manager of ${companyId}`, req });
      return res.status(403).json({ error: "Only a Manager of this company can remove members" });
    }

    // Find the target's membership in this company - we need their user id (to clear their
    // active-company pointer) and their role (for the last-Manager guard).
    let target;
    try {
      const { data: t } = await admin.from("members").select("user_id,role").eq("company_id", companyId).eq("email", email).maybeSingle();
      target = t || null;
    } catch (e) { target = null; }
    if (!target) {
      // Already gone - nothing to revoke. Idempotent success.
      return res.status(200).json({ ok: true, message: "Member is not part of this company." });
    }

    // Last-Manager protection: never leave a company with no Manager.
    if (target.role === "manager") {
      try {
        const { data: mgrs } = await admin.from("members").select("email").eq("company_id", companyId).eq("role", "manager");
        if ((mgrs || []).length <= 1) {
          return res.status(409).json({ error: "There must be at least one Manager. Promote someone else first." });
        }
      } catch (e) { return res.status(500).json({ error: "Could not verify Managers" }); }
    }

    // Revoke: delete the authoritative membership row.
    try {
      const { error: dErr } = await admin.from("members").delete().eq("company_id", companyId).eq("email", email);
      if (dErr) return res.status(500).json({ error: "Could not remove member: " + dErr.message });
    } catch (e) { return res.status(500).json({ error: "Could not remove member" }); }

    // Clear their active-company pointer if it named this company, so they don't try to
    // resume into a tenancy they're no longer in. resolveCompany would re-route them anyway,
    // but this keeps the pointer honest. Scoped by company_id so other selections are untouched.
    if (target.user_id) {
      try {
        await admin.from("active_company").delete().eq("user_id", target.user_id).eq("company_id", companyId);
      } catch (e) { /* non-fatal */ }
    }

    await writeSecurityEvent(admin, { email: callerEmail, action: "remove-member", detail: `${email} from company ${companyId}`, req });
    return res.status(200).json({ ok: true, message: `${email} removed.` });
  }

  return res.status(400).json({ error: "Unknown action" });
}
