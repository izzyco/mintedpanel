-- Smoke test for onboarding_orphan_files in
-- 20261107040000_onboarding_review_fixes.sql: which Storage objects the
-- onboarding file cleanup job deletes. Run it after the migration is applied,
-- as the postgres user (on a local `supabase start`, or the SQL editor on
-- staging):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/provider-onboarding-cleanup-smoke.sql
--
-- Everything runs in one transaction and is rolled back, so it leaves no rows.
-- The Storage objects here are catalog rows only (no file behind them): the
-- function reads storage.objects, and the job deletes through Storage. Any
-- failed check raises and stops the script.
BEGIN;

CREATE FUNCTION pg_temp.journey(p_org uuid, p_group uuid, p_state text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_provider uuid;
  v_journey uuid;
BEGIN
  INSERT INTO public.providers (org_id, first_name, last_name, status, group_id)
    VALUES (p_org, 'Smoke', p_state, 'active', p_group) RETURNING id INTO v_provider;
  INSERT INTO public.provider_onboardings (org_id, provider_id, created_record, submitted_at, admitted_at, cancelled_at)
    VALUES (p_org, v_provider, true,
            CASE WHEN p_state IN ('submitted', 'admitted') THEN now() END,
            CASE WHEN p_state = 'admitted' THEN now() END,
            CASE WHEN p_state = 'cancelled' THEN now() END)
    RETURNING id INTO v_journey;
  RETURN v_journey;
END;
$$;

CREATE FUNCTION pg_temp.upload(p_journey uuid, p_slot text, p_state text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid := (SELECT org_id FROM public.provider_onboardings WHERE id = p_journey);
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.provider_intake_uploads
    (id, org_id, onboarding_id, slot_key, doc_type, file_name, size_bytes, content_type, object_path,
     finalized_at, removed_at)
    VALUES (v_id, v_org, p_journey, p_slot,
            CASE WHEN p_slot LIKE 'license:%' THEN 'state_license' ELSE p_slot END,
            'file.pdf', 100, 'application/pdf',
            format('org/%s/onboarding/%s/%s/file.pdf', v_org, p_journey, v_id),
            CASE WHEN p_state <> 'pending' THEN now() END,
            CASE WHEN p_state = 'removed' THEN now() END);
  RETURN v_id;
END;
$$;

-- The holding path of an upload, and the vault path Submit copies it to.
CREATE FUNCTION pg_temp.held(p_upload uuid) RETURNS text
LANGUAGE sql AS $$ SELECT object_path FROM public.provider_intake_uploads WHERE id = p_upload $$;

CREATE FUNCTION pg_temp.vault(p_upload uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT format('org/%s/provider/%s/%s/1/file.pdf', j.org_id, j.provider_id, u.id)
    FROM public.provider_intake_uploads u JOIN public.provider_onboardings j ON j.id = u.onboarding_id
   WHERE u.id = p_upload
$$;

CREATE FUNCTION pg_temp.object(p_bucket text, p_name text, p_age interval) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO storage.objects (bucket_id, name, created_at) VALUES (p_bucket, p_name, now() - p_age);
  RETURN jsonb_build_object('bucket', p_bucket, 'path', p_name);
END;
$$;

-- The files under one org's paths, in the order given. A database may hold
-- real orphans of its own; the checks look only at this smoke's org.
CREATE FUNCTION pg_temp.mine(p_files jsonb, p_org uuid) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT coalesce(jsonb_agg(f ORDER BY n), '[]'::jsonb)
    FROM jsonb_array_elements(p_files) WITH ORDINALITY AS e(f, n)
   WHERE f->>'path' LIKE format('org/%s/%%', p_org)
$$;

CREATE FUNCTION pg_temp.sorted(p_files jsonb) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT coalesce(jsonb_agg(f ORDER BY f->>'bucket', f->>'path'), '[]'::jsonb) FROM jsonb_array_elements(p_files) f
$$;

DO $$
DECLARE
  v_org uuid;
  v_group uuid;
  v_open uuid;
  v_submitted uuid;
  v_admitted uuid;
  v_cancelled uuid;
  v_other uuid;
  v_up uuid;
  v_kept_doc uuid;
  v_old interval := interval '4 hours';
  v_young interval := interval '1 hour';
  v_cutoff timestamptz := now() - interval '3 hours';
  v_orphans jsonb := '[]';
  r jsonb;
  v_state text;
BEGIN
  INSERT INTO public.organizations (name) VALUES ('Smoke Cleanup') RETURNING id INTO v_org;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group') RETURNING id INTO v_group;
  v_open := pg_temp.journey(v_org, v_group, 'open');
  v_submitted := pg_temp.journey(v_org, v_group, 'submitted');
  v_admitted := pg_temp.journey(v_org, v_group, 'admitted');
  v_cancelled := pg_temp.journey(v_org, v_group, 'cancelled');
  v_other := pg_temp.journey(v_org, v_group, 'submitted');

  -- Holding bucket. Kept: a live upload of an open journey, finished or
  -- still on its way; anything younger than the cutoff; a path that is not an
  -- upload's.
  PERFORM pg_temp.object('provider-intake-uploads', pg_temp.held(pg_temp.upload(v_open, 'cv', 'finalized')), v_old);
  PERFORM pg_temp.object('provider-intake-uploads', pg_temp.held(pg_temp.upload(v_open, 'coi', 'pending')), v_old);
  PERFORM pg_temp.object('provider-intake-uploads', pg_temp.held(pg_temp.upload(v_open, 'diploma', 'removed')), v_young);
  PERFORM pg_temp.object('provider-intake-uploads', format('org/%s/other/%s/file.pdf', v_org, gen_random_uuid()), v_old);
  PERFORM pg_temp.object('provider-intake-uploads',
    format('org/%s/onboarding/%s/not-an-upload/file.pdf', v_org, v_open), v_old);
  -- Deleted: a removed upload's file (a signed URL used after Remove), a file
  -- with no upload row (her journey's rows went with a Cancel), and every
  -- held file of a submitted, admitted or cancelled journey.
  v_orphans := v_orphans
    || pg_temp.object('provider-intake-uploads', pg_temp.held(pg_temp.upload(v_open, 'other', 'removed')), v_old)
    || pg_temp.object('provider-intake-uploads',
         format('org/%s/onboarding/%s/%s/file.pdf', v_org, gen_random_uuid(), gen_random_uuid()), v_old)
    || pg_temp.object('provider-intake-uploads', pg_temp.held(pg_temp.upload(v_submitted, 'cv', 'finalized')), v_old)
    || pg_temp.object('provider-intake-uploads', pg_temp.held(pg_temp.upload(v_admitted, 'cv', 'finalized')), v_old)
    || pg_temp.object('provider-intake-uploads', pg_temp.held(pg_temp.upload(v_cancelled, 'cv', 'pending')), v_old);

  -- Vault. Kept: a file Submit made a document of; a copy for an open
  -- journey (a Submit may be on its way); a young copy; a staff document; a
  -- group document; a path that names an upload under another provider.
  v_kept_doc := pg_temp.upload(v_submitted, 'diploma', 'finalized');
  INSERT INTO public.provider_documents (id, org_id, provider_id, doc_type, file_path, file_name, document_family_id)
    SELECT v_kept_doc, v_org, j.provider_id, 'diploma', pg_temp.vault(v_kept_doc), 'file.pdf', v_kept_doc
      FROM public.provider_onboardings j WHERE j.id = v_submitted;
  PERFORM pg_temp.object('provider-documents', pg_temp.vault(v_kept_doc), v_old);
  PERFORM pg_temp.object('provider-documents', pg_temp.vault(pg_temp.upload(v_open, 'board_cert', 'removed')), v_old);
  PERFORM pg_temp.object('provider-documents', pg_temp.vault(pg_temp.upload(v_submitted, 'board_cert', 'removed')), v_young);
  PERFORM pg_temp.object('provider-documents',
    format('org/%s/provider/%s/%s/1/staff.pdf', v_org,
           (SELECT provider_id FROM public.provider_onboardings WHERE id = v_submitted), gen_random_uuid()), v_old);
  PERFORM pg_temp.object('provider-documents', format('org/%s/group/%s/%s/1/w9.pdf', v_org, v_group, gen_random_uuid()), v_old);
  v_up := pg_temp.upload(v_submitted, 'license:NC', 'removed');
  PERFORM pg_temp.object('provider-documents',
    format('org/%s/provider/%s/%s/1/file.pdf', v_org,
           (SELECT provider_id FROM public.provider_onboardings WHERE id = v_other), v_up), v_old);
  -- Deleted: a copy no document row points at, for a submitted (a removed
  -- upload, and one whose slot left her form), admitted or cancelled journey.
  v_up := pg_temp.upload(v_submitted, 'license:NC', 'finalized');
  v_orphans := v_orphans
    || pg_temp.object('provider-documents', pg_temp.vault(pg_temp.upload(v_submitted, 'coi', 'removed')), v_old)
    || pg_temp.object('provider-documents', pg_temp.vault(v_up), v_old)
    || pg_temp.object('provider-documents', pg_temp.vault(pg_temp.upload(v_admitted, 'other', 'removed')), v_old)
    || pg_temp.object('provider-documents', pg_temp.vault(pg_temp.upload(v_cancelled, 'coi', 'finalized')), v_old);

  r := pg_temp.mine(public.onboarding_orphan_files(v_cutoff, 1000), v_org);
  ASSERT pg_temp.sorted(r) = pg_temp.sorted(v_orphans),
    format('exactly the orphans: got %s of %s expected', jsonb_array_length(r), jsonb_array_length(v_orphans));

  -- Oldest first, bounded by the limit.
  UPDATE storage.objects SET created_at = now() - interval '5 hours'
   WHERE bucket_id = v_orphans->-1->>'bucket' AND name = v_orphans->-1->>'path';
  r := pg_temp.mine(public.onboarding_orphan_files(v_cutoff, 1000), v_org);
  ASSERT r->0 = v_orphans->-1, format('the older file first: %s', r->0);
  r := public.onboarding_orphan_files(v_cutoff, 1);
  ASSERT jsonb_array_length(r) = 1 AND r->0 = public.onboarding_orphan_files(v_cutoff, 1000)->0,
    format('a limit of 1 names the oldest: %s', r);
  ASSERT public.onboarding_orphan_files(v_cutoff, 0) = '[]'::jsonb, 'a zero limit names nothing';
  ASSERT pg_temp.mine(public.onboarding_orphan_files(now() - interval '6 hours', 1000), v_org)
         = '[]'::jsonb, 'nothing younger than the cutoff';

  -- Once deleted, a file is not named again. (Newer Storage refuses a direct
  -- delete unless this is set; the job deletes through the Storage API.)
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.objects o USING jsonb_array_elements(v_orphans) f
   WHERE o.bucket_id = f->>'bucket' AND o.name = f->>'path';
  ASSERT pg_temp.mine(public.onboarding_orphan_files(v_cutoff, 1000), v_org) = '[]'::jsonb,
    'a second run finds nothing';

  -- service_role only.
  ASSERT has_function_privilege('service_role', 'public.onboarding_orphan_files(timestamptz, integer)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.onboarding_orphan_files(timestamptz, integer)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.onboarding_orphan_files(timestamptz, integer)', 'EXECUTE'),
    'onboarding_orphan_files is service_role only';
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.onboarding_orphan_files(v_cutoff, 1);
    v_state := 'ran';
  EXCEPTION WHEN insufficient_privilege THEN
    v_state := 'refused';
  END;
  RESET ROLE;
  ASSERT v_state = 'refused', 'authenticated cannot list orphans';

  RAISE NOTICE 'provider onboarding cleanup smoke: all checks passed';
END;
$$;

ROLLBACK;
