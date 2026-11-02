-- MINT-134 workflow advisories packet: record_workflow_advisory,
-- record_job_advisory, resolve_workflow_advisories, the context validator,
-- the append-only guard and the ledger's access boundary
-- (supabase/migrations/20261101090000_mint134_workflow_advisories.sql).
--
-- Run after all migrations in a disposable PostgreSQL database, never against
-- hosted. CI's Migration dry-run job runs it right after applying them:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/mint134-workflow-advisories.sql
-- Every row it writes is synthetic and rolled back.
--
-- It needs a superuser connection (it writes fixtures, switches role, creates
-- a throwaway role) and the anon, authenticated and service_role roles. CI
-- creates those as bare NOLOGIN roles, so service_role has no BYPASSRLS here:
-- the packet reads workflow_advisories as the superuser. The RPCs are
-- SECURITY DEFINER, so they read memberships and the record tables as their
-- owner either way. The first block checks the prerequisites and stops with a
-- plain message.
--
-- Callers. pg_temp.m134_call runs one statement as a role (SET LOCAL ROLE,
-- which is what PostgREST does from the verified JWT) with
-- request.jwt.claim.sub set for auth.uid(), and returns 'ok:<value>' or
-- '<SQLSTATE>:<message>'. The role and the claim end with the call: a failure
-- rolls its block back, and a success resets both. The RPC reads the caller
-- from current_setting('role'), so a superuser with no role set is "any other
-- caller".
--
-- A check reads its statement's snapshot, so a write whose effect is checked
-- runs as its own statement first, never inside the checking statement.
--
-- The context cases between the context-cases markers are also read by
-- src/lib/advisoryChecks.test.ts, which runs each through the TypeScript
-- validator: the SQL and the code accept and refuse exactly the same cases.
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
    RAISE EXCEPTION 'mint134-workflow-advisories.sql must run as a superuser';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles
       WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'mint134-workflow-advisories.sql needs the anon, authenticated and service_role roles';
  END IF;
  IF to_regclass('public.workflow_advisories') IS NULL
     OR to_regprocedure('public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)') IS NULL
     OR to_regprocedure('public.record_job_advisory(text, uuid, text, text, text, uuid, jsonb)') IS NULL
     OR to_regprocedure('public.resolve_workflow_advisories(uuid, text, text, uuid, uuid)') IS NULL
     OR to_regprocedure('private.workflow_advisory_context_valid(jsonb)') IS NULL
     OR to_regprocedure('app_authz.is_restricted_external()') IS NULL
     OR to_regprocedure('app_authz.is_restricted_external_user(uuid)') IS NULL
     OR to_regclass('private.client_identity_classifications') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'mint134-workflow-advisories.sql runs after supabase/migrations/20261101090000_mint134_workflow_advisories.sql';
  END IF;
END;
$$;

-- Hosted Supabase grants authenticated USAGE on the auth schema; CI's plain
-- PostgreSQL seed does not. Mirror the hosted grant inside this rollback-only
-- transaction (the mint19 / mint58 precedent). The RPCs reach auth.uid() as
-- their owner, so they don't need it; it keeps this database's authenticated
-- role the one the RPCs meet on hosted.
GRANT USAGE ON SCHEMA auth TO authenticated;

CREATE TEMP TABLE m134_results (name text PRIMARY KEY, passed boolean NOT NULL);
CREATE TEMP TABLE m134_calls (name text PRIMARY KEY, result text NOT NULL);
CREATE TEMP TABLE m134_records (record_table text PRIMARY KEY, record_id uuid NOT NULL);
CREATE TEMP TABLE m134_context_cases (
  label text PRIMARY KEY,
  expect_valid boolean NOT NULL,
  context text NOT NULL
);

CREATE FUNCTION pg_temp.m134_mark(p_name text, p_passed boolean) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO pg_temp.m134_results VALUES (p_name, coalesce(p_passed, false))
$$;

-- Run p_statement (one SELECT of one value) as p_role (NULL: stay the
-- superuser), signed in as p_sub (NULL: no auth.uid()).
CREATE FUNCTION pg_temp.m134_call(p_role text, p_sub uuid, p_statement text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_value text;
  v_state text;
  v_message text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    IF p_role IS NOT NULL THEN
      EXECUTE format('SET LOCAL ROLE %I', p_role);
    END IF;
    EXECUTE p_statement INTO v_value;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RETURN 'ok:' || coalesce(v_value, 'null');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    RETURN v_state || ':' || v_message;
  END;
END;
$$;

-- m134_call, keeping the result under a name for later checks and for the
-- failure report at the end.
CREATE FUNCTION pg_temp.m134_run(p_name text, p_role text, p_sub uuid, p_statement text)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_result text;
BEGIN
  v_result := pg_temp.m134_call(p_role, p_sub, p_statement);
  INSERT INTO pg_temp.m134_calls VALUES (p_name, v_result);
  RETURN v_result;
END;
$$;

CREATE FUNCTION pg_temp.m134_result(p_name text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT result FROM pg_temp.m134_calls WHERE name = p_name
$$;

-- The row id an ok call returned, else NULL.
CREATE FUNCTION pg_temp.m134_ok_id(p_name text) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN result ~ '^ok:[0-9a-f-]{36}$' THEN substr(result, 4)::uuid END
    FROM pg_temp.m134_calls WHERE name = p_name
$$;

CREATE FUNCTION pg_temp.m134_rec(
  p_org uuid, p_key text, p_table text, p_record uuid,
  p_source text DEFAULT 'panel', p_context text DEFAULT '{}', p_actor uuid DEFAULT NULL,
  p_severity text DEFAULT 'advisory'
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    'SELECT public.record_workflow_advisory(%L::uuid, %L, %L, %L, %L::uuid, %L, %L::jsonb, %L::uuid)',
    p_org, p_key, p_severity, p_table, p_record, p_source, p_context, p_actor)
$$;

CREATE FUNCTION pg_temp.m134_job(
  p_job text, p_org uuid, p_key text, p_table text, p_record uuid,
  p_context text DEFAULT '{}', p_severity text DEFAULT 'advisory'
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    'SELECT public.record_job_advisory(%L, %L::uuid, %L, %L, %L, %L::uuid, %L::jsonb)',
    p_job, p_org, p_key, p_severity, p_table, p_record, p_context)
$$;

CREATE FUNCTION pg_temp.m134_resolve(
  p_org uuid, p_key text, p_table text, p_record uuid, p_by uuid DEFAULT NULL
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    'SELECT public.resolve_workflow_advisories(%L::uuid, %L, %L, %L::uuid, %L::uuid)',
    p_org, p_key, p_table, p_record, p_by)
$$;

-- A direct superuser insert, for the table's own CHECKs and index.
CREATE FUNCTION pg_temp.m134_insert(p_columns text, p_values text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    'WITH i AS (INSERT INTO public.workflow_advisories (%s) VALUES (%s) RETURNING 1) SELECT count(*) FROM i',
    p_columns, p_values)
$$;

-- A direct update of one row, for the append-only guard.
CREATE FUNCTION pg_temp.m134_update(p_set text, p_id uuid) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    'WITH u AS (UPDATE public.workflow_advisories SET %s WHERE id = %L RETURNING 1) SELECT count(*) FROM u',
    p_set, p_id)
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: org A (admin, specialist, billing), org B (admin), a signed-in
-- user with no membership, and one record in org A in every record table
-- (the registry additions' parties, organizations and memberships included;
-- notification_sequences is not on main, and
-- mint134-registry-additions.sql covers it). Organizations seed their roster
-- templates by trigger; the mapping uses one.
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (id, name) VALUES
  ('13400000-0000-4000-a000-00000000000a', 'MINT-134 Synthetic Org A'),
  ('13400000-0000-4000-a000-00000000000b', 'MINT-134 Synthetic Org B');
INSERT INTO auth.users (id, email) VALUES
  ('13400000-0000-4000-a000-000000000001', 'm134-admin-a@example.invalid'),
  ('13400000-0000-4000-a000-000000000002', 'm134-specialist-a@example.invalid'),
  ('13400000-0000-4000-a000-000000000003', 'm134-billing-a@example.invalid'),
  ('13400000-0000-4000-a000-000000000004', 'm134-admin-b@example.invalid'),
  ('13400000-0000-4000-a000-000000000005', 'm134-no-org@example.invalid'),
  ('13400000-0000-4000-a000-000000000006', 'm134-client-a@example.invalid'),
  ('13400000-0000-4000-a000-000000000007', 'm134-staff-client-a@example.invalid');
INSERT INTO public.profiles (id, full_name, email) VALUES
  ('13400000-0000-4000-a000-000000000001', 'MINT-134 Admin A', 'm134-admin-a@example.invalid'),
  ('13400000-0000-4000-a000-000000000002', 'MINT-134 Specialist A', 'm134-specialist-a@example.invalid'),
  ('13400000-0000-4000-a000-000000000003', 'MINT-134 Billing A', 'm134-billing-a@example.invalid'),
  ('13400000-0000-4000-a000-000000000004', 'MINT-134 Admin B', 'm134-admin-b@example.invalid'),
  ('13400000-0000-4000-a000-000000000005', 'MINT-134 No Org', 'm134-no-org@example.invalid'),
  ('13400000-0000-4000-a000-000000000006', 'MINT-134 Client A', 'm134-client-a@example.invalid'),
  ('13400000-0000-4000-a000-000000000007', 'MINT-134 Staff Client A', 'm134-staff-client-a@example.invalid');
INSERT INTO public.memberships (org_id, user_id, role) VALUES
  ('13400000-0000-4000-a000-00000000000a', '13400000-0000-4000-a000-000000000001', 'admin'),
  ('13400000-0000-4000-a000-00000000000a', '13400000-0000-4000-a000-000000000002', 'specialist'),
  ('13400000-0000-4000-a000-00000000000a', '13400000-0000-4000-a000-000000000003', 'billing'),
  ('13400000-0000-4000-a000-00000000000b', '13400000-0000-4000-a000-000000000004', 'admin'),
  ('13400000-0000-4000-a000-00000000000a', '13400000-0000-4000-a000-000000000006', 'specialist'),
  ('13400000-0000-4000-a000-00000000000a', '13400000-0000-4000-a000-000000000007', 'specialist');
-- E6.12: user 6 is also an active restricted client identity of org A, so
-- app_authz.is_restricted_external() is true for that session. User 7 has
-- the same classification but is active internal staff, which exempts it.
INSERT INTO private.client_identity_classifications (auth_user_id, org_id, email_normalized, state)
VALUES ('13400000-0000-4000-a000-000000000006', '13400000-0000-4000-a000-00000000000a',
        'm134-client-a@example.invalid', 'active'),
       ('13400000-0000-4000-a000-000000000007', '13400000-0000-4000-a000-00000000000a',
        'm134-staff-client-a@example.invalid', 'active');
INSERT INTO private.internal_staff (auth_user_id, org_id, staff_role, manifest_version)
VALUES ('13400000-0000-4000-a000-000000000007', '13400000-0000-4000-a000-00000000000a',
        'specialist', 'mint134-synthetic');
INSERT INTO public.providers (id, org_id, first_name, last_name) VALUES
  ('13400000-0000-4000-a000-0000000a0001', '13400000-0000-4000-a000-00000000000a',
   'Synthetic', 'Provider A'),
  ('13400000-0000-4000-a000-0000000a0011', '13400000-0000-4000-a000-00000000000a',
   'Synthetic', 'Provider A2'),
  ('13400000-0000-4000-a000-0000000b0001', '13400000-0000-4000-a000-00000000000b',
   'Synthetic', 'Provider B');
INSERT INTO public.payers (id, org_id, name) VALUES
  ('13400000-0000-4000-a000-0000000a0002', '13400000-0000-4000-a000-00000000000a',
   'MINT-134 Synthetic Payer A'),
  ('13400000-0000-4000-a000-0000000b0002', '13400000-0000-4000-a000-00000000000b',
   'MINT-134 Synthetic Payer B');
INSERT INTO public.credential_cases (id, org_id, provider_id, payer_id, state) VALUES
  ('13400000-0000-4000-a000-0000000a0003', '13400000-0000-4000-a000-00000000000a',
   '13400000-0000-4000-a000-0000000a0001', '13400000-0000-4000-a000-0000000a0002', 'KS');
INSERT INTO public.tasks (id, org_id, case_id, title, status, sop_content) VALUES
  ('13400000-0000-4000-a000-0000000a0004', '13400000-0000-4000-a000-00000000000a',
   '13400000-0000-4000-a000-0000000a0003', 'MINT-134 Synthetic Task', 'not_started',
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb);
INSERT INTO public.touches
  (id, org_id, case_id, touch_date, entry_type, touch_type, outcome, coordinator_id, source)
VALUES
  ('13400000-0000-4000-a000-0000000a0005', '13400000-0000-4000-a000-00000000000a',
   '13400000-0000-4000-a000-0000000a0003', current_date, 'touchpoint', 'portal', 'submitted',
   '13400000-0000-4000-a000-000000000001', 'extension');
INSERT INTO public.provider_groups (id, org_id, name) VALUES
  ('13400000-0000-4000-a000-0000000a0006', '13400000-0000-4000-a000-00000000000a',
   'MINT-134 Synthetic Group A');
INSERT INTO public.facilities (id, org_id, group_id, name) VALUES
  ('13400000-0000-4000-a000-0000000a0007', '13400000-0000-4000-a000-00000000000a',
   '13400000-0000-4000-a000-0000000a0006', 'MINT-134 Synthetic Facility A'),
  ('13400000-0000-4000-a000-0000000a0012', '13400000-0000-4000-a000-00000000000a',
   '13400000-0000-4000-a000-0000000a0006', 'MINT-134 Synthetic Facility A2');
INSERT INTO public.import_runs (id, org_id, created_by, source) VALUES
  ('13400000-0000-4000-a000-0000000a0008', '13400000-0000-4000-a000-00000000000a',
   '13400000-0000-4000-a000-000000000001', 'internal');
INSERT INTO public.roster_mappings (id, org_id, template_id, created_by, name, grain)
SELECT '13400000-0000-4000-a000-0000000a0009', t.org_id, t.id,
       '13400000-0000-4000-a000-000000000001', 'MINT-134 Synthetic Mapping', 'provider'
  FROM public.roster_templates AS t
 WHERE t.org_id = '13400000-0000-4000-a000-00000000000a'
 ORDER BY t.slug
 LIMIT 1;
INSERT INTO public.sop_templates (id, org_id, name, task_definitions, case_type) VALUES
  ('13400000-0000-4000-a000-0000000a0010', '13400000-0000-4000-a000-00000000000a',
   'MINT-134 Synthetic SOP', '[]'::jsonb, 'enrollment');
INSERT INTO public.parties (id, org_id, name, created_by) VALUES
  ('13400000-0000-4000-a000-0000000a0013', '13400000-0000-4000-a000-00000000000a',
   'MINT-134 Synthetic Contact A', '13400000-0000-4000-a000-000000000001');

INSERT INTO pg_temp.m134_records VALUES
  ('providers', '13400000-0000-4000-a000-0000000a0001'),
  ('credential_cases', '13400000-0000-4000-a000-0000000a0003'),
  ('tasks', '13400000-0000-4000-a000-0000000a0004'),
  ('touches', '13400000-0000-4000-a000-0000000a0005'),
  ('provider_groups', '13400000-0000-4000-a000-0000000a0006'),
  ('facilities', '13400000-0000-4000-a000-0000000a0007'),
  ('import_runs', '13400000-0000-4000-a000-0000000a0008'),
  ('roster_mappings', '13400000-0000-4000-a000-0000000a0009'),
  ('sop_templates', '13400000-0000-4000-a000-0000000a0010'),
  ('parties', '13400000-0000-4000-a000-0000000a0013'),
  ('organizations', '13400000-0000-4000-a000-00000000000a');
INSERT INTO pg_temp.m134_records
SELECT 'memberships', m.id FROM public.memberships AS m
 WHERE m.org_id = '13400000-0000-4000-a000-00000000000a'
   AND m.user_id = '13400000-0000-4000-a000-000000000001';

-- A role that holds EXECUTE but is neither authenticated nor service_role.
CREATE ROLE m134_other_caller NOLOGIN;
GRANT USAGE ON SCHEMA public TO m134_other_caller;
GRANT EXECUTE ON FUNCTION public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)
  TO m134_other_caller;
GRANT EXECUTE ON FUNCTION public.record_job_advisory(text, uuid, text, text, text, uuid, jsonb)
  TO m134_other_caller;
GRANT EXECUTE ON FUNCTION public.resolve_workflow_advisories(uuid, text, text, uuid, uuid)
  TO m134_other_caller;

SELECT pg_temp.m134_mark('fixtures_one_org_a_record_in_every_record_table',
  (SELECT count(*) = 12 FROM pg_temp.m134_records)
  AND private.workflow_advisory_record_in_org('providers', '13400000-0000-4000-a000-0000000a0001', '13400000-0000-4000-a000-00000000000a')
  AND (SELECT bool_and(private.workflow_advisory_record_in_org(
                         record_table, record_id, '13400000-0000-4000-a000-00000000000a'))
         FROM pg_temp.m134_records));

-- ---------------------------------------------------------------------------
-- Shape and access boundary.
-- ---------------------------------------------------------------------------
-- Mission Control reads these names verbatim; there is no record_label.
SELECT pg_temp.m134_mark('columns_are_the_mission_control_contract',
  (SELECT array_agg(column_name::text ORDER BY ordinal_position)
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workflow_advisories')
  = ARRAY['id', 'org_id', 'check_key', 'severity_at_time', 'record_table', 'record_id',
          'actor_id', 'actor_role', 'source', 'job', 'context', 'bypassed_at',
          'resolved_at', 'resolved_by']);

SELECT pg_temp.m134_mark('rls_is_enabled_with_no_policy',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.workflow_advisories'::regclass)
  AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'workflow_advisories'
  ));

-- A comma list is true when ANY listed privilege is held, so NOT (list) means none.
SELECT pg_temp.m134_mark('anon_authenticated_and_public_hold_no_table_privilege',
  NOT has_table_privilege('anon', 'public.workflow_advisories',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  AND NOT has_table_privilege('authenticated', 'public.workflow_advisories',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  AND NOT has_table_privilege('public', 'public.workflow_advisories',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));

SELECT pg_temp.m134_mark('service_role_reads_and_writes_only_through_the_rpcs',
  has_table_privilege('service_role', 'public.workflow_advisories', 'SELECT')
  AND NOT has_table_privilege('service_role', 'public.workflow_advisories',
        'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));

SELECT pg_temp.m134_mark('record_rpc_executes_for_authenticated_and_service_role_only',
  has_function_privilege('authenticated',
    'public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)', 'EXECUTE')
  AND has_function_privilege('service_role',
    'public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public',
    'public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)', 'EXECUTE'));

SELECT pg_temp.m134_mark('job_and_resolve_rpcs_execute_for_service_role_only',
  (SELECT bool_and(
            has_function_privilege('service_role', f, 'EXECUTE')
            AND NOT has_function_privilege('authenticated', f, 'EXECUTE')
            AND NOT has_function_privilege('anon', f, 'EXECUTE')
            AND NOT has_function_privilege('public', f, 'EXECUTE'))
     FROM unnest(ARRAY[
       'public.record_job_advisory(text, uuid, text, text, text, uuid, jsonb)',
       'public.resolve_workflow_advisories(uuid, text, text, uuid, uuid)']) AS f));

SELECT pg_temp.m134_mark('private_helpers_execute_for_no_api_role',
  (SELECT bool_and(
            NOT has_function_privilege('service_role', f, 'EXECUTE')
            AND NOT has_function_privilege('authenticated', f, 'EXECUTE')
            AND NOT has_function_privilege('anon', f, 'EXECUTE')
            AND NOT has_function_privilege('public', f, 'EXECUTE'))
     FROM unnest(ARRAY[
       'private.workflow_advisory_check_key_valid(text)',
       'private.workflow_advisory_context_set_valid(jsonb, text[])',
       'private.workflow_advisory_context_valid(jsonb)',
       'private.workflow_advisory_context_id_in_org(text, uuid, uuid)',
       'private.workflow_advisory_context_ids_in_org(jsonb, uuid)',
       'private.workflow_advisories_guard()',
       'private.workflow_advisory_record_in_org(text, uuid, uuid)',
       'private.workflow_advisory_assert_args(uuid, text, text, text, uuid, jsonb)']) AS f)
  -- and none of them is reachable through PostgREST's public schema.
  AND to_regprocedure('public.workflow_advisory_context_valid(jsonb)') IS NULL);

SELECT pg_temp.m134_mark('rpcs_are_security_definer_with_an_empty_search_path',
  (SELECT count(*) FROM pg_proc AS p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('record_workflow_advisory', 'record_job_advisory',
                         'resolve_workflow_advisories')
       AND p.prosecdef
       AND EXISTS (
         SELECT 1 FROM unnest(p.proconfig) AS c WHERE c IN ('search_path=""', 'search_path=')
       )) = 3);

-- A second overload would make every PostgREST call ambiguous.
SELECT pg_temp.m134_mark('each_rpc_has_exactly_one_signature',
  (SELECT count(*) FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('record_workflow_advisory', 'record_job_advisory',
                      'resolve_workflow_advisories')) = 3);

SELECT pg_temp.m134_mark('guard_is_a_before_update_row_trigger',
  EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.workflow_advisories'::regclass
       AND tgname = 'workflow_advisories_guard'
       AND NOT tgisinternal
       AND tgenabled = 'O'
       -- tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate.
       AND (tgtype & 1) = 1 AND (tgtype & 2) = 2 AND (tgtype & 16) = 16
       AND (tgtype & (4 | 8 | 32)) = 0
       AND tgfoid = 'private.workflow_advisories_guard()'::regprocedure
  ));

-- Every column but the resolve stamp is frozen by the guard. A new column
-- fails this until someone decides whether it may change.
SELECT pg_temp.m134_mark('guard_freezes_every_column_but_the_stamp',
  (SELECT bool_and(position(format('NEW.%1$s IS DISTINCT FROM OLD.%1$s', c.column_name) IN p.prosrc) > 0)
     FROM information_schema.columns AS c
     CROSS JOIN pg_proc AS p
    WHERE c.table_schema = 'public' AND c.table_name = 'workflow_advisories'
      AND c.column_name NOT IN ('resolved_at', 'resolved_by')
      AND p.oid = 'private.workflow_advisories_guard()'::regprocedure));

-- The record-in-org check has a branch for each table the CHECK allows: the
-- 12 fixture tables here, and notification_sequences (the 13th, covered by
-- mint134-registry-additions.sql).
SELECT pg_temp.m134_mark('record_table_set_and_org_check_agree',
  (SELECT count(*) FROM pg_constraint AS k,
          regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') AS m
    WHERE k.conname = 'workflow_advisories_record_table_check') = 13
  AND (SELECT bool_and(
                position(quote_literal(r.record_table) IN pg_get_constraintdef(k.oid)) > 0
                AND position(format('FROM public.%s AS r', r.record_table) IN p.prosrc) > 0)
         FROM pg_temp.m134_records AS r,
              pg_constraint AS k,
              pg_proc AS p
        WHERE k.conname = 'workflow_advisories_record_table_check'
          AND p.oid = 'private.workflow_advisory_record_in_org(text, uuid, uuid)'::regprocedure));

SELECT pg_temp.m134_mark('org_delete_cascades_and_context_check_uses_the_validator',
  (SELECT confdeltype = 'c' FROM pg_constraint
    WHERE conname = 'workflow_advisories_org_id_fkey')
  AND (SELECT position('workflow_advisory_context_valid' IN pg_get_constraintdef(oid)) > 0
         FROM pg_constraint WHERE conname = 'workflow_advisories_context_check'));

-- ---------------------------------------------------------------------------
-- record_workflow_advisory: accepted calls.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m134_run('rec_admin', 'authenticated', '13400000-0000-4000-a000-000000000001',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'npi_registry.not_found',
    'providers', '13400000-0000-4000-a000-0000000a0001', 'panel',
    '{"import_run_id": "13400000-0000-4000-a000-0000000a0008", "line": 12, "surface": "import"}'));
SELECT pg_temp.m134_run('rec_specialist_names_self', 'authenticated', '13400000-0000-4000-a000-000000000002',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'npi.missing',
    'providers', '13400000-0000-4000-a000-0000000a0001', 'import', '{}',
    '13400000-0000-4000-a000-000000000002'));
SELECT pg_temp.m134_run('rec_billing', 'authenticated', '13400000-0000-4000-a000-000000000003',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'touch.other_without_context',
    'touches', '13400000-0000-4000-a000-0000000a0005'));
SELECT pg_temp.m134_run('rec_service_api', 'service_role', NULL,
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'task.step_out_of_order',
    'tasks', '13400000-0000-4000-a000-0000000a0004', 'api',
    '{"step_order": 2, "earlier_open_count": 1}', '13400000-0000-4000-a000-000000000002'));
SELECT pg_temp.m134_run('rec_service_extension', 'service_role', NULL,
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'task.completed_out_of_order',
    'tasks', '13400000-0000-4000-a000-0000000a0004', 'extension', '{}',
    '13400000-0000-4000-a000-000000000001'));
SELECT pg_temp.m134_run('rec_block', 'authenticated', '13400000-0000-4000-a000-000000000001',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'generation.no_sop',
    'providers', '13400000-0000-4000-a000-0000000a0001', 'panel',
    '{"payer_id": "13400000-0000-4000-a000-0000000a0002", "case_type": "enrollment"}',
    NULL, 'block'));
SELECT pg_temp.m134_run('rec_null_context', 'authenticated', '13400000-0000-4000-a000-000000000001',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'npi.missing',
    'providers', '13400000-0000-4000-a000-0000000a0011', 'panel', NULL));
SELECT pg_temp.m134_run('table_ok_' || record_table, 'authenticated',
  '13400000-0000-4000-a000-000000000001',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'roster_export.override',
    record_table, record_id))
  FROM pg_temp.m134_records;

SELECT pg_temp.m134_mark('authenticated_actor_is_auth_uid_and_role_comes_from_memberships',
  EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE id = pg_temp.m134_ok_id('rec_admin')
       AND org_id = '13400000-0000-4000-a000-00000000000a'
       AND check_key = 'npi_registry.not_found'
       AND severity_at_time = 'advisory'
       AND record_table = 'providers'
       AND record_id = '13400000-0000-4000-a000-0000000a0001'
       AND actor_id = '13400000-0000-4000-a000-000000000001'
       AND actor_role = 'admin'
       AND source = 'panel'
       AND job IS NULL
       AND context = '{"import_run_id": "13400000-0000-4000-a000-0000000a0008", "line": 12, "surface": "import"}'::jsonb
       AND bypassed_at = now()
       AND resolved_at IS NULL AND resolved_by IS NULL
  ));
SELECT pg_temp.m134_mark('authenticated_may_name_itself_and_import_is_a_source',
  EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE id = pg_temp.m134_ok_id('rec_specialist_names_self')
       AND actor_id = '13400000-0000-4000-a000-000000000002'
       AND actor_role = 'specialist' AND source = 'import'
  ));
SELECT pg_temp.m134_mark('a_billing_member_is_recorded_as_billing',
  EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE id = pg_temp.m134_ok_id('rec_billing')
       AND actor_id = '13400000-0000-4000-a000-000000000003' AND actor_role = 'billing'
  ));
SELECT pg_temp.m134_mark('service_role_records_the_actor_it_passes',
  EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE id = pg_temp.m134_ok_id('rec_service_api')
       AND actor_id = '13400000-0000-4000-a000-000000000002' AND actor_role = 'specialist'
       AND source = 'api' AND context = '{"step_order": 2, "earlier_open_count": 1}'::jsonb
  )
  AND EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE id = pg_temp.m134_ok_id('rec_service_extension')
       AND actor_id = '13400000-0000-4000-a000-000000000001' AND actor_role = 'admin'
       AND source = 'extension'
  ));
SELECT pg_temp.m134_mark('a_block_severity_is_kept',
  EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE id = pg_temp.m134_ok_id('rec_block') AND severity_at_time = 'block'
  ));
SELECT pg_temp.m134_mark('a_null_context_is_stored_as_an_empty_object',
  EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE id = pg_temp.m134_ok_id('rec_null_context') AND context = '{}'::jsonb
  ));
SELECT pg_temp.m134_mark('every_record_table_accepts_a_record_of_the_org',
  (SELECT count(*) = 12 AND bool_and(result ~ '^ok:[0-9a-f-]{36}$')
     FROM pg_temp.m134_calls WHERE name LIKE 'table\_ok\_%')
  AND (SELECT count(DISTINCT record_table) = 12 FROM public.workflow_advisories
        WHERE check_key = 'roster_export.override'));

-- ---------------------------------------------------------------------------
-- record_workflow_advisory: refused calls. Each uses config.override_ignored,
-- a registered key no accepted call here uses (or an unregistered key), and
-- none may write a row.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m134_mark('authenticated_cannot_forge_another_actor',
  pg_temp.m134_run('refuse_forged_actor', 'authenticated', '13400000-0000-4000-a000-000000000001',
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001', 'panel', '{}',
      '13400000-0000-4000-a000-000000000002'))
  = '42501:workflow_advisory_actor_mismatch');
SELECT pg_temp.m134_mark('authenticated_without_a_signed_in_user_is_refused',
  pg_temp.m134_run('refuse_no_sub', 'authenticated', NULL,
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001'))
  = '42501:workflow_advisory_actor_mismatch');
SELECT pg_temp.m134_mark('service_role_must_pass_an_actor',
  pg_temp.m134_run('refuse_service_no_actor', 'service_role', NULL,
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001', 'api'))
  = '22023:workflow_advisory_actor_required');
SELECT pg_temp.m134_mark('service_role_actor_must_be_a_member',
  pg_temp.m134_run('refuse_service_non_member', 'service_role', NULL,
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001', 'api', '{}',
      '13400000-0000-4000-a000-000000000005'))
  = '42501:workflow_advisory_not_a_member'
  AND pg_temp.m134_run('refuse_service_other_org_actor', 'service_role', NULL,
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001', 'extension', '{}',
      '13400000-0000-4000-a000-000000000004'))
  = '42501:workflow_advisory_not_a_member');
SELECT pg_temp.m134_mark('a_signed_in_non_member_is_refused',
  pg_temp.m134_run('refuse_non_member', 'authenticated', '13400000-0000-4000-a000-000000000005',
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001'))
  = '42501:workflow_advisory_not_a_member');
SELECT pg_temp.m134_mark('a_member_of_another_org_cannot_forge_the_org',
  pg_temp.m134_run('refuse_forged_org', 'authenticated', '13400000-0000-4000-a000-000000000004',
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001'))
  = '42501:workflow_advisory_not_a_member');

-- Org B's admin, recording for org B, names each of org A's records.
SELECT pg_temp.m134_run('cross_org_' || record_table, 'authenticated',
  '13400000-0000-4000-a000-000000000004',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000b', 'config.override_ignored',
    record_table, record_id))
  FROM pg_temp.m134_records;
SELECT pg_temp.m134_mark('another_orgs_record_is_refused_in_every_record_table',
  (SELECT count(*) = 12 AND bool_and(result = '22023:workflow_advisory_record_not_in_org')
     FROM pg_temp.m134_calls WHERE name LIKE 'cross\_org\_%'));
SELECT pg_temp.m134_mark('a_missing_record_or_one_in_another_table_is_refused',
  pg_temp.m134_run('refuse_missing_record', 'authenticated', '13400000-0000-4000-a000-000000000001',
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000affff'))
  = '22023:workflow_advisory_record_not_in_org'
  AND pg_temp.m134_run('refuse_wrong_table', 'authenticated', '13400000-0000-4000-a000-000000000001',
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'tasks', '13400000-0000-4000-a000-0000000a0001'))
  = '22023:workflow_advisory_record_not_in_org');

SELECT pg_temp.m134_run('refuse_table_' || t, 'authenticated',
  '13400000-0000-4000-a000-000000000001',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
    t, '13400000-0000-4000-a000-00000000000a'))
  FROM unnest(ARRAY['profiles', 'payers', 'state_licenses', 'workflow_advisories',
                    'Providers']) AS t;
SELECT pg_temp.m134_mark('a_table_outside_the_closed_set_is_refused',
  (SELECT count(*) = 5 AND bool_and(result = '22023:workflow_advisory_record_table_invalid')
     FROM pg_temp.m134_calls WHERE name LIKE 'refuse\_table\_%'));

SELECT pg_temp.m134_run('refuse_source_' || coalesce(s, 'null'), 'authenticated',
  '13400000-0000-4000-a000-000000000001',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
    'providers', '13400000-0000-4000-a000-0000000a0001', s))
  FROM unnest(ARRAY['job', 'cron', 'Panel', NULL]) AS s;
SELECT pg_temp.m134_mark('job_and_unknown_sources_are_refused',
  (SELECT count(*) = 4 AND bool_and(result = '22023:workflow_advisory_source_invalid')
     FROM pg_temp.m134_calls WHERE name LIKE 'refuse\_source\_%'));

-- The source is bound to the caller: the browser may say panel or import, the
-- server api or extension, and neither may claim the other's.
SELECT pg_temp.m134_run('bound_source_' || b.label, b.role_name, b.sub,
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
    'providers', '13400000-0000-4000-a000-0000000a0001', b.source, '{}', b.actor))
  FROM (VALUES
    ('authenticated_claims_api', 'authenticated', '13400000-0000-4000-a000-000000000001'::uuid,
     'api', NULL::uuid),
    ('authenticated_claims_extension', 'authenticated', '13400000-0000-4000-a000-000000000001'::uuid,
     'extension', NULL::uuid),
    ('service_role_claims_panel', 'service_role', NULL::uuid,
     'panel', '13400000-0000-4000-a000-000000000002'::uuid),
    ('service_role_claims_import', 'service_role', NULL::uuid,
     'import', '13400000-0000-4000-a000-000000000002'::uuid)
  ) AS b(label, role_name, sub, source, actor);
SELECT pg_temp.m134_mark('a_caller_may_claim_only_its_own_sources',
  (SELECT count(*) = 4 AND bool_and(result = '22023:workflow_advisory_source_invalid')
     FROM pg_temp.m134_calls WHERE name LIKE 'bound\_source\_%'));

SELECT pg_temp.m134_mark('an_unknown_severity_is_refused',
  pg_temp.m134_run('refuse_severity', 'authenticated', '13400000-0000-4000-a000-000000000001',
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001', 'panel', '{}', NULL, 'warning'))
  = '22023:workflow_advisory_severity_invalid');

SELECT pg_temp.m134_run('refuse_key_' || k.label, 'authenticated',
  '13400000-0000-4000-a000-000000000001',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', k.check_key,
    'providers', '13400000-0000-4000-a000-0000000a0001'))
  FROM (VALUES
    ('unknown_domain', 'billing.npi_missing'),
    ('uppercase_domain', 'NPI.missing'),
    ('uppercase_name', 'npi.Missing'),
    ('no_name', 'npi.'),
    ('no_dot', 'npi_missing'),
    ('a_space', 'npi.missing now'),
    ('too_long', 'npi.' || repeat('a', 49)),
    ('a_null_key', NULL),
    -- Review of #568: well-shaped keys that are text, not registered checks.
    ('a_well_shaped_unregistered_key', 'npi.m134_probe'),
    ('a_name_and_a_date', 'npi.jane_smith_19610412'),
    ('an_npi', 'npi.n1234567893'),
    ('a_name_and_a_phone', 'touch.called_jane_at_5555550133')
  ) AS k(label, check_key);
SELECT pg_temp.m134_mark('a_key_that_is_not_registered_is_refused',
  (SELECT count(*) = 12 AND bool_and(result = '22023:workflow_advisory_check_key_invalid')
     FROM pg_temp.m134_calls WHERE name LIKE 'refuse\_key\_%'));

SELECT pg_temp.m134_mark('a_missing_org_or_record_is_refused',
  pg_temp.m134_run('refuse_null_org', 'authenticated', '13400000-0000-4000-a000-000000000001',
    pg_temp.m134_rec(NULL, 'config.override_ignored', 'providers', '13400000-0000-4000-a000-0000000a0001'))
  = '22023:workflow_advisory_org_required'
  AND pg_temp.m134_run('refuse_null_record', 'authenticated', '13400000-0000-4000-a000-000000000001',
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored', 'providers', NULL))
  = '22023:workflow_advisory_record_required');

SELECT pg_temp.m134_mark('anon_cannot_execute_the_record_rpc',
  split_part(pg_temp.m134_run('refuse_anon', 'anon', NULL,
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001', 'panel', '{}',
      '13400000-0000-4000-a000-000000000001')), ':', 1) = '42501');
SELECT pg_temp.m134_mark('a_restricted_external_client_is_refused_even_as_a_member',
  pg_temp.m134_run('refuse_restricted_client', 'authenticated', '13400000-0000-4000-a000-000000000006',
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001'))
  = '42501:workflow_advisory_restricted_client'
  -- The fixture really sets the E6.12 state: true for the client, false for
  -- an ordinary member of the same org (whose calls are accepted above).
  AND pg_temp.m134_run('restricted_state_client', 'authenticated',
        '13400000-0000-4000-a000-000000000006', 'SELECT app_authz.is_restricted_external()')
      = 'ok:true'
  AND pg_temp.m134_run('restricted_state_member', 'authenticated',
        '13400000-0000-4000-a000-000000000001', 'SELECT app_authz.is_restricted_external()')
      = 'ok:false');

-- Under the service key auth.uid() is NULL and guard.ts makes no E6.12
-- check, so the RPC checks the actor a route names. Both functions apply the
-- same test: user 6 is restricted, user 7 (also internal staff) is not.
SELECT pg_temp.m134_mark('service_role_cannot_name_a_restricted_client_as_actor',
  pg_temp.m134_run('refuse_service_restricted_actor', 'service_role', NULL,
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001', 'api', '{}',
      '13400000-0000-4000-a000-000000000006'))
  = '42501:workflow_advisory_restricted_client');
SELECT pg_temp.m134_mark('internal_staff_with_a_client_classification_is_not_restricted',
  pg_temp.m134_run('accept_service_staff_actor', 'service_role', NULL,
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'assignment.start_date_missing',
      'providers', '13400000-0000-4000-a000-0000000a0001', 'api', '{}',
      '13400000-0000-4000-a000-000000000007')) ~ '^ok:[0-9a-f-]{36}$'
  AND pg_temp.m134_run('restricted_state_staff', 'authenticated',
        '13400000-0000-4000-a000-000000000007', 'SELECT app_authz.is_restricted_external()')
      = 'ok:false');
-- app_authz.is_restricted_external_user runs as minted_e612_authz_owner
-- (NOBYPASSRLS) through E6.12's grants and policies, the original's path.
-- For each user it answers what is_restricted_external() answers for that
-- user's own session: the client, the staff client, a member, a non-member.
SELECT pg_temp.m134_run('restricted_self_' || u.label, 'authenticated', u.id,
         'SELECT app_authz.is_restricted_external()')
  FROM (VALUES
    ('client', '13400000-0000-4000-a000-000000000006'::uuid),
    ('staff_client', '13400000-0000-4000-a000-000000000007'::uuid),
    ('member', '13400000-0000-4000-a000-000000000001'::uuid),
    ('non_member', '13400000-0000-4000-a000-000000000005'::uuid)
  ) AS u(label, id);
SELECT pg_temp.m134_mark('the_user_keyed_helper_matches_is_restricted_external',
  (SELECT bool_and(pg_temp.m134_result('restricted_self_' || u.label)
                   = 'ok:' || app_authz.is_restricted_external_user(u.id)::text)
          AND count(*) = 4
     FROM (VALUES
       ('client', '13400000-0000-4000-a000-000000000006'::uuid),
       ('staff_client', '13400000-0000-4000-a000-000000000007'::uuid),
       ('member', '13400000-0000-4000-a000-000000000001'::uuid),
       ('non_member', '13400000-0000-4000-a000-000000000005'::uuid)
     ) AS u(label, id))
  AND app_authz.is_restricted_external_user('13400000-0000-4000-a000-000000000006')
  AND NOT app_authz.is_restricted_external_user('13400000-0000-4000-a000-000000000007'));

-- It names a user, so no signed-in user may call it: only service_role and
-- the advisory RPCs' owner. It belongs to E6.12's owner, like the original.
SELECT pg_temp.m134_mark('the_user_keyed_helper_is_the_e612_owners_and_never_the_browsers',
  (SELECT pg_get_userbyid(p.proowner) = 'minted_e612_authz_owner'
          AND p.prosecdef
          AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c WHERE c IN ('search_path=""', 'search_path='))
          AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
          AND has_function_privilege('service_role', p.oid, 'EXECUTE')
          AND has_function_privilege(
                (SELECT pg_get_userbyid(r.proowner) FROM pg_proc AS r
                  WHERE r.oid = 'public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)'::regprocedure),
                p.oid, 'EXECUTE')
     FROM pg_proc AS p
    WHERE p.oid = 'app_authz.is_restricted_external_user(uuid)'::regprocedure)
  AND split_part(pg_temp.m134_run('restricted_helper_as_authenticated', 'authenticated',
        '13400000-0000-4000-a000-000000000001',
        $$SELECT app_authz.is_restricted_external_user('13400000-0000-4000-a000-000000000006')$$),
        ':', 1) = '42501'
  AND split_part(pg_temp.m134_run('restricted_helper_as_anon', 'anon', NULL,
        $$SELECT app_authz.is_restricted_external_user('13400000-0000-4000-a000-000000000006')$$),
        ':', 1) = '42501'
  AND pg_temp.m134_run('restricted_helper_as_service_role', 'service_role', NULL,
        $$SELECT app_authz.is_restricted_external_user('13400000-0000-4000-a000-000000000006')$$)
      = 'ok:true');

SELECT pg_temp.m134_mark('any_other_caller_is_refused_in_the_body',
  pg_temp.m134_run('refuse_other_role', 'm134_other_caller', '13400000-0000-4000-a000-000000000001',
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001', 'panel', '{}',
      '13400000-0000-4000-a000-000000000001'))
  = '42501:workflow_advisory_caller_not_allowed'
  -- A superuser session with no role set is not a caller either.
  AND pg_temp.m134_run('refuse_no_role', NULL, '13400000-0000-4000-a000-000000000001',
    pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'config.override_ignored',
      'providers', '13400000-0000-4000-a000-0000000a0001', 'panel', '{}',
      '13400000-0000-4000-a000-000000000001'))
  = '42501:workflow_advisory_caller_not_allowed');

-- ---------------------------------------------------------------------------
-- Context. Each case runs through the validator and through the RPC (as org
-- A's admin): a valid context is stored as sent; any other is refused 22023.
-- Never a name, an NPI, an email, a phone, a date or free text; no nesting.
-- ---------------------------------------------------------------------------
-- context-cases:begin
INSERT INTO pg_temp.m134_context_cases (label, expect_valid, context) VALUES
  ('empty_object', true, '{}'),
  ('import_row_facts', true, '{"import_run_id": "13400000-0000-4000-a000-0000000a0008", "line": 12, "surface": "import"}'),
  ('the_first_line', true, '{"line": 0}'),
  ('the_last_line', true, '{"line": 100000}'),
  ('a_whole_number_written_with_a_fraction', true, '{"line": 2.0}'),
  ('two_small_counts_at_their_bounds', true, '{"step_order": 99, "earlier_open_count": 99}'),
  ('a_step_and_a_cc_count_at_their_bounds', true, '{"step_position": 10, "removed_count": 20}'),
  ('an_id_set', true, '{"facility_ids": ["13400000-0000-4000-a000-0000000a0007", "13400000-0000-4000-a000-0000000a0012"]}'),
  ('an_empty_id_set', true, '{"template_ids": []}'),
  ('a_token_set_with_single_digits', true, '{"attributes": ["caqh_id", "ssn_last4"], "column": "npi_type2"}'),
  ('every_profile_attribute', true, '{"attributes": ["caqh_attested", "caqh_id", "dob", "npi", "ssn_last4"]}'),
  ('every_kind_but_flag', true, '{"case_type": "enrollment", "column": "group_npi", "layer": "org", "surface": "record_edit", "attributes": ["dob"], "import_run_id": "13400000-0000-4000-a000-0000000a0008", "payer_id": "13400000-0000-4000-a000-0000000a0002", "recipient_id": "13400000-0000-4000-a000-000000000001", "facility_ids": ["13400000-0000-4000-a000-0000000a0007"], "template_ids": ["13400000-0000-4000-a000-0000000a0010"], "count": 9999}'),
  ('a_first_name', false, '{"provider": "Jane"}'),
  ('a_full_name', false, '{"provider": "jane smith"}'),
  ('a_name_as_a_key', false, '{"Jane Smith": true}'),
  ('a_name_as_a_snake_case_key', false, '{"jane_smith": true}'),
  ('a_name_under_a_declared_token_key', false, '{"surface": "jane_smith"}'),
  ('an_npi_as_a_string', false, '{"npi": "1234567893"}'),
  ('an_npi_as_a_number', false, '{"npi": 1234567893}'),
  ('an_npi_behind_a_letter', false, '{"value": "n1234567893"}'),
  ('an_npi_split_by_underscores', false, '{"problem": "n1_2_3_4_5_6_7_8_9_3"}'),
  ('an_npi_interleaved_with_letters', false, '{"problem": "a1b2c3d4e5f6g7h8i9j3"}'),
  ('an_npi_as_a_key', false, '{"a1_2_3_4_5_6_7_8_9_3": true}'),
  ('an_npi_split_across_two_counts', false, '{"step_order": 123456, "earlier_open_count": 7893}'),
  ('counts_whose_bounds_multiply_past_the_cap', false, '{"line": 99999, "count": 99}'),
  ('a_name_and_an_npi_under_roster_keys', false, '{"rule": "jane_smith", "field": "n1_2_3_4_5_6_7_8_9_3"}'),
  ('an_email', false, '{"email": "jane@example.com"}'),
  ('an_email_spelled_out', false, '{"problem": "jane_at_example_dot_com"}'),
  ('an_email_under_a_declared_token_key', false, '{"surface": "jane_at_example_dot_com"}'),
  ('a_phone', false, '{"phone": "+15555550133"}'),
  ('a_phone_as_a_number', false, '{"phone": 5555550133}'),
  ('an_iso_date', false, '{"dob": "1961-04-12"}'),
  ('a_date_behind_a_letter', false, '{"dob": "d19610412"}'),
  ('a_date_as_a_number', false, '{"dob": 19610412}'),
  ('a_date_as_a_key', false, '{"d1961_04_12": true}'),
  ('a_date_under_a_declared_count_key', false, '{"line": 19610412}'),
  ('a_timestamp', false, '{"at": "2026-11-01T09:00:00Z"}'),
  ('free_text', false, '{"note": "called twice, no answer"}'),
  ('an_undeclared_flag', false, '{"name_differs": true}'),
  ('an_undeclared_id_key', false, '{"party_id": "13400000-0000-4000-a000-0000000a0001"}'),
  ('a_value_outside_a_closed_vocabulary', false, '{"column": "home_phone"}'),
  ('a_case_type_in_capitals', false, '{"case_type": "Enrollment"}'),
  ('an_attribute_outside_the_vocabulary', false, '{"attributes": ["caqh_id", "favorite_color"]}'),
  ('a_repeated_token', false, '{"attributes": ["dob", "dob"]}'),
  ('an_unsorted_token_set', false, '{"attributes": ["dob", "caqh_id"]}'),
  ('an_unsorted_id_set', false, '{"facility_ids": ["13400000-0000-4000-a000-0000000a0012", "13400000-0000-4000-a000-0000000a0007"]}'),
  ('a_repeated_id', false, '{"facility_ids": ["13400000-0000-4000-a000-0000000a0007", "13400000-0000-4000-a000-0000000a0007"]}'),
  ('a_token_set_under_a_token_key', false, '{"surface": ["import"]}'),
  ('a_single_token_under_a_set_key', false, '{"attributes": "dob"}'),
  ('a_boolean_under_a_count_key', false, '{"line": true}'),
  ('a_count_one_past_its_bound', false, '{"removed_count": 21}'),
  ('a_line_one_past_its_bound', false, '{"line": 100001}'),
  ('a_step_one_past_its_bound', false, '{"step_position": 11}'),
  ('a_nested_object', false, '{"row": {"line": 2}}'),
  ('an_object_in_an_array', false, '{"attributes": [{"key": "dob"}]}'),
  ('an_array_of_arrays', false, '{"attributes": [["dob"]]}'),
  ('sixteen_undeclared_keys', false, '{"ka": 1, "kb": 1, "kc": 1, "kd": 1, "ke": 1, "kf": 1, "kg": 1, "kh": 1, "ki": 1, "kj": 1, "kk": 1, "kl": 1, "km": 1, "kn": 1, "ko": 1, "kp": 1}'),
  ('seventeen_keys', false, '{"ka": 1, "kb": 1, "kc": 1, "kd": 1, "ke": 1, "kf": 1, "kg": 1, "kh": 1, "ki": 1, "kj": 1, "kk": 1, "kl": 1, "km": 1, "kn": 1, "ko": 1, "kp": 1, "kq": 1}'),
  ('twenty_one_tokens', false, '{"attributes": ["dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob", "dob"]}'),
  ('a_null_value', false, '{"line": null}'),
  ('a_negative_count', false, '{"line": -1}'),
  ('a_fraction', false, '{"line": 1.5}'),
  ('a_seven_digit_count', false, '{"line": 1000000}'),
  ('a_number_as_a_string', false, '{"line": "12"}'),
  ('a_token_under_an_id_key', false, '{"import_run_id": "run_twelve"}'),
  ('an_uppercase_uuid', false, '{"import_run_id": "13400000-0000-4000-A000-0000000A0008"}'),
  ('a_number_under_an_id_key', false, '{"import_run_id": 12}'),
  ('an_id_set_under_an_id_key', false, '{"import_run_id": ["13400000-0000-4000-a000-0000000a0008"]}'),
  ('a_uuid_under_a_plain_key', false, '{"provider": "13400000-0000-4000-a000-0000000a0001"}'),
  ('a_bad_id_in_an_id_set', false, '{"facility_ids": ["13400000-0000-4000-a000-0000000a0007", "x"]}'),
  ('a_string_under_an_ids_key', false, '{"facility_ids": "13400000-0000-4000-a000-0000000a0007"}'),
  ('a_boolean_in_a_token_set', false, '{"attributes": [true]}'),
  ('a_mixed_set', false, '{"attributes": ["dob", 1]}'),
  ('an_uppercase_key', false, '{"Line": 1}'),
  ('a_key_starting_with_an_underscore', false, '{"_line": 1}'),
  ('a_key_starting_with_a_digit', false, '{"1line": 1}'),
  ('an_undeclared_long_key', false, '{"kaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": "taaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'),
  ('an_empty_token', false, '{"surface": ""}'),
  ('a_hyphenated_token', false, '{"surface": "record-edit"}'),
  ('a_top_level_array', false, '[]'),
  ('a_top_level_string', false, '"line"'),
  ('a_top_level_number', false, '12'),
  ('a_top_level_null', false, 'null');
-- context-cases:end

SELECT pg_temp.m134_mark('context_validator_' || label,
  private.workflow_advisory_context_valid(context::jsonb) = expect_valid)
  FROM pg_temp.m134_context_cases;

SELECT pg_temp.m134_run('context_rpc_' || label, 'authenticated',
  '13400000-0000-4000-a000-000000000001',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a',
    CASE WHEN expect_valid THEN 'digest.rules_fallback' ELSE 'config.override_ignored' END,
    'providers', '13400000-0000-4000-a000-0000000a0001', 'panel', context))
  FROM pg_temp.m134_context_cases;
SELECT pg_temp.m134_mark('context_rpc_' || c.label,
  CASE WHEN c.expect_valid
       THEN EXISTS (
         SELECT 1 FROM public.workflow_advisories AS w
          WHERE w.id = pg_temp.m134_ok_id('context_rpc_' || c.label)
            AND w.context = c.context::jsonb)
       ELSE pg_temp.m134_result('context_rpc_' || c.label) = '22023:workflow_advisory_context_invalid'
  END)
  FROM pg_temp.m134_context_cases AS c;

-- Every context id must name an existing record of the org: a payer or an SOP
-- template may also be a global catalog row (org_id NULL), such as Minted's
-- generic fallback SOP that a migration seeds.
SELECT pg_temp.m134_run('context_ids_' || i.label, i.role_name, i.sub,
  CASE WHEN i.job
       THEN pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
              i.check_key, 'providers', '13400000-0000-4000-a000-0000000a0011', i.context)
       ELSE pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', i.check_key,
              'providers', '13400000-0000-4000-a000-0000000a0011', 'panel', i.context)
  END)
  FROM (VALUES
    ('a_global_catalog_template', false, 'authenticated',
     '13400000-0000-4000-a000-000000000001'::uuid, 'digest.send_time_fallback',
     '{"template_ids": ["00000000-0000-4000-a000-00000000e17b", "13400000-0000-4000-a000-0000000a0010"]}'),
    ('a_member_recipient', false, 'authenticated',
     '13400000-0000-4000-a000-000000000001'::uuid, 'digest.send_time_fallback',
     '{"recipient_id": "13400000-0000-4000-a000-000000000003"}'),
    ('a_provider_id_as_a_facility', false, 'authenticated',
     '13400000-0000-4000-a000-000000000001'::uuid, 'config.override_ignored',
     '{"facility_ids": ["13400000-0000-4000-a000-0000000a0001", "13400000-0000-4000-a000-0000000a0007"]}'),
    ('an_import_run_that_does_not_exist', false, 'authenticated',
     '13400000-0000-4000-a000-000000000001'::uuid, 'config.override_ignored',
     '{"import_run_id": "13400000-0000-4000-a000-0000000affff"}'),
    ('another_orgs_payer', false, 'authenticated',
     '13400000-0000-4000-a000-000000000001'::uuid, 'config.override_ignored',
     '{"payer_id": "13400000-0000-4000-a000-0000000b0002"}'),
    ('a_recipient_who_is_not_a_member', false, 'authenticated',
     '13400000-0000-4000-a000-000000000001'::uuid, 'config.override_ignored',
     '{"recipient_id": "13400000-0000-4000-a000-000000000005"}'),
    ('a_recipient_from_another_org', false, 'authenticated',
     '13400000-0000-4000-a000-000000000001'::uuid, 'config.override_ignored',
     '{"recipient_id": "13400000-0000-4000-a000-000000000004"}'),
    ('a_template_that_does_not_exist', false, 'authenticated',
     '13400000-0000-4000-a000-000000000001'::uuid, 'config.override_ignored',
     '{"template_ids": ["13400000-0000-4000-a000-0000000affff"]}'),
    ('a_job_naming_another_orgs_payer', true, 'service_role', NULL::uuid, 'config.override_ignored',
     '{"payer_id": "13400000-0000-4000-a000-0000000b0002"}')
  ) AS i(label, job, role_name, sub, check_key, context);
SELECT pg_temp.m134_mark('context_ids_of_the_org_or_the_global_catalog_are_accepted',
  EXISTS (SELECT 1 FROM public.sop_templates
           WHERE id = '00000000-0000-4000-a000-00000000e17b' AND org_id IS NULL)
  AND (SELECT count(*) = 2 AND bool_and(result ~ '^ok:[0-9a-f-]{36}$')
         FROM pg_temp.m134_calls
        WHERE name IN ('context_ids_a_global_catalog_template', 'context_ids_a_member_recipient')));
SELECT pg_temp.m134_mark('context_ids_outside_the_org_are_refused',
  (SELECT count(*) = 7 AND bool_and(result = '22023:workflow_advisory_context_not_in_org')
     FROM pg_temp.m134_calls
    WHERE name LIKE 'context\_ids\_%'
      AND name NOT IN ('context_ids_a_global_catalog_template', 'context_ids_a_member_recipient')));

SELECT pg_temp.m134_mark('refused_record_calls_write_nothing',
  NOT EXISTS (SELECT 1 FROM public.workflow_advisories WHERE check_key = 'config.override_ignored')
  AND NOT EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE org_id = '13400000-0000-4000-a000-00000000000b'
        OR actor_id = '13400000-0000-4000-a000-000000000005'));

-- ---------------------------------------------------------------------------
-- record_job_advisory: one open job row per (org, check, record).
-- ---------------------------------------------------------------------------
SELECT pg_temp.m134_run('job_first', 'service_role', NULL,
  pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
    'npi_registry.unchecked', 'providers', '13400000-0000-4000-a000-0000000a0001',
    '{"line": 3}'));
SELECT pg_temp.m134_run('job_repeat', 'service_role', NULL,
  pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
    'npi_registry.unchecked', 'providers', '13400000-0000-4000-a000-0000000a0001',
    '{"line": 4}'));
SELECT pg_temp.m134_run('job_repeat_from_another_job', 'service_role', NULL,
  pg_temp.m134_job('m134-other-job', '13400000-0000-4000-a000-00000000000a',
    'npi_registry.unchecked', 'providers', '13400000-0000-4000-a000-0000000a0001'));
SELECT pg_temp.m134_run('job_other_record', 'service_role', NULL,
  pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
    'npi_registry.unchecked', 'providers', '13400000-0000-4000-a000-0000000a0011'));
SELECT pg_temp.m134_run('job_other_check', 'service_role', NULL,
  pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
    'npi.missing', 'providers', '13400000-0000-4000-a000-0000000a0001'));
-- People's rows are never deduplicated, and they don't hold a job's slot.
SELECT pg_temp.m134_run('people_t1_first', 'authenticated', '13400000-0000-4000-a000-000000000001',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'npi_registry.unchecked',
    'providers', '13400000-0000-4000-a000-0000000a0001'));
SELECT pg_temp.m134_run('people_t1_again', 'authenticated', '13400000-0000-4000-a000-000000000002',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'npi_registry.unchecked',
    'providers', '13400000-0000-4000-a000-0000000a0001'));
SELECT pg_temp.m134_run('people_t2', 'authenticated', '13400000-0000-4000-a000-000000000001',
  pg_temp.m134_rec('13400000-0000-4000-a000-00000000000a', 'npi_registry.inactive',
    'providers', '13400000-0000-4000-a000-0000000a0001'));
SELECT pg_temp.m134_run('job_t2_after_people', 'service_role', NULL,
  pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
    'npi_registry.inactive', 'providers', '13400000-0000-4000-a000-0000000a0001'));
SELECT pg_temp.m134_run('job_block', 'service_role', NULL,
  pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
    'notification.sms_disabled', 'providers', '13400000-0000-4000-a000-0000000a0001',
    '{"step_position": 1}', 'block'));

SELECT pg_temp.m134_mark('a_job_row_has_its_job_and_no_actor',
  EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE id = pg_temp.m134_ok_id('job_first')
       AND org_id = '13400000-0000-4000-a000-00000000000a'
       AND check_key = 'npi_registry.unchecked' AND severity_at_time = 'advisory'
       AND record_table = 'providers' AND record_id = '13400000-0000-4000-a000-0000000a0001'
       AND source = 'job' AND job = 'm134-recheck'
       AND actor_id IS NULL AND actor_role IS NULL
       AND context = '{"line": 3}'::jsonb
       AND resolved_at IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE id = pg_temp.m134_ok_id('job_block') AND severity_at_time = 'block'
  ));
SELECT pg_temp.m134_mark('a_repeat_while_open_returns_null_and_writes_nothing',
  pg_temp.m134_result('job_repeat') = 'ok:null'
  AND pg_temp.m134_result('job_repeat_from_another_job') = 'ok:null'
  AND (SELECT count(*) = 1 AND bool_and(context = '{"line": 3}'::jsonb)
         FROM public.workflow_advisories
        WHERE source = 'job' AND check_key = 'npi_registry.unchecked'
          AND record_id = '13400000-0000-4000-a000-0000000a0001'));
SELECT pg_temp.m134_mark('another_record_or_check_is_its_own_slot',
  pg_temp.m134_ok_id('job_other_record') IS NOT NULL
  AND pg_temp.m134_ok_id('job_other_check') IS NOT NULL);
SELECT pg_temp.m134_mark('people_rows_are_each_kept_and_hold_no_job_slot',
  pg_temp.m134_ok_id('people_t1_first') IS NOT NULL
  AND pg_temp.m134_ok_id('people_t1_again') IS NOT NULL
  AND pg_temp.m134_ok_id('people_t1_first') <> pg_temp.m134_ok_id('people_t1_again')
  AND pg_temp.m134_ok_id('people_t2') IS NOT NULL
  AND pg_temp.m134_ok_id('job_t2_after_people') IS NOT NULL);

-- The partial unique index is the guarantee, for any writer.
SELECT pg_temp.m134_mark('index_refuses_a_second_open_job_row',
  split_part(pg_temp.m134_run('index_second_open_job_row', NULL, NULL,
    pg_temp.m134_insert(
      'org_id, check_key, severity_at_time, record_table, record_id, source, job',
      $$'13400000-0000-4000-a000-00000000000a', 'npi_registry.unchecked', 'advisory', 'providers',
        '13400000-0000-4000-a000-0000000a0001', 'job', 'm134-recheck'$$)), ':', 1) = '23505');

SELECT pg_temp.m134_mark('job_refuses_' || j.label,
  pg_temp.m134_run('job_refuses_' || j.label, 'service_role', NULL,
    pg_temp.m134_job(j.job, j.org, 'config.override_ignored', j.record_table,
      '13400000-0000-4000-a000-0000000a0001', j.context, j.severity))
  = j.expected)
  FROM (VALUES
    ('a_job_name_with_capitals', 'Nightly Recheck', '13400000-0000-4000-a000-00000000000a'::uuid,
     'providers', '{}', 'advisory', '22023:workflow_advisory_job_invalid'),
    ('a_null_job_name', NULL, '13400000-0000-4000-a000-00000000000a'::uuid,
     'providers', '{}', 'advisory', '22023:workflow_advisory_job_invalid'),
    ('another_orgs_record', 'm134-recheck', '13400000-0000-4000-a000-00000000000b'::uuid,
     'providers', '{}', 'advisory', '22023:workflow_advisory_record_not_in_org'),
    ('an_email_in_context', 'm134-recheck', '13400000-0000-4000-a000-00000000000a'::uuid,
     'providers', '{"email": "jane@example.com"}', 'advisory', '22023:workflow_advisory_context_invalid'),
    ('an_unknown_severity', 'm134-recheck', '13400000-0000-4000-a000-00000000000a'::uuid,
     'providers', '{}', 'warning', '22023:workflow_advisory_severity_invalid'),
    ('a_table_outside_the_set', 'm134-recheck', '13400000-0000-4000-a000-00000000000a'::uuid,
     'profiles', '{}', 'advisory', '22023:workflow_advisory_record_table_invalid')
  ) AS j(label, job, org, record_table, context, severity, expected);

SELECT pg_temp.m134_mark('job_refuses_an_unregistered_key',
  pg_temp.m134_run('job_refuses_an_unregistered_key', 'service_role', NULL,
    pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
      'npi.n1234567893', 'providers', '13400000-0000-4000-a000-0000000a0001'))
  = '22023:workflow_advisory_check_key_invalid');

-- The session role is checked too, so holding EXECUTE (a later SECURITY
-- DEFINER caller runs under its owner's) is not enough.
SELECT pg_temp.m134_mark('the_job_rpc_refuses_any_session_role_but_service_role',
  pg_temp.m134_run('job_as_other_role', 'm134_other_caller', NULL,
    pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
      'config.override_ignored', 'providers', '13400000-0000-4000-a000-0000000a0001'))
  = '42501:workflow_advisory_caller_not_allowed'
  AND pg_temp.m134_run('job_with_no_role', NULL, NULL,
    pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
      'config.override_ignored', 'providers', '13400000-0000-4000-a000-0000000a0001'))
  = '42501:workflow_advisory_caller_not_allowed');

SELECT pg_temp.m134_mark('only_service_role_runs_the_job_rpc',
  split_part(pg_temp.m134_run('job_as_authenticated', 'authenticated',
    '13400000-0000-4000-a000-000000000001',
    pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
      'config.override_ignored', 'providers', '13400000-0000-4000-a000-0000000a0001')), ':', 1) = '42501'
  AND split_part(pg_temp.m134_run('job_as_anon', 'anon', NULL,
    pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
      'config.override_ignored', 'providers', '13400000-0000-4000-a000-0000000a0001')), ':', 1) = '42501');

-- ---------------------------------------------------------------------------
-- resolve_workflow_advisories: stamps every open row for (org, check, record).
-- T1 = (org A, npi_registry.unchecked, providers, provider A) holds the open
-- job row and two people rows.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m134_run('resolve_t1', 'service_role', NULL,
  pg_temp.m134_resolve('13400000-0000-4000-a000-00000000000a', 'npi_registry.unchecked',
    'providers', '13400000-0000-4000-a000-0000000a0001', '13400000-0000-4000-a000-000000000001'));

SELECT pg_temp.m134_mark('resolve_stamps_every_open_row_for_the_record',
  pg_temp.m134_result('resolve_t1') = 'ok:3'
  AND (SELECT count(*) = 3
              AND bool_and(resolved_at = now()
                           AND resolved_by = '13400000-0000-4000-a000-000000000001')
         FROM public.workflow_advisories
        WHERE id IN (pg_temp.m134_ok_id('job_first'), pg_temp.m134_ok_id('people_t1_first'),
                     pg_temp.m134_ok_id('people_t1_again'))));
SELECT pg_temp.m134_mark('resolve_leaves_other_records_and_checks_open',
  (SELECT bool_and(resolved_at IS NULL) FROM public.workflow_advisories
    WHERE id IN (pg_temp.m134_ok_id('job_other_record'), pg_temp.m134_ok_id('job_other_check'),
                 pg_temp.m134_ok_id('people_t2'), pg_temp.m134_ok_id('job_t2_after_people'),
                 pg_temp.m134_ok_id('rec_admin'))));

SELECT pg_temp.m134_run('resolve_t1_again', 'service_role', NULL,
  pg_temp.m134_resolve('13400000-0000-4000-a000-00000000000a', 'npi_registry.unchecked',
    'providers', '13400000-0000-4000-a000-0000000a0001', '13400000-0000-4000-a000-000000000001'));
SELECT pg_temp.m134_run('job_after_resolve', 'service_role', NULL,
  pg_temp.m134_job('m134-recheck', '13400000-0000-4000-a000-00000000000a',
    'npi_registry.unchecked', 'providers', '13400000-0000-4000-a000-0000000a0001'));
SELECT pg_temp.m134_run('resolve_by_a_job', 'service_role', NULL,
  pg_temp.m134_resolve('13400000-0000-4000-a000-00000000000a', 'npi.missing',
    'providers', '13400000-0000-4000-a000-0000000a0001'));

SELECT pg_temp.m134_mark('a_second_resolve_stamps_nothing',
  pg_temp.m134_result('resolve_t1_again') = 'ok:0');
SELECT pg_temp.m134_mark('after_resolve_a_job_records_a_new_row',
  pg_temp.m134_ok_id('job_after_resolve') IS NOT NULL
  AND pg_temp.m134_ok_id('job_after_resolve') <> pg_temp.m134_ok_id('job_first')
  AND (SELECT count(*) FILTER (WHERE resolved_at IS NULL) = 1
              AND count(*) FILTER (WHERE resolved_at IS NOT NULL) = 1
         FROM public.workflow_advisories
        WHERE source = 'job' AND check_key = 'npi_registry.unchecked'
          AND record_id = '13400000-0000-4000-a000-0000000a0001'));
-- job_other_check (job) and rec_specialist_names_self are npi.missing on
-- provider A; rec_null_context is on provider A2.
SELECT pg_temp.m134_mark('a_job_resolve_has_no_resolver',
  pg_temp.m134_result('resolve_by_a_job') = 'ok:2'
  AND (SELECT bool_and(resolved_at IS NOT NULL AND resolved_by IS NULL)
         FROM public.workflow_advisories
        WHERE id IN (pg_temp.m134_ok_id('job_other_check'),
                     pg_temp.m134_ok_id('rec_specialist_names_self')))
  AND (SELECT resolved_at IS NULL FROM public.workflow_advisories
        WHERE id = pg_temp.m134_ok_id('rec_null_context')));

SELECT pg_temp.m134_mark('resolve_refuses_' || r.label,
  pg_temp.m134_run('resolve_refuses_' || r.label, 'service_role', NULL,
    pg_temp.m134_resolve('13400000-0000-4000-a000-00000000000a', r.check_key, r.record_table,
      r.record_id, r.resolved_by))
  = r.expected)
  FROM (VALUES
    ('a_resolver_who_is_not_a_member', 'npi_registry.unchecked', 'providers',
     '13400000-0000-4000-a000-0000000a0011'::uuid, '13400000-0000-4000-a000-000000000005'::uuid,
     '42501:workflow_advisory_not_a_member'),
    ('a_resolver_from_another_org', 'npi_registry.unchecked', 'providers',
     '13400000-0000-4000-a000-0000000a0011'::uuid, '13400000-0000-4000-a000-000000000004'::uuid,
     '42501:workflow_advisory_not_a_member'),
    ('a_table_outside_the_set', 'npi_registry.unchecked', 'profiles',
     '13400000-0000-4000-a000-00000000000a'::uuid, NULL::uuid,
     '22023:workflow_advisory_record_table_invalid'),
    ('an_invalid_key', 'NPI', 'providers',
     '13400000-0000-4000-a000-0000000a0011'::uuid, NULL::uuid,
     '22023:workflow_advisory_check_key_invalid'),
    ('an_unregistered_key', 'touch.called_jane_at_5555550133', 'providers',
     '13400000-0000-4000-a000-0000000a0011'::uuid, NULL::uuid,
     '22023:workflow_advisory_check_key_invalid'),
    ('a_missing_record', 'npi_registry.unchecked', 'providers',
     NULL::uuid, NULL::uuid,
     '22023:workflow_advisory_record_required'),
    ('a_restricted_client_resolver', 'npi_registry.unchecked', 'providers',
     '13400000-0000-4000-a000-0000000a0011'::uuid, '13400000-0000-4000-a000-000000000006'::uuid,
     '42501:workflow_advisory_restricted_client')
  ) AS r(label, check_key, record_table, record_id, resolved_by, expected);
SELECT pg_temp.m134_mark('refused_resolves_stamp_nothing',
  (SELECT resolved_at IS NULL FROM public.workflow_advisories
    WHERE id = pg_temp.m134_ok_id('job_other_record')));

SELECT pg_temp.m134_mark('the_resolve_rpc_refuses_any_session_role_but_service_role',
  pg_temp.m134_run('resolve_as_other_role', 'm134_other_caller', NULL,
    pg_temp.m134_resolve('13400000-0000-4000-a000-00000000000a', 'npi_registry.unchecked',
      'providers', '13400000-0000-4000-a000-0000000a0011'))
  = '42501:workflow_advisory_caller_not_allowed'
  AND pg_temp.m134_run('resolve_with_no_role', NULL, NULL,
    pg_temp.m134_resolve('13400000-0000-4000-a000-00000000000a', 'npi_registry.unchecked',
      'providers', '13400000-0000-4000-a000-0000000a0011'))
  = '42501:workflow_advisory_caller_not_allowed'
  AND (SELECT resolved_at IS NULL FROM public.workflow_advisories
        WHERE id = pg_temp.m134_ok_id('job_other_record')));

SELECT pg_temp.m134_mark('only_service_role_runs_the_resolve_rpc',
  split_part(pg_temp.m134_run('resolve_as_authenticated', 'authenticated',
    '13400000-0000-4000-a000-000000000001',
    pg_temp.m134_resolve('13400000-0000-4000-a000-00000000000a', 'npi_registry.unchecked',
      'providers', '13400000-0000-4000-a000-0000000a0011')), ':', 1) = '42501'
  AND split_part(pg_temp.m134_run('resolve_as_anon', 'anon', NULL,
    pg_temp.m134_resolve('13400000-0000-4000-a000-00000000000a', 'npi_registry.unchecked',
      'providers', '13400000-0000-4000-a000-0000000a0011')), ':', 1) = '42501');

-- ---------------------------------------------------------------------------
-- Append-only. Direct superuser updates still meet the guard (the API roles
-- hold no UPDATE at all, below). rec_admin is open; rec_billing gets the one
-- allowed change, the stamp, and is then final.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m134_run('frozen_' || c.col, NULL, NULL,
  pg_temp.m134_update(format('%I = %s', c.col, c.val), pg_temp.m134_ok_id('rec_admin')))
  FROM (VALUES
    ('id', 'pg_catalog.gen_random_uuid()'),
    ('org_id', $$'13400000-0000-4000-a000-00000000000b'::uuid$$),
    ('check_key', $$'npi.missing'$$),
    ('severity_at_time', $$'block'$$),
    ('record_table', $$'tasks'$$),
    ('record_id', 'pg_catalog.gen_random_uuid()'),
    ('actor_id', $$'13400000-0000-4000-a000-000000000002'::uuid$$),
    ('actor_role', $$'billing'$$),
    ('source', $$'api'$$),
    ('job', $$'m134-recheck'$$),
    ('context', $$'{"line": 99}'::jsonb$$),
    ('bypassed_at', $$pg_catalog.now() - interval '1 day'$$)
  ) AS c(col, val);
SELECT pg_temp.m134_mark('no_column_but_the_stamp_may_change',
  (SELECT count(*) = 12 AND bool_and(result = '42501:workflow_advisory_append_only')
     FROM pg_temp.m134_calls WHERE name LIKE 'frozen\_%')
  AND (SELECT count(*) = 12 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'workflow_advisories'
          AND column_name NOT IN ('resolved_at', 'resolved_by')));

SELECT pg_temp.m134_mark('an_update_that_sets_no_stamp_is_refused',
  pg_temp.m134_run('noop_update', NULL, NULL,
    pg_temp.m134_update('context = context', pg_temp.m134_ok_id('rec_admin')))
  = '42501:workflow_advisory_append_only'
  AND pg_temp.m134_run('resolver_without_stamp', NULL, NULL,
    pg_temp.m134_update($$resolved_by = '13400000-0000-4000-a000-000000000001'$$,
      pg_temp.m134_ok_id('rec_admin')))
  = '42501:workflow_advisory_append_only');

SELECT pg_temp.m134_mark('stamping_an_open_row_is_the_one_allowed_update',
  pg_temp.m134_run('stamp_rec_billing', NULL, NULL,
    pg_temp.m134_update($$resolved_at = pg_catalog.now(), resolved_by = '13400000-0000-4000-a000-000000000001'$$,
      pg_temp.m134_ok_id('rec_billing')))
  = 'ok:1');

SELECT pg_temp.m134_mark('a_stamp_cannot_be_' || s.label,
  pg_temp.m134_run('stamp_' || s.label, NULL, NULL,
    pg_temp.m134_update(s.set_clause, pg_temp.m134_ok_id('rec_billing')))
  = '42501:workflow_advisory_append_only')
  FROM (VALUES
    ('cleared', 'resolved_at = NULL, resolved_by = NULL'),
    ('moved', $$resolved_at = pg_catalog.now() + interval '1 hour'$$),
    ('reattributed', $$resolved_by = '13400000-0000-4000-a000-000000000002'$$),
    ('touched', 'context = context')
  ) AS s(label, set_clause);

SELECT pg_temp.m134_mark('refused_updates_change_nothing',
  EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE id = pg_temp.m134_ok_id('rec_admin')
       AND org_id = '13400000-0000-4000-a000-00000000000a'
       AND check_key = 'npi_registry.not_found' AND severity_at_time = 'advisory'
       AND record_table = 'providers' AND actor_role = 'admin' AND source = 'panel'
       AND job IS NULL AND bypassed_at = now() AND resolved_at IS NULL AND resolved_by IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE id = pg_temp.m134_ok_id('rec_billing')
       AND resolved_at = now() AND resolved_by = '13400000-0000-4000-a000-000000000001'
  ));

-- No API role may write the table directly, or delete from it.
SELECT pg_temp.m134_run('direct_' || d.role_name || '_' || d.op, d.role_name, d.sub, d.statement)
  FROM (VALUES
    ('service_role', 'update', NULL::uuid,
     pg_temp.m134_update('resolved_at = pg_catalog.now()', pg_temp.m134_ok_id('rec_admin'))),
    ('service_role', 'delete', NULL::uuid,
     format('WITH d AS (DELETE FROM public.workflow_advisories WHERE id = %L RETURNING 1) SELECT count(*) FROM d',
            pg_temp.m134_ok_id('rec_admin'))),
    ('service_role', 'insert', NULL::uuid,
     pg_temp.m134_insert(
       'org_id, check_key, severity_at_time, record_table, record_id, source, job',
       $$'13400000-0000-4000-a000-00000000000a', 'config.override_ignored', 'advisory', 'providers',
         '13400000-0000-4000-a000-0000000a0001', 'job', 'm134-recheck'$$)),
    ('authenticated', 'select', '13400000-0000-4000-a000-000000000001'::uuid,
     'SELECT count(*) FROM public.workflow_advisories'),
    ('authenticated', 'update', '13400000-0000-4000-a000-000000000001'::uuid,
     pg_temp.m134_update('resolved_at = pg_catalog.now()', pg_temp.m134_ok_id('rec_admin'))),
    ('authenticated', 'delete', '13400000-0000-4000-a000-000000000001'::uuid,
     format('WITH d AS (DELETE FROM public.workflow_advisories WHERE id = %L RETURNING 1) SELECT count(*) FROM d',
            pg_temp.m134_ok_id('rec_admin'))),
    ('authenticated', 'insert', '13400000-0000-4000-a000-000000000001'::uuid,
     pg_temp.m134_insert(
       'org_id, check_key, severity_at_time, record_table, record_id, actor_id, actor_role, source',
       $$'13400000-0000-4000-a000-00000000000a', 'config.override_ignored', 'advisory', 'providers',
         '13400000-0000-4000-a000-0000000a0001', '13400000-0000-4000-a000-000000000001', 'admin',
         'panel'$$)),
    ('anon', 'select', NULL::uuid, 'SELECT count(*) FROM public.workflow_advisories'),
    ('anon', 'delete', NULL::uuid,
     format('WITH d AS (DELETE FROM public.workflow_advisories WHERE id = %L RETURNING 1) SELECT count(*) FROM d',
            pg_temp.m134_ok_id('rec_admin')))
  ) AS d(role_name, op, sub, statement);
SELECT pg_temp.m134_mark('api_roles_cannot_write_or_delete_directly',
  (SELECT count(*) = 9 AND bool_and(split_part(result, ':', 1) = '42501')
     FROM pg_temp.m134_calls WHERE name LIKE 'direct\_%')
  AND EXISTS (SELECT 1 FROM public.workflow_advisories
               WHERE id = pg_temp.m134_ok_id('rec_admin') AND resolved_at IS NULL));
-- service_role's read works (CI's service_role has no BYPASSRLS, so RLS
-- shows it no rows here; hosted service_role bypasses RLS).
SELECT pg_temp.m134_mark('service_role_can_read',
  pg_temp.m134_run('service_role_select', 'service_role', NULL,
    'SELECT count(*) FROM public.workflow_advisories') ~ '^ok:[0-9]+$');

-- The table's own CHECKs hold for any writer, a superuser included.
SELECT pg_temp.m134_mark('check_' || k.label,
  pg_temp.m134_run('check_' || k.label, NULL, NULL, pg_temp.m134_insert(k.cols, k.vals))
  LIKE '23514:%' || k.constraint_name || '%')
  FROM (VALUES
    ('refuses_a_date_in_context', 'workflow_advisories_context_check',
     'org_id, check_key, severity_at_time, record_table, record_id, actor_id, actor_role, source, context',
     $$'13400000-0000-4000-a000-00000000000a', 'config.override_ignored', 'advisory', 'providers',
       '13400000-0000-4000-a000-0000000a0001', '13400000-0000-4000-a000-000000000001', 'admin',
       'panel', '{"dob": "1961-04-12"}'$$),
    ('refuses_a_person_row_without_an_actor', 'workflow_advisories_actor_check',
     'org_id, check_key, severity_at_time, record_table, record_id, source',
     $$'13400000-0000-4000-a000-00000000000a', 'config.override_ignored', 'advisory', 'providers',
       '13400000-0000-4000-a000-0000000a0001', 'panel'$$),
    ('refuses_a_job_row_without_a_job', 'workflow_advisories_job_check',
     'org_id, check_key, severity_at_time, record_table, record_id, source',
     $$'13400000-0000-4000-a000-00000000000a', 'config.override_ignored', 'advisory', 'providers',
       '13400000-0000-4000-a000-0000000a0001', 'job'$$),
    ('refuses_a_resolver_without_a_stamp', 'workflow_advisories_resolved_check',
     'org_id, check_key, severity_at_time, record_table, record_id, source, job, resolved_by',
     $$'13400000-0000-4000-a000-00000000000a', 'config.override_ignored', 'advisory', 'providers',
       '13400000-0000-4000-a000-0000000a0011', 'job', 'm134-recheck',
       '13400000-0000-4000-a000-000000000001'$$),
    ('refuses_an_unregistered_key', 'workflow_advisories_check_key_check',
     'org_id, check_key, severity_at_time, record_table, record_id, source, job',
     $$'13400000-0000-4000-a000-00000000000a', 'npi.jane_smith_19610412', 'advisory', 'providers',
       '13400000-0000-4000-a000-0000000a0011', 'job', 'm134-recheck'$$),
    ('refuses_a_role_outside_memberships', 'workflow_advisories_actor_role_check',
     'org_id, check_key, severity_at_time, record_table, record_id, actor_id, actor_role, source',
     $$'13400000-0000-4000-a000-00000000000a', 'config.override_ignored', 'advisory', 'providers',
       '13400000-0000-4000-a000-0000000a0001', '13400000-0000-4000-a000-000000000001',
       'platform_admin', 'panel'$$)
  ) AS k(label, constraint_name, cols, vals);

SELECT pg_temp.m134_mark('nothing_refused_was_written',
  NOT EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE check_key = 'config.override_ignored'
  ));

-- ---------------------------------------------------------------------------
-- Report.
-- ---------------------------------------------------------------------------
SELECT name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END
  FROM pg_temp.m134_results ORDER BY name;

-- On any failure, print every call's result to show where it went wrong.
SELECT 'call ' || c.name || ' -> ' || c.result
  FROM pg_temp.m134_calls AS c
 WHERE EXISTS (SELECT 1 FROM pg_temp.m134_results WHERE NOT passed)
 ORDER BY c.name;

DO $$
DECLARE v_failed text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO v_failed
    FROM pg_temp.m134_results WHERE NOT passed;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'MINT-134 workflow advisories assertions failed: %', v_failed;
  END IF;
END;
$$;

-- The ROLLBACK also undoes the auth USAGE grant and the throwaway role.
ROLLBACK;
\echo MINT-134 workflow advisories packet passed.
