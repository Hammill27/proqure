-- ============================================================================
-- proqure_telemetry_guard.sql
-- ----------------------------------------------------------------------------
-- Closes three cross-tenant paths found in the Phase 1 isolation audit
-- (2026-06-22). All three are SECURITY DEFINER (they bypass RLS) and were
-- EXECUTE-able by anon/authenticated, but trusted their company argument:
--
--   * proqure_event_push  - client could push events into ANY company's data
--   * proqure_stats_bump   - client could bump stats on ANY company's data
--   * proqure_storage_stats- client could read EVERY company's storage footprint
--
-- These three were also not in the committed migrations, so this file both
-- FIXES the hole and version-controls the functions.
--
-- Fix shape:
--   - event_push / stats_bump: keep callable, but add a membership guard.
--     The service role (server) is trusted and skips the check; a browser
--     caller may only affect a company it is a verified member of.
--   - storage_stats: platform-wide report with no per-company scope; there is
--     no safe client form of it, so it is locked to service_role only.
--
-- Idempotent: CREATE OR REPLACE + REVOKE/GRANT are safe to re-run.
-- Apply order: after proqure_security_migration.sql (needs proqure_member_rank).
-- ============================================================================

-- ---- proqure_event_push: membership-guarded -------------------------------
CREATE OR REPLACE FUNCTION public.proqure_event_push(p_company uuid, p_key text, p_event jsonb, p_cap integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  arr jsonb;
begin
  -- Tenant guard: the service role (server) is trusted; a browser caller may
  -- only write to a company it is a verified member of. Closes cross-tenant push.
  if coalesce(auth.role(), '') <> 'service_role' then
    if public.proqure_member_rank(p_company::text) < 1 then
      raise exception 'Not authorised for this company';
    end if;
  end if;

  insert into public.proqure_data(user_id, store_key, value, updated_at)
    values (p_company, p_key, '[]'::jsonb, now())
    on conflict (user_id, store_key) do nothing;
  select value into arr
    from public.proqure_data
    where user_id = p_company and store_key = p_key
    for update;
  if arr is null or jsonb_typeof(arr) <> 'array' then
    arr := '[]'::jsonb;
  end if;
  arr := arr || jsonb_build_array(p_event);
  -- Keep only the newest p_cap entries, in chronological order. One pass:
  -- number the elements, take the highest-numbered p_cap, re-aggregate ascending.
  if jsonb_array_length(arr) > p_cap then
    arr := (
      select coalesce(jsonb_agg(e order by ord), '[]'::jsonb)
      from (
        select e, ord
        from jsonb_array_elements(arr) with ordinality as t(e, ord)
        order by ord desc
        limit p_cap
      ) newest
    );
  end if;
  update public.proqure_data
    set value = arr, updated_at = now()
    where user_id = p_company and store_key = p_key;
end;
$function$;

-- ---- proqure_stats_bump: membership-guarded -------------------------------
CREATE OR REPLACE FUNCTION public.proqure_stats_bump(p_company uuid, p_key text, p_fields jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v jsonb;
  k text;
  inc text;
begin
  -- Tenant guard: service role trusted; browser caller must be a verified
  -- member of p_company. Closes cross-tenant stats writes.
  if coalesce(auth.role(), '') <> 'service_role' then
    if public.proqure_member_rank(p_company::text) < 1 then
      raise exception 'Not authorised for this company';
    end if;
  end if;

  insert into public.proqure_data(user_id, store_key, value, updated_at)
    values (p_company, p_key, '{}'::jsonb, now())
    on conflict (user_id, store_key) do nothing;
  select value into v
    from public.proqure_data
    where user_id = p_company and store_key = p_key
    for update;
  if v is null or jsonb_typeof(v) <> 'object' then
    v := '{}'::jsonb;
  end if;
  for k, inc in select key, value from jsonb_each_text(p_fields) loop
    v := jsonb_set(
      v, array[k],
      to_jsonb(coalesce((v->>k)::numeric, 0) + coalesce(inc::numeric, 0)),
      true
    );
  end loop;
  v := jsonb_set(v, '{lastEventAt}', to_jsonb(now()), true);
  update public.proqure_data
    set value = v, updated_at = now()
    where user_id = p_company and store_key = p_key;
end;
$function$;

-- ---- proqure_storage_stats: locked to service_role ------------------------
-- Platform-wide report (returns every company's footprint); no per-company
-- scope exists, so there is no safe client form. The body is unchanged; we
-- simply remove client EXECUTE so only the server (admin/ops) can run it.
revoke execute on function public.proqure_storage_stats() from public, anon, authenticated;
grant  execute on function public.proqure_storage_stats() to service_role;

-- ---- Minimal-grants belt-and-braces on the two writers --------------------
-- Verified from the codebase (2026-06-22): the browser makes ZERO .rpc() calls;
-- event_push / stats_bump are invoked only server-side (resend-webhook.js,
-- inbound.js) with the service role. So removing client EXECUTE is safe and
-- gives a second layer beneath the in-function membership guards above.
revoke execute on function public.proqure_event_push(uuid, text, jsonb, integer) from public, anon, authenticated;
revoke execute on function public.proqure_stats_bump(uuid, text, jsonb)          from public, anon, authenticated;
grant  execute on function public.proqure_event_push(uuid, text, jsonb, integer) to service_role;
grant  execute on function public.proqure_stats_bump(uuid, text, jsonb)          to service_role;

-- ----------------------------------------------------------------------------
-- VERIFY:
--   1) All three should be service_role (+ postgres) only on EXECUTE:
--      select proname, coalesce(array_to_string(proacl::text[], ', '),'PUBLIC')
--      from pg_proc where proname in
--        ('proqure_storage_stats','proqure_event_push','proqure_stats_bump');
--   2) Guards present: the two writer bodies contain the
--      'Not authorised for this company' check.
-- ============================================================================
-- END proqure_telemetry_guard.sql
-- ============================================================================
