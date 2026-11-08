-- Smoke test for 20261106233000_provider_intake_submit.sql. Run it after the
-- migration is applied, as the postgres user (the owner of the tables and the
-- SECURITY DEFINER functions: on a local `supabase start`, or the SQL editor
-- on staging):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/provider-intake-submit-smoke.sql
--
-- Everything runs in one transaction and is rolled back, so it leaves no rows.
-- It touches no Storage object: the submit route copies and deletes files.
-- Hashes are plain strings here: the RPCs only compare them. Any failed check
-- raises and stops the script.
BEGIN;

DO $$
DECLARE
  v_org uuid;
  v_group uuid;
  v_actor uuid := gen_random_uuid();
  r jsonb;
  v_answers jsonb;
  v_provider uuid;
  v_journey uuid;
  v_nc uuid;
  v_va uuid;
  v_cv uuid;
  v_lic uuid;
  v_coi uuid;
  v_stale uuid;
  v_docs jsonb;
  v_audit jsonb;
  v_locked_provider uuid;
  v_locked_journey uuid;
  v_taken_journey uuid;
  v_taken_provider uuid;
  v_admitted_journey uuid;
  v_state text;
BEGIN
  INSERT INTO public.organizations (name) VALUES ('Smoke Submit') RETURNING id INTO v_org;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group') RETURNING id INTO v_group;

  -- A new hire, signed in, with two licenses on her record before she starts.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Anita', 'last_name', 'Rao', 'email', 'anita.submit@example.test', 'group_id', v_group),
    'sub-link-a', now() + interval '30 days');
  v_provider := (r->>'provider_id')::uuid;
  v_journey := (r->>'onboarding_id')::uuid;
  ASSERT (public.issue_intake_code('sub-link-a', 'sub-code-a')->>'send')::boolean, 'code a';
  ASSERT public.verify_intake_code('sub-link-a', 'sub-code-a', 'sub-sess-a', now() + interval '2 hours') = 'ok', 'session a';
  INSERT INTO public.state_licenses (org_id, provider_id, state, license_number, expiration_date, verified_status, verified_at)
    VALUES (v_org, v_provider, 'NC', 'PT-1', '2026-12-31', 'verified', now()) RETURNING id INTO v_nc;
  INSERT INTO public.state_licenses (org_id, provider_id, state, license_number, expiration_date)
    VALUES (v_org, v_provider, 'VA', 'VA-1', '2027-03-31') RETURNING id INTO v_va;

  -- Nothing is written before she has signed the consent.
  BEGIN
    PERFORM public.submit_provider_intake('sub-sess-a', 'sub-link-a', 0, '[]');
    RAISE EXCEPTION 'a Submit without consent was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  ASSERT public.sign_intake_consent('sub-sess-a', 'sub-link-a', 'Anita Rao', 1)->>'result' = 'signed', 'consent a';

  r := public.read_intake_state('sub-sess-a', 'sub-link-a');
  ASSERT (r->>'org_id')::uuid = v_org AND (r->>'provider_id')::uuid = v_provider
     AND r->'held_object_paths' = '[]'::jsonb, format('state names her org, record and no held files: %s', r);

  -- Her answers: NC renewed with a new number, SC added, VA not listed.
  v_answers := jsonb_build_object(
    'firstName', 'Anita', 'lastName', 'Rao-Smith', 'npi', '1730195835', 'taxonomyCode', '225100000X',
    'dateOfBirth', '1990-04-02', 'caqhId', '12345678', 'mobile', '(704) 555-0100',
    'homeStreet', '1 Main St', 'homeCity', 'Charlotte', 'homeState', 'nc', 'homeZip', '28202',
    'licenses', jsonb_build_array(
      jsonb_build_object('state', 'NC', 'number', 'PT-2', 'expiresOn', '2028-01-31'),
      jsonb_build_object('state', 'SC', 'number', 'SC-9', 'expiresOn', '2027-05-01')));
  ASSERT public.save_intake_draft('sub-sess-a', 'sub-link-a', v_answers, 'documents', 0)->>'result' = 'saved', 'draft';

  -- Her files: a CV, the NC license copy, a COI with its date, and an SC copy
  -- she replaced (removed), which stays held until Submit clears it.
  r := public.begin_intake_upload('sub-sess-a', 'sub-link-a', 'cv', 'cv', 'cv.pdf', 100, 'application/pdf', NULL);
  v_cv := (r->>'upload_id')::uuid;
  PERFORM public.finish_intake_upload('sub-sess-a', 'sub-link-a', v_cv, 100);
  r := public.begin_intake_upload('sub-sess-a', 'sub-link-a', 'license:NC', 'state_license', 'nc.pdf', 100,
                                  'application/pdf', NULL);
  v_lic := (r->>'upload_id')::uuid;
  PERFORM public.finish_intake_upload('sub-sess-a', 'sub-link-a', v_lic, 100);
  r := public.begin_intake_upload('sub-sess-a', 'sub-link-a', 'coi', 'coi', 'coi.png', 100, 'image/png', '2027-06-30');
  v_coi := (r->>'upload_id')::uuid;
  PERFORM public.finish_intake_upload('sub-sess-a', 'sub-link-a', v_coi, 100);
  r := public.begin_intake_upload('sub-sess-a', 'sub-link-a', 'license:SC', 'state_license', 'old.pdf', 100,
                                  'application/pdf', NULL);
  v_stale := (r->>'upload_id')::uuid;
  PERFORM public.remove_intake_upload('sub-sess-a', 'sub-link-a', v_stale);
  ASSERT jsonb_array_length(public.read_intake_state('sub-sess-a', 'sub-link-a')->'held_object_paths') = 4,
    'every object her journey put in the holding bucket, removed ones too';

  -- Staff edit her record after the invite; her answer wins.
  UPDATE public.providers SET phone = '(704) 555-0999' WHERE id = v_provider;

  v_docs := jsonb_build_array(
    jsonb_build_object('upload_id', v_cv, 'file_path', format('org/%s/provider/%s/%s/1/cv.pdf', v_org, v_provider, v_cv)),
    jsonb_build_object('upload_id', v_lic, 'file_path', format('org/%s/provider/%s/%s/1/nc.pdf', v_org, v_provider, v_lic)),
    jsonb_build_object('upload_id', v_coi, 'file_path', format('org/%s/provider/%s/%s/1/coi.png', v_org, v_provider, v_coi)));

  -- A stale version, another link and a bad document change nothing.
  r := public.submit_provider_intake('sub-sess-a', 'sub-link-a', 0, v_docs);
  ASSERT r = jsonb_build_object('result', 'conflict', 'version', 1), format('stale: %s', r);
  ASSERT public.submit_provider_intake('sub-sess-a', 'sub-link-nope', 1, v_docs) IS NULL, 'another link';
  BEGIN
    PERFORM public.submit_provider_intake('sub-sess-a', 'sub-link-a', 1, jsonb_build_array(
      jsonb_build_object('upload_id', v_cv, 'file_path', format('org/%s/provider/%s/elsewhere/1/cv.pdf', v_org, v_provider))));
    RAISE EXCEPTION 'a path that is not the vault path was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.submit_provider_intake('sub-sess-a', 'sub-link-a', 1, jsonb_build_array(
      jsonb_build_object('upload_id', v_stale, 'file_path', format('org/%s/provider/%s/%s/1/old.pdf', v_org, v_provider, v_stale))));
    RAISE EXCEPTION 'a removed upload was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  ASSERT (SELECT submitted_at IS NULL FROM public.provider_onboardings WHERE id = v_journey), 'nothing submitted yet';
  ASSERT (SELECT last_name = 'Rao' FROM public.providers WHERE id = v_provider), 'nothing merged yet';

  r := public.submit_provider_intake('sub-sess-a', 'sub-link-a', 1, v_docs);
  ASSERT r->>'result' = 'submitted'
     AND (r->>'onboarding_id')::uuid = v_journey AND (r->>'provider_id')::uuid = v_provider
     AND r->>'practice_name' = 'Smoke Submit' AND r->>'first_name' = 'Anita'
     AND r->>'email' = 'anita.submit@example.test', format('submit: %s', r);

  -- Her answers are on the record; email and status are not hers to change.
  ASSERT (SELECT last_name = 'Rao-Smith' AND npi = '1730195835' AND date_of_birth = '1990-04-02'
                 AND caqh_id = '12345678' AND phone = '(704) 555-0100' AND home_state = 'NC'
                 AND home_zip = '28202' AND email = 'anita.submit@example.test' AND status = 'onboarding'
            FROM public.providers WHERE id = v_provider), 'merged columns';
  -- Licenses: NC updated by state and back to unverified, SC added, VA kept.
  ASSERT (SELECT license_number = 'PT-2' AND expiration_date = '2028-01-31' AND verified_status = 'unverified'
                 AND verified_at IS NULL
            FROM public.state_licenses WHERE id = v_nc), 'NC renewed in place';
  ASSERT (SELECT count(*) FROM public.state_licenses
           WHERE provider_id = v_provider AND state = 'SC' AND license_number = 'SC-9'
             AND expiration_date = '2027-05-01') = 1, 'SC added';
  ASSERT (SELECT license_number = 'VA-1' FROM public.state_licenses WHERE id = v_va), 'VA kept';
  ASSERT (SELECT count(*) FROM public.state_licenses WHERE provider_id = v_provider) = 3, 'three licenses';

  -- Documents: one row per file, id and family = upload id, version 1.
  ASSERT (SELECT count(*) FROM public.provider_documents WHERE provider_id = v_provider) = 3, 'three documents';
  ASSERT (SELECT doc_type = 'cv' AND document_family_id = v_cv AND version_number = 1 AND expiration_date IS NULL
                 AND file_name = 'cv.pdf' AND org_id = v_org
                 AND file_path = format('org/%s/provider/%s/%s/1/cv.pdf', v_org, v_provider, v_cv)
            FROM public.provider_documents WHERE id = v_cv), 'cv row';
  ASSERT (SELECT doc_type = 'state_license' AND expiration_date = '2028-01-31'
            FROM public.provider_documents WHERE id = v_lic), 'license copy takes her NC expiry';
  ASSERT (SELECT doc_type = 'coi' AND expiration_date = '2027-06-30'
            FROM public.provider_documents WHERE id = v_coi), 'coi keeps its date';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_documents WHERE id = v_stale), 'removed upload not copied';

  -- Audit: the provider row carries only what changed, the staff phone as before.
  SELECT jsonb_build_object('before', before, 'after', after) INTO v_audit FROM public.audit_log
   WHERE entity_type = 'provider' AND entity_id = v_provider AND action_type = 'UPDATE'
     AND description = 'Provider record updated from the onboarding form';
  ASSERT v_audit->'before'->>'phone' = '(704) 555-0999' AND v_audit->'after'->>'phone' = '(704) 555-0100'
     AND v_audit->'before'->>'last_name' = 'Rao' AND NOT (v_audit->'after') ? 'first_name'
     AND NOT (v_audit->'after') ? 'email' AND NOT (v_audit->'after') ? 'ssn_last4'
     AND jsonb_array_length(v_audit->'after'->'state_licenses') = 2
     AND v_audit->'before'->'state_licenses'->0->>'license_number' = 'PT-1',
    format('provider audit: %s', v_audit);
  ASSERT (SELECT count(*) FROM public.audit_log WHERE org_id = v_org AND entity_type = 'provider_document'
             AND action_type = 'CREATE') = 3, 'one CREATE per document';
  ASSERT (SELECT count(*) FROM public.audit_log WHERE entity_type = 'provider_onboarding' AND entity_id = v_journey
             AND description = 'Provider submitted the onboarding form') = 1, 'journey audit';
  ASSERT (SELECT submitted_at IS NOT NULL FROM public.provider_onboardings WHERE id = v_journey), 'submitted_at';
  ASSERT (public.read_intake_state('sub-sess-a', 'sub-link-a')->>'submitted')::boolean, 'state says submitted';

  -- A retry converges: nothing written again, nothing to send.
  r := public.submit_provider_intake('sub-sess-a', 'sub-link-a', 1, v_docs);
  ASSERT r = jsonb_build_object('result', 'already_submitted'), format('retry: %s', r);
  ASSERT (SELECT count(*) FROM public.provider_documents WHERE provider_id = v_provider) = 3, 'documents once';
  ASSERT (SELECT count(*) FROM public.audit_log WHERE org_id = v_org AND entity_type = 'provider_document') = 3,
    'no second document audit';
  ASSERT public.save_intake_draft('sub-sess-a', 'sub-link-a', v_answers, 'documents', 1)->>'result' = 'closed',
    'the form is closed after Submit';

  -- Help after Submit: a note in a plain sentence and last_help_at; a second
  -- request within 60 seconds is a no-op.
  r := public.request_intake_help('sub-sess-a', 'sub-link-a', 'help', NULL);
  ASSERT r->>'result' = 'requested' AND (r->>'provider_id')::uuid = v_provider
     AND r->>'practice_name' = 'Smoke Submit', format('help: %s', r);
  ASSERT (SELECT count(*) FROM public.notes WHERE entity_type = 'provider' AND entity_id = v_provider
             AND org_id = v_org AND author_id IS NULL
             AND content = 'Asked for help from the onboarding form.') = 1, 'help note';
  ASSERT (SELECT last_help_at IS NOT NULL FROM public.provider_onboardings WHERE id = v_journey), 'last_help_at';
  ASSERT public.request_intake_help('sub-sess-a', 'sub-link-a', 'fix', 'npi') = jsonb_build_object('result', 'recent'),
    'a double click is a no-op';
  ASSERT (SELECT count(*) FROM public.notes WHERE entity_id = v_provider) = 1, 'no second note';
  UPDATE public.provider_onboardings SET last_help_at = now() - interval '61 seconds' WHERE id = v_journey;
  ASSERT public.request_intake_help('sub-sess-a', 'sub-link-a', 'fix', 'date_of_birth')->>'result' = 'requested',
    'after a minute she can ask again';
  ASSERT (SELECT count(*) FROM public.notes WHERE entity_id = v_provider
             AND content = 'Says the date of birth on file is wrong.') = 1, 'fix note names the field, never a value';
  ASSERT (SELECT count(*) FROM public.audit_log WHERE org_id = v_org AND entity_type = 'note'
             AND action_type = 'CREATE') = 2, 'one audit row per help request';
  ASSERT public.request_intake_help('sub-sess-a', 'sub-link-nope', 'help', NULL) IS NULL, 'help under another link';
  BEGIN
    PERFORM public.request_intake_help('sub-sess-a', 'sub-link-a', 'fix', 'email');
    RAISE EXCEPTION 'an unknown field was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  -- A re-invited provider: NPI and date of birth locked. Even a draft that
  -- carries them (written some other way) changes neither.
  INSERT INTO public.providers (org_id, first_name, last_name, email, npi, date_of_birth, status, group_id)
    VALUES (v_org, 'Priya', 'Shah', 'priya.submit@example.test', '1234567893', '1985-07-01', 'active', v_group)
    RETURNING id INTO v_locked_provider;
  INSERT INTO public.provider_group_assignments (org_id, provider_id, group_id, is_primary)
    VALUES (v_org, v_locked_provider, v_group, true);
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_locked_provider, 'sub-link-b', now() + interval '30 days');
  v_locked_journey := (r->>'onboarding_id')::uuid;
  ASSERT (SELECT locked_fields = ARRAY['npi', 'date_of_birth'] FROM public.provider_onboardings WHERE id = v_locked_journey),
    'locks';
  ASSERT (public.issue_intake_code('sub-link-b', 'sub-code-b')->>'send')::boolean, 'code b';
  ASSERT public.verify_intake_code('sub-link-b', 'sub-code-b', 'sub-sess-b', now() + interval '2 hours') = 'ok', 'session b';
  ASSERT public.submit_provider_intake('sub-sess-a', 'sub-link-b', 0, '[]') IS NULL, 'her session under his link';
  PERFORM public.sign_intake_consent('sub-sess-b', 'sub-link-b', 'Priya Shah', 1);
  PERFORM public.save_intake_draft('sub-sess-b', 'sub-link-b', jsonb_build_object('firstName', 'Priya', 'mobile', '7045550111'),
                                   'documents', 0);
  UPDATE public.provider_intake_drafts
     SET answers = answers || jsonb_build_object('npi', '1730195835', 'dateOfBirth', '2001-01-01')
   WHERE onboarding_id = v_locked_journey;
  r := public.submit_provider_intake('sub-sess-b', 'sub-link-b', 1, '[]');
  ASSERT r->>'result' = 'submitted', format('locked submit: %s', r);
  ASSERT (SELECT npi = '1234567893' AND date_of_birth = '1985-07-01' AND phone = '7045550111'
                 AND email = 'priya.submit@example.test' AND status = 'active'
            FROM public.providers WHERE id = v_locked_provider), 'locked fields untouched, the rest merged';
  ASSERT (SELECT NOT (after ? 'npi') AND NOT (after ? 'date_of_birth') AND NOT (after ? 'first_name')
                 AND after = jsonb_build_object('phone', '7045550111')
            FROM public.audit_log WHERE entity_type = 'provider' AND entity_id = v_locked_provider
             AND description = 'Provider record updated from the onboarding form'), 'only the phone changed';

  -- An NPI that is another provider's in the org: refused, nothing written.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Dev', 'last_name', 'Patel', 'email', 'dev.submit@example.test', 'group_id', v_group),
    'sub-link-c', now() + interval '30 days');
  v_taken_provider := (r->>'provider_id')::uuid;
  v_taken_journey := (r->>'onboarding_id')::uuid;
  ASSERT (public.issue_intake_code('sub-link-c', 'sub-code-c')->>'send')::boolean, 'code c';
  ASSERT public.verify_intake_code('sub-link-c', 'sub-code-c', 'sub-sess-c', now() + interval '2 hours') = 'ok', 'session c';
  PERFORM public.sign_intake_consent('sub-sess-c', 'sub-link-c', 'Dev Patel', 1);
  PERFORM public.save_intake_draft('sub-sess-c', 'sub-link-c',
    jsonb_build_object('lastName', 'Patel-Lee', 'npi', '1234567893'), 'documents', 0);
  r := public.submit_provider_intake('sub-sess-c', 'sub-link-c', 1, '[]');
  ASSERT r = jsonb_build_object('result', 'npi_in_use'), format('npi in use: %s', r);
  ASSERT (SELECT npi IS NULL AND last_name = 'Patel' FROM public.providers WHERE id = v_taken_provider), 'nothing merged';
  ASSERT (SELECT submitted_at IS NULL FROM public.provider_onboardings WHERE id = v_taken_journey), 'not submitted';
  -- Her own NPI already on her record is no conflict.
  UPDATE public.provider_intake_drafts SET answers = answers || '{"npi": "1588667638"}' WHERE onboarding_id = v_taken_journey;
  UPDATE public.providers SET npi = '1588667638' WHERE id = v_taken_provider;
  ASSERT public.submit_provider_intake('sub-sess-c', 'sub-link-c', 1, '[]')->>'result' = 'submitted', 'own npi';

  -- An admitted journey is closed to Submit and to help; a cancelled one's
  -- session reads nothing.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Sam', 'last_name', 'Lee', 'email', 'sam.submit@example.test', 'group_id', v_group),
    'sub-link-d', now() + interval '30 days');
  v_admitted_journey := (r->>'onboarding_id')::uuid;
  ASSERT (public.issue_intake_code('sub-link-d', 'sub-code-d')->>'send')::boolean, 'code d';
  ASSERT public.verify_intake_code('sub-link-d', 'sub-code-d', 'sub-sess-d', now() + interval '2 hours') = 'ok', 'session d';
  UPDATE public.provider_onboardings SET admitted_at = now() WHERE id = v_admitted_journey;
  ASSERT public.submit_provider_intake('sub-sess-d', 'sub-link-d', 0, '[]') = jsonb_build_object('result', 'closed'),
    'admitted submit';
  ASSERT public.request_intake_help('sub-sess-d', 'sub-link-d', 'help', NULL) = jsonb_build_object('result', 'closed'),
    'admitted help';
  UPDATE public.provider_onboardings SET admitted_at = NULL, cancelled_at = now() WHERE id = v_admitted_journey;
  ASSERT public.submit_provider_intake('sub-sess-d', 'sub-link-d', 0, '[]') IS NULL, 'cancelled submit';
  ASSERT public.request_intake_help('sub-sess-d', 'sub-link-d', 'help', NULL) IS NULL, 'cancelled help';

  BEGIN
    PERFORM public.submit_provider_intake('sub-sess-a', 'sub-link-a', 1, '{}');
    RAISE EXCEPTION 'documents that are not a list were accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  -- Grants: only service_role calls them.
  ASSERT has_function_privilege('service_role', 'public.submit_provider_intake(text, text, int, jsonb)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.request_intake_help(text, text, text, text)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.read_intake_state(text, text)', 'EXECUTE'), 'service_role';
  ASSERT NOT has_function_privilege('authenticated', 'public.submit_provider_intake(text, text, int, jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.submit_provider_intake(text, text, int, jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.request_intake_help(text, text, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.request_intake_help(text, text, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.read_intake_state(text, text)', 'EXECUTE'), 'no client calls';

  RAISE NOTICE 'provider intake submit smoke: all checks passed';
END;
$$;

ROLLBACK;
