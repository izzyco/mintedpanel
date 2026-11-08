-- Smoke test for 20261106210000_provider_intake_drafts.sql. Run it after the
-- migration is applied, as the postgres user (the owner of the tables and the
-- SECURITY DEFINER functions: on a local `supabase start`, or the SQL editor
-- on staging):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/provider-intake-drafts-smoke.sql
--
-- Everything runs in one transaction and is rolled back, so it leaves no rows.
-- Hashes are plain strings here: the RPCs only compare them. Any failed check
-- raises and stops the script.
BEGIN;

DO $$
DECLARE
  v_org uuid;
  v_other_org uuid;
  v_group uuid;
  v_other_group uuid;
  v_actor uuid := gen_random_uuid();
  r jsonb;
  v_provider uuid;
  v_journey uuid;
  v_journey_2 uuid;
  v_answers jsonb := jsonb_build_object(
    'firstName', 'Anita', 'mobile', '7045550100', 'npi', '1234567893',
    'dateOfBirth', '1990-04-02', 'ssn', '123456789',
    'licenses', jsonb_build_array(jsonb_build_object('state', 'NC', 'number', 'PT-1', 'expiresOn', null)));
BEGIN
  INSERT INTO public.organizations (name) VALUES ('Smoke Drafts') RETURNING id INTO v_org;
  INSERT INTO public.organizations (name) VALUES ('Smoke Drafts Other') RETURNING id INTO v_other_org;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group') RETURNING id INTO v_group;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_other_org, 'Other Group') RETURNING id INTO v_other_group;

  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Anita', 'last_name', 'Rao', 'email', 'anita.drafts@example.test', 'group_id', v_group),
    'dr-link-a', now() + interval '30 days');
  v_provider := (r->>'provider_id')::uuid;
  v_journey := (r->>'onboarding_id')::uuid;
  INSERT INTO public.state_licenses (org_id, provider_id, state, license_number, expiration_date)
    VALUES (v_org, v_provider, 'NC', 'PT-48213', '2027-12-31');
  UPDATE public.providers SET phone = '7045550199', home_city = 'Charlotte' WHERE id = v_provider;

  -- Another org's invite and session, for the cross-link checks.
  PERFORM public.create_provider_intake_invite(v_other_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Other', 'last_name', 'Person', 'email', 'other.drafts@example.test',
    'group_id', v_other_group), 'dr-link-b', now() + interval '30 days');
  ASSERT (public.issue_intake_code('dr-link-b', 'dr-code-b')->>'send')::boolean, 'code b';
  ASSERT public.verify_intake_code('dr-link-b', 'dr-code-b', 'dr-sess-b', now() + interval '2 hours') = 'ok', 'session b';

  ASSERT (public.issue_intake_code('dr-link-a', 'dr-code-a')->>'send')::boolean, 'code a';
  ASSERT public.verify_intake_code('dr-link-a', 'dr-code-a', 'dr-sess-a', now() + interval '2 hours') = 'ok', 'session a';

  -- State: her record in the answers shape, nothing saved or signed yet.
  r := public.read_intake_state('dr-sess-a', 'dr-link-a');
  ASSERT r->>'practice_name' = 'Smoke Drafts' AND r->>'email' = 'anita.drafts@example.test', format('state: %s', r);
  ASSERT r->'record'->>'firstName' = 'Anita' AND r->'record'->>'mobile' = '7045550199'
     AND r->'record'->>'homeCity' = 'Charlotte' AND r->'record'->'npi' = 'null'::jsonb, format('record: %s', r);
  ASSERT r->'record'->'licenses' = jsonb_build_array(jsonb_build_object(
    'state', 'NC', 'number', 'PT-48213', 'expiresOn', '2027-12-31')), format('licenses: %s', r);
  ASSERT r->'locked_fields' = '[]'::jsonb AND r->'ssn_last4' = 'null'::jsonb, format('locks: %s', r);
  ASSERT r->'draft' = 'null'::jsonb AND NOT (r->>'consented')::boolean
     AND r->'consent_text_version' = 'null'::jsonb AND NOT (r->>'submitted')::boolean, format('fresh: %s', r);

  -- A session is good only under its own link, and only while it is live.
  ASSERT public.read_intake_state('dr-sess-a', 'dr-link-b') IS NULL, 'org a session under org b link';
  ASSERT public.read_intake_state('dr-sess-b', 'dr-link-a') IS NULL, 'org b session under org a link';
  ASSERT public.read_intake_state('dr-sess-nope', 'dr-link-a') IS NULL, 'unknown session';
  ASSERT public.save_intake_draft('dr-sess-a', 'dr-link-b', '{}', 'form', 0) IS NULL, 'save under another link';
  ASSERT public.sign_intake_consent('dr-sess-a', 'dr-link-b', 'Anita Rao', 1) IS NULL, 'sign under another link';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_drafts d
                       JOIN public.provider_onboardings o ON o.id = d.onboarding_id
                      WHERE o.org_id = v_other_org), 'nothing written for org b';
  UPDATE public.provider_intake_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = 'dr-sess-b';
  ASSERT public.read_intake_state('dr-sess-b', 'dr-link-b') IS NULL, 'expired session';

  -- Save: version 0 -> 1 -> 2; a stale version conflicts and writes nothing.
  r := public.save_intake_draft('dr-sess-a', 'dr-link-a', v_answers, 'form', 0);
  ASSERT r = jsonb_build_object('result', 'saved', 'version', 1), format('first save: %s', r);
  ASSERT (SELECT answers->>'npi' = '1234567893' AND NOT answers ? 'ssn' AND org_id = v_org
            FROM public.provider_intake_drafts WHERE onboarding_id = v_journey), 'unlocked npi kept, ssn dropped';
  r := public.save_intake_draft('dr-sess-a', 'dr-link-a', jsonb_build_object('mobile', '7045550111'), 'documents', 1);
  ASSERT r = jsonb_build_object('result', 'saved', 'version', 2), format('second save: %s', r);
  r := public.save_intake_draft('dr-sess-a', 'dr-link-a', jsonb_build_object('mobile', 'stale'), 'form', 0);
  ASSERT r = jsonb_build_object('result', 'conflict', 'version', 2), format('stale save: %s', r);
  r := public.read_intake_state('dr-sess-a', 'dr-link-a');
  ASSERT r->'draft'->'answers' = jsonb_build_object('mobile', '7045550111') AND r->'draft'->>'step' = 'documents'
     AND (r->'draft'->>'version')::int = 2 AND r->'draft'->>'updated_at' IS NOT NULL, format('saved draft: %s', r);
  BEGIN
    PERFORM public.save_intake_draft('dr-sess-a', 'dr-link-a', '[]', 'form', 2);
    RAISE EXCEPTION 'non-object answers accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.save_intake_draft('dr-sess-a', 'dr-link-a', '{}', 'review', 2);
    RAISE EXCEPTION 'unknown step accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  ASSERT NOT EXISTS (SELECT 1 FROM public.audit_log WHERE org_id = v_org AND entity_type = 'provider_intake_draft'),
    'a save writes no audit row';

  -- Consent: the first signature sets consented_at; signing again appends.
  r := public.sign_intake_consent('dr-sess-a', 'dr-link-a', '  Anita Rao ', 1);
  ASSERT r = jsonb_build_object('result', 'signed'), format('sign: %s', r);
  ASSERT (SELECT consented_at IS NOT NULL FROM public.provider_onboardings WHERE id = v_journey), 'consented_at set';
  ASSERT (SELECT typed_name = 'Anita Rao' AND text_version = 1 AND org_id = v_org
                 AND session_id = (SELECT id FROM public.provider_intake_sessions WHERE token_hash = 'dr-sess-a')
            FROM public.provider_intake_consents WHERE onboarding_id = v_journey), 'signature row';
  -- One transaction gives both signatures the same now(); backdate the first
  -- so "latest" has an answer, as it always does across real requests.
  UPDATE public.provider_onboardings SET consented_at = consented_at - interval '1 day' WHERE id = v_journey;
  UPDATE public.provider_intake_consents SET signed_at = signed_at - interval '1 day' WHERE onboarding_id = v_journey;
  r := public.sign_intake_consent('dr-sess-a', 'dr-link-a', 'Anita R. Rao', 2);
  ASSERT (SELECT count(*) FROM public.provider_intake_consents WHERE onboarding_id = v_journey) = 2, 're-sign appends';
  ASSERT (SELECT consented_at < now() - interval '23 hours' FROM public.provider_onboardings WHERE id = v_journey),
    'consented_at set once';
  r := public.read_intake_state('dr-sess-a', 'dr-link-a');
  ASSERT (r->>'consented')::boolean AND (r->>'consent_text_version')::int = 2, format('consent state: %s', r);
  ASSERT (SELECT count(*) FROM public.audit_log
           WHERE org_id = v_org AND entity_type = 'provider_intake_consent' AND action_type = 'CREATE'
             AND entity_id IN (SELECT id FROM public.provider_intake_consents WHERE onboarding_id = v_journey)
             AND description NOT LIKE '%Anita%' AND after IS NULL) = 2, 'one audit row per signature, no name';
  BEGIN
    PERFORM public.sign_intake_consent('dr-sess-a', 'dr-link-a', '   ', 1);
    RAISE EXCEPTION 'blank name accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.sign_intake_consent('dr-sess-a', 'dr-link-a', 'Anita Rao', 0);
    RAISE EXCEPTION 'version 0 accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  -- Closed once she has submitted: nothing more is saved or signed.
  UPDATE public.provider_onboardings SET submitted_at = now() WHERE id = v_journey;
  r := public.save_intake_draft('dr-sess-a', 'dr-link-a', '{}', 'form', 2);
  ASSERT r = jsonb_build_object('result', 'closed'), format('closed save: %s', r);
  ASSERT public.sign_intake_consent('dr-sess-a', 'dr-link-a', 'Anita Rao', 1) = jsonb_build_object('result', 'closed'),
    'closed sign';
  ASSERT (SELECT version FROM public.provider_intake_drafts WHERE onboarding_id = v_journey) = 2, 'closed writes nothing';
  ASSERT (public.read_intake_state('dr-sess-a', 'dr-link-a')->>'submitted')::boolean, 'submitted in state';

  -- After Admit, a re-invite opens a new journey that locks the NPI and date
  -- of birth on file; her save keeps neither.
  UPDATE public.providers SET npi = '1234567893', date_of_birth = '1990-04-02' WHERE id = v_provider;
  UPDATE public.provider_onboardings SET admitted_at = now() WHERE id = v_journey;
  UPDATE public.provider_intake_invites SET created_at = created_at - interval '11 minutes'
   WHERE provider_id = v_provider AND revoked_at IS NULL;
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_provider, 'dr-link-a2', now() + interval '30 days');
  v_journey_2 := (r->>'onboarding_id')::uuid;
  ASSERT v_journey_2 <> v_journey, format('new journey: %s', r);
  ASSERT public.read_intake_state('dr-sess-a', 'dr-link-a') IS NULL, 'a resend ends the old session';
  ASSERT (public.issue_intake_code('dr-link-a2', 'dr-code-a2')->>'send')::boolean, 'code a2';
  ASSERT public.verify_intake_code('dr-link-a2', 'dr-code-a2', 'dr-sess-a2', now() + interval '2 hours') = 'ok', 'session a2';
  r := public.read_intake_state('dr-sess-a2', 'dr-link-a2');
  ASSERT r->'locked_fields' = '["npi", "date_of_birth"]'::jsonb AND r->'draft' = 'null'::jsonb
     AND NOT (r->>'consented')::boolean AND NOT (r->>'submitted')::boolean, format('new journey state: %s', r);
  r := public.save_intake_draft('dr-sess-a2', 'dr-link-a2', v_answers, 'form', 0);
  ASSERT r = jsonb_build_object('result', 'saved', 'version', 1), format('locked save: %s', r);
  ASSERT (SELECT NOT answers ? 'npi' AND NOT answers ? 'dateOfBirth' AND NOT answers ? 'ssn'
                 AND answers->>'mobile' = '7045550100' AND answers->'licenses' = v_answers->'licenses'
            FROM public.provider_intake_drafts WHERE onboarding_id = v_journey_2), 'locked keys dropped';

  -- A cancelled journey's session reads nothing.
  UPDATE public.provider_onboardings SET cancelled_at = now() WHERE id = v_journey_2;
  ASSERT public.read_intake_state('dr-sess-a2', 'dr-link-a2') IS NULL, 'cancelled journey';
  ASSERT public.save_intake_draft('dr-sess-a2', 'dr-link-a2', '{}', 'form', 1) IS NULL, 'cancelled save';

  -- Deleting the provider takes drafts and signatures with the journeys.
  DELETE FROM public.state_licenses WHERE provider_id = v_provider;
  DELETE FROM public.provider_group_assignments WHERE provider_id = v_provider;
  DELETE FROM public.providers WHERE id = v_provider;
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_drafts WHERE onboarding_id IN (v_journey, v_journey_2)),
    'drafts cascade';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_consents WHERE onboarding_id = v_journey),
    'signatures cascade';

  -- Grants: only service_role calls the RPCs, and nobody else reads the tables.
  ASSERT NOT has_function_privilege('authenticated', 'public.read_intake_state(text, text)', 'EXECUTE'), 'authenticated state';
  ASSERT NOT has_function_privilege('anon', 'public.save_intake_draft(text, text, jsonb, text, int)', 'EXECUTE'), 'anon save';
  ASSERT NOT has_function_privilege('anon', 'public.sign_intake_consent(text, text, text, int)', 'EXECUTE'), 'anon sign';
  ASSERT has_function_privilege('service_role', 'public.save_intake_draft(text, text, jsonb, text, int)', 'EXECUTE'), 'service_role save';
  ASSERT NOT has_function_privilege('service_role', 'public._intake_session_context(text, text)', 'EXECUTE'), 'context is private';
  ASSERT NOT has_table_privilege('authenticated', 'public.provider_intake_drafts', 'SELECT'), 'authenticated drafts';
  ASSERT NOT has_table_privilege('anon', 'public.provider_intake_consents', 'SELECT'), 'anon consents';
  ASSERT NOT has_table_privilege('service_role', 'public.provider_intake_consents', 'UPDATE')
     AND NOT has_table_privilege('service_role', 'public.provider_intake_consents', 'DELETE'), 'consents append-only';
  ASSERT (SELECT count(*) FROM pg_trigger
           WHERE tgname = 'block_writes_when_offboarded'
             AND tgrelid IN ('public.provider_intake_drafts'::regclass, 'public.provider_intake_consents'::regclass)) = 2,
    'offboarded freeze on both tables';

  RAISE NOTICE 'provider intake drafts smoke: all checks passed';
END;
$$;

ROLLBACK;
