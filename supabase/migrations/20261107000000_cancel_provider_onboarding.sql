-- Provider onboarding: staff cancel an open onboarding before Submit.
--
--   cancel_provider_onboarding  one transaction, with the provider's open
--                               journey locked. Her invites and their
--                               sessions are revoked. A record the journey
--                               created, with nothing else on it, is deleted.
--                               Otherwise the journey is closed and what it
--                               wrote is removed: her draft, the logins it
--                               stored and the SSN it stored. Her held upload
--                               rows are marked removed and kept, and her
--                               consent rows stay.
--
-- What keeps a created record from being deleted, by what references
-- providers (a case, a document, real work):
--   credential_cases, tasks, enrollment_facts, private.enrollment_scopes,
--   case_generation_exclusions, case_generation_run_rows, fill_sessions,
--   provider_documents (before Submit every row is staff's),
--   provider_facility_assignments, provider_field_verifications,
--   launches.clinic_director_provider_id, another journey, and a group
--   assignment beyond the one the invite made (another group joined her).
-- What goes with the record:
--   deleted here, in order: provider notes (help requests, staff notes),
--   state_licenses, provider_group_assignments
--   cascades: provider_intake_invites (codes, sessions), the journey (draft,
--   consents, held upload rows), provider_ssn_vault,
--   provider_ssn_intake_links, provider_portal_credentials,
--   provider_registry_pulls
--   set null: sms_consents.provider_id (the consent evidence stays)
--   kept: audit_log
--
-- The DELETE audit row carries the consent evidence (the text version and
-- signed time of each signature, never the typed name), since the delete
-- takes the consent rows with the record.
--
-- The result names the Storage prefixes the route deletes after the commit:
-- the journey's holding prefix in provider-intake-uploads, and in
-- provider-documents the record's vault prefix (deleted) or each held
-- upload's vault prefix (closed). A Submit refused after its copies can leave
-- vault files with no row.
--
-- service_role only (POST /api/provider-invites/:providerId/cancel). Writes
-- its own audit rows. The offboarded write freeze applies to every write.
-- No new table.
--
-- Additive and idempotent. Applying to hosted is an OPERATOR task, after
-- 20261106233000. Verify the OBJECTS:
--   SELECT count(*) FROM pg_proc WHERE proname = 'cancel_provider_onboarding'; -- 1
--   SELECT prosrc LIKE '%consents%' FROM pg_proc
--    WHERE proname = 'cancel_provider_onboarding';                     -- true
--   then run scripts/sql/provider-onboarding-cancel-smoke.sql.

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
  PERFORM public._lock_provider_invites(p_provider_id);

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
  -- Kept, not deleted: onboarding_orphan_files finds a vault copy whose
  -- Storage delete failed only through its upload row.
  UPDATE public.provider_intake_uploads SET removed_at = coalesce(removed_at, now())
   WHERE onboarding_id = v_journey.id;
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

NOTIFY pgrst, 'reload schema';
