-- MINT-134 registry additions packet
-- (supabase/migrations/20261102140000_mint134_registry_additions.sql): the four
-- new check keys, the four new record tables and the four new context keys
-- are accepted, an unknown key, table or value is still refused, and the
-- replaced functions keep #568's owner, grants and search_path.
--
-- Run after all migrations, in a disposable PostgreSQL database, never
-- against hosted. CI's Migration dry-run job runs it after #568's packet:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/mint134-registry-additions.sql
-- It needs a superuser connection and the anon, authenticated and
-- service_role roles (CI's seed creates them). Every row it writes is
-- synthetic and rolled back.
--
-- notification_sequences comes with #561. When the table is absent the packet
-- first checks that a sequence record and a sequence_id are refused, then
-- creates a stand-in with the columns the guarded branches read (id, org_id)
-- inside this transaction and checks that they are accepted for the org's own
-- sequence only. When #561's table exists it uses that table.
--
-- The context cases between the context-cases markers are also read by
-- src/lib/advisoryChecks.vocabulary.test.ts, which runs each through the
-- TypeScript validator.
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
    RAISE EXCEPTION 'mint134-registry-additions.sql must run as a superuser';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles
       WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'mint134-registry-additions.sql needs the anon, authenticated and service_role roles';
  END IF;
  IF to_regprocedure('private.workflow_advisory_check_key_valid(text)') IS NULL
     OR NOT private.workflow_advisory_check_key_valid('contact.phone_missing') THEN
    RAISE EXCEPTION 'mint134-registry-additions.sql runs after supabase/migrations/20261102140000_mint134_registry_additions.sql';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA auth TO authenticated;

CREATE TEMP TABLE m134r_results (name text PRIMARY KEY, passed boolean NOT NULL);
CREATE TEMP TABLE m134r_calls (name text PRIMARY KEY, result text NOT NULL);
CREATE TEMP TABLE m134r_context_cases (
  label text PRIMARY KEY,
  expect_valid boolean NOT NULL,
  context text NOT NULL
);
CREATE TEMP TABLE m134r_state AS
SELECT to_regclass('public.notification_sequences') IS NULL AS sequences_absent;

CREATE FUNCTION pg_temp.m134r_mark(p_name text, p_passed boolean) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO pg_temp.m134r_results VALUES (p_name, coalesce(p_passed, false))
$$;

-- Run p_statement (one SELECT of one value) as p_role, signed in as p_sub,
-- and keep 'ok:<value>' or '<SQLSTATE>:<message>' under p_name.
CREATE FUNCTION pg_temp.m134r_run(p_name text, p_role text, p_sub uuid, p_statement text)
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
  INSERT INTO pg_temp.m134r_calls VALUES (p_name, v_result);
  RETURN v_result;
END;
$$;

-- record_workflow_advisory for org A's admin, from the panel unless told.
CREATE FUNCTION pg_temp.m134r_rec(
  p_name text, p_org uuid, p_key text, p_table text, p_record uuid,
  p_context text DEFAULT '{}', p_severity text DEFAULT 'advisory', p_source text DEFAULT 'panel'
) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.m134r_run(p_name, 'authenticated', '13410000-0000-4000-a000-000000000001',
    format('SELECT public.record_workflow_advisory(%L::uuid, %L, %L, %L, %L::uuid, %L, %L::jsonb)',
           p_org, p_key, p_severity, p_table, p_record, p_source, p_context))
$$;

CREATE FUNCTION pg_temp.m134r_ok(p_result text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_result ~ '^ok:[0-9a-f-]{36}$' $$;

-- ---------------------------------------------------------------------------
-- Fixtures: org A (its admin) and org B (its admin), a provider, a contact
-- and a membership in each, and a roster mapping in org A (organizations seed
-- their roster templates by trigger; the mapping uses one).
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (id, name) VALUES
  ('13410000-0000-4000-a000-00000000000a', 'MINT-134 Additions Synthetic Org A'),
  ('13410000-0000-4000-a000-00000000000b', 'MINT-134 Additions Synthetic Org B');
INSERT INTO auth.users (id, email) VALUES
  ('13410000-0000-4000-a000-000000000001', 'm134r-admin-a@example.invalid'),
  ('13410000-0000-4000-a000-000000000004', 'm134r-admin-b@example.invalid');
INSERT INTO public.profiles (id, full_name, email) VALUES
  ('13410000-0000-4000-a000-000000000001', 'MINT-134 Additions Admin A', 'm134r-admin-a@example.invalid'),
  ('13410000-0000-4000-a000-000000000004', 'MINT-134 Additions Admin B', 'm134r-admin-b@example.invalid');
INSERT INTO public.memberships (id, org_id, user_id, role) VALUES
  ('13410000-0000-4000-a000-0000000a0014', '13410000-0000-4000-a000-00000000000a',
   '13410000-0000-4000-a000-000000000001', 'admin'),
  ('13410000-0000-4000-a000-0000000b0014', '13410000-0000-4000-a000-00000000000b',
   '13410000-0000-4000-a000-000000000004', 'admin');
INSERT INTO public.providers (id, org_id, first_name, last_name) VALUES
  ('13410000-0000-4000-a000-0000000a0001', '13410000-0000-4000-a000-00000000000a',
   'Synthetic', 'Provider A'),
  ('13410000-0000-4000-a000-0000000b0001', '13410000-0000-4000-a000-00000000000b',
   'Synthetic', 'Provider B');
INSERT INTO public.parties (id, org_id, name, created_by) VALUES
  ('13410000-0000-4000-a000-0000000a0013', '13410000-0000-4000-a000-00000000000a',
   'MINT-134 Additions Contact A', '13410000-0000-4000-a000-000000000001'),
  ('13410000-0000-4000-a000-0000000b0013', '13410000-0000-4000-a000-00000000000b',
   'MINT-134 Additions Contact B', '13410000-0000-4000-a000-000000000004');
INSERT INTO public.roster_mappings (id, org_id, template_id, created_by, name, grain)
SELECT '13410000-0000-4000-a000-0000000a0009', t.org_id, t.id,
       '13410000-0000-4000-a000-000000000001', 'MINT-134 Additions Mapping', 'provider'
  FROM public.roster_templates AS t
 WHERE t.org_id = '13410000-0000-4000-a000-00000000000a'
 ORDER BY t.slug
 LIMIT 1;

-- ---------------------------------------------------------------------------
-- Check keys: 34, the four new ones accepted, anything else refused.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m134r_mark('the_registry_lists_34_check_keys',
  (SELECT count(*) FROM pg_proc AS p,
          regexp_matches(p.prosrc, '\(''([a-z_]+\.[a-z0-9_]+)''\)', 'g') AS m
    WHERE p.oid = 'private.workflow_advisory_check_key_valid(text)'::regprocedure) = 34);

SELECT pg_temp.m134r_mark('the_four_new_check_keys_are_registered',
  private.workflow_advisory_check_key_valid('npi_registry.credentials_differ')
  AND private.workflow_advisory_check_key_valid('npi_registry.taxonomy_differs')
  AND private.workflow_advisory_check_key_valid('npi_registry.license_differs')
  AND private.workflow_advisory_check_key_valid('contact.phone_missing'));

SELECT pg_temp.m134r_mark('an_unknown_check_key_is_still_refused',
  NOT private.workflow_advisory_check_key_valid('npi_registry.dea_differs')
  AND NOT private.workflow_advisory_check_key_valid('contact.phone')
  AND NOT private.workflow_advisory_check_key_valid('contact.phone_missing_now')
  AND NOT private.workflow_advisory_check_key_valid('contact.jane_at_5555550133')
  AND NOT coalesce(private.workflow_advisory_check_key_valid(NULL), false)
  AND pg_temp.m134r_rec('refuse_unknown_key', '13410000-0000-4000-a000-00000000000a',
        'npi_registry.dea_differs', 'providers', '13410000-0000-4000-a000-0000000a0001')
      = '22023:workflow_advisory_check_key_invalid');

-- A check reads its statement's snapshot, so each write whose row is checked
-- runs as its own statement first.
SELECT pg_temp.m134r_rec('rec_credentials_differ', '13410000-0000-4000-a000-00000000000a',
  'npi_registry.credentials_differ', 'providers', '13410000-0000-4000-a000-0000000a0001',
  '{"surface": "add_provider"}');
SELECT pg_temp.m134r_rec('rec_taxonomy_differs', '13410000-0000-4000-a000-00000000000a',
  'npi_registry.taxonomy_differs', 'providers', '13410000-0000-4000-a000-0000000a0001',
  '{"surface": "roster_form"}');
SELECT pg_temp.m134r_rec('rec_license_differs', '13410000-0000-4000-a000-00000000000a',
  'npi_registry.license_differs', 'providers', '13410000-0000-4000-a000-0000000a0001',
  '{"surface": "record_edit"}');
SELECT pg_temp.m134r_mark('the_npi_registry_differences_record_on_the_provider',
  (SELECT count(*) = 3 AND bool_and(pg_temp.m134r_ok(result)) FROM pg_temp.m134r_calls
    WHERE name IN ('rec_credentials_differ', 'rec_taxonomy_differs', 'rec_license_differs'))
  AND (SELECT count(*) = 3 FROM public.workflow_advisories
        WHERE org_id = '13410000-0000-4000-a000-00000000000a'
          AND check_key LIKE 'npi_registry.%'
          AND record_table = 'providers' AND severity_at_time = 'advisory'));

-- ---------------------------------------------------------------------------
-- Record tables: 13, each new one checked in the org.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m134r_mark('the_record_table_check_lists_13_tables',
  (SELECT count(*) FROM pg_constraint AS k,
          regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') AS m
    WHERE k.conname = 'workflow_advisories_record_table_check') = 13
  AND (SELECT bool_and(position(quote_literal(t) IN pg_get_constraintdef(k.oid)) > 0)
         FROM pg_constraint AS k,
              unnest(ARRAY['parties', 'organizations', 'memberships', 'notification_sequences']) AS t
        WHERE k.conname = 'workflow_advisories_record_table_check'));

SELECT pg_temp.m134r_mark('a_contact_with_no_phone_records_on_its_party_of_the_org',
  pg_temp.m134r_ok(pg_temp.m134r_rec('rec_contact_a', '13410000-0000-4000-a000-00000000000a',
    'contact.phone_missing', 'parties', '13410000-0000-4000-a000-0000000a0013'))
  AND pg_temp.m134r_rec('refuse_contact_b', '13410000-0000-4000-a000-00000000000a',
    'contact.phone_missing', 'parties', '13410000-0000-4000-a000-0000000b0013')
      = '22023:workflow_advisory_record_not_in_org');

SELECT pg_temp.m134r_mark('an_org_level_check_records_on_the_orgs_own_row_only',
  pg_temp.m134r_ok(pg_temp.m134r_rec('rec_org_a', '13410000-0000-4000-a000-00000000000a',
    'config.override_ignored', 'organizations', '13410000-0000-4000-a000-00000000000a',
    '{"layer": "org"}'))
  AND pg_temp.m134r_rec('refuse_org_b', '13410000-0000-4000-a000-00000000000a',
    'config.override_ignored', 'organizations', '13410000-0000-4000-a000-00000000000b')
      = '22023:workflow_advisory_record_not_in_org'
  AND NOT private.workflow_advisory_record_in_org('organizations',
    '13410000-0000-4000-a000-0000000affff', '13410000-0000-4000-a000-0000000affff'));

SELECT pg_temp.m134r_mark('a_recipient_check_records_on_a_membership_of_the_org',
  pg_temp.m134r_ok(pg_temp.m134r_rec('rec_membership_a', '13410000-0000-4000-a000-00000000000a',
    'digest.recipient_no_email', 'memberships', '13410000-0000-4000-a000-0000000a0014',
    '{"recipient_id": "13410000-0000-4000-a000-000000000001"}', 'block'))
  AND pg_temp.m134r_rec('refuse_membership_b', '13410000-0000-4000-a000-00000000000a',
    'digest.recipient_no_email', 'memberships', '13410000-0000-4000-a000-0000000b0014',
    '{}', 'block')
      = '22023:workflow_advisory_record_not_in_org');

SELECT pg_temp.m134r_mark('a_job_records_on_the_org_too',
  pg_temp.m134r_ok(pg_temp.m134r_run('job_org_a', 'service_role', NULL,
    format('SELECT public.record_job_advisory(%L, %L::uuid, %L, %L, %L, %L::uuid, %L::jsonb)',
      'followup-digest', '13410000-0000-4000-a000-00000000000a', 'digest.org_failed', 'block',
      'organizations', '13410000-0000-4000-a000-00000000000a', '{}'))));

SELECT pg_temp.m134r_mark('a_table_outside_the_set_is_still_refused',
  pg_temp.m134r_rec('refuse_profiles', '13410000-0000-4000-a000-00000000000a',
    'config.override_ignored', 'profiles', '13410000-0000-4000-a000-000000000001')
      = '22023:workflow_advisory_record_table_invalid'
  AND pg_temp.m134r_rec('refuse_capitalised', '13410000-0000-4000-a000-00000000000a',
    'config.override_ignored', 'Organizations', '13410000-0000-4000-a000-00000000000a')
      = '22023:workflow_advisory_record_table_invalid');

-- notification_sequences while #561's table is absent: refused, not an error.
SELECT pg_temp.m134r_mark('without_the_sequences_table_a_sequence_is_refused',
  NOT (SELECT sequences_absent FROM pg_temp.m134r_state)
  OR (
    NOT private.workflow_advisory_record_in_org('notification_sequences',
      '13410000-0000-4000-a000-0000000a0015', '13410000-0000-4000-a000-00000000000a')
    AND pg_temp.m134r_rec('refuse_sequence_absent', '13410000-0000-4000-a000-00000000000a',
      'notification.schedule_invalid', 'notification_sequences',
      '13410000-0000-4000-a000-0000000a0015')
        = '22023:workflow_advisory_record_not_in_org'
    AND pg_temp.m134r_rec('refuse_sequence_id_absent', '13410000-0000-4000-a000-00000000000a',
      'digest.step_unusable', 'organizations', '13410000-0000-4000-a000-00000000000a',
      '{"problem": "no_step", "sequence_id": "13410000-0000-4000-a000-0000000a0015"}')
        = '22023:workflow_advisory_context_not_in_org'
  ));

-- A stand-in with the columns the guarded branches read, only when #561's
-- table is absent; rolled back with everything else.
DO $$
BEGIN
  IF to_regclass('public.notification_sequences') IS NULL THEN
    CREATE TABLE public.notification_sequences (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
      purpose text NOT NULL,
      UNIQUE (org_id, purpose)
    );
  END IF;
END;
$$;
INSERT INTO public.notification_sequences (id, org_id, purpose) VALUES
  ('13410000-0000-4000-a000-0000000a0015', '13410000-0000-4000-a000-00000000000a', 'intake_reminder'),
  ('13410000-0000-4000-a000-0000000b0015', '13410000-0000-4000-a000-00000000000b', 'intake_reminder');

SELECT pg_temp.m134r_mark('a_sequence_check_records_on_a_sequence_of_the_org',
  pg_temp.m134r_ok(pg_temp.m134r_rec('rec_sequence_a', '13410000-0000-4000-a000-00000000000a',
    'notification.cc_member_lapsed', 'notification_sequences',
    '13410000-0000-4000-a000-0000000a0015', '{"step_position": 2, "removed_count": 1}'))
  AND pg_temp.m134r_rec('refuse_sequence_b', '13410000-0000-4000-a000-00000000000a',
    'notification.cc_member_lapsed', 'notification_sequences',
    '13410000-0000-4000-a000-0000000b0015')
      = '22023:workflow_advisory_record_not_in_org');

-- ---------------------------------------------------------------------------
-- Context: sequence_id checked in the org; problem, rule_code and field_key
-- closed.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m134r_rec('rec_step_unusable', '13410000-0000-4000-a000-00000000000a',
  'digest.step_unusable', 'organizations', '13410000-0000-4000-a000-00000000000a',
  '{"problem": "several_steps", "sequence_id": "13410000-0000-4000-a000-0000000a0015"}');
SELECT pg_temp.m134r_mark('a_sequence_id_must_be_a_sequence_of_the_org',
  pg_temp.m134r_ok((SELECT result FROM pg_temp.m134r_calls WHERE name = 'rec_step_unusable'))
  AND pg_temp.m134r_rec('refuse_sequence_id_b', '13410000-0000-4000-a000-00000000000a',
    'digest.step_unusable', 'organizations', '13410000-0000-4000-a000-00000000000a',
    '{"problem": "several_steps", "sequence_id": "13410000-0000-4000-a000-0000000b0015"}')
      = '22023:workflow_advisory_context_not_in_org'
  AND EXISTS (SELECT 1 FROM public.workflow_advisories
               WHERE check_key = 'digest.step_unusable'
                 AND context = '{"problem": "several_steps", "sequence_id": "13410000-0000-4000-a000-0000000a0015"}'::jsonb));

SELECT pg_temp.m134r_mark('a_roster_override_records_its_rule_field_and_count',
  pg_temp.m134r_ok(pg_temp.m134r_rec('rec_roster_override', '13410000-0000-4000-a000-00000000000a',
    'roster_export.override', 'roster_mappings', '13410000-0000-4000-a000-0000000a0009',
    '{"rule_code": "provider_npi_invalid", "field_key": "provider_npi", "count": 120}'))
  AND pg_temp.m134r_rec('refuse_roster_typed_reason', '13410000-0000-4000-a000-00000000000a',
    'roster_export.override', 'roster_mappings', '13410000-0000-4000-a000-0000000a0009',
    '{"rule_code": "provider_npi_invalid", "reason": "payer confirmed by phone"}')
      = '22023:workflow_advisory_context_invalid');

-- context-cases:begin
INSERT INTO pg_temp.m134r_context_cases (label, expect_valid, context) VALUES
  ('every_rule_code_field_key_and_count', true, '{"rule_code": "required_value_missing", "field_key": "zip_plus_4", "count": 9999}'),
  ('the_first_rule_and_field', true, '{"rule_code": "active_state_license_missing", "field_key": "address_1"}'),
  ('a_problem_code', true, '{"problem": "wrong_purpose"}'),
  ('a_problem_and_a_sequence', true, '{"problem": "channel_unsupported", "sequence_id": "13410000-0000-4000-a000-0000000a0015"}'),
  ('a_sequence_id', true, '{"sequence_id": "13410000-0000-4000-a000-0000000a0015"}'),
  ('a_rule_code_that_is_a_name', false, '{"rule_code": "jane_smith"}'),
  ('a_rule_code_in_capitals', false, '{"rule_code": "NPI_INVALID"}'),
  ('a_non_overrideable_rule', false, '{"rule_code": "ssn_last4_invalid"}'),
  ('a_field_key_with_its_dot', false, '{"field_key": "provider.npi"}'),
  ('a_field_key_outside_the_templates', false, '{"field_key": "home_phone"}'),
  ('a_field_key_that_is_a_value', false, '{"field_key": "n1_2_3_4_5_6_7_8_9_3"}'),
  ('a_field_key_as_a_number', false, '{"field_key": 12}'),
  ('a_rule_code_as_a_set', false, '{"rule_code": ["npi_invalid"]}'),
  ('a_problem_outside_the_codes', false, '{"problem": "template_deleted"}'),
  ('a_problem_that_is_an_email', false, '{"problem": "jane_at_example_dot_com"}'),
  ('a_sequence_id_that_is_not_a_uuid', false, '{"sequence_id": "intake_reminder"}'),
  ('a_sequence_id_in_capitals', false, '{"sequence_id": "13410000-0000-4000-A000-0000000A0015"}'),
  ('a_set_of_sequence_ids', false, '{"sequence_id": ["13410000-0000-4000-a000-0000000a0015"]}'),
  ('the_dropped_roster_keys', false, '{"rule": "npi_invalid", "field": "npi"}'),
  ('a_typed_reason', false, '{"reason": "payer confirmed by phone"}');
-- context-cases:end

SELECT pg_temp.m134r_mark('context_case_' || c.label,
  private.workflow_advisory_context_valid(c.context::jsonb) = c.expect_valid)
  FROM pg_temp.m134r_context_cases AS c;

-- ---------------------------------------------------------------------------
-- The replaced functions keep #568's owner, grants and search_path.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m134r_mark('replaced_functions_keep_owner_grants_and_search_path',
  (SELECT bool_and(
            p.proowner = (SELECT r.proowner FROM pg_proc AS r
                           WHERE r.oid = 'public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)'::regprocedure)
            AND NOT p.prosecdef
            AND p.proconfig = ARRAY['search_path=""']
            AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE'))
     FROM pg_proc AS p
    WHERE p.oid IN (
      'private.workflow_advisory_check_key_valid(text)'::regprocedure,
      'private.workflow_advisory_context_valid(jsonb)'::regprocedure,
      'private.workflow_advisory_assert_args(uuid, text, text, text, uuid, jsonb)'::regprocedure,
      'private.workflow_advisory_record_in_org(text, uuid, uuid)'::regprocedure,
      'private.workflow_advisory_context_id_in_org(text, uuid, uuid)'::regprocedure)));

-- ---------------------------------------------------------------------------
-- Report.
-- ---------------------------------------------------------------------------
SELECT name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END
  FROM pg_temp.m134r_results ORDER BY name;

SELECT 'call ' || c.name || ' -> ' || c.result
  FROM pg_temp.m134r_calls AS c
 WHERE EXISTS (SELECT 1 FROM pg_temp.m134r_results WHERE NOT passed)
 ORDER BY c.name;

DO $$
DECLARE v_failed text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO v_failed
    FROM pg_temp.m134r_results WHERE NOT passed;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'MINT-134 registry additions assertions failed: %', v_failed;
  END IF;
END;
$$;

-- The ROLLBACK also undoes the auth USAGE grant and any stand-in table.
ROLLBACK;
\echo MINT-134 registry additions packet passed.
