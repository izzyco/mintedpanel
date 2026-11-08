-- Provider onboarding R1, cycle 5: Submit puts her answers and documents on
-- her record, and a help request reaches staff.
--
--   read_intake_state        also returns org_id, provider_id and
--                            held_object_paths (every object her journey
--                            put in the holding bucket), which only the
--                            submit route reads: it builds the vault paths
--                            and deletes the held files after Submit
--   submit_provider_intake   one transaction: her answers onto providers and
--                            state_licenses, her documents into
--                            provider_documents, submitted_at, audit rows
--   request_intake_help      a provider note and last_help_at
--
-- Both RPCs resolve the journey from the session and link hashes
-- (_intake_session_context), never from an id the browser sends, and are
-- EXECUTE-granted to service_role alone. No new table.
--
-- Additive and idempotent. Applying to hosted is an OPERATOR task, after
-- 20261106230000. Verify the OBJECTS:
--   SELECT count(*) FROM pg_proc WHERE proname IN ('submit_provider_intake',
--     'request_intake_help');                                        -- 2
--   SELECT pg_get_functiondef('public.read_intake_state(text, text)'::regprocedure)
--     LIKE '%held_object_paths%';                                     -- t
--   then run scripts/sql/provider-intake-submit-smoke.sql.

-- ---------------------------------------------------------------------------
-- read_intake_state: as in 20261106230000, plus org_id, provider_id and
-- held_object_paths: the path of every upload of her journey, removed or
-- not, so a file a failed delete left behind is cleared too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.read_intake_state(p_session_hash text, p_token_hash text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'practice_name', org.name,
           'email', i.email,
           'org_id', c.org_id,
           'provider_id', c.provider_id,
           'record', jsonb_build_object(
             'firstName', p.first_name,
             'lastName', p.last_name,
             'npi', p.npi,
             'taxonomyCode', p.taxonomy_code,
             'dateOfBirth', p.date_of_birth,
             'caqhId', p.caqh_id,
             'mobile', p.phone,
             'homeStreet', p.home_street,
             'homeCity', p.home_city,
             'homeState', p.home_state,
             'homeZip', p.home_zip,
             'licenses', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'state', l.state,
                        'number', l.license_number,
                        'expiresOn', l.expiration_date)
                      ORDER BY l.state, l.created_at, l.id)
                 FROM public.state_licenses l
                WHERE l.provider_id = p.id AND l.org_id = c.org_id), '[]'::jsonb)),
           'locked_fields', to_jsonb(o.locked_fields),
           'ssn_last4', p.ssn_last4,
           'logins_on_file', jsonb_build_object(
             'caqh', EXISTS (
               SELECT 1 FROM public.provider_portal_credentials pc
                WHERE pc.provider_id = p.id AND pc.org_id = c.org_id AND pc.portal = 'caqh'),
             'pecos', EXISTS (
               SELECT 1 FROM public.provider_portal_credentials pc
                WHERE pc.provider_id = p.id AND pc.org_id = c.org_id AND pc.portal = 'pecos')),
           'consented', o.consented_at IS NOT NULL,
           'consent_text_version', (
             SELECT k.text_version FROM public.provider_intake_consents k
              WHERE k.onboarding_id = o.id
              ORDER BY k.signed_at DESC, k.id DESC
              LIMIT 1),
           'draft', (
             SELECT jsonb_build_object(
                      'answers', d.answers,
                      'step', d.step,
                      'version', d.version,
                      'updated_at', d.updated_at)
               FROM public.provider_intake_drafts d
              WHERE d.onboarding_id = o.id),
           'uploads', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', u.id,
                      'slot_key', u.slot_key,
                      'doc_type', u.doc_type,
                      'file_name', u.file_name,
                      'size_bytes', u.size_bytes,
                      'expires_on', u.expires_on)
                    ORDER BY u.created_at, u.id)
               FROM public.provider_intake_uploads u
              WHERE u.onboarding_id = o.id AND u.removed_at IS NULL AND u.finalized_at IS NOT NULL),
             '[]'::jsonb),
           'held_object_paths', coalesce((
             SELECT jsonb_agg(u.object_path ORDER BY u.created_at, u.id)
               FROM public.provider_intake_uploads u
              WHERE u.onboarding_id = o.id), '[]'::jsonb),
           'submitted', o.submitted_at IS NOT NULL)
    FROM public._intake_session_context(p_session_hash, p_token_hash) c
    JOIN public.provider_intake_invites i ON i.id = c.invite_id
    JOIN public.provider_onboardings o ON o.id = c.onboarding_id
    JOIN public.providers p ON p.id = c.provider_id
    JOIN public.organizations org ON org.id = c.org_id;
$$;

-- ---------------------------------------------------------------------------
-- submit_provider_intake: her saved answers and documents onto her record, in
-- one transaction with the journey row locked. Results:
--   null               the session is not live under this link
--   submitted          written; first_time is true, and the result carries
--                      what the emails need (practice_name, first_name, the
--                      invited email) plus onboarding_id and provider_id
--   already_submitted  submitted before; nothing written, nothing to send
--   conflict           p_expected_version is not the saved draft version (no
--                      draft is version 0); returns the saved version
--   npi_in_use         the NPI she entered is another provider's in her org;
--                      nothing written. Records are never merged here.
--   closed             the journey is admitted or cancelled
-- A journey without her signed consent raises (the route checks it first).
--
-- The merge (decision 3, D7, D11): each answer she gave overwrites its
-- providers column, except a field locked on the journey. Email and status
-- are never touched; mobile is providers.phone. Licenses (D6), each answer
-- row as she saw it (her values, else the state's newest license, as
-- draftFromState shows it): a license with that number in that state takes
-- the expiry; otherwise the state's newest license, once, takes the number
-- and expiry; otherwise a new license. A number or expiry change returns the
-- license to unverified, as a staff renewal does. No license is deleted.
--
-- p_documents: [{ upload_id, file_path }], one per held file whose slot is
-- still on her form. The route has already copied each into the
-- provider-documents bucket at file_path, which must be the vault path for
-- that upload (family = upload id, version 1). Each becomes a
-- provider_documents row whose id is the upload id. A COI keeps its expiry;
-- a license copy takes the expiry of that state's license.
--
-- Audit: one UPDATE on the provider with before and after of the changed
-- columns and licenses only (never the SSN, a password or a username), one
-- CREATE per document, and one UPDATE on the journey.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_provider_intake(
  p_session_hash text,
  p_token_hash text,
  p_expected_version int,
  p_documents jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx record;
  v_journey public.provider_onboardings%ROWTYPE;
  v_provider public.providers%ROWTYPE;
  v_answers jsonb;
  v_version int;
  v_npi text;
  v_wanted jsonb;
  v_current jsonb;
  v_before jsonb;
  v_after jsonb;
  v_answer jsonb;
  v_state text;
  v_number text;
  v_expires date;
  v_newest public.state_licenses%ROWTYPE;
  v_license public.state_licenses%ROWTYPE;
  v_touched uuid[] := '{}';
  v_license_expiry jsonb := '{}';
  v_licenses_before jsonb := '[]';
  v_licenses_after jsonb := '[]';
  v_doc jsonb;
  v_upload public.provider_intake_uploads%ROWTYPE;
  v_doc_expires date;
  v_doc_id uuid;
BEGIN
  IF jsonb_typeof(p_documents) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_documents';
  END IF;

  SELECT * INTO v_ctx FROM public._intake_session_context(p_session_hash, p_token_hash);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_journey FROM public.provider_onboardings WHERE id = v_ctx.onboarding_id FOR UPDATE;
  IF v_journey.submitted_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'already_submitted');
  END IF;
  IF v_journey.admitted_at IS NOT NULL OR v_journey.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'closed');
  END IF;
  -- The route checks this first; nothing she hasn't consented to is written.
  IF v_journey.consented_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'not_consented';
  END IF;

  SELECT d.answers, d.version INTO v_answers, v_version
    FROM public.provider_intake_drafts d WHERE d.onboarding_id = v_journey.id;
  v_version := coalesce(v_version, 0);
  IF p_expected_version IS DISTINCT FROM v_version THEN
    RETURN jsonb_build_object('result', 'conflict', 'version', v_version);
  END IF;
  -- save_intake_draft already drops locked keys; dropping them again here
  -- keeps a lock a lock even for a draft written some other way.
  v_answers := coalesce(v_answers, '{}'::jsonb) - ARRAY(
    SELECT CASE f WHEN 'date_of_birth' THEN 'dateOfBirth' ELSE f END
      FROM unnest(v_journey.locked_fields) f);

  -- NO KEY UPDATE: an invite adding a group to her record (FOR KEY SHARE on
  -- this row) doesn't wait on Submit, so the NPI lock below can't deadlock.
  SELECT * INTO v_provider FROM public.providers
   WHERE id = v_ctx.provider_id AND org_id = v_ctx.org_id
   FOR NO KEY UPDATE;

  v_npi := nullif(btrim(v_answers->>'npi'), '');
  IF v_npi IS NOT NULL AND v_npi IS DISTINCT FROM v_provider.npi THEN
    -- The invite's NPI lock, so an invite with this NPI and this Submit
    -- can't both miss each other.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_ctx.org_id::text || ':npi:' || v_npi, 0));
    IF EXISTS (
      SELECT 1 FROM public.providers p
       WHERE p.org_id = v_ctx.org_id AND p.npi = v_npi AND p.id <> v_provider.id
    ) THEN
      RETURN jsonb_build_object('result', 'npi_in_use');
    END IF;
  END IF;

  v_wanted := jsonb_strip_nulls(jsonb_build_object(
    'first_name', nullif(btrim(v_answers->>'firstName'), ''),
    'last_name', nullif(btrim(v_answers->>'lastName'), ''),
    'npi', v_npi,
    'taxonomy_code', nullif(btrim(v_answers->>'taxonomyCode'), ''),
    'date_of_birth', nullif(btrim(v_answers->>'dateOfBirth'), ''),
    'caqh_id', nullif(btrim(v_answers->>'caqhId'), ''),
    'phone', nullif(btrim(v_answers->>'mobile'), ''),
    'home_street', nullif(btrim(v_answers->>'homeStreet'), ''),
    'home_city', nullif(btrim(v_answers->>'homeCity'), ''),
    'home_state', upper(nullif(btrim(v_answers->>'homeState'), '')),
    'home_zip', nullif(btrim(v_answers->>'homeZip'), '')));
  v_current := jsonb_build_object(
    'first_name', v_provider.first_name,
    'last_name', v_provider.last_name,
    'npi', v_provider.npi,
    'taxonomy_code', v_provider.taxonomy_code,
    'date_of_birth', v_provider.date_of_birth,
    'caqh_id', v_provider.caqh_id,
    'phone', v_provider.phone,
    'home_street', v_provider.home_street,
    'home_city', v_provider.home_city,
    'home_state', v_provider.home_state,
    'home_zip', v_provider.home_zip);
  SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) INTO v_after
    FROM jsonb_each(v_wanted) e
   WHERE v_current->e.key IS DISTINCT FROM e.value;
  SELECT coalesce(jsonb_object_agg(k, v_current->k), '{}'::jsonb) INTO v_before
    FROM jsonb_object_keys(v_after) k;

  IF v_after <> '{}'::jsonb THEN
    UPDATE public.providers SET
      first_name = coalesce(v_after->>'first_name', first_name),
      last_name = coalesce(v_after->>'last_name', last_name),
      npi = coalesce(v_after->>'npi', npi),
      taxonomy_code = coalesce(v_after->>'taxonomy_code', taxonomy_code),
      date_of_birth = coalesce((v_after->>'date_of_birth')::date, date_of_birth),
      caqh_id = coalesce(v_after->>'caqh_id', caqh_id),
      phone = coalesce(v_after->>'phone', phone),
      home_street = coalesce(v_after->>'home_street', home_street),
      home_city = coalesce(v_after->>'home_city', home_city),
      home_state = coalesce(v_after->>'home_state', home_state),
      home_zip = coalesce(v_after->>'home_zip', home_zip),
      updated_at = now()
    WHERE id = v_provider.id;
  END IF;

  FOR v_answer IN
    SELECT e.value FROM jsonb_array_elements(coalesce(v_answers->'licenses', '[]'::jsonb))
      WITH ORDINALITY AS e(value, n)
     ORDER BY e.n
  LOOP
    v_state := upper(nullif(btrim(v_answer->>'state'), ''));
    CONTINUE WHEN v_state IS NULL;

    SELECT * INTO v_newest FROM public.state_licenses l
     WHERE l.provider_id = v_provider.id AND l.org_id = v_ctx.org_id AND l.state = v_state
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT 1;
    v_number := coalesce(nullif(btrim(v_answer->>'number'), ''), v_newest.license_number);
    v_expires := coalesce(nullif(btrim(v_answer->>'expiresOn'), '')::date, v_newest.expiration_date);
    IF v_number IS NULL OR v_expires IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'incomplete_license';
    END IF;

    SELECT * INTO v_license FROM public.state_licenses l
     WHERE l.provider_id = v_provider.id AND l.org_id = v_ctx.org_id
       AND l.state = v_state AND l.license_number = v_number;
    IF v_license.id IS NULL AND v_newest.id IS NOT NULL AND NOT v_newest.id = ANY (v_touched) THEN
      v_license := v_newest;
    END IF;

    IF v_license.id IS NULL THEN
      INSERT INTO public.state_licenses (org_id, provider_id, state, license_number, expiration_date)
        VALUES (v_ctx.org_id, v_provider.id, v_state, v_number, v_expires)
        RETURNING * INTO v_license;
      v_licenses_after := v_licenses_after || jsonb_build_array(jsonb_build_object(
        'id', v_license.id, 'state', v_state, 'license_number', v_number, 'expiration_date', v_expires));
    ELSIF v_license.license_number IS DISTINCT FROM v_number
       OR v_license.expiration_date IS DISTINCT FROM v_expires THEN
      UPDATE public.state_licenses
         SET license_number = v_number,
             expiration_date = v_expires,
             verified_status = 'unverified',
             verified_at = NULL,
             verified_by = NULL
       WHERE id = v_license.id;
      v_licenses_before := v_licenses_before || jsonb_build_array(jsonb_build_object(
        'id', v_license.id, 'state', v_license.state, 'license_number', v_license.license_number,
        'expiration_date', v_license.expiration_date));
      v_licenses_after := v_licenses_after || jsonb_build_array(jsonb_build_object(
        'id', v_license.id, 'state', v_state, 'license_number', v_number, 'expiration_date', v_expires));
    END IF;

    v_touched := v_touched || v_license.id;
    IF NOT v_license_expiry ? v_state THEN
      v_license_expiry := v_license_expiry || jsonb_build_object(v_state, v_expires);
    END IF;
  END LOOP;

  FOR v_doc IN SELECT value FROM jsonb_array_elements(p_documents) LOOP
    SELECT * INTO v_upload FROM public.provider_intake_uploads u
     WHERE u.id = (v_doc->>'upload_id')::uuid
       AND u.onboarding_id = v_journey.id
       AND u.removed_at IS NULL
       AND u.finalized_at IS NOT NULL;
    IF NOT FOUND OR v_doc->>'file_path' IS DISTINCT FROM format(
         'org/%s/provider/%s/%s/1/%s', v_ctx.org_id, v_ctx.provider_id, v_upload.id, v_upload.file_name) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_document';
    END IF;

    v_doc_expires := NULL;
    IF v_upload.doc_type = 'coi' THEN
      v_doc_expires := v_upload.expires_on;
    ELSIF v_upload.doc_type = 'state_license' THEN
      v_doc_expires := (v_license_expiry->>substr(v_upload.slot_key, 9))::date;
      -- No answer row for that state (she never changed her licenses): the
      -- state's newest license, as the form showed it.
      IF v_doc_expires IS NULL THEN
        SELECT l.expiration_date INTO v_doc_expires FROM public.state_licenses l
         WHERE l.provider_id = v_provider.id AND l.org_id = v_ctx.org_id
           AND l.state = substr(v_upload.slot_key, 9)
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT 1;
      END IF;
    END IF;

    INSERT INTO public.provider_documents
      (id, org_id, provider_id, doc_type, file_path, file_name, expiration_date,
       document_family_id, version_number)
      VALUES (v_upload.id, v_ctx.org_id, v_provider.id, v_upload.doc_type, v_doc->>'file_path',
              v_upload.file_name, v_doc_expires, v_upload.id, 1)
      ON CONFLICT (id) DO NOTHING
      RETURNING id INTO v_doc_id;
    IF v_doc_id IS NOT NULL THEN
      INSERT INTO public.audit_log (org_id, action_type, entity_type, entity_id, after, description)
        VALUES (v_ctx.org_id, 'CREATE', 'provider_document', v_doc_id,
                jsonb_build_object('ownerType', 'provider', 'ownerId', v_provider.id,
                                   'kind', v_upload.doc_type, 'familyId', v_upload.id,
                                   'versionNumber', 1),
                'Document added from the provider onboarding form');
    END IF;
  END LOOP;

  IF v_after <> '{}'::jsonb OR v_licenses_after <> '[]'::jsonb THEN
    INSERT INTO public.audit_log (org_id, action_type, entity_type, entity_id, before, after, description)
      VALUES (
        v_ctx.org_id, 'UPDATE', 'provider', v_provider.id,
        v_before || CASE WHEN v_licenses_after <> '[]'::jsonb
                         THEN jsonb_build_object('state_licenses', v_licenses_before)
                         ELSE '{}'::jsonb END,
        v_after || CASE WHEN v_licenses_after <> '[]'::jsonb
                        THEN jsonb_build_object('state_licenses', v_licenses_after)
                        ELSE '{}'::jsonb END,
        'Provider record updated from the onboarding form');
  END IF;

  UPDATE public.provider_onboardings SET submitted_at = now() WHERE id = v_journey.id;
  INSERT INTO public.audit_log (org_id, action_type, entity_type, entity_id, description)
    VALUES (v_ctx.org_id, 'UPDATE', 'provider_onboarding', v_journey.id,
            'Provider submitted the onboarding form');

  RETURN jsonb_build_object(
    'result', 'submitted',
    'first_time', true,
    'onboarding_id', v_journey.id,
    'provider_id', v_provider.id,
    'practice_name', (SELECT name FROM public.organizations WHERE id = v_ctx.org_id),
    'first_name', (SELECT first_name FROM public.providers WHERE id = v_provider.id),
    'email', (SELECT email FROM public.provider_intake_invites WHERE id = v_ctx.invite_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- request_intake_help: "I need help" (p_kind 'help', no field) or "Wrong?
-- Tell us" (p_kind 'fix', p_field npi | date_of_birth | ssn). Adds a provider
-- note in a plain sentence that never carries a value, sets last_help_at,
-- and writes one audit row. Works before and after Submit while the journey
-- is open. Results:
--   null       the session is not live under this link
--   requested  written; returns provider_id and practice_name for the alert
--   recent     she asked in the last 60 seconds (a double click); nothing
--              written, nothing to send
--   closed     the journey is admitted or cancelled
-- Any other kind or field raises without echoing it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_intake_help(
  p_session_hash text,
  p_token_hash text,
  p_kind text,
  p_field text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_content text := CASE
    WHEN p_kind = 'help' AND p_field IS NULL THEN 'Asked for help from the onboarding form.'
    WHEN p_kind = 'fix' AND p_field = 'npi' THEN 'Says the NPI on file is wrong.'
    WHEN p_kind = 'fix' AND p_field = 'date_of_birth' THEN 'Says the date of birth on file is wrong.'
    WHEN p_kind = 'fix' AND p_field = 'ssn' THEN 'Says the SSN on file is wrong.'
  END;
  v_ctx record;
  v_journey public.provider_onboardings%ROWTYPE;
  v_note_id uuid;
BEGIN
  IF v_content IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_help';
  END IF;

  SELECT * INTO v_ctx FROM public._intake_session_context(p_session_hash, p_token_hash);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_journey FROM public.provider_onboardings WHERE id = v_ctx.onboarding_id FOR UPDATE;
  IF v_journey.admitted_at IS NOT NULL OR v_journey.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'closed');
  END IF;
  IF v_journey.last_help_at > now() - interval '60 seconds' THEN
    RETURN jsonb_build_object('result', 'recent');
  END IF;

  INSERT INTO public.notes (org_id, entity_type, entity_id, content, author_id)
    VALUES (v_ctx.org_id, 'provider', v_ctx.provider_id, v_content, NULL)
    RETURNING id INTO v_note_id;

  UPDATE public.provider_onboardings SET last_help_at = now() WHERE id = v_journey.id;

  INSERT INTO public.audit_log (org_id, action_type, entity_type, entity_id, after, description)
    VALUES (v_ctx.org_id, 'CREATE', 'note', v_note_id,
            jsonb_build_object('entity_type', 'provider', 'kind', p_kind, 'field', p_field),
            'Provider asked for help from the onboarding form');

  RETURN jsonb_build_object(
    'result', 'requested',
    'provider_id', v_ctx.provider_id,
    'practice_name', (SELECT name FROM public.organizations WHERE id = v_ctx.org_id));
END;
$$;

REVOKE ALL ON FUNCTION public.read_intake_state(text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_provider_intake(text, text, int, jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_intake_help(text, text, text, text) FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.read_intake_state(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_provider_intake(text, text, int, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_intake_help(text, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
