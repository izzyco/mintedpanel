-- Provider onboarding R1, cycle 7: staff see and finish an onboarding on the
-- provider's page (boards 6a and 6b).
--
--   provider_onboardings.first_signed_in_at  her first sign-in on the journey,
--                                           the tracker's Started step. Set
--                                           once by verify_intake_code and
--                                           backfilled from her sessions
--   provider_onboarding_checks              person checks (D12): append-only,
--                                           the latest row per check_key is
--                                           the answer. The keys mirror
--                                           PERSON_CHECK_KEYS in
--                                           src/lib/onboardingCard.ts
--   record_onboarding_check                 a writer records confirmed or a
--                                           problem, with an optional note
--   mark_onboarding_contacted               a writer records that someone
--                                           reached her after a help request
--   admit_provider_onboarding               a writer ends a submitted journey
--                                           at a location of one of her
--                                           groups: her assignment to it
--                                           (primary when she has none),
--                                           admitted_*, and her invite link
--                                           and sessions revoked. Never
--                                           touches providers.status (D1, D2)
--   read_provider_onboarding                any member: her latest journey,
--                                           its checks, the invite it went
--                                           to, and which secrets, uploads
--                                           and cases exist, as booleans and
--                                           counts. Never a secret
--
-- The three writes are authenticated SECURITY DEFINER RPCs (R4): the caller
-- must be an admin or specialist of the journey's org, checked NULL-safe
-- (20260918172142), and each writes one audit row. A non-member is told the
-- journey does not exist.
--
-- Additive and idempotent. Applying to hosted is an OPERATOR task, after
-- 20261107000000. Verify the OBJECTS:
--   SELECT to_regclass('public.provider_onboarding_checks');           -- non-null
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name = 'provider_onboardings'
--      AND column_name = 'first_signed_in_at';                         -- 1
--   SELECT count(*) FROM pg_proc WHERE proname IN ('record_onboarding_check',
--     'mark_onboarding_contacted', 'admit_provider_onboarding',
--     'read_provider_onboarding', '_onboarding_for_writer');           -- 5
--   SELECT position('first_signed_in_at' IN prosrc) > 0
--     FROM pg_proc WHERE proname = 'verify_intake_code';               -- true
--   then run scripts/sql/provider-onboarding-staff-smoke.sql.

ALTER TABLE public.provider_onboardings
  ADD COLUMN IF NOT EXISTS first_signed_in_at timestamptz NULL;

UPDATE public.provider_onboardings o
   SET first_signed_in_at = f.first_at
  FROM (
    SELECT i.onboarding_id, min(s.created_at) AS first_at
      FROM public.provider_intake_sessions s
      JOIN public.provider_intake_invites i ON i.id = s.invite_id
     WHERE i.onboarding_id IS NOT NULL
     GROUP BY i.onboarding_id
  ) f
 WHERE o.id = f.onboarding_id
   AND o.first_signed_in_at IS NULL;

CREATE TABLE IF NOT EXISTS public.provider_onboarding_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  onboarding_id uuid NOT NULL,
  check_key text NOT NULL
    CONSTRAINT provider_onboarding_checks_check_key_check
      CHECK (check_key IN ('caqh_login', 'pecos_login', 'caqh_attestation')),
  outcome text NOT NULL
    CONSTRAINT provider_onboarding_checks_outcome_check CHECK (outcome IN ('confirmed', 'problem')),
  note text NULL
    CONSTRAINT provider_onboarding_checks_note_check
      CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 500)),
  checked_by uuid NOT NULL,
  checked_by_name text NULL,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_onboarding_checks_onboarding_fkey FOREIGN KEY (org_id, onboarding_id)
    REFERENCES public.provider_onboardings (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS provider_onboarding_checks_latest_idx
  ON public.provider_onboarding_checks (onboarding_id, check_key, checked_at DESC);

ALTER TABLE public.provider_onboarding_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_onboarding_checks FROM public, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.provider_onboarding_checks TO authenticated;

DROP POLICY IF EXISTS provider_onboarding_checks_select ON public.provider_onboarding_checks;
CREATE POLICY provider_onboarding_checks_select ON public.provider_onboarding_checks
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.user_org_ids()));

-- ---------------------------------------------------------------------------
-- verify_intake_code: the body of 20261025120000, plus the journey's
-- first_signed_in_at on its first successful sign-in.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_intake_code(
  p_token_hash text,
  p_code_hash text,
  p_session_hash text,
  p_session_expires_at timestamptz
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite public.provider_intake_invites%ROWTYPE;
  v_code public.provider_intake_codes%ROWTYPE;
  v_session_id uuid;
BEGIN
  -- Locked so a resend running at the same moment can't revoke this invite
  -- between the check and the new session.
  SELECT * INTO v_invite
    FROM public.provider_intake_invites
   WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'invalid';
  END IF;

  SELECT * INTO v_code
    FROM public.provider_intake_codes
   WHERE invite_id = v_invite.id AND consumed_at IS NULL AND expires_at > now()
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND OR v_code.attempts >= 5 THEN
    RETURN 'invalid';
  END IF;

  IF v_code.code_hash <> p_code_hash THEN
    UPDATE public.provider_intake_codes SET attempts = attempts + 1 WHERE id = v_code.id;
    RETURN 'invalid';
  END IF;

  UPDATE public.provider_intake_codes
     SET attempts = attempts + 1, consumed_at = now()
   WHERE id = v_code.id;

  INSERT INTO public.provider_intake_sessions (invite_id, token_hash, expires_at)
    VALUES (v_invite.id, p_session_hash, p_session_expires_at)
    RETURNING id INTO v_session_id;

  UPDATE public.provider_onboardings
     SET first_signed_in_at = now()
   WHERE id = v_invite.onboarding_id AND first_signed_in_at IS NULL;

  INSERT INTO public.audit_log (org_id, action_type, entity_type, entity_id, description)
    VALUES (v_invite.org_id, 'CREATE', 'provider_intake_session', v_session_id,
            'Provider signed in to onboarding with an emailed code');

  RETURN 'ok';
END;
$$;

-- ---------------------------------------------------------------------------
-- _onboarding_for_writer: the open journey, locked, for a caller who is an
-- admin or specialist of its org. Raises:
--   42501 not_authenticated            no auth.uid()
--   P0002 onboarding_not_found         no such journey, or not a member of
--                                      its org (the two read the same)
--   42501 onboarding_writer_required   a member who can't write (billing)
--   55000 onboarding_closed            admitted or cancelled
-- Private: only the RPCs below call it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._onboarding_for_writer(p_onboarding_id uuid)
RETURNS public.provider_onboardings
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_journey public.provider_onboardings%ROWTYPE;
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authenticated';
  END IF;

  SELECT * INTO v_journey FROM public.provider_onboardings WHERE id = p_onboarding_id FOR UPDATE;
  IF FOUND THEN
    v_role := public.user_role(v_journey.org_id);
  END IF;
  IF v_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'onboarding_not_found';
  END IF;
  -- IS NOT TRUE so that a NULL role can never slip past.
  IF (v_role IN ('admin', 'specialist')) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'onboarding_writer_required';
  END IF;
  IF v_journey.admitted_at IS NOT NULL OR v_journey.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'onboarding_closed';
  END IF;

  RETURN v_journey;
END;
$$;

-- ---------------------------------------------------------------------------
-- record_onboarding_check: one person check, appended. The key and outcome
-- are the table's CHECKs; the note is trimmed and an empty one is null.
-- Returns the row as the card reads it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_onboarding_check(
  p_onboarding_id uuid,
  p_check_key text,
  p_outcome text,
  p_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_journey public.provider_onboardings%ROWTYPE;
  v_name text;
  v_row public.provider_onboarding_checks%ROWTYPE;
BEGIN
  v_journey := public._onboarding_for_writer(p_onboarding_id);

  SELECT coalesce(nullif(btrim(p.full_name), ''), p.email) INTO v_name
    FROM public.profiles p WHERE p.id = v_uid;

  INSERT INTO public.provider_onboarding_checks
    (org_id, onboarding_id, check_key, outcome, note, checked_by, checked_by_name)
    VALUES (v_journey.org_id, v_journey.id, p_check_key, p_outcome,
            nullif(btrim(coalesce(p_note, '')), ''), v_uid, v_name)
    RETURNING * INTO v_row;

  INSERT INTO public.audit_log
    (org_id, user_id, user_name, action_type, entity_type, entity_id, after, description)
    VALUES (v_journey.org_id, v_uid, v_name, 'UPDATE', 'provider_onboarding', v_journey.id,
            jsonb_build_object('provider_id', v_journey.provider_id, 'check_key', v_row.check_key,
                               'outcome', v_row.outcome, 'has_note', v_row.note IS NOT NULL),
            'Recorded an onboarding check');

  RETURN jsonb_build_object(
    'check_key', v_row.check_key,
    'outcome', v_row.outcome,
    'note', v_row.note,
    'checked_by_name', v_row.checked_by_name,
    'checked_at', v_row.checked_at);
END;
$$;

-- ---------------------------------------------------------------------------
-- mark_onboarding_contacted: someone reached her after a help request, so
-- the request no longer waits on the practice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_onboarding_contacted(p_onboarding_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_journey public.provider_onboardings%ROWTYPE;
  v_name text;
  v_at timestamptz;
BEGIN
  v_journey := public._onboarding_for_writer(p_onboarding_id);

  UPDATE public.provider_onboardings SET last_contacted_at = now()
   WHERE id = v_journey.id
   RETURNING last_contacted_at INTO v_at;

  SELECT coalesce(nullif(btrim(p.full_name), ''), p.email) INTO v_name
    FROM public.profiles p WHERE p.id = v_uid;
  INSERT INTO public.audit_log
    (org_id, user_id, user_name, action_type, entity_type, entity_id, after, description)
    VALUES (v_journey.org_id, v_uid, v_name, 'UPDATE', 'provider_onboarding', v_journey.id,
            jsonb_build_object('provider_id', v_journey.provider_id, 'last_contacted_at', v_at),
            'Marked the provider contacted');

  RETURN jsonb_build_object('last_contacted_at', v_at);
END;
$$;

-- ---------------------------------------------------------------------------
-- admit_provider_onboarding. Raises what _onboarding_for_writer raises, and:
--   55000 onboarding_not_submitted        she hasn't submitted
--   22023 onboarding_location_ineligible  the facility is not an active
--                                         location of her org owned by a
--                                         group she is currently assigned to
-- Her provider_facility_assignments row for the location is made when she
-- has none (start_date from providers.start_date, her start date from the
-- invite) and made primary when she has no primary. Her invites for this
-- journey and their sessions are revoked: the journey is over. Returns
-- { admitted_at, assignment_created, made_primary }.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admit_provider_onboarding(
  p_onboarding_id uuid,
  p_facility_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_provider uuid;
  v_journey public.provider_onboardings%ROWTYPE;
  v_name text;
  v_created boolean;
  v_primary boolean := false;
  v_at timestamptz;
BEGIN
  -- resend_provider_intake_invite's lock, taken before the journey row as
  -- cancel does, so a resend can't attach a live invite to a journey this is
  -- ending.
  SELECT provider_id INTO v_provider FROM public.provider_onboardings WHERE id = p_onboarding_id;
  IF v_provider IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('provider_intake_invite:' || v_provider::text, 0));
  END IF;

  v_journey := public._onboarding_for_writer(p_onboarding_id);
  IF v_journey.submitted_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'onboarding_not_submitted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.facilities f
      JOIN public.provider_group_assignments a
        ON a.group_id = f.group_id
       AND a.org_id = f.org_id
       AND a.provider_id = v_journey.provider_id
       AND a.end_date IS NULL
     WHERE f.id = p_facility_id
       AND f.org_id = v_journey.org_id
       AND f.is_active
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'onboarding_location_ineligible';
  END IF;

  INSERT INTO public.provider_facility_assignments (org_id, provider_id, facility_id, is_primary, start_date)
    SELECT v_journey.org_id, v_journey.provider_id, p_facility_id, false, p.start_date
      FROM public.providers p WHERE p.id = v_journey.provider_id
    ON CONFLICT (provider_id, facility_id) DO NOTHING
    RETURNING true INTO v_created;

  IF NOT EXISTS (
    SELECT 1 FROM public.provider_facility_assignments
     WHERE provider_id = v_journey.provider_id AND is_primary
  ) THEN
    UPDATE public.provider_facility_assignments SET is_primary = true
     WHERE provider_id = v_journey.provider_id AND facility_id = p_facility_id;
    v_primary := true;
  END IF;

  UPDATE public.provider_onboardings
     SET admitted_at = now(), admitted_by = v_uid, admitted_facility_id = p_facility_id
   WHERE id = v_journey.id
   RETURNING admitted_at INTO v_at;

  UPDATE public.provider_intake_invites SET revoked_at = now()
   WHERE onboarding_id = v_journey.id AND revoked_at IS NULL;
  UPDATE public.provider_intake_sessions s SET revoked_at = now()
    FROM public.provider_intake_invites i
   WHERE i.id = s.invite_id AND i.onboarding_id = v_journey.id AND s.revoked_at IS NULL;

  SELECT coalesce(nullif(btrim(p.full_name), ''), p.email) INTO v_name
    FROM public.profiles p WHERE p.id = v_uid;
  INSERT INTO public.audit_log
    (org_id, user_id, user_name, action_type, entity_type, entity_id, after, description)
    VALUES (v_journey.org_id, v_uid, v_name, 'UPDATE', 'provider_onboarding', v_journey.id,
            jsonb_build_object('provider_id', v_journey.provider_id,
                               'admitted_facility_id', p_facility_id,
                               'assignment_created', coalesce(v_created, false),
                               'made_primary', v_primary),
            'Admitted the provider and assigned a location');

  RETURN jsonb_build_object(
    'admitted_at', v_at,
    'assignment_created', coalesce(v_created, false),
    'made_primary', v_primary);
END;
$$;

-- ---------------------------------------------------------------------------
-- read_provider_onboarding: what the Onboarding card shows, for any member of
-- the provider's org. Null when she has never had a journey. Otherwise
--   journey         the latest journey's milestones (admitted_by as a name)
--   invite          the journey's latest invite: email, when it was sent,
--                   its delivery outcome, and how many invites it has had
--   checks          the latest row per check_key
--   logins_on_file  { caqh, pecos } booleans
--   ssn_on_file     boolean
--   held_uploads    her finished uploads still on her form, before Submit
--                   copies them into the vault
--   has_case        she has any credentialing case
--   npi_in_use      another provider in the org has her NPI
-- A non-member gets P0002 onboarding_not_found, as for a missing provider.
-- ---------------------------------------------------------------------------
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
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'onboarding_not_found';
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

REVOKE ALL ON FUNCTION public._onboarding_for_writer(uuid) FROM public, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_onboarding_check(uuid, text, text, text) FROM public, anon, service_role;
REVOKE ALL ON FUNCTION public.mark_onboarding_contacted(uuid) FROM public, anon, service_role;
REVOKE ALL ON FUNCTION public.admit_provider_onboarding(uuid, uuid) FROM public, anon, service_role;
REVOKE ALL ON FUNCTION public.read_provider_onboarding(uuid) FROM public, anon, service_role;

GRANT EXECUTE ON FUNCTION public.record_onboarding_check(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_onboarding_contacted(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admit_provider_onboarding(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.read_provider_onboarding(uuid) TO authenticated;

SELECT public.apply_offboarded_write_freeze();

NOTIFY pgrst, 'reload schema';
