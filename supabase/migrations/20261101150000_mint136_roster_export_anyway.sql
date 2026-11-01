-- MINT-136 roster "Export anyway": an overrideable roster-validation hard
-- error is overridden with one click, with no typed reason, and the click is
-- recorded with its rule and field (Sowmya, Nov 1 2026, Addendum 9, U7).
-- Non-overrideable errors stay hard: the file goes to a payer and must be
-- accurate. That rule lives in the app (validation.exportable) and is
-- unchanged here.
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
--
-- The override row keeps its rule_code and field_key, as before. The bypass
-- also goes to MINT-134's workflow advisories (roster_export.override on the
-- roster mapping, with the roster's row count under #568's existing count
-- key); that needs no SQL here. The closed rule_code and field_key context
-- vocabulary for that key belongs to the shared #568 registry PR, which
-- replaces private.workflow_advisory_context_valid once for every key: this
-- migration does not touch it.
--
-- Order: any time after 20260925203025_wp13_roster_engine_tables.sql; it
-- needs nothing from #568. Apply this migration BEFORE deploying the app
-- that stops sending a reason: the old function has no default for
-- p_reason, so PostgREST finds no function for the new app's call (PGRST202,
-- a 500 "Roster operation could not be completed") and nothing is recorded.
-- The old app keeps working after the apply: its reason is accepted and
-- dropped.
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
  'Legacy typed reason (at least 20 characters) for overrides recorded before MINT-136. NULL for every override since: "Export anyway" takes no typed text. The row keeps its rule_code and field_key, and the bypass is also recorded in workflow_advisories (roster_export.override).';

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

NOTIFY pgrst, 'reload schema';
