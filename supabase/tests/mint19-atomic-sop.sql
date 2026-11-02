-- MINT-19 authorization, idempotency, termination, and rollback checks, with
-- MINT-75's completion and termination days and MINT-135's out-of-order
-- ticks (allowed, recorded as one task.step_out_of_order advisory).
-- Run only after the disposable migration runner has applied the full schema.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
BEGIN;
-- Hosted Supabase grants authenticated USAGE on the auth schema; CI's plain
-- PostgreSQL seed does not. Every authenticated call below reaches auth.uid()
-- through the SECURITY INVOKER RPC body, the MINT-8 audit actor trigger and
-- the profiles_select_self policy, so mirror the hosted grant here. It is
-- transaction-local and rolls back with the final ROLLBACK (the same pattern
-- as mint58-exact-fill-submission.sql). anon and service_role need no such
-- grant: anon appears only in privilege checks, and the RPC's service_role
-- branch skips auth.uid(); the triggers it fires reach auth.uid() only through
-- SECURITY DEFINER functions, which run as their owner. auth.role() and
-- auth.jwt() are not called anywhere on this path.
GRANT USAGE ON SCHEMA auth TO authenticated;
SET LOCAL client_min_messages = warning;

CREATE TEMP TABLE mint19_results (
  ordinal bigint GENERATED ALWAYS AS IDENTITY,
  label text UNIQUE,
  passed boolean NOT NULL
);

CREATE FUNCTION pg_temp.mint19_assert(p_label text, p_passed boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_temp
AS $function$
BEGIN
  INSERT INTO mint19_results (label, passed) VALUES (p_label, COALESCE(p_passed, false));
END;
$function$;

CREATE FUNCTION pg_temp.mint19_try_audit_failure(
  p_org_id uuid,
  p_task_id uuid,
  p_actor_id uuid,
  p_step_id text DEFAULT 'only-step'
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_temp
AS $function$
DECLARE
  v_state text;
  v_message text;
BEGIN
  PERFORM public.complete_sop_task_step(
    p_org_id, p_task_id, p_step_id, p_actor_id, 'panel'
  );
  RETURN 'unexpected_success';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
  RETURN v_state || '|' || v_message;
END;
$function$;

-- These identities are synthetic and are removed by the final ROLLBACK.
INSERT INTO public.organizations (id, name) VALUES
  ('19000000-0000-4000-8000-000000000001', 'MINT-19 org A'),
  ('19000000-0000-4000-8000-000000000002', 'MINT-19 org B');

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('29000000-0000-4000-8000-000000000001', 'm19-a1@example.test', '{}'::jsonb),
  ('29000000-0000-4000-8000-000000000002', 'm19-a2@example.test', '{}'::jsonb),
  ('29000000-0000-4000-8000-000000000003', 'm19-billing@example.test', '{}'::jsonb),
  ('29000000-0000-4000-8000-000000000004', 'm19-b1@example.test', '{}'::jsonb);

INSERT INTO public.profiles (id, full_name, email) VALUES
  ('29000000-0000-4000-8000-000000000001', 'MINT-19 Specialist A1', 'm19-a1@example.test'),
  ('29000000-0000-4000-8000-000000000002', 'MINT-19 Specialist A2', 'm19-a2@example.test'),
  ('29000000-0000-4000-8000-000000000003', 'MINT-19 Billing', 'm19-billing@example.test'),
  ('29000000-0000-4000-8000-000000000004', 'MINT-19 Specialist B1', 'm19-b1@example.test');

INSERT INTO public.memberships (org_id, user_id, role) VALUES
  ('19000000-0000-4000-8000-000000000001', '29000000-0000-4000-8000-000000000001', 'specialist'),
  ('19000000-0000-4000-8000-000000000001', '29000000-0000-4000-8000-000000000002', 'admin'),
  ('19000000-0000-4000-8000-000000000001', '29000000-0000-4000-8000-000000000003', 'billing'),
  ('19000000-0000-4000-8000-000000000002', '29000000-0000-4000-8000-000000000004', 'specialist');

INSERT INTO public.providers (id, org_id, first_name, last_name) VALUES
  ('39000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001', 'M19', 'Provider A1'),
  ('39000000-0000-4000-8000-000000000002', '19000000-0000-4000-8000-000000000001', 'M19', 'Provider A2'),
  ('39000000-0000-4000-8000-000000000003', '19000000-0000-4000-8000-000000000002', 'M19', 'Provider B1');

INSERT INTO public.payers (id, org_id, name) VALUES
  ('49000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001', 'MINT-19 Payer A1'),
  ('49000000-0000-4000-8000-000000000002', '19000000-0000-4000-8000-000000000001', 'MINT-19 Payer A2'),
  ('49000000-0000-4000-8000-000000000003', '19000000-0000-4000-8000-000000000002', 'MINT-19 Payer B1');

INSERT INTO public.credential_cases (id, org_id, provider_id, payer_id, state) VALUES
  ('59000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001', '39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', 'CO'),
  ('59000000-0000-4000-8000-000000000002', '19000000-0000-4000-8000-000000000001', '39000000-0000-4000-8000-000000000002', '49000000-0000-4000-8000-000000000002', 'CO'),
  ('59000000-0000-4000-8000-000000000003', '19000000-0000-4000-8000-000000000002', '39000000-0000-4000-8000-000000000003', '49000000-0000-4000-8000-000000000003', 'KS');

INSERT INTO public.tasks (id, org_id, case_id, title, status, sop_content) VALUES
  (
    '69000000-0000-4000-8000-000000000001',
    '19000000-0000-4000-8000-000000000001',
    '59000000-0000-4000-8000-000000000001',
    'Submit termination paperwork',
    'not_started',
    '[{"id":"first","order":1,"label":"Prepare termination","isCompleted":false},{"id":"last","order":2,"label":"Submit termination","isCompleted":false}]'::jsonb
  ),
  (
    '69000000-0000-4000-8000-000000000002',
    '19000000-0000-4000-8000-000000000001',
    '59000000-0000-4000-8000-000000000003',
    'Corrupt cross-org case reference',
    'not_started',
    '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb
  ),
  (
    '69000000-0000-4000-8000-000000000003',
    '19000000-0000-4000-8000-000000000001',
    '59000000-0000-4000-8000-000000000002',
    'Submit termination paperwork',
    'not_started',
    '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb
  ),
  (
    '69000000-0000-4000-8000-000000000004',
    '19000000-0000-4000-8000-000000000001',
    '59000000-0000-4000-8000-000000000001',
    'MINT-19 stale SOP writer race',
    'not_started',
    '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb
  );

CREATE TEMP TABLE mint19_stale_sop_snapshot ON COMMIT DROP AS
SELECT id, org_id, sop_content_revision, sop_content
  FROM public.tasks
 WHERE id = '69000000-0000-4000-8000-000000000004';

SELECT pg_temp.mint19_assert(
  'anonymous cannot execute completion RPC',
  NOT pg_catalog.has_function_privilege(
    'anon',
    'public.complete_sop_task_step(uuid,uuid,text,uuid,text,date)',
    'EXECUTE'
  )
);
-- MINT-75 replaced the 5-argument signature; a second overload would make
-- every PostgREST call ambiguous.
SELECT pg_temp.mint19_assert(
  'completion RPC has exactly one signature',
  (SELECT count(*) = 1 FROM pg_catalog.pg_proc
    WHERE proname = 'complete_sop_task_step'
      AND pronamespace = 'public'::regnamespace)
);

-- MINT-75 tasks: one single-step task per completion-date case (UTC-1, UTC+1,
-- UTC-2, UTC-30, UTC+2, omitted), plus a two-step task whose first tick must
-- leave completed_date unset.
INSERT INTO public.tasks (id, org_id, case_id, title, status, sop_content) VALUES
  ('69000000-0000-4000-8000-000000000005', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002', 'MINT-75 local date in range', 'not_started',
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000006', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002', 'MINT-75 backdated local date', 'not_started',
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000007', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002', 'MINT-75 future local date', 'not_started',
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000008', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002', 'MINT-75 omitted local date', 'not_started',
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000009', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002', 'MINT-75 non-final step', 'not_started',
   '[{"id":"first","order":1,"label":"First","isCompleted":false},{"id":"last","order":2,"label":"Last","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000010', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002', 'MINT-75 local date UTC+1', 'not_started',
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000011', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002', 'MINT-75 local date UTC-2', 'not_started',
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb);

-- MINT-75 termination tasks whose last step sets the case's
-- termination_date. One case per day case (UTC-1, UTC+1, omitted, UTC-30), each
-- with no termination_date yet, plus one whose termination_date is already set.
INSERT INTO public.credential_cases (id, org_id, provider_id, payer_id, state, termination_date) VALUES
  ('59000000-0000-4000-8000-000000000004', '19000000-0000-4000-8000-000000000001', '39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', 'NC', NULL),
  ('59000000-0000-4000-8000-000000000005', '19000000-0000-4000-8000-000000000001', '39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', 'SC', NULL),
  ('59000000-0000-4000-8000-000000000006', '19000000-0000-4000-8000-000000000001', '39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', 'UT', NULL),
  ('59000000-0000-4000-8000-000000000007', '19000000-0000-4000-8000-000000000001', '39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', 'NM', NULL),
  ('59000000-0000-4000-8000-000000000008', '19000000-0000-4000-8000-000000000001', '39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', 'WY', '2026-01-15');

INSERT INTO public.tasks (id, org_id, case_id, title, status, sop_content) VALUES
  ('69000000-0000-4000-8000-000000000012', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000004', 'Submit termination MINT-75 local day UTC-1', 'not_started',
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000013', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000005', 'Submit termination MINT-75 local day UTC+1', 'not_started',
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000014', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000006', 'Submit termination MINT-75 omitted day', 'not_started',
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000015', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000007', 'Submit termination MINT-75 backdated day', 'not_started',
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000016', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000008', 'Submit termination MINT-75 already terminated', 'not_started',
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb);

-- The UTC day the RPC falls back to (clock_timestamp may cross midnight after
-- the transaction's now(), so either day is accepted).
CREATE FUNCTION pg_temp.mint75_is_utc_day(p_value text)
RETURNS boolean
LANGUAGE sql
AS $function$
  SELECT p_value::date IN (
    (pg_catalog.now() AT TIME ZONE 'UTC')::date,
    (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date
  );
$function$;

SET LOCAL request.jwt.claim.sub = '29000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.mint19_assert(
  'MINT-75 a local date one day behind UTC (UTC-1) is stored',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000005',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel',
    (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date - 1
  ) -> 'task' ->> 'completed_date')::date
    = (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date - 1
);
SELECT pg_temp.mint19_assert(
  'MINT-75 a local date one day ahead of UTC (UTC+1) is stored',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000010',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel',
    (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date + 1
  ) -> 'task' ->> 'completed_date')::date
    = (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date + 1
);
SELECT pg_temp.mint19_assert(
  'MINT-75 a local date two days behind UTC (UTC-2) falls back to the UTC day',
  pg_temp.mint75_is_utc_day(public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000011',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel',
    (pg_catalog.now() AT TIME ZONE 'UTC')::date - 2
  ) -> 'task' ->> 'completed_date')
);
SELECT pg_temp.mint19_assert(
  'MINT-75 a backdated local date falls back to the UTC day',
  pg_temp.mint75_is_utc_day(public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000006',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel',
    (pg_catalog.now() AT TIME ZONE 'UTC')::date - 30
  ) -> 'task' ->> 'completed_date')
);
SELECT pg_temp.mint19_assert(
  'MINT-75 a local date two days ahead falls back to the UTC day',
  pg_temp.mint75_is_utc_day(public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000007',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel',
    (pg_catalog.now() AT TIME ZONE 'UTC')::date + 2
  ) -> 'task' ->> 'completed_date')
);
SELECT pg_temp.mint19_assert(
  'MINT-75 an omitted local date keeps the UTC day',
  pg_temp.mint75_is_utc_day(public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000008',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) -> 'task' ->> 'completed_date')
);
SELECT pg_temp.mint19_assert(
  'MINT-75 a local date on a non-final step leaves completed_date unset',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000009',
    'first',
    '29000000-0000-4000-8000-000000000001',
    'panel',
    (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date - 1
  ) -> 'task' -> 'completed_date') = 'null'::jsonb
);
RESET ROLE;

-- MINT-75 (20261101110000): the last step of a termination task sets
-- termination_date to the task's completed_date, so the caller's local day
-- when it is within one day of UTC's, else UTC's day. Each RPC call is its own
-- statement: a later statement is what sees its writes.
SET LOCAL request.jwt.claim.sub = '29000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.mint19_assert(
  'MINT-75 termination step (UTC-1) completes',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000012',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel',
    (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date - 1
  ) ->> 'kind') = 'ok'
);
SELECT pg_temp.mint19_assert(
  'MINT-75 termination step (UTC+1) completes',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000013',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel',
    (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date + 1
  ) ->> 'kind') = 'ok'
);
SELECT pg_temp.mint19_assert(
  'MINT-75 termination step with no day completes',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000014',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'kind') = 'ok'
);
SELECT pg_temp.mint19_assert(
  'MINT-75 termination step with a backdated day completes',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000015',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel',
    (pg_catalog.now() AT TIME ZONE 'UTC')::date - 30
  ) ->> 'kind') = 'ok'
);
SELECT pg_temp.mint19_assert(
  'MINT-75 termination step on an already terminated case completes',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000016',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel',
    (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date - 1
  ) ->> 'kind') = 'ok'
);
RESET ROLE;

SELECT pg_temp.mint19_assert(
  'MINT-75 termination takes the local day passed (UTC-1), the same as completed_date',
  (SELECT c.termination_date = (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date - 1
          AND c.termination_date = t.completed_date
     FROM public.tasks AS t
     JOIN public.credential_cases AS c ON c.id = t.case_id
    WHERE t.id = '69000000-0000-4000-8000-000000000012')
);
SELECT pg_temp.mint19_assert(
  'MINT-75 termination takes the local day passed (UTC+1), the same as completed_date',
  (SELECT c.termination_date = (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date + 1
          AND c.termination_date = t.completed_date
     FROM public.tasks AS t
     JOIN public.credential_cases AS c ON c.id = t.case_id
    WHERE t.id = '69000000-0000-4000-8000-000000000013')
);
SELECT pg_temp.mint19_assert(
  'MINT-75 termination with no day passed falls back to the UTC day',
  (SELECT pg_temp.mint75_is_utc_day(c.termination_date::text)
          AND c.termination_date = t.completed_date
     FROM public.tasks AS t
     JOIN public.credential_cases AS c ON c.id = t.case_id
    WHERE t.id = '69000000-0000-4000-8000-000000000014')
);
SELECT pg_temp.mint19_assert(
  'MINT-75 termination with a day outside the one-day window falls back to the UTC day',
  (SELECT pg_temp.mint75_is_utc_day(c.termination_date::text)
          AND c.termination_date = t.completed_date
     FROM public.tasks AS t
     JOIN public.credential_cases AS c ON c.id = t.case_id
    WHERE t.id = '69000000-0000-4000-8000-000000000015')
);
SELECT pg_temp.mint19_assert(
  'MINT-75 an existing termination_date is never overwritten',
  (SELECT c.termination_date = DATE '2026-01-15'
          AND t.completed_date = (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date - 1
     FROM public.tasks AS t
     JOIN public.credential_cases AS c ON c.id = t.case_id
    WHERE t.id = '69000000-0000-4000-8000-000000000016')
);
SELECT pg_temp.mint19_assert(
  'completion RPC stays executable by authenticated and service_role only',
  pg_catalog.has_function_privilege(
    'authenticated', 'public.complete_sop_task_step(uuid,uuid,text,uuid,text,date)', 'EXECUTE'
  )
  AND pg_catalog.has_function_privilege(
    'service_role', 'public.complete_sop_task_step(uuid,uuid,text,uuid,text,date)', 'EXECUTE'
  )
  AND NOT pg_catalog.has_function_privilege(
    'anon', 'public.complete_sop_task_step(uuid,uuid,text,uuid,text,date)', 'EXECUTE'
  )
  AND NOT pg_catalog.has_function_privilege(
    'public', 'public.complete_sop_task_step(uuid,uuid,text,uuid,text,date)', 'EXECUTE'
  )
);
SELECT pg_temp.mint19_assert(
  'completion RPC stays SECURITY INVOKER with an empty search_path',
  (SELECT NOT p.prosecdef AND p.proconfig = ARRAY['search_path=""']::text[]
     FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'public.complete_sop_task_step(uuid,uuid,text,uuid,text,date)'::regprocedure)
);

SET LOCAL request.jwt.claim.sub = '29000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.mint19_assert(
  'source is constrained',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000001',
    'first',
    '29000000-0000-4000-8000-000000000001',
    'other'
  ) ->> 'status')::integer = 422
);
SELECT pg_temp.mint19_assert(
  'authenticated actor cannot be forged',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000001',
    'first',
    '29000000-0000-4000-8000-000000000002',
    'panel'
  ) ->> 'status')::integer = 403
);
SELECT pg_temp.mint19_assert(
  'wrong organization is hidden',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000002',
    '69000000-0000-4000-8000-000000000001',
    'first',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'status')::integer = 404
);
SELECT pg_temp.mint19_assert(
  'cross-org task case reference is rejected',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000002',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'status')::integer = 409
);
RESET ROLE;

SET LOCAL request.jwt.claim.sub = '29000000-0000-4000-8000-000000000004';
SET LOCAL ROLE authenticated;
SELECT pg_temp.mint19_assert(
  'org B authenticated user cannot access org A task',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000001',
    'first',
    '29000000-0000-4000-8000-000000000004',
    'panel'
  ) ->> 'status')::integer = 404
);
RESET ROLE;

SET LOCAL request.jwt.claim.sub = '29000000-0000-4000-8000-000000000003';
SET LOCAL ROLE authenticated;
SELECT pg_temp.mint19_assert(
  'billing membership cannot complete task steps',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000001',
    'first',
    '29000000-0000-4000-8000-000000000003',
    'panel'
  ) ->> 'status')::integer = 403
);
RESET ROLE;

SET LOCAL request.jwt.claim.sub = '29000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.mint19_assert(
  'first step completes through authenticated role',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000001',
    'first',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'kind') = 'ok'
);
SELECT pg_temp.mint19_assert(
  'single-step task completes through authenticated role',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000004',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'kind') = 'ok'
);
RESET ROLE;
SELECT pg_temp.mint19_assert(
  'RPC step completion advances the SOP content revision',
  (SELECT t.sop_content_revision = s.sop_content_revision + 1
     FROM public.tasks AS t
     JOIN mint19_stale_sop_snapshot AS s ON s.id = t.id)
);

-- Model attach/detach/remove's stale full-array payload with the revision the
-- service read before the completion RPC. Its CAS update must affect no row.
DO $function$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.tasks AS t
     SET sop_content = pg_catalog.jsonb_set(
       s.sop_content,
       '{0,attachments}',
       '[{"documentId":"stale-write"}]'::jsonb,
       true
     )
    FROM mint19_stale_sop_snapshot AS s
   WHERE t.id = s.id
     AND t.org_id = s.org_id
     AND t.sop_content_revision = s.sop_content_revision;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  PERFORM pg_temp.mint19_assert('stale full-array SOP write is rejected', v_updated = 0);

  WITH current_task AS (
    SELECT id, org_id, sop_content_revision, sop_content
      FROM public.tasks
     WHERE id = '69000000-0000-4000-8000-000000000004'
  )
  UPDATE public.tasks AS t
     SET sop_content = pg_catalog.jsonb_set(
       current_task.sop_content,
       '{0,attachments}',
       '[{"documentId":"retry-write"}]'::jsonb,
       true
     )
    FROM current_task
   WHERE t.id = current_task.id
     AND t.org_id = current_task.org_id
     AND t.sop_content_revision = current_task.sop_content_revision;

  PERFORM pg_temp.mint19_assert(
    'successful stale-writer retry preserves completion and its attachment',
    (SELECT t.sop_content_revision = s.sop_content_revision + 2
            AND t.sop_content -> 0 ->> 'isCompleted' = 'true'
            AND t.sop_content -> 0 -> 'attachments' -> 0 ->> 'documentId' = 'retry-write'
       FROM public.tasks AS t
       JOIN mint19_stale_sop_snapshot AS s ON s.id = t.id)
  );
END;
$function$;

-- MINT-135 (20261101160000): a step may be ticked while earlier-ordered steps
-- are still open. The tick completes, the earlier steps stay open, and one
-- task.step_out_of_order advisory is written in the same transaction, before
-- the audit row. An in-order tick, and a repeat of a completed step, write
-- none. A ledger refusal never blocks the tick.
INSERT INTO public.tasks (id, org_id, case_id, title, status, sop_content) VALUES
  ('69000000-0000-4000-8000-000000000017', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002', 'MINT-135 three steps', 'not_started',
   '[{"id":"a","order":1,"label":"A","isCompleted":false},{"id":"b","order":2,"label":"B","isCompleted":false},{"id":"c","order":3,"label":"C","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000018', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002', 'MINT-135 extension tick', 'not_started',
   '[{"id":"a","order":1,"label":"A","isCompleted":false},{"id":"b","order":2,"label":"B","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000019', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002', 'MINT-135 ledger refuses', 'not_started',
   '[{"id":"a","order":1,"label":"A","isCompleted":false},{"id":"b","order":2,"label":"B","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000020', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002', 'MINT-135 audit failure', 'not_started',
   '[{"id":"a","order":1,"label":"A","isCompleted":false},{"id":"b","order":2,"label":"B","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000021', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002', 'MINT-135 step order past the bound', 'not_started',
   '[{"id":"a","order":1,"label":"A","isCompleted":false},{"id":"b","order":150,"label":"B","isCompleted":false}]'::jsonb);

-- MINT-135 task order: one case whose tasks run by sort_order. An open first
-- task, a removed payer form and a completed task before the later task, so
-- exactly one earlier task counts as open; then an already completed task
-- that still has an open step.
INSERT INTO public.credential_cases (id, org_id, provider_id, payer_id, state) VALUES
  ('59000000-0000-4000-8000-000000000009', '19000000-0000-4000-8000-000000000001', '39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', 'ID');
INSERT INTO public.tasks (id, org_id, case_id, title, status, sort_order, sop_content) VALUES
  ('69000000-0000-4000-8000-000000000022', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000009', 'MINT-135 earlier open task', 'in_progress', 0,
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000023', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000009', 'MINT-135 removed payer form', 'blocked', 1,
   '[{"id":"form","order":1,"label":"Send payer form","isCompleted":false,"stepType":"pdf","payerForm":{"familyId":"family-1","removedAt":"2026-11-01T00:00:00Z"}}]'::jsonb),
  ('69000000-0000-4000-8000-000000000024', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000009', 'MINT-135 earlier completed task', 'completed', 2,
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":true}]'::jsonb),
  ('69000000-0000-4000-8000-000000000025', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000009', 'MINT-135 later task', 'not_started', 3,
   '[{"id":"a","order":1,"label":"A","isCompleted":false},{"id":"b","order":2,"label":"B","isCompleted":false}]'::jsonb),
  ('69000000-0000-4000-8000-000000000026', '19000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000009', 'MINT-135 already completed task', 'completed', 4,
   '[{"id":"only-step","order":1,"label":"Only step","isCompleted":false}]'::jsonb);

-- MINT-135 typed submission: with the RPC's 409 gone, its own earlier-step
-- check is what keeps the extension's Work-in-portal submission on the
-- current step. An enrollment case with one two-form Auto-fill task.
INSERT INTO public.sop_templates (
  id, org_id, name, payer_id, state, states, task_definitions,
  archived, current_version, required_profile_attributes, case_type
) VALUES (
  '79000000-0000-4000-8000-000000000001',
  '19000000-0000-4000-8000-000000000001', 'MINT-135 enrollment SOP',
  '49000000-0000-4000-8000-000000000001', 'WA', ARRAY['WA']::text[], '[]'::jsonb,
  false, 1, '[]'::jsonb, 'enrollment'
);
INSERT INTO public.credential_cases (id, org_id, provider_id, payer_id, state, case_type, case_status) VALUES
  ('59000000-0000-4000-8000-000000000010', '19000000-0000-4000-8000-000000000001', '39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', 'WA', 'enrollment', 'in_progress');
INSERT INTO public.tasks (
  id, org_id, case_id, provider_id, title, status, sort_order, sop_content,
  sop_template_id, sop_version, execution_type
) VALUES (
  '69000000-0000-4000-8000-000000000030', '19000000-0000-4000-8000-000000000001',
  '59000000-0000-4000-8000-000000000010', '39000000-0000-4000-8000-000000000001',
  'MINT-135 typed submission', 'in_progress', 1,
  '[{"id":"form-1","order":1,"label":"First form","stepType":"online_form","portalKey":"mint135_portal","isCompleted":false},{"id":"form-2","order":2,"label":"Second form","stepType":"online_form","portalKey":"mint135_portal","isCompleted":false}]'::jsonb,
  '79000000-0000-4000-8000-000000000001', 1, 'extension_fill'
);

-- The typed submission's work context for one step of that task, at the
-- case's current context version. No portal row exists, so a submission that
-- passes the step check stops at the portal check.
CREATE FUNCTION pg_temp.mint135_typed_submission(p_step_id text, p_touch_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_temp
AS $function$
  SELECT public.record_typed_enrollment_submission(
    '19000000-0000-4000-8000-000000000001',
    '29000000-0000-4000-8000-000000000002',
    '59000000-0000-4000-8000-000000000010',
    p_touch_id,
    NULL,
    pg_catalog.jsonb_build_object(
      'launchReceiptId', '89000000-0000-4000-8000-000000000001',
      'orgId', '19000000-0000-4000-8000-000000000001',
      'ownerKind', 'case',
      'ownerId', '59000000-0000-4000-8000-000000000010',
      'contextVersion', (SELECT c.context_version FROM public.credential_cases AS c
                          WHERE c.id = '59000000-0000-4000-8000-000000000010'),
      'sopTemplateId', '79000000-0000-4000-8000-000000000001',
      'sopVersion', 1,
      'portalId', '89000000-0000-4000-8000-000000000002',
      'portalKey', 'mint135_portal',
      'mappingGeneration', 1,
      'effectiveMappingFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
      'providerId', '39000000-0000-4000-8000-000000000001',
      'facilityId', NULL,
      'stepIdentity', '59000000-0000-4000-8000-000000000010:69000000-0000-4000-8000-000000000030:79000000-0000-4000-8000-000000000001:1:' || p_step_id,
      'taskId', '69000000-0000-4000-8000-000000000030',
      'stepId', p_step_id
    ),
    '{"note":null,"payerReferenceId":null,"wipNote":null,"pdfFilename":null}'::jsonb
  );
$function$;

-- The ledger refuses every row for the "ledger refuses" task.
CREATE FUNCTION public.mint135_fail_test_advisory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.record_id = '69000000-0000-4000-8000-000000000019'::uuid THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'mint135_ledger_failure';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER zz_mint135_ledger_failure
  BEFORE INSERT ON public.workflow_advisories
  FOR EACH ROW EXECUTE FUNCTION public.mint135_fail_test_advisory();

SET LOCAL request.jwt.claim.sub = '29000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.mint19_assert(
  'MINT-135 an out-of-order step completes instead of returning a conflict',
  (SELECT r ->> 'kind' = 'ok' AND (r ->> 'allDone')::boolean = false
     FROM (SELECT public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000017',
    'c',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) AS r) AS x)
);
SELECT pg_temp.mint19_assert(
  'MINT-135 repeating the out-of-order step is a no-op',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000017',
    'c',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'kind') = 'ok'
);
SELECT pg_temp.mint19_assert(
  'MINT-135 a step order past the context bound completes',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000021',
    'b',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'kind') = 'ok'
);
SELECT pg_temp.mint19_assert(
  'MINT-135 a ledger refusal does not block the tick',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000019',
    'b',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'kind') = 'ok'
);
RESET ROLE;

SELECT pg_temp.mint19_assert(
  'MINT-135 the earlier steps stay open and the task is in progress',
  (SELECT t.status = 'in_progress'
          AND t.completed_date IS NULL
          AND t.sop_content -> 0 ->> 'isCompleted' = 'false'
          AND t.sop_content -> 1 ->> 'isCompleted' = 'false'
          AND t.sop_content -> 2 ->> 'isCompleted' = 'true'
     FROM public.tasks AS t
    WHERE t.id = '69000000-0000-4000-8000-000000000017')
);
SELECT pg_temp.mint19_assert(
  'MINT-135 the out-of-order tick writes one advisory in its own transaction',
  (SELECT pg_catalog.count(*) = 1
          AND pg_catalog.bool_and(w.bypassed_at = pg_catalog.now())
     FROM public.workflow_advisories AS w
    WHERE w.record_id = '69000000-0000-4000-8000-000000000017')
);
SELECT pg_temp.mint19_assert(
  'MINT-135 the advisory names the check, the task, the panel and the verified actor',
  (SELECT w.org_id = '19000000-0000-4000-8000-000000000001'
          AND w.check_key = 'task.step_out_of_order'
          AND w.severity_at_time = 'advisory'
          AND w.record_table = 'tasks'
          AND w.source = 'panel'
          AND w.job IS NULL
          AND w.actor_id = '29000000-0000-4000-8000-000000000001'
          AND w.actor_role = 'specialist'
          AND w.resolved_at IS NULL
     FROM public.workflow_advisories AS w
    WHERE w.record_id = '69000000-0000-4000-8000-000000000017')
);
SELECT pg_temp.mint19_assert(
  'MINT-135 the advisory context is the step order and the earlier open count',
  (SELECT w.context = '{"step_order": 3, "earlier_open_count": 2}'::jsonb
     FROM public.workflow_advisories AS w
    WHERE w.record_id = '69000000-0000-4000-8000-000000000017')
);
SELECT pg_temp.mint19_assert(
  'MINT-135 a step order past the context bound is left out of the context',
  (SELECT pg_catalog.count(*) = 1
          AND pg_catalog.bool_and(w.context = '{"earlier_open_count": 1}'::jsonb)
     FROM public.workflow_advisories AS w
    WHERE w.record_id = '69000000-0000-4000-8000-000000000021')
);
SELECT pg_temp.mint19_assert(
  'MINT-135 a ledger refusal leaves the step ticked and no advisory',
  (SELECT t.sop_content -> 1 ->> 'isCompleted' = 'true'
          AND t.sop_content -> 0 ->> 'isCompleted' = 'false'
     FROM public.tasks AS t
    WHERE t.id = '69000000-0000-4000-8000-000000000019')
  AND (SELECT pg_catalog.count(*) = 0 FROM public.workflow_advisories AS w
        WHERE w.record_id = '69000000-0000-4000-8000-000000000019')
  AND (SELECT pg_catalog.count(*) = 1 FROM public.audit_log AS a
        WHERE a.entity_id = '69000000-0000-4000-8000-000000000019')
);
DROP TRIGGER zz_mint135_ledger_failure ON public.workflow_advisories;

SET LOCAL request.jwt.claim.sub = '29000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.mint19_assert(
  'MINT-135 the earlier step still completes in order afterwards',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000017',
    'a',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'kind') = 'ok'
);
SELECT pg_temp.mint19_assert(
  'MINT-135 the last open step completes the task',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000017',
    'b',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'allDone')::boolean
);
RESET ROLE;
SELECT pg_temp.mint19_assert(
  'MINT-135 in-order ticks and repeats write no advisory',
  (SELECT pg_catalog.count(*) = 1 FROM public.workflow_advisories AS w
    WHERE w.record_id = '69000000-0000-4000-8000-000000000017')
  AND (SELECT pg_catalog.count(*) = 0 FROM public.workflow_advisories AS w
        WHERE w.org_id = '19000000-0000-4000-8000-000000000001'
          AND w.record_id NOT IN ('69000000-0000-4000-8000-000000000017',
                                  '69000000-0000-4000-8000-000000000021'))
);

-- MINT-135: a tick that completes a later task while an earlier task of its
-- case is open records task.completed_out_of_order; the earlier task stays
-- open. A removed payer form and a completed task don't count, and a task
-- that was already completed, or completes in order, records nothing.
SET LOCAL request.jwt.claim.sub = '29000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.mint19_assert(
  'MINT-135 a later task''s first step ticks in order',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000025',
    'a',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'kind') = 'ok'
);
SELECT pg_temp.mint19_assert(
  'MINT-135 a later task''s last step completes it while an earlier task is open',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000025',
    'b',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'allDone')::boolean
);
SELECT pg_temp.mint19_assert(
  'MINT-135 the last open step of an already completed task ticks',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000026',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'kind') = 'ok'
);
RESET ROLE;
SELECT pg_temp.mint19_assert(
  'MINT-135 the earlier task stays open',
  (SELECT t.status = 'in_progress' FROM public.tasks AS t
    WHERE t.id = '69000000-0000-4000-8000-000000000022')
);
SELECT pg_temp.mint19_assert(
  'MINT-135 completing the later task records task.completed_out_of_order once',
  (SELECT pg_catalog.count(*) = 1
          AND pg_catalog.bool_and(
                w.check_key = 'task.completed_out_of_order'
                AND w.record_table = 'tasks'
                AND w.source = 'panel'
                AND w.actor_id = '29000000-0000-4000-8000-000000000001'
                AND w.bypassed_at = pg_catalog.now())
     FROM public.workflow_advisories AS w
    WHERE w.record_id = '69000000-0000-4000-8000-000000000025')
);
SELECT pg_temp.mint19_assert(
  'MINT-135 the earlier open count skips a removed payer form and a completed task',
  (SELECT w.context = '{"earlier_open_count": 1}'::jsonb
     FROM public.workflow_advisories AS w
    WHERE w.record_id = '69000000-0000-4000-8000-000000000025')
);
SET LOCAL request.jwt.claim.sub = '29000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.mint19_assert(
  'MINT-135 the earlier task still completes afterwards',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000022',
    'only-step',
    '29000000-0000-4000-8000-000000000001',
    'panel'
  ) ->> 'allDone')::boolean
);
RESET ROLE;
SELECT pg_temp.mint19_assert(
  'MINT-135 an already completed task and an in-order completion record nothing',
  (SELECT pg_catalog.count(*) = 0 FROM public.workflow_advisories AS w
    WHERE w.record_id IN ('69000000-0000-4000-8000-000000000022',
                          '69000000-0000-4000-8000-000000000026'))
);

-- CI creates a minimally privileged service_role. Emulate the real Supabase
-- BYPASSRLS attribute only inside this rollback-only verification transaction.
ALTER ROLE service_role BYPASSRLS;
-- MINT-135: record_typed_enrollment_submission reads auth.uid() and locks
-- its portal row under service_role. Mirror those hosted grants (the mint58
-- packet's), rolled back with the transaction.
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT SELECT, UPDATE ON public.portals TO service_role;
SET LOCAL request.jwt.claim.sub = '29000000-0000-4000-8000-000000000002';
SET LOCAL ROLE service_role;
SELECT pg_temp.mint19_assert(
  'service role retry is idempotent and does not add audit',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000001',
    'first',
    '29000000-0000-4000-8000-000000000002',
    'extension'
  ) ->> 'kind') = 'ok'
  AND (SELECT count(*) = 1 FROM public.audit_log
        WHERE org_id = '19000000-0000-4000-8000-000000000001'
          AND entity_id = '69000000-0000-4000-8000-000000000001')
);
SELECT pg_temp.mint19_assert(
  'second step reports all done',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000001',
    'last',
    '29000000-0000-4000-8000-000000000002',
    'extension'
  ) ->> 'allDone')::boolean
);
SELECT pg_temp.mint19_assert(
  'final task is completed with a completion date',
  (SELECT t.status = 'completed' AND t.completed_date IS NOT NULL
     FROM public.tasks AS t
    WHERE t.id = '69000000-0000-4000-8000-000000000001')
);
SELECT pg_temp.mint19_assert(
  'termination date is set on the same-org case',
  (SELECT c.termination_date IS NOT NULL
     FROM public.credential_cases AS c
    WHERE c.id = '59000000-0000-4000-8000-000000000001'
      AND c.org_id = '19000000-0000-4000-8000-000000000001')
);
SELECT pg_temp.mint19_assert(
  'step attribution is the verified extension actor',
  (SELECT s.step ->> 'completedBy' = '29000000-0000-4000-8000-000000000002'
     FROM public.tasks AS t
     CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(t.sop_content) AS s(step)
    WHERE t.id = '69000000-0000-4000-8000-000000000001'
      AND s.step ->> 'id' = 'last')
);
SELECT pg_temp.mint19_assert(
  'two distinct steps produce two audit events',
  (SELECT count(*) = 2 FROM public.audit_log
    WHERE org_id = '19000000-0000-4000-8000-000000000001'
      AND entity_id = '69000000-0000-4000-8000-000000000001')
);
SELECT pg_temp.mint19_assert(
  'authenticated audit actor comes from auth.uid',
  (SELECT a.user_id = '29000000-0000-4000-8000-000000000001'
          AND a.after ->> 'source' = 'panel'
     FROM public.audit_log AS a
    WHERE a.entity_id = '69000000-0000-4000-8000-000000000001'
      AND a.after ->> 'stepId' = 'first')
);
SELECT pg_temp.mint19_assert(
  'service-role audit keeps its membership-verified actor',
  (SELECT a.user_id = '29000000-0000-4000-8000-000000000002'
          AND a.after ->> 'source' = 'extension'
     FROM public.audit_log AS a
    WHERE a.entity_id = '69000000-0000-4000-8000-000000000001'
      AND a.after ->> 'stepId' = 'last')
);
SELECT pg_temp.mint19_assert(
  'service role cannot impersonate a nonmember',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000001',
    'first',
    '29000000-0000-4000-8000-000000000004',
    'extension'
  ) ->> 'status')::integer = 404
);
SELECT pg_temp.mint19_assert(
  'MINT-135 the typed submission still refuses a step while an earlier step is open',
  (SELECT r ->> 'kind' = 'rejected'
          AND (r ->> 'status')::integer = 409
          AND r ->> 'message' = 'Enrollment SOP step is stale or already complete'
     FROM (SELECT pg_temp.mint135_typed_submission(
             'form-2', '89000000-0000-4000-8000-000000000003') AS r) AS x)
);
SELECT pg_temp.mint19_assert(
  'MINT-135 the earlier step ticks through the RPC',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000030',
    'form-1',
    '29000000-0000-4000-8000-000000000002',
    'extension'
  ) ->> 'kind') = 'ok'
);
-- The control: the same submission now passes the step check and stops at
-- the next one, so the refusal above was the earlier-step check.
SELECT pg_temp.mint19_assert(
  'MINT-135 with the earlier step done the submission gets past the step check',
  (pg_temp.mint135_typed_submission('form-2', '89000000-0000-4000-8000-000000000004')
     ->> 'message') = 'Enrollment portal configuration is stale'
);
SELECT pg_temp.mint19_assert(
  'MINT-135 an out-of-order extension tick completes',
  (public.complete_sop_task_step(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000018',
    'b',
    '29000000-0000-4000-8000-000000000002',
    'extension'
  ) ->> 'kind') = 'ok'
);
RESET ROLE;
ALTER ROLE service_role NOBYPASSRLS;
SELECT pg_temp.mint19_assert(
  'MINT-135 the extension advisory names the extension and the verified actor',
  (SELECT pg_catalog.count(*) = 1
          AND pg_catalog.bool_and(
                w.source = 'extension'
                AND w.actor_id = '29000000-0000-4000-8000-000000000002'
                AND w.actor_role = 'admin'
                AND w.context = '{"step_order": 2, "earlier_open_count": 1}'::jsonb)
     FROM public.workflow_advisories AS w
    WHERE w.record_id = '69000000-0000-4000-8000-000000000018')
);

-- Force the audit INSERT to fail after task/case changes have been attempted.
-- The RPC's transaction boundary must roll all of them back together.
-- MINT-135: the message carries how many advisories the task already had in
-- this transaction when the audit row failed, so a check can tell an
-- advisory that was written and rolled back from one never written. SECURITY
-- DEFINER, so the count reads the ledger whatever role the RPC runs as.
CREATE FUNCTION public.mint19_fail_test_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.entity_id IN ('69000000-0000-4000-8000-000000000003'::uuid,
                       '69000000-0000-4000-8000-000000000020'::uuid) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'mint19_atomic_audit_failure|advisories=' || (
        SELECT pg_catalog.count(*) FROM public.workflow_advisories AS w
         WHERE w.record_id = NEW.entity_id
      )::text;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER zz_mint19_atomic_audit_failure
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.mint19_fail_test_audit();

SET LOCAL request.jwt.claim.sub = '29000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.mint19_assert(
  'audit failure rolls back task, case, and audit',
  pg_temp.mint19_try_audit_failure(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000003',
    '29000000-0000-4000-8000-000000000001'
  ) = 'P0001|mint19_atomic_audit_failure|advisories=0'
  AND (SELECT t.status = 'not_started'
              AND (t.sop_content -> 0 ->> 'isCompleted') = 'false'
              AND c.termination_date IS NULL
              AND (SELECT count(*) = 0 FROM public.audit_log a WHERE a.entity_id = t.id)
       FROM public.tasks AS t
       JOIN public.credential_cases AS c ON c.id = t.case_id AND c.org_id = t.org_id
       WHERE t.id = '69000000-0000-4000-8000-000000000003')
);
SELECT pg_temp.mint19_assert(
  'MINT-135 an audit failure on an out-of-order tick, after its advisory was written, rolls back the step',
  pg_temp.mint19_try_audit_failure(
    '19000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000020',
    '29000000-0000-4000-8000-000000000001',
    'b'
  ) = 'P0001|mint19_atomic_audit_failure|advisories=1'
  AND (SELECT t.status = 'not_started'
              AND t.sop_content -> 1 ->> 'isCompleted' = 'false'
         FROM public.tasks AS t
        WHERE t.id = '69000000-0000-4000-8000-000000000020')
);
RESET ROLE;
-- The failing audit row saw the advisory (advisories=1 above), so the failed
-- audit insert is what rolled it back: one transaction for step, case,
-- advisory and audit.
SELECT pg_temp.mint19_assert(
  'MINT-135 an audit failure rolls the advisory back with the step',
  (SELECT pg_catalog.count(*) = 0 FROM public.workflow_advisories AS w
    WHERE w.record_id = '69000000-0000-4000-8000-000000000020')
);

DO $function$
DECLARE
  v_failures text;
BEGIN
  SELECT pg_catalog.string_agg(r.label, ', ' ORDER BY r.ordinal)
    INTO v_failures
    FROM pg_temp.mint19_results AS r
   WHERE NOT r.passed;
  IF v_failures IS NOT NULL THEN
    RAISE EXCEPTION 'MINT-19 SQL checks failed: %', v_failures;
  END IF;
  RAISE NOTICE 'MINT19|RESULT|PASS|checks=%', (SELECT count(*) FROM pg_temp.mint19_results);
END;
$function$;

SELECT 'MINT19|RESULT|PASS|checks=' || count(*)::text
  FROM pg_temp.mint19_results;

ROLLBACK;
