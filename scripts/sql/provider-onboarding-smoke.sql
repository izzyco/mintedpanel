-- Smoke test for 20261106200000_provider_onboardings.sql. Run it after the
-- migration is applied, as the postgres user (the owner of the tables and the
-- SECURITY DEFINER functions: on a local `supabase start`, or the SQL editor
-- on staging):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/provider-onboarding-smoke.sql
--
-- Everything runs in one transaction and is rolled back, so it leaves no rows.
-- Every UPDATE that moves a clock or a milestone is scoped to the smoke's own
-- rows. The last block impersonates two synthetic staff users (fake auth.users
-- rows, rolled back) the way PostgREST does. Any failed check raises and stops
-- the script.
BEGIN;

DO $$
DECLARE
  v_org uuid;
  v_other_org uuid;
  v_group uuid;
  v_group_b uuid;
  v_other_group uuid;
  v_actor uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  r jsonb;
  v_provider uuid;
  v_journey uuid;
  v_journey_2 uuid;
  v_invite uuid;
  v_code uuid;
  v_other_journey uuid;
  v_seen uuid[];
  v_state text;
BEGIN
  INSERT INTO public.organizations (name) VALUES ('Smoke Onboarding') RETURNING id INTO v_org;
  INSERT INTO public.organizations (name) VALUES ('Smoke Other') RETURNING id INTO v_other_org;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group A') RETURNING id INTO v_group;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group B') RETURNING id INTO v_group_b;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_other_org, 'Other Group') RETURNING id INTO v_other_group;

  -- Create opens a journey that says the invite made the record.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Anita', 'last_name', 'Rao', 'email', 'Anita@Example.test', 'group_id', v_group,
    'npi', '1234567893'), 'ob-link-1', now() + interval '30 days');
  ASSERT r->>'result' = 'created', format('create: %s', r);
  v_provider := (r->>'provider_id')::uuid;
  v_journey := (r->>'onboarding_id')::uuid;
  v_invite := (r->>'invite_id')::uuid;
  ASSERT (SELECT created_record AND source = 'staff' AND locked_fields = '{}' AND created_by = v_actor
                 AND org_id = v_org AND provider_id = v_provider
            FROM public.provider_onboardings WHERE id = v_journey), 'created journey';
  ASSERT (SELECT onboarding_id FROM public.provider_intake_invites WHERE id = v_invite) = v_journey,
    'invite linked to its journey';

  -- An outside system's reference is kept with its source.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Api', 'last_name', 'Made', 'email', 'api.made@example.test', 'group_id', v_group,
    'source', 'api', 'external_ref', 'ext-42'), 'ob-link-api', now() + interval '30 days');
  ASSERT (SELECT source = 'api' AND external_ref = 'ext-42' FROM public.provider_onboardings
           WHERE id = (r->>'onboarding_id')::uuid), format('api source: %s', r);

  -- Same group, by email (any case) or by NPI: duplicate, nothing written.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'A', 'last_name', 'R', 'email', 'ANITA@example.test', 'group_id', v_group),
    'ob-link-x', now() + interval '30 days');
  ASSERT r->>'result' = 'duplicate' AND (r->>'provider_id')::uuid = v_provider, format('dup email: %s', r);
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'A', 'last_name', 'R', 'email', 'someone.else@example.test', 'group_id', v_group,
    'npi', '1234567893'), 'ob-link-y', now() + interval '30 days');
  ASSERT r->>'result' = 'duplicate' AND (r->>'provider_id')::uuid = v_provider, format('dup npi: %s', r);

  -- An email that is one provider's and an NPI that is another's: a guess
  -- either way, so nothing is written.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'A', 'last_name', 'M', 'email', 'api.made@example.test', 'group_id', v_group_b,
    'npi', '1234567893'), 'ob-link-c', now() + interval '30 days');
  ASSERT r = jsonb_build_object('result', 'conflict'), format('conflict: %s', r);
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_group_assignments WHERE group_id = v_group_b),
    'conflict adds no group';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_invites WHERE token_hash = 'ob-link-c'),
    'conflict sends no invite';

  -- Another group: she joins it on her existing record. No invite, no email.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Anita', 'last_name', 'Rao', 'email', 'other.address@example.test', 'group_id', v_group_b,
    'npi', '1234567893'), 'ob-link-z', now() + interval '30 days');
  ASSERT r->>'result' = 'added_group' AND (r->>'provider_id')::uuid = v_provider, format('added group: %s', r);
  ASSERT (SELECT count(*) FROM public.provider_group_assignments
           WHERE provider_id = v_provider AND group_id = v_group_b AND NOT is_primary AND end_date IS NULL) = 1,
    'non-primary assignment added';
  ASSERT (SELECT group_id FROM public.provider_group_assignments WHERE provider_id = v_provider AND is_primary) = v_group,
    'primary unchanged';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_invites WHERE token_hash = 'ob-link-z'), 'no invite for added group';
  ASSERT (SELECT count(*) FROM public.providers WHERE org_id = v_org AND npi = '1234567893') = 1, 'one record per person';
  ASSERT (SELECT count(*) FROM public.audit_log
           WHERE org_id = v_org AND entity_type = 'provider' AND entity_id = v_provider
             AND action_type = 'UPDATE' AND after->>'group_id' = v_group_b::text) = 1, 'added-group audit row';
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Anita', 'last_name', 'Rao', 'email', 'anita@example.test', 'group_id', v_group_b),
    'ob-link-z2', now() + interval '30 days');
  ASSERT r->>'result' = 'duplicate', format('now in group b: %s', r);

  -- An ended assignment to the group is reopened, not duplicated.
  UPDATE public.provider_group_assignments SET end_date = current_date
   WHERE provider_id = v_provider AND group_id = v_group_b;
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Anita', 'last_name', 'Rao', 'email', 'anita@example.test', 'group_id', v_group_b),
    'ob-link-z3', now() + interval '30 days');
  ASSERT r->>'result' = 'added_group', format('reopen: %s', r);
  ASSERT (SELECT end_date IS NULL FROM public.provider_group_assignments
           WHERE provider_id = v_provider AND group_id = v_group_b), 'ended assignment reopened';

  -- Two records that share an email are a conflict too.
  INSERT INTO public.providers (org_id, first_name, last_name, email, status)
    VALUES (v_org, 'Twin', 'One', 'twin@example.test', 'active'),
           (v_org, 'Twin', 'Two', 'TWIN@example.test', 'active');
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Twin', 'last_name', 'One', 'email', 'twin@example.test', 'group_id', v_group),
    'ob-link-twin', now() + interval '30 days');
  ASSERT r->>'result' = 'conflict', format('shared email: %s', r);

  -- The match never reaches into another org.
  r := public.create_provider_intake_invite(v_other_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Anita', 'last_name', 'Rao', 'email', 'anita@example.test', 'group_id', v_other_group,
    'npi', '1234567893'), 'ob-link-other', now() + interval '30 days');
  ASSERT r->>'result' = 'created' AND (r->>'provider_id')::uuid <> v_provider, format('other org: %s', r);
  v_other_journey := (r->>'onboarding_id')::uuid;

  -- Resend reuses the open journey.
  UPDATE public.provider_intake_invites SET created_at = created_at - interval '11 minutes'
   WHERE provider_id = v_provider AND revoked_at IS NULL;
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_provider, 'ob-link-2', now() + interval '30 days');
  ASSERT r->>'result' = 'resent' AND (r->>'onboarding_id')::uuid = v_journey, format('resend reuses: %s', r);
  ASSERT (SELECT onboarding_id FROM public.provider_intake_invites WHERE token_hash = 'ob-link-2') = v_journey,
    'resent invite linked';
  ASSERT (SELECT count(*) FROM public.provider_onboardings WHERE provider_id = v_provider) = 1, 'still one journey';

  -- One open journey per provider.
  BEGIN
    INSERT INTO public.provider_onboardings (org_id, provider_id) VALUES (v_org, v_provider);
    RAISE EXCEPTION 'second open journey was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  -- A journey ends one way.
  BEGIN
    UPDATE public.provider_onboardings SET admitted_at = now(), cancelled_at = now() WHERE id = v_journey;
    RAISE EXCEPTION 'admitted and cancelled both accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- After Admit, a re-invite revokes the old link and opens a new journey that
  -- locks what is on file now.
  UPDATE public.providers SET date_of_birth = '1990-04-02', ssn_last4 = '6789' WHERE id = v_provider;
  UPDATE public.provider_onboardings SET admitted_at = now() WHERE id = v_journey;
  -- A journey can't name another org's provider (none open here, so the
  -- key is what refuses it).
  BEGIN
    INSERT INTO public.provider_onboardings (org_id, provider_id) VALUES (v_other_org, v_provider);
    RAISE EXCEPTION 'cross-org journey was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  UPDATE public.provider_intake_invites SET created_at = created_at - interval '11 minutes'
   WHERE provider_id = v_provider AND revoked_at IS NULL;
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_provider, 'ob-link-3', now() + interval '30 days');
  v_journey_2 := (r->>'onboarding_id')::uuid;
  ASSERT r->>'result' = 'resent' AND v_journey_2 <> v_journey, format('new journey: %s', r);
  ASSERT (SELECT NOT created_record AND locked_fields = ARRAY['ssn', 'npi', 'date_of_birth'] AND created_by = v_actor
            FROM public.provider_onboardings WHERE id = v_journey_2), 'locked snapshot';
  ASSERT public.read_intake_link('ob-link-2') IS NULL, 'old link dead';
  ASSERT (SELECT onboarding_id FROM public.provider_intake_invites WHERE token_hash = 'ob-link-3') = v_journey_2,
    'new invite on the new journey';

  -- A hand-added provider with nothing on file opens a journey with no locks.
  INSERT INTO public.providers (org_id, first_name, last_name, email, status)
    VALUES (v_org, 'Hand', 'Added', 'hand@example.test', 'active') RETURNING id INTO v_provider;
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_provider, 'ob-link-4', now() + interval '30 days');
  ASSERT (SELECT locked_fields = '{}' AND NOT created_record FROM public.provider_onboardings
           WHERE id = (r->>'onboarding_id')::uuid), format('first invite journey: %s', r);
  -- An SSN in the vault alone counts as on file.
  UPDATE public.provider_onboardings SET cancelled_at = now() WHERE id = (r->>'onboarding_id')::uuid;
  INSERT INTO public.provider_ssn_vault (provider_id, org_id, ssn_ciphertext) VALUES (v_provider, v_org, '\x00');
  UPDATE public.provider_intake_invites SET created_at = created_at - interval '11 minutes'
   WHERE provider_id = v_provider AND revoked_at IS NULL;
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_provider, 'ob-link-5', now() + interval '30 days');
  ASSERT (SELECT locked_fields = ARRAY['ssn'] FROM public.provider_onboardings
           WHERE id = (r->>'onboarding_id')::uuid), format('vault ssn locks: %s', r);

  -- Codes: issue_intake_code names the code it stored.
  r := public.issue_intake_code('ob-link-5', 'ob-code-1');
  v_code := (r->>'code_id')::uuid;
  ASSERT (r->>'send')::boolean
     AND (SELECT code_hash FROM public.provider_intake_codes WHERE id = v_code) = 'ob-code-1', format('code_id: %s', r);
  ASSERT public.issue_intake_code('nope', 'ob-code-x')->>'code_id' IS NULL, 'no code_id without a send';

  -- Delivery is recorded once; a retry never overwrites it.
  v_invite := (SELECT id FROM public.provider_intake_invites WHERE token_hash = 'ob-link-5');
  ASSERT public.record_intake_email_delivery('invite', v_invite, 'failed'), 'invite delivery set';
  ASSERT NOT public.record_intake_email_delivery('invite', v_invite, 'sent'), 'invite delivery kept';
  ASSERT (SELECT delivery FROM public.provider_intake_invites WHERE id = v_invite) = 'failed', 'invite delivery value';
  ASSERT public.record_intake_email_delivery('code', v_code, 'sandbox'), 'code delivery set';
  ASSERT NOT public.record_intake_email_delivery('code', v_code, 'sent'), 'code delivery kept';
  ASSERT (SELECT delivery FROM public.provider_intake_codes WHERE id = v_code) = 'sandbox', 'code delivery value';
  ASSERT public.record_intake_email_delivery('submitted', v_journey_2, 'sent'), 'submitted delivery set';
  ASSERT NOT public.record_intake_email_delivery('submitted', v_journey_2, 'failed'), 'submitted delivery kept';
  ASSERT (SELECT submitted_email_delivery FROM public.provider_onboardings WHERE id = v_journey_2) = 'sent',
    'submitted delivery value';
  ASSERT NOT public.record_intake_email_delivery('invite', gen_random_uuid(), 'sent'), 'unknown id';
  BEGIN
    PERFORM public.record_intake_email_delivery('invite', v_invite, 'bounced');
    RAISE EXCEPTION 'invalid delivery accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.record_intake_email_delivery('reminder', v_invite, 'sent');
    RAISE EXCEPTION 'invalid kind accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  -- An email change revokes the open invite and its session; the journey stays.
  UPDATE public.provider_intake_codes SET created_at = created_at - interval '1 day' WHERE id = v_code;
  ASSERT (public.issue_intake_code('ob-link-5', 'ob-code-2')->>'send')::boolean, 'fresh code';
  ASSERT public.verify_intake_code('ob-link-5', 'ob-code-2', 'ob-sess-1', now() + interval '2 hours') = 'ok', 'signed in';
  UPDATE public.providers SET email = ' HAND@example.test ' WHERE id = v_provider;
  ASSERT public.read_intake_link('ob-link-5') IS NOT NULL, 'case and spaces are not a change';
  UPDATE public.providers SET email = 'hand.new@example.test' WHERE id = v_provider;
  ASSERT public.read_intake_link('ob-link-5') IS NULL, 'email change revokes the invite';
  ASSERT (SELECT revoked_at IS NOT NULL FROM public.provider_intake_sessions WHERE token_hash = 'ob-sess-1'),
    'email change revokes the session';
  ASSERT (SELECT count(*) FROM public.audit_log
           WHERE entity_type = 'provider_intake_invite' AND entity_id = v_invite
             AND description = 'Revoked onboarding invite (provider email changed)') = 1, 'revoke audit row';
  v_journey := (SELECT id FROM public.provider_onboardings
                 WHERE provider_id = v_provider AND admitted_at IS NULL AND cancelled_at IS NULL);
  ASSERT v_journey IS NOT NULL, 'journey stays open';
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_provider, 'ob-link-6', now() + interval '30 days');
  ASSERT r->>'result' = 'resent' AND r->>'email' = 'hand.new@example.test'
     AND (r->>'onboarding_id')::uuid = v_journey, format('resend after email change: %s', r);

  -- Termination revokes too.
  UPDATE public.providers SET status = 'terminated' WHERE id = v_provider;
  ASSERT public.read_intake_link('ob-link-6') IS NULL, 'termination revokes the invite';
  ASSERT (SELECT count(*) FROM public.audit_log
           WHERE entity_type = 'provider_intake_invite'
             AND entity_id = (SELECT id FROM public.provider_intake_invites WHERE token_hash = 'ob-link-6')
             AND description = 'Revoked onboarding invite (provider terminated)') = 1, 'termination audit row';

  -- The off switch reads false until the operator sets it.
  ASSERT NOT public.intake_paused(), 'not paused by default';
  UPDATE public.provider_intake_settings SET paused = true;
  ASSERT public.intake_paused(), 'paused';
  DELETE FROM public.provider_intake_settings;
  ASSERT NOT public.intake_paused(), 'a missing row is not paused';

  -- Grants: only service_role calls the RPCs; members read journeys, never write them.
  ASSERT NOT has_function_privilege('authenticated', 'public.record_intake_email_delivery(text, uuid, text)', 'EXECUTE'), 'authenticated delivery rpc';
  ASSERT NOT has_function_privilege('anon', 'public.intake_paused()', 'EXECUTE'), 'anon paused rpc';
  ASSERT has_function_privilege('service_role', 'public.intake_paused()', 'EXECUTE'), 'service_role paused rpc';
  ASSERT NOT has_function_privilege('service_role', 'public._match_onboarding_provider(uuid, text, text, uuid)', 'EXECUTE'), 'match is private';
  ASSERT NOT has_table_privilege('authenticated', 'public.provider_onboardings', 'INSERT'), 'authenticated journey insert';
  ASSERT NOT has_table_privilege('authenticated', 'public.provider_onboardings', 'UPDATE'), 'authenticated journey update';
  ASSERT NOT has_table_privilege('anon', 'public.provider_onboardings', 'SELECT'), 'anon journey read';
  ASSERT NOT has_table_privilege('authenticated', 'public.provider_intake_settings', 'SELECT'), 'authenticated settings';

  -- RLS: a member of the org sees its journeys and not another org's. A staff
  -- email edit under RLS still revokes the invite (the trigger is a definer).
  INSERT INTO auth.users (id, email) VALUES
    (v_member, 'ob-smoke-member@example.invalid'), (v_outsider, 'ob-smoke-outsider@example.invalid');
  INSERT INTO public.profiles (id, full_name, email) VALUES
    (v_member, 'Smoke Member', 'ob-smoke-member@example.invalid'),
    (v_outsider, 'Smoke Outsider', 'ob-smoke-outsider@example.invalid')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (org_id, user_id, role) VALUES
    (v_org, v_member, 'specialist'), (v_other_org, v_outsider, 'specialist');
  v_provider := (SELECT provider_id FROM public.provider_onboardings WHERE id = (
    SELECT onboarding_id FROM public.provider_intake_invites WHERE token_hash = 'ob-link-api'));

  PERFORM set_config('request.jwt.claim.sub', v_member::text, true),
          set_config('request.jwt.claim.role', 'authenticated', true),
          set_config('request.jwt.claims',
            json_build_object('sub', v_member, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(DISTINCT org_id) INTO v_seen FROM public.provider_onboardings;
  UPDATE public.providers SET email = 'api.made.new@example.test' WHERE id = v_provider;
  BEGIN
    UPDATE public.provider_onboardings SET cancelled_at = now() WHERE provider_id = v_provider;
    v_state := '00000';
  EXCEPTION WHEN insufficient_privilege THEN
    v_state := '42501';
  END;
  RESET ROLE;
  ASSERT v_seen = ARRAY[v_org], format('member sees only her org: %s', v_seen);
  ASSERT v_state = '42501', 'members cannot write journeys';
  ASSERT public.read_intake_link('ob-link-api') IS NULL, 'staff email edit revokes the invite';
  ASSERT (SELECT user_id FROM public.audit_log
           WHERE entity_type = 'provider_intake_invite'
             AND entity_id = (SELECT id FROM public.provider_intake_invites WHERE token_hash = 'ob-link-api')
             AND description = 'Revoked onboarding invite (provider email changed)') = v_member,
    'revoke audit row names the staff member';

  PERFORM set_config('request.jwt.claim.sub', v_outsider::text, true),
          set_config('request.jwt.claims',
            json_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(id) INTO v_seen FROM public.provider_onboardings;
  RESET ROLE;
  ASSERT v_seen = ARRAY[v_other_journey], format('outsider sees only her org: %s', v_seen);

  PERFORM set_config('request.jwt.claim.sub', '', true),
          set_config('request.jwt.claim.role', '', true),
          set_config('request.jwt.claims', '', true);

  RAISE NOTICE 'provider onboarding smoke: all checks passed';
END;
$$;

ROLLBACK;
