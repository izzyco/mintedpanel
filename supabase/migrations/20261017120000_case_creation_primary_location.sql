-- Case creation writes the primary case_facilities row.
--
-- E1.1 (20260827120000_e11_case_facilities.sql) made case_facilities the
-- location set and credential_cases.facility_id its PRIMARY MIRROR, and
-- backfilled the child rows once. create_case_with_tasks was never taught to
-- write the child row, so every case created since (generation and
-- ManualCaseModal both go through it) carries a facility_id with no
-- case_facilities row. Production on 2026-10-17: 36 of 72 cases, created
-- 2026-08-31 -> 2026-10-16. Those cases have no location in Billing
-- Readiness (it reads case_facilities only), and the typed fill-submission
-- guard rejects them as "Enrollment facility context is stale".
--
-- 1. create_case_with_tasks: same signature (exactly one overload), body
--    unchanged from 20261003120000_mint44_typed_sops.sql except one block —
--    when facility_id is set, insert the matching primary case_facilities
--    row in the same transaction. created_by = the creating user, the same
--    attribution addCaseFacility gives a first location. The function stays
--    SECURITY INVOKER: case_facilities_insert and credential_cases_insert
--    are the same writer policy, so nobody who can create a case today is
--    refused the child row. CREATE OR REPLACE keeps the existing grants.
--
--    Guarded: if the live function already writes case_facilities (draft
--    PR #520's 20261015160000_provider_primary_case_location_defaults.sql,
--    applied to staging only, is a superset of this change), it is left
--    alone, so this migration never reverts that body in either apply order.
--
-- 2. Backfill, the E1.1 shape: one primary row per case whose mirror is set,
--    created_by NULL (system backfill — the billing feed does not report it
--    as a coordinator linking a location). Skips any case that already has a
--    primary row (uq_case_facilities_primary_per_case) and is idempotent.
--    Expected on production 2026-10-17: 36 rows; staging: 0.

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'create_case_with_tasks'
      AND p.prosrc ILIKE '%INSERT INTO public.case_facilities%'
  ) THEN
    RAISE NOTICE 'create_case_with_tasks already writes case_facilities; left unchanged';
    RETURN;
  END IF;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.create_case_with_tasks(p_input jsonb, p_tasks jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := NULLIF(p_input->>'org_id','')::uuid;
  v_status uuid := NULLIF(p_input->>'credentialing_status_id','')::uuid;
  v_case public.credential_cases;
  v_task jsonb;
  v_task_id uuid;
  v_task_ids uuid[] := '{}';
  v_case_type text := coalesce(nullif(p_input->>'case_type', ''), 'enrollment');
  v_task_template_id uuid;
  v_task_version integer;
  v_stamp_template_id uuid;
  v_stamp_version integer;
  v_has_unstamped_task boolean := false;
  v_template public.sop_templates%ROWTYPE;
  v_version_case_type text;
  v_is_generic_fallback boolean;
  v_user uuid := auth.uid();
  v_user_name text;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF v_case_type <> 'enrollment' THEN RAISE EXCEPTION 'provider_case_type_unsupported'; END IF;
  IF jsonb_typeof(coalesce(p_tasks, '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'case_tasks_invalid';
  END IF;

  FOR v_task IN SELECT value FROM jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb))
  LOOP
    v_task_template_id := nullif(v_task->>'sop_template_id', '')::uuid;
    v_task_version := nullif(v_task->>'sop_version', '')::integer;
    IF v_task_template_id IS NOT NULL THEN
      IF v_stamp_template_id IS NOT NULL
         AND (v_stamp_template_id IS DISTINCT FROM v_task_template_id
              OR v_stamp_version IS DISTINCT FROM v_task_version) THEN
        RAISE EXCEPTION 'case_sop_stamp_mixed';
      END IF;
      v_stamp_template_id := v_task_template_id;
      v_stamp_version := v_task_version;
      SELECT case_type INTO v_version_case_type
      FROM public.sop_template_versions
      WHERE template_id = v_task_template_id AND version = v_task_version;
      IF NOT FOUND THEN RAISE EXCEPTION 'case_sop_type_mismatch'; END IF;
      SELECT * INTO v_template FROM public.sop_templates WHERE id = v_task_template_id;
      v_is_generic_fallback := v_template.id = '00000000-0000-4000-a000-00000000e17b'::uuid
        AND v_template.org_id IS NULL AND v_template.payer_id IS NULL
        AND v_template.group_id IS NULL AND v_template.state IS NULL
        AND v_template.states IS NULL;
      IF NOT FOUND
         OR v_version_case_type IS DISTINCT FROM v_case_type
         OR v_template.case_type IS DISTINCT FROM v_case_type
         OR v_template.current_version IS DISTINCT FROM v_task_version
         OR v_template.archived
         OR (v_template.group_id IS NOT NULL
             AND v_template.group_id IS DISTINCT FROM nullif(p_input->>'group_id', '')::uuid)
         OR (NOT v_is_generic_fallback AND (
              v_template.payer_id IS DISTINCT FROM nullif(p_input->>'payer_id', '')::uuid
              OR NOT ((p_input->>'state') = ANY(coalesce(v_template.states, ARRAY[v_template.state]))
                      OR coalesce(v_template.states, ARRAY[v_template.state]) = ARRAY['All']::text[])
            ))
         OR (v_template.org_id IS NOT NULL AND v_template.org_id IS DISTINCT FROM v_org) THEN
        RAISE EXCEPTION 'case_sop_type_mismatch';
      END IF;
    ELSE
      v_has_unstamped_task := true;
    END IF;
  END LOOP;
  IF v_stamp_template_id IS NOT NULL AND v_has_unstamped_task THEN
    RAISE EXCEPTION 'case_sop_stamp_incomplete';
  END IF;

  IF v_status IS NULL THEN
    SELECT id INTO v_status
    FROM public.status_configs
    WHERE org_id = v_org AND track = 'credentialing'
    ORDER BY sort_order ASC LIMIT 1;
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'No credentialing status configured for this organization. Add at least one credentialing status before creating cases.';
    END IF;
  END IF;
  SELECT COALESCE(full_name, email) INTO v_user_name
  FROM public.profiles WHERE id = v_user;

  INSERT INTO public.credential_cases (
    org_id, provider_id, payer_id, state, group_id, facility_id, specialty,
    credentialing_status_id, mso_id, assigned_to, submitted_date,
    expected_effective_date, generation_run_id, created_by, case_type
  ) VALUES (
    v_org, NULLIF(p_input->>'provider_id','')::uuid,
    NULLIF(p_input->>'payer_id','')::uuid, p_input->>'state',
    NULLIF(p_input->>'group_id','')::uuid,
    NULLIF(p_input->>'facility_id','')::uuid,
    NULLIF(p_input->>'specialty',''), v_status,
    NULLIF(p_input->>'mso_id','')::uuid,
    NULLIF(p_input->>'assigned_to','')::uuid,
    NULLIF(p_input->>'submitted_date','')::date,
    NULLIF(p_input->>'expected_effective_date','')::date,
    NULLIF(p_input->>'generation_run_id','')::uuid, v_user, v_case_type
  ) RETURNING * INTO v_case;

  -- The primary location is a case_facilities row; facility_id mirrors it.
  IF v_case.facility_id IS NOT NULL THEN
    INSERT INTO public.case_facilities (org_id, case_id, facility_id, is_primary, created_by)
    VALUES (v_org, v_case.id, v_case.facility_id, true, v_user);
  END IF;

  INSERT INTO public.status_history
    (org_id, case_id, track, from_status_id, to_status_id, metadata, changed_by)
  VALUES (v_org, v_case.id, 'credentialing', NULL, v_status, '{}'::jsonb, v_user);
  INSERT INTO public.case_status_history
    (org_id, case_id, from_status, to_status, actor_kind, changed_by)
  VALUES (v_org, v_case.id, NULL, v_case.case_status, 'system', v_user);

  FOR v_task IN SELECT value FROM jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb))
  LOOP
    INSERT INTO public.tasks (
      org_id, case_id, provider_id, title, description, sop_content,
      status, sort_order, due_date, is_auto_generated, sop_template_id,
      sop_version, execution_type, sop_resolution_tier
    ) VALUES (
      v_org, v_case.id, v_case.provider_id,
      COALESCE(NULLIF(v_task->>'title',''), 'Task'), v_task->>'description',
      COALESCE(v_task->'sop_content', '[]'::jsonb), 'not_started',
      COALESCE((v_task->>'sort_order')::int, 0),
      NULLIF(v_task->>'due_date','')::date, true,
      NULLIF(v_task->>'sop_template_id','')::uuid,
      NULLIF(v_task->>'sop_version','')::int,
      NULLIF(v_task->>'execution_type',''),
      NULLIF(v_task->>'sop_resolution_tier','')
    ) RETURNING id INTO v_task_id;
    v_task_ids := v_task_ids || v_task_id;
  END LOOP;

  INSERT INTO public.audit_log
    (org_id, user_id, user_name, action_type, entity_type, entity_id,
     before, after, description)
  VALUES (v_org, v_user, v_user_name, 'CREATE', 'credential_case', v_case.id,
          NULL, to_jsonb(v_case), 'Created credentialing case');
  IF coalesce(array_length(v_task_ids, 1), 0) > 0 THEN
    INSERT INTO public.audit_log
      (org_id, user_id, user_name, action_type, entity_type, entity_id,
       before, after, description)
    VALUES (
      v_org, v_user, v_user_name, 'CREATE', 'task', v_case.id, NULL,
      jsonb_build_object('caseId', v_case.id,
                         'count', array_length(v_task_ids, 1),
                         'taskIds', to_jsonb(v_task_ids)),
      'Auto-generated ' || array_length(v_task_ids, 1) || ' SOP task'
        || CASE WHEN array_length(v_task_ids, 1) = 1 THEN '' ELSE 's' END
        || ' for case'
    );
  END IF;
  RETURN to_jsonb(v_case);
END;
$function$
$ddl$;
END;
$migration$;

DO $verify$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_case_with_tasks'
  ) <> 1 THEN
    RAISE EXCEPTION 'create_case_with_tasks must have exactly one overload';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'create_case_with_tasks'
      AND p.prosrc ILIKE '%INSERT INTO public.case_facilities%'
  ) THEN
    RAISE EXCEPTION 'create_case_with_tasks does not write case_facilities';
  END IF;
END;
$verify$;

INSERT INTO public.case_facilities (org_id, case_id, facility_id, is_primary, created_by)
SELECT c.org_id, c.id, c.facility_id, true, NULL
FROM public.credential_cases c
WHERE c.facility_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.case_facilities cf
    WHERE cf.case_id = c.id AND cf.is_primary
  )
ON CONFLICT (case_id, facility_id) DO NOTHING;
