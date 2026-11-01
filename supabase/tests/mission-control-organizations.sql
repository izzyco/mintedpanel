-- Mission Control M3 packet: organization slug rules, lifecycle stage objects
-- and the transition matrix, the offboarded write freeze, and the four
-- organization RPCs (platform_create_organization, platform_grant_membership,
-- platform_org_summary, update_organization_profile).
-- Run after repository migrations in an owned disposable local database
-- (scripts/security/verify-mission-control-organizations.mjs). Every fixture
-- row is synthetic and the outer transaction rolls back. Output is labels only.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;
SET LOCAL client_min_messages = warning;

CREATE TEMP TABLE mo_results (
  ordinal bigint GENERATED ALWAYS AS IDENTITY,
  label text PRIMARY KEY,
  passed boolean NOT NULL
);

CREATE FUNCTION pg_temp.mo_assert(p_label text, p_condition boolean)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
AS $$
  INSERT INTO pg_temp.mo_results (label, passed)
  VALUES (p_label, coalesce(p_condition, false));
$$;

-- Impersonate a PostgREST caller (both claim spellings), or clear the claims
-- to act as a direct database session (operator SQL, migrations).
CREATE FUNCTION pg_temp.mo_claims(p_user uuid, p_role text DEFAULT 'authenticated')
RETURNS void
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true),
         set_config('request.jwt.claim.role', p_role, true),
         set_config('request.jwt.claims',
           json_build_object('sub', p_user, 'role', p_role)::text, true);
$$;

CREATE FUNCTION pg_temp.mo_no_claims()
RETURNS void
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT set_config('request.jwt.claim.sub', '', true),
         set_config('request.jwt.claim.role', '', true),
         set_config('request.jwt.claims', '', true);
$$;

-- Runs one statement under the current role; returns '00000' or
-- '<sqlstate>:<message>'. The failed statement's effects roll back with it.
CREATE FUNCTION pg_temp.mo_try(p_sql text)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_state text;
  v_message text;
BEGIN
  EXECUTE p_sql;
  RETURN '00000';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
  RETURN v_state || ':' || v_message;
END;
$$;

CREATE FUNCTION pg_temp.mo_keys(p_doc jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::text[]) FROM jsonb_object_keys(p_doc) AS k;
$$;

-- Synthetic fixtures (inserted as a direct database session, no claims).
--   PA       platform admin, no membership
--   ADMIN_A  admin of org A          SPEC_A  specialist of org A
--   ADMIN_B  admin of org B
-- Org A (active) and org B (active) carry groups, providers, cases and a
-- touch; org C is a legacy 'inactive' org; org D is 'prospect'.
INSERT INTO auth.users (id, email) VALUES
  ('7d100000-0000-4000-8000-000000000001', 'mo-platform@example.invalid'),
  ('7d100000-0000-4000-8000-000000000002', 'mo-admin-a@example.invalid'),
  ('7d100000-0000-4000-8000-000000000003', 'mo-spec-a@example.invalid'),
  ('7d100000-0000-4000-8000-000000000004', 'mo-admin-b@example.invalid');

INSERT INTO public.profiles (id, full_name, email) VALUES
  ('7d100000-0000-4000-8000-000000000001', 'Synthetic MO Platform', 'mo-platform@example.invalid'),
  ('7d100000-0000-4000-8000-000000000002', 'Synthetic MO Admin A', 'mo-admin-a@example.invalid'),
  ('7d100000-0000-4000-8000-000000000003', 'Synthetic MO Specialist A', 'mo-spec-a@example.invalid'),
  ('7d100000-0000-4000-8000-000000000004', 'Synthetic MO Admin B', 'mo-admin-b@example.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.platform_admins (user_id, granted_by, note)
VALUES ('7d100000-0000-4000-8000-000000000001', '7d100000-0000-4000-8000-000000000001', 'bootstrap')
ON CONFLICT (user_id) DO UPDATE SET revoked_at = NULL, revoked_by = NULL, updated_at = now();

INSERT INTO public.organizations (id, name, lifecycle_state, created_at) VALUES
  ('7d200000-0000-4000-8000-000000000001', 'MO Synthetic Org A', 'active', '2026-01-01T00:00:00Z'),
  ('7d200000-0000-4000-8000-000000000002', 'MO Synthetic Org B', 'active', '2026-01-02T00:00:00Z'),
  ('7d200000-0000-4000-8000-000000000003', 'MO Synthetic Org C', 'inactive', '2026-01-03T00:00:00Z'),
  ('7d200000-0000-4000-8000-000000000004', 'MO Synthetic Org D', 'prospect', '2026-01-04T00:00:00Z');

INSERT INTO public.memberships (org_id, user_id, role) VALUES
  ('7d200000-0000-4000-8000-000000000001', '7d100000-0000-4000-8000-000000000002', 'admin'),
  ('7d200000-0000-4000-8000-000000000001', '7d100000-0000-4000-8000-000000000003', 'specialist'),
  ('7d200000-0000-4000-8000-000000000003', '7d100000-0000-4000-8000-000000000003', 'specialist'),
  ('7d200000-0000-4000-8000-000000000002', '7d100000-0000-4000-8000-000000000004', 'admin');

INSERT INTO public.pending_invites (org_id, email, role) VALUES
  ('7d200000-0000-4000-8000-000000000001', 'mo-invite-a1@example.invalid', 'specialist'),
  ('7d200000-0000-4000-8000-000000000001', 'mo-invite-a2@example.invalid', 'billing'),
  ('7d200000-0000-4000-8000-000000000002', 'mo-invite-b1@example.invalid', 'specialist');

INSERT INTO public.parties (id, org_id, party_type, name, email, created_by) VALUES
  ('7d600000-0000-4000-8000-000000000001', '7d200000-0000-4000-8000-000000000001', 'person',
   'Synthetic Owner A', 'owner-a@example.invalid', '7d100000-0000-4000-8000-000000000002');
INSERT INTO public.party_role_assignments (org_id, party_id, role_key, scope_type, is_default) VALUES
  ('7d200000-0000-4000-8000-000000000001', '7d600000-0000-4000-8000-000000000001', 'owner', 'org', true);

INSERT INTO public.provider_groups (id, org_id, name, tin, npi_type2) VALUES
  ('7d700000-0000-4000-8000-000000000001', '7d200000-0000-4000-8000-000000000001', 'MO Group A1', '55-1116789', '1234567893'),
  ('7d700000-0000-4000-8000-000000000002', '7d200000-0000-4000-8000-000000000001', 'MO Group A2', NULL, NULL),
  ('7d700000-0000-4000-8000-000000000003', '7d200000-0000-4000-8000-000000000002', 'MO Group B1', '98-7654321', '1987654325');

INSERT INTO public.payers (id, org_id, name) VALUES
  ('7d300000-0000-4000-8000-000000000001', '7d200000-0000-4000-8000-000000000001', 'MO synthetic payer A'),
  ('7d300000-0000-4000-8000-000000000002', '7d200000-0000-4000-8000-000000000002', 'MO synthetic payer B');

INSERT INTO public.providers (id, org_id, first_name, last_name, status, verification_state) VALUES
  ('7d400000-0000-4000-8000-000000000001', '7d200000-0000-4000-8000-000000000001', 'Synthetic', 'Zyxwvutsrq', 'active', 'verified'),
  ('7d400000-0000-4000-8000-000000000002', '7d200000-0000-4000-8000-000000000001', 'Synthetic', 'Onboarding A', 'onboarding', 'pending_verification'),
  ('7d400000-0000-4000-8000-000000000003', '7d200000-0000-4000-8000-000000000001', 'Synthetic', 'Terminated A', 'terminated', 'verified'),
  ('7d400000-0000-4000-8000-000000000004', '7d200000-0000-4000-8000-000000000002', 'Synthetic', 'Provider B', 'active', 'verified'),
  ('7d400000-0000-4000-8000-000000000005', '7d200000-0000-4000-8000-000000000003', 'Synthetic', 'Provider C', 'active', 'verified');

INSERT INTO public.credential_cases (id, org_id, provider_id, payer_id, state, case_status) VALUES
  ('7d500000-0000-4000-8000-000000000001', '7d200000-0000-4000-8000-000000000001', '7d400000-0000-4000-8000-000000000001', '7d300000-0000-4000-8000-000000000001', 'CO', 'in_progress'),
  ('7d500000-0000-4000-8000-000000000002', '7d200000-0000-4000-8000-000000000001', '7d400000-0000-4000-8000-000000000001', '7d300000-0000-4000-8000-000000000001', 'KS', 'submitted'),
  ('7d500000-0000-4000-8000-000000000003', '7d200000-0000-4000-8000-000000000001', '7d400000-0000-4000-8000-000000000002', '7d300000-0000-4000-8000-000000000001', 'CO', 'approved'),
  ('7d500000-0000-4000-8000-000000000004', '7d200000-0000-4000-8000-000000000002', '7d400000-0000-4000-8000-000000000004', '7d300000-0000-4000-8000-000000000002', 'TX', 'not_started');

INSERT INTO public.touches (org_id, case_id, touch_date, entry_type, notes, created_at) VALUES
  ('7d200000-0000-4000-8000-000000000001', '7d500000-0000-4000-8000-000000000001', '2026-10-30', 'note', 'synthetic', '2026-10-30T15:04:05.123Z'),
  ('7d200000-0000-4000-8000-000000000002', '7d500000-0000-4000-8000-000000000004', '2026-09-01', 'note', 'synthetic', '2026-09-01T08:00:00Z');

-- ---------------------------------------------------------------------------
-- Shape and ACLs
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_fn text;
  v_expected text[];
  v_actual text[];
BEGIN
  PERFORM pg_temp.mo_assert('shape.lifecycle_stages_rls_enabled',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.lifecycle_stages'::regclass));
  PERFORM pg_temp.mo_assert('acl.lifecycle_stages.authenticated_select_only',
    has_table_privilege('authenticated', 'public.lifecycle_stages', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.lifecycle_stages', 'INSERT,UPDATE,DELETE,TRUNCATE'));
  PERFORM pg_temp.mo_assert('acl.lifecycle_stages.anon_none',
    NOT has_table_privilege('anon', 'public.lifecycle_stages', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'));
  PERFORM pg_temp.mo_assert('shape.lifecycle_stages_one_select_policy',
    (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lifecycle_stages') = 1
    AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lifecycle_stages'
                 AND policyname = 'lifecycle_stages_select_authenticated' AND cmd = 'SELECT'));
  -- M1's packet pins exactly six mc_ policies; M3 adds none.
  PERFORM pg_temp.mo_assert('shape.no_new_mc_policies',
    (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'mc\_%') = 6);

  PERFORM pg_temp.mo_assert('lifecycle.seed_exact',
    (SELECT jsonb_agg(jsonb_build_array(key, display_name, allowed_next, switcher_group, writable,
                                        generation_allowed, shown_by_default) ORDER BY sort_order)
       FROM public.lifecycle_stages)
    = jsonb_build_array(
        jsonb_build_array('prospect', 'Prospect', ARRAY['onboarding', 'offboarded'], 'prospects', true, false, true),
        jsonb_build_array('onboarding', 'Onboarding', ARRAY['active', 'offboarded'], 'prospects', true, false, true),
        jsonb_build_array('active', 'Active', ARRAY['offboarded'], 'in_motion', true, true, true),
        jsonb_build_array('offboarded', 'Offboarded', ARRAY['active'], NULL, false, false, false)));

  PERFORM pg_temp.mo_assert('shape.lifecycle_check_replaced_by_trigger',
    NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_lifecycle_state_check')
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'organizations_lifecycle_state_valid'
                 AND tgrelid = 'public.organizations'::regclass));

  PERFORM pg_temp.mo_assert('shape.functions_definer_search_path_pinned',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('platform_set_org_lifecycle', 'platform_create_organization',
                          'platform_grant_membership', 'platform_org_summary',
                          'update_organization_profile', 'block_writes_when_offboarded',
                          'apply_offboarded_write_freeze', 'org_is_writable')
        AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=public']
        AND p.pronargdefaults = 0) = 8);
  PERFORM pg_temp.mo_assert('shape.rpcs_single_overload',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('platform_set_org_lifecycle', 'platform_create_organization',
                          'platform_grant_membership', 'platform_org_summary',
                          'update_organization_profile')) = 5);

  FOREACH v_fn IN ARRAY ARRAY[
    'public.platform_set_org_lifecycle(uuid,text)',
    'public.platform_create_organization(text,text,text,text,text)',
    'public.platform_grant_membership(uuid)',
    'public.platform_org_summary(uuid)',
    'public.update_organization_profile(uuid,text,text,text,text)'
  ] LOOP
    PERFORM pg_temp.mo_assert('acl.execute.' || split_part(split_part(v_fn, '.', 2), '(', 1),
      has_function_privilege('authenticated', v_fn, 'EXECUTE')
      AND NOT has_function_privilege('anon', v_fn, 'EXECUTE')
      AND NOT EXISTS (
        SELECT 1
          FROM pg_proc p,
               aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         WHERE p.oid = v_fn::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'));
  END LOOP;
  PERFORM pg_temp.mo_assert('acl.installer_service_role_only',
    has_function_privilege('service_role', 'public.apply_offboarded_write_freeze()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.apply_offboarded_write_freeze()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.apply_offboarded_write_freeze()', 'EXECUTE'));

  -- The freeze is on every public base table with org_id except the four
  -- exempt ones, and on nothing else.
  SELECT array_agg(c.table_name::text ORDER BY c.table_name) INTO v_expected
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE'
     AND c.table_name NOT IN ('admin_audit_log', 'audit_log', 'memberships', 'pending_invites');
  SELECT array_agg(tg.tgrelid::regclass::text ORDER BY tg.tgrelid::regclass::text) INTO v_actual
    FROM pg_trigger tg
   WHERE tg.tgname = 'block_writes_when_offboarded' AND NOT tg.tgisinternal;
  PERFORM pg_temp.mo_assert('freeze.installed_on_every_tenant_table',
    v_actual = (SELECT array_agg(x ORDER BY x) FROM unnest(v_expected) AS x)
    AND array_length(v_actual, 1) >= 50
    AND 'providers' = ANY (v_actual) AND 'workflow_advisories' = ANY (v_actual));
  PERFORM pg_temp.mo_assert('freeze.exempt_tables_untouched',
    NOT EXISTS (SELECT 1 FROM pg_trigger tg
                 WHERE tg.tgname = 'block_writes_when_offboarded'
                   AND tg.tgrelid::regclass::text IN ('admin_audit_log', 'audit_log', 'memberships', 'pending_invites')));
  PERFORM pg_temp.mo_assert('freeze.installer_idempotent',
    public.apply_offboarded_write_freeze() = ARRAY[]::text[]
    AND (SELECT count(*) FROM pg_trigger WHERE tgname = 'block_writes_when_offboarded') = array_length(v_actual, 1));
END
$$;

-- ---------------------------------------------------------------------------
-- Slug rules: filled from the name, DNS label, unique, fixed once set.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_state text;
  v_long text := repeat('a', 63);
BEGIN
  PERFORM pg_temp.mo_assert('slug.filled_from_name',
    (SELECT slug FROM public.organizations WHERE id = '7d200000-0000-4000-8000-000000000001') = 'mo-synthetic-org-a');
  INSERT INTO public.organizations (id, name) VALUES ('7d200000-0000-4000-8000-0000000000a1', '  MO Synthetic -- Org A!! ');
  PERFORM pg_temp.mo_assert('slug.collision_gets_suffix',
    (SELECT slug FROM public.organizations WHERE id = '7d200000-0000-4000-8000-0000000000a1') = 'mo-synthetic-org-a-2');
  PERFORM pg_temp.mo_assert('slug.from_name_rules',
    public.org_slug_from_name('Café & Co. Rehab') = 'caf-co-rehab'
    AND public.org_slug_from_name('---') = 'org'
    AND length(public.org_slug_from_name(repeat('ab ', 40))) <= 63
    AND public.org_slug_from_name(repeat('ab ', 40)) !~ '-$');
  PERFORM pg_temp.mo_assert('slug.not_null', (SELECT attnotnull FROM pg_attribute
    WHERE attrelid = 'public.organizations'::regclass AND attname = 'slug'));

  PERFORM pg_temp.mo_assert('slug.format_rejects_uppercase', pg_temp.mo_try(
    $q$INSERT INTO public.organizations (name, slug) VALUES ('MO slug x1', 'Bad-Slug')$q$) LIKE '23514:%');
  PERFORM pg_temp.mo_assert('slug.format_rejects_edges', pg_temp.mo_try(
    $q$INSERT INTO public.organizations (name, slug) VALUES ('MO slug x2', '-edge')$q$) LIKE '23514:%'
    AND pg_temp.mo_try($q$INSERT INTO public.organizations (name, slug) VALUES ('MO slug x3', 'edge-')$q$) LIKE '23514:%'
    AND pg_temp.mo_try($q$INSERT INTO public.organizations (name, slug) VALUES ('MO slug x4', 'under_score')$q$) LIKE '23514:%');
  PERFORM pg_temp.mo_assert('slug.format_length_63_ok_64_rejected',
    pg_temp.mo_try(format($q$INSERT INTO public.organizations (name, slug) VALUES ('MO slug x5', %L)$q$, v_long)) = '00000'
    AND pg_temp.mo_try(format($q$INSERT INTO public.organizations (name, slug) VALUES ('MO slug x6', %L)$q$, v_long || 'a')) LIKE '23514:%');
  PERFORM pg_temp.mo_assert('slug.unique', pg_temp.mo_try(
    $q$INSERT INTO public.organizations (name, slug) VALUES ('MO slug x7', 'mo-synthetic-org-b')$q$) LIKE '23505:%');

  -- Fixed once set, for every session (an operator too).
  v_state := pg_temp.mo_try($q$UPDATE public.organizations SET slug = 'mo-renamed' WHERE id = '7d200000-0000-4000-8000-000000000004'$q$);
  PERFORM pg_temp.mo_assert('slug.immutable', v_state = '23514:slug_immutable'
    AND (SELECT slug FROM public.organizations WHERE id = '7d200000-0000-4000-8000-000000000004') = 'mo-synthetic-org-d');
END
$$;

-- ---------------------------------------------------------------------------
-- lifecycle_state accepts configured keys and the legacy alias, nothing else;
-- a new stage is a row, not a migration.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_paused text;
BEGIN
  PERFORM pg_temp.mo_assert('lifecycle.legacy_values_still_write',
    pg_temp.mo_try($q$UPDATE public.organizations SET lifecycle_state = 'inactive' WHERE id = '7d200000-0000-4000-8000-000000000004'$q$) = '00000'
    AND pg_temp.mo_try($q$UPDATE public.organizations SET lifecycle_state = 'active' WHERE id = '7d200000-0000-4000-8000-000000000004'$q$) = '00000'
    AND pg_temp.mo_try($q$UPDATE public.organizations SET lifecycle_state = 'prospect' WHERE id = '7d200000-0000-4000-8000-000000000004'$q$) = '00000');
  PERFORM pg_temp.mo_assert('lifecycle.new_keys_write',
    pg_temp.mo_try($q$INSERT INTO public.organizations (name, lifecycle_state) VALUES ('MO lc onboarding', 'onboarding')$q$) = '00000'
    AND pg_temp.mo_try($q$INSERT INTO public.organizations (name, lifecycle_state) VALUES ('MO lc offboarded', 'offboarded')$q$) = '00000');
  PERFORM pg_temp.mo_assert('lifecycle.unknown_key_rejected',
    pg_temp.mo_try($q$INSERT INTO public.organizations (name, lifecycle_state) VALUES ('MO lc paused', 'paused')$q$) = '23514:lifecycle_stage_unknown');

  BEGIN
    INSERT INTO public.lifecycle_stages (key, display_name, sort_order, allowed_next, switcher_group)
    VALUES ('paused', 'Paused', 35, ARRAY['active', 'offboarded'], 'in_motion');
    v_paused := pg_temp.mo_try($q$INSERT INTO public.organizations (name, lifecycle_state) VALUES ('MO lc paused', 'paused')$q$);
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'mo_undo_paused';
  EXCEPTION WHEN raise_exception THEN
    NULL;
  END;
  PERFORM pg_temp.mo_assert('lifecycle.paused_is_a_row', v_paused = '00000');
  PERFORM pg_temp.mo_assert('lifecycle.paused_row_rolled_back',
    NOT EXISTS (SELECT 1 FROM public.lifecycle_stages WHERE key = 'paused'));
  PERFORM pg_temp.mo_assert('lifecycle.normalize_alias',
    public.normalize_lifecycle_state('inactive') = 'offboarded'
    AND public.normalize_lifecycle_state('active') = 'active');
END
$$;

-- ---------------------------------------------------------------------------
-- The transition matrix, as a platform admin, against the configured list.
-- Every allowed move writes exactly one org.lifecycle_change row; a same-stage
-- move and every refused move write nothing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_pa uuid := '7d100000-0000-4000-8000-000000000001';
  v_org uuid := '7d200000-0000-4000-8000-000000000004';
  v_from text;
  v_to text;
  v_state text;
  v_result jsonb;
  v_ledger bigint;
  v_allowed text[] := ARRAY[
    'prospect>onboarding', 'prospect>offboarded', 'onboarding>active', 'onboarding>offboarded',
    'active>offboarded', 'offboarded>active', 'inactive>active'];
  v_seen_allowed text[] := ARRAY[]::text[];
  v_bad text[] := ARRAY[]::text[];
BEGIN
  FOREACH v_from IN ARRAY ARRAY['prospect', 'onboarding', 'active', 'offboarded', 'inactive'] LOOP
    FOREACH v_to IN ARRAY ARRAY['prospect', 'onboarding', 'active', 'offboarded', 'inactive', 'paused'] LOOP
      PERFORM pg_temp.mo_no_claims();
      UPDATE public.organizations SET lifecycle_state = v_from WHERE id = v_org;
      v_ledger := (SELECT count(*) FROM public.admin_audit_log);

      PERFORM pg_temp.mo_claims(v_pa);
      SET LOCAL ROLE authenticated;
      v_state := pg_temp.mo_try(format('SELECT public.platform_set_org_lifecycle(%L::uuid, %L)', v_org, v_to));
      RESET ROLE;

      IF (v_from || '>' || v_to) = ANY (v_allowed) THEN
        IF v_state = '00000'
           AND (SELECT lifecycle_state FROM public.organizations WHERE id = v_org) = v_to
           AND (SELECT count(*) FROM public.admin_audit_log) = v_ledger + 1
           AND (SELECT count(*) FROM public.admin_audit_log a
                 WHERE a.org_id = v_org AND a.action = 'org.lifecycle_change'
                   AND a.actor_user_id = v_pa AND a.target_type = 'organization'
                   AND a.target_id = v_org::text
                   AND a.before->>'lifecycleState' = v_from
                   AND a.after->>'lifecycleState' = v_to) = 1 THEN
          v_seen_allowed := v_seen_allowed || (v_from || '>' || v_to);
        ELSE
          v_bad := v_bad || (v_from || '>' || v_to || ':' || v_state);
        END IF;
      ELSIF public.normalize_lifecycle_state(v_from) = v_to THEN
        IF v_state <> '00000'
           OR (SELECT lifecycle_state FROM public.organizations WHERE id = v_org) <> v_from
           OR (SELECT count(*) FROM public.admin_audit_log) <> v_ledger THEN
          v_bad := v_bad || (v_from || '>' || v_to || ':noop:' || v_state);
        END IF;
      ELSE
        IF v_state NOT IN ('22023:lifecycle_transition_not_allowed', '22023:lifecycle_stage_unknown')
           OR (v_to IN ('paused', 'inactive') AND v_state <> '22023:lifecycle_stage_unknown')
           OR (SELECT lifecycle_state FROM public.organizations WHERE id = v_org) <> v_from
           OR (SELECT count(*) FROM public.admin_audit_log) <> v_ledger THEN
          v_bad := v_bad || (v_from || '>' || v_to || ':' || v_state);
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  PERFORM pg_temp.mo_assert('lifecycle.matrix_exact',
    cardinality(v_bad) = 0
    AND (SELECT array_agg(x ORDER BY x) FROM unnest(v_seen_allowed) x)
      = (SELECT array_agg(x ORDER BY x) FROM unnest(v_allowed) x));

  -- The noop returns changed = false.
  PERFORM pg_temp.mo_no_claims();
  UPDATE public.organizations SET lifecycle_state = 'prospect' WHERE id = v_org;
  PERFORM pg_temp.mo_claims(v_pa);
  SET LOCAL ROLE authenticated;
  v_result := public.platform_set_org_lifecycle(v_org, 'prospect');
  RESET ROLE;
  PERFORM pg_temp.mo_assert('lifecycle.same_stage_noop', NOT (v_result->>'changed')::boolean AND v_result->>'auditId' IS NULL);

  -- Unknown organization.
  PERFORM pg_temp.mo_claims(v_pa);
  SET LOCAL ROLE authenticated;
  v_state := pg_temp.mo_try(format('SELECT public.platform_set_org_lifecycle(%L::uuid, %L)', gen_random_uuid(), 'active'));
  RESET ROLE;
  PERFORM pg_temp.mo_assert('lifecycle.unknown_org_p0002', v_state = 'P0002:org_not_found');
END
$$;

DO $$
DECLARE
  v_admin_a uuid := '7d100000-0000-4000-8000-000000000002';
  v_ledger bigint := (SELECT count(*) FROM public.admin_audit_log);
  v_state text;
  v_direct text;
BEGIN
  PERFORM pg_temp.mo_claims(v_admin_a);
  SET LOCAL ROLE authenticated;
  v_state := pg_temp.mo_try($q$SELECT public.platform_set_org_lifecycle('7d200000-0000-4000-8000-000000000001'::uuid, 'offboarded')$q$);
  v_direct := pg_temp.mo_try($q$UPDATE public.organizations SET lifecycle_state = 'active' WHERE id = '7d200000-0000-4000-8000-000000000003'$q$);
  RESET ROLE;
  PERFORM pg_temp.mo_assert('lifecycle.org_admin_denied_42501',
    v_state = '42501:platform_admin_required'
    AND (SELECT count(*) FROM public.admin_audit_log) = v_ledger
    AND (SELECT lifecycle_state FROM public.organizations WHERE id = '7d200000-0000-4000-8000-000000000001') = 'active');
  -- No client write path to lifecycle_state exists (no UPDATE policy).
  PERFORM pg_temp.mo_assert('lifecycle.no_direct_client_write',
    (SELECT lifecycle_state FROM public.organizations WHERE id = '7d200000-0000-4000-8000-000000000003') = 'inactive');
END
$$;

-- ---------------------------------------------------------------------------
-- The offboarded write freeze: rejected while offboarded (and for legacy
-- inactive), allowed again after Reopen; reads keep working.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_pa uuid := '7d100000-0000-4000-8000-000000000001';
  v_spec uuid := '7d100000-0000-4000-8000-000000000003';
  v_org_a uuid := '7d200000-0000-4000-8000-000000000001';
  v_before_insert text;
  v_insert text;
  v_update text;
  v_delete text;
  v_service text;
  v_operator text;
  v_audit text;
  v_reads bigint;
  v_inactive text;
  v_after_reopen text;
  v_result jsonb;
BEGIN
  PERFORM pg_temp.mo_claims(v_spec);
  SET LOCAL ROLE authenticated;
  v_before_insert := pg_temp.mo_try(format(
    $q$INSERT INTO public.providers (org_id, first_name, last_name) VALUES (%L, 'Synthetic', 'Before Freeze')$q$, v_org_a));
  RESET ROLE;
  PERFORM pg_temp.mo_assert('freeze.active_org_writable', v_before_insert = '00000');

  PERFORM pg_temp.mo_claims(v_pa);
  SET LOCAL ROLE authenticated;
  v_result := public.platform_set_org_lifecycle(v_org_a, 'offboarded');
  RESET ROLE;

  PERFORM pg_temp.mo_claims(v_spec);
  SET LOCAL ROLE authenticated;
  v_insert := pg_temp.mo_try(format(
    $q$INSERT INTO public.providers (org_id, first_name, last_name) VALUES (%L, 'Synthetic', 'Frozen')$q$, v_org_a));
  v_update := pg_temp.mo_try(
    $q$UPDATE public.providers SET last_name = 'Changed' WHERE id = '7d400000-0000-4000-8000-000000000001'$q$);
  v_audit := pg_temp.mo_try(format(
    $q$INSERT INTO public.audit_log (org_id, action_type, entity_type, description) VALUES (%L, 'READ', 'provider', 'synthetic read')$q$, v_org_a));
  SELECT count(*) INTO v_reads FROM public.providers WHERE org_id = v_org_a;
  v_inactive := pg_temp.mo_try(
    $q$INSERT INTO public.providers (org_id, first_name, last_name) VALUES ('7d200000-0000-4000-8000-000000000003', 'Synthetic', 'Legacy')$q$);
  RESET ROLE;

  -- DELETE through the API path (claims present; run as owner so RLS, which
  -- grants members no provider DELETE, is not what refuses it).
  v_delete := pg_temp.mo_try($q$DELETE FROM public.touches WHERE org_id = '7d200000-0000-4000-8000-000000000001'$q$);
  PERFORM pg_temp.mo_claims(NULL, 'service_role');
  v_service := pg_temp.mo_try(format(
    $q$INSERT INTO public.provider_groups (org_id, name) VALUES (%L, 'MO service write')$q$, v_org_a));
  PERFORM pg_temp.mo_no_claims();
  v_operator := pg_temp.mo_try(format(
    $q$INSERT INTO public.provider_groups (id, org_id, name) VALUES ('7d700000-0000-4000-8000-0000000000f1', %L, 'MO operator write')$q$, v_org_a));

  PERFORM pg_temp.mo_assert('freeze.member_insert_rejected', v_insert = '42501:org_offboarded');
  PERFORM pg_temp.mo_assert('freeze.member_update_rejected', v_update = '42501:org_offboarded'
    AND (SELECT last_name FROM public.providers WHERE id = '7d400000-0000-4000-8000-000000000001') = 'Zyxwvutsrq');
  PERFORM pg_temp.mo_assert('freeze.delete_rejected', v_delete = '42501:org_offboarded'
    AND (SELECT count(*) FROM public.touches WHERE org_id = v_org_a) = 1);
  PERFORM pg_temp.mo_assert('freeze.service_role_api_rejected', v_service = '42501:org_offboarded');
  PERFORM pg_temp.mo_assert('freeze.reads_still_work', v_reads = 4);
  PERFORM pg_temp.mo_assert('freeze.audit_log_exempt', v_audit = '00000');
  PERFORM pg_temp.mo_assert('freeze.legacy_inactive_frozen', v_inactive = '42501:org_offboarded');
  PERFORM pg_temp.mo_assert('freeze.operator_session_not_api', v_operator = '00000');
  PERFORM pg_temp.mo_assert('freeze.offboarding_ledger_row',
    (v_result->>'changed')::boolean
    AND (SELECT action FROM public.admin_audit_log WHERE id = (v_result->>'auditId')::uuid) = 'org.lifecycle_change');
  PERFORM pg_temp.mo_assert('freeze.global_rows_never_frozen',
    pg_temp.mo_try($q$UPDATE public.payers SET name = name WHERE org_id IS NULL$q$) = '00000');

  -- Reopen: offboarded -> active, and writes work again.
  PERFORM pg_temp.mo_claims(v_pa);
  SET LOCAL ROLE authenticated;
  v_result := public.platform_set_org_lifecycle(v_org_a, 'active');
  RESET ROLE;
  PERFORM pg_temp.mo_claims(v_spec);
  SET LOCAL ROLE authenticated;
  v_after_reopen := pg_temp.mo_try(format(
    $q$INSERT INTO public.providers (org_id, first_name, last_name) VALUES (%L, 'Synthetic', 'After Reopen')$q$, v_org_a));
  RESET ROLE;
  PERFORM pg_temp.mo_assert('freeze.reopen_allows_writes', v_after_reopen = '00000' AND (v_result->>'changed')::boolean);
  PERFORM pg_temp.mo_no_claims();
END
$$;

-- The consent exceptions live in the trigger function itself, so they hold on
-- a trigger attached by hand (temp stand-ins for the audit-backlog lane's
-- sms_consents and sms_consent_archive; TG_TABLE_NAME carries no schema).
CREATE TEMP TABLE sms_consents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid);
CREATE TEMP TABLE sms_consent_archive (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid);
CREATE TRIGGER block_writes_when_offboarded BEFORE INSERT OR UPDATE OR DELETE ON pg_temp.sms_consents
  FOR EACH ROW EXECUTE FUNCTION public.block_writes_when_offboarded();
CREATE TRIGGER block_writes_when_offboarded BEFORE INSERT OR UPDATE OR DELETE ON pg_temp.sms_consent_archive
  FOR EACH ROW EXECUTE FUNCTION public.block_writes_when_offboarded();
INSERT INTO pg_temp.sms_consents (id, org_id)
VALUES ('7d800000-0000-4000-8000-000000000001', '7d200000-0000-4000-8000-000000000003');

DO $$
DECLARE
  v_insert text;
  v_update text;
  v_delete text;
  v_archive text;
  v_archive_update text;
BEGIN
  PERFORM pg_temp.mo_claims(NULL, 'service_role');
  v_insert := pg_temp.mo_try($q$INSERT INTO pg_temp.sms_consents (org_id) VALUES ('7d200000-0000-4000-8000-000000000003')$q$);
  v_update := pg_temp.mo_try($q$UPDATE pg_temp.sms_consents SET org_id = org_id$q$);
  v_archive := pg_temp.mo_try($q$INSERT INTO pg_temp.sms_consent_archive (org_id) VALUES ('7d200000-0000-4000-8000-000000000003')$q$);
  v_archive_update := pg_temp.mo_try($q$UPDATE pg_temp.sms_consent_archive SET org_id = org_id$q$);
  v_delete := pg_temp.mo_try($q$DELETE FROM pg_temp.sms_consents$q$);
  PERFORM pg_temp.mo_no_claims();
  PERFORM pg_temp.mo_assert('freeze.sms_consents_insert_update_rejected',
    v_insert = '42501:org_offboarded' AND v_update = '42501:org_offboarded');
  PERFORM pg_temp.mo_assert('freeze.sms_consents_delete_allowed',
    v_delete = '00000' AND NOT EXISTS (SELECT 1 FROM pg_temp.sms_consents));
  PERFORM pg_temp.mo_assert('freeze.sms_consent_archive_insert_allowed',
    v_archive = '00000' AND v_archive_update = '42501:org_offboarded');
END
$$;

-- ---------------------------------------------------------------------------
-- platform_org_summary: denied to everyone but platform admins; counts for
-- exactly the organization asked for; no provider rows or names.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_pa uuid := '7d100000-0000-4000-8000-000000000001';
  v_admin_a uuid := '7d100000-0000-4000-8000-000000000002';
  v_a jsonb;
  v_b jsonb;
  v_member text;
  v_anon text;
  v_unknown text;
BEGIN
  PERFORM pg_temp.mo_claims(v_admin_a);
  SET LOCAL ROLE authenticated;
  v_member := pg_temp.mo_try($q$SELECT public.platform_org_summary('7d200000-0000-4000-8000-000000000001'::uuid)$q$);
  RESET ROLE;
  PERFORM pg_temp.mo_no_claims();
  SET LOCAL ROLE anon;
  v_anon := pg_temp.mo_try($q$SELECT public.platform_org_summary('7d200000-0000-4000-8000-000000000001'::uuid)$q$);
  RESET ROLE;

  PERFORM pg_temp.mo_claims(v_pa);
  SET LOCAL ROLE authenticated;
  v_a := public.platform_org_summary('7d200000-0000-4000-8000-000000000001');
  v_b := public.platform_org_summary('7d200000-0000-4000-8000-000000000002');
  v_unknown := pg_temp.mo_try(format('SELECT public.platform_org_summary(%L::uuid)', gen_random_uuid()));
  RESET ROLE;
  PERFORM pg_temp.mo_no_claims();

  PERFORM pg_temp.mo_assert('summary.member_denied_42501', v_member = '42501:platform_admin_required');
  PERFORM pg_temp.mo_assert('summary.anon_denied', v_anon LIKE '42501:%');
  PERFORM pg_temp.mo_assert('summary.unknown_org_p0002', v_unknown = 'P0002:org_not_found');
  PERFORM pg_temp.mo_assert('summary.keys_exact',
    pg_temp.mo_keys(v_a) = ARRAY['cases', 'groups', 'lastActivityAt', 'members', 'orgId', 'owner', 'pendingInvites', 'providers']
    AND pg_temp.mo_keys(v_a->'providers') = ARRAY['active', 'inCredentialing', 'onboarding', 'pendingVerification', 'terminated', 'total']
    AND pg_temp.mo_keys(v_a->'cases') = ARRAY['byStatus', 'open']
    AND pg_temp.mo_keys(v_a->'cases'->'byStatus') = ARRAY['action_required', 'in_progress', 'in_review', 'not_started', 'submitted']);
  -- Org A after the freeze section: 3 fixture providers + 2 inserted (the
  -- provider default status is onboarding).
  PERFORM pg_temp.mo_assert('summary.org_a_counts',
    v_a->>'orgId' = '7d200000-0000-4000-8000-000000000001'
    AND v_a->'owner' = jsonb_build_object('name', 'Synthetic Owner A', 'email', 'owner-a@example.invalid')
    AND v_a->'providers' = jsonb_build_object('total', 5, 'onboarding', 3, 'pendingVerification', 1,
                                              'active', 1, 'inCredentialing', 2, 'terminated', 1)
    AND v_a->'cases' = jsonb_build_object('open', 2, 'byStatus', jsonb_build_object(
          'not_started', 0, 'in_progress', 1, 'submitted', 1, 'in_review', 0, 'action_required', 0))
    AND (v_a->>'members')::int = 2
    AND (v_a->>'pendingInvites')::int = 2
    AND v_a->>'lastActivityAt' = '2026-10-30T15:04:05.123Z');
  PERFORM pg_temp.mo_assert('summary.org_a_groups_non_phi_identifiers',
    v_a->'groups' = jsonb_build_array(
      jsonb_build_object('id', '7d700000-0000-4000-8000-000000000001', 'name', 'MO Group A1',
                         'tinLast4', '6789', 'npi', '1234567893', 'active', true),
      jsonb_build_object('id', '7d700000-0000-4000-8000-000000000002', 'name', 'MO Group A2',
                         'tinLast4', NULL, 'npi', NULL, 'active', true),
      jsonb_build_object('id', '7d700000-0000-4000-8000-0000000000f1', 'name', 'MO operator write',
                         'tinLast4', NULL, 'npi', NULL, 'active', true)));
  PERFORM pg_temp.mo_assert('summary.cross_org_id_returns_that_org_only',
    v_b->>'orgId' = '7d200000-0000-4000-8000-000000000002'
    AND v_b->'owner' = 'null'::jsonb
    AND v_b->'groups' = jsonb_build_array(jsonb_build_object('id', '7d700000-0000-4000-8000-000000000003',
          'name', 'MO Group B1', 'tinLast4', '4321', 'npi', '1987654325', 'active', true))
    AND v_b->'providers' = jsonb_build_object('total', 1, 'onboarding', 0, 'pendingVerification', 0,
                                              'active', 1, 'inCredentialing', 1, 'terminated', 0)
    AND (v_b->'cases'->>'open')::int = 1
    AND (v_b->>'members')::int = 1
    AND (v_b->>'pendingInvites')::int = 1
    AND v_b->>'lastActivityAt' = '2026-09-01T08:00:00.000Z');
  PERFORM pg_temp.mo_assert('summary.no_provider_names_or_full_tin',
    position('Zyxwvutsrq' IN v_a::text) = 0
    AND position('551116789' IN v_a::text) = 0
    AND position('55-1116789' IN v_a::text) = 0
    AND position('first_name' IN v_a::text) = 0);
END
$$;

-- ---------------------------------------------------------------------------
-- platform_create_organization: one call, the prospect stage, the operator's
-- slug, one org.create row.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_pa uuid := '7d100000-0000-4000-8000-000000000001';
  v_admin_a uuid := '7d100000-0000-4000-8000-000000000002';
  v_result jsonb;
  v_org public.organizations%ROWTYPE;
  v_ledger bigint;
  v_denied text;
  v_bad_slug text;
  v_taken text;
  v_dup_name text;
  v_missing_owner text;
  v_rename text;
  v_row public.admin_audit_log%ROWTYPE;
BEGIN
  PERFORM pg_temp.mo_claims(v_admin_a);
  SET LOCAL ROLE authenticated;
  v_denied := pg_temp.mo_try($q$SELECT public.platform_create_organization('MO New Org', 'mo-new-org', 'Pat Owner', 'pat@example.invalid', NULL)$q$);
  RESET ROLE;
  PERFORM pg_temp.mo_assert('create.non_admin_denied_42501', v_denied = '42501:platform_admin_required'
    AND NOT EXISTS (SELECT 1 FROM public.organizations WHERE slug = 'mo-new-org'));

  v_ledger := (SELECT count(*) FROM public.admin_audit_log);
  PERFORM pg_temp.mo_claims(v_pa);
  SET LOCAL ROLE authenticated;
  v_bad_slug := pg_temp.mo_try($q$SELECT public.platform_create_organization('MO New Org', 'MO New Org', 'Pat Owner', 'pat@example.invalid', NULL)$q$);
  v_taken := pg_temp.mo_try($q$SELECT public.platform_create_organization('MO New Org', 'mo-synthetic-org-b', 'Pat Owner', 'pat@example.invalid', NULL)$q$);
  v_dup_name := pg_temp.mo_try($q$SELECT public.platform_create_organization('mo synthetic ORG b', 'mo-other-slug', 'Pat Owner', 'pat@example.invalid', NULL)$q$);
  v_missing_owner := pg_temp.mo_try($q$SELECT public.platform_create_organization('MO New Org', 'mo-new-org', '', 'pat@example.invalid', NULL)$q$);
  v_result := public.platform_create_organization('  MO New Org ', ' Mo-New-Org ', 'Pat Owner', 'pat@example.invalid', ' pilot ');
  RESET ROLE;
  PERFORM pg_temp.mo_no_claims();

  PERFORM pg_temp.mo_assert('create.slug_invalid', v_bad_slug = '22023:slug_invalid');
  PERFORM pg_temp.mo_assert('create.slug_taken', v_taken = '23505:slug_taken');
  PERFORM pg_temp.mo_assert('create.duplicate_name_refused',
    v_dup_name LIKE 'P0001:An organization named "mo synthetic ORG b" already exists.%');
  PERFORM pg_temp.mo_assert('create.owner_required', v_missing_owner = 'P0001:Owner name is required');

  SELECT * INTO v_org FROM public.organizations WHERE id = (v_result->>'orgId')::uuid;
  PERFORM pg_temp.mo_assert('create.org_row',
    v_org.name = 'MO New Org' AND v_org.slug = 'mo-new-org' AND v_org.plan_tier = 'pilot'
    AND v_org.lifecycle_state = 'prospect'
    AND v_result->>'slug' = 'mo-new-org');
  PERFORM pg_temp.mo_assert('create.owner_party_and_creator_membership',
    EXISTS (SELECT 1 FROM public.party_role_assignments a JOIN public.parties p ON p.id = a.party_id
             WHERE a.org_id = v_org.id AND a.role_key = 'owner' AND p.name = 'Pat Owner'
               AND p.email = 'pat@example.invalid')
    AND (SELECT role FROM public.memberships WHERE org_id = v_org.id AND user_id = v_pa) = 'admin'
    AND (SELECT count(*) FROM public.status_configs WHERE org_id = v_org.id) = 22);
  SELECT * INTO v_row FROM public.admin_audit_log WHERE id = (v_result->>'auditId')::uuid;
  PERFORM pg_temp.mo_assert('create.one_ledger_row',
    (SELECT count(*) FROM public.admin_audit_log) = v_ledger + 1
    AND v_row.action = 'org.create' AND v_row.actor_user_id = v_pa AND v_row.org_id = v_org.id
    AND v_row.after->>'slug' = 'mo-new-org' AND v_row.after->'owner'->>'email' = 'pat@example.invalid');
  PERFORM pg_temp.mo_assert('create.setting_cleared',
    coalesce(current_setting('minted.new_org_slug', true), '') = '');

  v_rename := pg_temp.mo_try(format($q$UPDATE public.organizations SET slug = 'mo-new-org-2' WHERE id = %L$q$, v_org.id));
  PERFORM pg_temp.mo_assert('create.slug_fixed_after_creation', v_rename = '23514:slug_immutable');
END
$$;

-- ---------------------------------------------------------------------------
-- platform_grant_membership: self only, admin, one ledger row, works on an
-- offboarded organization (memberships are exempt from the freeze).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_pa uuid := '7d100000-0000-4000-8000-000000000001';
  v_admin_a uuid := '7d100000-0000-4000-8000-000000000002';
  v_org_c uuid := '7d200000-0000-4000-8000-000000000003';
  v_denied text;
  v_first jsonb;
  v_second jsonb;
  v_ledger bigint;
  v_row public.admin_audit_log%ROWTYPE;
  v_reads bigint;
BEGIN
  PERFORM pg_temp.mo_claims(v_admin_a);
  SET LOCAL ROLE authenticated;
  v_denied := pg_temp.mo_try(format('SELECT public.platform_grant_membership(%L::uuid)', v_org_c));
  RESET ROLE;
  PERFORM pg_temp.mo_assert('grant.non_admin_denied_42501', v_denied = '42501:platform_admin_required'
    AND NOT EXISTS (SELECT 1 FROM public.memberships WHERE org_id = v_org_c AND user_id = v_admin_a));

  v_ledger := (SELECT count(*) FROM public.admin_audit_log);
  PERFORM pg_temp.mo_claims(v_pa);
  SET LOCAL ROLE authenticated;
  v_first := public.platform_grant_membership(v_org_c);
  v_second := public.platform_grant_membership(v_org_c);
  SELECT count(*) INTO v_reads FROM public.providers WHERE org_id = v_org_c;
  RESET ROLE;
  PERFORM pg_temp.mo_no_claims();

  SELECT * INTO v_row FROM public.admin_audit_log WHERE id = (v_first->>'auditId')::uuid;
  PERFORM pg_temp.mo_assert('grant.membership_admin_on_offboarded_org',
    (v_first->>'changed')::boolean
    AND (SELECT role FROM public.memberships WHERE org_id = v_org_c AND user_id = v_pa) = 'admin');
  PERFORM pg_temp.mo_assert('grant.one_ledger_row',
    v_row.action = 'membership.grant' AND v_row.actor_user_id = v_pa AND v_row.org_id = v_org_c
    AND v_row.target_type = 'user' AND v_row.target_id = v_pa::text AND v_row.before IS NULL
    AND (SELECT count(*) FROM public.admin_audit_log) = v_ledger + 1);
  PERFORM pg_temp.mo_assert('grant.repeat_is_noop', NOT (v_second->>'changed')::boolean);
  PERFORM pg_temp.mo_assert('grant.membership_opens_reads', v_reads = 1);
END
$$;

-- ---------------------------------------------------------------------------
-- update_organization_profile: the caller is resolved inside.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_pa uuid := '7d100000-0000-4000-8000-000000000001';
  v_admin_a uuid := '7d100000-0000-4000-8000-000000000002';
  v_spec uuid := '7d100000-0000-4000-8000-000000000003';
  v_admin_b uuid := '7d100000-0000-4000-8000-000000000004';
  v_org_a uuid := '7d200000-0000-4000-8000-000000000001';
  v_org_b uuid := '7d200000-0000-4000-8000-000000000002';
  v_org_c uuid := '7d200000-0000-4000-8000-000000000003';
  v_result jsonb;
  v_noop jsonb;
  v_ledger bigint;
  v_audit bigint;
  v_row public.admin_audit_log%ROWTYPE;
  v_spec_state text;
  v_cross text;
  v_tier text;
  v_frozen text;
  v_dup text;
  v_customer jsonb;
BEGIN
  -- Platform admin: name, owner and plan tier; one org.update row.
  v_ledger := (SELECT count(*) FROM public.admin_audit_log);
  PERFORM pg_temp.mo_claims(v_pa);
  SET LOCAL ROLE authenticated;
  v_result := public.update_organization_profile(v_org_b, 'MO Synthetic Org B Renamed', 'Bea Owner', 'bea@example.invalid', 'standard');
  v_noop := public.update_organization_profile(v_org_b, 'MO Synthetic Org B Renamed', 'Bea Owner', 'bea@example.invalid', 'standard');
  v_frozen := pg_temp.mo_try(format($q$SELECT public.update_organization_profile(%L::uuid, 'MO C', 'C Owner', 'c@example.invalid', NULL)$q$, v_org_c));
  v_dup := pg_temp.mo_try(format($q$SELECT public.update_organization_profile(%L::uuid, 'mo synthetic org a', 'Bea Owner', 'bea@example.invalid', 'standard')$q$, v_org_b));
  RESET ROLE;
  PERFORM pg_temp.mo_no_claims();
  SELECT * INTO v_row FROM public.admin_audit_log WHERE id = (v_result->>'auditId')::uuid;
  PERFORM pg_temp.mo_assert('profile.platform_admin_updates',
    (v_result->>'changed')::boolean
    AND (SELECT name || '|' || plan_tier FROM public.organizations WHERE id = v_org_b) = 'MO Synthetic Org B Renamed|standard'
    AND (SELECT slug FROM public.organizations WHERE id = v_org_b) = 'mo-synthetic-org-b'
    AND EXISTS (SELECT 1 FROM public.party_role_assignments a JOIN public.parties p ON p.id = a.party_id
                 WHERE a.org_id = v_org_b AND a.role_key = 'owner' AND p.name = 'Bea Owner'
                   AND p.email = 'bea@example.invalid' AND p.first_name = 'Bea' AND p.last_name = 'Owner'));
  PERFORM pg_temp.mo_assert('profile.platform_one_ledger_row',
    v_row.action = 'org.update' AND v_row.org_id = v_org_b AND v_row.actor_user_id = v_pa
    AND v_row.before->>'name' = 'MO Synthetic Org B' AND v_row.before->'owner' = 'null'::jsonb
    AND v_row.after->'owner'->>'name' = 'Bea Owner'
    AND (SELECT count(*) FROM public.admin_audit_log) = v_ledger + 1);
  PERFORM pg_temp.mo_assert('profile.no_change_writes_nothing',
    NOT (v_noop->>'changed')::boolean AND (SELECT count(*) FROM public.admin_audit_log) = v_ledger + 1);
  PERFORM pg_temp.mo_assert('profile.offboarded_refused', v_frozen = '42501:org_offboarded');
  PERFORM pg_temp.mo_assert('profile.duplicate_name_refused',
    v_dup LIKE 'P0001:An organization named "mo synthetic org a" already exists.%');

  -- The organization's own admin: name and owner, audit_log not the ledger;
  -- plan tier is platform-only; a specialist and another org's admin are refused.
  v_ledger := (SELECT count(*) FROM public.admin_audit_log);
  v_audit := (SELECT count(*) FROM public.audit_log WHERE org_id = v_org_a AND entity_type = 'organization');
  PERFORM pg_temp.mo_claims(v_admin_a);
  SET LOCAL ROLE authenticated;
  v_customer := public.update_organization_profile(v_org_a, 'MO Synthetic Org A Plus', 'Synthetic Owner A2', 'owner-a2@example.invalid', NULL);
  v_tier := pg_temp.mo_try(format($q$SELECT public.update_organization_profile(%L::uuid, 'MO Synthetic Org A Plus', 'Synthetic Owner A2', 'owner-a2@example.invalid', 'enterprise')$q$, v_org_a));
  RESET ROLE;
  PERFORM pg_temp.mo_claims(v_spec);
  SET LOCAL ROLE authenticated;
  v_spec_state := pg_temp.mo_try(format($q$SELECT public.update_organization_profile(%L::uuid, 'X', 'Y Z', 'y@example.invalid', NULL)$q$, v_org_a));
  RESET ROLE;
  PERFORM pg_temp.mo_claims(v_admin_b);
  SET LOCAL ROLE authenticated;
  v_cross := pg_temp.mo_try(format($q$SELECT public.update_organization_profile(%L::uuid, 'X', 'Y Z', 'y@example.invalid', NULL)$q$, v_org_a));
  RESET ROLE;
  PERFORM pg_temp.mo_no_claims();

  PERFORM pg_temp.mo_assert('profile.org_admin_updates_via_audit_log',
    (v_customer->>'changed')::boolean
    AND (SELECT name FROM public.organizations WHERE id = v_org_a) = 'MO Synthetic Org A Plus'
    AND (SELECT p.email FROM public.parties p WHERE p.id = '7d600000-0000-4000-8000-000000000001') = 'owner-a2@example.invalid'
    AND (SELECT count(*) FROM public.audit_log WHERE org_id = v_org_a AND entity_type = 'organization') = v_audit + 1
    AND (SELECT user_id FROM public.audit_log WHERE id = (v_customer->>'auditId')::uuid) = v_admin_a
    AND (SELECT count(*) FROM public.admin_audit_log) = v_ledger);
  PERFORM pg_temp.mo_assert('profile.plan_tier_platform_only', v_tier = '42501:plan_tier_platform_only');
  PERFORM pg_temp.mo_assert('profile.specialist_denied', v_spec_state = '42501:org_admin_required');
  PERFORM pg_temp.mo_assert('profile.other_org_admin_denied', v_cross = '42501:org_admin_required');
END
$$;

SELECT label || '|' || CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END
FROM pg_temp.mo_results
ORDER BY ordinal;

DO $$
DECLARE
  failed bigint;
BEGIN
  SELECT count(*) INTO failed FROM pg_temp.mo_results WHERE NOT passed;
  IF failed <> 0 THEN
    RAISE EXCEPTION 'MISSION_CONTROL_ORGANIZATIONS_TEST_FAILED: %',
      (SELECT string_agg(label, ', ' ORDER BY ordinal) FROM pg_temp.mo_results WHERE NOT passed);
  END IF;
END
$$;

SELECT 'MISSION_CONTROL_ORGANIZATIONS|PASS';
ROLLBACK;
