-- Provider onboarding R1, cycle 3: the SSN and the CAQH and PECOS logins she
-- types are saved to the vaults as she leaves each field.
--
--   provider_portal_credentials  one row per (provider, portal): the username
--                                in the clear, the password encrypted under
--                                its own key (never the SSN key, PM decision
--                                9), and the journey that wrote it, so Cancel
--                                can remove it
--   _portal_credentials_key      private: the Supabase Vault secret
--                                'portal_credentials_key', else the GUC
--                                app.settings.portal_credentials_key; raises
--                                when neither is set
--   store_intake_ssn             her SSN into provider_ssn_vault, unless the
--                                journey locked it
--   store_intake_portal_login    one login, replacing any earlier one
--   read_intake_state            also says which logins are on file
--   reveal_portal_credential     staff: an admin of the provider's org, with a
--                                reason, reads one login back; one READ audit
--                                row
--
-- provider_portal_credentials is zero-trust like provider_ssn_vault: RLS on,
-- no policies, no table grant to any client role or to service_role. Only the
-- SECURITY DEFINER RPCs read or write it. The intake RPCs resolve the provider
-- from the session and link hashes (_intake_session_context), never from an
-- id the browser sends, and are EXECUTE-granted to service_role alone.
--
-- Additive and idempotent. Applying to hosted is an OPERATOR task, after
-- 20261106210000. It needs the Vault secret 'portal_credentials_key'
-- (Dashboard: Project Settings, Vault, Add new secret), whose value must not
-- be the SSN key. Until it exists every login store and reveal raises.
-- Verify the OBJECTS:
--   SELECT to_regclass('public.provider_portal_credentials');        -- non-null
--   SELECT count(*) FROM pg_proc WHERE proname IN ('_portal_credentials_key',
--     'store_intake_ssn', 'store_intake_portal_login',
--     'reveal_portal_credential');                                  -- 4
--   then run scripts/sql/provider-intake-secrets-smoke.sql.

CREATE TABLE IF NOT EXISTS public.provider_portal_credentials (
  provider_id uuid NOT NULL,
  portal text NOT NULL
    CONSTRAINT provider_portal_credentials_portal_check CHECK (portal IN ('caqh', 'pecos')),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  username text NOT NULL
    CONSTRAINT provider_portal_credentials_username_check
      CHECK (btrim(username) <> '' AND length(username) <= 100),
  password_ciphertext bytea NOT NULL,
  key_version int NOT NULL DEFAULT 1,
  onboarding_id uuid NULL REFERENCES public.provider_onboardings (id) ON DELETE SET NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_portal_credentials_pkey PRIMARY KEY (provider_id, portal),
  -- (org_id, provider_id): a login can't sit under another org's provider.
  CONSTRAINT provider_portal_credentials_provider_fkey FOREIGN KEY (org_id, provider_id)
    REFERENCES public.providers (org_id, id) ON DELETE CASCADE
);

-- Cancel finds what its journey wrote.
CREATE INDEX IF NOT EXISTS provider_portal_credentials_onboarding_idx
  ON public.provider_portal_credentials (onboarding_id);

ALTER TABLE public.provider_portal_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_portal_credentials FROM public, anon, authenticated, service_role;

-- The same shape as _ssn_vault_key() (20260718020000): Supabase Vault first,
-- then the GUC, fail closed.
CREATE OR REPLACE FUNCTION public._portal_credentials_key()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_key text;
BEGIN
  IF to_regclass('vault.decrypted_secrets') IS NOT NULL THEN
    SELECT ds.decrypted_secret
      INTO v_key
      FROM vault.decrypted_secrets ds
     WHERE ds.name = 'portal_credentials_key';
    v_key := nullif(v_key, '');
  END IF;

  IF v_key IS NULL THEN
    v_key := nullif(current_setting('app.settings.portal_credentials_key', true), '');
  END IF;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Portal credentials key is not configured';
  END IF;

  RETURN v_key;
END;
$$;

-- ---------------------------------------------------------------------------
-- store_intake_ssn: her full SSN into provider_ssn_vault (and
-- providers.ssn_last4) through _ssn_vault_upsert, and the journey's
-- ssn_stored_at. Results:
--   null      the session is not live under this link
--   stored    written; returns ssn_last4
--   locked    an SSN was on file when the journey opened; nothing written
--   closed    the journey is submitted, admitted or cancelled; nothing written
-- p_ssn is 9 digits (the route strips separators); anything else raises
-- without echoing it. The vault row's actor is whoever sent the invite, as
-- with an SSN intake link. One audit row, never the SSN or its last 4.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.store_intake_ssn(
  p_session_hash text,
  p_token_hash text,
  p_ssn text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx record;
  v_journey public.provider_onboardings%ROWTYPE;
  v_actor uuid;
  v_last4 text;
BEGIN
  IF p_ssn IS NULL OR p_ssn !~ '^[0-9]{9}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_ssn';
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
  IF 'ssn' = ANY (v_journey.locked_fields) THEN
    RETURN jsonb_build_object('result', 'locked');
  END IF;

  SELECT created_by INTO v_actor FROM public.provider_intake_invites WHERE id = v_ctx.invite_id;
  v_last4 := public._ssn_vault_upsert(v_ctx.provider_id, v_ctx.org_id, p_ssn, v_actor);

  UPDATE public.provider_onboardings SET ssn_stored_at = now() WHERE id = v_journey.id;

  INSERT INTO public.audit_log (org_id, action_type, entity_type, entity_id, description)
    VALUES (v_ctx.org_id, 'UPDATE', 'provider_ssn_vault', v_ctx.provider_id,
            'Full SSN stored in vault (provider onboarding intake)');

  RETURN jsonb_build_object('result', 'stored', 'ssn_last4', v_last4);
END;
$$;

-- ---------------------------------------------------------------------------
-- store_intake_portal_login: one CAQH or PECOS login, replacing any earlier
-- one for that portal, stamped with the journey that wrote it. Results: null
-- (session not live), stored, closed (submitted, admitted or cancelled;
-- nothing written). A portal other than caqh or pecos, a blank or overlong
-- username (100) or password (200) raises without echoing either. One audit
-- row naming the portal, never the username or password.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.store_intake_portal_login(
  p_session_hash text,
  p_token_hash text,
  p_portal text,
  p_username text,
  p_password text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_username text := btrim(coalesce(p_username, ''));
  v_ctx record;
  v_journey public.provider_onboardings%ROWTYPE;
  v_actor uuid;
BEGIN
  IF p_portal IS NULL OR p_portal NOT IN ('caqh', 'pecos')
     OR v_username = '' OR length(v_username) > 100
     OR coalesce(p_password, '') = '' OR length(p_password) > 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_login';
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

  SELECT created_by INTO v_actor FROM public.provider_intake_invites WHERE id = v_ctx.invite_id;

  INSERT INTO public.provider_portal_credentials
    (provider_id, portal, org_id, username, password_ciphertext, key_version, onboarding_id,
     created_by, updated_by)
    VALUES (
      v_ctx.provider_id, p_portal, v_ctx.org_id, v_username,
      extensions.pgp_sym_encrypt(p_password, public._portal_credentials_key()),
      1, v_journey.id, v_actor, v_actor)
  ON CONFLICT (provider_id, portal) DO UPDATE
    SET username = EXCLUDED.username,
        password_ciphertext = EXCLUDED.password_ciphertext,
        key_version = EXCLUDED.key_version,
        onboarding_id = EXCLUDED.onboarding_id,
        updated_by = EXCLUDED.updated_by,
        updated_at = now();

  INSERT INTO public.audit_log (org_id, action_type, entity_type, entity_id, after, description)
    VALUES (v_ctx.org_id, 'UPDATE', 'provider_portal_credential', v_ctx.provider_id,
            jsonb_build_object('portal', p_portal),
            'Portal login stored (provider onboarding intake)');

  RETURN jsonb_build_object('result', 'stored');
END;
$$;

-- ---------------------------------------------------------------------------
-- read_intake_state: as in 20261106210000, plus logins_on_file
-- ({ caqh, pecos }: whether a login for that portal is on her record).
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
           'submitted', o.submitted_at IS NOT NULL)
    FROM public._intake_session_context(p_session_hash, p_token_hash) c
    JOIN public.provider_intake_invites i ON i.id = c.invite_id
    JOIN public.provider_onboardings o ON o.id = c.onboarding_id
    JOIN public.providers p ON p.id = c.provider_id
    JOIN public.organizations org ON org.id = c.org_id;
$$;

-- ---------------------------------------------------------------------------
-- reveal_portal_credential: staff read one login back (decision D13, the
-- reveal_ssn posture). The caller must be an admin of the provider's org and
-- give a reason. Returns { username, password } once; writes one READ audit
-- row with the portal and the reason, never the username or password.
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

  INSERT INTO public.audit_log (org_id, user_id, action_type, entity_type, entity_id, description, after)
    VALUES (v_org, v_uid, 'READ', 'provider_portal_credential', p_provider_id,
            'Portal login revealed (admin click-to-reveal)',
            jsonb_build_object('portal', p_portal, 'justification', v_just));

  RETURN jsonb_build_object('username', v_row.username, 'password', v_password);
END;
$$;

REVOKE ALL ON FUNCTION public._portal_credentials_key() FROM public, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.store_intake_ssn(text, text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_intake_portal_login(text, text, text, text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_intake_state(text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.reveal_portal_credential(uuid, text, text) FROM public, anon, service_role;

GRANT EXECUTE ON FUNCTION public.store_intake_ssn(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_intake_portal_login(text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_intake_state(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reveal_portal_credential(uuid, text, text) TO authenticated;

SELECT public.apply_offboarded_write_freeze();

NOTIFY pgrst, 'reload schema';
