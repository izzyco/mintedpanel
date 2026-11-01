-- Mission Control M3: the organization lifecycle as configuration.
--
-- Stage objects replace the CHECK list on organizations.lifecycle_state
-- (Sowmya, Oct 31 2026: business policy is configuration, state objects are
-- configuration; D37: prospect, onboarding, active, offboarded). A stage is a
-- row: key, display name, sort order, the stages it may move to, and its
-- behaviours. Adding `paused` later is an INSERT, not a migration.
--
--   switcher_group     the org switcher / Portfolio group: 'prospects',
--                      'in_motion', or NULL (hidden)
--   writable           false freezes every tenant write (the offboarded write
--                      freeze, migration 20261101160200)
--   generation_allowed the generation UI shows a labelled reason when false
--   shown_by_default   Mission Control's organization list shows the stage
--                      without the "include offboarded" toggle
--
-- organizations.lifecycle_state is unchanged in name and type and still
-- accepts the legacy values prospect, active and inactive (staging seeds and
-- reports write and read them). inactive is a legacy alias read as offboarded
-- by public.normalize_lifecycle_state() here and normalizeLifecycle() in
-- src/lib/lifecycle.ts; keep the two in step. The CHECK
-- organizations_lifecycle_state_check is replaced by a trigger that accepts
-- any configured stage key or a legacy alias (the pattern of
-- 20260921220000, which moved a CHECK into a BEFORE INSERT trigger).
--
-- Lifecycle changes go through platform_set_org_lifecycle() only: platform
-- admins, validated against the configured allowed_next list, one
-- admin_audit_log row (org.lifecycle_change) in the same transaction. There is
-- no client write path to lifecycle_stages; the settings page that edits the
-- objects belongs to the later settings shell. Idempotent.

CREATE TABLE IF NOT EXISTS public.lifecycle_stages (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,31}$'),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  sort_order integer NOT NULL,
  allowed_next text[] NOT NULL DEFAULT '{}'::text[],
  switcher_group text,
  writable boolean NOT NULL DEFAULT true,
  generation_allowed boolean NOT NULL DEFAULT false,
  shown_by_default boolean NOT NULL DEFAULT true
);

COMMENT ON TABLE public.lifecycle_stages IS
  'Mission Control M3: organization lifecycle stage objects (configuration). Mirrored by DEFAULT_LIFECYCLE_STAGES in src/lib/lifecycle.ts.';

ALTER TABLE public.lifecycle_stages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lifecycle_stages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.lifecycle_stages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.lifecycle_stages TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'lifecycle_stages'
       AND policyname = 'lifecycle_stages_select_authenticated'
  ) THEN
    CREATE POLICY lifecycle_stages_select_authenticated
      ON public.lifecycle_stages FOR SELECT TO authenticated
      USING (true);
  END IF;
END
$$;

-- D37's four stages (Mock 7): any stage may go to offboarded; offboarded
-- reopens to active. ON CONFLICT DO NOTHING: a re-run never overwrites an
-- operator's later edit.
INSERT INTO public.lifecycle_stages
  (key, display_name, sort_order, allowed_next, switcher_group, writable, generation_allowed, shown_by_default)
VALUES
  ('prospect',   'Prospect',   10, ARRAY['onboarding', 'offboarded'], 'prospects', true,  false, true),
  ('onboarding', 'Onboarding', 20, ARRAY['active', 'offboarded'],     'prospects', true,  false, true),
  ('active',     'Active',     30, ARRAY['offboarded'],               'in_motion', true,  true,  true),
  ('offboarded', 'Offboarded', 40, ARRAY['active'],                   NULL,        false, false, false)
ON CONFLICT (key) DO NOTHING;

-- The one legacy alias. src/lib/lifecycle.ts normalizeLifecycle() mirrors it.
CREATE OR REPLACE FUNCTION public.normalize_lifecycle_state(p_state text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE WHEN p_state = 'inactive' THEN 'offboarded' ELSE p_state END;
$$;
REVOKE ALL ON FUNCTION public.normalize_lifecycle_state(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_lifecycle_state(text) TO authenticated, service_role;

-- lifecycle_state accepts a configured stage key or a legacy alias of one.
CREATE OR REPLACE FUNCTION public.organizations_lifecycle_state_valid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lifecycle_stages s
     WHERE s.key = public.normalize_lifecycle_state(NEW.lifecycle_state)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'lifecycle_stage_unknown',
      DETAIL = format('No lifecycle stage is configured for %L.', NEW.lifecycle_state);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.organizations_lifecycle_state_valid() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organizations_lifecycle_state_valid ON public.organizations;
CREATE TRIGGER organizations_lifecycle_state_valid
  BEFORE INSERT OR UPDATE OF lifecycle_state ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_lifecycle_state_valid();

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_lifecycle_state_check;

-- ---------------------------------------------------------------------------
-- platform_set_org_lifecycle(p_org_id, p_stage): the one lifecycle write.
-- A move to the stage the organization is already in changes nothing and
-- writes nothing (changed = false). No reason or note: one click.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_set_org_lifecycle(p_org_id uuid, p_stage text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org public.organizations%ROWTYPE;
  v_from text;
  v_to text := btrim(coalesce(p_stage, ''));
  v_from_stage public.lifecycle_stages%ROWTYPE;
  v_to_stage public.lifecycle_stages%ROWTYPE;
  v_audit_id uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'platform_admin_required';
  END IF;

  SELECT * INTO v_org FROM public.organizations WHERE id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'org_not_found';
  END IF;

  SELECT * INTO v_to_stage FROM public.lifecycle_stages WHERE key = v_to;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'lifecycle_stage_unknown';
  END IF;

  v_from := public.normalize_lifecycle_state(v_org.lifecycle_state);
  IF v_from = v_to THEN
    RETURN jsonb_build_object(
      'orgId', v_org.id, 'lifecycleState', v_org.lifecycle_state,
      'previous', v_org.lifecycle_state, 'changed', false, 'auditId', NULL);
  END IF;

  SELECT * INTO v_from_stage FROM public.lifecycle_stages WHERE key = v_from;
  IF NOT FOUND OR NOT (v_to = ANY (v_from_stage.allowed_next)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'lifecycle_transition_not_allowed',
      DETAIL = format('%s cannot move to %s.', v_from, v_to);
  END IF;

  UPDATE public.organizations SET lifecycle_state = v_to WHERE id = v_org.id;

  INSERT INTO public.admin_audit_log
    (actor_user_id, actor_email, action, target_type, target_id, org_id, before, after, description)
  VALUES (
    v_actor,
    (SELECT u.email FROM auth.users u WHERE u.id = v_actor),
    'org.lifecycle_change',
    'organization',
    v_org.id::text,
    v_org.id,
    jsonb_build_object('lifecycleState', v_org.lifecycle_state),
    jsonb_build_object('lifecycleState', v_to),
    format('Lifecycle %s to %s', coalesce(v_from_stage.display_name, v_from), v_to_stage.display_name)
  )
  RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'orgId', v_org.id, 'lifecycleState', v_to,
    'previous', v_org.lifecycle_state, 'changed', true, 'auditId', v_audit_id);
END;
$$;
REVOKE ALL ON FUNCTION public.platform_set_org_lifecycle(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_org_lifecycle(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
