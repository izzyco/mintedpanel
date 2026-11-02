-- MINT-135: an SOP step may be ticked while earlier-ordered steps are still
-- open, and a task completed while earlier tasks are (Sowmya, Addendum 9,
-- U5). Before this, complete_sop_task_step refused the first with a 409
-- "Complete "X" first". Now the tick goes through, the earlier steps and
-- tasks stay open, and the bypass is recorded as one row in MINT-134's
-- workflow_advisories ledger, in the same transaction. This covers the Panel
-- task drawer, the /tasks/$id page and the extension's
-- PATCH /api/tasks/:id/steps.
--
-- complete_sop_task_step is replaced with 20261101110000's definition copied
-- exactly (SECURITY INVOKER, search_path, row locks, the MINT-75 completion
-- and termination days, audit, grants, comment). The only change: the
-- out-of-order refusal becomes a count of the earlier-ordered open steps,
-- and the function calls public.record_workflow_advisory (20261101090000)
-- before the audit insert, in one guarded call, for at most one of:
--   task.step_out_of_order       earlier-ordered steps are open. Context:
--                                step_order (the ticked step's order) and
--                                earlier_open_count (those steps).
--   task.completed_out_of_order  the tick moves the task to completed while
--                                earlier tasks of its case are open: lower
--                                sort_order, not completed, not a removed
--                                payer form (record_typed_enrollment_
--                                submission's rule). Context:
--                                earlier_open_count (those tasks).
-- Both use severity advisory and record (tasks, p_task_id). They never meet:
-- a tick with earlier steps open cannot complete the task.
--   source     panel for an authenticated caller, extension for service_role
--              (the ledger binds the source to the caller)
--   context    a count is left out when it is not an integer from 0 to 99,
--              as pickDeclared() drops it in code
--   actor      p_actor_id, already bound to auth.uid() for authenticated and
--              membership-checked for service_role above; the ledger checks
--              both again and reads the role from memberships.
-- record_workflow_advisory keeps all of MINT-134's guards (caller, actor,
-- E6.12 restricted clients, check key, context, record in org). If it refuses
-- or fails, the tick still completes: its own subtransaction rolls back and
-- the function raises one WARNING carrying the check key and SQLSTATE only
-- (the advisory_record_failed line the browser helper logs). A later failure
-- in this function (the audit insert) rolls the advisory back with the step.
--
-- Same signature, so CREATE OR REPLACE keeps the owner and leaves no second
-- overload. The guard below checks function signatures, not ledger versions:
-- it refuses to run without #557's 6-argument function (20261101110000; an
-- older 5-argument function would gain a 6-argument twin that PostgREST
-- cannot choose between) or without #568's record_workflow_advisory
-- (20261101090000; no ledger to record into). Re-runnable.
--
-- Deploy order: 20261101090000 (#568), 20261101110000 (#557), then this,
-- then the Panel. An older Panel against this function works unchanged (it
-- only offers the first open step). A newer Panel against the old function
-- offers every open step, and an out-of-order tick shows the old 409 as a
-- toast, writing nothing, until this is applied.
--
-- Verify the OBJECTS after an apply:
--   SELECT pg_get_function_identity_arguments(oid), prosecdef, proconfig,
--          pg_get_functiondef(oid) LIKE '%task.step_out_of_order%'
--     FROM pg_proc WHERE proname = 'complete_sop_task_step';
--     -> p_org_id uuid, p_task_id uuid, p_step_id text, p_actor_id uuid,
--        p_source text, p_completed_date date | false | {search_path=""} | true
--     (exactly one row)

DO $guard$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.complete_sop_task_step(uuid, uuid, text, uuid, text, date)'
     ) IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'mint135_requires_mint75_complete_sop_task_step',
      HINT = 'Apply #557''s 20261101110000 (MINT-75 SOP step local completed date) first.';
  END IF;
  IF pg_catalog.to_regprocedure(
       'public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'mint135_requires_record_workflow_advisory',
      HINT = 'Apply #568''s 20261101090000_mint134_workflow_advisories.sql first.';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.complete_sop_task_step(
  p_org_id uuid,
  p_task_id uuid,
  p_step_id text,
  p_actor_id uuid,
  p_source text,
  p_completed_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_role text;
  v_task public.tasks%ROWTYPE;
  v_case public.credential_cases%ROWTYPE;
  v_steps jsonb;
  v_target jsonb;
  v_target_order numeric;
  v_earlier_open integer;
  v_earlier_open_tasks integer;
  v_was_open boolean;
  v_check_key text;
  v_context jsonb;
  v_next_steps jsonb;
  v_all_done boolean;
  v_next_status text;
  v_completed_date date;
  v_now timestamptz;
  v_user_name text;
BEGIN
  IF p_step_id IS NULL OR pg_catalog.btrim(p_step_id) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'kind', 'rejected', 'status', 422, 'message', 'stepId is required'
    );
  END IF;

  IF p_source IS NULL OR p_source NOT IN ('panel', 'extension') THEN
    RETURN pg_catalog.jsonb_build_object(
      'kind', 'rejected', 'status', 422, 'message', 'source must be panel or extension'
    );
  END IF;

  IF p_org_id IS NULL OR p_task_id IS NULL OR p_actor_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'kind', 'rejected', 'status', 404, 'message', 'Task not found'
    );
  END IF;

  -- Browser calls run as authenticated and must bind attribution to auth.uid.
  -- The extension server uses its service-role client only after JWT and org
  -- membership resolution in the API guard; membership is rechecked below.
  IF current_user = 'authenticated' THEN
    IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
      RETURN pg_catalog.jsonb_build_object(
        'kind', 'rejected', 'status', 403, 'message', 'Actor does not match the authenticated user'
      );
    END IF;
  ELSIF current_user <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object(
      'kind', 'rejected', 'status', 403, 'message', 'Caller role cannot complete SOP steps'
    );
  END IF;

  -- Do not rely on p_org_id supplied by the caller. This membership check is
  -- explicit for both authenticated/RLS callers and the API's service client.
  SELECT m.role
    INTO v_role
    FROM public.memberships AS m
   WHERE m.org_id = p_org_id
     AND m.user_id = p_actor_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'kind', 'rejected', 'status', 404, 'message', 'Task not found'
    );
  END IF;

  IF v_role NOT IN ('specialist', 'admin') THEN
    RETURN pg_catalog.jsonb_build_object(
      'kind', 'rejected', 'status', 403, 'message', 'Your role cannot complete task steps'
    );
  END IF;

  -- Lock before reading sop_content. Concurrent callers now plan from the
  -- preceding committed version after waiting for this row lock.
  SELECT t.*
    INTO v_task
    FROM public.tasks AS t
   WHERE t.id = p_task_id
     AND t.org_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'kind', 'rejected', 'status', 404, 'message', 'Task not found'
    );
  END IF;

  -- A task may reference a case only in its own organization. Fail closed on
  -- corrupt historical cross-org links before changing any state.
  IF v_task.case_id IS NOT NULL THEN
    SELECT c.*
      INTO v_case
      FROM public.credential_cases AS c
     WHERE c.id = v_task.case_id
       AND c.org_id = p_org_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'kind', 'rejected', 'status', 409, 'message', 'Task case organization does not match'
      );
    END IF;
  END IF;

  v_steps := CASE
    WHEN pg_catalog.jsonb_typeof(v_task.sop_content) = 'array' THEN v_task.sop_content
    ELSE '[]'::jsonb
  END;

  SELECT s.step
    INTO v_target
    FROM pg_catalog.jsonb_array_elements(v_steps) WITH ORDINALITY AS s(step, ordinal)
   WHERE s.step ->> 'id' = p_step_id
   ORDER BY s.ordinal
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'kind', 'rejected', 'status', 404, 'message', 'Step not found on task'
    );
  END IF;

  -- Repeating the same completed step is a successful no-op. In particular,
  -- it does not append another audit event.
  IF v_target ->> 'isCompleted' = 'true' THEN
    SELECT COALESCE(
             pg_catalog.bool_and(s.step ->> 'isCompleted' = 'true'),
             true
           )
      INTO v_all_done
      FROM pg_catalog.jsonb_array_elements(v_steps) AS s(step);

    RETURN pg_catalog.jsonb_build_object(
      'kind', 'ok', 'task', pg_catalog.to_jsonb(v_task), 'allDone', v_all_done
    );
  END IF;

  v_target_order := CASE
    WHEN pg_catalog.jsonb_typeof(v_target -> 'order') = 'number'
      THEN (v_target ->> 'order')::numeric
    ELSE NULL
  END;

  -- MINT-135: earlier-ordered open steps no longer stop the tick. They stay
  -- open, and their count is recorded below as task.step_out_of_order.
  SELECT pg_catalog.count(*)::integer
    INTO v_earlier_open
    FROM pg_catalog.jsonb_array_elements(v_steps) AS s(step)
   WHERE v_target_order IS NOT NULL
     AND pg_catalog.jsonb_typeof(s.step -> 'order') = 'number'
     AND (s.step ->> 'order')::numeric < v_target_order
     AND s.step ->> 'isCompleted' IS DISTINCT FROM 'true';

  v_now := pg_catalog.clock_timestamp();
  SELECT pg_catalog.jsonb_agg(
           CASE
             WHEN s.step ->> 'id' = p_step_id THEN
               s.step || pg_catalog.jsonb_build_object(
                 'isCompleted', true,
                 'completedAt', pg_catalog.to_char(
                   v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 ),
                 'completedBy', p_actor_id
               )
             ELSE s.step
           END
           ORDER BY s.ordinal
         )
    INTO v_next_steps
    FROM pg_catalog.jsonb_array_elements(v_steps) WITH ORDINALITY AS s(step, ordinal);
  v_next_steps := COALESCE(v_next_steps, '[]'::jsonb);

  SELECT COALESCE(
           pg_catalog.bool_and(s.step ->> 'isCompleted' = 'true'),
           true
         )
    INTO v_all_done
    FROM pg_catalog.jsonb_array_elements(v_next_steps) AS s(step);

  v_next_status := CASE
    WHEN v_all_done THEN 'completed'
    WHEN v_task.status = 'not_started' THEN 'in_progress'
    ELSE v_task.status
  END;
  -- MINT-75: the caller's local day when it is within one day of the UTC day
  -- (every real zone is); anything else, or no date, falls back to UTC's day.
  v_completed_date := CASE
    WHEN v_all_done THEN CASE
      WHEN p_completed_date BETWEEN (v_now AT TIME ZONE 'UTC')::date - 1
                                AND (v_now AT TIME ZONE 'UTC')::date + 1
        THEN p_completed_date
      ELSE (v_now AT TIME ZONE 'UTC')::date
    END
    ELSE v_task.completed_date
  END;

  -- MINT-135: only a tick that moves the task to completed can complete it
  -- out of order.
  v_was_open := v_task.status IS DISTINCT FROM 'completed';

  UPDATE public.tasks AS t
     SET sop_content = v_next_steps,
         status = v_next_status,
         completed_date = v_completed_date,
         updated_at = v_now
   WHERE t.id = p_task_id
     AND t.org_id = p_org_id
   RETURNING t.* INTO v_task;

  IF v_all_done
     AND v_task.case_id IS NOT NULL
     AND pg_catalog.lower(v_task.title) LIKE 'submit termination%' THEN
    UPDATE public.credential_cases AS c
       SET termination_date = COALESCE(c.termination_date, v_completed_date)
     WHERE c.id = v_task.case_id
       AND c.org_id = p_org_id
       AND c.termination_date IS NULL;
  END IF;

  -- MINT-135: record the out-of-order tick in this transaction. A tick with
  -- earlier steps open is task.step_out_of_order. A tick that completes the
  -- task while earlier tasks of its case are open is
  -- task.completed_out_of_order: lower sort_order, not completed, and not a
  -- removed payer form (record_typed_enrollment_submission's rule). The two
  -- never meet, since a tick with earlier steps open cannot complete the task.
  -- The ledger checks the caller, actor, record and context itself; a refusal
  -- or failure is one WARNING and never blocks the tick.
  IF v_earlier_open > 0 THEN
    v_check_key := 'task.step_out_of_order';
    v_context := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'step_order', CASE
        WHEN v_target_order BETWEEN 0 AND 99
         AND v_target_order = pg_catalog.trunc(v_target_order)
          THEN v_target_order::integer
      END,
      'earlier_open_count', CASE WHEN v_earlier_open <= 99 THEN v_earlier_open END
    ));
  ELSIF v_was_open AND v_all_done AND v_task.case_id IS NOT NULL THEN
    SELECT pg_catalog.count(*)::integer
      INTO v_earlier_open_tasks
      FROM public.tasks AS prior_task
     WHERE prior_task.org_id = p_org_id
       AND prior_task.case_id = v_task.case_id
       AND prior_task.status <> 'completed'
       AND prior_task.sort_order < v_task.sort_order
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.jsonb_array_elements(
             CASE WHEN pg_catalog.jsonb_typeof(prior_task.sop_content) = 'array'
                  THEN prior_task.sop_content ELSE '[]'::jsonb END
           ) AS prior_step(step)
          WHERE prior_step.step->>'stepType' = 'pdf'
            AND nullif(pg_catalog.btrim(prior_step.step->'payerForm'->>'familyId'), '') IS NOT NULL
            AND nullif(pg_catalog.btrim(prior_step.step->'payerForm'->>'removedAt'), '') IS NOT NULL
       );
    IF v_earlier_open_tasks > 0 THEN
      v_check_key := 'task.completed_out_of_order';
      v_context := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'earlier_open_count', CASE WHEN v_earlier_open_tasks <= 99 THEN v_earlier_open_tasks END
      ));
    END IF;
  END IF;

  IF v_check_key IS NOT NULL THEN
    BEGIN
      PERFORM public.record_workflow_advisory(
        p_org_id,
        v_check_key,
        'advisory',
        'tasks',
        p_task_id,
        CASE WHEN current_user = 'authenticated' THEN 'panel' ELSE 'extension' END,
        v_context,
        p_actor_id
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '%', pg_catalog.json_build_object(
        'event', 'advisory_record_failed',
        'check_key', v_check_key,
        'sqlstate', SQLSTATE
      );
    END;
  END IF;

  -- MINT-8's audit actor trigger verifies authenticated attribution. Under
  -- service_role, retain the actor and profile name supplied by this verified
  -- API operation. Any insert error aborts task and case updates as one unit.
  SELECT COALESCE(NULLIF(pg_catalog.btrim(p.full_name), ''), p.email)
    INTO v_user_name
    FROM public.profiles AS p
   WHERE p.id = p_actor_id;

  INSERT INTO public.audit_log (
    org_id, user_id, user_name, action_type, entity_type, entity_id,
    before, after, description
  ) VALUES (
    p_org_id,
    p_actor_id,
    v_user_name,
    'UPDATE',
    'task',
    p_task_id,
    pg_catalog.jsonb_build_object('stepId', p_step_id, 'isCompleted', false),
    pg_catalog.jsonb_build_object(
      'stepId', p_step_id,
      'isCompleted', true,
      'taskStatus', v_task.status,
      'source', p_source
    ),
    'Completed SOP step "' || COALESCE(v_target ->> 'label', p_step_id) || '"'
  );

  RETURN pg_catalog.jsonb_build_object(
    'kind', 'ok', 'task', pg_catalog.to_jsonb(v_task), 'allDone', v_all_done
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_sop_task_step(uuid, uuid, text, uuid, text, date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_sop_task_step(uuid, uuid, text, uuid, text, date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.complete_sop_task_step(uuid, uuid, text, uuid, text, date)
  IS 'Atomically completes one ordered SOP step, updates its task and optional termination case, and appends one verified audit event.';

NOTIFY pgrst, 'reload schema';
