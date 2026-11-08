-- Provider onboarding R1, cycle 1: the onboarding record (journey).
--
-- provider_onboardings holds one row per onboarding journey: opened by an
-- invite (or by a resend when no journey is open), ended by Admit or Cancel
-- (later cycles). Every later step hangs off it: drafts, consent, held
-- uploads, Submit. "Onboarding open" lives here, never in providers.status,
-- which billing reads as "not seeing patients yet".
--   source / external_ref  who opened it (staff today; practice and an outside
--                          system later) and that system's own id
--   created_record         the invite created the provider record
--   locked_fields          which of ssn, npi, date_of_birth were on file when
--                          the journey opened; the provider can't change them
--   *_at / *_by            milestones, written only by SECURITY DEFINER RPCs
-- One open journey per provider (partial unique index). Org members read
-- under RLS; nobody but service_role writes the table directly.
--
-- Also here:
--   provider_intake_invites.onboarding_id  the journey an invite belongs to,
--                                          backfilled for existing invites
--   provider_intake_invites.delivery,      what happened to the email
--   provider_intake_codes.delivery         (sent | sandbox | failed), written
--                                          once by record_intake_email_delivery
--   provider_intake_settings               one row; paused = true makes every
--                                          intake and invite route answer 503
--   _match_onboarding_provider             the one rule for "is this person
--                                          already in the org"
--   create/resend_provider_intake_invite   open or reuse the journey; one
--                                          email or NPI match outside the
--                                          group joins that group, no email;
--                                          two matches write nothing
--   issue_intake_code                      also returns code_id
--   revoke_intake_on_provider_change       an email change or termination
--                                          revokes the open invite and its
--                                          sessions; the journey stays open
--
-- Additive and idempotent. Applying to hosted is an OPERATOR task.
-- Verify the OBJECTS:
--   SELECT to_regclass('public.provider_onboardings'),
--          to_regclass('public.provider_intake_settings');          -- non-null
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name IN ('provider_intake_invites', 'provider_intake_codes')
--      AND column_name IN ('onboarding_id', 'delivery');            -- 3
--   SELECT count(*) FROM pg_proc WHERE proname IN ('intake_paused',
--     'record_intake_email_delivery', '_match_onboarding_provider',
--     'revoke_intake_on_provider_change');                         -- 4
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'public.providers'::regclass
--      AND tgname = 'revoke_intake_on_provider_change';            -- 1 row
--   then run scripts/sql/provider-onboarding-smoke.sql.

CREATE TABLE IF NOT EXISTS public.provider_onboardings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  provider_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'staff'
    CONSTRAINT provider_onboardings_source_check CHECK (source IN ('staff', 'practice', 'api')),
  external_ref text NULL,
  created_record boolean NOT NULL DEFAULT false,
  locked_fields text[] NOT NULL DEFAULT '{}'
    CONSTRAINT provider_onboardings_locked_fields_check
      CHECK (locked_fields <@ ARRAY['ssn', 'npi', 'date_of_birth']::text[]),
  created_by uuid NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  consented_at timestamptz NULL,
  ssn_stored_at timestamptz NULL,
  submitted_at timestamptz NULL,
  admitted_at timestamptz NULL,
  admitted_by uuid NULL,
  admitted_facility_id uuid NULL,
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL,
  last_help_at timestamptz NULL,
  last_contacted_at timestamptz NULL,
  submitted_email_delivery text NULL
    CONSTRAINT provider_onboardings_submitted_email_delivery_check
      CHECK (submitted_email_delivery IN ('sent', 'sandbox', 'failed')),
  CONSTRAINT provider_onboardings_one_ending CHECK (admitted_at IS NULL OR cancelled_at IS NULL),
  -- (org_id, ...) keys: a journey can't name another org's provider or facility.
  CONSTRAINT provider_onboardings_provider_fkey FOREIGN KEY (org_id, provider_id)
    REFERENCES public.providers (org_id, id) ON DELETE CASCADE,
  CONSTRAINT provider_onboardings_admitted_facility_fkey FOREIGN KEY (org_id, admitted_facility_id)
    REFERENCES public.facilities (org_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_onboardings_one_open
  ON public.provider_onboardings (provider_id)
  WHERE admitted_at IS NULL AND cancelled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS provider_onboardings_external_ref_key
  ON public.provider_onboardings (org_id, source, external_ref)
  WHERE external_ref IS NOT NULL;
-- Org reads, and the (org_id, provider_id) cascade from providers.
CREATE INDEX IF NOT EXISTS provider_onboardings_org_provider_idx
  ON public.provider_onboardings (org_id, provider_id);

ALTER TABLE public.provider_onboardings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_onboardings FROM public, anon, authenticated;
GRANT SELECT ON TABLE public.provider_onboardings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.provider_onboardings TO service_role;

DROP POLICY IF EXISTS provider_onboardings_select ON public.provider_onboardings;
CREATE POLICY provider_onboardings_select ON public.provider_onboardings
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.user_org_ids()));

ALTER TABLE public.provider_intake_invites
  ADD COLUMN IF NOT EXISTS onboarding_id uuid NULL REFERENCES public.provider_onboardings (id),
  ADD COLUMN IF NOT EXISTS delivery text NULL
    CONSTRAINT provider_intake_invites_delivery_check
      CHECK (delivery IN ('sent', 'sandbox', 'failed'));
CREATE INDEX IF NOT EXISTS provider_intake_invites_onboarding_idx
  ON public.provider_intake_invites (onboarding_id);

ALTER TABLE public.provider_intake_codes
  ADD COLUMN IF NOT EXISTS delivery text NULL
    CONSTRAINT provider_intake_codes_delivery_check
      CHECK (delivery IN ('sent', 'sandbox', 'failed'));

-- Backfill: one journey per provider that already has an invite, opened at
-- that provider's first invite, and every one of its invites linked to it.
-- created_record is false because nothing recorded which invites created
-- their provider, and a false never holds work back. A re-run finds every
-- invite linked and every such provider with a journey, so it changes nothing.
INSERT INTO public.provider_onboardings
  (org_id, provider_id, source, created_record, locked_fields, created_by, opened_at)
SELECT DISTINCT ON (i.provider_id)
       i.org_id, i.provider_id, 'staff', false, '{}', i.created_by, i.created_at
  FROM public.provider_intake_invites i
 WHERE NOT EXISTS (
         SELECT 1 FROM public.provider_onboardings o WHERE o.provider_id = i.provider_id)
 ORDER BY i.provider_id, i.created_at, i.id;

UPDATE public.provider_intake_invites i
   SET onboarding_id = o.id
  FROM public.provider_onboardings o
 WHERE i.onboarding_id IS NULL
   AND o.provider_id = i.provider_id
   AND o.admitted_at IS NULL
   AND o.cancelled_at IS NULL;

-- The off switch. The operator flips it with SQL:
--   UPDATE public.provider_intake_settings SET paused = true;
CREATE TABLE IF NOT EXISTS public.provider_intake_settings (
  id boolean PRIMARY KEY DEFAULT true CONSTRAINT provider_intake_settings_one_row CHECK (id),
  paused boolean NOT NULL DEFAULT false
);
INSERT INTO public.provider_intake_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.provider_intake_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_intake_settings FROM public, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.provider_intake_settings TO service_role;

-- A missing row reads as not paused: the switch only ever turns intake off.
CREATE OR REPLACE FUNCTION public.intake_paused()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((SELECT paused FROM public.provider_intake_settings WHERE id), false);
$$;

-- ---------------------------------------------------------------------------
-- _match_onboarding_provider: the one rule for "is this person already in
-- the org". Every provider in the org with that email (any case) or that NPI
-- counts. Always one row:
--   none         nobody matches
--   in_group     one provider, with a current (no end date) assignment to
--                p_group_id
--   other_group  one provider, without one
--   conflict     two or more providers (the email is one person's and the
--                NPI another's, or two records share the email); joining
--                either would be a guess
-- provider_id is set only for in_group and other_group.
-- Private: only the SECURITY DEFINER RPCs call it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._match_onboarding_provider(
  p_org_id uuid,
  p_email text,
  p_npi text,
  p_group_id uuid
) RETURNS TABLE (verdict text, provider_id uuid)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE WHEN m.n = 0 THEN 'none'
              WHEN m.n > 1 THEN 'conflict'
              WHEN m.in_group THEN 'in_group'
              ELSE 'other_group' END,
         CASE WHEN m.n = 1 THEN m.ids[1] END
    FROM (
      SELECT count(*) AS n,
             array_agg(p.id) AS ids,
             bool_or(EXISTS (
               SELECT 1 FROM public.provider_group_assignments a
                WHERE a.provider_id = p.id AND a.group_id = p_group_id AND a.end_date IS NULL
             )) AS in_group
        FROM public.providers p
       WHERE p.org_id = p_org_id
         AND (lower(p.email) = lower(p_email) OR p.npi = p_npi)
    ) m;
$$;

-- ---------------------------------------------------------------------------
-- create_provider_intake_invite: provider + primary group assignment + journey
-- + invite + audit rows in one transaction.
-- p_input: { first_name, last_name, email, group_id, npi?, start_date?,
--            source?, external_ref? }
-- Results, from _match_onboarding_provider:
--   created      nobody matched: new provider; returns provider_id,
--                invite_id, onboarding_id, practice_name
--   duplicate    the match already has a current assignment to the group;
--                nothing written
--   added_group  the match has no current assignment to the group: one
--                non-primary assignment (an ended one is reopened), one audit
--                row, no invite and no email
--   conflict     the email and NPI point at different providers; nothing
--                written
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_provider_intake_invite(
  p_org_id uuid,
  p_actor_id uuid,
  p_actor_name text,
  p_input jsonb,
  p_token_hash text,
  p_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_first text := nullif(btrim(coalesce(p_input->>'first_name', '')), '');
  v_last text := nullif(btrim(coalesce(p_input->>'last_name', '')), '');
  v_email text := lower(nullif(btrim(coalesce(p_input->>'email', '')), ''));
  v_npi text := nullif(btrim(coalesce(p_input->>'npi', '')), '');
  v_group_id uuid := nullif(p_input->>'group_id', '')::uuid;
  v_start date := nullif(p_input->>'start_date', '')::date;
  v_source text := coalesce(nullif(btrim(coalesce(p_input->>'source', '')), ''), 'staff');
  v_external_ref text := nullif(btrim(coalesce(p_input->>'external_ref', '')), '');
  v_verdict text;
  v_existing uuid;
  v_provider_id uuid;
  v_onboarding_id uuid;
  v_invite_id uuid;
BEGIN
  IF v_first IS NULL OR v_last IS NULL OR v_email IS NULL OR v_group_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_input');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.provider_groups WHERE id = v_group_id AND org_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('result', 'group_not_found');
  END IF;

  -- Serialize invites for the same address, and for the same NPI, in the same
  -- org, so two simultaneous invites can't both miss the match. Always email
  -- first, then NPI, so two invites can't wait on each other.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':email:' || v_email, 0));
  IF v_npi IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':npi:' || v_npi, 0));
  END IF;

  SELECT m.verdict, m.provider_id INTO v_verdict, v_existing
    FROM public._match_onboarding_provider(p_org_id, v_email, v_npi, v_group_id) m;

  IF v_verdict = 'conflict' THEN
    RETURN jsonb_build_object('result', 'conflict');
  END IF;

  IF v_verdict = 'in_group' THEN
    RETURN jsonb_build_object('result', 'duplicate', 'provider_id', v_existing);
  END IF;

  IF v_verdict = 'other_group' THEN
    INSERT INTO public.provider_group_assignments (org_id, provider_id, group_id, is_primary)
      VALUES (p_org_id, v_existing, v_group_id, false)
      ON CONFLICT (provider_id, group_id) DO UPDATE SET end_date = NULL;

    INSERT INTO public.audit_log
      (org_id, user_id, user_name, action_type, entity_type, entity_id, after, description)
      VALUES (p_org_id, p_actor_id, p_actor_name, 'UPDATE', 'provider', v_existing,
              jsonb_build_object('group_id', v_group_id, 'is_primary', false),
              'Added provider to a group from an onboarding invite');

    RETURN jsonb_build_object('result', 'added_group', 'provider_id', v_existing);
  END IF;

  -- group_id is the frozen mirror of the primary assignment, set on create
  -- exactly as src/services/providers.ts does.
  INSERT INTO public.providers
    (org_id, first_name, last_name, email, npi, start_date, status, group_id)
    VALUES (p_org_id, v_first, v_last, v_email, v_npi, v_start, 'onboarding', v_group_id)
    RETURNING id INTO v_provider_id;

  INSERT INTO public.provider_group_assignments (org_id, provider_id, group_id, is_primary)
    VALUES (p_org_id, v_provider_id, v_group_id, true);

  INSERT INTO public.provider_onboardings
    (org_id, provider_id, source, external_ref, created_record, created_by)
    VALUES (p_org_id, v_provider_id, v_source, v_external_ref, true, p_actor_id)
    RETURNING id INTO v_onboarding_id;

  INSERT INTO public.provider_intake_invites
    (org_id, provider_id, email, token_hash, created_by, expires_at, onboarding_id)
    VALUES (p_org_id, v_provider_id, v_email, p_token_hash, p_actor_id, p_expires_at, v_onboarding_id)
    RETURNING id INTO v_invite_id;

  INSERT INTO public.audit_log (org_id, user_id, user_name, action_type, entity_type, entity_id, description)
    VALUES
      (p_org_id, p_actor_id, p_actor_name, 'CREATE', 'provider', v_provider_id,
       'Created provider from an onboarding invite'),
      (p_org_id, p_actor_id, p_actor_name, 'CREATE', 'provider_intake_invite', v_invite_id,
       'Invited provider to onboarding');

  RETURN jsonb_build_object(
    'result', 'created',
    'provider_id', v_provider_id,
    'invite_id', v_invite_id,
    'onboarding_id', v_onboarding_id,
    'practice_name', (SELECT name FROM public.organizations WHERE id = p_org_id)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- resend_provider_intake_invite: replace the provider's unrevoked invite (even
-- an expired one) with a new token. 10-minute cooldown from the last send.
-- Revoking the old invite also ends any session opened from it. A provider in
-- the org with an email but no open invite (added by hand or by import) gets
-- a first invite, with no cooldown, so a duplicate is never a dead end.
-- The new invite goes to the provider record's CURRENT email (the old
-- invite's address only when the record has none), so a mistyped address is
-- fixed by correcting the record and resending.
-- The new invite joins the provider's open journey. With none open (never
-- had one, or the last was admitted or cancelled) it opens one, which locks
-- whichever of SSN, NPI and date of birth are on file right now.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resend_provider_intake_invite(
  p_org_id uuid,
  p_actor_id uuid,
  p_actor_name text,
  p_provider_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old public.provider_intake_invites%ROWTYPE;
  v_invite_id uuid;
  v_email text;
  v_first text;
  v_onboarding_id uuid;
  v_opened boolean := false;
BEGIN
  -- One resend per provider at a time. Without this, a double submit on the
  -- first-invite path has both callers miss the open-invite lookup and the
  -- second hits provider_intake_invites_one_open (23505, a 500) instead of
  -- answering cooldown.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('provider_intake_invite:' || p_provider_id::text, 0));

  SELECT lower(nullif(btrim(email), '')), first_name INTO v_email, v_first
    FROM public.providers
   WHERE id = p_provider_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- No row leaves v_old all NULL, so v_old.id IS NULL marks a first invite.
  SELECT * INTO v_old
    FROM public.provider_intake_invites
   WHERE org_id = p_org_id AND provider_id = p_provider_id AND revoked_at IS NULL
   FOR UPDATE;

  IF FOUND THEN
    IF v_old.created_at > now() - interval '10 minutes' THEN
      RETURN jsonb_build_object('result', 'cooldown');
    END IF;
    v_email := coalesce(v_email, v_old.email);

    UPDATE public.provider_intake_invites SET revoked_at = now() WHERE id = v_old.id;

    INSERT INTO public.audit_log (org_id, user_id, user_name, action_type, entity_type, entity_id, description)
      VALUES (p_org_id, p_actor_id, p_actor_name, 'UPDATE', 'provider_intake_invite', v_old.id,
              'Revoked onboarding invite (replaced by a resend)');
  ELSIF v_email IS NULL THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  SELECT id INTO v_onboarding_id
    FROM public.provider_onboardings
   WHERE provider_id = p_provider_id AND admitted_at IS NULL AND cancelled_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.provider_onboardings
      (org_id, provider_id, created_record, locked_fields, created_by)
    SELECT p_org_id, p.id, false,
           array_remove(ARRAY[
             CASE WHEN p.ssn_last4 IS NOT NULL
                    OR EXISTS (SELECT 1 FROM public.provider_ssn_vault v WHERE v.provider_id = p.id)
                  THEN 'ssn' END,
             CASE WHEN nullif(btrim(p.npi), '') IS NOT NULL THEN 'npi' END,
             CASE WHEN p.date_of_birth IS NOT NULL THEN 'date_of_birth' END
           ], NULL),
           p_actor_id
      FROM public.providers p
     WHERE p.id = p_provider_id
    RETURNING id INTO v_onboarding_id;
    v_opened := true;
  END IF;

  INSERT INTO public.provider_intake_invites
    (org_id, provider_id, email, token_hash, created_by, expires_at, onboarding_id)
    VALUES (p_org_id, p_provider_id, v_email, p_token_hash, p_actor_id, p_expires_at, v_onboarding_id)
    RETURNING id INTO v_invite_id;

  INSERT INTO public.audit_log (org_id, user_id, user_name, action_type, entity_type, entity_id, description)
    VALUES (p_org_id, p_actor_id, p_actor_name, 'CREATE', 'provider_intake_invite', v_invite_id,
            CASE WHEN v_opened THEN 'Invited existing provider to onboarding'
                 ELSE 'Resent onboarding invite' END);

  RETURN jsonb_build_object(
    'result', 'resent',
    'invite_id', v_invite_id,
    'onboarding_id', v_onboarding_id,
    'email', v_email,
    'first_name', v_first,
    'practice_name', (SELECT name FROM public.organizations WHERE id = p_org_id)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- issue_intake_code: store a new code for a live invite, within 3 per 10
-- minutes and 10 per 24 hours. Any unused earlier code is consumed. The caller
-- emails the code only when send = true, and answers the browser the same way
-- either way. code_id is for record_intake_email_delivery.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_intake_code(p_token_hash text, p_code_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite public.provider_intake_invites%ROWTYPE;
  v_code_id uuid;
BEGIN
  SELECT * INTO v_invite
    FROM public.provider_intake_invites
   WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('send', false);
  END IF;

  IF (SELECT count(*) FROM public.provider_intake_codes
       WHERE invite_id = v_invite.id AND created_at > now() - interval '10 minutes') >= 3
     OR (SELECT count(*) FROM public.provider_intake_codes
       WHERE invite_id = v_invite.id AND created_at > now() - interval '24 hours') >= 10 THEN
    RETURN jsonb_build_object('send', false);
  END IF;

  UPDATE public.provider_intake_codes
     SET consumed_at = now()
   WHERE invite_id = v_invite.id AND consumed_at IS NULL;

  INSERT INTO public.provider_intake_codes (invite_id, code_hash, expires_at)
    VALUES (v_invite.id, p_code_hash, now() + interval '10 minutes')
    RETURNING id INTO v_code_id;

  RETURN jsonb_build_object(
    'send', true,
    'code_id', v_code_id,
    'email', v_invite.email,
    'practice_name', (SELECT name FROM public.organizations WHERE id = v_invite.org_id),
    'first_name', (SELECT first_name FROM public.providers WHERE id = v_invite.provider_id)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- record_intake_email_delivery: what happened to one email. p_kind 'invite'
-- (an invite id), 'code' (a code id) or 'submitted' (a journey id, for the
-- Submit confirmation). Sets the delivery only while it is still NULL, so a
-- retried request never overwrites the first outcome. Returns whether it set
-- one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_intake_email_delivery(
  p_kind text,
  p_id uuid,
  p_delivery text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_delivery IS NULL OR p_delivery NOT IN ('sent', 'sandbox', 'failed') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_delivery';
  END IF;

  IF p_kind = 'invite' THEN
    UPDATE public.provider_intake_invites SET delivery = p_delivery
     WHERE id = p_id AND delivery IS NULL;
  ELSIF p_kind = 'code' THEN
    UPDATE public.provider_intake_codes SET delivery = p_delivery
     WHERE id = p_id AND delivery IS NULL;
  ELSIF p_kind = 'submitted' THEN
    UPDATE public.provider_onboardings SET submitted_email_delivery = p_delivery
     WHERE id = p_id AND submitted_email_delivery IS NULL;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_kind';
  END IF;

  RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- revoke_intake_on_provider_change: when a provider's email changes (case and
-- surrounding spaces ignored) or she becomes terminated, her unrevoked invite
-- and its sessions are revoked, with one audit row per invite. The journey
-- stays open, so staff can resend to the new address. SECURITY DEFINER
-- because staff edit providers under RLS, with no grant on the intake tables.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_intake_on_provider_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  WITH revoked AS (
    UPDATE public.provider_intake_invites
       SET revoked_at = now()
     WHERE provider_id = NEW.id AND revoked_at IS NULL
    RETURNING id
  ), sessions AS (
    UPDATE public.provider_intake_sessions
       SET revoked_at = now()
     WHERE invite_id IN (SELECT id FROM revoked) AND revoked_at IS NULL
  )
  INSERT INTO public.audit_log (org_id, user_id, action_type, entity_type, entity_id, description)
  SELECT NEW.org_id, auth.uid(), 'UPDATE', 'provider_intake_invite', r.id,
         CASE WHEN NEW.status = 'terminated' AND OLD.status IS DISTINCT FROM 'terminated'
              THEN 'Revoked onboarding invite (provider terminated)'
              ELSE 'Revoked onboarding invite (provider email changed)' END
    FROM revoked r;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER revoke_intake_on_provider_change
  AFTER UPDATE OF email, status ON public.providers
  FOR EACH ROW
  WHEN (lower(nullif(btrim(OLD.email), '')) IS DISTINCT FROM lower(nullif(btrim(NEW.email), ''))
        OR (NEW.status = 'terminated' AND OLD.status IS DISTINCT FROM 'terminated'))
  EXECUTE FUNCTION public.revoke_intake_on_provider_change();

REVOKE ALL ON FUNCTION public.intake_paused() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public._match_onboarding_provider(uuid, text, text, uuid) FROM public, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_provider_intake_invite(uuid, uuid, text, jsonb, text, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.resend_provider_intake_invite(uuid, uuid, text, uuid, text, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.issue_intake_code(text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_intake_email_delivery(text, uuid, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_intake_on_provider_change() FROM public, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.intake_paused() TO service_role;
GRANT EXECUTE ON FUNCTION public.create_provider_intake_invite(uuid, uuid, text, jsonb, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.resend_provider_intake_invite(uuid, uuid, text, uuid, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.issue_intake_code(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_intake_email_delivery(text, uuid, text) TO service_role;

SELECT public.apply_offboarded_write_freeze();

NOTIFY pgrst, 'reload schema';
