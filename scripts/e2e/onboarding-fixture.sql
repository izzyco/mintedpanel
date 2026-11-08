-- The sample practice for the onboarding runs on a LOCAL stack: the practice,
-- with the staff user as its admin; one active group with a TIN; one active
-- NC location; a payer with an NC network target for the group; and an
-- Enrollment SOP for that payer in NC, which generation needs before it
-- creates a case. Each row is found by its name or created, so a rerun reuses
-- what is there. e2e/onboarding-local-stack.spec.ts runs it under fresh names;
-- `scripts/e2e/onboarding-local-stack.sh --serve` under fixed ones.
--
-- Run it as postgres, after the staff user exists in auth.users. It prints one
-- JSON line: org_id, group_id, facility_id, payer_id.
--
--   psql "$DB_URL" -X -q -At -v ON_ERROR_STOP=1 \
--     -v practice=... -v staff_id=... -v staff_email=... -v group_name=... \
--     -v facility_name=... -v facility_city=... -v payer_name=... \
--     -f scripts/e2e/onboarding-fixture.sql

INSERT INTO public.profiles (id, full_name, first_name, last_name, email)
VALUES (:'staff_id', 'Sam Staff', 'Sam', 'Staff', :'staff_email')
ON CONFLICT (id) DO NOTHING;

SELECT coalesce((
  SELECT o.id::text
    FROM public.organizations o
    JOIN public.memberships m ON m.org_id = o.id
   WHERE o.name = :'practice' AND m.user_id = :'staff_id' AND m.role = 'admin'
   ORDER BY o.created_at
   LIMIT 1), '') AS org_id \gset
SELECT :'org_id' = '' AS need_org \gset

\if :need_org
-- create_organization makes the caller its admin and seeds the canonical
-- statuses, as the app's own path does. The rest is plain inserts as postgres.
BEGIN;
SELECT set_config('request.jwt.claims',
                  json_build_object('sub', :'staff_id', 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', :'staff_id', true) \g /dev/null
SELECT public.create_organization(:'practice') AS org_id \gset
COMMIT;
\endif

INSERT INTO public.provider_groups (org_id, name, tin, is_active)
SELECT :'org_id'::uuid, :'group_name', '56-1234567', true
 WHERE NOT EXISTS (SELECT 1 FROM public.provider_groups
                    WHERE org_id = :'org_id'::uuid AND name = :'group_name');

INSERT INTO public.facilities (org_id, group_id, name, city, state, is_active)
SELECT g.org_id, g.id, :'facility_name', :'facility_city', 'NC', true
  FROM public.provider_groups g
 WHERE g.org_id = :'org_id'::uuid AND g.name = :'group_name'
   AND NOT EXISTS (SELECT 1 FROM public.facilities
                    WHERE org_id = :'org_id'::uuid AND name = :'facility_name');

INSERT INTO public.payers (name, states, status)
SELECT :'payer_name', ARRAY['NC'], 'active'
 WHERE NOT EXISTS (SELECT 1 FROM public.payers WHERE org_id IS NULL AND name = :'payer_name');

INSERT INTO public.payer_network_targets (org_id, payer_id, group_id, state, status)
SELECT g.org_id, p.id, g.id, 'NC', 'active'
  FROM public.provider_groups g, public.payers p
 WHERE g.org_id = :'org_id'::uuid AND g.name = :'group_name'
   AND p.org_id IS NULL AND p.name = :'payer_name'
ON CONFLICT (group_id, payer_id, state) DO NOTHING;

INSERT INTO public.sop_templates (org_id, name, payer_id, state, states, case_type, task_definitions)
SELECT :'org_id'::uuid, :'payer_name' || ' enrollment', p.id, 'NC', ARRAY['NC'], 'enrollment',
       '[{"title": "Submit the enrollment application", "sortOrder": 0, "dueOffsetDays": 5,
          "steps": [{"label": "Call the payer to start the application", "stepType": "phone"}]}]'::jsonb
  FROM public.payers p
 WHERE p.org_id IS NULL AND p.name = :'payer_name'
   AND NOT EXISTS (SELECT 1 FROM public.sop_templates
                    WHERE org_id = :'org_id'::uuid AND name = :'payer_name' || ' enrollment');

SELECT json_build_object(
  'org_id', :'org_id',
  'group_id', (SELECT id FROM public.provider_groups
                WHERE org_id = :'org_id'::uuid AND name = :'group_name'),
  'facility_id', (SELECT id FROM public.facilities
                   WHERE org_id = :'org_id'::uuid AND name = :'facility_name'),
  'payer_id', (SELECT id FROM public.payers WHERE org_id IS NULL AND name = :'payer_name'));
