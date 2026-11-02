-- MINT-110 PR 3: NPI Registry source data and provenance.
--
-- One table, provider_registry_pulls: one row per provider-form save that
-- used an NPI Registry (NPPES) answer, a pick or the check of a new or
-- changed NPI. Unsaved searches leave nothing.
--   reply      the trimmed public reply (src/lib/npiRegistry.ts
--              NpiRegistryRecord), kept as source data apart from the
--              provider's own columns. NULL: the registry has no record for
--              the NPI.
--   sourced    the fields whose saved value came from this pull: any of
--              credentials, taxonomyCode, gender, phone, and licenses
--              ([{state, number}]). The route keeps a field only when the
--              saved value equals the reply's (keepNpiRegistrySourced).
--   pulled_at  when the registry answered (the server's pulledAt).
--   pulled_by  the verified actor who saved.
--   confirmed  true for an Add Provider Review step submit (pulled_by
--              confirmed); false for every other save.
-- A later edit changes the provider as today (audit_log records it); the pull
-- row stays as written. A later pull adds its own row and never overwrites a
-- provider value.
--
-- Written once, by POST /api/npi-registry/pulls (src/server/npiRegistryRoutes
-- .ts): the full org guard, writers only, the org and actor from the
-- membership, the provider in that org and holding that NPI, the reply from
-- the server's cache or NPPES (never from the client), one insert with the
-- service-role client. No triggers, no session settings, no view.
--
-- Access. RLS on with no policies, and nothing granted to anon or
-- authenticated: there is no reader yet, so no API role reads or writes the
-- table directly. service_role has SELECT and INSERT only (the route's insert
-- returns the new id), so nothing may UPDATE, DELETE or TRUNCATE through the
-- API roles. The organizations and providers foreign keys cascade, so
-- offboarding a tenant or deleting a provider still removes its rows. The
-- provider foreign key is (org_id, provider_id), so a row can't name another
-- org's provider. A reader, when one is built, adds its own policy or route.
--
-- Mission Control M3 adds apply_offboarded_write_freeze() for tenant tables
-- with org_id. It is not on main yet; this table needs it once M3 lands.
--
-- Additive and re-runnable. REPO-ONLY until an operator applies it, staging
-- first. Until then PostgREST answers the route's insert with PGRST205 (HTTP
-- 404: the table is not in its schema cache), the route returns a 500, and
-- the forms' fire and forget call logs npi_registry_pull_failed with the
-- status only; every save goes through.
-- Verify the OBJECTS, not a ledger filename:
--   SELECT to_regclass('public.provider_registry_pulls');              -- non-null
--   SELECT relrowsecurity FROM pg_class
--    WHERE oid = 'public.provider_registry_pulls'::regclass;           -- true
--   SELECT count(*) FROM pg_policy
--    WHERE polrelid = 'public.provider_registry_pulls'::regclass;      -- 0
--   SELECT has_table_privilege('authenticated', 'public.provider_registry_pulls', 'SELECT'),
--          has_table_privilege('anon', 'public.provider_registry_pulls', 'SELECT'),
--          has_table_privilege('service_role', 'public.provider_registry_pulls', 'INSERT'),
--          has_table_privilege('service_role', 'public.provider_registry_pulls', 'UPDATE');
--     -> false | false | true | false
--   The behavioural packet, supabase/tests/mint110-registry-pulls.sql, needs a
--   superuser and runs only in CI's disposable database, never hosted.

CREATE TABLE IF NOT EXISTS public.provider_registry_pulls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  provider_id uuid NOT NULL,
  npi text NOT NULL
    CONSTRAINT provider_registry_pulls_npi_check CHECK (npi ~ '^[0-9]{10}$'),
  pulled_at timestamptz NOT NULL,
  pulled_by uuid NOT NULL,
  reply jsonb NULL
    CONSTRAINT provider_registry_pulls_reply_check
      CHECK (reply IS NULL OR jsonb_typeof(reply) = 'object'),
  sourced jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT provider_registry_pulls_sourced_check CHECK (jsonb_typeof(sourced) = 'object'),
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_registry_pulls_provider_fkey FOREIGN KEY (org_id, provider_id)
    REFERENCES public.providers (org_id, id) ON DELETE CASCADE
);

-- A provider's pulls, newest first; also covers the (org_id, provider_id)
-- foreign key.
CREATE INDEX IF NOT EXISTS idx_provider_registry_pulls_provider
  ON public.provider_registry_pulls (org_id, provider_id, pulled_at DESC);

ALTER TABLE public.provider_registry_pulls ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.provider_registry_pulls FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.provider_registry_pulls TO service_role;

COMMENT ON TABLE public.provider_registry_pulls IS
  'MINT-110 PR 3: one row per provider-form save that used an NPI Registry answer. reply is the trimmed public reply (NULL: no record); sourced names the fields whose saved value came from it; confirmed marks an Add Provider Review step submit. Written only by POST /api/npi-registry/pulls (service role, insert only). No reader yet: nothing is granted to anon or authenticated.';
