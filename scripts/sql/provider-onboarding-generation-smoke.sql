-- Smoke test for 20261107020000_cases_wait_for_onboarding_admit.sql. Run it
-- after the migration is applied, as the postgres user (on a local
-- `supabase start`, or the SQL editor on staging):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/provider-onboarding-generation-smoke.sql
--
-- Everything runs in one transaction and is rolled back. Any failed check
-- raises and stops the script.
BEGIN;

-- The error a statement raises as the current role and claims, or 'ok'. Its
-- subtransaction rolls back whatever the statement wrote.
CREATE FUNCTION pg_temp.attempt(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
  v_message text;
  v_detail text;
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
  RETURN v_state || ' ' || v_message || ' | ' || coalesce(v_detail, '');
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

CREATE FUNCTION pg_temp.insert_case(p_org uuid, p_provider uuid, p_group uuid, p_payer uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.attempt(format(
    'INSERT INTO public.credential_cases (org_id, provider_id, group_id, payer_id, state) VALUES (%L, %L, %L, %L, %L)',
    p_org, p_provider, p_group, p_payer, 'NC'));
$$;

DO $$
DECLARE
  v_held_error constant text := 'P0001 onboarding_not_admitted | This provider''s onboarding isn''t finished. Admit & assign on the provider''s page before creating a case.';
  v_org uuid;
  v_group uuid;
  v_group_b uuid;
  v_payer uuid;
  v_actor uuid := gen_random_uuid();
  v_staff uuid := gen_random_uuid();
  r jsonb;
  v_new uuid;
  v_new_journey uuid;
  v_gap uuid;
  v_gap_journey uuid;
  v_joined uuid;
  v_result text;
BEGIN
  INSERT INTO public.organizations (name) VALUES ('Smoke Generation Hold') RETURNING id INTO v_org;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group') RETURNING id INTO v_group;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group B') RETURNING id INTO v_group_b;
  INSERT INTO public.payers (name) VALUES ('Smoke Hold Payer') RETURNING id INTO v_payer;
  INSERT INTO public.status_configs (org_id, track, label, color, sort_order)
    VALUES (v_org, 'credentialing', 'Not Started', '#6B7280', 1);
  INSERT INTO auth.users (id, email) VALUES (v_staff, 'hold-smoke-staff@example.invalid');
  INSERT INTO public.profiles (id, full_name, email)
    VALUES (v_staff, 'Smoke Staff', 'hold-smoke-staff@example.invalid')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (org_id, user_id, role) VALUES (v_org, v_staff, 'admin');

  -- A new hire the invite created: held until Admit.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Nia', 'last_name', 'New', 'email', 'nia.new@example.test', 'group_id', v_group),
    'gh-link-n', now() + interval '30 days');
  v_new := (r->>'provider_id')::uuid;
  v_new_journey := (r->>'onboarding_id')::uuid;
  ASSERT (SELECT created_record FROM public.provider_onboardings WHERE id = v_new_journey), 'the invite created her';

  PERFORM pg_temp.act_as(v_staff);
  v_result := pg_temp.insert_case(v_org, v_new, v_group, v_payer);
  ASSERT v_result = v_held_error, format('held insert: %s', v_result);

  -- The browser's path, create_case_with_tasks as a signed-in admin, gets the same refusal.
  SET LOCAL ROLE authenticated;
  v_result := pg_temp.attempt(format('SELECT public.create_case_with_tasks(%L::jsonb, %L::jsonb)',
    jsonb_build_object('org_id', v_org, 'provider_id', v_new, 'group_id', v_group,
                       'payer_id', v_payer, 'state', 'NC', 'case_type', 'enrollment'),
    '[]'));
  RESET ROLE;
  ASSERT v_result = v_held_error, format('held RPC: %s', v_result);
  PERFORM pg_temp.act_as(NULL);
  ASSERT NOT EXISTS (SELECT 1 FROM public.credential_cases WHERE provider_id = v_new), 'no case for her';

  -- Operator SQL and seeds carry no JWT claims, so they are not held.
  v_result := pg_temp.insert_case(v_org, v_new, v_group, v_payer);
  ASSERT v_result = 'ok', format('no claims: %s', v_result);

  -- After Admit her cases go ahead.
  UPDATE public.provider_onboardings SET submitted_at = now(), admitted_at = now(), admitted_by = v_staff
   WHERE id = v_new_journey;
  PERFORM pg_temp.act_as(v_staff);
  v_result := pg_temp.insert_case(v_org, v_new, v_group_b, v_payer);
  ASSERT v_result = 'ok', format('after admit: %s', v_result);
  PERFORM pg_temp.act_as(NULL);

  -- A gap-fill invite to a provider already on file never pauses her cases.
  INSERT INTO public.providers (org_id, first_name, last_name, email, status, group_id)
    VALUES (v_org, 'Gail', 'Gap', 'gail.gap@example.test', 'active', v_group) RETURNING id INTO v_gap;
  INSERT INTO public.provider_group_assignments (org_id, provider_id, group_id, is_primary)
    VALUES (v_org, v_gap, v_group, true);
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_gap, 'gh-link-g', now() + interval '30 days');
  v_gap_journey := (r->>'onboarding_id')::uuid;
  ASSERT (SELECT NOT created_record AND admitted_at IS NULL AND cancelled_at IS NULL
            FROM public.provider_onboardings WHERE id = v_gap_journey), 'gap-fill journey is open';
  PERFORM pg_temp.act_as(v_staff);
  v_result := pg_temp.insert_case(v_org, v_gap, v_group, v_payer);
  ASSERT v_result = 'ok', format('gap-fill: %s', v_result);
  PERFORM pg_temp.act_as(NULL);

  -- Cancel a gap-fill journey: still no hold.
  ASSERT public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_gap)->>'result' = 'closed', 'gap-fill closed';
  PERFORM pg_temp.act_as(v_staff);
  v_result := pg_temp.insert_case(v_org, v_gap, v_group_b, v_payer);
  ASSERT v_result = 'ok', format('after gap-fill cancel: %s', v_result);
  PERFORM pg_temp.act_as(NULL);

  -- An invite-created record that Cancel closes (another group joined her)
  -- is no longer held.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Jo', 'last_name', 'Joined', 'email', 'jo.joined@example.test', 'group_id', v_group),
    'gh-link-j', now() + interval '30 days');
  v_joined := (r->>'provider_id')::uuid;
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Jo', 'last_name', 'Joined', 'email', 'jo.joined@example.test', 'group_id', v_group_b),
    'gh-link-j2', now() + interval '30 days');
  ASSERT r->>'result' = 'added_group', format('second group: %s', r);
  PERFORM pg_temp.act_as(v_staff);
  v_result := pg_temp.insert_case(v_org, v_joined, v_group, v_payer);
  ASSERT v_result = v_held_error, format('joined before cancel: %s', v_result);
  PERFORM pg_temp.act_as(NULL);
  ASSERT public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_joined)->>'result' = 'closed', 'joined closed';
  PERFORM pg_temp.act_as(v_staff);
  v_result := pg_temp.insert_case(v_org, v_joined, v_group, v_payer);
  ASSERT v_result = 'ok', format('after cancel: %s', v_result);
  PERFORM pg_temp.act_as(NULL);

  RAISE NOTICE 'provider onboarding generation smoke: all checks passed';
END;
$$;

ROLLBACK;
