-- Mission Control M3: organizations.slug and organizations.plan_tier.
--
-- slug names exactly one organization and is a URL identifier (/join/<slug>,
-- later a customer subdomain), so it is a DNS label and a hard rule:
--   format   ^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$   (CHECK)
--   unique   organizations_slug_key                    (unique index)
--   fixed    once an organization has a slug it never changes (trigger)
-- Every organization has one. Existing rows are backfilled from their name in
-- created order (a collision gets -2, -3, ...), and a row inserted without a
-- slug gets one the same way (BEFORE INSERT), so every creation path keeps
-- working unchanged. Mission Control's platform_create_organization (a later
-- migration in this set) passes the operator's chosen slug through the
-- transaction-local setting minted.new_org_slug, read here at insert time
-- only; it can never change an existing slug.
--
-- plan_tier is informational, nullable text with no CHECK: the small list of
-- tiers lives in the UI (src/lib/orgProfile.ts), so a new tier is not a
-- migration. No billing integration.
--
-- Additive: two new columns, two triggers, three helper functions. Nothing
-- existing is dropped or restated. Idempotent.

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS plan_tier text;

COMMENT ON COLUMN public.organizations.slug IS
  'Mission Control M3: the organization''s URL name (/join/<slug>). A DNS label, unique, fixed once set.';
COMMENT ON COLUMN public.organizations.plan_tier IS
  'Mission Control M3: informational plan tier (pilot, standard, enterprise in the UI list). Nullable, no CHECK.';

-- The slug a name suggests: lowercase, runs of anything but a-z0-9 become one
-- hyphen, no leading or trailing hyphen, at most 63 characters, 'org' when
-- nothing is left. src/lib/orgProfile.ts slugFromName() is the UI's version.
CREATE OR REPLACE FUNCTION public.org_slug_from_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT coalesce(
    nullif(rtrim(left(btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-'), 63), '-'), ''),
    'org'
  );
$$;

-- The first free slug for a base: the base itself, else base-2, base-3, ...
-- with the base shortened so the result stays within 63 characters.
CREATE OR REPLACE FUNCTION public.org_slug_first_free(p_base text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_candidate text := p_base;
  v_suffix text;
  v_n integer := 1;
BEGIN
  WHILE EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = v_candidate) LOOP
    v_n := v_n + 1;
    v_suffix := '-' || v_n::text;
    v_candidate := rtrim(left(p_base, 63 - length(v_suffix)), '-') || v_suffix;
  END LOOP;
  RETURN v_candidate;
END;
$$;

REVOKE ALL ON FUNCTION public.org_slug_from_name(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.org_slug_first_free(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_slug_from_name(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.org_slug_first_free(text) TO service_role;

-- Backfill in created order so the oldest organization keeps the plain slug.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id, name FROM public.organizations WHERE slug IS NULL ORDER BY created_at, id LOOP
    UPDATE public.organizations
       SET slug = public.org_slug_first_free(public.org_slug_from_name(r.name))
     WHERE id = r.id;
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'organizations_slug_format' AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_slug_format
      CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$');
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_key ON public.organizations (slug);

-- A row inserted without a slug gets one. SECURITY DEFINER so the collision
-- check sees every organization, not only the caller's.
CREATE OR REPLACE FUNCTION public.organizations_fill_slug()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_chosen text := nullif(current_setting('minted.new_org_slug', true), '');
BEGIN
  IF NEW.slug IS NULL THEN
    NEW.slug := coalesce(v_chosen, public.org_slug_first_free(public.org_slug_from_name(NEW.name)));
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.organizations_slug_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.slug IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'slug_immutable',
      DETAIL = 'An organization''s slug is fixed once it is set.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.organizations_fill_slug() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.organizations_slug_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organizations_fill_slug ON public.organizations;
CREATE TRIGGER organizations_fill_slug
  BEFORE INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_fill_slug();

DROP TRIGGER IF EXISTS organizations_slug_immutable ON public.organizations;
CREATE TRIGGER organizations_slug_immutable
  BEFORE UPDATE OF slug ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_slug_immutable();

ALTER TABLE public.organizations ALTER COLUMN slug SET NOT NULL;

NOTIFY pgrst, 'reload schema';
