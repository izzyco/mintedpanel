-- The Storage objects the onboarding file cleanup job deletes.
--
--   onboarding_orphan_files  the files no onboarding step will read again
--                            (src/server/jobs/onboardingFileCleanup.ts)
--
-- service_role only. No new table.
--
-- Additive and idempotent. Applying to hosted is an OPERATOR task, after
-- 20261107020000. Verify the OBJECT:
--   SELECT count(*) FROM pg_proc WHERE proname = 'onboarding_orphan_files'; -- 1
--   then run scripts/sql/provider-onboarding-cleanup-smoke.sql.

-- ---------------------------------------------------------------------------
-- onboarding_orphan_files: up to p_limit Storage objects created before
-- p_cutoff that no onboarding step will read again, oldest first, as
-- [{ bucket, path }]. Three kinds, and nothing else:
--   provider-intake-uploads  org/<org>/onboarding/<journey>/<upload>/<file>
--                            whose upload row is missing or removed, or whose
--                            journey is submitted, admitted, cancelled or
--                            gone. A live upload of an open journey stays.
--   provider-documents       org/<org>/provider/<provider>/<upload>/...
--                            where <upload> is an upload of that org's and
--                            provider's journey (any state), the journey is
--                            submitted, admitted or cancelled, and no
--                            provider_documents row has the upload's id.
--   provider-documents       org/<org>/provider/<provider>/<family>/...
--                            where no providers row has <provider>. Cancel
--                            is the only delete of a provider, and her
--                            document rows cascade with it.
-- Every other vault path is never named. Every condition is final (no row
-- comes back, no document row is written for an ended journey), so a file
-- named once stays an orphan. The caller picks a cutoff older than any signed
-- upload URL lives.
-- plpgsql, not sql: CI applies every migration on a Postgres with no storage
-- schema, and a plpgsql body resolves storage.objects only when it runs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.onboarding_orphan_files(p_cutoff timestamptz, p_limit int)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_files jsonb;
BEGIN
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
            AND NOT public._intake_form_closed(j))
  ),
  vault_orphans AS (
    SELECT o.bucket_id, o.name, o.created_at
      FROM public.provider_intake_uploads u
      JOIN public.provider_onboardings j ON j.id = u.onboarding_id
      JOIN storage.objects o
        ON o.bucket_id = 'provider-documents'
       AND o.name LIKE format('org/%s/provider/%s/%s/%%', j.org_id, j.provider_id, u.id)
     WHERE public._intake_form_closed(j)
       AND u.org_id = j.org_id
       AND o.created_at < p_cutoff
       AND NOT EXISTS (SELECT 1 FROM public.provider_documents d WHERE d.id = u.id)
  ),
  -- The same shape the cleanup job accepts, so it never refuses the list.
  gone_provider_orphans AS (
    SELECT o.bucket_id, o.name, o.created_at
      FROM storage.objects o
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN o.name ~ '^org/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/provider/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.+$'
                 THEN split_part(o.name, '/', 4)::uuid
               END AS provider_id) p
     WHERE o.bucket_id = 'provider-documents'
       AND o.created_at < p_cutoff
       AND p.provider_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.providers r WHERE r.id = p.provider_id)
  ),
  batch AS (
    SELECT * FROM holding_orphans
    UNION ALL
    SELECT * FROM vault_orphans
    UNION ALL
    SELECT * FROM gone_provider_orphans
    ORDER BY created_at, name
    LIMIT greatest(coalesce(p_limit, 0), 0)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', b.bucket_id, 'path', b.name)
                            ORDER BY b.created_at, b.name), '[]'::jsonb)
    INTO v_files
    FROM batch b;
  RETURN v_files;
END;
$$;

REVOKE ALL ON FUNCTION public.onboarding_orphan_files(timestamptz, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.onboarding_orphan_files(timestamptz, int) TO service_role;

NOTIFY pgrst, 'reload schema';
