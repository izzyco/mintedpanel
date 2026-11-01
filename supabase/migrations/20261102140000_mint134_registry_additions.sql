-- MINT-134 registry additions: every extension of the workflow advisories
-- ledger (20261101090000_mint134_workflow_advisories.sql) that the wiring PRs
-- need, in one place.
--
-- Why one migration. The registry's vocabularies live in a few functions and
-- one CHECK. If each wiring PR (NPI registry, phone, digest, roster export)
-- replaced them in its own migration, the one applied last would silently drop
-- the others' additions. So this migration replaces them once, and the wiring
-- PRs stack on it. A later addition replaces them again, from this file's
-- definitions, adding only.
--
-- What it adds (src/lib/advisoryChecks.ts mirrors each list; its contract test
-- reads the latest definition of every function here):
--   check keys     34 (was 30): npi_registry.credentials_differ,
--                  npi_registry.taxonomy_differs, npi_registry.license_differs
--                  (on providers, the other npi_registry.* context) and
--                  contact.phone_missing (on parties: a contact saved with no
--                  office phone, Sowmya's U8).
--   record tables  13 (was 9): parties (parties.org_id), organizations (the
--                  org's own row: id = p_org_id), memberships
--                  (memberships.org_id) and notification_sequences (#561, not
--                  on main yet: refused until the table exists). #568's
--                  Question 1 points the org-level digest.* checks and
--                  config.override_ignored at organizations, the two sequence
--                  checks at notification_sequences, and the digest recipient
--                  at memberships; that pointing is code only.
--   context keys   20 (was 16), each a closed sorted vocabulary or an id:
--                  sequence_id (a notification sequence of the org, refused
--                  until the table exists), problem (digest.step_unusable:
--                  #563's digestStepProblem and templateSendProblem codes),
--                  rule_code and field_key (roster_export.override: the
--                  validator's overrideable rule codes; the seeded templates'
--                  column keys and the row checks' source fields, "." written
--                  "_"). One context still holds at most 16 keys.
--
-- Each function is #568's definition with only these additions; its owner,
-- grants, search_path and SECURITY INVOKER stay as they were (CREATE OR
-- REPLACE keeps the owner and the ACL; the REVOKEs are #568's, repeated).
-- Adding a key, a table or a value leaves every stored row valid, and the
-- CHECK is replaced in one ALTER TABLE statement. Nothing is removed. The
-- public RPCs keep their signatures, so PostgREST needs no reload.
--
-- notification_sequences without the table. PL/pgSQL plans each statement the
-- first time it runs, so the two lookups on notification_sequences sit in
-- their own guarded branches: to_regclass() refuses the table, or a
-- sequence_id, until #561 creates it, and every other branch works without it.
--
-- Re-runnable: CREATE OR REPLACE, DROP CONSTRAINT IF EXISTS, REVOKE, COMMENT.
-- Apply as the executor that applied 20261101090000 and owns its functions
-- and table (only the owner may replace a function or alter the table).
-- REPO-ONLY until an operator applies it, staging first, after
-- 20261101090000. Verify the OBJECTS, not a ledger filename:
--   SELECT private.workflow_advisory_check_key_valid('npi_registry.license_differs'),
--          private.workflow_advisory_check_key_valid('contact.phone_missing'),
--          private.workflow_advisory_check_key_valid('npi_registry.dea_differs');
--     -> true | true | false
--   SELECT private.workflow_advisory_context_valid('{"rule_code": "npi_invalid"}'),
--          private.workflow_advisory_context_valid('{"rule_code": "jane_smith"}');
--     -> true | false
--   SELECT count(*) FROM pg_constraint AS k,
--          regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g')
--    WHERE k.conname = 'workflow_advisories_record_table_check';
--     -> 13
--   SELECT pg_get_userbyid(proowner), proconfig, prosecdef FROM pg_proc
--    WHERE oid = 'private.workflow_advisory_record_in_org(text, uuid, uuid)'::regprocedure;
--     -> the 20261101090000 executor | {search_path=""} | false
-- The packet supabase/tests/mint134-registry-additions.sql checks the
-- additions in a disposable database; it runs by hand, never against hosted.

-- ---------------------------------------------------------------------------
-- 1. The registered check keys: 34, CHECKS in src/lib/advisoryChecks.ts row
--    for row. Adds contact.phone_missing and npi_registry.credentials_differ,
--    .license_differs and .taxonomy_differs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.workflow_advisory_check_key_valid(p_check_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT p_check_key IS NOT NULL AND EXISTS (
    SELECT 1
      FROM (VALUES
        ('assignment.start_date_missing'),
        ('config.override_ignored'),
        ('contact.phone_missing'),
        ('digest.org_failed'),
        ('digest.recipient_no_email'),
        ('digest.rules_fallback'),
        ('digest.send_time_fallback'),
        ('digest.step_unusable'),
        ('digest.unassigned_follow_ups'),
        ('generation.no_sop'),
        ('generation.required_attribute_missing'),
        ('generation.sop_tie'),
        ('import.group_npi_unusable'),
        ('import.npi_missing'),
        ('import.npi_unusable'),
        ('import.phone_dropped'),
        ('notification.cc_member_lapsed'),
        ('notification.schedule_invalid'),
        ('notification.sms_disabled'),
        ('notification.template_unavailable'),
        ('npi.missing'),
        ('npi.stored_check_digit_invalid'),
        ('npi_registry.credentials_differ'),
        ('npi_registry.inactive'),
        ('npi_registry.license_differs'),
        ('npi_registry.name_mismatch'),
        ('npi_registry.not_found'),
        ('npi_registry.organization_number'),
        ('npi_registry.taxonomy_differs'),
        ('npi_registry.unchecked'),
        ('roster_export.override'),
        ('task.completed_out_of_order'),
        ('task.step_out_of_order'),
        ('touch.other_without_context')
      ) AS k(check_key)
     WHERE k.check_key = p_check_key
  );
$function$;

REVOKE ALL ON FUNCTION private.workflow_advisory_check_key_valid(text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.workflow_advisory_check_key_valid(text) IS
  'MINT-134: true when p_check_key is one of the registered workflow advisory check keys (CHECKS in src/lib/advisoryChecks.ts). A new check key is a migration.';

-- ---------------------------------------------------------------------------
-- 2. The declared context keys: 20, CONTEXT_KEYS row for row. Adds field_key,
--    problem and rule_code (closed vocabularies, sorted) and sequence_id (an
--    id, checked in the org in section 5).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.workflow_advisory_context_valid(p_context jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
DECLARE
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_key text;
  v_value jsonb;
  v_type text;
  v_kind text;
  v_max integer;
  v_allowed text[];
  v_number numeric;
  v_keys integer := 0;
  v_capacity numeric := 1;
BEGIN
  IF p_context IS NULL OR pg_catalog.jsonb_typeof(p_context) <> 'object' THEN
    RETURN false;
  END IF;
  FOR v_key, v_value IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_context) AS e LOOP
    v_keys := v_keys + 1;
    IF v_keys > 16 THEN
      RETURN false;
    END IF;

    -- A key that isn't declared is refused, whatever its value.
    SELECT d.kind, d.max_value, d.allowed
      INTO v_kind, v_max, v_allowed
      FROM (VALUES
        ('attributes', 'tokens', NULL, ARRAY['caqh_id', 'caqh_attested', 'npi', 'dob', 'ssn_last4']),
        ('case_type', 'token', NULL, ARRAY['contract', 'enrollment', 'recredentialing']),
        ('column', 'token', NULL, ARRAY['npi', 'npi_type2', 'group_npi', 'phone', 'fax', 'appointment_phone', 'billing_phone', 'billing_fax', 'corr_phone', 'corr_fax', 'cred_phone', 'cred_fax']),
        ('count', 'count', 9999, NULL),
        ('earlier_open_count', 'count', 99, NULL),
        ('facility_ids', 'ids', NULL, NULL),
        ('field_key', 'token', NULL, ARRAY['address_1', 'city', 'dob', 'facility_city',
          'facility_state', 'facility_street', 'facility_zip', 'first_name', 'group_name',
          'group_npi', 'individual_npi', 'last_name', 'license_expiration',
          'license_license_number', 'license_number', 'location_name', 'npi', 'phone',
          'practice_name', 'provider_npi', 'state', 'taxonomy', 'tin', 'zip_plus_4']),
        ('import_run_id', 'id', NULL, NULL),
        ('layer', 'token', NULL, ARRAY['platform', 'org']),
        ('line', 'count', 100000, NULL),
        ('payer_id', 'id', NULL, NULL),
        ('problem', 'token', NULL, ARRAY['channel_unsupported', 'no_step', 'not_registered',
          'not_selectable', 'several_steps', 'unknown_template', 'wrong_purpose']),
        ('recipient_id', 'id', NULL, NULL),
        ('removed_count', 'count', 20, NULL),
        ('rule_code', 'token', NULL, ARRAY['active_state_license_missing', 'date_invalid',
          'facility_city_missing', 'facility_state_missing', 'facility_street_missing',
          'facility_zip_plus_4_invalid', 'npi_invalid', 'phone_invalid', 'provider_npi_invalid',
          'required_value_missing']),
        ('sequence_id', 'id', NULL, NULL),
        ('step_order', 'count', 99, NULL),
        ('step_position', 'count', 10, NULL),
        ('surface', 'token', NULL, ARRAY['add_provider', 'roster_form', 'record_edit', 'import']),
        ('template_ids', 'ids', NULL, NULL)
      ) AS d(context_key, kind, max_value, allowed)
     WHERE d.context_key = v_key;
    IF NOT FOUND THEN
      RETURN false;
    END IF;

    -- Each branch tests the JSON type before anything that needs it (a
    -- numeric cast, an array length), so no value makes the validator error.
    v_type := pg_catalog.jsonb_typeof(v_value);
    IF v_kind = 'flag' THEN
      IF v_type <> 'boolean' THEN
        RETURN false;
      END IF;
    ELSIF v_kind = 'count' THEN
      IF v_type <> 'number' THEN
        RETURN false;
      END IF;
      v_number := (v_value #>> '{}')::numeric;
      IF v_number < 0 OR v_number <> pg_catalog.trunc(v_number) OR v_number > v_max THEN
        RETURN false;
      END IF;
      v_capacity := v_capacity * (v_max + 1);
    ELSIF v_kind = 'id' THEN
      IF v_type <> 'string' THEN
        RETURN false;
      END IF;
      IF (v_value #>> '{}') !~ v_uuid THEN
        RETURN false;
      END IF;
    ELSIF v_kind = 'ids' THEN
      IF NOT private.workflow_advisory_context_set_valid(v_value, NULL) THEN
        RETURN false;
      END IF;
    ELSIF v_kind = 'token' THEN
      IF v_type <> 'string' THEN
        RETURN false;
      END IF;
      IF NOT ((v_value #>> '{}') = ANY (v_allowed)) THEN
        RETURN false;
      END IF;
    ELSIF v_kind = 'tokens' THEN
      IF NOT private.workflow_advisory_context_set_valid(v_value, v_allowed) THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;

  -- No context may carry a 7-digit number or longer split across its counts.
  RETURN v_capacity < 10000000;
END;
$function$;

REVOKE ALL ON FUNCTION private.workflow_advisory_context_valid(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.workflow_advisory_context_valid(jsonb) IS
  'MINT-134: a workflow advisory context is a flat object of at most 16 declared keys (the closed list in this function, mirrored by CONTEXT_KEYS in src/lib/advisoryChecks.ts). count: an integer 0 to the key''s bound; id/ids: a lowercase UUID or a set of up to 20; token/tokens: a value or a set of up to 20 from the key''s closed vocabulary; flag: a boolean. The bounds of the count keys present multiply to under 10,000,000.';

-- ---------------------------------------------------------------------------
-- 3. The record tables: 13, ADVISORY_RECORD_TABLES. Adds parties,
--    organizations, memberships and notification_sequences, in the table
--    CHECK, the argument check and the org check.
-- ---------------------------------------------------------------------------
ALTER TABLE public.workflow_advisories
  DROP CONSTRAINT IF EXISTS workflow_advisories_record_table_check,
  ADD CONSTRAINT workflow_advisories_record_table_check CHECK (
    record_table IN ('providers', 'provider_groups', 'facilities', 'credential_cases', 'tasks',
                     'touches', 'import_runs', 'roster_mappings', 'sop_templates', 'parties',
                     'organizations', 'memberships', 'notification_sequences')
  );

CREATE OR REPLACE FUNCTION private.workflow_advisory_assert_args(
  p_org_id uuid,
  p_check_key text,
  p_severity text,
  p_record_table text,
  p_record_id uuid,
  p_context jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_org_required';
  END IF;
  IF NOT private.workflow_advisory_check_key_valid(p_check_key) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_check_key_invalid';
  END IF;
  IF p_severity IS NULL OR p_severity NOT IN ('advisory', 'block') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_severity_invalid';
  END IF;
  IF p_record_table IS NULL
     OR p_record_table NOT IN ('providers', 'provider_groups', 'facilities', 'credential_cases',
                               'tasks', 'touches', 'import_runs', 'roster_mappings',
                               'sop_templates', 'parties', 'organizations', 'memberships',
                               'notification_sequences') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_record_table_invalid';
  END IF;
  IF p_record_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_record_required';
  END IF;
  IF NOT private.workflow_advisory_context_valid(p_context) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_context_invalid';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION private.workflow_advisory_assert_args(uuid, text, text, text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.workflow_advisory_assert_args(uuid, text, text, text, uuid, jsonb) IS
  'MINT-134: raises 22023 with a stable workflow_advisory_* key when an org, check key, severity, record table, record id or context is missing or outside its vocabulary.';

-- ---------------------------------------------------------------------------
-- 4. Does the record belong to the org? Adds a branch for each new table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.workflow_advisory_record_in_org(
  p_record_table text,
  p_record_id uuid,
  p_org_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  -- notification_sequences comes with #561. Until that table exists its
  -- records are refused. PL/pgSQL plans a statement when it first runs, so
  -- the lookup below is never planned without the table, and the static
  -- branches keep working either way.
  IF p_record_table = 'notification_sequences' THEN
    IF pg_catalog.to_regclass('public.notification_sequences') IS NULL THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.notification_sequences AS r WHERE r.id = p_record_id AND r.org_id = p_org_id);
  END IF;
  RETURN CASE p_record_table
    WHEN 'providers' THEN EXISTS (
      SELECT 1 FROM public.providers AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'provider_groups' THEN EXISTS (
      SELECT 1 FROM public.provider_groups AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'facilities' THEN EXISTS (
      SELECT 1 FROM public.facilities AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'credential_cases' THEN EXISTS (
      SELECT 1 FROM public.credential_cases AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'tasks' THEN EXISTS (
      SELECT 1 FROM public.tasks AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'touches' THEN EXISTS (
      SELECT 1 FROM public.touches AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'import_runs' THEN EXISTS (
      SELECT 1 FROM public.import_runs AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'roster_mappings' THEN EXISTS (
      SELECT 1 FROM public.roster_mappings AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'sop_templates' THEN EXISTS (
      SELECT 1 FROM public.sop_templates AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'parties' THEN EXISTS (
      SELECT 1 FROM public.parties AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'memberships' THEN EXISTS (
      SELECT 1 FROM public.memberships AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    -- The org itself: only its own row.
    WHEN 'organizations' THEN EXISTS (
      SELECT 1 FROM public.organizations AS r WHERE r.id = p_record_id AND r.id = p_org_id)
    ELSE false
  END;
END;
$function$;

REVOKE ALL ON FUNCTION private.workflow_advisory_record_in_org(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.workflow_advisory_record_in_org(text, uuid, uuid) IS
  'MINT-134: true when the record (record_table, record_id) exists with org_id = p_org_id; for organizations, when it is the org''s own row; for notification_sequences, false until that table exists. Closed set of tables; false for any other table.';

-- ---------------------------------------------------------------------------
-- 5. Every context id names a record of the org. Adds sequence_id.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.workflow_advisory_context_id_in_org(
  p_key text,
  p_id uuid,
  p_org_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  -- sequence_id names a notification sequence (#561's table), refused until
  -- the table exists, the same way as the record branch.
  IF p_key = 'sequence_id' THEN
    IF pg_catalog.to_regclass('public.notification_sequences') IS NULL THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.notification_sequences AS r WHERE r.id = p_id AND r.org_id = p_org_id);
  END IF;
  RETURN CASE p_key
    WHEN 'import_run_id' THEN EXISTS (
      SELECT 1 FROM public.import_runs AS r WHERE r.id = p_id AND r.org_id = p_org_id)
    WHEN 'facility_ids' THEN EXISTS (
      SELECT 1 FROM public.facilities AS r WHERE r.id = p_id AND r.org_id = p_org_id)
    WHEN 'recipient_id' THEN EXISTS (
      SELECT 1 FROM public.memberships AS r WHERE r.user_id = p_id AND r.org_id = p_org_id)
    WHEN 'payer_id' THEN EXISTS (
      SELECT 1 FROM public.payers AS r
       WHERE r.id = p_id AND (r.org_id = p_org_id OR r.org_id IS NULL))
    WHEN 'template_ids' THEN EXISTS (
      SELECT 1 FROM public.sop_templates AS r
       WHERE r.id = p_id AND (r.org_id = p_org_id OR r.org_id IS NULL))
    ELSE false
  END;
END;
$function$;

REVOKE ALL ON FUNCTION private.workflow_advisory_context_id_in_org(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.workflow_advisory_context_id_in_org(text, uuid, uuid) IS
  'MINT-134: true when a context id under p_key names an existing record of the org (import run, facility, member, notification sequence once that table exists; payer or SOP template of the org or the global catalog). False for any key without a branch.';
