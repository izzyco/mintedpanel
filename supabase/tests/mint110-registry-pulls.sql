-- MINT-110 PR 3 registry pulls packet
-- (supabase/migrations/20261102150000_mint110_provider_registry_pulls.sql):
-- service_role inserts and nothing else; authenticated reads its own org's
-- rows when admin or specialist, and billing, another org and a user with no
-- membership read none; no API role updates, deletes or truncates; the
-- constraints refuse another org's provider, a malformed NPI, a non-object
-- reply or sourced and half a confirmation; both foreign keys cascade; and the
-- table has no trigger and one policy.
--
-- Run after all migrations, in a disposable PostgreSQL database, never
-- against hosted. CI's Migration dry-run job runs it after the MINT-134
-- packets:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/mint110-registry-pulls.sql
-- It needs a superuser connection and the anon, authenticated and
-- service_role roles (CI's seed creates them). Every row it writes is
-- synthetic and rolled back.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;
SET LOCAL client_min_messages = warning;

DO $$
BEGIN
  IF NOT coalesce(
    (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), false
  ) THEN
    RAISE EXCEPTION 'mint110-registry-pulls.sql must run as a superuser';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles
       WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'mint110-registry-pulls.sql needs the anon, authenticated and service_role roles';
  END IF;
  IF to_regclass('public.provider_registry_pulls') IS NULL THEN
    RAISE EXCEPTION 'mint110-registry-pulls.sql runs after supabase/migrations/20261102150000_mint110_provider_registry_pulls.sql';
  END IF;
END;
$$;

CREATE TEMP TABLE m110p_results (name text PRIMARY KEY, passed boolean NOT NULL);
CREATE TEMP TABLE m110p_calls (name text PRIMARY KEY, result text NOT NULL);

CREATE FUNCTION pg_temp.m110p_mark(p_name text, p_passed boolean) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO pg_temp.m110p_results VALUES (p_name, coalesce(p_passed, false))
$$;

-- Run p_statement (one statement returning at most one value) as p_role,
-- signed in as p_sub, and keep 'ok:<value>' or '<SQLSTATE>:<message>' under
-- p_name.
CREATE FUNCTION pg_temp.m110p_run(p_name text, p_role text, p_sub uuid, p_statement text)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_value text;
  v_state text;
  v_message text;
  v_result text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    IF p_role IS NOT NULL THEN
      EXECUTE format('SET LOCAL ROLE %I', p_role);
    END IF;
    EXECUTE p_statement INTO v_value;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claim.sub', '', true);
    v_result := 'ok:' || coalesce(v_value, 'null');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_result := v_state || ':' || v_message;
  END;
  INSERT INTO pg_temp.m110p_calls VALUES (p_name, v_result);
  RETURN v_result;
END;
$$;

-- What a member sees: '<rows of org A>/<rows of org B>'.
CREATE FUNCTION pg_temp.m110p_seen(p_name text, p_role text, p_sub uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.m110p_run(p_name, p_role, p_sub,
    'SELECT count(*) FILTER (WHERE org_id = ''11010000-0000-4000-a000-00000000000a'')::text'
    || ' || ''/'' || count(*) FILTER (WHERE org_id = ''11010000-0000-4000-a000-00000000000b'')::text'
    || ' FROM public.provider_registry_pulls')
$$;

-- An INSERT of one pull as p_role; the values are a template's, with p_org,
-- p_provider and the jsonb/npi overrides.
CREATE FUNCTION pg_temp.m110p_insert(
  p_name text, p_role text, p_org uuid, p_provider uuid,
  p_npi text DEFAULT '1234567893', p_reply text DEFAULT '{"npi": "1234567893"}',
  p_sourced text DEFAULT '{}', p_confirmed_at text DEFAULT 'NULL', p_confirmed_by text DEFAULT 'NULL'
) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.m110p_run(p_name, p_role, NULL,
    format('INSERT INTO public.provider_registry_pulls'
           || ' (org_id, provider_id, npi, pulled_at, pulled_by, reply, sourced, confirmed_at, confirmed_by)'
           || ' VALUES (%L::uuid, %L::uuid, %L, now(), %L::uuid, %s, %L::jsonb, %s, %s) RETURNING id::text',
           p_org, p_provider, p_npi, '11010000-0000-4000-a000-000000000001',
           CASE WHEN p_reply IS NULL THEN 'NULL' ELSE quote_literal(p_reply) || '::jsonb' END,
           p_sourced, p_confirmed_at, p_confirmed_by))
$$;

CREATE FUNCTION pg_temp.m110p_ok(p_result text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_result ~ '^ok:[0-9a-f-]{36}$' $$;

-- ---------------------------------------------------------------------------
-- Fixtures: org A (an admin, a specialist and a billing member) and org B (an
-- admin), a provider in each, and a signed-in user with no membership.
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (id, name) VALUES
  ('11010000-0000-4000-a000-00000000000a', 'MINT-110 Pulls Synthetic Org A'),
  ('11010000-0000-4000-a000-00000000000b', 'MINT-110 Pulls Synthetic Org B');
INSERT INTO auth.users (id, email) VALUES
  ('11010000-0000-4000-a000-000000000001', 'm110p-admin-a@example.invalid'),
  ('11010000-0000-4000-a000-000000000002', 'm110p-specialist-a@example.invalid'),
  ('11010000-0000-4000-a000-000000000003', 'm110p-billing-a@example.invalid'),
  ('11010000-0000-4000-a000-000000000004', 'm110p-admin-b@example.invalid'),
  ('11010000-0000-4000-a000-000000000005', 'm110p-nobody@example.invalid');
INSERT INTO public.profiles (id, full_name, email) VALUES
  ('11010000-0000-4000-a000-000000000001', 'MINT-110 Pulls Admin A', 'm110p-admin-a@example.invalid'),
  ('11010000-0000-4000-a000-000000000002', 'MINT-110 Pulls Specialist A', 'm110p-specialist-a@example.invalid'),
  ('11010000-0000-4000-a000-000000000003', 'MINT-110 Pulls Billing A', 'm110p-billing-a@example.invalid'),
  ('11010000-0000-4000-a000-000000000004', 'MINT-110 Pulls Admin B', 'm110p-admin-b@example.invalid'),
  ('11010000-0000-4000-a000-000000000005', 'MINT-110 Pulls Nobody', 'm110p-nobody@example.invalid');
INSERT INTO public.memberships (id, org_id, user_id, role) VALUES
  ('11010000-0000-4000-a000-0000000a0011', '11010000-0000-4000-a000-00000000000a',
   '11010000-0000-4000-a000-000000000001', 'admin'),
  ('11010000-0000-4000-a000-0000000a0012', '11010000-0000-4000-a000-00000000000a',
   '11010000-0000-4000-a000-000000000002', 'specialist'),
  ('11010000-0000-4000-a000-0000000a0013', '11010000-0000-4000-a000-00000000000a',
   '11010000-0000-4000-a000-000000000003', 'billing'),
  ('11010000-0000-4000-a000-0000000b0011', '11010000-0000-4000-a000-00000000000b',
   '11010000-0000-4000-a000-000000000004', 'admin');
INSERT INTO public.providers (id, org_id, first_name, last_name, npi) VALUES
  ('11010000-0000-4000-a000-0000000a0001', '11010000-0000-4000-a000-00000000000a',
   'Synthetic', 'Provider A', '1234567893'),
  ('11010000-0000-4000-a000-0000000b0001', '11010000-0000-4000-a000-00000000000b',
   'Synthetic', 'Provider B', '1234567893');

-- CI creates a minimally privileged service_role. Emulate the real Supabase
-- BYPASSRLS attribute only inside this rollback-only transaction (the
-- ROLLBACK undoes it), as mint19-atomic-sop.sql does.
ALTER ROLE service_role BYPASSRLS;

-- ---------------------------------------------------------------------------
-- The shape: RLS on, one SELECT policy, no trigger, the grants.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m110p_mark('rls_is_on',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provider_registry_pulls'::regclass));

SELECT pg_temp.m110p_mark('one_policy_and_it_is_select_for_authenticated',
  (SELECT count(*) = 1 AND bool_and(p.polcmd = 'r'
            AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'authenticated')])
     FROM pg_policy AS p
    WHERE p.polrelid = 'public.provider_registry_pulls'::regclass));

SELECT pg_temp.m110p_mark('no_trigger',
  NOT EXISTS (SELECT 1 FROM pg_trigger
               WHERE tgrelid = 'public.provider_registry_pulls'::regclass AND NOT tgisinternal));

SELECT pg_temp.m110p_mark('authenticated_may_only_select',
  has_table_privilege('authenticated', 'public.provider_registry_pulls', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.provider_registry_pulls',
                              'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));

SELECT pg_temp.m110p_mark('anon_has_nothing',
  NOT has_table_privilege('anon', 'public.provider_registry_pulls',
                          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));

SELECT pg_temp.m110p_mark('service_role_may_select_and_insert_only',
  has_table_privilege('service_role', 'public.provider_registry_pulls', 'SELECT')
  AND has_table_privilege('service_role', 'public.provider_registry_pulls', 'INSERT')
  AND NOT has_table_privilege('service_role', 'public.provider_registry_pulls',
                              'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));

SELECT pg_temp.m110p_mark('public_has_nothing',
  NOT has_table_privilege('public', 'public.provider_registry_pulls',
                          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));

-- ---------------------------------------------------------------------------
-- Writes: service_role inserts; nothing else writes.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m110p_mark('service_role_inserts_a_pull',
  pg_temp.m110p_ok(pg_temp.m110p_insert('insert_a', 'service_role',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000a0001',
    p_sourced => '{"credentials": "DPT", "licenses": [{"state": "CO", "number": "PT-4471"}]}',
    p_confirmed_at => 'now()', p_confirmed_by => '''11010000-0000-4000-a000-000000000001''::uuid')));

SELECT pg_temp.m110p_mark('service_role_inserts_a_pull_with_no_record',
  pg_temp.m110p_ok(pg_temp.m110p_insert('insert_a_no_record', 'service_role',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000a0001',
    p_reply => NULL)));

SELECT pg_temp.m110p_mark('service_role_inserts_for_org_b',
  pg_temp.m110p_ok(pg_temp.m110p_insert('insert_b', 'service_role',
    '11010000-0000-4000-a000-00000000000b', '11010000-0000-4000-a000-0000000b0001')));

SELECT pg_temp.m110p_mark('an_admin_cannot_insert',
  pg_temp.m110p_insert('refuse_admin_insert', 'authenticated',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000a0001')
    LIKE '42501:%');

SELECT pg_temp.m110p_mark('anon_cannot_insert',
  pg_temp.m110p_insert('refuse_anon_insert', 'anon',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000a0001')
    LIKE '42501:%');

SELECT pg_temp.m110p_mark('an_admin_cannot_update',
  pg_temp.m110p_run('refuse_admin_update', 'authenticated', '11010000-0000-4000-a000-000000000001',
    'UPDATE public.provider_registry_pulls SET sourced = ''{}''::jsonb RETURNING id::text')
    LIKE '42501:%');

SELECT pg_temp.m110p_mark('an_admin_cannot_delete',
  pg_temp.m110p_run('refuse_admin_delete', 'authenticated', '11010000-0000-4000-a000-000000000001',
    'DELETE FROM public.provider_registry_pulls RETURNING id::text')
    LIKE '42501:%');

SELECT pg_temp.m110p_mark('an_admin_cannot_truncate',
  pg_temp.m110p_run('refuse_admin_truncate', 'authenticated', '11010000-0000-4000-a000-000000000001',
    'TRUNCATE public.provider_registry_pulls')
    LIKE '42501:%');

SELECT pg_temp.m110p_mark('service_role_cannot_update',
  pg_temp.m110p_run('refuse_service_update', 'service_role', NULL,
    'UPDATE public.provider_registry_pulls SET sourced = ''{}''::jsonb RETURNING id::text')
    LIKE '42501:%');

SELECT pg_temp.m110p_mark('service_role_cannot_delete',
  pg_temp.m110p_run('refuse_service_delete', 'service_role', NULL,
    'DELETE FROM public.provider_registry_pulls RETURNING id::text')
    LIKE '42501:%');

SELECT pg_temp.m110p_mark('anon_cannot_delete',
  pg_temp.m110p_run('refuse_anon_delete', 'anon', NULL,
    'DELETE FROM public.provider_registry_pulls RETURNING id::text')
    LIKE '42501:%');

-- ---------------------------------------------------------------------------
-- Reads: the org's admins and specialists see its rows only.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m110p_mark('admin_a_sees_org_a_only',
  pg_temp.m110p_seen('seen_admin_a', 'authenticated', '11010000-0000-4000-a000-000000000001')
    = 'ok:2/0');

SELECT pg_temp.m110p_mark('specialist_a_sees_org_a_only',
  pg_temp.m110p_seen('seen_specialist_a', 'authenticated', '11010000-0000-4000-a000-000000000002')
    = 'ok:2/0');

SELECT pg_temp.m110p_mark('billing_a_sees_nothing',
  pg_temp.m110p_seen('seen_billing_a', 'authenticated', '11010000-0000-4000-a000-000000000003')
    = 'ok:0/0');

SELECT pg_temp.m110p_mark('admin_b_sees_org_b_only',
  pg_temp.m110p_seen('seen_admin_b', 'authenticated', '11010000-0000-4000-a000-000000000004')
    = 'ok:0/1');

SELECT pg_temp.m110p_mark('a_user_with_no_membership_sees_nothing',
  pg_temp.m110p_seen('seen_nobody', 'authenticated', '11010000-0000-4000-a000-000000000005')
    = 'ok:0/0');

SELECT pg_temp.m110p_mark('anon_cannot_select',
  pg_temp.m110p_seen('seen_anon', 'anon', NULL) LIKE '42501:%');

SELECT pg_temp.m110p_mark('the_row_reads_back_as_written',
  pg_temp.m110p_run('read_back', 'authenticated', '11010000-0000-4000-a000-000000000001',
    'SELECT (sourced->>''credentials'') || ''|'' || (sourced->''licenses''->0->>''number'')'
    || ' || ''|'' || (confirmed_by IS NOT NULL)::text || ''|'' || (reply->>''npi'')'
    || ' FROM public.provider_registry_pulls WHERE confirmed_at IS NOT NULL')
    = 'ok:DPT|PT-4471|true|1234567893');

-- ---------------------------------------------------------------------------
-- Constraints.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m110p_mark('another_orgs_provider_is_refused',
  pg_temp.m110p_insert('refuse_cross_org_provider', 'service_role',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000b0001')
    LIKE '23503:%');

SELECT pg_temp.m110p_mark('a_malformed_npi_is_refused',
  pg_temp.m110p_insert('refuse_npi', 'service_role',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000a0001',
    p_npi => '123-456-7893') LIKE '23514:%'
  AND pg_temp.m110p_insert('refuse_npi_short', 'service_role',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000a0001',
    p_npi => '123456789') LIKE '23514:%');

SELECT pg_temp.m110p_mark('a_reply_that_is_not_an_object_is_refused',
  pg_temp.m110p_insert('refuse_reply', 'service_role',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000a0001',
    p_reply => '["1234567893"]') LIKE '23514:%');

SELECT pg_temp.m110p_mark('sourced_that_is_not_an_object_is_refused',
  pg_temp.m110p_insert('refuse_sourced', 'service_role',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000a0001',
    p_sourced => '"credentials"') LIKE '23514:%');

SELECT pg_temp.m110p_mark('half_a_confirmation_is_refused',
  pg_temp.m110p_insert('refuse_confirmed_at_only', 'service_role',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000a0001',
    p_confirmed_at => 'now()') LIKE '23514:%'
  AND pg_temp.m110p_insert('refuse_confirmed_by_only', 'service_role',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000a0001',
    p_confirmed_by => '''11010000-0000-4000-a000-000000000001''::uuid') LIKE '23514:%');

-- ---------------------------------------------------------------------------
-- The cascades: deleting a provider removes its rows, and both foreign keys
-- (the org, and the org's provider) cascade, so offboarding still removes them.
-- ---------------------------------------------------------------------------
DELETE FROM public.providers WHERE id = '11010000-0000-4000-a000-0000000a0001';
SELECT pg_temp.m110p_mark('deleting_a_provider_removes_its_pulls',
  NOT EXISTS (SELECT 1 FROM public.provider_registry_pulls
               WHERE provider_id = '11010000-0000-4000-a000-0000000a0001')
  AND EXISTS (SELECT 1 FROM public.provider_registry_pulls
               WHERE provider_id = '11010000-0000-4000-a000-0000000b0001'));

SELECT pg_temp.m110p_mark('both_foreign_keys_cascade',
  (SELECT count(*) = 2 AND bool_and(c.confdeltype = 'c')
     FROM pg_constraint AS c
    WHERE c.conrelid = 'public.provider_registry_pulls'::regclass AND c.contype = 'f')
  AND EXISTS (SELECT 1 FROM pg_constraint AS c
               WHERE c.conrelid = 'public.provider_registry_pulls'::regclass
                 AND c.contype = 'f'
                 AND c.confrelid = 'public.providers'::regclass
                 AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (org_id, provider_id)%'));

-- ---------------------------------------------------------------------------
-- Report.
-- ---------------------------------------------------------------------------
SELECT name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END
  FROM pg_temp.m110p_results ORDER BY name;

SELECT 'call ' || c.name || ' -> ' || c.result
  FROM pg_temp.m110p_calls AS c
 WHERE EXISTS (SELECT 1 FROM pg_temp.m110p_results WHERE NOT passed)
 ORDER BY c.name;

DO $$
DECLARE v_failed text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO v_failed
    FROM pg_temp.m110p_results WHERE NOT passed;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'MINT-110 registry pulls assertions failed: %', v_failed;
  END IF;
END;
$$;

-- The ROLLBACK also undoes service_role's BYPASSRLS.
ROLLBACK;
\echo MINT-110 registry pulls packet passed.
