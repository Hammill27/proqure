-- ============================================================================
-- proqure_security_migration.sql
-- ----------------------------------------------------------------------------
-- REGENERATED SNAPSHOT of ProQure's live database security model.
--
-- Provenance: the original migration file was never in version control (it is
-- the "root blind spot" recorded in the Security & Infrastructure Certificate).
-- This file was reconstructed on 2026-06-19 directly from the live database via
-- pg_get_functiondef / pg_get_triggerdef / pg_policies / pg_tables, so it is a
-- faithful record of what is actually deployed -- not a memory of it.
--
-- Scope: this file recreates the FUNCTIONS, RLS ENABLEMENT, POLICIES and
-- TRIGGERS that make up the security model, EXCEPT the two objects that have
-- their own dedicated migration files:
--   * proqure_billing_guard()  + trg_proqure_billing_guard  -> proqure_billing_guard.sql
--   * the EXECUTE revokes on proqure_ai_meter_add / proqure_notify -> proqure_rpc_lockdown.sql
--
-- Apply order on a fresh database:
--   1. proqure_security_migration.sql   (this file)
--   2. proqure_billing_guard.sql
--   3. proqure_rpc_lockdown.sql
--
-- Idempotent: functions use CREATE OR REPLACE; RLS enablement is a no-op if
-- already on; policies and triggers are dropped-if-exists then created, so the
-- file can be re-run safely.
--
-- NOTE (must verify before committing): the proqure_billing RLS-enable line
-- below is included DEFENSIVELY. Phase 1 never confirmed RLS is enabled on
-- proqure_billing. Run the schema-wide RLS audit and confirm the live state
-- before relying on this file as truth.
-- ============================================================================


-- ============================================================================
-- FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.proqure_role_rank(p_role text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case lower(coalesce(p_role, ''))
    when 'manager'  then 3
    when 'owner'    then 3   -- legacy owner == manager
    when 'buyer'    then 2
    when 'engineer' then 1
    else 0
  end;
$function$;

CREATE OR REPLACE FUNCTION public.proqure_required_rank(k text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case k
    when 'piq_settings'  then 3   -- company settings: Managers only
    when 'piq_team'      then 3   -- team list:        Managers only
    when 'piq_suppliers' then 2   -- suppliers:        Buyers + Managers
    else 1                        -- everything else: any signed-in member
  end;
$function$;

CREATE OR REPLACE FUNCTION public.proqure_notif_min_rank(p_category text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case p_category
    when 'billing'    then 3
    when 'usage_cost' then 3
    when 'usage'      then 3
    when 'team'       then 3
    when 'system'     then 3
    when 'invoice'    then 2
    when 'workflow'   then 2
    when 'process'    then 2
    -- announcement / maintenance / release and anything unknown: everyone
    else 1
  end;
$function$;

CREATE OR REPLACE FUNCTION public.is_platform_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select false
$function$;

CREATE OR REPLACE FUNCTION public.my_company()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select company_id from public.members
  where email = lower(auth.jwt() ->> 'email')
  limit 1
$function$;

CREATE OR REPLACE FUNCTION public.proqure_member_rank(target_company text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(max(
    case lower(role)
      when 'manager'  then 3
      when 'owner'    then 3   -- retired role, treated as manager
      when 'buyer'    then 2
      when 'engineer' then 1
      else 0
    end), 0)
  from public.members
  where company_id::text = target_company
    and user_id::text   = auth.uid()::text;
$function$;

CREATE OR REPLACE FUNCTION public.proqure_member_role(company uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when auth.uid() = company then 'manager'
    else (
      -- map the retired "owner" role to manager, matching the app's normaliseRole
      select case when role = 'owner' then 'manager' else role end
      from public.members
      where company_id = company
        and user_id = auth.uid()
      limit 1
    )
  end;
$function$;

CREATE OR REPLACE FUNCTION public.proqure_notify(p_company uuid, p_type text, p_category text, p_title text, p_body text DEFAULT ''::text, p_dedupe text DEFAULT NULL::text, p_cta_label text DEFAULT NULL::text, p_cta_href text DEFAULT NULL::text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.notifications
    (company_id, type, category, title, body, cta_label, cta_href, dedupe_key, meta)
  values
    (p_company, p_type, p_category, p_title, p_body, p_cta_label, p_cta_href,
     coalesce(p_dedupe, gen_random_uuid()::text), coalesce(p_meta, '{}'::jsonb))
  on conflict (company_id, dedupe_key) do nothing;
end;
$function$;

-- Legacy text-keyed overload. Retained as-is; client EXECUTE is revoked in
-- proqure_rpc_lockdown.sql. (Consolidation to the uuid version is a P2 cleanup.)
CREATE OR REPLACE FUNCTION public.proqure_ai_meter_add(p_company_id text, p_cost numeric, p_period text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  new_total numeric;
begin
  insert into public.proqure_data (user_id, store_key, value, updated_at)
  values (
    p_company_id,
    'piq_ai_meter',
    jsonb_build_object('period', p_period, 'costPeriod', round(coalesce(p_cost, 0)::numeric, 6)),
    now()
  )
  on conflict (user_id, store_key) do update
  set value = case
        -- same month: add to the running total
        when public.proqure_data.value->>'period' = p_period then
          jsonb_build_object(
            'period', p_period,
            'costPeriod', round(
              (coalesce((public.proqure_data.value->>'costPeriod')::numeric, 0) + coalesce(p_cost, 0))::numeric, 6)
          )
        -- new month (or no period): reset to just this cost
        else
          jsonb_build_object('period', p_period, 'costPeriod', round(coalesce(p_cost, 0)::numeric, 6))
      end,
      updated_at = now()
  returning (value->>'costPeriod')::numeric into new_total;

  return new_total;
end;
$function$;

-- Atomic, row-locked uuid-keyed version (preferred).
CREATE OR REPLACE FUNCTION public.proqure_ai_meter_add(p_company_id uuid, p_cost numeric, p_period text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v   jsonb;
  cur numeric;
begin
  insert into public.proqure_data(user_id, store_key, value, updated_at)
    values (p_company_id, 'piq_ai_meter',
            jsonb_build_object('period', p_period, 'costPeriod', 0), now())
    on conflict (user_id, store_key) do nothing;

  -- Row lock serialises concurrent AI calls so no increment is lost.
  select value into v
    from public.proqure_data
    where user_id = p_company_id and store_key = 'piq_ai_meter'
    for update;

  if v is null or jsonb_typeof(v) <> 'object' then
    v := jsonb_build_object('period', p_period, 'costPeriod', 0);
  end if;

  -- New month resets the running total.
  if (v->>'period') is distinct from p_period then
    cur := 0;
  else
    cur := coalesce((v->>'costPeriod')::numeric, 0);
  end if;

  v := jsonb_build_object(
         'period', p_period,
         'costPeriod', round((cur + coalesce(p_cost, 0))::numeric, 6)
       );

  update public.proqure_data
    set value = v, updated_at = now()
    where user_id = p_company_id and store_key = 'piq_ai_meter';
end;
$function$;

CREATE OR REPLACE FUNCTION public.proqure_guard_member_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- service_role (server functions / admin) is trusted and skips the check.
  if coalesce(auth.role(), '') = 'service_role' then
    return NEW;
  end if;
  -- Only a role CHANGE is policed; claiming your row (user_id/joined_at) is fine.
  if NEW.role is distinct from OLD.role then
    if public.proqure_member_rank(OLD.company_id::text) < 3 then
      raise exception 'Only a manager can change a member''s role';
    end if;
  end if;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.proqure_members_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  is_mgr      boolean;
  actor_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  -- Only guard genuine end-user writes. Service role / db owner do trusted work.
  -- NB: inside a SECURITY DEFINER function `current_user` is the owner, so we must use
  -- auth.role() (the JWT role claim) to identify the real caller. authenticated users
  -- get 'authenticated'; the service role gets 'service_role'; a direct/migration
  -- connection has no JWT (null) -- all non-'authenticated' callers bypass the guard.
  if coalesce(auth.role(), '') <> 'authenticated' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if public.proqure_member_role(old.company_id) is distinct from 'manager' then
      raise exception 'Only a manager can remove a member';
    end if;
    return old;
  end if;

  -- INSERT / UPDATE share these invariants.
  if new.role is not null and new.role not in ('engineer','buyer','manager','owner') then
    raise exception 'Invalid member role: %', new.role;
  end if;

  is_mgr := (public.proqure_member_role(new.company_id) = 'manager');

  if tg_op = 'INSERT' then
    if is_mgr then
      return new;                                   -- manager inviting into own company
    elsif new.company_id = auth.uid()
          and new.user_id = auth.uid()
          and new.role = 'manager' then
      return new;                                   -- brand-new owner bootstrap
    end if;
    raise exception 'Not authorised to add this member';
  end if;

  -- UPDATE
  if new.company_id is distinct from old.company_id then
    raise exception 'A member cannot be moved between companies';
  end if;

  if is_mgr then
    return new;                                     -- manager edits role/employment
  end if;

  -- Invite-accept: the invited user attaches their account to their own pending
  -- row. They may set user_id/joined_at only -- never their role or email.
  if actor_email <> ''
     and lower(coalesce(old.email, '')) = actor_email
     and new.user_id = auth.uid()
     and coalesce(new.role, '')  = coalesce(old.role, '')
     and lower(coalesce(new.email, '')) = lower(coalesce(old.email, '')) then
    return new;
  end if;

  raise exception 'Not authorised to modify this membership';
end;
$function$;

CREATE OR REPLACE FUNCTION public.proqure_members_join_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if old.user_id is null and new.user_id is not null then
    perform public.proqure_notify(
      new.company_id,
      'info',
      'team',
      'Teammate joined',
      coalesce(new.email, 'A teammate') || ' has joined the team'
        || case when new.role is not null then ' as ' || new.role else '' end || '.',
      'team:joined:' || new.user_id::text,
      null, null,
      jsonb_build_object('kind', 'joined', 'email', new.email, 'role', new.role)
    );
  end if;
  return new;
end;
$function$;


-- ============================================================================
-- ROW LEVEL SECURITY ENABLEMENT
-- ============================================================================

alter table public.announcements      enable row level security;
alter table public.members            enable row level security;
alter table public.notification_state enable row level security;
alter table public.notifications      enable row level security;
alter table public.proqure_data       enable row level security;

-- DEFENSIVE / VERIFY: proqure_billing has a SELECT policy but its live RLS
-- state was never confirmed in Phase 1. If the schema-wide RLS audit shows
-- rls_enabled = false for this table, it has been cross-tenant readable and
-- this line closes a real hole. If already enabled, this is a harmless no-op.
alter table public.proqure_billing    enable row level security;


-- ============================================================================
-- POLICIES  (dropped-if-exists then created, so the file is re-runnable)
-- ============================================================================

-- ---- proqure_data ----------------------------------------------------------
drop policy if exists "own rows" on public.proqure_data;
create policy "own rows" on public.proqure_data as permissive for ALL to public
  using ((auth.uid() = user_id)) with check ((auth.uid() = user_id));

drop policy if exists proqure_data_company_delete on public.proqure_data;
create policy proqure_data_company_delete on public.proqure_data as permissive for DELETE to authenticated
  using ((proqure_member_rank((user_id)::text) >= 1));

drop policy if exists proqure_data_company_insert on public.proqure_data;
create policy proqure_data_company_insert on public.proqure_data as permissive for INSERT to authenticated
  with check ((proqure_member_rank((user_id)::text) >= 1));

drop policy if exists proqure_data_company_select on public.proqure_data;
create policy proqure_data_company_select on public.proqure_data as permissive for SELECT to authenticated
  using ((proqure_member_rank((user_id)::text) >= 1));

drop policy if exists proqure_data_company_update on public.proqure_data;
create policy proqure_data_company_update on public.proqure_data as permissive for UPDATE to authenticated
  using ((proqure_member_rank((user_id)::text) >= 1)) with check ((proqure_member_rank((user_id)::text) >= 1));

drop policy if exists proqure_data_insert on public.proqure_data;
create policy proqure_data_insert on public.proqure_data as permissive for INSERT to authenticated
  with check (((user_id = my_company()) OR is_platform_admin()));

drop policy if exists proqure_data_select on public.proqure_data;
create policy proqure_data_select on public.proqure_data as permissive for SELECT to authenticated
  using (((user_id = my_company()) OR is_platform_admin()));

drop policy if exists proqure_data_update on public.proqure_data;
create policy proqure_data_update on public.proqure_data as permissive for UPDATE to authenticated
  using (((user_id = my_company()) OR is_platform_admin())) with check (((user_id = my_company()) OR is_platform_admin()));

drop policy if exists piq_ai_meter_no_client_delete on public.proqure_data;
create policy piq_ai_meter_no_client_delete on public.proqure_data as restrictive for DELETE to authenticated
  using ((store_key <> 'piq_ai_meter'::text));

drop policy if exists piq_ai_meter_no_client_insert on public.proqure_data;
create policy piq_ai_meter_no_client_insert on public.proqure_data as restrictive for INSERT to authenticated
  with check ((store_key <> 'piq_ai_meter'::text));

drop policy if exists piq_ai_meter_no_client_update on public.proqure_data;
create policy piq_ai_meter_no_client_update on public.proqure_data as restrictive for UPDATE to authenticated
  using ((store_key <> 'piq_ai_meter'::text)) with check ((store_key <> 'piq_ai_meter'::text));

drop policy if exists proqure_data_role_money_guard on public.proqure_data;
create policy proqure_data_role_money_guard on public.proqure_data as restrictive for ALL to authenticated
  using (((store_key <> ALL (ARRAY['piq_costs'::text, 'piq_quote_sets'::text, 'piq_quote_library'::text, 'piq_invoices'::text])) OR (proqure_member_role(user_id) = ANY (ARRAY['buyer'::text, 'manager'::text]))))
  with check (((store_key <> ALL (ARRAY['piq_costs'::text, 'piq_quote_sets'::text, 'piq_quote_library'::text, 'piq_invoices'::text])) OR (proqure_member_role(user_id) = ANY (ARRAY['buyer'::text, 'manager'::text]))));

drop policy if exists proqure_role_delete on public.proqure_data;
create policy proqure_role_delete on public.proqure_data as restrictive for DELETE to authenticated
  using ((proqure_member_rank((user_id)::text) >= proqure_required_rank(store_key)));

drop policy if exists proqure_role_insert on public.proqure_data;
create policy proqure_role_insert on public.proqure_data as restrictive for INSERT to authenticated
  with check ((proqure_member_rank((user_id)::text) >= proqure_required_rank(store_key)));

drop policy if exists proqure_role_update on public.proqure_data;
create policy proqure_role_update on public.proqure_data as restrictive for UPDATE to authenticated
  using ((proqure_member_rank((user_id)::text) >= proqure_required_rank(store_key)))
  with check ((proqure_member_rank((user_id)::text) >= proqure_required_rank(store_key)));

-- ---- members ---------------------------------------------------------------
-- NB: two overlapping permissive policy sets exist (members_* and
-- proqure_members_*). Permissive policies OR together, so the loosest wins;
-- the real role/escalation invariants are enforced by the members triggers,
-- not these policies. Reconciling the two sets is a tracked P2 cleanup.
drop policy if exists members_delete on public.members;
create policy members_delete on public.members as permissive for DELETE to authenticated
  using (((company_id = my_company()) OR is_platform_admin()));

drop policy if exists members_insert on public.members;
create policy members_insert on public.members as permissive for INSERT to authenticated
  with check (((company_id = my_company()) OR ((email = lower((auth.jwt() ->> 'email'::text))) AND (company_id = auth.uid())) OR is_platform_admin()));

drop policy if exists members_select on public.members;
create policy members_select on public.members as permissive for SELECT to authenticated
  using (((email = lower((auth.jwt() ->> 'email'::text))) OR (company_id = my_company()) OR is_platform_admin()));

drop policy if exists members_update on public.members;
create policy members_update on public.members as permissive for UPDATE to authenticated
  using (((company_id = my_company()) OR is_platform_admin())) with check (((company_id = my_company()) OR is_platform_admin()));

drop policy if exists proqure_members_delete on public.members;
create policy proqure_members_delete on public.members as permissive for DELETE to authenticated
  using ((proqure_member_rank((company_id)::text) >= 3));

drop policy if exists proqure_members_insert on public.members;
create policy proqure_members_insert on public.members as permissive for INSERT to authenticated
  with check (((((company_id)::text = (auth.uid())::text) AND ((user_id)::text = (auth.uid())::text) AND (lower(role) = 'manager'::text)) OR (proqure_member_rank((company_id)::text) >= 3)));

drop policy if exists proqure_members_select on public.members;
create policy proqure_members_select on public.members as permissive for SELECT to authenticated
  using (((proqure_member_rank((company_id)::text) >= 1) OR (lower(email) = lower((auth.jwt() ->> 'email'::text)))));

drop policy if exists proqure_members_update on public.members;
create policy proqure_members_update on public.members as permissive for UPDATE to authenticated
  using (((proqure_member_rank((company_id)::text) >= 3) OR (lower(email) = lower((auth.jwt() ->> 'email'::text))) OR ((user_id)::text = (auth.uid())::text)))
  with check (((proqure_member_rank((company_id)::text) >= 3) OR (lower(email) = lower((auth.jwt() ->> 'email'::text))) OR ((user_id)::text = (auth.uid())::text)));

-- ---- notifications ---------------------------------------------------------
drop policy if exists notif_member on public.notifications;
create policy notif_member on public.notifications as permissive for ALL to authenticated
  using ((proqure_member_role(company_id) IS NOT NULL)) with check ((proqure_member_role(company_id) IS NOT NULL));

drop policy if exists notif_role_guard on public.notifications;
create policy notif_role_guard on public.notifications as restrictive for ALL to authenticated
  using ((proqure_role_rank(proqure_member_role(company_id)) >= proqure_notif_min_rank(category)))
  with check ((proqure_role_rank(proqure_member_role(company_id)) >= proqure_notif_min_rank(category)));

-- ---- notification_state ----------------------------------------------------
drop policy if exists ns_self on public.notification_state;
create policy ns_self on public.notification_state as permissive for ALL to authenticated
  using ((user_id = auth.uid())) with check ((user_id = auth.uid()));

-- ---- announcements (read-only to clients; only service role writes) --------
drop policy if exists ann_read_scoped on public.announcements;
create policy ann_read_scoped on public.announcements as permissive for SELECT to public
  using (((target = 'all'::text) OR is_platform_admin() OR (EXISTS ( SELECT 1
     FROM members m
    WHERE ((m.user_id = auth.uid()) AND (m.company_id = ANY (announcements.company_ids)))))));

-- ---- proqure_billing (see VERIFY note above re: RLS enablement) ------------
drop policy if exists proqure_billing_select on public.proqure_billing;
create policy proqure_billing_select on public.proqure_billing as permissive for SELECT to authenticated
  using ((proqure_member_rank(company_id) >= 1));


-- ============================================================================
-- TRIGGERS  (dropped-if-exists then created)
-- The billing-guard trigger lives in proqure_billing_guard.sql, not here.
-- ============================================================================

drop trigger if exists proqure_guard_member_role on public.members;
CREATE TRIGGER proqure_guard_member_role BEFORE UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION proqure_guard_member_role();

drop trigger if exists proqure_members_guard_del on public.members;
CREATE TRIGGER proqure_members_guard_del BEFORE DELETE ON public.members
  FOR EACH ROW EXECUTE FUNCTION proqure_members_guard();

drop trigger if exists proqure_members_guard_ins on public.members;
CREATE TRIGGER proqure_members_guard_ins BEFORE INSERT ON public.members
  FOR EACH ROW EXECUTE FUNCTION proqure_members_guard();

drop trigger if exists proqure_members_guard_upd on public.members;
CREATE TRIGGER proqure_members_guard_upd BEFORE UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION proqure_members_guard();

drop trigger if exists proqure_members_join_notify on public.members;
CREATE TRIGGER proqure_members_join_notify AFTER UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION proqure_members_join_notify();

-- ============================================================================
-- END proqure_security_migration.sql
-- ============================================================================
