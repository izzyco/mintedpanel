-- Provider onboarding R1, cycle 9: the Onboarding card read answers NULL, not
-- an error, for a provider the caller can't see.
--
-- read_provider_onboarding (20261107010000) raised P0002 onboarding_not_found
-- when the provider was gone or in another org, and PostgREST answers P0002
-- with HTTP 500. A deleted record is an ordinary state: Cancel deletes the
-- record her invite created while her page is still open, and the refetch
-- that follows, like any later visit to that page, read as a server fault.
--
-- Now a provider that doesn't exist, or that isn't in one of the caller's
-- orgs, reads NULL, exactly as a provider with no journey does. The card
-- shows nothing either way, and a non-member still learns nothing. The
-- staff write RPCs keep raising onboarding_not_found.
--
-- Additive and idempotent: one CREATE OR REPLACE, grants unchanged. Applying
-- to hosted is an OPERATOR task, after 20261107010000. Verify the OBJECT:
--   SELECT prosrc NOT LIKE '%onboarding_not_found%' FROM pg_proc
--    WHERE proname = 'read_provider_onboarding';                       -- true
--   then run scripts/sql/provider-onboarding-staff-smoke.sql.

CREATE OR REPLACE FUNCTION public.read_provider_onboarding(p_provider_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_npi text;
  v_journey public.provider_onboardings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authenticated';
  END IF;
  SELECT org_id, npi INTO v_org, v_npi FROM public.providers WHERE id = p_provider_id;
  IF v_org IS NULL OR public.user_role(v_org) IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_journey
    FROM public.provider_onboardings
   WHERE org_id = v_org AND provider_id = p_provider_id
   ORDER BY opened_at DESC, id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'journey', jsonb_build_object(
      'id', v_journey.id,
      'source', v_journey.source,
      'created_record', v_journey.created_record,
      'locked_fields', to_jsonb(v_journey.locked_fields),
      'opened_at', v_journey.opened_at,
      'first_signed_in_at', v_journey.first_signed_in_at,
      'consented_at', v_journey.consented_at,
      'ssn_stored_at', v_journey.ssn_stored_at,
      'submitted_at', v_journey.submitted_at,
      'admitted_at', v_journey.admitted_at,
      'admitted_by_name', (SELECT coalesce(nullif(btrim(p.full_name), ''), p.email)
                             FROM public.profiles p WHERE p.id = v_journey.admitted_by),
      'admitted_facility_id', v_journey.admitted_facility_id,
      'cancelled_at', v_journey.cancelled_at,
      'last_help_at', v_journey.last_help_at,
      'last_contacted_at', v_journey.last_contacted_at),
    'invite', (
      SELECT jsonb_build_object('email', i.email, 'last_sent_at', i.created_at,
                                'delivery', i.delivery, 'sends', count(*) OVER ())
        FROM public.provider_intake_invites i
       WHERE i.onboarding_id = v_journey.id
       ORDER BY i.created_at DESC, i.id DESC
       LIMIT 1),
    'checks', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'check_key', c.check_key, 'outcome', c.outcome, 'note', c.note,
               'checked_by_name', c.checked_by_name, 'checked_at', c.checked_at)
             ORDER BY c.check_key)
        FROM (
          SELECT DISTINCT ON (k.check_key) k.*
            FROM public.provider_onboarding_checks k
           WHERE k.onboarding_id = v_journey.id
           ORDER BY k.check_key, k.checked_at DESC, k.id DESC
        ) c), '[]'::jsonb),
    'logins_on_file', jsonb_build_object(
      'caqh', EXISTS (SELECT 1 FROM public.provider_portal_credentials pc
                       WHERE pc.provider_id = p_provider_id AND pc.org_id = v_org AND pc.portal = 'caqh'),
      'pecos', EXISTS (SELECT 1 FROM public.provider_portal_credentials pc
                        WHERE pc.provider_id = p_provider_id AND pc.org_id = v_org AND pc.portal = 'pecos')),
    'ssn_on_file', EXISTS (SELECT 1 FROM public.provider_ssn_vault v
                            WHERE v.provider_id = p_provider_id AND v.org_id = v_org),
    'held_uploads', (SELECT count(*) FROM public.provider_intake_uploads u
                      WHERE u.onboarding_id = v_journey.id
                        AND u.finalized_at IS NOT NULL AND u.removed_at IS NULL),
    'has_case', EXISTS (SELECT 1 FROM public.credential_cases cc
                         WHERE cc.provider_id = p_provider_id AND cc.org_id = v_org),
    'npi_in_use', v_npi IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.providers p
                     WHERE p.org_id = v_org AND p.npi = v_npi AND p.id <> p_provider_id));
END;
$$;

NOTIFY pgrst, 'reload schema';
