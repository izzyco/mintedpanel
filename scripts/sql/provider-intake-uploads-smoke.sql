-- Smoke test for 20261106230000_provider_intake_uploads.sql. Run it after the
-- migration is applied, as the postgres user (the owner of the tables and the
-- SECURITY DEFINER functions: on a local `supabase start`, or the SQL editor
-- on staging):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/provider-intake-uploads-smoke.sql
--
-- Everything runs in one transaction and is rolled back, so it leaves no rows.
-- It touches no Storage object: the routes do that. Hashes are plain strings
-- here: the RPCs only compare them. Any failed check raises and stops the
-- script.
BEGIN;

DO $$
DECLARE
  v_org uuid;
  v_other_org uuid;
  v_group uuid;
  v_other_group uuid;
  v_actor uuid := gen_random_uuid();
  r jsonb;
  v_journey uuid;
  v_other_journey uuid;
  v_cv uuid;
  v_cv_path text;
  v_cv_2 uuid;
  v_coi uuid;
  v_other_upload uuid;
  v_first_finalized timestamptz;
  v_state text;
BEGIN
  INSERT INTO public.organizations (name) VALUES ('Smoke Uploads') RETURNING id INTO v_org;
  INSERT INTO public.organizations (name) VALUES ('Smoke Uploads Other') RETURNING id INTO v_other_org;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group') RETURNING id INTO v_group;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_other_org, 'Other Group') RETURNING id INTO v_other_group;

  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Anita', 'last_name', 'Rao', 'email', 'anita.uploads@example.test', 'group_id', v_group),
    'up-link-a', now() + interval '30 days');
  v_journey := (r->>'onboarding_id')::uuid;
  ASSERT (public.issue_intake_code('up-link-a', 'up-code-a')->>'send')::boolean, 'code a';
  ASSERT public.verify_intake_code('up-link-a', 'up-code-a', 'up-sess-a', now() + interval '2 hours') = 'ok', 'session a';

  r := public.create_provider_intake_invite(v_other_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Other', 'last_name', 'Person', 'email', 'other.uploads@example.test',
    'group_id', v_other_group), 'up-link-b', now() + interval '30 days');
  v_other_journey := (r->>'onboarding_id')::uuid;
  ASSERT (public.issue_intake_code('up-link-b', 'up-code-b')->>'send')::boolean, 'code b';
  ASSERT public.verify_intake_code('up-link-b', 'up-code-b', 'up-sess-b', now() + interval '2 hours') = 'ok', 'session b';

  ASSERT public.read_intake_state('up-sess-a', 'up-link-a')->'uploads' = '[]'::jsonb, 'no uploads yet';

  -- Begin: a pending row at a path under her journey, not shown until finished.
  r := public.begin_intake_upload('up-sess-a', 'up-link-a', 'cv', 'cv', 'Anita_Rao_CV.pdf', 2048,
                                  'application/pdf', NULL);
  ASSERT r->>'result' = 'started' AND r->'replaced_object_path' = 'null'::jsonb, format('begin cv: %s', r);
  v_cv := (r->>'upload_id')::uuid;
  v_cv_path := r->>'object_path';
  ASSERT v_cv_path = format('org/%s/onboarding/%s/%s/Anita_Rao_CV.pdf', v_org, v_journey, v_cv),
    format('path: %s', v_cv_path);
  ASSERT (SELECT finalized_at IS NULL AND removed_at IS NULL AND doc_type = 'cv' AND org_id = v_org
            FROM public.provider_intake_uploads WHERE id = v_cv), 'pending row';
  ASSERT public.read_intake_state('up-sess-a', 'up-link-a')->'uploads' = '[]'::jsonb, 'pending is not shown';

  r := public.read_intake_upload('up-sess-a', 'up-link-a', v_cv);
  ASSERT r->>'result' = 'found' AND r->>'object_path' = v_cv_path
     AND r->>'content_type' = 'application/pdf' AND r->'finalized' = 'false'::jsonb
     AND r->'upload' = jsonb_build_object('id', v_cv, 'slot_key', 'cv', 'doc_type', 'cv',
                         'file_name', 'Anita_Rao_CV.pdf', 'size_bytes', 2048, 'expires_on', NULL),
    format('read pending: %s', r);

  -- Finish: only with the declared size, and finishing twice changes nothing.
  BEGIN
    PERFORM public.finish_intake_upload('up-sess-a', 'up-link-a', v_cv, 2049);
    RAISE EXCEPTION 'a wrong size finished';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  ASSERT public.finish_intake_upload('up-sess-a', 'up-link-a', v_cv, 2048) = jsonb_build_object('result', 'finalized'),
    'finish cv';
  SELECT finalized_at INTO v_first_finalized FROM public.provider_intake_uploads WHERE id = v_cv;
  ASSERT v_first_finalized IS NOT NULL, 'finalized_at set';
  ASSERT public.finish_intake_upload('up-sess-a', 'up-link-a', v_cv, 2048) = jsonb_build_object('result', 'finalized'),
    'finish twice';
  ASSERT (SELECT finalized_at = v_first_finalized FROM public.provider_intake_uploads WHERE id = v_cv),
    'the first finalized_at stays';
  r := public.read_intake_state('up-sess-a', 'up-link-a');
  ASSERT r->'uploads' = jsonb_build_array(jsonb_build_object('id', v_cv, 'slot_key', 'cv', 'doc_type', 'cv',
           'file_name', 'Anita_Rao_CV.pdf', 'size_bytes', 2048, 'expires_on', NULL))
     AND r ? 'draft' AND r ? 'logins_on_file' AND r ? 'consented' AND r ? 'locked_fields'
     AND r ? 'ssn_last4' AND r ? 'record' AND r ? 'submitted',
    format('state shows the cv and keeps every key: %s', r);

  -- Replace: a new upload in the slot removes the old one and hands back its path.
  r := public.begin_intake_upload('up-sess-a', 'up-link-a', 'cv', 'cv', 'cv-2.png', 4096, 'image/png', NULL);
  ASSERT r->>'result' = 'started' AND r->>'replaced_object_path' = v_cv_path, format('replace: %s', r);
  v_cv_2 := (r->>'upload_id')::uuid;
  ASSERT (SELECT removed_at IS NOT NULL FROM public.provider_intake_uploads WHERE id = v_cv), 'old cv removed';
  ASSERT public.read_intake_state('up-sess-a', 'up-link-a')->'uploads' = '[]'::jsonb,
    'the replaced cv is gone and the new one is pending';
  ASSERT public.read_intake_upload('up-sess-a', 'up-link-a', v_cv)->>'result' = 'not_found', 'old cv not found';
  ASSERT public.finish_intake_upload('up-sess-a', 'up-link-a', v_cv, 2048)->>'result' = 'not_found',
    'a removed upload cannot finish';
  PERFORM public.finish_intake_upload('up-sess-a', 'up-link-a', v_cv_2, 4096);
  ASSERT jsonb_array_length(public.read_intake_state('up-sess-a', 'up-link-a')->'uploads') = 1, 'one cv shown';

  -- One live upload per slot, even written by hand.
  BEGIN
    INSERT INTO public.provider_intake_uploads
      (id, org_id, onboarding_id, slot_key, doc_type, file_name, size_bytes, content_type, object_path)
    SELECT x.id, v_org, v_journey, 'cv', 'cv', 'x.pdf', 1, 'application/pdf',
           format('org/%s/onboarding/%s/%s/x.pdf', v_org, v_journey, x.id)
      FROM (SELECT gen_random_uuid() AS id) x;
    RAISE EXCEPTION 'a second live cv was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  -- And the path always sits under its own journey and id.
  BEGIN
    INSERT INTO public.provider_intake_uploads
      (org_id, onboarding_id, slot_key, doc_type, file_name, size_bytes, content_type, object_path)
      VALUES (v_org, v_journey, 'diploma', 'diploma', 'x.pdf', 1, 'application/pdf',
              format('org/%s/onboarding/%s/elsewhere/x.pdf', v_org, v_other_journey));
    RAISE EXCEPTION 'a path outside the journey was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Remove: the path comes back for the route to delete, and again on a retry.
  r := public.remove_intake_upload('up-sess-a', 'up-link-a', v_cv_2);
  ASSERT r->>'result' = 'removed' AND r->>'object_path' LIKE format('org/%s/onboarding/%s/%s/cv-2.png', v_org, v_journey, v_cv_2),
    format('remove: %s', r);
  ASSERT public.read_intake_state('up-sess-a', 'up-link-a')->'uploads' = '[]'::jsonb, 'removed is not shown';
  ASSERT public.remove_intake_upload('up-sess-a', 'up-link-a', v_cv_2) = r, 'removing again answers the same';
  ASSERT public.remove_intake_upload('up-sess-a', 'up-link-a', gen_random_uuid())->>'result' = 'not_found',
    'unknown id';
  ASSERT (SELECT count(*) FROM public.provider_intake_uploads WHERE onboarding_id = v_journey) = 2,
    'removed rows stay as the trail';

  -- Expiry: a COI's only.
  r := public.begin_intake_upload('up-sess-a', 'up-link-a', 'coi', 'coi', 'coi.jpg', 10485760, 'image/jpeg',
                                  DATE '2027-06-30');
  v_coi := (r->>'upload_id')::uuid;
  ASSERT r->>'result' = 'started' AND (SELECT expires_on = DATE '2027-06-30'
            FROM public.provider_intake_uploads WHERE id = v_coi), 'a coi begins with its date, at exactly 10 MB';
  PERFORM public.finish_intake_upload('up-sess-a', 'up-link-a', v_coi, 10485760);
  ASSERT public.set_intake_upload_expiry('up-sess-a', 'up-link-a', v_coi, DATE '2028-01-31')
         = jsonb_build_object('result', 'saved'), 'set coi expiry';
  ASSERT public.read_intake_state('up-sess-a', 'up-link-a')->'uploads'->0->>'expires_on' = '2028-01-31',
    'state shows the coi date';
  ASSERT public.set_intake_upload_expiry('up-sess-a', 'up-link-a', v_coi, NULL)->>'result' = 'saved',
    'clear the coi date';
  ASSERT (SELECT expires_on IS NULL FROM public.provider_intake_uploads WHERE id = v_coi), 'cleared';
  r := public.begin_intake_upload('up-sess-a', 'up-link-a', 'license:NC', 'state_license', 'nc.pdf', 10,
                                  'application/pdf', NULL);
  ASSERT r->>'result' = 'started', format('license slot: %s', r);
  ASSERT public.set_intake_upload_expiry('up-sess-a', 'up-link-a', (r->>'upload_id')::uuid, DATE '2027-01-01')
         = jsonb_build_object('result', 'not_dated'), 'a license copy takes no date of its own';
  ASSERT (SELECT expires_on IS NULL FROM public.provider_intake_uploads WHERE id = (r->>'upload_id')::uuid),
    'not_dated writes nothing';

  -- Refused before anything is written: a kind that isn't the slot's, an
  -- unknown slot, over 10 MB, another type, an unsafe name, a date on a CV.
  FOR r IN SELECT * FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('slot', 'cv', 'kind', 'diploma', 'name', 'a.pdf', 'size', 1, 'type', 'application/pdf'),
    jsonb_build_object('slot', 'license:NC', 'kind', 'cv', 'name', 'a.pdf', 'size', 1, 'type', 'application/pdf'),
    jsonb_build_object('slot', 'license:nc', 'kind', 'state_license', 'name', 'a.pdf', 'size', 1, 'type', 'application/pdf'),
    jsonb_build_object('slot', 'dea', 'kind', 'dea', 'name', 'a.pdf', 'size', 1, 'type', 'application/pdf'),
    jsonb_build_object('slot', 'diploma', 'kind', 'diploma', 'name', 'a.pdf', 'size', 10485761, 'type', 'application/pdf'),
    jsonb_build_object('slot', 'diploma', 'kind', 'diploma', 'name', 'a.pdf', 'size', 0, 'type', 'application/pdf'),
    jsonb_build_object('slot', 'diploma', 'kind', 'diploma', 'name', 'a.txt', 'size', 1, 'type', 'text/plain'),
    jsonb_build_object('slot', 'diploma', 'kind', 'diploma', 'name', '../a.pdf', 'size', 1, 'type', 'application/pdf'),
    jsonb_build_object('slot', 'cv', 'kind', 'cv', 'name', 'a.pdf', 'size', 1, 'type', 'application/pdf',
                       'expires', '2027-01-01')))
  LOOP
    BEGIN
      PERFORM public.begin_intake_upload('up-sess-a', 'up-link-a', r->>'slot', r->>'kind', r->>'name',
                                         (r->>'size')::bigint, r->>'type', (r->>'expires')::date);
      v_state := 'accepted';
    EXCEPTION WHEN invalid_parameter_value THEN
      v_state := 'refused';
    END;
    ASSERT v_state = 'refused', format('refused: %s', r);
  END LOOP;
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_uploads
                      WHERE onboarding_id = v_journey AND slot_key IN ('diploma', 'dea')), 'refusals wrote nothing';
  ASSERT (SELECT count(*) FROM public.provider_intake_uploads
           WHERE onboarding_id = v_journey AND slot_key = 'cv' AND removed_at IS NULL) = 0,
    'the cv slot is still empty';

  -- Another link: nothing begun, read, finished, removed or dated for anyone
  -- else, and an upload id from another journey is not found.
  ASSERT public.begin_intake_upload('up-sess-a', 'up-link-b', 'cv', 'cv', 'a.pdf', 1, 'application/pdf', NULL) IS NULL,
    'begin under another link';
  ASSERT public.begin_intake_upload('up-sess-b', 'up-link-a', 'cv', 'cv', 'a.pdf', 1, 'application/pdf', NULL) IS NULL,
    'org b session, org a link';
  ASSERT public.read_intake_state('up-sess-a', 'up-link-b') IS NULL, 'state under another link';
  r := public.begin_intake_upload('up-sess-b', 'up-link-b', 'cv', 'cv', 'b.pdf', 1, 'application/pdf', NULL);
  v_other_upload := (r->>'upload_id')::uuid;
  ASSERT public.read_intake_upload('up-sess-a', 'up-link-b', v_other_upload) IS NULL, 'read under another link';
  ASSERT public.finish_intake_upload('up-sess-a', 'up-link-b', v_other_upload, 1) IS NULL, 'finish under another link';
  ASSERT public.remove_intake_upload('up-sess-a', 'up-link-b', v_other_upload) IS NULL, 'remove under another link';
  ASSERT public.set_intake_upload_expiry('up-sess-a', 'up-link-b', v_other_upload, NULL) IS NULL,
    'date under another link';
  ASSERT public.read_intake_upload('up-sess-a', 'up-link-a', v_other_upload)->>'result' = 'not_found',
    'another journey''s upload id, read';
  ASSERT public.finish_intake_upload('up-sess-a', 'up-link-a', v_other_upload, 1)->>'result' = 'not_found',
    'another journey''s upload id, finish';
  ASSERT public.remove_intake_upload('up-sess-a', 'up-link-a', v_other_upload)->>'result' = 'not_found',
    'another journey''s upload id, remove';
  ASSERT (SELECT finalized_at IS NULL AND removed_at IS NULL FROM public.provider_intake_uploads
           WHERE id = v_other_upload), 'org b''s upload untouched';
  ASSERT public.read_intake_state('up-sess-b', 'up-link-b')->'uploads' = '[]'::jsonb, 'org b sees only its own';

  -- Closed once she has submitted: nothing more is begun, finished, removed or dated.
  UPDATE public.provider_onboardings SET submitted_at = now() WHERE id = v_journey;
  ASSERT public.begin_intake_upload('up-sess-a', 'up-link-a', 'other', 'other', 'a.pdf', 1, 'application/pdf', NULL)
         = jsonb_build_object('result', 'closed'), 'closed begin';
  ASSERT public.read_intake_upload('up-sess-a', 'up-link-a', v_coi) = jsonb_build_object('result', 'closed'),
    'closed read';
  ASSERT public.finish_intake_upload('up-sess-a', 'up-link-a', v_coi, 10485760) = jsonb_build_object('result', 'closed'),
    'closed finish';
  ASSERT public.remove_intake_upload('up-sess-a', 'up-link-a', v_coi) = jsonb_build_object('result', 'closed'),
    'closed remove';
  ASSERT public.set_intake_upload_expiry('up-sess-a', 'up-link-a', v_coi, DATE '2030-01-01')
         = jsonb_build_object('result', 'closed'), 'closed date';
  ASSERT (SELECT removed_at IS NULL AND expires_on IS NULL FROM public.provider_intake_uploads WHERE id = v_coi),
    'closed writes nothing';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_uploads WHERE onboarding_id = v_journey AND slot_key = 'other'),
    'closed begins nothing';

  -- A cancelled journey's session reads nothing.
  UPDATE public.provider_onboardings SET cancelled_at = now() WHERE id = v_other_journey;
  ASSERT public.read_intake_upload('up-sess-b', 'up-link-b', v_other_upload) IS NULL, 'cancelled reads nothing';

  -- Deleting a journey takes its rows with it.
  DELETE FROM public.provider_intake_invites WHERE onboarding_id = v_other_journey;
  DELETE FROM public.provider_onboardings WHERE id = v_other_journey;
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_uploads WHERE onboarding_id = v_other_journey),
    'rows cascade with the journey';

  -- Grants: the server reads the table; only the RPCs write it.
  ASSERT has_table_privilege('service_role', 'public.provider_intake_uploads', 'SELECT')
     AND NOT has_table_privilege('service_role', 'public.provider_intake_uploads', 'INSERT')
     AND NOT has_table_privilege('service_role', 'public.provider_intake_uploads', 'UPDATE')
     AND NOT has_table_privilege('service_role', 'public.provider_intake_uploads', 'DELETE')
     AND NOT has_table_privilege('authenticated', 'public.provider_intake_uploads', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.provider_intake_uploads', 'SELECT'), 'table grants';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provider_intake_uploads'::regclass), 'rls on';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'provider_intake_uploads'), 'no policies';
  ASSERT has_function_privilege('service_role',
           'public.begin_intake_upload(text, text, text, text, text, bigint, text, date)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.read_intake_upload(text, text, uuid)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.finish_intake_upload(text, text, uuid, bigint)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.remove_intake_upload(text, text, uuid)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.set_intake_upload_expiry(text, text, uuid, date)', 'EXECUTE'),
    'service_role runs the RPCs';
  ASSERT NOT has_function_privilege('authenticated',
           'public.begin_intake_upload(text, text, text, text, text, bigint, text, date)', 'EXECUTE')
     AND NOT has_function_privilege('anon',
           'public.begin_intake_upload(text, text, text, text, text, bigint, text, date)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.read_intake_upload(text, text, uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.finish_intake_upload(text, text, uuid, bigint)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.remove_intake_upload(text, text, uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.set_intake_upload_expiry(text, text, uuid, date)', 'EXECUTE'),
    'no client runs them';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'block_writes_when_offboarded'
                    AND tgrelid = 'public.provider_intake_uploads'::regclass), 'offboarded freeze';

  -- The holding bucket: private, its limits, and no client policy names it.
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    ASSERT (SELECT NOT public AND file_size_limit = 26214400
                   AND allowed_mime_types = ARRAY['application/pdf', 'image/png', 'image/jpeg']
              FROM storage.buckets WHERE id = 'provider-intake-uploads'), 'bucket';
    ASSERT NOT EXISTS (SELECT 1 FROM pg_policies
                        WHERE schemaname = 'storage' AND tablename = 'objects'
                          AND (coalesce(qual, '') LIKE '%provider-intake-uploads%'
                               OR coalesce(with_check, '') LIKE '%provider-intake-uploads%')),
      'no storage policy names the bucket';
  END IF;

  RAISE NOTICE 'provider intake uploads smoke: all checks passed';
END;
$$;

ROLLBACK;
