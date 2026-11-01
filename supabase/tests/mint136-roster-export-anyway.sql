-- MINT-136 roster "Export anyway" packet: an override needs no typed reason
-- and stores none, every other override guard still holds, existing rows
-- keep their reason, and the bypass is recorded in the workflow advisories
-- with its rule and field as closed vocabularies
-- (supabase/migrations/20261101150000_mint136_roster_export_anyway.sql).
--
-- Run after all migrations in a disposable PostgreSQL database, never against
-- hosted. CI's Migration dry-run job runs it after the MINT-134 packet:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/mint136-roster-export-anyway.sql
-- Every row it writes is synthetic and rolled back.
--
-- It needs a superuser connection (it writes fixtures and switches role) and
-- the anon, authenticated and service_role roles. Every call here is made as
-- service_role, the role the /api route's client holds, so it needs nothing
-- from the auth schema. pg_temp.m136_call runs one statement as a role and
-- returns 'ok:<value>' or '<SQLSTATE>:<message>'; a failure rolls only its
-- own block back.
--
-- The context cases between the context-cases markers are also read by
-- src/lib/rosterOverrideAdvisory.test.ts, which runs each through the
-- TypeScript validator: the SQL and the code accept and refuse the same
-- roster contexts.
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
    RAISE EXCEPTION 'mint136-roster-export-anyway.sql must run as a superuser';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles
       WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'mint136-roster-export-anyway.sql needs the anon, authenticated and service_role roles';
  END IF;
  IF to_regprocedure('public.roster_engine_record_override(uuid, uuid, uuid, integer, text, text, text, text, text)') IS NULL
     OR to_regprocedure('public.roster_engine_build_source(uuid, uuid)') IS NULL
     OR to_regprocedure('public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)') IS NULL
     OR to_regprocedure('private.workflow_advisory_context_valid(jsonb)') IS NULL
     OR NOT private.workflow_advisory_context_valid('{"rule": "npi_invalid"}') THEN
    RAISE EXCEPTION 'mint136-roster-export-anyway.sql runs after supabase/migrations/20261101150000_mint136_roster_export_anyway.sql';
  END IF;
END;
$$;

CREATE TEMP TABLE m136_results (name text PRIMARY KEY, passed boolean NOT NULL);
CREATE TEMP TABLE m136_calls (name text PRIMARY KEY, result text NOT NULL);
CREATE TEMP TABLE m136_context_cases (
  label text PRIMARY KEY,
  expect_valid boolean NOT NULL,
  context text NOT NULL
);

CREATE FUNCTION pg_temp.m136_mark(p_name text, p_passed boolean) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO pg_temp.m136_results VALUES (p_name, coalesce(p_passed, false))
$$;

-- Run p_statement (one SELECT of one value) as p_role (NULL: stay the
-- superuser) and keep the result under p_name.
CREATE FUNCTION pg_temp.m136_run(p_name text, p_role text, p_statement text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_value text;
  v_state text;
  v_message text;
  v_result text;
BEGIN
  BEGIN
    IF p_role IS NOT NULL THEN
      EXECUTE format('SET LOCAL ROLE %I', p_role);
    END IF;
    EXECUTE p_statement INTO v_value;
    EXECUTE 'RESET ROLE';
    v_result := 'ok:' || coalesce(v_value, 'null');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_result := v_state || ':' || v_message;
  END;
  INSERT INTO pg_temp.m136_calls VALUES (p_name, v_result);
  RETURN v_result;
END;
$$;

CREATE FUNCTION pg_temp.m136_result(p_name text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT result FROM pg_temp.m136_calls WHERE name = p_name
$$;

-- The row id an ok call returned, else NULL.
CREATE FUNCTION pg_temp.m136_ok_id(p_name text) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN result ~ '^ok:[0-9a-f-]{36}$' THEN substr(result, 4)::uuid END
    FROM pg_temp.m136_calls WHERE name = p_name
$$;

-- One override call, the way src/services/rosterEngineData.ts makes it: no
-- p_reason (p_reason NULL here), or a reason an older caller still sends.
CREATE FUNCTION pg_temp.m136_override(
  p_actor uuid, p_revision integer, p_fingerprint text, p_row text, p_rule text,
  p_field text, p_reason text DEFAULT NULL
) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_reason IS NULL THEN format(
    'SELECT (public.roster_engine_record_override(%L::uuid, %L::uuid, %L::uuid, %s, %L, %L, %L, %L)).id',
    '13600000-0000-4000-a000-00000000000a', p_actor, '13600000-0000-4000-a000-0000000a0009',
    p_revision, p_fingerprint, p_row, p_rule, p_field)
  ELSE format(
    'SELECT (public.roster_engine_record_override(%L::uuid, %L::uuid, %L::uuid, %s, %L, %L, %L, %L, %L)).id',
    '13600000-0000-4000-a000-00000000000a', p_actor, '13600000-0000-4000-a000-0000000a0009',
    p_revision, p_fingerprint, p_row, p_rule, p_field, p_reason)
  END
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: one org (its roster templates are seeded by trigger), a
-- specialist and a billing member, one provider and one mapping over it.
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (id, name) VALUES
  ('13600000-0000-4000-a000-00000000000a', 'MINT-136 Synthetic Org');
INSERT INTO auth.users (id, email) VALUES
  ('13600000-0000-4000-a000-000000000001', 'm136-specialist@example.invalid'),
  ('13600000-0000-4000-a000-000000000002', 'm136-billing@example.invalid');
INSERT INTO public.profiles (id, full_name, email) VALUES
  ('13600000-0000-4000-a000-000000000001', 'MINT-136 Specialist', 'm136-specialist@example.invalid'),
  ('13600000-0000-4000-a000-000000000002', 'MINT-136 Billing', 'm136-billing@example.invalid');
INSERT INTO public.memberships (org_id, user_id, role) VALUES
  ('13600000-0000-4000-a000-00000000000a', '13600000-0000-4000-a000-000000000001', 'specialist'),
  ('13600000-0000-4000-a000-00000000000a', '13600000-0000-4000-a000-000000000002', 'billing');
INSERT INTO public.providers (id, org_id, first_name, last_name) VALUES
  ('13600000-0000-4000-a000-0000000a0001', '13600000-0000-4000-a000-00000000000a',
   'Synthetic', 'Provider');
INSERT INTO public.roster_mappings
  (id, org_id, template_id, created_by, name, grain, selected_provider_ids)
SELECT '13600000-0000-4000-a000-0000000a0009', t.org_id, t.id,
       '13600000-0000-4000-a000-000000000001', 'MINT-136 Synthetic Mapping', 'provider',
       ARRAY['13600000-0000-4000-a000-0000000a0001']::uuid[]
  FROM public.roster_templates AS t
 WHERE t.org_id = '13600000-0000-4000-a000-00000000000a'
 ORDER BY t.slug
 LIMIT 1;

-- The current source fingerprint, as the server computes it.
SELECT set_config('m136.fingerprint',
  encode(pg_catalog.sha256(convert_to(public.roster_engine_build_source(
    '13600000-0000-4000-a000-00000000000a', '13600000-0000-4000-a000-0000000a0009')::text,
    'UTF8')), 'hex'),
  true);

SELECT pg_temp.m136_mark('fixtures_a_mapping_and_its_fingerprint',
  EXISTS (SELECT 1 FROM public.roster_mappings WHERE id = '13600000-0000-4000-a000-0000000a0009')
  AND current_setting('m136.fingerprint') ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- The column and the function: reason is nullable with no CHECK left on it,
-- and p_reason has a default. Owner and grants are unchanged.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m136_mark('the_reason_column_is_nullable',
  (SELECT NOT a.attnotnull FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = 'public.roster_export_overrides'::regclass AND a.attname = 'reason'));
SELECT pg_temp.m136_mark('no_check_is_left_on_the_reason_column',
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
      JOIN pg_catalog.pg_attribute AS a
        ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'public.roster_export_overrides'::regclass
       AND c.contype = 'c' AND a.attname = 'reason'));
SELECT pg_temp.m136_mark('the_other_override_checks_are_kept',
  (SELECT count(DISTINCT a.attname) = 5
     FROM pg_catalog.pg_constraint AS c
     JOIN pg_catalog.pg_attribute AS a
       ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.roster_export_overrides'::regclass AND c.contype = 'c'
      AND a.attname IN ('mapping_revision', 'input_fingerprint', 'row_key', 'rule_code',
                        'field_key')));
SELECT pg_temp.m136_mark('the_reason_argument_has_a_default',
  (SELECT p.pronargdefaults = 1 AND p.prosecdef AND p.proconfig = ARRAY['search_path=""']
     FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'public.roster_engine_record_override(uuid, uuid, uuid, integer, text, text, text, text, text)'::regprocedure));
SELECT pg_temp.m136_mark('only_service_role_may_record_an_override',
  has_function_privilege('service_role',
    'public.roster_engine_record_override(uuid, uuid, uuid, integer, text, text, text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.roster_engine_record_override(uuid, uuid, uuid, integer, text, text, text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.roster_engine_record_override(uuid, uuid, uuid, integer, text, text, text, text, text)', 'EXECUTE'));

-- ---------------------------------------------------------------------------
-- "Export anyway": one call, no reason; an older caller's reason is dropped.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m136_run('override_without_a_reason', 'service_role',
  pg_temp.m136_override('13600000-0000-4000-a000-000000000001', 1,
    current_setting('m136.fingerprint'), 'row-a', 'facility_zip_plus_4_invalid', 'facility.zip'));
SELECT pg_temp.m136_run('override_from_an_older_caller', 'service_role',
  pg_temp.m136_override('13600000-0000-4000-a000-000000000001', 1,
    current_setting('m136.fingerprint'), 'row-b', 'npi_invalid', 'npi',
    'An older client still typed this reason for the payer.'));
SELECT pg_temp.m136_run('override_with_a_short_reason', 'service_role',
  pg_temp.m136_override('13600000-0000-4000-a000-000000000001', 1,
    current_setting('m136.fingerprint'), 'row-c', 'phone_invalid', 'phone', 'ok'));

SELECT pg_temp.m136_mark('an_override_records_without_a_reason',
  EXISTS (
    SELECT 1 FROM public.roster_export_overrides
     WHERE id = pg_temp.m136_ok_id('override_without_a_reason')
       AND org_id = '13600000-0000-4000-a000-00000000000a'
       AND mapping_id = '13600000-0000-4000-a000-0000000a0009'
       AND mapping_revision = 1
       AND input_fingerprint = current_setting('m136.fingerprint')
       AND row_key = 'row-a'
       AND rule_code = 'facility_zip_plus_4_invalid'
       AND field_key = 'facility.zip'
       AND reason IS NULL
       AND created_by = '13600000-0000-4000-a000-000000000001'));
SELECT pg_temp.m136_mark('a_reason_an_older_caller_sends_is_never_stored',
  (SELECT count(*) = 2 AND bool_and(reason IS NULL)
     FROM public.roster_export_overrides
    WHERE id IN (pg_temp.m136_ok_id('override_from_an_older_caller'),
                 pg_temp.m136_ok_id('override_with_a_short_reason'))));
SELECT pg_temp.m136_mark('each_override_writes_its_audit_row_without_a_reason',
  (SELECT count(*) = 3 AND bool_and(NOT (l.after ? 'reason'))
          AND bool_and(l.after ->> 'rule_code' IS NOT NULL)
     FROM public.audit_log AS l
    WHERE l.entity_type = 'roster_export_override'
      AND l.entity_id IN (pg_temp.m136_ok_id('override_without_a_reason'),
                          pg_temp.m136_ok_id('override_from_an_older_caller'),
                          pg_temp.m136_ok_id('override_with_a_short_reason'))));

-- ---------------------------------------------------------------------------
-- Every other guard still holds.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m136_run('a_billing_member_is_refused', 'service_role',
  pg_temp.m136_override('13600000-0000-4000-a000-000000000002', 1,
    current_setting('m136.fingerprint'), 'row-d', 'npi_invalid', 'npi'));
SELECT pg_temp.m136_run('a_stale_fingerprint_is_refused', 'service_role',
  pg_temp.m136_override('13600000-0000-4000-a000-000000000001', 1,
    repeat('0', 64), 'row-d', 'npi_invalid', 'npi'));
SELECT pg_temp.m136_run('another_revision_is_refused', 'service_role',
  pg_temp.m136_override('13600000-0000-4000-a000-000000000001', 2,
    current_setting('m136.fingerprint'), 'row-d', 'npi_invalid', 'npi'));
SELECT pg_temp.m136_run('a_missing_actor_is_refused', 'service_role',
  pg_temp.m136_override(NULL, 1,
    current_setting('m136.fingerprint'), 'row-d', 'npi_invalid', 'npi'));
SELECT pg_temp.m136_run('authenticated_cannot_call_it', 'authenticated',
  pg_temp.m136_override('13600000-0000-4000-a000-000000000001', 1,
    current_setting('m136.fingerprint'), 'row-d', 'npi_invalid', 'npi'));

SELECT pg_temp.m136_mark('a_billing_member_is_refused',
  pg_temp.m136_result('a_billing_member_is_refused') = '42501:roster_writer_membership_required');
SELECT pg_temp.m136_mark('a_stale_fingerprint_is_refused',
  pg_temp.m136_result('a_stale_fingerprint_is_refused') = '40001:roster_input_fingerprint_stale');
SELECT pg_temp.m136_mark('another_revision_is_refused',
  pg_temp.m136_result('another_revision_is_refused') = '40001:roster_mapping_revision_conflict');
SELECT pg_temp.m136_mark('a_missing_actor_is_refused',
  pg_temp.m136_result('a_missing_actor_is_refused') = '42501:roster_actor_org_mapping_required');
SELECT pg_temp.m136_mark('authenticated_cannot_call_it',
  pg_temp.m136_result('authenticated_cannot_call_it') LIKE '42501:%');
SELECT pg_temp.m136_mark('nothing_refused_was_written',
  NOT EXISTS (SELECT 1 FROM public.roster_export_overrides WHERE row_key = 'row-d'));

-- ---------------------------------------------------------------------------
-- Existing rows stay as they are: one written the old way (a typed reason)
-- keeps it, and the table is still append-only. The dropped CHECK no longer
-- refuses a short text either; only the app's path writes NULL.
-- ---------------------------------------------------------------------------
INSERT INTO public.roster_export_overrides
  (id, org_id, mapping_id, mapping_revision, input_fingerprint, row_key, rule_code,
   field_key, reason, created_by)
VALUES
  ('13600000-0000-4000-a000-0000000a0101', '13600000-0000-4000-a000-00000000000a',
   '13600000-0000-4000-a000-0000000a0009', 1, current_setting('m136.fingerprint'),
   'row-legacy', 'date_invalid', 'dob', 'A reason typed before MINT-136, kept as it was.',
   '13600000-0000-4000-a000-000000000001');
SELECT pg_temp.m136_run('a_short_text_is_no_longer_refused', NULL,
  $$WITH i AS (
      INSERT INTO public.roster_export_overrides
        (org_id, mapping_id, mapping_revision, input_fingerprint, row_key, rule_code,
         field_key, reason, created_by)
      VALUES ('13600000-0000-4000-a000-00000000000a', '13600000-0000-4000-a000-0000000a0009', 1,
              current_setting('m136.fingerprint'), 'row-short', 'date_invalid', 'dob', 'short',
              '13600000-0000-4000-a000-000000000001')
      RETURNING 1)
    SELECT count(*) FROM i$$);
SELECT pg_temp.m136_run('a_legacy_reason_cannot_be_cleared', NULL,
  $$WITH u AS (UPDATE public.roster_export_overrides SET reason = NULL
                WHERE id = '13600000-0000-4000-a000-0000000a0101' RETURNING 1)
    SELECT count(*) FROM u$$);
SELECT pg_temp.m136_run('a_legacy_row_cannot_be_deleted', NULL,
  $$WITH d AS (DELETE FROM public.roster_export_overrides
                WHERE id = '13600000-0000-4000-a000-0000000a0101' RETURNING 1)
    SELECT count(*) FROM d$$);

SELECT pg_temp.m136_mark('a_short_text_is_no_longer_refused',
  pg_temp.m136_result('a_short_text_is_no_longer_refused') = 'ok:1');
SELECT pg_temp.m136_mark('the_table_stays_append_only',
  pg_temp.m136_result('a_legacy_reason_cannot_be_cleared') LIKE '55000:%'
  AND pg_temp.m136_result('a_legacy_row_cannot_be_deleted') LIKE '55000:%');
SELECT pg_temp.m136_mark('a_legacy_reason_is_kept',
  EXISTS (
    SELECT 1 FROM public.roster_export_overrides
     WHERE id = '13600000-0000-4000-a000-0000000a0101'
       AND reason = 'A reason typed before MINT-136, kept as it was.'));

-- ---------------------------------------------------------------------------
-- The bypass in the workflow advisories: roster_export.override on the
-- mapping, from the /api route (service_role names the actor), with the rule,
-- the field token and the row count.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m136_run('advisory_with_rule_field_and_count', 'service_role',
  $$SELECT public.record_workflow_advisory(
      '13600000-0000-4000-a000-00000000000a', 'roster_export.override', 'advisory',
      'roster_mappings', '13600000-0000-4000-a000-0000000a0009', 'api',
      '{"rule": "facility_zip_plus_4_invalid", "field": "facility_zip", "count": 1}'::jsonb,
      '13600000-0000-4000-a000-000000000001')$$);
SELECT pg_temp.m136_run('advisory_with_a_dotted_field', 'service_role',
  $$SELECT public.record_workflow_advisory(
      '13600000-0000-4000-a000-00000000000a', 'roster_export.override', 'advisory',
      'roster_mappings', '13600000-0000-4000-a000-0000000a0009', 'api',
      '{"rule": "facility_zip_plus_4_invalid", "field": "facility.zip", "count": 1}'::jsonb,
      '13600000-0000-4000-a000-000000000001')$$);
SELECT pg_temp.m136_run('advisory_with_an_unknown_rule', 'service_role',
  $$SELECT public.record_workflow_advisory(
      '13600000-0000-4000-a000-00000000000a', 'roster_export.override', 'advisory',
      'roster_mappings', '13600000-0000-4000-a000-0000000a0009', 'api',
      '{"rule": "ZIP_PLUS_4_REQUIRED", "count": 1}'::jsonb,
      '13600000-0000-4000-a000-000000000001')$$);

SELECT pg_temp.m136_mark('the_advisory_records_the_rule_field_and_count',
  EXISTS (
    SELECT 1 FROM public.workflow_advisories
     WHERE id = pg_temp.m136_ok_id('advisory_with_rule_field_and_count')
       AND org_id = '13600000-0000-4000-a000-00000000000a'
       AND check_key = 'roster_export.override'
       AND severity_at_time = 'advisory'
       AND record_table = 'roster_mappings'
       AND record_id = '13600000-0000-4000-a000-0000000a0009'
       AND actor_id = '13600000-0000-4000-a000-000000000001'
       AND actor_role = 'specialist'
       AND source = 'api'
       AND context = '{"rule": "facility_zip_plus_4_invalid", "field": "facility_zip", "count": 1}'::jsonb));
SELECT pg_temp.m136_mark('a_field_key_with_its_dot_is_refused',
  pg_temp.m136_result('advisory_with_a_dotted_field') = '22023:workflow_advisory_context_invalid');
SELECT pg_temp.m136_mark('a_rule_outside_the_vocabulary_is_refused',
  pg_temp.m136_result('advisory_with_an_unknown_rule') = '22023:workflow_advisory_context_invalid');
SELECT pg_temp.m136_mark('only_the_accepted_advisory_was_written',
  (SELECT count(*) = 1 FROM public.workflow_advisories
    WHERE org_id = '13600000-0000-4000-a000-00000000000a'));

-- ---------------------------------------------------------------------------
-- The validator's roster cases. A rule or field is a listed token only: a
-- field key keeps its dot out, a value or a name is refused, the row count is
-- bounded.
-- ---------------------------------------------------------------------------
-- context-cases:begin
INSERT INTO pg_temp.m136_context_cases (label, expect_valid, context) VALUES
  ('a_rule_a_field_and_a_row_count', true, '{"rule": "required_value_missing", "field": "first_name", "count": 12}'),
  ('the_largest_roster', true, '{"rule": "npi_invalid", "field": "npi", "count": 5000}'),
  ('a_rule_alone', true, '{"rule": "date_invalid"}'),
  ('a_field_alone', true, '{"field": "zip_plus_4"}'),
  ('a_source_field_spelled_with_an_underscore', true, '{"rule": "provider_npi_invalid", "field": "provider_npi", "count": 1}'),
  ('the_license_source_field', true, '{"rule": "active_state_license_missing", "field": "license_license_number"}'),
  ('every_facility_rule_field', true, '{"rule": "facility_street_missing", "field": "facility_street"}'),
  ('a_roster_field_beside_the_mint134_keys', true, '{"rule": "phone_invalid", "field": "phone", "count": 3, "surface": "roster_form"}'),
  ('a_field_key_with_its_dot', false, '{"field": "provider.npi"}'),
  ('a_template_column_outside_the_seed', false, '{"field": "practice_zip"}'),
  ('a_rule_in_capitals', false, '{"rule": "ZIP_PLUS_4_REQUIRED"}'),
  ('a_rule_that_cannot_be_overridden', false, '{"rule": "ssn_last4_invalid"}'),
  ('a_scope_rule', false, '{"rule": "roster_scope_empty"}'),
  ('a_name_as_a_rule', false, '{"rule": "jane_smith"}'),
  ('an_npi_as_a_field', false, '{"field": "n1234567893"}'),
  ('a_value_as_a_field', false, '{"field": "12345-6789"}'),
  ('a_rule_and_field_swapped', false, '{"rule": "zip_plus_4", "field": "npi_invalid"}'),
  ('a_rule_set_under_a_token_key', false, '{"rule": ["npi_invalid"]}'),
  ('a_number_as_a_rule', false, '{"rule": 12}'),
  ('a_row_count_past_its_bound', false, '{"rule": "npi_invalid", "count": 10000}'),
  ('a_typed_reason', false, '{"rule": "npi_invalid", "reason": "payer confirmed by phone"}');
-- context-cases:end

SELECT pg_temp.m136_mark('context_validator_' || label,
  private.workflow_advisory_context_valid(context::jsonb) = expect_valid)
  FROM pg_temp.m136_context_cases;

-- ---------------------------------------------------------------------------
-- Report.
-- ---------------------------------------------------------------------------
SELECT name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END
  FROM pg_temp.m136_results ORDER BY name;

-- On any failure, print every call's result to show where it went wrong.
SELECT 'call ' || c.name || ' -> ' || c.result
  FROM pg_temp.m136_calls AS c
 WHERE EXISTS (SELECT 1 FROM pg_temp.m136_results WHERE NOT passed)
 ORDER BY c.name;

DO $$
DECLARE v_failed text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO v_failed
    FROM pg_temp.m136_results WHERE NOT passed;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'MINT-136 roster Export anyway assertions failed: %', v_failed;
  END IF;
END;
$$;

ROLLBACK;
\echo MINT-136 roster Export anyway packet passed.
