-- ============================================================================
-- proqure_rpc_lockdown.sql
-- ----------------------------------------------------------------------------
-- Remove client EXECUTE on the two SECURITY DEFINER functions that bypass RLS.
--
-- Why: both functions are SECURITY DEFINER (they run as the owner and bypass
-- row-level security). Left client-callable they were exploitable:
--   * proqure_ai_meter_add - a logged-in user could call it directly with a
--     negative cost to drive recorded AI spend down and defeat the budget cap
--     (unbounded OpenRouter cost), and p_company_id was unchecked so it could
--     reach other tenants' meters.
--   * proqure_notify       - inject notifications into any company/category
--     (in-app phishing via the CTA link).
-- The browser makes ZERO .rpc() calls to either; the server uses the service
-- role. So removing client EXECUTE is safe and closes both holes.
--
-- Verified live result (2026-06-19): EXECUTE limited to postgres (owner) +
-- service_role on all three signatures; no anon, authenticated or PUBLIC.
--
-- Apply order: run LAST, AFTER proqure_security_migration.sql has created the
-- functions. Idempotent: REVOKE/GRANT are safe to re-run.
-- ============================================================================

-- Both overloads of the meter RPC (text- and uuid-keyed).
revoke execute on function public.proqure_ai_meter_add(text, numeric, text) from public, anon, authenticated;
revoke execute on function public.proqure_ai_meter_add(uuid, numeric, text) from public, anon, authenticated;

-- The notify RPC (full 9-argument signature).
revoke execute on function public.proqure_notify(uuid, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;

-- Re-assert server access explicitly (the server calls these via the service role).
grant execute on function public.proqure_ai_meter_add(text, numeric, text) to service_role;
grant execute on function public.proqure_ai_meter_add(uuid, numeric, text) to service_role;
grant execute on function public.proqure_notify(uuid, text, text, text, text, text, text, text, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- VERIFY (section C) - should return only service_role (+ postgres):
--
-- select p.proname,
--        coalesce(array_to_string(p.proacl::text[], ', '), 'default (PUBLIC)') as execute_grants
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname in ('proqure_ai_meter_add','proqure_notify')
-- order by p.proname;
-- ============================================================================
-- END proqure_rpc_lockdown.sql
-- ============================================================================
