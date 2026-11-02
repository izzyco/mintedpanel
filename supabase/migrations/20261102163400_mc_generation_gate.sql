-- Mission Control M3: case generation only in a stage that allows it.
--
-- Sowmya, Nov 2 2026, her explicit exception to working rule 2: no case
-- generation until the organization is active. The stage object's
-- generation_allowed behaviour (lifecycle_stages, 20261102163100: active only
-- by default) stays configurable; this makes it a hard stop on the server.
--
-- The generation path inserts one case_generation_runs row first and threads
-- its id through every create_case_with_tasks call (src/services/
-- generationConfirm.ts), so a BEFORE INSERT trigger on case_generation_runs
-- refuses the whole path with generation_not_allowed (P0001) for an
-- organization whose stage disallows generation. Like the offboarded write
-- freeze it applies to API traffic (any JWT role) and not to direct database
-- sessions (migrations, operator SQL), and an organization whose stage has no
-- configured row is not blocked. The generation UI mirrors it: a labelled
-- reason and no grid. ManualCaseModal (/cases) does not write a run and is
-- not gated here. Additive and idempotent.

CREATE OR REPLACE FUNCTION public.org_generation_allowed(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM public.organizations o
      JOIN public.lifecycle_stages s ON s.key = public.normalize_lifecycle_state(o.lifecycle_state)
     WHERE o.id = p_org_id AND NOT s.generation_allowed
  );
$$;
REVOKE ALL ON FUNCTION public.org_generation_allowed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_generation_allowed(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.block_generation_when_not_allowed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_stage text;
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT public.org_generation_allowed(NEW.org_id) THEN
    SELECT s.display_name INTO v_stage
      FROM public.organizations o
      JOIN public.lifecycle_stages s ON s.key = public.normalize_lifecycle_state(o.lifecycle_state)
     WHERE o.id = NEW.org_id;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'generation_not_allowed',
      DETAIL = format('Case generation is off while this organization is %s.', v_stage);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.block_generation_when_not_allowed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS block_generation_when_not_allowed ON public.case_generation_runs;
CREATE TRIGGER block_generation_when_not_allowed
  BEFORE INSERT ON public.case_generation_runs
  FOR EACH ROW EXECUTE FUNCTION public.block_generation_when_not_allowed();

NOTIFY pgrst, 'reload schema';
