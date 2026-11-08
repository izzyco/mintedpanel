-- Provider onboarding R1, cycle 2: her answers and consent persist, and
-- signing in resumes where she was.
--
--   provider_intake_drafts    one row per journey: what she has typed so far
--                             (answers, never the SSN or a password), the
--                             step she reached and an optimistic version
--   provider_intake_consents  append-only: each signature, with the consent
--                             text version, her typed name, the server time
--                             and the session that signed
--   _intake_session_context   private: a live session bound to THIS link,
--                             resolved to its invite, journey, provider and
--                             org. Every RPC below starts from it, so none
--                             takes an id from the browser.
--   read_intake_state         what the form opens with
--   save_intake_draft         one save, version-checked
--   sign_intake_consent       one signature
--
-- Both tables are service_role only (RLS on, no policies), reached through
-- the SECURITY DEFINER RPCs, which are EXECUTE-granted to service_role alone.
--
-- Additive and idempotent. Applying to hosted is an OPERATOR task, after
-- 20261106200000. Verify the OBJECTS:
--   SELECT to_regclass('public.provider_intake_drafts'),
--          to_regclass('public.provider_intake_consents');          -- non-null
--   SELECT count(*) FROM pg_proc WHERE proname IN ('_intake_session_context',
--     'read_intake_state', 'save_intake_draft', 'sign_intake_consent'); -- 4
--   then run scripts/sql/provider-intake-drafts-smoke.sql.

-- The (org_id, onboarding_id) keys below need it: a draft or a signature
-- can't carry an org other than its journey's.
CREATE UNIQUE INDEX IF NOT EXISTS provider_onboardings_org_id_id_key
  ON public.provider_onboardings (org_id, id);

CREATE TABLE IF NOT EXISTS public.provider_intake_drafts (
  onboarding_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  answers jsonb NOT NULL
    CONSTRAINT provider_intake_drafts_answers_object CHECK (jsonb_typeof(answers) = 'object'),
  step text NOT NULL DEFAULT 'form'
    CONSTRAINT provider_intake_drafts_step_check CHECK (step IN ('form', 'documents')),
  version int NOT NULL DEFAULT 1 CONSTRAINT provider_intake_drafts_version_check CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_intake_drafts_onboarding_fkey FOREIGN KEY (org_id, onboarding_id)
    REFERENCES public.provider_onboardings (org_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.provider_intake_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  onboarding_id uuid NOT NULL,
  text_version int NOT NULL CONSTRAINT provider_intake_consents_text_version_check CHECK (text_version > 0),
  typed_name text NOT NULL
    CONSTRAINT provider_intake_consents_typed_name_check
      CHECK (btrim(typed_name) <> '' AND length(typed_name) <= 200),
  signed_at timestamptz NOT NULL DEFAULT now(),
  session_id uuid NOT NULL REFERENCES public.provider_intake_sessions (id),
  CONSTRAINT provider_intake_consents_onboarding_fkey FOREIGN KEY (org_id, onboarding_id)
    REFERENCES public.provider_onboardings (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS provider_intake_consents_onboarding_idx
  ON public.provider_intake_consents (onboarding_id, signed_at DESC);
CREATE INDEX IF NOT EXISTS provider_intake_consents_session_idx
  ON public.provider_intake_consents (session_id);

ALTER TABLE public.provider_intake_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_intake_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_intake_drafts FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.provider_intake_consents FROM public, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.provider_intake_drafts TO service_role;
-- Append-only: a signature is never changed or removed by hand. It goes only
-- with its journey (cascade).
GRANT SELECT, INSERT ON TABLE public.provider_intake_consents TO service_role;

-- ---------------------------------------------------------------------------
-- _intake_session_context: the session, invite, journey, provider and org for
-- a session cookie opened under THIS link (a shared browser can't act under
-- another provider's link). No row when the session is expired or revoked,
-- its invite was revoked (a resend, an email change, termination) or its
-- journey was cancelled. The same binding as read_intake_session.
-- Private: only the SECURITY DEFINER RPCs call it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._intake_session_context(p_session_hash text, p_token_hash text)
RETURNS TABLE (session_id uuid, invite_id uuid, onboarding_id uuid, provider_id uuid, org_id uuid)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT s.id, i.id, o.id, i.provider_id, i.org_id
    FROM public.provider_intake_sessions s
    JOIN public.provider_intake_invites i ON i.id = s.invite_id
    JOIN public.provider_onboardings o ON o.id = i.onboarding_id
   WHERE s.token_hash = p_session_hash
     AND i.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND i.revoked_at IS NULL
     AND o.cancelled_at IS NULL;
$$;

-- ---------------------------------------------------------------------------
-- read_intake_state: what the form opens with. Null when the session is not
-- live under this link. `record` is her provider record in the answers shape
-- (the columns the form shows, and every state license); `draft` is her saved
-- answers, or null before her first save. Never the full SSN: ssn_last4 only.
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
           'submitted', o.submitted_at IS NOT NULL)
    FROM public._intake_session_context(p_session_hash, p_token_hash) c
    JOIN public.provider_intake_invites i ON i.id = c.invite_id
    JOIN public.provider_onboardings o ON o.id = c.onboarding_id
    JOIN public.providers p ON p.id = c.provider_id
    JOIN public.organizations org ON org.id = c.org_id;
$$;

-- ---------------------------------------------------------------------------
-- save_intake_draft: replace her saved answers and step. Results:
--   null       the session is not live under this link
--   saved      written; returns the new version
--   conflict   p_expected_version is not the saved version (another window
--              saved first; a first save expects 0); returns the saved version
--   closed     the journey is submitted, admitted or cancelled; nothing written
-- Keys for fields locked on the journey are dropped, and so is any ssn key:
-- the draft never holds what she can't change or the SSN. No audit row: a
-- save is not a milestone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_intake_draft(
  p_session_hash text,
  p_token_hash text,
  p_answers jsonb,
  p_step text,
  p_expected_version int
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_journey_id uuid;
  v_journey public.provider_onboardings%ROWTYPE;
  v_version int;
BEGIN
  IF jsonb_typeof(p_answers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_answers';
  END IF;

  SELECT c.onboarding_id INTO v_journey_id
    FROM public._intake_session_context(p_session_hash, p_token_hash) c;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- One save per journey at a time, so two windows can't both pass the
  -- version check. Read again under the lock: a cancel may have landed.
  SELECT * INTO v_journey FROM public.provider_onboardings WHERE id = v_journey_id FOR UPDATE;
  IF v_journey.submitted_at IS NOT NULL OR v_journey.admitted_at IS NOT NULL
     OR v_journey.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'closed');
  END IF;

  v_version := coalesce(
    (SELECT version FROM public.provider_intake_drafts WHERE onboarding_id = v_journey.id), 0);
  IF p_expected_version IS DISTINCT FROM v_version THEN
    RETURN jsonb_build_object('result', 'conflict', 'version', v_version);
  END IF;

  INSERT INTO public.provider_intake_drafts (onboarding_id, org_id, answers, step, version, updated_at)
    VALUES (
      v_journey.id,
      v_journey.org_id,
      p_answers - (ARRAY['ssn'] || ARRAY(
        SELECT CASE f WHEN 'date_of_birth' THEN 'dateOfBirth' ELSE f END
          FROM unnest(v_journey.locked_fields) f)),
      p_step,
      v_version + 1,
      now())
  ON CONFLICT (onboarding_id) DO UPDATE
    SET answers = EXCLUDED.answers,
        step = EXCLUDED.step,
        version = EXCLUDED.version,
        updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object('result', 'saved', 'version', v_version + 1);
END;
$$;

-- ---------------------------------------------------------------------------
-- sign_intake_consent: append one signature. The first one sets the
-- journey's consented_at; signing again appends another row and leaves it.
-- One CREATE audit row per signature, carrying its id only, never the name.
-- Results: null (session not live), signed, closed (submitted, admitted or
-- cancelled; nothing written).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_intake_consent(
  p_session_hash text,
  p_token_hash text,
  p_typed_name text,
  p_text_version int
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := btrim(coalesce(p_typed_name, ''));
  v_ctx record;
  v_journey public.provider_onboardings%ROWTYPE;
  v_consent_id uuid;
BEGIN
  IF v_name = '' OR length(v_name) > 200 OR coalesce(p_text_version, 0) < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_consent';
  END IF;

  SELECT * INTO v_ctx FROM public._intake_session_context(p_session_hash, p_token_hash);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_journey FROM public.provider_onboardings WHERE id = v_ctx.onboarding_id FOR UPDATE;
  IF v_journey.submitted_at IS NOT NULL OR v_journey.admitted_at IS NOT NULL
     OR v_journey.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'closed');
  END IF;

  INSERT INTO public.provider_intake_consents (org_id, onboarding_id, text_version, typed_name, session_id)
    VALUES (v_journey.org_id, v_journey.id, p_text_version, v_name, v_ctx.session_id)
    RETURNING id INTO v_consent_id;

  UPDATE public.provider_onboardings SET consented_at = now()
   WHERE id = v_journey.id AND consented_at IS NULL;

  INSERT INTO public.audit_log (org_id, action_type, entity_type, entity_id, description)
    VALUES (v_journey.org_id, 'CREATE', 'provider_intake_consent', v_consent_id,
            'Provider signed the onboarding consent');

  RETURN jsonb_build_object('result', 'signed');
END;
$$;

REVOKE ALL ON FUNCTION public._intake_session_context(text, text) FROM public, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.read_intake_state(text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_intake_draft(text, text, jsonb, text, int) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.sign_intake_consent(text, text, text, int) FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.read_intake_state(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_intake_draft(text, text, jsonb, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.sign_intake_consent(text, text, text, int) TO service_role;

SELECT public.apply_offboarded_write_freeze();

NOTIFY pgrst, 'reload schema';
