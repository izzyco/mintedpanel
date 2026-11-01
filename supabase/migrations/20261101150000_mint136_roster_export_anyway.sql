-- MINT-136 roster "Export anyway": an overrideable roster-validation hard
-- error is overridden with one click, with no typed reason, and the click is
-- recorded in MINT-134's workflow advisories with its rule and field
-- (Sowmya, Nov 1 2026, Addendum 9, U7). Non-overrideable errors stay hard:
-- the file goes to a payer and must be accurate. That rule lives in the app
-- (validation.exportable) and is unchanged here.
--
-- 1. roster_export_overrides.reason becomes nullable and loses its CHECK of
--    at least 20 characters (20260925203025, the inline CHECK on reason).
--    Free text can hold PII, and a typed reason contradicts fewest clicks.
--    Existing rows keep the reason they were written with: nothing here
--    rewrites a row, and the table stays append-only (its triggers are
--    untouched).
-- 2. public.roster_engine_record_override no longer requires a reason and
--    never stores one: the row's reason is NULL. p_reason stays in the
--    signature, now DEFAULT NULL, so a caller from before this change (one
--    that still sends a reason) resolves to the same function and records
--    the override; what it sends is dropped. The app stops sending it. Every
--    other check (writer membership, revision, fingerprint) and the audit_log
--    row are unchanged. Same signature, owner and grants (service_role only).
-- 3. private.workflow_advisory_context_valid gains two declared context keys
--    for roster_export.override, both closed vocabularies:
--      rule   the overrideable rule codes of src/lib/rosterValidation.ts.
--      field  the field keys those rules name, with "." spelled "_": every
--             column key of the seeded payer templates
--             (roster_engine_seed_templates) and the source fields the row
--             checks name (provider.npi is provider_npi).
--    The row count goes under #568's existing count key (bound 9999; a
--    roster holds at most 5,000 rows). The body is #568's, verbatim, with
--    the two VALUES rows added in key order; src/lib/advisoryChecks.contract.test.ts
--    reads this, the latest definition, and checks that nothing else
--    changed. A field key outside the list (a template added later) is left
--    out of the row by the app, never sent as text. A later check key or
--    vocabulary value is again a migration that replaces this function with
--    the union of every key so far.
--
-- No PHI: a rule code and a field key name a check and a column, never a
-- value. The record is the roster mapping (record_table roster_mappings,
-- already in #568's set).
--
-- Order: after 20261101090000_mint134_workflow_advisories.sql, which creates
-- the validator and the ledger. Apply this migration BEFORE deploying the app
-- that stops sending a reason: the old function refuses a missing or short
-- reason (roster_override_reason_too_short), so until this is applied an
-- override from the new app fails with a 422 and nothing is recorded.
--
-- Additive and re-runnable. REPO-ONLY until an operator applies it, staging
-- first. It has never been applied to a hosted database.
-- Verify the OBJECTS, not a ledger filename (supabase-migrations skill):
--   SELECT is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'roster_export_overrides'
--      AND column_name = 'reason';                                   -- YES
--   SELECT count(*) FROM pg_constraint c
--     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
--    WHERE c.conrelid = 'public.roster_export_overrides'::regclass
--      AND c.contype = 'c' AND a.attname = 'reason';                  -- 0
--   SELECT pronargdefaults, prosecdef, proconfig FROM pg_proc
--    WHERE oid = 'public.roster_engine_record_override(uuid, uuid, uuid, integer, text, text, text, text, text)'::regprocedure;
--     -> 1 | true | {search_path=""}
--   SELECT has_function_privilege('authenticated',
--            'public.roster_engine_record_override(uuid, uuid, uuid, integer, text, text, text, text, text)', 'EXECUTE'),
--          has_function_privilege('service_role',
--            'public.roster_engine_record_override(uuid, uuid, uuid, integer, text, text, text, text, text)', 'EXECUTE');
--     -> false | true
--   SELECT private.workflow_advisory_context_valid(
--            '{"rule": "facility_zip_plus_4_invalid", "field": "facility_zip", "count": 12}'),
--          private.workflow_advisory_context_valid('{"rule": "jane_smith"}');
--     -> true | false
--   The behavioural packet, supabase/tests/mint136-roster-export-anyway.sql,
--   needs a superuser and runs only in CI's disposable database, never hosted.

-- ---------------------------------------------------------------------------
-- 1. The reason column: nullable, no length CHECK. The CHECK was declared
--    inline, so its name is the server's choice; drop every CHECK on the
--    column by its attribute, not by a guessed name.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_constraint name;
BEGIN
  FOR v_constraint IN
    SELECT c.conname
      FROM pg_catalog.pg_constraint AS c
      JOIN pg_catalog.pg_attribute AS a
        ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'public.roster_export_overrides'::regclass
       AND c.contype = 'c'
       AND a.attname = 'reason'
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.roster_export_overrides DROP CONSTRAINT %I', v_constraint
    );
  END LOOP;
END
$$;

ALTER TABLE public.roster_export_overrides ALTER COLUMN reason DROP NOT NULL;

COMMENT ON COLUMN public.roster_export_overrides.reason IS
  'Legacy typed reason (at least 20 characters) for overrides recorded before MINT-136. NULL for every override since: "Export anyway" takes no typed text, and the bypass is recorded in workflow_advisories (roster_export.override) with its rule and field.';

-- ---------------------------------------------------------------------------
-- 2. The override RPC: no reason required, none stored. The body is
--    20260925203025's with the reason check removed and NULL inserted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.roster_engine_record_override(
  p_org_id uuid, p_actor_id uuid, p_mapping_id uuid, p_mapping_revision integer,
  p_input_fingerprint text, p_row_key text, p_rule_code text, p_field_key text,
  p_reason text DEFAULT NULL
) RETURNS public.roster_export_overrides LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text; v_current text; v_row public.roster_export_overrides%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL OR p_org_id IS NULL OR p_mapping_id IS NULL THEN RAISE EXCEPTION 'roster_actor_org_mapping_required' USING ERRCODE = '42501'; END IF;
  SELECT m.role INTO v_role FROM public.memberships m WHERE m.user_id = p_actor_id AND m.org_id = p_org_id;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'specialist') THEN RAISE EXCEPTION 'roster_writer_membership_required' USING ERRCODE = '42501'; END IF;
  -- MINT-136: no typed reason. p_reason is accepted for an older caller and
  -- never stored.
  IF NOT EXISTS (SELECT 1 FROM public.roster_mappings m WHERE m.id = p_mapping_id AND m.org_id = p_org_id AND m.revision = p_mapping_revision) THEN
    RAISE EXCEPTION 'roster_mapping_revision_conflict' USING ERRCODE = '40001';
  END IF;
  v_current := encode(pg_catalog.sha256(convert_to(public.roster_engine_build_source(p_org_id, p_mapping_id)::text, 'UTF8')), 'hex');
  IF v_current IS DISTINCT FROM p_input_fingerprint THEN RAISE EXCEPTION 'roster_input_fingerprint_stale' USING ERRCODE = '40001'; END IF;
  INSERT INTO public.roster_export_overrides(
    org_id, mapping_id, mapping_revision, input_fingerprint, row_key,
    rule_code, field_key, reason, created_by
  ) VALUES (
    p_org_id, p_mapping_id, p_mapping_revision, p_input_fingerprint, p_row_key,
    p_rule_code, p_field_key, NULL, p_actor_id
  ) RETURNING * INTO v_row;
  INSERT INTO public.audit_log(org_id, user_id, action_type, entity_type, entity_id, after, description)
  VALUES (p_org_id, p_actor_id, 'CREATE', 'roster_export_override', v_row.id,
    jsonb_build_object('mapping_id', p_mapping_id, 'mapping_revision', p_mapping_revision,
      'row_key', p_row_key, 'rule_code', p_rule_code, 'field_key', p_field_key,
      'input_fingerprint', p_input_fingerprint),
    'Recorded a provider roster validation override');
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.roster_engine_record_override(uuid, uuid, uuid, integer, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.roster_engine_record_override(uuid, uuid, uuid, integer, text, text, text, text, text)
  TO service_role;

COMMENT ON FUNCTION public.roster_engine_record_override(uuid, uuid, uuid, integer, text, text, text, text, text) IS
  'Records one roster validation override ("Export anyway", MINT-136) for an admin or specialist, bound to the mapping revision and the current source fingerprint, with an audit_log row. Takes no typed reason: p_reason is accepted for older callers and never stored (reason is NULL). service_role only.';

-- ---------------------------------------------------------------------------
-- 3. The context validator: #568's body with the rule and field rows added.
--    CREATE OR REPLACE, as #568 does: the table CHECK depends on it. Rows
--    already stored stay valid, since a key is only added.
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
        ('field', 'token', NULL, ARRAY['address_1', 'city', 'dob', 'facility_city', 'facility_state',
                                       'facility_street', 'facility_zip', 'first_name', 'group_name', 'group_npi',
                                       'individual_npi', 'last_name', 'license_expiration', 'license_license_number', 'license_number',
                                       'location_name', 'npi', 'phone', 'practice_name', 'provider_npi',
                                       'state', 'taxonomy', 'tin', 'zip_plus_4']),
        ('import_run_id', 'id', NULL, NULL),
        ('layer', 'token', NULL, ARRAY['platform', 'org']),
        ('line', 'count', 100000, NULL),
        ('payer_id', 'id', NULL, NULL),
        ('recipient_id', 'id', NULL, NULL),
        ('removed_count', 'count', 20, NULL),
        ('rule', 'token', NULL, ARRAY['active_state_license_missing', 'date_invalid', 'facility_city_missing',
                                      'facility_state_missing', 'facility_street_missing', 'facility_zip_plus_4_invalid',
                                      'npi_invalid', 'phone_invalid', 'provider_npi_invalid',
                                      'required_value_missing']),
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
  'MINT-134, MINT-136: a workflow advisory context is a flat object of at most 16 declared keys (the closed list in this function, mirrored by CONTEXT_KEYS in src/lib/advisoryChecks.ts). count: an integer 0 to the key''s bound; id/ids: a lowercase UUID or a set of up to 20; token/tokens: a value or a set of up to 20 from the key''s closed vocabulary; flag: a boolean. The bounds of the count keys present multiply to under 10,000,000. MINT-136 added rule and field (roster_export.override).';

NOTIFY pgrst, 'reload schema';
