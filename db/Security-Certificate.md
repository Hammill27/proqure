# ProQure — Security & Infrastructure Certificate

> **Living record.** This is the authoritative, portable account of what has been
> checked, verified, and assumed across ProQure's code, database and third-party
> configuration. It is maintained as evidence arrives. If this work moves to another
> conversation, machine, or developer, **this document is the source of truth** — not
> memory and not code comments (the `plan` incident proved comments can lie).

**Owner:** Jordan Hammill  **Started:** 2026-06-19  **Last updated:** 2026-06-19  **Version:** 1.0 (Phase 1 COMPLETE & version-controlled; Phase 2 next)

### Confidence taxonomy
- **GUARANTEED** — enforced at a layer the client cannot bypass, *with evidence on file* (policy dump, trigger definition, a rejected test write, a dashboard screenshot).
- **DEFENCE-IN-DEPTH** — genuinely helps but is evadable or secondary; not a hard guarantee.
- **IMPLEMENTED (unverified)** — built/deployed, but live enforcement not yet evidenced.
- **UNVERIFIED** — assumed true; no evidence gathered yet.

### How to read an entry
`ID · Item · Status · Confidence · Date · Evidence · Notes`

---

## A. Verified infrastructure facts (evidence on file)

| ID | Fact | Confidence | Date | Evidence |
|----|------|-----------|------|----------|
| INF-1 | Vercel team `jordan-s-projects2` (`team_PWB9SK4cg8ZpgBwxLzcTMCna`) holds 3 projects: `proqure` (app), `proqure-website` (marketing), `initial-mechanical-finished-draft-1` | GUARANTEED | 2026-06-19 | Vercel API `list_projects` |
| INF-2 | App project `prj_VVoapHLjoENF1EdxzEfXc2FOfwMM`: framework **vite**, Node 24.x | GUARANTEED | 2026-06-19 | Vercel API `get_project` |
| INF-3 | App answers on 4 hostnames: `app.proqure.co.uk` + `procureiq-two.vercel.app` + `proqure-jordan-s-projects2.vercel.app` + `proqure-git-main-jordan-s-projects2.vercel.app` | GUARANTEED | 2026-06-19 | Vercel API `get_project` |
| INF-4 | Marketing project `prj_uWDa8YmoZJkFl0MBdxifgOzs92Uy` (`proqure-website`): static (no framework), live on `proqure.co.uk` + `www.proqure.co.uk` | GUARANTEED | 2026-06-19 | Vercel API `get_project` |
| INF-5 | Repo `Hammill27/proqure` (public as of 2026-06-19); app is single-file `procurement-dashboard.jsx`; 15 serverless functions in `api/` | GUARANTEED | 2026-06-19 | Repo clone, commit `1486c8f` |

---

## B. Implemented & verified this session

| ID | Control | Status | Confidence | Date | Evidence | Notes |
|----|---------|--------|-----------|------|----------|-------|
| APP-1 | **Billing-field freeze trigger** (`proqure_billing_guard`) — browser cannot set/change `plan`, `trialEndsAt`, `subscriptionStatus`, `stripeCustomerId`, `renewsAt` in `piq_settings` | Live + body-verified | GUARANTEED (recommend a live client test-write to make airtight) | 2026-06-19 | Query 4 (trigger on INSERT+UPDATE) + F2 (function body); committed `db/proqure_billing_guard.sql` | INSERT forces `plan='trial'` + 14-day window; UPDATE freezes the 5 fields for client roles; service_role/SQL authoritative |
| APP-2 | **Server-side trial-expiry gate** in `api/ai.js` — expired trial → HTTP 402, AI stops | Live (code-confirmed) | GUARANTEED (rests on APP-1) | 2026-06-19 | `api/ai.js` L181–188 (trial 402) + L192 (budget 402); reads server-authoritative `trialEndsAt` | Also enforces monthly `AI_BUDGET` cap per plan |
| APP-3 | **`licence.js` hardening** — honeypot + optional `LICENCE_SIGNUP_KEY` + Turnstile (gated on `TURNSTILE_SECRET_KEY`) + disposable-email block + per-IP throttle | Live (code-confirmed) | DEFENCE-IN-DEPTH | 2026-06-19 | `api/licence.js` | Turnstile inert until secret + widget live (TODO-MK-1 / Phase 7); throttle fail-open — WAF rule is the hard stop |
| DOC-1 | **Architecture Blueprint** (42pp) and **out-of-band checklist** produced | Complete | n/a | 2026-06-19 | `ProQure-Architecture-Blueprint.pdf`, `ProQure-out-of-band-security-checklist.md` | Reference artifacts |
| DOC-2 | **Three DB migrations committed to repo `/db/`** — security model now reproducible from version control | Complete | GUARANTEED | 2026-06-19 | Repo `db/` at commit `1486c8f`; files byte-identical to regenerated source | Closes the root blind spot (TODO-DB-0/9) |

---

## C. Pre-existing controls — now confirmed with evidence

| ID | Control | Confidence | Notes / evidence |
|----|---------|-----------|------------------|
| SEC-1 | Tenant isolation via Postgres RLS on all tenant tables | GUARANTEED | RLS enabled on all 6 public base tables (schema-wide audit); cross-tenant read isolation proven (Phase 1 §G) |
| SEC-2 | `piq_ai_meter` is service-role-write-only | GUARANTEED | RESTRICTIVE policies `piq_ai_meter_no_client_{insert,update,delete}` block client writes (Query F1) |
| SEC-3 | `members` role cannot be self-assigned | GUARANTEED | `proqure_members_guard` + `proqure_guard_member_role` trigger bodies verified (F2) |
| SEC-4 | SECURITY DEFINER functions have pinned `search_path` | GUARANTEED | All definer functions show `SET search_path` (Query 3 / function defs) |
| SEC-5 | Admin endpoints aal2 + allow-list + rate-limit | DEFENCE-IN-DEPTH | Confirmed in code (`admin.js`, `admin-metrics.js`, `admin-health.js` all gate on `aal2`); live env (`ADMIN_CONSOLE_EMAILS`) unconfirmed |
| SEC-6 | Webhooks signature-verified (Stripe `constructEvent`, Resend/inbound Svix) | DEFENCE-IN-DEPTH | Confirmed in code; live secrets unconfirmed (Phase 6 / Phase 4) |
| SEC-7 | All provider secrets server-side only; browser holds anon key + JWT | UNVERIFIED | Confirm no `VITE_`-prefixed secret (Phase 3 / TODO-VC-2) |

---

## D. Open register — blind spots, assumptions & TODO

**The root blind spot is CLOSED.** All three migrations are now in the repo `/db/`
(commit `1486c8f`), regenerated faithfully from the live database. The live security
posture is reviewable and reproducible.

| ID | Action | Priority | Status |
|----|--------|----------|--------|
| TODO-DB-0 | Commit `proqure_security_migration.sql` + `proqure_billing_guard.sql` + `proqure_rpc_lockdown.sql` into the repo (`/db/`) | P0 | **Done — commit `1486c8f`** |
| TODO-DB-1 | Verify RLS enabled + correct on all tenant tables | P0 | **Done — Guaranteed (§G, schema-wide audit)** |
| TODO-DB-2 | Verify `piq_ai_meter` write-lock is live | P0 | **Done — Guaranteed (SEC-2)** |
| TODO-DB-3 | Verify `members` role self-assignment is blocked | P0 | **Done — Guaranteed (SEC-3)** |
| TODO-DB-4 | Verify SECURITY DEFINER `search_path` + RPC grants | P1 | **Done — Guaranteed (SEC-4, P1-C/D)** |
| TODO-DB-5 | Evidence-test the billing trigger (attempt a client `plan` write; confirm neutralised) | P2 | Open (nice-to-have; body already verified) |
| TODO-DB-6 | Decide: freeze `piq_usage.addons` server-side, or accept £-cap backstop | P1 | Open |
| TODO-DB-7 | Run `proqure_rpc_lockdown.sql` + verify grants | P0 | **Done — Guaranteed (post-lockdown grant query)** |
| TODO-DB-8 | Verify `is_platform_admin()` non-forgeable + rank helpers read-only | P0 | **Done — Guaranteed (F3)** |
| TODO-DB-9 | Commit 3 migrations into repo `/db/` | P1 | **Done — commit `1486c8f`, byte-verified** |
| TODO-ADMIN-1 | Protect `proqureadmin@proqure.co.uk` (master tenancy-bypass account): strong unique password + MFA enrolled; reconcile with `ADMIN_CONSOLE_EMAILS` | **P0** | Open (Phase 2 — first task) |
| TODO-SB-1 | Supabase Auth: custom SMTP (not default), redirect allow-list, CAPTCHA, leaked-password, email-confirm, MFA factors | P1 | Open (Phase 2) |
| TODO-SB-2 | Supabase backups / PITR on funded tier; network restrictions | P1 | Open (Phase 2) |
| TODO-VC-1 | Redirect/remove the 3 non-canonical app hostnames (esp. stale `procureiq-two.vercel.app`) | P1 | Open (Phase 3) |
| TODO-VC-2 | Env-var exposure audit (no `VITE_` secret; mark secrets Sensitive) | P0 | Open (Phase 3) |
| TODO-VC-3 | Preview Deployment Protection (previews hit live DB + live secrets) | P1 | Open (Phase 3) |
| TODO-VC-4 | Spend management cap/alert | P1 | Open (Phase 3) |
| TODO-RS-1 | Resend SPF/DKIM/DMARC; webhook secret; inbound MX; plan limits | P1 | Open (Phase 4) |
| TODO-CF-1 | Determine if domain is Cloudflare-proxied; decide single edge owner | P1 | Open (Phase 5) |
| TODO-ST-1 | Stripe webhook secret + event-subscription match; portal config; cancel→downgrade; test→live swap; wire real payment in `licence.js` placeholder | P1 | Open (Phase 6) |
| TODO-MK-1 | Marketing site: Turnstile on signup (+ contact) form; review neglect | P1 | Open (Phase 7) |
| TODO-X-1 | 2FA on GitHub, Vercel, Supabase, Resend, Stripe, Cloudflare, **registrar**; registrar domain-lock | P0 | Open (Phase 8) |
| TODO-X-2 | Secrets-in-git-history scan; rotate anything found | P1 | Open (Phase 8) |
| TODO-X-3 | Break-glass key-rotation runbook | P2 | Open (Phase 8) |
| TODO-P2-1 | **Reconcile overlapping `members` policy sets** (`members_*` vs `proqure_members_*`) and the `proqure_data` permissive sets into one coherent set (P1-F1) | P2 | Open |
| TODO-P2-2 | **Consolidate the two `proqure_ai_meter_add` overloads** (text + uuid) to the single atomic uuid version (P1-F2) | P2 | Open |

---

## E. Human-verification placement (decided 2026-06-19)

| Surface | Decision | Rationale |
|---------|----------|-----------|
| Marketing signup form | Turnstile | Public, unauth, creates accounts + sends mail + (later) payment |
| Marketing contact form (if any) | Turnstile | Public unauth email trigger |
| App login | Supabase Auth CAPTCHA | Credential-stuffing target; protect at the Supabase endpoint, not a bespoke widget |
| Password reset | Supabase Auth CAPTCHA | Email-bomb / enumeration vector |
| Invite (send) | None | Already authenticated + aal2 |
| Invite (accept) | None | Emailed-link possession is the proof |
| Admin console | None | Allow-list + aal2 + rate-limit already stronger than a CAPTCHA |
| `/api/ai`, send-email, billing, webhooks | None | Session/role/signature already gate them |

---

## F. App-layer MFA (aal2) coverage — confirmed in code 2026-06-19

| Endpoint | aal2 enforced? | Notes |
|----------|----------------|-------|
| `api/create-checkout-session.js` | YES | Money endpoint |
| `api/create-portal-session.js` | YES | Money endpoint |
| `api/notifications.js` | YES | |
| `api/admin.js` | YES | Admin |
| `api/admin-metrics.js` | YES | Admin |
| `api/admin-health.js` | YES | Admin |
| `api/ai.js` | NO | Gated by session + role + budget/trial instead |
| `api/send-email.js` | NO | Gated by session + role |

**Decision pending (roadmap "App MFA Phase 2"):** whether to extend aal2 to any
remaining privileged endpoints (obvious candidate: `send-email.js`). Deliberate
boundary, not a gap.

---

## G. Phase 1 — database verification (COMPLETE, 2026-06-19)

**Evidence:** SQL exports run by Jordan (RLS flags, `pg_policies` dump, `pg_proc`
definer/settings, `information_schema.triggers`, RPC grants, full `pg_get_functiondef`
/ `pg_get_triggerdef` DDL, schema-wide RLS audit).

### Verified (GUARANTEED)
| ID | Finding | Evidence |
|----|---------|----------|
| P1-1 | RLS **enabled** on all 6 public base tables (`announcements`, `members`, `notification_state`, `notifications`, `proqure_billing`, `proqure_data`). The 6 are the *complete* base-table set — no untracked tables. | Schema-wide RLS audit |
| P1-2 | **Cross-tenant read isolation** — every SELECT policy requires membership/ownership/admin; no `qual=true` for `authenticated`. | `pg_policies` dump |
| P1-3 | **SECURITY DEFINER `search_path` pinned** on all definer functions. | Function defs |
| P1-4 | **Billing-guard trigger live + body verified** — `trg_proqure_billing_guard` on INSERT+UPDATE; body matches committed file. | Query 4 + F2 |
| P1-5 | `announcements` has **no client write policy** (read-only to clients). | `pg_policies` |
| P1-6 | `notification_state` scoped to `user_id = auth.uid()`. | `pg_policies` |
| P1-A | All lock policies are **RESTRICTIVE** (meter direct-write lock, money-key guard, role-rank guard, notif-rank guard) — they genuinely AND-lock. | Query F1 |
| P1-B | `proqure_members_guard` + `proqure_guard_member_role` reject role escalation; only a manager may assign/change a role; safe owner-bootstrap + invite-accept paths can't alter `role`/`email`. | F2 (bodies) |
| P1-C | `proqure_ai_meter_add` (both overloads) EXECUTE now limited to `postgres` + `service_role`; no `anon`/`authenticated`/PUBLIC. Meter-bypass vector closed. | Post-lockdown grant query |
| P1-D | `proqure_notify` EXECUTE now limited to `postgres` + `service_role`. Notification-injection vector closed. | Post-lockdown grant query |
| P1-E | `is_platform_admin()` compares signed `auth.jwt()->>'email'` to a hardcoded literal — non-forgeable. Rank helpers read the write-guarded `members` table (keyed on `auth.uid()`) or are `IMMUTABLE` pure mappings. No tenancy-bypass or rank-spoof. | F3 |

### Phase 1 sign-off
Tenant isolation (schema-wide RLS), the within-tenant locks (meter / money-keys /
role-rank / notification-rank), role-escalation defence, definer-function hygiene,
the RPC lockdown, and the platform-admin gate are all **GUARANTEED** with evidence on
file. The one hole found (P1-C/D: client-callable definer RPCs) is fixed and verified.
All three migrations are committed to the repo. **Phase 1 is complete — verified and
version-controlled.**

### Phase 1 findings carried forward
| ID | Finding | Confidence | Notes |
|----|---------|-----------|-------|
| ADMIN-1 | **Single platform super-admin** `proqureadmin@proqure.co.uk` bypasses ALL tenancy (`is_platform_admin()` in `proqure_data` + `announcements` policies). The gate is non-forgeable; the **account itself is the master key to every tenant.** | gate: GUARANTEED · account protection: UNVERIFIED | **P0, first task of Phase 2:** strong unique password + MFA on this Supabase auth user. Reconcile/document vs `ADMIN_CONSOLE_EMAILS`. |
| TENANT-EMAIL | **Tenant resolution is email-keyed.** `my_company()` resolves a user's tenant by matching `auth.jwt()->>'email'` against `members`. This makes **Supabase email-confirmation load-bearing for tenant isolation** — if email confirmation is off, someone could sign up under a known invited address and `my_company()` would hand them that tenant's data. | dependent on Phase 2 email-confirm setting | Verify explicitly in Phase 2 auth-settings review (item 3) |
| P1-F1 | Overlapping legacy + new policy sets on `members` and `proqure_data` (permissive policies OR together; loosest wins). Security holds via the triggers, but effective permission is emergent. | n/a | Reconcile — TODO-P2-1 |
| P1-F2 | Two `proqure_ai_meter_add` overloads (text + uuid). Both locked, so no security consequence; cosmetic. | n/a | Consolidate — TODO-P2-2 |

---

## H. Phase 2 — Supabase Auth (NEXT — mostly dashboard, not SQL)

Priority order. Screenshots fine; none of these need secrets.

1. **`proqureadmin@proqure.co.uk` — MFA status** *(highest — ADMIN-1, the master key).* Authentication → Users → that user: enrolled MFA factor? Confirm strong unique password.
2. **SMTP** — Authentication → Emails/SMTP. Custom SMTP (ideally Resend) or default Supabase sender? Decides whether invite/reset email silently throttles.
3. **Auth protections** — min password length, leaked-password (HIBP) toggle, CAPTCHA (enabled? provider?), **and email-confirmation** (load-bearing — see TENANT-EMAIL).
4. **URL configuration** — Site URL + Redirect URLs allow-list locked to `app.proqure.co.uk`, not wildcarded.
5. **MFA factors + rate limits** — which factors enabled; per-hour email/token numbers.

---

## I. Change log
- **2026-06-19 (v1.0):** **Phase 1 COMPLETE & version-controlled.** Schema-wide RLS audit: all 6 public base tables `rls_enabled=true`, complete set, no untracked tables (SEC-1/2 → GUARANTEED). All three migrations committed to repo `/db/` (commit `1486c8f`, byte-verified identical to regenerated source) — root blind spot CLOSED (TODO-DB-0/9 done). `proqure_security_migration.sql` regenerated from live `pg_get_functiondef`/`pg_get_triggerdef`; policy counts cross-checked against live audit (28 total, exact match). `proqure_billing` confirmed server-only/service-role — RLS enable was pure hardening, no client impact. App-layer aal2 coverage mapped (§F). Carried forward: ADMIN-1 (P0, Phase 2 first task) and TENANT-EMAIL (email-keyed tenancy → email-confirm is load-bearing). Next: Phase 2 (Supabase Auth).
- **2026-06-19 (v0.5):** P1-C/D → GUARANTEED (post-lockdown grant query: only `postgres`+`service_role`). TODO-DB-7 closed. New finding: `proqure_billing` table outside Phase 1's original 5-table scope; RLS state unverified → schema-wide audit ordered. Regenerated `proqure_security_migration.sql` from live DDL.
- **2026-06-19 (v0.4):** Phase 1 verification complete bar repo commit. F3 confirmed `is_platform_admin()` non-forgeable + rank helpers safe (P1-E). Recorded ADMIN-1. Clarified migration status: DB-applied (evidence) but not yet in repo.
- **2026-06-19 (v0.3):** F1 → all lock policies RESTRICTIVE (P1-A). F2 → member-role triggers block escalation (P1-B); billing-guard body verified (APP-1). HOLE FOUND: `proqure_ai_meter_add` + `proqure_notify` client-EXECUTE + DEFINER (P1-C/D); fix `proqure_rpc_lockdown.sql` delivered.
- **2026-06-19 (v0.2):** Phase 1 partial results (§G). Verified RLS enabled, cross-tenant read isolation, definer search_path hygiene, billing-guard trigger present, announcements/notification_state scoping.
- **2026-06-19 (v0.1):** Document created. Recorded session work (APP-1..3, DOC-1), Vercel infra (INF-1..4), human-verification decisions (E), full open register (D).
