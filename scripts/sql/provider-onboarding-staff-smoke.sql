-- Smoke test for 20261107010000_provider_onboarding_staff.sql. Run it after
-- the migration is applied, as the postgres user (the owner of the tables and
-- the SECURITY DEFINER functions: on a local `supabase start`, or the SQL
-- editor on staging), with both Vault secrets (ssn_vault_key and
-- portal_credentials_key) provisioned:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/provider-onboarding-staff-smoke.sql
--
-- Everything runs in one transaction and is rolled back. Hashes are plain
-- strings here: the RPCs only compare them. Any failed check raises and stops
-- the script.
BEGIN;

-- The error a statement raises as the current role, or 'ok'. Its subtransaction
-- rolls back whatever the statement wrote.
CREATE FUNCTION pg_temp.attempt(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END;
$$;

CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true),
          set_config('request.jwt.claim.role', CASE WHEN p_user IS NULL THEN '' ELSE 'authenticated' END, true),
          set_config('request.jwt.claims',
            CASE WHEN p_user IS NULL THEN ''
                 ELSE json_build_object('sub', p_user, 'role', 'authenticated')::text END, true);
END;
$$;

DO $$
DECLARE
  v_org uuid;
  v_other_org uuid;
  v_group uuid;
  v_group_2 uuid;
  v_other_group uuid;
  v_clt uuid;
  v_gso uuid;
  v_closed_site uuid;
  v_group_2_site uuid;
  v_other_site uuid;
  v_actor uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_specialist uuid := gen_random_uuid();
  v_billing uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_other_admin uuid := gen_random_uuid();
  v_provider uuid;
  v_journey uuid;
  v_provider_2 uuid;
  v_journey_2 uuid;
  r jsonb;
  v_text text;
  v_count int;
BEGIN
  INSERT INTO public.organizations (name) VALUES ('Smoke Staff') RETURNING id INTO v_org;
  INSERT INTO public.organizations (name) VALUES ('Smoke Staff Other') RETURNING id INTO v_other_org;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group') RETURNING id INTO v_group;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group Two') RETURNING id INTO v_group_2;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_other_org, 'Other Group') RETURNING id INTO v_other_group;
  INSERT INTO public.facilities (org_id, group_id, name, state) VALUES (v_org, v_group, 'Charlotte', 'NC')
    RETURNING id INTO v_clt;
  INSERT INTO public.facilities (org_id, group_id, name, state) VALUES (v_org, v_group, 'Greensboro', 'NC')
    RETURNING id INTO v_gso;
  INSERT INTO public.facilities (org_id, group_id, name, state, is_active) VALUES (v_org, v_group, 'Closed', 'NC', false)
    RETURNING id INTO v_closed_site;
  INSERT INTO public.facilities (org_id, group_id, name, state) VALUES (v_org, v_group_2, 'Group Two Site', 'NC')
    RETURNING id INTO v_group_2_site;
  INSERT INTO public.facilities (org_id, group_id, name, state) VALUES (v_other_org, v_other_group, 'Elsewhere', 'NC')
    RETURNING id INTO v_other_site;

  INSERT INTO auth.users (id, email) VALUES
    (v_admin, 'staff-smoke-admin@example.invalid'),
    (v_specialist, 'staff-smoke-specialist@example.invalid'),
    (v_billing, 'staff-smoke-billing@example.invalid'),
    (v_outsider, 'staff-smoke-outsider@example.invalid'),
    (v_other_admin, 'staff-smoke-other-admin@example.invalid');
  INSERT INTO public.profiles (id, full_name, email) VALUES
    (v_admin, 'Smoke Admin', 'staff-smoke-admin@example.invalid'),
    (v_specialist, 'Smoke Specialist', 'staff-smoke-specialist@example.invalid'),
    (v_billing, 'Smoke Billing', 'staff-smoke-billing@example.invalid'),
    (v_outsider, 'Smoke Outsider', 'staff-smoke-outsider@example.invalid'),
    (v_other_admin, 'Smoke Other Admin', 'staff-smoke-other-admin@example.invalid')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (org_id, user_id, role) VALUES
    (v_org, v_admin, 'admin'), (v_org, v_specialist, 'specialist'), (v_org, v_billing, 'billing'),
    (v_other_org, v_other_admin, 'admin');

  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Lena', 'last_name', 'Ortiz', 'email', 'lena.staff@example.test', 'group_id', v_group),
    'staff-link-a', now() + interval '30 days');
  v_provider := (r->>'provider_id')::uuid;
  v_journey := (r->>'onboarding_id')::uuid;
  UPDATE public.providers SET start_date = '2026-11-10', npi = '1234567893' WHERE id = v_provider;

  -- first_signed_in_at: unset until she signs in, set by the first sign-in,
  -- never moved by a later one.
  ASSERT (SELECT first_signed_in_at IS NULL FROM public.provider_onboardings WHERE id = v_journey), 'unset before sign-in';
  ASSERT (public.issue_intake_code('staff-link-a', 'staff-code-1')->>'send')::boolean, 'code 1';
  ASSERT public.verify_intake_code('staff-link-a', 'staff-code-1', 'staff-sess-1', now() + interval '2 hours') = 'ok', 'sign-in 1';
  ASSERT (SELECT first_signed_in_at = now() FROM public.provider_onboardings WHERE id = v_journey), 'set by the first sign-in';
  UPDATE public.provider_onboardings SET first_signed_in_at = '2026-10-15 18:52:00+00' WHERE id = v_journey;
  ASSERT (public.issue_intake_code('staff-link-a', 'staff-code-2')->>'send')::boolean, 'code 2';
  ASSERT public.verify_intake_code('staff-link-a', 'staff-code-2', 'staff-sess-2', now() + interval '2 hours') = 'ok', 'sign-in 2';
  ASSERT (SELECT first_signed_in_at = '2026-10-15 18:52:00+00' FROM public.provider_onboardings WHERE id = v_journey),
    'a later sign-in leaves it';
  ASSERT public.verify_intake_code('staff-link-a', 'wrong-code', 'staff-sess-x', now() + interval '2 hours') = 'invalid',
    'a wrong code still fails';

  -- Secrets and uploads for the read: the RPC must answer them as booleans
  -- and counts only.
  ASSERT public.store_intake_ssn('staff-sess-2', 'staff-link-a', '123456789')->>'result' = 'stored', 'ssn stored';
  ASSERT public.store_intake_portal_login('staff-sess-2', 'staff-link-a', 'caqh', 'lena.caqh', 'Secret-Pass-9')->>'result' = 'stored',
    'login stored';
  INSERT INTO public.provider_intake_uploads
    (id, org_id, onboarding_id, slot_key, doc_type, file_name, size_bytes, content_type, object_path, finalized_at, removed_at)
  SELECT u.id, v_org, v_journey, u.slot, u.slot, 'file.pdf', 10, 'application/pdf',
         format('org/%s/onboarding/%s/%s/file.pdf', v_org, v_journey, u.id), now(), u.removed
    FROM (VALUES (gen_random_uuid(), 'cv', NULL::timestamptz),
                 (gen_random_uuid(), 'diploma', now()),
                 (gen_random_uuid(), 'other', NULL::timestamptz)) AS u (id, slot, removed);
  UPDATE public.provider_intake_uploads SET finalized_at = NULL WHERE onboarding_id = v_journey AND slot_key = 'other';

  -- Nobody without a writer role gets through, NULL-safe.
  PERFORM pg_temp.act_as(NULL);
  SET LOCAL ROLE authenticated;
  ASSERT pg_temp.attempt(format('SELECT public.record_onboarding_check(%L, %L, %L, NULL)', v_journey, 'caqh_login', 'confirmed'))
    = 'not_authenticated', 'no user';
  ASSERT pg_temp.attempt(format('SELECT public.read_provider_onboarding(%L)', v_provider)) = 'not_authenticated', 'no user reads';
  RESET ROLE;

  PERFORM pg_temp.act_as(v_outsider);
  SET LOCAL ROLE authenticated;
  ASSERT pg_temp.attempt(format('SELECT public.record_onboarding_check(%L, %L, %L, NULL)', v_journey, 'caqh_login', 'confirmed'))
    = 'onboarding_not_found', 'a signed-in non-member (NULL role) is refused';
  ASSERT pg_temp.attempt(format('SELECT public.mark_onboarding_contacted(%L)', v_journey)) = 'onboarding_not_found', 'non-member contacted';
  ASSERT pg_temp.attempt(format('SELECT public.admit_provider_onboarding(%L, %L)', v_journey, v_clt)) = 'onboarding_not_found', 'non-member admit';
  ASSERT public.read_provider_onboarding(v_provider) IS NULL, 'a non-member reads nothing';
  RESET ROLE;

  PERFORM pg_temp.act_as(v_other_admin);
  SET LOCAL ROLE authenticated;
  ASSERT pg_temp.attempt(format('SELECT public.record_onboarding_check(%L, %L, %L, NULL)', v_journey, 'caqh_login', 'confirmed'))
    = 'onboarding_not_found', 'another org''s admin is refused';
  ASSERT public.read_provider_onboarding(v_provider) IS NULL, 'another org''s admin reads nothing';
  RESET ROLE;

  PERFORM pg_temp.act_as(v_billing);
  SET LOCAL ROLE authenticated;
  ASSERT pg_temp.attempt(format('SELECT public.record_onboarding_check(%L, %L, %L, NULL)', v_journey, 'caqh_login', 'confirmed'))
    = 'onboarding_writer_required', 'billing records no check';
  ASSERT pg_temp.attempt(format('SELECT public.mark_onboarding_contacted(%L)', v_journey)) = 'onboarding_writer_required', 'billing contacted';
  ASSERT pg_temp.attempt(format('SELECT public.admit_provider_onboarding(%L, %L)', v_journey, v_clt)) = 'onboarding_writer_required', 'billing admit';
  RESET ROLE;

  -- Checks: a specialist and an admin append; the latest row per key wins.
  PERFORM pg_temp.act_as(v_specialist);
  SET LOCAL ROLE authenticated;
  r := public.record_onboarding_check(v_journey, 'caqh_login', 'problem', '  Password rejected  ');
  ASSERT r->>'outcome' = 'problem' AND r->>'note' = 'Password rejected' AND r->>'checked_by_name' = 'Smoke Specialist',
    format('specialist check: %s', r);
  ASSERT pg_temp.attempt(format('SELECT public.record_onboarding_check(%L, %L, %L, NULL)', v_journey, 'npi', 'confirmed'))
    LIKE '%provider_onboarding_checks_check_key_check%', 'a key outside the person checks is refused';
  ASSERT pg_temp.attempt(format('SELECT public.record_onboarding_check(%L, %L, %L, NULL)', v_journey, 'caqh_login', 'maybe'))
    LIKE '%provider_onboarding_checks_outcome_check%', 'an unknown outcome is refused';
  ASSERT pg_temp.attempt(format('SELECT public.record_onboarding_check(%L, %L, %L, %L)', v_journey, 'caqh_login', 'problem', repeat('x', 501)))
    LIKE '%provider_onboarding_checks_note_check%', 'a note over 500 characters is refused';
  r := public.mark_onboarding_contacted(v_journey);
  ASSERT r ? 'last_contacted_at', format('contacted: %s', r);
  RESET ROLE;
  ASSERT (SELECT last_contacted_at IS NOT NULL FROM public.provider_onboardings WHERE id = v_journey), 'last_contacted_at set';

  PERFORM pg_temp.act_as(v_admin);
  SET LOCAL ROLE authenticated;
  r := public.record_onboarding_check(v_journey, 'caqh_login', 'confirmed', '   ');
  ASSERT r->>'outcome' = 'confirmed' AND r->'note' = 'null'::jsonb, format('blank note is null: %s', r);
  PERFORM public.record_onboarding_check(v_journey, 'caqh_attestation', 'confirmed', NULL);
  RESET ROLE;
  ASSERT (SELECT count(*) FROM public.provider_onboarding_checks WHERE onboarding_id = v_journey) = 3, 'checks append';
  ASSERT (SELECT count(*) FROM public.audit_log
           WHERE org_id = v_org AND entity_type = 'provider_onboarding' AND entity_id = v_journey
             AND description = 'Recorded an onboarding check' AND after ? 'check_key' AND NOT after ? 'note') = 3,
    'one audit row per check, never the note';
  ASSERT (SELECT count(*) FROM public.audit_log
           WHERE entity_id = v_journey AND description = 'Marked the provider contacted' AND user_id = v_specialist) = 1,
    'one contacted audit row';

  -- The read: any member, the latest check per key, no secret. A provider
  -- that is gone (Cancel deleted it) reads nothing, never an error.
  PERFORM pg_temp.act_as(v_billing);
  SET LOCAL ROLE authenticated;
  r := public.read_provider_onboarding(v_provider);
  ASSERT public.read_provider_onboarding(gen_random_uuid()) IS NULL, 'a missing provider reads nothing';
  RESET ROLE;
  ASSERT (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r) k)
       = ARRAY['checks', 'has_case', 'held_uploads', 'invite', 'journey', 'logins_on_file', 'npi_in_use', 'ssn_on_file'],
    format('read keys: %s', r);
  ASSERT jsonb_array_length(r->'checks') = 2, format('one row per key: %s', r->'checks');
  ASSERT (SELECT c->>'outcome' = 'confirmed' AND c->>'checked_by_name' = 'Smoke Admin' AND c->'note' = 'null'::jsonb
            FROM jsonb_array_elements(r->'checks') c WHERE c->>'check_key' = 'caqh_login'), 'latest caqh_login wins';
  ASSERT r->'logins_on_file' = '{"caqh": true, "pecos": false}'::jsonb AND r->'ssn_on_file' = 'true'::jsonb,
    format('secrets as booleans: %s', r);
  ASSERT (r->>'held_uploads')::int = 1, format('finished, kept uploads only: %s', r->'held_uploads');
  ASSERT r->'has_case' = 'false'::jsonb AND r->'npi_in_use' = 'false'::jsonb, 'no case, npi unique';
  ASSERT r->'invite'->>'email' = 'lena.staff@example.test' AND (r->'invite'->>'sends')::int = 1, format('invite: %s', r->'invite');
  ASSERT r->'journey'->>'first_signed_in_at' IS NOT NULL AND r->'journey'->'submitted_at' = 'null'::jsonb,
    format('journey: %s', r->'journey');
  ASSERT position('6789' IN r::text) = 0 AND position('123456789' IN r::text) = 0
     AND position('Secret-Pass-9' IN r::text) = 0 AND position('lena.caqh' IN r::text) = 0
     AND position('token' IN r::text) = 0 AND position('hash' IN r::text) = 0,
    'the read carries no SSN, password, username or token';

  -- Admit: only after Submit, only at an active location of her own group.
  PERFORM pg_temp.act_as(v_specialist);
  SET LOCAL ROLE authenticated;
  ASSERT pg_temp.attempt(format('SELECT public.admit_provider_onboarding(%L, %L)', v_journey, v_clt)) = 'onboarding_not_submitted',
    'admit before Submit is refused';
  RESET ROLE;
  PERFORM pg_temp.act_as(NULL);
  UPDATE public.provider_onboardings SET submitted_at = now() WHERE id = v_journey;

  PERFORM pg_temp.act_as(v_specialist);
  SET LOCAL ROLE authenticated;
  ASSERT pg_temp.attempt(format('SELECT public.admit_provider_onboarding(%L, %L)', v_journey, v_group_2_site))
    = 'onboarding_location_ineligible', 'another group''s location is refused';
  ASSERT pg_temp.attempt(format('SELECT public.admit_provider_onboarding(%L, %L)', v_journey, v_closed_site))
    = 'onboarding_location_ineligible', 'an inactive location is refused';
  ASSERT pg_temp.attempt(format('SELECT public.admit_provider_onboarding(%L, %L)', v_journey, v_other_site))
    = 'onboarding_location_ineligible', 'another org''s location is refused';
  ASSERT pg_temp.attempt(format('SELECT public.admit_provider_onboarding(%L, %L)', v_journey, gen_random_uuid()))
    = 'onboarding_location_ineligible', 'a missing location is refused';
  r := public.admit_provider_onboarding(v_journey, v_clt);
  ASSERT r->'assignment_created' = 'true'::jsonb AND r->'made_primary' = 'true'::jsonb, format('admit: %s', r);
  ASSERT pg_temp.attempt(format('SELECT public.admit_provider_onboarding(%L, %L)', v_journey, v_clt)) = 'onboarding_closed',
    'admit twice is refused';
  ASSERT pg_temp.attempt(format('SELECT public.record_onboarding_check(%L, %L, %L, NULL)', v_journey, 'pecos_login', 'confirmed'))
    = 'onboarding_closed', 'no check after Admit';
  ASSERT pg_temp.attempt(format('SELECT public.mark_onboarding_contacted(%L)', v_journey)) = 'onboarding_closed', 'no contact after Admit';
  RESET ROLE;

  ASSERT (SELECT is_primary AND start_date = '2026-11-10' FROM public.provider_facility_assignments
           WHERE provider_id = v_provider AND facility_id = v_clt AND org_id = v_org),
    'her assignment: primary, dated her start date';
  ASSERT (SELECT admitted_at IS NOT NULL AND admitted_by = v_specialist AND admitted_facility_id = v_clt
            FROM public.provider_onboardings WHERE id = v_journey), 'admitted_*';
  ASSERT (SELECT status FROM public.providers WHERE id = v_provider) = 'onboarding', 'providers.status untouched (D1, D2)';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_invites WHERE onboarding_id = v_journey AND revoked_at IS NULL),
    'her invites are revoked';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_sessions s JOIN public.provider_intake_invites i ON i.id = s.invite_id
                      WHERE i.onboarding_id = v_journey AND s.revoked_at IS NULL), 'her sessions are revoked';
  ASSERT public.read_intake_state('staff-sess-2', 'staff-link-a') IS NULL, 'her session reads nothing after Admit';
  ASSERT (SELECT count(*) FROM public.audit_log
           WHERE entity_id = v_journey AND description = 'Admitted the provider and assigned a location'
             AND after->>'admitted_facility_id' = v_clt::text AND user_id = v_specialist) = 1, 'one admit audit row';

  PERFORM pg_temp.act_as(v_admin);
  SET LOCAL ROLE authenticated;
  r := public.read_provider_onboarding(v_provider);
  RESET ROLE;
  ASSERT r->'journey'->>'admitted_by_name' = 'Smoke Specialist' AND r->'journey'->>'admitted_facility_id' = v_clt::text,
    format('read after admit: %s', r->'journey');

  -- A provider who already has a primary location keeps it; one already at
  -- the picked location gets no second row.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Owen', 'last_name', 'Park', 'email', 'owen.staff@example.test', 'group_id', v_group),
    'staff-link-b', now() + interval '30 days');
  v_provider_2 := (r->>'provider_id')::uuid;
  v_journey_2 := (r->>'onboarding_id')::uuid;
  INSERT INTO public.provider_facility_assignments (org_id, provider_id, facility_id, is_primary)
    VALUES (v_org, v_provider_2, v_gso, true), (v_org, v_provider_2, v_clt, false);
  UPDATE public.provider_onboardings SET submitted_at = now() WHERE id = v_journey_2;
  PERFORM pg_temp.act_as(v_admin);
  SET LOCAL ROLE authenticated;
  r := public.admit_provider_onboarding(v_journey_2, v_clt);
  RESET ROLE;
  ASSERT r->'assignment_created' = 'false'::jsonb AND r->'made_primary' = 'false'::jsonb, format('admit 2: %s', r);
  ASSERT (SELECT count(*) FROM public.provider_facility_assignments WHERE provider_id = v_provider_2) = 2, 'no second row';
  ASSERT (SELECT facility_id FROM public.provider_facility_assignments WHERE provider_id = v_provider_2 AND is_primary) = v_gso,
    'her primary stays';

  -- RLS: members of her org read the journey and its checks; another org's
  -- member reads neither; nobody writes either table directly.
  PERFORM pg_temp.act_as(v_billing);
  SET LOCAL ROLE authenticated;
  ASSERT (SELECT count(*) FROM public.provider_onboardings WHERE id = v_journey) = 1, 'her org reads the journey';
  ASSERT (SELECT count(*) FROM public.provider_onboarding_checks WHERE onboarding_id = v_journey) = 3, 'her org reads the checks';
  RESET ROLE;
  PERFORM pg_temp.act_as(v_other_admin);
  SET LOCAL ROLE authenticated;
  ASSERT (SELECT count(*) FROM public.provider_onboardings WHERE org_id = v_org) = 0, 'other org reads no journey';
  ASSERT (SELECT count(*) FROM public.provider_onboarding_checks WHERE org_id = v_org) = 0, 'other org reads no check';
  RESET ROLE;
  PERFORM pg_temp.act_as(v_admin);
  SET LOCAL ROLE authenticated;
  ASSERT pg_temp.attempt(format(
    'INSERT INTO public.provider_onboarding_checks (org_id, onboarding_id, check_key, outcome, checked_by) VALUES (%L, %L, %L, %L, %L)',
    v_org, v_journey_2, 'caqh_login', 'confirmed', v_admin)) LIKE 'permission denied%', 'no direct check insert';
  ASSERT pg_temp.attempt(format('UPDATE public.provider_onboarding_checks SET outcome = %L WHERE org_id = %L', 'problem', v_org))
    LIKE 'permission denied%', 'no direct check update';
  ASSERT pg_temp.attempt(format('DELETE FROM public.provider_onboarding_checks WHERE org_id = %L', v_org))
    LIKE 'permission denied%', 'no direct check delete';
  ASSERT pg_temp.attempt(format('UPDATE public.provider_onboardings SET last_contacted_at = now() WHERE id = %L', v_journey_2))
    LIKE 'permission denied%', 'no direct journey update';
  RESET ROLE;
  PERFORM pg_temp.act_as(NULL);

  -- Grants and the offboarded freeze.
  ASSERT has_function_privilege('authenticated', 'public.record_onboarding_check(uuid, text, text, text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.mark_onboarding_contacted(uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.admit_provider_onboarding(uuid, uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.read_provider_onboarding(uuid)', 'EXECUTE'), 'staff RPCs for signed-in users';
  ASSERT NOT has_function_privilege('anon', 'public.record_onboarding_check(uuid, text, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.mark_onboarding_contacted(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.admit_provider_onboarding(uuid, uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.read_provider_onboarding(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('service_role', 'public.admit_provider_onboarding(uuid, uuid)', 'EXECUTE'), 'not for anon or service_role';
  ASSERT NOT has_function_privilege('authenticated', 'public._onboarding_for_writer(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public._onboarding_for_writer(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('service_role', 'public._onboarding_for_writer(uuid)', 'EXECUTE'), 'the helper is private';
  ASSERT NOT has_table_privilege('anon', 'public.provider_onboarding_checks', 'SELECT')
     AND NOT has_table_privilege('service_role', 'public.provider_onboarding_checks', 'INSERT'), 'table grants';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'block_writes_when_offboarded'
                    AND tgrelid = 'public.provider_onboarding_checks'::regclass), 'offboarded freeze';

  -- An offboarded org's links are paused (intake_link_paused, which the
  -- intake routes ask first), so no code goes out for a sign-in the write
  -- freeze would refuse.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Olga', 'last_name', 'Off', 'email', 'olga.off@example.test', 'group_id', v_group),
    'staff-link-off', now() + interval '30 days');
  ASSERT NOT public.intake_link_paused('staff-link-off'), 'a writable org''s link is not paused';
  ASSERT (public.issue_intake_code('staff-link-off', 'staff-code-off')->>'send')::boolean, 'code while writable';
  UPDATE public.organizations SET lifecycle_state = 'offboarded' WHERE id = v_org;
  ASSERT public.intake_link_paused('staff-link-off'), 'an offboarded org''s link is paused';
  ASSERT NOT public.intake_link_paused('staff-link-unknown'), 'an unknown link reads the off switch alone';
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.verify_intake_code('staff-link-off', 'staff-code-off', 'staff-sess-off',
                                      now() + interval '2 hours');
    v_text := 'signed in';
  EXCEPTION WHEN insufficient_privilege THEN
    v_text := SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  ASSERT v_text = 'org_offboarded', format('the sign-in the pause stands in for is refused: %s', v_text);
  UPDATE public.organizations SET lifecycle_state = 'active' WHERE id = v_org;
  ASSERT NOT public.intake_link_paused('staff-link-off'), 'reopened, the link works again';
  UPDATE public.provider_intake_settings SET paused = true;
  ASSERT public.intake_link_paused('staff-link-off') AND public.intake_link_paused('staff-link-unknown'),
    'the off switch pauses every link';
  UPDATE public.provider_intake_settings SET paused = false;
  ASSERT has_function_privilege('service_role', 'public.intake_link_paused(text)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.intake_link_paused(text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.intake_link_paused(text)', 'EXECUTE'),
    'intake_link_paused is service_role only';

  -- A journey that goes away (Cancel deleting her record) takes its checks.
  DELETE FROM public.provider_intake_invites WHERE onboarding_id = v_journey;
  DELETE FROM public.provider_onboardings WHERE id = v_journey;
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_onboarding_checks WHERE onboarding_id = v_journey), 'checks cascade';

  RAISE NOTICE 'provider onboarding staff smoke: all checks passed';
END;
$$;

ROLLBACK;
