-- Provider onboarding: her documents upload to a holding area and stay
-- removable until Submit. The document vault
-- (provider_documents and the provider-documents bucket) has no delete by
-- design, so a file waits here until Submit copies it in.
--
--   provider-intake-uploads   private Storage bucket, 10 MiB, PDF/PNG/JPEG.
--                             No storage.objects policy names it, so no
--                             client role can read or write it: the
--                             /api/intake routes use the service role, and
--                             only for a path a session-bound RPC returned.
--   provider_intake_uploads   one row per file she sent: its slot, kind, safe
--                             file name, declared size and type, object path,
--                             a COI's expiry, and when it was finished or
--                             removed. Removed rows stay: they are the trail
--                             of what she sent and took back before Submit.
--   begin_intake_upload       a pending upload; the slot's live one is removed
--   read_intake_upload        a live upload and its object path, for finalize
--   finish_intake_upload      the object checked out, so the upload counts
--   remove_intake_upload      removed; the route deletes the object
--   set_intake_upload_expiry  a COI's expiry
--
-- Every RPC resolves the journey from the session and link hashes
-- (_intake_session_context), never from an id the browser sends; an upload
-- id is only ever looked up inside that journey. EXECUTE-granted to
-- service_role alone. No audit_log rows: like a draft save, a held file is
-- not a milestone, and the rows themselves are never deleted.
--
-- Additive and idempotent. Applying to hosted is an OPERATOR task, after
-- 20261106220000. Verify the OBJECTS:
--   SELECT to_regclass('public.provider_intake_uploads');            -- non-null
--   SELECT id, public, file_size_limit FROM storage.buckets
--    WHERE id = 'provider-intake-uploads';                 -- f, 10485760
--   SELECT count(*) FROM pg_proc WHERE proname IN ('begin_intake_upload',
--     'read_intake_upload', 'finish_intake_upload', 'remove_intake_upload',
--     'set_intake_upload_expiry');                                   -- 5
--   then, once 20261106233000 (read_intake_state) is applied too, run
--   scripts/sql/provider-intake-uploads-smoke.sql.

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema absent: skipping the provider-intake-uploads bucket (repo-only rebuild)';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES (
    'provider-intake-uploads',
    'provider-intake-uploads',
    false,
    10485760,
    ARRAY['application/pdf', 'image/png', 'image/jpeg']
  )
  ON CONFLICT (id) DO UPDATE SET
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
END;
$$;

-- Deleting a journey drops its rows here but not their objects. Whoever
-- deletes one removes everything under org/<org>/onboarding/<journey>/ first;
-- the object_path CHECK keeps every object under that prefix.
CREATE TABLE IF NOT EXISTS public.provider_intake_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  onboarding_id uuid NOT NULL,
  slot_key text NOT NULL
    CONSTRAINT provider_intake_uploads_slot_key_check
      CHECK (slot_key ~ '^(cv|diploma|board_cert|coi|other|license:[A-Z]{2})$'),
  -- The slot decides the kind: a license slot holds a state_license, every
  -- other slot the kind it is named for. All six are provider kinds in the
  -- provider_documents doc_type CHECK, which Submit copies into.
  doc_type text NOT NULL
    CONSTRAINT provider_intake_uploads_doc_type_check
      CHECK (doc_type = CASE WHEN slot_key LIKE 'license:%' THEN 'state_license' ELSE slot_key END),
  file_name text NOT NULL
    CONSTRAINT provider_intake_uploads_file_name_check CHECK (file_name ~ '^[A-Za-z0-9._-]{1,100}$'),
  size_bytes bigint NOT NULL
    CONSTRAINT provider_intake_uploads_size_check CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  content_type text NOT NULL
    CONSTRAINT provider_intake_uploads_content_type_check
      CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  object_path text NOT NULL
    CONSTRAINT provider_intake_uploads_object_path_key UNIQUE
    CONSTRAINT provider_intake_uploads_object_path_check
      CHECK (object_path = format('org/%s/onboarding/%s/%s/%s', org_id, onboarding_id, id, file_name)),
  -- Only a COI carries its own date. A license copy takes the form's.
  expires_on date NULL
    CONSTRAINT provider_intake_uploads_expires_check CHECK (expires_on IS NULL OR slot_key = 'coi'),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz NULL,
  removed_at timestamptz NULL,
  CONSTRAINT provider_intake_uploads_onboarding_fkey FOREIGN KEY (org_id, onboarding_id)
    REFERENCES public.provider_onboardings (org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_intake_uploads_one_live_per_slot
  ON public.provider_intake_uploads (onboarding_id, slot_key)
  WHERE removed_at IS NULL;

ALTER TABLE public.provider_intake_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_intake_uploads FROM public, anon, authenticated, service_role;
-- Read-only for the server; every write goes through the RPCs below.
GRANT SELECT ON TABLE public.provider_intake_uploads TO service_role;

-- ---------------------------------------------------------------------------
-- begin_intake_upload: a pending upload for one slot. Results:
--   null      the session is not live under this link
--   started   returns upload_id and object_path, the path the route signs an
--             upload for, and replaced_object_path: the slot's previous live
--             upload (pending or finished) is now removed, and the route
--             deletes that object. Null when the slot was empty.
--   closed    the journey is submitted, admitted or cancelled; nothing written
-- p_file_name is already the storage-safe name (the route runs safeFileName);
-- a bad slot, a kind that isn't the slot's, a size over 10 MB, another file
-- type, or an expiry on anything but a COI raises without echoing a value.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.begin_intake_upload(
  p_session_hash text,
  p_token_hash text,
  p_slot_key text,
  p_doc_type text,
  p_file_name text,
  p_size_bytes bigint,
  p_content_type text,
  p_expires_on date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slot_kind text := CASE WHEN p_slot_key LIKE 'license:%' THEN 'state_license' ELSE p_slot_key END;
  v_ctx record;
  v_journey public.provider_onboardings%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_replaced text;
BEGIN
  IF p_slot_key IS NULL OR p_slot_key !~ '^(cv|diploma|board_cert|coi|other|license:[A-Z]{2})$'
     OR p_doc_type IS DISTINCT FROM v_slot_kind
     OR p_file_name IS NULL OR p_file_name !~ '^[A-Za-z0-9._-]{1,100}$'
     OR p_size_bytes IS NULL OR p_size_bytes < 1 OR p_size_bytes > 10485760
     OR p_content_type IS NULL OR p_content_type NOT IN ('application/pdf', 'image/png', 'image/jpeg')
     OR (p_expires_on IS NOT NULL AND p_slot_key <> 'coi') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_upload';
  END IF;

  SELECT * INTO v_ctx FROM public._intake_session_context(p_session_hash, p_token_hash);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- One upload change per journey at a time, so two windows can't both leave
  -- a live upload in one slot.
  SELECT * INTO v_journey FROM public.provider_onboardings WHERE id = v_ctx.onboarding_id FOR UPDATE;
  IF public._intake_form_closed(v_journey) THEN
    RETURN jsonb_build_object('result', 'closed');
  END IF;

  UPDATE public.provider_intake_uploads
     SET removed_at = now()
   WHERE onboarding_id = v_journey.id AND slot_key = p_slot_key AND removed_at IS NULL
  RETURNING object_path INTO v_replaced;

  v_path := format('org/%s/onboarding/%s/%s/%s', v_journey.org_id, v_journey.id, v_id, p_file_name);
  INSERT INTO public.provider_intake_uploads
    (id, org_id, onboarding_id, slot_key, doc_type, file_name, size_bytes, content_type,
     object_path, expires_on)
    VALUES (v_id, v_journey.org_id, v_journey.id, p_slot_key, p_doc_type, p_file_name,
            p_size_bytes, p_content_type, v_path, p_expires_on);

  RETURN jsonb_build_object(
    'result', 'started',
    'upload_id', v_id,
    'object_path', v_path,
    'replaced_object_path', v_replaced);
END;
$$;

-- ---------------------------------------------------------------------------
-- read_intake_upload: one live (not removed) upload of her journey, with the
-- path and type the route checks the stored object against. Results: null
-- (session not live), found ({ upload, object_path, content_type,
-- finalized }), not_found (no live upload with that id on her journey),
-- closed (submitted, admitted or cancelled).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.read_intake_upload(
  p_session_hash text,
  p_token_hash text,
  p_upload_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx record;
  v_journey public.provider_onboardings%ROWTYPE;
  v_upload public.provider_intake_uploads%ROWTYPE;
BEGIN
  SELECT * INTO v_ctx FROM public._intake_session_context(p_session_hash, p_token_hash);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_journey FROM public.provider_onboardings WHERE id = v_ctx.onboarding_id;
  IF public._intake_form_closed(v_journey) THEN
    RETURN jsonb_build_object('result', 'closed');
  END IF;

  SELECT * INTO v_upload FROM public.provider_intake_uploads
   WHERE id = p_upload_id AND onboarding_id = v_journey.id AND removed_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  RETURN jsonb_build_object(
    'result', 'found',
    'upload', jsonb_build_object(
      'id', v_upload.id,
      'slot_key', v_upload.slot_key,
      'doc_type', v_upload.doc_type,
      'file_name', v_upload.file_name,
      'size_bytes', v_upload.size_bytes,
      'expires_on', v_upload.expires_on),
    'object_path', v_upload.object_path,
    'content_type', v_upload.content_type,
    'finalized', v_upload.finalized_at IS NOT NULL);
END;
$$;

-- ---------------------------------------------------------------------------
-- finish_intake_upload: the route found the object at its path, with the
-- declared size and type, so the upload now counts. p_size_bytes is the size
-- Storage reported; anything but the declared size raises. Finishing twice
-- keeps the first finalized_at. Results: null (session not live), finalized,
-- not_found (no live upload with that id on her journey), closed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finish_intake_upload(
  p_session_hash text,
  p_token_hash text,
  p_upload_id uuid,
  p_size_bytes bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx record;
  v_journey public.provider_onboardings%ROWTYPE;
  v_upload public.provider_intake_uploads%ROWTYPE;
BEGIN
  SELECT * INTO v_ctx FROM public._intake_session_context(p_session_hash, p_token_hash);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_journey FROM public.provider_onboardings WHERE id = v_ctx.onboarding_id FOR UPDATE;
  IF public._intake_form_closed(v_journey) THEN
    RETURN jsonb_build_object('result', 'closed');
  END IF;

  SELECT * INTO v_upload FROM public.provider_intake_uploads
   WHERE id = p_upload_id AND onboarding_id = v_journey.id AND removed_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF p_size_bytes IS DISTINCT FROM v_upload.size_bytes THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'size_mismatch';
  END IF;

  UPDATE public.provider_intake_uploads
     SET finalized_at = coalesce(finalized_at, now())
   WHERE id = v_upload.id;

  RETURN jsonb_build_object('result', 'finalized');
END;
$$;

-- ---------------------------------------------------------------------------
-- remove_intake_upload: she takes a file back. The row is marked removed and
-- the route deletes the object at the returned path. Removing a removed
-- upload answers removed again with the same path, so a retry after a failed
-- delete finishes the job. Results: null (session not live), removed
-- ({ object_path }), not_found (no upload with that id on her journey),
-- closed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_intake_upload(
  p_session_hash text,
  p_token_hash text,
  p_upload_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx record;
  v_journey public.provider_onboardings%ROWTYPE;
  v_path text;
BEGIN
  SELECT * INTO v_ctx FROM public._intake_session_context(p_session_hash, p_token_hash);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_journey FROM public.provider_onboardings WHERE id = v_ctx.onboarding_id FOR UPDATE;
  IF public._intake_form_closed(v_journey) THEN
    RETURN jsonb_build_object('result', 'closed');
  END IF;

  UPDATE public.provider_intake_uploads
     SET removed_at = coalesce(removed_at, now())
   WHERE id = p_upload_id AND onboarding_id = v_journey.id
  RETURNING object_path INTO v_path;
  IF v_path IS NULL THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  RETURN jsonb_build_object('result', 'removed', 'object_path', v_path);
END;
$$;

-- ---------------------------------------------------------------------------
-- set_intake_upload_expiry: a COI's expiry, or null to clear it. Results:
-- null (session not live), saved, not_found (no live upload with that id on
-- her journey), not_dated (the upload isn't a COI; nothing written), closed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_intake_upload_expiry(
  p_session_hash text,
  p_token_hash text,
  p_upload_id uuid,
  p_expires_on date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx record;
  v_journey public.provider_onboardings%ROWTYPE;
  v_upload public.provider_intake_uploads%ROWTYPE;
BEGIN
  SELECT * INTO v_ctx FROM public._intake_session_context(p_session_hash, p_token_hash);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_journey FROM public.provider_onboardings WHERE id = v_ctx.onboarding_id FOR UPDATE;
  IF public._intake_form_closed(v_journey) THEN
    RETURN jsonb_build_object('result', 'closed');
  END IF;

  SELECT * INTO v_upload FROM public.provider_intake_uploads
   WHERE id = p_upload_id AND onboarding_id = v_journey.id AND removed_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_upload.slot_key <> 'coi' THEN
    RETURN jsonb_build_object('result', 'not_dated');
  END IF;

  UPDATE public.provider_intake_uploads SET expires_on = p_expires_on WHERE id = v_upload.id;

  RETURN jsonb_build_object('result', 'saved');
END;
$$;

REVOKE ALL ON FUNCTION public.begin_intake_upload(text, text, text, text, text, bigint, text, date)
  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_intake_upload(text, text, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_intake_upload(text, text, uuid, bigint) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.remove_intake_upload(text, text, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_intake_upload_expiry(text, text, uuid, date) FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_intake_upload(text, text, text, text, text, bigint, text, date)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.read_intake_upload(text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_intake_upload(text, text, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_intake_upload(text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_intake_upload_expiry(text, text, uuid, date) TO service_role;

SELECT public.apply_offboarded_write_freeze();

NOTIFY pgrst, 'reload schema';
