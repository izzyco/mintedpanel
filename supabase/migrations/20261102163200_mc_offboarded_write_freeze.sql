-- Mission Control M3: the offboarded write freeze.
--
-- When an organization's lifecycle stage is not writable (offboarded, and the
-- legacy inactive that reads as offboarded), every API write to its tenant
-- rows is refused with org_offboarded (SQLSTATE 42501). Reads keep working.
-- Reactivation is a lifecycle change by a platform admin (Reopen moves
-- offboarded to active through platform_set_org_lifecycle).
--
-- One trigger function, many triggers: block_writes_when_offboarded() runs
-- BEFORE INSERT, UPDATE and DELETE on every public table that carries org_id,
-- instead of restating the tenant policies (D3: 228 policy references).
--
-- The installer public.apply_offboarded_write_freeze() scans
-- information_schema for base tables in public with an org_id column and
-- creates the trigger where it is missing. It is idempotent and safe to call
-- any number of times. This migration calls it once; any later migration that
-- adds a tenant table calls it again, as its last statement:
--
--   SELECT public.apply_offboarded_write_freeze();
--
-- Tables the freeze never attaches to (FREEZE_EXEMPT_TABLES, below):
--   admin_audit_log   the platform ledger records the offboarding itself
--   audit_log         reads write READ rows (profile reads), and reads work
--   memberships       access, not tenant data: a platform admin grants
--                     themself a membership to read an offboarded org, and
--                     claim_invites() runs at every sign-in
--   pending_invites   access, the other half of claim_invites()
--
-- What the function itself always allows (FREEZE_ALLOWED_OPERATIONS, in the
-- function, so it holds even on a trigger attached by hand):
--   sms_consents DELETE, sms_consent_archive INSERT
--     deleting an organization cascades into sms_consents, whose BEFORE
--     DELETE trigger copies each row into the archive; consent evidence that
--     survives an organization delete is a compliance floor
--   a session with no request.jwt.claims
--     migrations and operator SQL are direct database sessions, not API
--     traffic (PostgREST sets the claims for anon, authenticated and
--     service_role alike), so a later backfill migration never fails on an
--     offboarded organization's rows
--
-- Tables with org_id on the migration chain when this file was written (the
-- installer attached the trigger to each one not listed above):
--   case_facilities, case_generation_exclusions, case_generation_run_rows,
--   case_generation_runs, case_status_history, communication_event,
--   contract_sop_assignments, contracts, credential_cases,
--   denial_reason_codes, enrollment_facts, facilities, field_dictionary,
--   fill_sessions, form_mapping_reset_events, group_insurance_policies,
--   import_rows, import_runs, launches, mso_routing_rules, msos,
--   next_best_action_configs, notes, org_payer_assignments,
--   org_payer_settings, parties, party_capture_links, party_role_assignments,
--   payer_network_targets, payer_pipeline_history, payers, portal_field_maps,
--   portals, provider_documents, provider_facility_assignments,
--   provider_field_verifications, provider_group_assignments, provider_groups,
--   provider_intake_invites, provider_ssn_intake_links, provider_ssn_vault,
--   providers, roster_export_overrides, roster_export_snapshots,
--   roster_mappings, roster_templates, sop_template_drafts, sop_templates,
--   state_licenses, status_configs, status_history, tasks, touches,
--   workflow_advisories
-- Rows with a NULL org_id (global payers, shared portal maps, global SOP
-- templates) belong to no organization and are never frozen. Idempotent.

-- The org's stage is writable unless its configured stage says otherwise. An
-- organization whose stage is missing from lifecycle_stages stays writable:
-- the lifecycle trigger refuses unknown keys, so this only happens if a stage
-- row is deleted, and a write freeze must never come from missing config.
CREATE OR REPLACE FUNCTION public.org_is_writable(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM public.organizations o
      JOIN public.lifecycle_stages s ON s.key = public.normalize_lifecycle_state(o.lifecycle_state)
     WHERE o.id = p_org_id AND NOT s.writable
  );
$$;
REVOKE ALL ON FUNCTION public.org_is_writable(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_is_writable(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.block_writes_when_offboarded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- FREEZE_ALLOWED_OPERATIONS: the one place these exceptions live.
  IF (TG_TABLE_NAME = 'sms_consents' AND TG_OP = 'DELETE')
     OR (TG_TABLE_NAME = 'sms_consent_archive' AND TG_OP = 'INSERT') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF nullif(current_setting('request.jwt.claims', true), '') IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.org_id IS NOT NULL
     AND NOT public.org_is_writable(OLD.org_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'org_offboarded',
      DETAIL = 'This organization is offboarded. Reads still work; changes are turned off.';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.org_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.org_id IS DISTINCT FROM OLD.org_id)
     AND NOT public.org_is_writable(NEW.org_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'org_offboarded',
      DETAIL = 'This organization is offboarded. Reads still work; changes are turned off.';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION public.block_writes_when_offboarded() FROM PUBLIC, anon, authenticated;

-- Returns the tables it attached the trigger to on this call (empty when
-- nothing was missing).
CREATE OR REPLACE FUNCTION public.apply_offboarded_write_freeze()
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  -- FREEZE_EXEMPT_TABLES
  v_exempt constant text[] := ARRAY['admin_audit_log', 'audit_log', 'memberships', 'pending_invites'];
  v_table text;
  v_added text[] := ARRAY[]::text[];
BEGIN
  FOR v_table IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'org_id'
       AND t.table_type = 'BASE TABLE'
       AND NOT (c.table_name = ANY (v_exempt))
     ORDER BY c.table_name
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger tg
       WHERE tg.tgrelid = format('public.%I', v_table)::regclass
         AND tg.tgname = 'block_writes_when_offboarded'
         AND NOT tg.tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER block_writes_when_offboarded BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
        'FOR EACH ROW EXECUTE FUNCTION public.block_writes_when_offboarded()',
        v_table);
      v_added := v_added || v_table;
    END IF;
  END LOOP;
  RETURN v_added;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_offboarded_write_freeze() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_offboarded_write_freeze() TO service_role;

SELECT public.apply_offboarded_write_freeze();
