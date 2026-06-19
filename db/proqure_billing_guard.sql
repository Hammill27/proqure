-- ============================================================================
-- proqure_billing_guard.sql
-- ----------------------------------------------------------------------------
-- Billing-field freeze. A browser session (role anon/authenticated) cannot
-- set or change the five billing fields in piq_settings:
--   plan, trialEndsAt, subscriptionStatus, stripeCustomerId, renewsAt
-- On INSERT a client write is forced to plan='trial' + a 14-day trial window;
-- on UPDATE those five fields are frozen to their previous values. The server
-- (service_role) and direct SQL/migration connections remain authoritative, so
-- Stripe-driven plan changes via stripe-webhook.js still work.
--
-- This is the keystone behind api/ai.js trusting trialEndsAt as
-- server-authoritative. Regenerated from live DDL 2026-06-19.
--
-- Apply order: run AFTER proqure_security_migration.sql.
-- Idempotent: CREATE OR REPLACE + drop-trigger-if-exists.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.proqure_billing_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  _role      text;
  _is_client boolean;
  _new       jsonb;
  _old       jsonb;
begin
  -- Only police the settings object; everything else passes straight through.
  if (NEW.store_key is distinct from 'piq_settings') then
    return NEW;
  end if;

  -- Who is writing? Browser sessions present role 'anon' or 'authenticated'.
  -- The service role presents 'service_role'. Direct SQL here has no JWT claims,
  -- so it is treated as privileged (so manual admin fixes are never blocked).
  _role := coalesce(
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );
  _is_client := _role in ('anon', 'authenticated');

  _new := coalesce(NEW.value, '{}'::jsonb)::jsonb;

  -- ---- INSERT: establish billing truth from the server, never the client ----
  if (TG_OP = 'INSERT') then
    if (_is_client) or ((_new ->> 'plan') is null) then
      _new := jsonb_set(_new, '{plan}', '"trial"'::jsonb, true);
    end if;
    if (_is_client) or ((_new ->> 'trialEndsAt') is null) then
      _new := jsonb_set(_new, '{trialEndsAt}', to_jsonb((now() + interval '14 days')), true);
    end if;
    NEW.value := _new;
    return NEW;
  end if;

  -- ---- UPDATE by a browser: freeze the five billing fields to their old values
  if (TG_OP = 'UPDATE' and _is_client) then
    _old := coalesce(OLD.value, '{}'::jsonb)::jsonb;
    _new := (_new
              - 'plan' - 'subscriptionStatus' - 'stripeCustomerId'
              - 'trialEndsAt' - 'renewsAt')
            || (
              select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
              from jsonb_each(_old) as e(k, v)
              where k in ('plan','subscriptionStatus','stripeCustomerId','trialEndsAt','renewsAt')
            );
    NEW.value := _new;
    return NEW;
  end if;

  -- Privileged update (service_role / SQL): leave exactly as written.
  return NEW;
end;
$function$;

drop trigger if exists trg_proqure_billing_guard on public.proqure_data;
CREATE TRIGGER trg_proqure_billing_guard BEFORE INSERT OR UPDATE ON public.proqure_data
  FOR EACH ROW EXECUTE FUNCTION proqure_billing_guard();

-- ============================================================================
-- END proqure_billing_guard.sql
-- ============================================================================
