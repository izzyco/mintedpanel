-- MINT-108 notification_sends: the per-recipient send record behind
-- scheduled notification jobs (src/server/jobs/), starting with the follow-up
-- digest (followup-digest).
--
-- There is no run ledger (MINT-106): every call to a job runs it, and the
-- digest is called every hour (a GitHub Actions schedule, plus one daily
-- Vercel cron as a backup; the two may overlap). So a job that emails people
-- claims each send here first, keyed on (org_id, job, slot,
-- recipient_user_id), and sends only what it claimed. The slot is what the
-- send is once-only for: for the digest, the scheduled send, the org's LOCAL
-- DATE (YYYY-MM-DD) or YYYY-MM-DD:2 for a twice-a-day digest's second send.
-- So no rerun, later hourly call, overlapping call, changed send hour, zone
-- or frequency sends a recipient a scheduled send twice.
--
-- One row per key: the primary key is the idempotency guarantee (it leads
-- with org_id, so it also serves the organizations FK). A send that may have
-- been delivered (a network error or timeout, a SendGrid 5xx or 408, an
-- unexplained error, a function that died mid-send) stays `claimed` and is
-- never resent: SendGrid has no idempotency key. Only a definite rejection
-- (a 4xx other than 408, invalid input, misconfiguration: nothing was
-- accepted) is recorded `failed`, and a later call may claim that row again.
--
-- No PHI, ever: ids, the slot, the outcome and a timestamp. Never an
-- address, a name, a subject or a body.
--
-- service_role only: RLS on with no policies, nothing granted to anon or
-- authenticated. service_role may read the table and writes only through the
-- two SECURITY DEFINER RPCs below.
--
-- Additive and re-runnable. REPO-ONLY until an operator applies it, staging
-- first, after 20261101100000. Until then the digest job cannot claim a send,
-- so it sends nothing.
-- Verify the OBJECTS, not a ledger filename (supabase-migrations skill):
--   SELECT to_regclass('public.notification_sends');                 -- non-null
--   SELECT proname, pg_get_function_identity_arguments(oid), prosecdef
--     FROM pg_proc WHERE proname IN ('claim_notification_send',
--       'finish_notification_send');
--     -> p_job text, p_slot text, p_org_id uuid, p_recipient_user_id uuid | true
--     -> p_job text, p_slot text, p_org_id uuid, p_recipient_user_id uuid, p_outcome text | true
--   Then run supabase/tests/mint108-notification-sends.sql (rolled back).

CREATE TABLE IF NOT EXISTS public.notification_sends (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job text NOT NULL,
  slot text NOT NULL,
  -- An actor id, not a foreign key (the notification_sequences.updated_by
  -- convention): removing a profile must not rewrite the send history.
  recipient_user_id uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'claimed',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_sends_pkey PRIMARY KEY (org_id, job, slot, recipient_user_id),
  -- The registered job name, and a short key: never data.
  CONSTRAINT notification_sends_job_check CHECK (job ~ '^[a-z][a-z0-9-]{0,47}$'),
  CONSTRAINT notification_sends_slot_check CHECK (slot ~ '^[0-9A-Za-z:_-]{1,64}$'),
  CONSTRAINT notification_sends_outcome_check CHECK (outcome IN ('claimed', 'sent', 'failed'))
);

ALTER TABLE public.notification_sends ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.notification_sends FROM public, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.notification_sends TO service_role;

COMMENT ON TABLE public.notification_sends IS
  'Per-recipient send record for scheduled notification jobs (MINT-108). One row per (org_id, job, slot, recipient_user_id): no later call resends for the same slot. Ids, the slot, the outcome and a timestamp, never PHI. service_role only; written by claim_notification_send and finish_notification_send.';
COMMENT ON COLUMN public.notification_sends.job IS
  'The registered job name that sent it, e.g. followup-digest.';
COMMENT ON COLUMN public.notification_sends.slot IS
  'What a send is once-only for, within (org, job, recipient). For followup-digest, the scheduled send: the org''s local date the digest is for (YYYY-MM-DD), or YYYY-MM-DD:2 for a twice-a-day digest''s second send.';
COMMENT ON COLUMN public.notification_sends.recipient_user_id IS
  'The org member the message went to (an actor id, not a foreign key). Never an address.';
COMMENT ON COLUMN public.notification_sends.outcome IS
  'claimed (the job is sending it, or it may have been delivered: never resent), sent, or failed (a definite rejection: a 4xx other than 408, invalid input, misconfiguration; a later call may claim it again).';
COMMENT ON COLUMN public.notification_sends.claimed_at IS
  'When the send was last claimed.';

-- ---------------------------------------------------------------------------
-- claim_notification_send: claim one recipient's send for a slot. True when
-- the caller now holds it (a new key, or one whose last attempt failed);
-- false when it is already claimed or sent, so the caller skips it. Two
-- concurrent claims: one wins, the other waits for it and gets false.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_notification_send(
  p_job text,
  p_slot text,
  p_org_id uuid,
  p_recipient_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.notification_sends AS s (org_id, job, slot, recipient_user_id)
  VALUES (p_org_id, p_job, p_slot, p_recipient_user_id)
  ON CONFLICT (org_id, job, slot, recipient_user_id) DO UPDATE
    SET outcome = 'claimed', claimed_at = now()
    WHERE s.outcome = 'failed';
  RETURN FOUND;
END;
$function$;

-- ---------------------------------------------------------------------------
-- finish_notification_send: record a claimed send `sent`, or `failed` (a
-- definite rejection). False when the row is not claimed. A send that may
-- have been delivered is never finished: it stays claimed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finish_notification_send(
  p_job text,
  p_slot text,
  p_org_id uuid,
  p_recipient_user_id uuid,
  p_outcome text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'finish_notification_send: outcome must be sent or failed'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.notification_sends
     SET outcome = p_outcome
   WHERE org_id = p_org_id
     AND job = p_job
     AND slot = p_slot
     AND recipient_user_id = p_recipient_user_id
     AND outcome = 'claimed';

  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_notification_send(text, text, uuid, uuid)
  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_notification_send(text, text, uuid, uuid, text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_send(text, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_notification_send(text, text, uuid, uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.claim_notification_send(text, text, uuid, uuid) IS
  'MINT-108: claim one recipient''s send for a slot (for followup-digest, the scheduled send). True when the caller now holds it (new, or its last attempt failed); false when it is already claimed or sent. service_role only.';
COMMENT ON FUNCTION public.finish_notification_send(text, text, uuid, uuid, text) IS
  'MINT-108: record a claimed send sent, or failed (a definite rejection, so a later call may claim it again). False when the row is not claimed. service_role only.';

NOTIFY pgrst, 'reload schema';
