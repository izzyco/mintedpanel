-- Provider onboarding R1, cycle 8: no case for a provider the invite created
-- until staff Admit her (PM decision 11, D3, R2).
--
-- Only a journey whose invite created the record holds case creation, from
-- the invite until Admit or Cancel. A gap-fill invite to a provider already
-- on file (created_record = false) never pauses her cases.
--
-- The rule is enforced where cases are chosen: the generation preview skips
-- a held provider with the reason, and ManualCaseModal refuses her
-- (src/lib/generationPreview.ts, onboardingHeldProviderIds in
-- src/lib/providerOnboarding.ts). This BEFORE INSERT trigger on
-- credential_cases is the backstop under both. It raises
-- onboarding_not_admitted (P0001) with a DETAIL sentence the browser maps to
-- the same words (src/lib/dbErrors.ts).
--
-- Like block_generation_when_not_allowed (20261102163400) it applies to API
-- traffic (any JWT role) and not to direct database sessions (migrations,
-- seeds, operator SQL). commit_import_run inserts no case. The lookup rides
-- the partial unique index provider_onboardings_one_open (20261106200000).
--
-- Additive and idempotent. Applying to hosted is an OPERATOR task, after
-- 20261106200000. Verify the OBJECTS:
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'public.credential_cases'::regclass
--      AND tgname = 'block_case_until_onboarding_admitted';           -- 1 row
--   then run scripts/sql/provider-onboarding-generation-smoke.sql.

CREATE OR REPLACE FUNCTION public.block_case_until_onboarding_admitted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.provider_onboardings o
     WHERE o.provider_id = NEW.provider_id
       AND o.admitted_at IS NULL
       AND o.cancelled_at IS NULL
       AND o.created_record
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'onboarding_not_admitted',
      DETAIL = 'This provider''s onboarding isn''t finished. Admit & assign on the provider''s page before creating a case.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.block_case_until_onboarding_admitted() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS block_case_until_onboarding_admitted ON public.credential_cases;
CREATE TRIGGER block_case_until_onboarding_admitted
  BEFORE INSERT ON public.credential_cases
  FOR EACH ROW EXECUTE FUNCTION public.block_case_until_onboarding_admitted();

NOTIFY pgrst, 'reload schema';
