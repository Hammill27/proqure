# Database migrations

These three SQL files are the **version-controlled record of ProQure's live database
security model**. They were regenerated on 2026-06-19 directly from the live database
(`pg_get_functiondef`, `pg_get_triggerdef`, `pg_policies`), so they are a faithful mirror
of what is actually deployed — not a from-memory approximation.

> **Applied ≠ committed.** The live database already has all of this applied. These files
> exist so the security model is reviewable, reproducible, and rebuildable on a fresh
> environment. Applying a change to the database and committing it here are two separate
> acts — keep them in step, or the repo drifts from reality (the exact trap these files
> were created to close).

## Files & apply order

On a fresh database, run in this order:

1. **`proqure_security_migration.sql`** — the core model: helper and guard functions,
   RLS enablement on all tenant tables, every row-level-security policy, and the
   membership triggers.
2. **`proqure_billing_guard.sql`** — the trigger that freezes the billing fields
   (`plan`, `trialEndsAt`, `subscriptionStatus`, `stripeCustomerId`, `renewsAt`) in
   `piq_settings` against browser writes, making billing server-authoritative. Stripe
   updates flow through the service role and are unaffected.
3. **`proqure_rpc_lockdown.sql`** — removes client `EXECUTE` on the two SECURITY DEFINER
   RPCs (`proqure_ai_meter_add`, `proqure_notify`), leaving them callable only by the
   service role.

The order matters: migration #1 creates the functions that #3 locks down. All three are
idempotent (`CREATE OR REPLACE`, drop-if-exists then create, `REVOKE`/`GRANT`), so they
are safe to re-run.

## What the model enforces

- **Tenant isolation** — RLS on every tenant table; one company cannot read or write
  another's data.
- **Within-tenant role rules** — RESTRICTIVE policies clamp AI-meter writes, commercial
  data keys, per-store-key write ranks, and notification categories to the correct roles.
- **Role-escalation defence** — triggers ensure only a manager can assign or change a
  member's role; the owner-bootstrap and invite-accept paths cannot alter role or email.
- **Definer hygiene** — every SECURITY DEFINER function pins its `search_path`.
- **Server-authoritative billing** — the billing-guard trigger (file #2).
- **Non-forgeable platform admin** — the admin gate compares a Supabase-signed JWT email
  against a hardcoded literal, so it cannot be spoofed by a client.

## Applying to a fresh database

Run each file in the Supabase SQL editor (or via `psql`) in the order above. For a
transaction-safe run, wrap each file's contents in `begin; … commit;` so a mid-file error
rolls back cleanly.
