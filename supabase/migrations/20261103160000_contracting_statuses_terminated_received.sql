-- 20261103160000_contracting_statuses_terminated_received.sql
-- Ensure Terminated and Contract Received / Awaiting Signature statuses exist
-- across all existing and newly created organizations, preserving existing
-- statuses and action bucket configurations.

-- 1. Trigger function to seed additional contracting statuses for newly created organizations
CREATE OR REPLACE FUNCTION public.seed_contracting_additional_statuses()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.status_configs (org_id, track, label, color, sort_order, action_bucket)
  VALUES
    (NEW.id, 'contracting', 'Terminated', '#DC2626', 75, 'complete'),
    (NEW.id, 'contracting', 'Contract Received / Awaiting Signature', '#0D9488', 25, 'ours')
  ON CONFLICT (org_id, track, label) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_contracting_additional_statuses() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_seed_contracting_additional_statuses ON public.organizations;
CREATE TRIGGER trigger_seed_contracting_additional_statuses
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.seed_contracting_additional_statuses();

-- 2. Seed existing organizations without modifying or rewriting any existing status rows
DO $$
DECLARE
  v_org RECORD;
BEGIN
  FOR v_org IN SELECT id FROM public.organizations LOOP
    INSERT INTO public.status_configs (org_id, track, label, color, sort_order, action_bucket)
    VALUES
      (v_org.id, 'contracting', 'Terminated', '#DC2626', 75, 'complete'),
      (v_org.id, 'contracting', 'Contract Received / Awaiting Signature', '#0D9488', 25, 'ours')
    ON CONFLICT (org_id, track, label) DO NOTHING;
  END LOOP;
END $$;
