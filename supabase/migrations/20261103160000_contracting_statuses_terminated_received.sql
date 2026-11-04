-- 20261103160000_contracting_statuses_terminated_received.sql
-- Synchronize Terminated, Contract Received / Awaiting Signature, In Progress, and Contracted statuses in public.status_configs across all existing organizations.

DO $$
DECLARE
  org RECORD;
  status_record RECORD;
BEGIN
  FOR org IN SELECT id FROM public.organizations LOOP
    FOR status_record IN
      SELECT * FROM (VALUES
        ('Terminated',                              '#DC2626', 75, 'complete'),
        ('Contract Received / Awaiting Signature',  '#0D9488', 25, 'ours'),
        ('In Progress',                             '#3B82F6', 22, 'waiting_payer'),
        ('Contracted',                              '#0D9488', 45, 'complete')
      ) AS t(label, color, sort_order, action_bucket)
    LOOP
      IF EXISTS (
        SELECT 1 FROM public.status_configs
        WHERE org_id = org.id AND track = 'contracting' AND label = status_record.label
      ) THEN
        UPDATE public.status_configs
        SET color = status_record.color,
            sort_order = status_record.sort_order,
            action_bucket = status_record.action_bucket
        WHERE org_id = org.id AND track = 'contracting' AND label = status_record.label;
      ELSE
        INSERT INTO public.status_configs (org_id, track, label, color, sort_order, action_bucket)
        VALUES (org.id, 'contracting', status_record.label, status_record.color, status_record.sort_order, status_record.action_bucket);
      END IF;
    END LOOP;
  END LOOP;
END $$;
