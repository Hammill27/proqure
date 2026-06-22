# ProQure — Security & Infrastructure Certificate

> **Living record.** This is the authoritative, portable account of what has been
> checked, verified, and assumed across ProQure's code, database and third-party
> configuration. It is maintained as evidence arrives. If this work moves to another
> conversation, machine, or developer, **this document is the source of truth** — not
> memory and not code comments (the `plan` incident proved comments can lie).

**Owner:** Jordan Hammill  **Started:** 2026-06-19  **Last updated:** 2026-06-22  **Version:** 1.4 (Phase 1, Phase 2, isolation audit, Phase 3 Vercel + provider spend guardrails COMPLETE; deeper cost review + ISO-TEST deferred)

### Confidence taxonomy
- **GUARANTEED** — enforced at a layer the client cannot bypass, *with evidence on file* (policy dump, trigger definition, a rejected test write, a dashboard screenshot, a live end-to-end test).
- **DEFENCE-IN-DEPTH** — genuinely helps but is evadable or secondary; not a hard guarantee.
- **IMPLEMENTED (unverified)** — built/deployed, but live enforcement not yet evidenced.
- **UNVERIFIED** — assumed true; no evidence gathered yet.
- **DEFERRED (paid-tier)** — sound control, blocked behind a Supabase paid plan; not an oversight.

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
| INF-5 | Repo `Hammill27/proqure`; app is single-file `procurement-dashboard.jsx`; 14 serverless functions in `api/` (+ one misplaced at repo root, see OPS-1) | GUARANTEED | 2026-06-19 | Repo clone, commit `1486c8f` |

---

## B. Application-layer controls

| ID | Control | Status | Confidence | Date | Evidence | Notes |
|----|---------|--------|-----------|------|----------|-------|
| APP-1 | **Billing-field freeze trigger** (`proqure_billing_guard`) — browser cannot set/change `plan`, `trialEndsAt`, `subscriptionStatus`, `stripeCustomerId`, `renewsAt` in `piq_settings` | Live + body-verified | GUARANTEED (recommend a live client test-write to make airtight) | 2026-06-19 | Query 4 + F2; committed `db/proqure_billing_guard.sql` | INSERT forces `plan='trial'` + 14-day window; UPDATE freezes the 5 fields for client roles even at manager rank; service_role/SQL authoritative |
| APP-2 | **Server-side trial-expiry gate** in `api/ai.js` — expired trial → HTTP 402 | Live (code-confirmed) | GUARANTEED (rests on APP-1) | 2026-06-19 | `api/ai.js` 402 gates | Also enforces monthly `AI_BUDGET` cap |
| APP-3 | **`licence.js` hardening** — honeypot + optional `LICENCE_SIGNUP_KEY` + **Turnstile (now active)** + disposable-email block + per-IP throttle | Live | GUARANTEED (Turnstile element); DEFENCE-IN-DEPTH (rest) | 2026-06-22 | See APP-4 | Turnstile upgraded from inert to active this session |
| APP-4 | **CAPTCHA on marketing signup** — Cloudflare Turnstile widget on the licence form, token verified server-side by `licence.js`, fail-closed | Live + end-to-end tested | GUARANTEED | 2026-06-22 | Live test: widget→token→server-verify→account created→setup email delivered (screenshots on file). Site key `0x4AAAAAADpDZaKR0No2Z1oy`; `TURNSTILE_SECRET_KEY` set on app project | Closes TODO-MK-1 |
| DOC-1 | **Architecture Blueprint** (42pp) + out-of-band checklist | Complete | n/a | 2026-06-19 | PDF artifacts | Reference |
| DOC-2 | **Three DB migrations committed to repo `/db/`** | Complete | GUARANTEED | 2026-06-19 | Repo `db/` commit `1486c8f`, byte-verified | Closed the root blind spot |
| DOC-3 | **Repo documentation** — root `README.md`, `db/README.md`, `SECURITY.md`, `docs/README.md` (tiered), `.gitignore` | Complete | n/a | 2026-06-19/22 | Committed | `SECURITY.md` points to `security@proqure.co.uk` — confirm mailbox exists (OPS-2) |

---

## C. Tenant/data controls — confirmed with evidence

| ID | Control | Confidence | Notes / evidence |
|----|---------|-----------|------------------|
| SEC-1 | Tenant isolation via Postgres RLS on all tenant tables | GUARANTEED | Schema-wide audit: all 6 public base tables `rls_enabled=true`; cross-tenant read isolation proven |
| SEC-2 | `piq_ai_meter` service-role-write-only | GUARANTEED | RESTRICTIVE `piq_ai_meter_no_client_*` policies |
| SEC-3 | `members` role cannot be self-assigned | GUARANTEED | `proqure_members_guard` + `proqure_guard_member_role` bodies verified |
| SEC-4 | SECURITY DEFINER functions pin `search_path` | GUARANTEED | Function defs |
| SEC-5 | Admin endpoints aal2 + allow-list + rate-limit | DEFENCE-IN-DEPTH | Code-confirmed (`admin*.js`); `ADMIN_CONSOLE_EMAILS` value pending reconcile (see ADMIN-1) |
| SEC-6 | Webhooks signature-verified (Stripe/Resend/Svix) | DEFENCE-IN-DEPTH | Code-confirmed; live secrets unconfirmed (Phase 4/6) |
| SEC-7 | All provider secrets server-side only; browser holds anon key + JWT | UNVERIFIED | Code side looks clean (only `VITE_SUPABASE_URL/ANON_KEY/INBOUND_CAPTURE_DOMAIN` exposed, none secret); full Vercel env audit = Phase 3 / TODO-VC-2 |

---

## D. Open register — blind spots, assumptions & TODO

**Root blind spot CLOSED** — all three migrations in repo `/db/` (commit `1486c8f`), regenerated from live DB.

### Database / Phase 1 — all done
| ID | Action | Status |
|----|--------|--------|
| TODO-DB-0..9 | RLS verify, meter lock, role guards, definer hygiene, RPC lockdown, migrations committed | **All Done — Guaranteed** |
| TODO-DB-5 | Live client `plan`-write test (make APP-1 airtight) | Open (P2, nice-to-have; body already verified) |
| TODO-DB-6 | Decide: freeze `piq_usage.addons` server-side vs £-cap backstop | Open (P1) |

### Phase 2 — Supabase Auth — done this session
| ID | Action | Status |
|----|--------|--------|
| TODO-ADMIN-1 | Master admin account | **Resolved — `proqureadmin@` was deleted long ago; gate retired (see ADMIN-1)** |
| TODO-SB-1 | Supabase Auth: SMTP, redirect allow-list, MFA, email-confirm, CAPTCHA, leaked-password | **Mostly Done** (SMTP/redirect/MFA/email-confirm/CAPTCHA closed; leaked-password deferred → TIER-1) |
| TODO-MK-1 | Turnstile on marketing signup | **Done — Guaranteed (APP-4)** |
| TODO-SB-2 | Backups / PITR; network restrictions | Deferred → TIER-3 |

### Funded-tier bucket (do on upgrade to Supabase Pro+)
| ID | Action | Priority |
|----|--------|----------|
| TIER-1 | Leaked-password protection (HIBP) — Pro-only; mitigated now by min-10 + char-class requirements | P1 at go-live |
| TIER-2 | SMS MFA — Pro-only; **not wanted** (TOTP-only is stronger; SIM-swap risk). Record as a deliberate no. | n/a |
| TIER-3 | PITR / point-in-time recovery — Pro + compute add-on, billed hourly, **not covered by spend cap** | P1 at go-live |

### Phase 3 — Vercel (COMPLETE 2026-06-22)
| ID | Action | Outcome |
|----|--------|---------|
| TODO-VC-1 | Stale `procureiq-two.vercel.app` hostname | **Done** — removed from proqure project; verified no code/marketing/auth reference first. App served only on `app.proqure.co.uk`. Other `*-jordan-s-projects2.vercel.app` are auto-gen deploy URLs, now behind deployment-protection login. |
| TODO-VC-2 | Env-var exposure audit | **Done** — no secret is `VITE_`-exposed (only URL/anon-key/inbound-domain are, all non-secret). Bug found + fixed: `TRIPE_PRICE_BUSINESS` typo → renamed `STRIPE_PRICE_BUSINESS` (`price_1TgP…`), Business checkout restored. Minor: `VITE_INBOUND_CAPTURE_DOMAIN` possibly redundant. |
| TODO-VC-3 | Preview deployment protection | **Done** — Vercel Authentication "Require Log In" (Standard Protection) ON; previews require logged-in team member. Production `app.proqure.co.uk` confirmed still public (incognito). |
| TODO-VC-4 | Spend cap/alert | **Done** — Pro base $20/mo, $20 included credit (32¢ used), on-demand budget $200 with Notifications ON / Pause-Projects OFF (won't take prod offline). Safe as-is. |

### Provider spend guardrails (2026-06-22)
| ID | Item | State |
|----|------|-------|
| COST-OR | OpenRouter | Key "ProQure" credit limit set **$50** (was unlimited); balance $4.87, **auto-top-up OFF** (hard ceiling = balance); lifetime key spend $0.13 (Gemini 2.5 Flash / DeepSeek V3 / Gemini 3.5 Flash). Guardrail policies: default/empty (optional model-restriction policy noted for cost review). In-code budget meter + trial gate remain per-tenant layer. Runaway-bill risk: effectively nil. |
| COST-DOC | Dedicated **Cost & Spend Analysis PDF** | **Deferred** — to be built after the fuller spend review (provider fixed vs variable costs, guardrails, unit economics). Data being gathered (Vercel + OpenRouter captured above). |

### Earlier-phase items still open

### Later phases
| ID | Action | Phase |
|----|--------|-------|
| TODO-RS-1 | Resend SPF/DKIM/DMARC (confirm `proqure.co.uk` verified); webhook secret; inbound MX; plan limits | 4 |
| TODO-CF-1 | Cloudflare-proxied? single edge owner | 5 |
| TODO-ST-1 | Stripe webhook secret/event match; portal; cancel→downgrade; test→live; wire real payment in `licence.js` placeholder | 6 |
| TODO-X-1 | 2FA on GitHub, Vercel, Supabase, Resend, Stripe, Cloudflare, registrar; registrar domain-lock | 8 (P0) |
| TODO-X-2 | Secrets-in-git-history scan; rotate anything found (`.gitignore` now in place but doesn't touch history) | 8 |
| TODO-X-3 | Break-glass key-rotation runbook | 8 |

### Operational findings (this session)
| ID | Finding | Priority | Status |
|----|---------|----------|--------|
| OPS-1 | **`retention-sweep` cron** — file is correctly at `api/retention-sweep.js` and `vercel.json` schedules `/api/retention-sweep` (03:00). Path and cron target match; cron resolves to a real function. | — | **Closed (verified in repo 2026-06-22)** |
| OPS-2 | `SECURITY.md` — **finding withdrawn.** Verified against the live repo: no `SECURITY.md` was ever committed (only the root `README.md` from the "extras" batch landed). No dead address exists anywhere. A `SECURITY.md` is optional and not currently wanted (no mailbox / Exchange Online). | — | **Withdrawn — nothing live to fix** |
| OPS-3 | **Repo visibility.** Repo currently public (re-opened so Claude could read code). Recommendation: flip back to **private**, or hold Tier-2 docs + the cert out of it. A public repo carrying the open-gaps register + admin context is the one loose thread. | P1 | Open — decision pending |

---

## E. Human-verification placement (decided 2026-06-19, CAPTCHA now live)

| Surface | Decision | Status |
|---------|----------|--------|
| Marketing signup form | Turnstile | **Live (APP-4)** |
| App login | Supabase Auth CAPTCHA | Deferred — needs frontend token wiring in `procurement-dashboard.jsx` before enabling, or logins break (same fail-closed pattern as the marketing form) |
| Password reset | Supabase Auth CAPTCHA | Deferred — as above |
| Invite (send/accept), admin console, `/api/*` | None | Session/role/aal2/signature already gate them |

---

## F. App-layer MFA (aal2) coverage — confirmed in code

| Endpoint | aal2? | Notes |
|----------|-------|-------|
| `create-checkout-session`, `create-portal-session`, `notifications`, `admin`, `admin-metrics`, `admin-health` | YES | Money + admin |
| `ai`, `send-email` | NO | Gated by session + role + budget/trial instead |

Project-level MFA: **TOTP enabled**, SMS disabled (deliberate), AAL1 session-duration limit ON. Decision pending (roadmap "App MFA Phase 2"): whether to extend aal2 to `send-email`. Deliberate boundary, not a gap.

---

## G. Phase 1 — database verification (COMPLETE, 2026-06-19)

Tenant isolation (schema-wide RLS, all 6 base tables), within-tenant locks (meter/money-keys/role-rank/notif-rank, all RESTRICTIVE), role-escalation triggers, definer hygiene, RPC lockdown (`proqure_ai_meter_add` + `proqure_notify` → service_role only), and the platform-admin gate — all **GUARANTEED** with evidence. One hole found (client-callable definer RPCs) → fixed + verified. Migrations committed. Policy counts cross-checked against live audit (28, exact match). Full detail retained in v1.0 history.

---

## H. Phase 2 — Supabase Auth (COMPLETE, 2026-06-22)

| ID | Item | Outcome | Confidence | Evidence |
|----|------|---------|-----------|----------|
| ADMIN-1 | Platform super-admin gate | **Retired.** `proqureadmin@proqure.co.uk` was an old cross-tenant-login account, **deleted long ago**. The admin centre runs on `ADMIN_CONSOLE_EMAILS` + service role (server-side) and never used `is_platform_admin()` — so the function was vestigial. Its `OR is_platform_admin()` branches were a dormant landmine (anyone re-registering that email would inherit god-mode). **`is_platform_admin()` body hardwired to `select false`** in live DB + committed migration. | GUARANTEED | Live `prosrc` = `select false`; grep showing admin endpoints use `ADMIN_CONSOLE_EMAILS`+service role |
| TENANT-EMAIL | Email-keyed tenancy (`my_company()` matches JWT email) | **Resolved — positive.** Trial signup uses `inviteUserByEmail` (emailed link → set password), so email ownership is proven before any session exists; tenancy lookup can't be hijacked. Public sign-up is OFF; accounts provisioned server-side only. Supabase "Confirm email" is off but **moot** for this flow. | GUARANTEED | `licence.js` L177 `inviteUserByEmail`; Supabase signup-disabled screenshot |
| SB-SMTP | Auth email delivery | **Custom SMTP via Resend** (`smtp.resend.com`, port 465 implicit TLS, sender `accounts@proqure.co.uk`, name ProQure). Not on throttled default sender. Min-interval 60s/user. | GUARANTEED | SMTP settings screenshots |
| SB-URL | Redirect allow-list | **Locked.** Site URL + sole redirect entry both `https://app.proqure.co.uk`. No wildcards, no stale hostnames. | GUARANTEED | URL Configuration screenshot (Total URLs: 1) |
| SB-MFA | Multi-factor | **TOTP enabled** (the factor admin console + manager/buyer 2FA depend on); SMS disabled (deliberate); AAL1 session-duration limit ON. Max 10 factors/user. | GUARANTEED | Multi-Factor screenshot |
| SB-PW | Password policy | Min length **10** + requires lowercase/uppercase/digits/symbols. Secure email change ON. Leaked-password protection OFF — **deferred (Pro-only, TIER-1)**. | GUARANTEED (policy) / DEFERRED (HIBP) | Email-provider settings screenshot |

**Phase 2 verdict:** the Supabase-auth attack surface is hardened — admin bypass removed, signup proves ownership, auth email production-grade, redirect surface minimal, MFA strong, signup bot-protected end-to-end. Remaining auth items are paid-tier (TIER-1/3) or app-login CAPTCHA (needs frontend wiring, deferred by choice).

---

## J. Tenant-isolation audit (COMPLETE, 2026-06-22)

**Purpose:** answer the present-day question — *can any authenticated user today reach another company's data through a forgotten path?* — weighted toward bypass-hunting (paths that never touch `my_company()`/RLS), not just resolver dependencies. Method: full live-schema enumeration (all tables + RLS + policy predicates; all views; all functions + security type + grants; client-role table grants) plus code reading of call-sites.

### Clean (evidence on file)
| Area | Finding | Evidence |
|------|---------|----------|
| RLS coverage | All 6 public base tables RLS-enabled; the 6 are the complete base-table set | Q1 schema-wide |
| Views | **None exist** — entire view-bypass category empty | Q3 returned 0 rows |
| Policy predicates | Every policy ties to `my_company()` / `proqure_member_rank`/`role` (verified membership) / `auth.uid()` / signed JWT email. No `using (true)`, nothing keyed on a forgeable value | Q2 full predicate dump |
| Client `.rpc()` surface | Browser makes **zero** `.rpc()` calls; all RPCs invoked server-side with service role only | Code: `procurement-dashboard.jsx` (no `.rpc(`), callers in `api/` use `SUPABASE_SERVICE_ROLE_KEY` |
| Table grants to anon/authenticated | Broad (full CRUD) but **gated by RLS** — expected under the Supabase model; not a finding while RLS stays on. (This is precisely what the Phase-4 isolation test suite must guard.) | Q5 |

### HOLES FOUND + FIXED (the bypass hunt's payoff)
Three SECURITY DEFINER functions (bypass RLS by design), client-EXECUTE-able, **not in the committed migrations**, that trusted their company argument:

| Function | Risk | Fix | Confidence |
|----------|------|-----|-----------|
| `proqure_event_push(uuid,text,jsonb,int)` | Cross-tenant **write** — push events into any company's `proqure_data` | In-function membership guard (service-role bypass) **+** client EXECUTE revoked | GUARANTEED |
| `proqure_stats_bump(uuid,text,jsonb)` | Cross-tenant **write** — bump stats on any company | Same two-layer fix | GUARANTEED |
| `proqure_storage_stats()` | Cross-tenant **read** — returns every company's storage footprint (no per-company scope) | Locked to service_role (no safe client form) | GUARANTEED |

**Evidence:** post-fix grant query shows all three EXECUTE = `postgres` + `service_role` only (no anon/authenticated/PUBLIC); guard bodies live (migration ran clean); callers verified server-only/service-role from code (`resend-webhook.js`, `inbound.js`, `admin-metrics.js`). Fix committed as `db/proqure_telemetry_guard.sql` — closing the version-control drift that let them hide.

**Audit verdict:** as of this schema snapshot, every enumerated tenant-data path is membership-guarded, definer-guarded, or service-role-only. No present-day cross-tenant read/write path remains in the enumerated surface. *Caveat (acknowledged): an audit gives high point-in-time confidence within its enumerated surface, not a proof for all time or all paths — continuous enforcement is the job of the deferred isolation test suite (see ISO-TEST).*

### Architectural finding (deferred — multi-membership)
> **Finding (architectural, not a current security issue).** Tenant resolution uses `my_company()` → `select company_id from members where email = … limit 1`. This is safe **under the invariant that an identity holds exactly one membership**. Introducing multiple memberships per identity without first implementing deterministic, fail-closed tenant resolution (database-authoritative, no arbitrary row selection, no implicit fallback to another company, no trust in client-controlled context) and reviewing all dependent RLS policies and tenant-data paths would create a latent tenant-isolation risk. **Prerequisite gate:** multi-membership MUST NOT be enabled until (a) tenant resolution is deterministic and fails closed, validating any active-company hint against `members` rather than trusting it, and (b) every RLS policy/function depending on `my_company()` has been reviewed. Agreed phased plan: audit/map → resolver contract → refactor single-membership assumptions (`LIMIT 1`/`.single()`/email-uniqueness) → **isolation test suite** → active-company resolution → enable multi-membership. Implementation deferred until a business requirement exists.

| ID | Item | Status |
|----|------|--------|
| ISO-TEST | Adversarial cross-tenant isolation test suite (two tenants; assert every table/RPC/definer fn denies cross-tenant read+write) — the continuous guardrail against regression | **Open — recommended next security investment** |
| MULTI-MEM | Multi-membership feature, gated behind the prerequisite above | Deferred (roadmap) |

---

## I. Change log
- **2026-06-22 (v1.4):** **Phase 3 (Vercel) COMPLETE** + provider spend guardrails. Env audit: no secret `VITE_`-exposed (P0 clean); found & fixed `TRIPE_PRICE_BUSINESS` typo (Business checkout was broken) → `STRIPE_PRICE_BUSINESS`. Preview deployment protection ON (prod still public). Stale `procureiq-two.vercel.app` removed (no references, verified). Vercel spend: $20 base + $20 included credit (32¢ used), $200 on-demand budget notify-not-pause — safe. OpenRouter: key credit limit set $50, auto-top-up OFF (ceiling = $4.87 balance), guardrail policies default/empty. Deferred: dedicated Cost & Spend Analysis PDF (after fuller review) and ISO-TEST (dev build).
- **2026-06-22 (v1.3):** Corrected two OPS findings. OPS-1 closed — `retention-sweep` already at `api/retention-sweep.js` (prior "cron dead" note was stale). OPS-2 — `SECURITY.md` was never actually committed to the repo; no mailbox exists; finding withdrawn (no live dead-address). Honest note: the `SECURITY.md`/address was a generated suggestion never deployed; cert had drifted ahead of repo reality on both — corrected by checking the live repo.
- **2026-06-22 (v1.2):** **Tenant-isolation audit COMPLETE (§J).** Core model clean — all 6 tables RLS-on, no views, all policy predicates membership-bound, zero client `.rpc()` calls. Bypass hunt found 3 undocumented client-callable SECURITY DEFINER functions trusting their company arg: `proqure_event_push`/`proqure_stats_bump` (cross-tenant write) + `proqure_storage_stats` (cross-tenant storage-metadata read). Fixed two-layer (in-function membership guard with service-role bypass + client EXECUTE revoked) / service-role lockdown; verified live (all three EXECUTE = postgres+service_role); callers confirmed server-only from code; committed `db/proqure_telemetry_guard.sql` (closes drift). Recorded multi-membership as a deferred architectural finding with a hard prerequisite gate, and ISO-TEST (adversarial isolation suite) as the recommended next security investment. `db/` now also holds `README.md` + `Security-Certificate.md`.
- **2026-06-22 (v1.1):** **Phase 2 (Supabase Auth) COMPLETE.** ADMIN-1 retired (`is_platform_admin()`→`select false`, live+repo; old `proqureadmin@` account long deleted; admin centre uses `ADMIN_CONSOLE_EMAILS`+service role). TENANT-EMAIL resolved positive (invite-link signup proves ownership). SMTP (Resend custom), redirect allow-list (locked), MFA (TOTP on/SMS off/AAL1 limit on), password policy — all GUARANTEED via screenshots. CAPTCHA (APP-4) live + end-to-end tested → TODO-MK-1 closed, APP-3 Turnstile active. Funded-tier bucket recorded (TIER-1/2/3). New findings: OPS-1 (retention-sweep cron dead — file misplaced at repo root), OPS-2 (SECURITY.md mailbox), OPS-3 (repo visibility). Repo docs added (DOC-3). Next: Phase 3 (Vercel).
- **2026-06-19 (v1.0):** Phase 1 COMPLETE & version-controlled. Schema-wide RLS audit (6/6 tables). Migrations committed (`1486c8f`, byte-verified). `proqure_security_migration.sql` regenerated from live DDL; 28 policies cross-checked. App-layer aal2 coverage mapped. Carried forward ADMIN-1, TENANT-EMAIL.
- **2026-06-19 (v0.5):** P1-C/D → GUARANTEED (post-lockdown grants). New finding: `proqure_billing` outside original RLS scope → schema-wide audit ordered.
- **2026-06-19 (v0.4):** Phase 1 verification complete bar repo commit. F3 (admin gate non-forgeable). ADMIN-1 recorded.
- **2026-06-19 (v0.3):** F1 (lock policies RESTRICTIVE), F2 (member triggers), billing-guard body. HOLE FOUND: client-EXECUTE definer RPCs → `proqure_rpc_lockdown.sql`.
- **2026-06-19 (v0.2):** Phase 1 partial — RLS enabled, cross-tenant isolation, definer hygiene, billing-guard trigger, scoping.
- **2026-06-19 (v0.1):** Document created.
