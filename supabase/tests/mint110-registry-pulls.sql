-- MINT-110 PR 3 registry pulls packet
-- (supabase/migrations/20261102150000_mint110_provider_registry_pulls.sql):
-- service_role selects and inserts and nothing else; anon and authenticated
-- have nothing (there is no reader yet), so no API role but service_role
-- inserts, and none updates, deletes or truncates; the constraints refuse
-- another org's provider, a malformed NPI, a non-object reply or sourced and
-- a NULL confirmed, which defaults to false; both foreign keys cascade; and
-- the table has no trigger and no policy.
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

-- An INSERT of one pull as p_role; the values are a template's, with p_org,
-- p_provider and the jsonb/npi overrides. p_confirmed is SQL text ('true',
-- 'NULL'); left out, the column takes its default.
CREATE FUNCTION pg_temp.m110p_insert(
  p_name text, p_role text, p_org uuid, p_provider uuid,
  p_npi text DEFAULT '1234567893', p_reply text DEFAULT '{"npi": "1234567893"}',
  p_sourced text DEFAULT '{}', p_confirmed text DEFAULT NULL
) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.m110p_run(p_name, p_role, NULL,
    format('INSERT INTO public.provider_registry_pulls'
           || ' (org_id, provider_id, npi, pulled_at, pulled_by, reply, sourced%s)'
           || ' VALUES (%L::uuid, %L::uuid, %L, now(), %L::uuid, %s, %L::jsonb%s) RETURNING id::text',
           CASE WHEN p_confirmed IS NULL THEN '' ELSE ', confirmed' END,
           p_org, p_provider, p_npi, '11010000-0000-4000-a000-000000000001',
           CASE WHEN p_reply IS NULL THEN 'NULL' ELSE quote_literal(p_reply) || '::jsonb' END,
           p_sourced,
           CASE WHEN p_confirmed IS NULL THEN '' ELSE ', ' || p_confirmed END))
$$;

CREATE FUNCTION pg_temp.m110p_ok(p_result text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_result ~ '^ok:[0-9a-f-]{36}$' $$;

-- ---------------------------------------------------------------------------
-- Fixtures: org A with an admin, org B, and a provider in each.
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (id, name) VALUES
  ('11010000-0000-4000-a000-00000000000a', 'MINT-110 Pulls Synthetic Org A'),
  ('11010000-0000-4000-a000-00000000000b', 'MINT-110 Pulls Synthetic Org B');
INSERT INTO auth.users (id, email) VALUES
  ('11010000-0000-4000-a000-000000000001', 'm110p-admin-a@example.invalid');
INSERT INTO public.profiles (id, full_name, email) VALUES
  ('11010000-0000-4000-a000-000000000001', 'MINT-110 Pulls Admin A', 'm110p-admin-a@example.invalid');
INSERT INTO public.memberships (id, org_id, user_id, role) VALUES
  ('11010000-0000-4000-a000-0000000a0011', '11010000-0000-4000-a000-00000000000a',
   '11010000-0000-4000-a000-000000000001', 'admin');
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
-- The shape: RLS on, no policy, no trigger, the grants.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m110p_mark('rls_is_on',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provider_registry_pulls'::regclass));

SELECT pg_temp.m110p_mark('no_policy',
  NOT EXISTS (SELECT 1 FROM pg_policy
               WHERE polrelid = 'public.provider_registry_pulls'::regclass));

SELECT pg_temp.m110p_mark('no_trigger',
  NOT EXISTS (SELECT 1 FROM pg_trigger
               WHERE tgrelid = 'public.provider_registry_pulls'::regclass AND NOT tgisinternal));

SELECT pg_temp.m110p_mark('authenticated_has_nothing',
  NOT has_table_privilege('authenticated', 'public.provider_registry_pulls',
                          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));

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
SELECT pg_temp.m110p_mark('service_role_inserts_a_confirmed_pull',
  pg_temp.m110p_ok(pg_temp.m110p_insert('insert_a', 'service_role',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000a0001',
    p_sourced => '{"credentials": "DPT", "licenses": [{"state": "CO", "number": "PT-4471"}]}',
    p_confirmed => 'true')));

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
-- What was written: the route's insert reads its row back as service_role;
-- confirmed defaults to false.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m110p_mark('the_row_reads_back_as_written',
  pg_temp.m110p_run('read_back', 'service_role', NULL,
    'SELECT (sourced->>''credentials'') || ''|'' || (sourced->''licenses''->0->>''number'')'
    || ' || ''|'' || (reply->>''npi'') || ''|'' || (count(*) OVER ())::text'
    || ' FROM public.provider_registry_pulls WHERE confirmed')
    = 'ok:DPT|PT-4471|1234567893|1');

SELECT pg_temp.m110p_mark('confirmed_defaults_to_false',
  (SELECT count(*) = 2 AND bool_and(NOT confirmed)
     FROM public.provider_registry_pulls
    WHERE org_id IN ('11010000-0000-4000-a000-00000000000a',
                     '11010000-0000-4000-a000-00000000000b')
      AND sourced = '{}'::jsonb));

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

SELECT pg_temp.m110p_mark('a_null_confirmed_is_refused',
  pg_temp.m110p_insert('refuse_null_confirmed', 'service_role',
    '11010000-0000-4000-a000-00000000000a', '11010000-0000-4000-a000-0000000a0001',
    p_confirmed => 'NULL') LIKE '23502:%');

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
