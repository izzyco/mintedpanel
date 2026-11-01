-- MINT-96 (B9): a facility assignment saves without a start date once
-- 20261101140000 drops the E1.4 floor, so Add Provider's "no default" setting
-- saves an accurate draft instead of refusing. (B10) commit_import_run dates a
-- blank assignment with the plan's assignment_start_date (20261101140100).
-- Run after all migrations in the disposable PostgreSQL CI database (the
-- Migration dry-run job). Synthetic rows only; the transaction rolls back
-- every fixture.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;
SET LOCAL client_min_messages = warning;
-- Hosted Supabase lets authenticated reach auth.uid(); the bare CI Postgres
-- does not until this grant (rolled back with everything else).
GRANT USAGE ON SCHEMA auth TO authenticated;
\o /dev/null

CREATE TEMP TABLE pfa_results (name text PRIMARY KEY, passed boolean NOT NULL);

INSERT INTO auth.users(id, email)
VALUES ('3d000000-0000-4000-a000-000000000001', 'pfa-admin@example.invalid');
INSERT INTO public.profiles(id, full_name, email)
VALUES ('3d000000-0000-4000-a000-000000000001', 'PFA Synthetic Admin', 'pfa-admin@example.invalid');
INSERT INTO public.organizations(id, name)
VALUES ('1d000000-0000-4000-a000-000000000001', 'PFA Synthetic Org');
INSERT INTO public.memberships(org_id, user_id, role)
VALUES ('1d000000-0000-4000-a000-000000000001', '3d000000-0000-4000-a000-000000000001', 'admin');
INSERT INTO public.provider_groups(id, org_id, name)
VALUES (
  '4d000000-0000-4000-a000-000000000001',
  '1d000000-0000-4000-a000-000000000001',
  'PFA Synthetic Group'
);
INSERT INTO public.facilities(id, org_id, group_id, name, state) VALUES
  ('7d000000-0000-4000-a000-000000000001', '1d000000-0000-4000-a000-000000000001',
   '4d000000-0000-4000-a000-000000000001', 'PFA Synthetic Clinic One', 'NC'),
  ('7d000000-0000-4000-a000-000000000002', '1d000000-0000-4000-a000-000000000001',
   '4d000000-0000-4000-a000-000000000001', 'PFA Synthetic Clinic Two', 'NC');
INSERT INTO public.providers(id, org_id, group_id, first_name, last_name, status)
VALUES (
  '5d000000-0000-4000-a000-000000000001',
  '1d000000-0000-4000-a000-000000000001',
  '4d000000-0000-4000-a000-000000000001',
  'Synthetic', 'Provider', 'onboarding'
);
-- Three ready import runs, one staged line each: the plan says no default
-- (null), names the coordinator's local day, or predates the key.
INSERT INTO public.import_runs(id, org_id, created_by, source, state)
SELECT r.id::uuid, '1d000000-0000-4000-a000-000000000001',
       '3d000000-0000-4000-a000-000000000001', 'internal', 'ready_for_review'
FROM (VALUES
  ('8d000000-0000-4000-a000-000000000001'),
  ('8d000000-0000-4000-a000-000000000002'),
  ('8d000000-0000-4000-a000-000000000003')
) AS r(id);
INSERT INTO public.import_rows(org_id, run_id, line, raw, row_state)
SELECT '1d000000-0000-4000-a000-000000000001', r.id, 2, '{}'::jsonb, 'staged'
FROM public.import_runs r
WHERE r.org_id = '1d000000-0000-4000-a000-000000000001';
CREATE FUNCTION pg_temp.pfa_plan(p_extra jsonb) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'creates', jsonb_build_array(jsonb_build_object(
      'line', 2,
      'provider', jsonb_build_object('first_name', 'Imported', 'last_name', 'Provider'),
      'group_ids', '[]'::jsonb,
      'facility_ids', jsonb_build_array('7d000000-0000-4000-a000-000000000001'),
      'licenses', '[]'::jsonb
    )),
    'updates', '[]'::jsonb,
    'skipped_count', 0,
    'blocked_entries', '[]'::jsonb
  ) || p_extra
$$;
GRANT EXECUTE ON FUNCTION pg_temp.pfa_plan(jsonb) TO authenticated;
CREATE FUNCTION pg_temp.pfa_import_start(p_run uuid) RETURNS date
LANGUAGE sql AS $$
  SELECT a.start_date FROM public.provider_facility_assignments a
  JOIN public.import_runs r ON a.provider_id = ANY (r.created_provider_ids)
  WHERE r.id = p_run
$$;

-- The browser's writes, as an org admin through RLS: Add Provider inserts
-- the assignments with no start date, then the primary is promoted (an
-- UPDATE of an undated row, as set_primary_assignment does).
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '3d000000-0000-4000-a000-000000000001', true);
INSERT INTO public.provider_facility_assignments(org_id, provider_id, facility_id, is_primary, start_date)
VALUES
  ('1d000000-0000-4000-a000-000000000001', '5d000000-0000-4000-a000-000000000001',
   '7d000000-0000-4000-a000-000000000001', false, NULL),
  ('1d000000-0000-4000-a000-000000000001', '5d000000-0000-4000-a000-000000000001',
   '7d000000-0000-4000-a000-000000000002', false, NULL);
UPDATE public.provider_facility_assignments
SET is_primary = true
WHERE provider_id = '5d000000-0000-4000-a000-000000000001'
  AND facility_id = '7d000000-0000-4000-a000-000000000001';
SELECT public.commit_import_run(
  '8d000000-0000-4000-a000-000000000001',
  pg_temp.pfa_plan('{"assignment_start_date": null}'::jsonb)
);
SELECT public.commit_import_run(
  '8d000000-0000-4000-a000-000000000002',
  pg_temp.pfa_plan('{"assignment_start_date": "2026-11-01"}'::jsonb)
);
SELECT public.commit_import_run(
  '8d000000-0000-4000-a000-000000000003',
  pg_temp.pfa_plan('{}'::jsonb)
);
RESET ROLE;

INSERT INTO pg_temp.pfa_results VALUES
  (
    'start_date_check_dropped',
    NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'provider_facility_assignments_start_date_check'
    )
  ),
  (
    'undated_assignments_saved',
    (SELECT count(*) = 2 FROM public.provider_facility_assignments
     WHERE provider_id = '5d000000-0000-4000-a000-000000000001' AND start_date IS NULL)
  ),
  (
    'undated_assignment_promoted_primary',
    EXISTS (
      SELECT 1 FROM public.provider_facility_assignments
      WHERE provider_id = '5d000000-0000-4000-a000-000000000001'
        AND facility_id = '7d000000-0000-4000-a000-000000000001'
        AND is_primary AND start_date IS NULL
    )
  ),
  (
    'import_no_default_saves_undated',
    (SELECT count(*) = 1 FROM public.provider_facility_assignments a
     JOIN public.import_runs r ON a.provider_id = ANY (r.created_provider_ids)
     WHERE r.id = '8d000000-0000-4000-a000-000000000001' AND a.start_date IS NULL)
  ),
  (
    'import_takes_plan_local_day',
    pg_temp.pfa_import_start('8d000000-0000-4000-a000-000000000002') = DATE '2026-11-01'
  ),
  (
    'import_plan_without_key_keeps_today',
    pg_temp.pfa_import_start('8d000000-0000-4000-a000-000000000003') = CURRENT_DATE
  );

\o
SELECT name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END
FROM pg_temp.pfa_results ORDER BY name;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.pfa_results WHERE NOT passed) THEN
    RAISE EXCEPTION 'facility assignment start date optional regression failed';
  END IF;
END;
$$;

ROLLBACK;
