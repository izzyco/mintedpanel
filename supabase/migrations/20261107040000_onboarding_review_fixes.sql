-- Provider onboarding R1, review fixes (Nov 7).
--
--   intake_link_paused          the off switch for one intake link: paused
--                               when intake is, or when the link's org is not
--                               writable (offboarded). verify_intake_code
--                               writes provider_onboardings, which the write
--                               freeze refuses there, so without this a code
--                               was emailed and the sign-in that followed was
--                               a 500.
--   cancel_provider_onboarding  as in 20261107000000, plus the consent
--                               evidence (text version and signed time of
--                               each signature, never the typed name) in the
--                               DELETE audit row, since the delete takes the
--                               consent rows with the record.
--   reveal_portal_credential    as in 20261106220000, plus the caller's name
--                               on its READ audit row.
--   onboarding_orphan_files     the files the cleanup job deletes
--                               (src/server/jobs/onboardingFileCleanup.ts).
--
-- service_role only, except reveal_portal_credential (authenticated, as
-- before). No new table.
--
-- Additive and idempotent. Applying to hosted is an OPERATOR task, after
-- 20261107030000. Verify the OBJECTS:
--   SELECT count(*) FROM pg_proc WHERE proname IN ('intake_link_paused',
--     'onboarding_orphan_files');                                      -- 2
--   SELECT prosrc LIKE '%consents%' FROM pg_proc
--    WHERE proname = 'cancel_provider_onboarding';                     -- true
--   SELECT prosrc LIKE '%user_name%' FROM pg_proc
--    WHERE proname = 'reveal_portal_credential';                       -- true
--   then run scripts/sql/provider-onboarding-cleanup-smoke.sql, and the
--   cancel, secrets and staff smokes again.

-- ---------------------------------------------------------------------------
-- intake_link_paused: true while intake is paused, or while the org of the
-- invite with this token hash is not writable. Any other hash reads the off
-- switch alone, so an unknown link still gets its own answer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.intake_link_paused(p_token_hash text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.intake_paused() OR EXISTS (
    SELECT 1 FROM public.provider_intake_invites i
     WHERE i.token_hash = p_token_hash AND NOT public.org_is_writable(i.org_id));
$$;

REVOKE ALL ON FUNCTION public.intake_link_paused(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intake_link_paused(text) TO service_role;

-- ---------------------------------------------------------------------------
-- cancel_provider_onboarding. Results:
--   not_found          no open journey for that provider in that org
--   already_submitted  she submitted; nothing written (cancel is before Submit)
--   deleted            the record is gone; returns storage
--   closed             the journey is cancelled; returns storage
-- storage: [{ bucket, prefix }], each prefix ending in a slash.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_provider_onboarding(
  p_org_id uuid,
  p_actor_id uuid,
  p_actor_name text,
  p_provider_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_journey public.provider_onboardings%ROWTYPE;
  v_holding jsonb;
  v_storage jsonb;
  v_deletable boolean := false;
  v_logins int;
  v_ssn_removed boolean := false;
  v_consents jsonb;
BEGIN
  -- resend_provider_intake_invite's lock, so a resend can't attach a new
  -- invite to a journey this is closing.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('provider_intake_invite:' || p_provider_id::text, 0));

  SELECT * INTO v_journey
    FROM public.provider_onboardings
   WHERE org_id = p_org_id AND provider_id = p_provider_id
     AND admitted_at IS NULL AND cancelled_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_journey.submitted_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'already_submitted');
  END IF;

  UPDATE public.provider_intake_invites SET revoked_at = now()
   WHERE org_id = p_org_id AND provider_id = p_provider_id AND revoked_at IS NULL;
  UPDATE public.provider_intake_sessions s SET revoked_at = now()
    FROM public.provider_intake_invites i
   WHERE i.id = s.invite_id AND i.provider_id = p_provider_id AND s.revoked_at IS NULL;

  v_holding := jsonb_build_object(
    'bucket', 'provider-intake-uploads',
    'prefix', format('org/%s/onboarding/%s/', p_org_id, v_journey.id));

  IF v_journey.created_record THEN
    -- Anything that would name this provider (a case, a document, an
    -- assignment) waits on this lock, so nothing lands between the check and
    -- the delete.
    PERFORM 1 FROM public.providers WHERE id = p_provider_id FOR UPDATE;
    v_deletable := NOT (
      EXISTS (SELECT 1 FROM public.credential_cases WHERE provider_id = p_provider_id)
      OR EXISTS (SELECT 1 FROM public.tasks WHERE provider_id = p_provider_id)
      OR EXISTS (SELECT 1 FROM public.enrollment_facts WHERE provider_id = p_provider_id)
      OR EXISTS (SELECT 1 FROM private.enrollment_scopes WHERE provider_id = p_provider_id)
      OR EXISTS (SELECT 1 FROM public.case_generation_exclusions WHERE provider_id = p_provider_id)
      OR EXISTS (SELECT 1 FROM public.case_generation_run_rows WHERE provider_id = p_provider_id)
      OR EXISTS (SELECT 1 FROM public.fill_sessions WHERE provider_id = p_provider_id)
      OR EXISTS (SELECT 1 FROM public.provider_documents WHERE provider_id = p_provider_id)
      OR EXISTS (SELECT 1 FROM public.provider_facility_assignments WHERE provider_id = p_provider_id)
      OR EXISTS (SELECT 1 FROM public.provider_field_verifications WHERE provider_id = p_provider_id)
      OR EXISTS (SELECT 1 FROM public.launches WHERE clinic_director_provider_id = p_provider_id)
      OR EXISTS (SELECT 1 FROM public.provider_onboardings
                  WHERE provider_id = p_provider_id AND id <> v_journey.id)
      OR (SELECT count(*) FROM public.provider_group_assignments WHERE provider_id = p_provider_id) > 1);
  END IF;

  IF v_deletable THEN
    -- The consent rows go with the record (cascade), so what she agreed to
    -- and when stays on the audit row. Never the typed name.
    SELECT coalesce(jsonb_agg(jsonb_build_object('text_version', k.text_version,
                                                 'signed_at', k.signed_at)
                              ORDER BY k.signed_at, k.id), '[]'::jsonb)
      INTO v_consents
      FROM public.provider_intake_consents k
     WHERE k.onboarding_id = v_journey.id;

    DELETE FROM public.notes
     WHERE org_id = p_org_id AND entity_type = 'provider' AND entity_id = p_provider_id;
    DELETE FROM public.state_licenses WHERE provider_id = p_provider_id;
    DELETE FROM public.provider_group_assignments WHERE provider_id = p_provider_id;
    DELETE FROM public.providers WHERE id = p_provider_id AND org_id = p_org_id;

    INSERT INTO public.audit_log
      (org_id, user_id, user_name, action_type, entity_type, entity_id, after, description)
      VALUES (p_org_id, p_actor_id, p_actor_name, 'DELETE', 'provider', p_provider_id,
              jsonb_build_object('onboarding_id', v_journey.id, 'consents', v_consents),
              'Deleted provider (onboarding cancelled before Submit)');

    RETURN jsonb_build_object(
      'result', 'deleted',
      'storage', jsonb_build_array(
        v_holding,
        jsonb_build_object(
          'bucket', 'provider-documents',
          'prefix', format('org/%s/provider/%s/', p_org_id, p_provider_id))));
  END IF;

  -- A document row with an upload's id is a file Submit put in the vault;
  -- its prefix is never handed back for deletion.
  SELECT jsonb_build_array(v_holding) || coalesce(jsonb_agg(jsonb_build_object(
           'bucket', 'provider-documents',
           'prefix', format('org/%s/provider/%s/%s/', p_org_id, p_provider_id, u.id))
           ORDER BY u.created_at, u.id), '[]'::jsonb)
    INTO v_storage
    FROM public.provider_intake_uploads u
   WHERE u.onboarding_id = v_journey.id
     AND NOT EXISTS (SELECT 1 FROM public.provider_documents d WHERE d.id = u.id);

  UPDATE public.provider_onboardings
     SET cancelled_at = now(), cancelled_by = p_actor_id
   WHERE id = v_journey.id;
  DELETE FROM public.provider_intake_drafts WHERE onboarding_id = v_journey.id;
  DELETE FROM public.provider_intake_uploads WHERE onboarding_id = v_journey.id;
  DELETE FROM public.provider_portal_credentials WHERE onboarding_id = v_journey.id;
  GET DIAGNOSTICS v_logins = ROW_COUNT;

  IF v_journey.ssn_stored_at IS NOT NULL AND NOT ('ssn' = ANY (v_journey.locked_fields)) THEN
    -- store_intake_ssn sets ssn_stored_at and the vault row's updated_at in
    -- one transaction, so they match while the vault still holds her SSN. A
    -- later save by staff moves updated_at, and that SSN stays.
    DELETE FROM public.provider_ssn_vault
     WHERE provider_id = p_provider_id AND updated_at = v_journey.ssn_stored_at;
    IF FOUND THEN
      UPDATE public.providers SET ssn_last4 = NULL WHERE id = p_provider_id;
      v_ssn_removed := true;
    END IF;
  END IF;

  INSERT INTO public.audit_log
    (org_id, user_id, user_name, action_type, entity_type, entity_id, after, description)
    VALUES (p_org_id, p_actor_id, p_actor_name, 'UPDATE', 'provider_onboarding', v_journey.id,
            jsonb_build_object('provider_id', p_provider_id, 'logins_removed', v_logins,
                               'ssn_removed', v_ssn_removed),
            'Cancelled onboarding before Submit');

  RETURN jsonb_build_object('result', 'closed', 'storage', v_storage);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_provider_onboarding(uuid, uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_provider_onboarding(uuid, uuid, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- reveal_portal_credential: staff read one login back (decision D13, the
-- reveal_ssn posture). The caller must be an admin of the provider's org and
-- give a reason. Returns { username, password } once; writes one READ audit
-- row with the caller's name, the portal and the reason, never the username
-- or password.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reveal_portal_credential(
  p_provider_id uuid,
  p_portal text,
  p_justification text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
  v_just text := btrim(coalesce(p_justification, ''));
  v_row public.provider_portal_credentials%ROWTYPE;
  v_password text;
  v_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT org_id INTO v_org FROM public.providers WHERE id = p_provider_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Provider not found';
  END IF;
  -- IS DISTINCT FROM: user_role() is NULL for a non-member, and a NULL
  -- comparison would skip the raise.
  IF public.user_role(v_org) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only an administrator can reveal a portal login';
  END IF;
  IF v_just = '' THEN
    RAISE EXCEPTION 'A reason is required to reveal a portal login';
  END IF;

  SELECT * INTO v_row FROM public.provider_portal_credentials
   WHERE provider_id = p_provider_id AND org_id = v_org AND portal = p_portal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No login on file for this portal';
  END IF;
  v_password := extensions.pgp_sym_decrypt(v_row.password_ciphertext, public._portal_credentials_key());

  SELECT coalesce(nullif(btrim(p.full_name), ''), p.email) INTO v_name
    FROM public.profiles p WHERE p.id = v_uid;

  INSERT INTO public.audit_log
    (org_id, user_id, user_name, action_type, entity_type, entity_id, description, after)
    VALUES (v_org, v_uid, v_name, 'READ', 'provider_portal_credential', p_provider_id,
            'Portal login revealed (admin click-to-reveal)',
            jsonb_build_object('portal', p_portal, 'justification', v_just));

  RETURN jsonb_build_object('username', v_row.username, 'password', v_password);
END;
$$;

REVOKE ALL ON FUNCTION public.reveal_portal_credential(uuid, text, text) FROM public, anon, service_role;
GRANT EXECUTE ON FUNCTION public.reveal_portal_credential(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- onboarding_orphan_files: up to p_limit Storage objects created before
-- p_cutoff that no onboarding step will read again, oldest first, as
-- [{ bucket, path }]. Two kinds, and nothing else:
--   provider-intake-uploads  org/<org>/onboarding/<journey>/<upload>/<file>
--                            whose upload row is missing or removed, or whose
--                            journey is submitted, admitted, cancelled or
--                            gone. A live upload of an open journey stays.
--   provider-documents       org/<org>/provider/<provider>/<upload>/...
--                            where <upload> is an upload of that org's and
--                            provider's journey (any state), the journey is
--                            submitted, admitted or cancelled, and no
--                            provider_documents row has the upload's id. Every
--                            other vault path is never named.
-- Every condition is final (no row comes back, no document row is written
-- for an ended journey), so a file named once stays an orphan. The caller
-- picks a cutoff older than any signed upload URL lives.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.onboarding_orphan_files(p_cutoff timestamptz, p_limit int)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH held AS (
    SELECT o.bucket_id, o.name, o.created_at, p.upload_id
      FROM storage.objects o
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN o.name ~ '^org/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/onboarding/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$'
                 THEN split_part(o.name, '/', 5)::uuid
               END AS upload_id) p
     WHERE o.bucket_id = 'provider-intake-uploads'
       AND o.created_at < p_cutoff
  ),
  holding_orphans AS (
    SELECT h.bucket_id, h.name, h.created_at
      FROM held h
     WHERE h.upload_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.provider_intake_uploads u
           JOIN public.provider_onboardings j ON j.id = u.onboarding_id
          WHERE u.id = h.upload_id
            AND u.removed_at IS NULL
            AND j.submitted_at IS NULL AND j.admitted_at IS NULL AND j.cancelled_at IS NULL)
  ),
  vault_orphans AS (
    SELECT o.bucket_id, o.name, o.created_at
      FROM public.provider_intake_uploads u
      JOIN public.provider_onboardings j ON j.id = u.onboarding_id
      JOIN storage.objects o
        ON o.bucket_id = 'provider-documents'
       AND o.name LIKE format('org/%s/provider/%s/%s/%%', j.org_id, j.provider_id, u.id)
     WHERE (j.submitted_at IS NOT NULL OR j.admitted_at IS NOT NULL OR j.cancelled_at IS NOT NULL)
       AND u.org_id = j.org_id
       AND o.created_at < p_cutoff
       AND NOT EXISTS (SELECT 1 FROM public.provider_documents d WHERE d.id = u.id)
  ),
  batch AS (
    SELECT * FROM holding_orphans
    UNION ALL
    SELECT * FROM vault_orphans
    ORDER BY created_at, name
    LIMIT greatest(coalesce(p_limit, 0), 0)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', b.bucket_id, 'path', b.name)
                            ORDER BY b.created_at, b.name), '[]'::jsonb)
    FROM batch b;
$$;

REVOKE ALL ON FUNCTION public.onboarding_orphan_files(timestamptz, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.onboarding_orphan_files(timestamptz, int) TO service_role;

NOTIFY pgrst, 'reload schema';
