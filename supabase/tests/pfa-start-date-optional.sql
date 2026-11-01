-- MINT-96 (B9): a facility assignment saves without a start date once
-- 20261101140000 drops the E1.4 floor, so Add Provider's "no default" setting
-- saves an accurate draft instead of refusing. Run after all migrations in the
-- disposable PostgreSQL CI database (the Migration dry-run job). Synthetic
-- rows only; the transaction rolls back every fixture.
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
