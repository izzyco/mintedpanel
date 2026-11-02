-- Mission Control M3: the organization RPCs behind /mission-control/organizations.
--
--   platform_create_organization(name, slug, owner_name, owner_email, plan_tier)
--     One form, one click. Reuses create_organization(name), the existing
--     overload with no duplicate-name refusal (organization row, the caller as
--     its first admin member, the canonical status_configs, the audit_log
--     row), with the operator's slug passed to the insert through the
--     transaction-local setting minted.new_org_slug (20261102163000); then
--     the prospect stage, plan_tier and the owner party (the same owner checks
--     and party rows as the 3-arg overload). A name that matches an existing
--     organization's normalized name is allowed (Sowmya, Nov 1 2026: business
--     policy, not a boundary); Mission Control shows a notice linking the
--     other organization. The existing create_organization overloads are
--     unchanged and keep their own refusal for their callers. The escalation
--     contact and sales rep are added later on the organization's page.
--   platform_grant_membership(org_id)
--     "Grant myself admin membership": the caller, as admin, one click. A
--     platform admin never opens an organization's data without a membership.
--   platform_org_summary(org_id)
--     Counts and non-PHI identifiers for the detail page, so no tenant table
--     is widened: owner contact, groups (name, TIN last four, group NPI),
--     providers by bucket, open cases by status, members, pending invites,
--     last activity. No provider rows, no names of providers.
--   update_organization_profile(org_id, name, owner_name, owner_email, plan_tier)
--     The one organization profile write, with the caller resolved inside: a
--     platform admin (admin_audit_log org.update) or the organization's own
--     admin (audit_log UPDATE). Only a platform admin may change plan_tier.
--     Refused while the organization is offboarded. A duplicate normalized
--     name is allowed, as at creation.
--
-- Every platform-admin mutation writes exactly one admin_audit_log row in the
-- same transaction; a call that changes nothing writes nothing. All four are
-- SECURITY DEFINER with search_path pinned, no DEFAULT arguments, jsonb
-- returns. Idempotent.

CREATE OR REPLACE FUNCTION public.platform_create_organization(
  p_name text,
  p_slug text,
  p_owner_name text,
  p_owner_email text,
  p_plan_tier text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_tier text := nullif(btrim(coalesce(p_plan_tier, '')), '');
  v_owner_name text := btrim(coalesce(p_owner_name, ''));
  v_owner_email text := btrim(coalesce(p_owner_email, ''));
  v_email_re constant text := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
  v_org_id uuid;
  v_party_id uuid;
  v_org public.organizations%ROWTYPE;
  v_audit_id uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'platform_admin_required';
  END IF;
  IF btrim(coalesce(p_name, '')) = '' THEN RAISE EXCEPTION 'Organization name is required'; END IF;
  IF v_owner_name = '' THEN RAISE EXCEPTION 'Owner name is required'; END IF;
  IF v_owner_email = '' THEN RAISE EXCEPTION 'Owner email is required'; END IF;
  IF v_owner_email !~ v_email_re THEN RAISE EXCEPTION 'Owner email is not valid'; END IF;
  IF v_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'slug_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = v_slug) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'slug_taken';
  END IF;

  PERFORM set_config('minted.new_org_slug', v_slug, true);
  v_org_id := public.create_organization(p_name);
  PERFORM set_config('minted.new_org_slug', '', true);

  UPDATE public.organizations
     SET lifecycle_state = 'prospect', plan_tier = v_tier
   WHERE id = v_org_id
  RETURNING * INTO v_org;

  INSERT INTO public.parties (org_id, party_type, name, first_name, last_name, email, created_by)
  VALUES (v_org.id, 'person', v_owner_name,
          nullif(public._party_first_name(v_owner_name), ''),
          nullif(public._party_last_name(v_owner_name), ''),
          v_owner_email, v_actor)
  RETURNING id INTO v_party_id;
  INSERT INTO public.party_role_assignments (org_id, party_id, role_key, scope_type, is_default)
  VALUES (v_org.id, v_party_id, 'owner', 'org', true);

  INSERT INTO public.admin_audit_log
    (actor_user_id, actor_email, action, target_type, target_id, org_id, before, after, description)
  VALUES (
    v_actor,
    (SELECT u.email FROM auth.users u WHERE u.id = v_actor),
    'org.create',
    'organization',
    v_org.id::text,
    v_org.id,
    NULL,
    jsonb_build_object(
      'name', v_org.name,
      'slug', v_org.slug,
      'planTier', v_org.plan_tier,
      'lifecycleState', v_org.lifecycle_state,
      'owner', jsonb_build_object('name', v_owner_name, 'email', v_owner_email),
      'creatorRole', 'admin'),
    'Created organization ' || v_org.name
  )
  RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'orgId', v_org.id,
    'name', v_org.name,
    'slug', v_org.slug,
    'planTier', v_org.plan_tier,
    'lifecycleState', v_org.lifecycle_state,
    'auditId', v_audit_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.platform_create_organization(text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_create_organization(text, text, text, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.platform_grant_membership(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_before text;
  v_audit_id uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'platform_admin_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'org_not_found';
  END IF;

  SELECT m.role INTO v_before
    FROM public.memberships m
   WHERE m.org_id = p_org_id AND m.user_id = v_actor
   FOR UPDATE;

  IF v_before = 'admin' THEN
    RETURN jsonb_build_object('orgId', p_org_id, 'userId', v_actor, 'role', 'admin',
                              'changed', false, 'auditId', NULL);
  END IF;

  INSERT INTO public.memberships (org_id, user_id, role)
  VALUES (p_org_id, v_actor, 'admin')
  ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'admin';

  INSERT INTO public.admin_audit_log
    (actor_user_id, actor_email, action, target_type, target_id, org_id, before, after, description)
  VALUES (
    v_actor,
    (SELECT u.email FROM auth.users u WHERE u.id = v_actor),
    'membership.grant',
    'user',
    v_actor::text,
    p_org_id,
    CASE WHEN v_before IS NULL THEN NULL ELSE jsonb_build_object('role', v_before) END,
    jsonb_build_object('role', 'admin'),
    'Granted self admin membership'
  )
  RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object('orgId', p_org_id, 'userId', v_actor, 'role', 'admin',
                            'changed', true, 'auditId', v_audit_id);
END;
$$;
REVOKE ALL ON FUNCTION public.platform_grant_membership(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_grant_membership(uuid) TO authenticated, service_role;

-- Counts only. Every key is always present; counts are integers. The open
-- case statuses are src/lib/caseStatus.ts OPEN_CASE_STATUSES, as in
-- platform_metrics().
CREATE OR REPLACE FUNCTION public.platform_org_summary(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'platform_admin_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'org_not_found';
  END IF;

  RETURN jsonb_build_object(
    'orgId', p_org_id,
    'owner', (
      SELECT jsonb_build_object('name', p.name, 'email', p.email)
        FROM public.party_role_assignments a
        JOIN public.parties p ON p.id = a.party_id AND p.org_id = a.org_id
       WHERE a.org_id = p_org_id AND a.role_key = 'owner' AND a.scope_type = 'org'
       ORDER BY a.is_default DESC, a.created_at, a.id
       LIMIT 1
    ),
    'groups', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', g.id,
               'name', g.name,
               'tinLast4', CASE
                 WHEN length(regexp_replace(coalesce(g.tin, ''), '[^0-9]', '', 'g')) >= 4
                 THEN right(regexp_replace(g.tin, '[^0-9]', '', 'g'), 4)
               END,
               'npi', nullif(btrim(coalesce(g.npi_type2, '')), ''),
               'active', g.is_active)
             ORDER BY g.name, g.id)
        FROM public.provider_groups g
       WHERE g.org_id = p_org_id
    ), '[]'::jsonb),
    'providers', (
      SELECT jsonb_build_object(
        'total', count(*),
        'onboarding', count(*) FILTER (WHERE p.status = 'onboarding'),
        'pendingVerification', count(*) FILTER (WHERE p.verification_state = 'pending_verification'),
        'active', count(*) FILTER (WHERE p.status = 'active'),
        'inCredentialing', count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM public.credential_cases c
           WHERE c.org_id = p_org_id AND c.provider_id = p.id)),
        'terminated', count(*) FILTER (WHERE p.status = 'terminated'))
        FROM public.providers p
       WHERE p.org_id = p_org_id
    ),
    'cases', (
      SELECT jsonb_build_object(
        'open', count(*),
        'byStatus', jsonb_build_object(
          'not_started', count(*) FILTER (WHERE c.case_status = 'not_started'),
          'in_progress', count(*) FILTER (WHERE c.case_status = 'in_progress'),
          'submitted', count(*) FILTER (WHERE c.case_status = 'submitted'),
          'in_review', count(*) FILTER (WHERE c.case_status = 'in_review'),
          'action_required', count(*) FILTER (WHERE c.case_status = 'action_required')))
        FROM public.credential_cases c
       WHERE c.org_id = p_org_id
         AND c.case_status IN ('not_started', 'in_progress', 'submitted', 'in_review', 'action_required')
    ),
    'members', (SELECT count(*) FROM public.memberships m WHERE m.org_id = p_org_id),
    'pendingInvites', (SELECT count(*) FROM public.pending_invites i WHERE i.org_id = p_org_id),
    'lastActivityAt', (
      SELECT to_char(max(t.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        FROM public.touches t
       WHERE t.org_id = p_org_id
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.platform_org_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_org_summary(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_organization_profile(
  p_org_id uuid,
  p_name text,
  p_owner_name text,
  p_owner_email text,
  p_plan_tier text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_platform boolean := public.is_platform_admin();
  v_org public.organizations%ROWTYPE;
  v_name text := btrim(coalesce(p_name, ''));
  v_owner_name text := btrim(coalesce(p_owner_name, ''));
  v_owner_email text := btrim(coalesce(p_owner_email, ''));
  v_tier text := nullif(btrim(coalesce(p_plan_tier, '')), '');
  v_email_re constant text := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
  v_party_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_audit_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication_required';
  END IF;
  IF NOT v_platform AND NOT EXISTS (
    SELECT 1 FROM public.memberships m
     WHERE m.org_id = p_org_id AND m.user_id = v_actor AND m.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'org_admin_required';
  END IF;

  SELECT * INTO v_org FROM public.organizations WHERE id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'org_not_found';
  END IF;
  IF NOT public.org_is_writable(p_org_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'org_offboarded';
  END IF;

  IF v_name = '' THEN RAISE EXCEPTION 'Organization name is required'; END IF;
  IF v_owner_name = '' THEN RAISE EXCEPTION 'Owner name is required'; END IF;
  IF v_owner_email = '' THEN RAISE EXCEPTION 'Owner email is required'; END IF;
  IF v_owner_email !~ v_email_re THEN RAISE EXCEPTION 'Owner email is not valid'; END IF;
  IF NOT v_platform AND v_tier IS DISTINCT FROM v_org.plan_tier THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'plan_tier_platform_only';
  END IF;

  SELECT a.party_id INTO v_party_id
    FROM public.party_role_assignments a
   WHERE a.org_id = p_org_id AND a.role_key = 'owner' AND a.scope_type = 'org'
   ORDER BY a.is_default DESC, a.created_at, a.id
   LIMIT 1;

  v_before := jsonb_build_object(
    'name', v_org.name,
    'planTier', v_org.plan_tier,
    'owner', (SELECT jsonb_build_object('name', p.name, 'email', p.email)
                FROM public.parties p WHERE p.id = v_party_id));
  v_after := jsonb_build_object(
    'name', v_name,
    'planTier', v_tier,
    'owner', jsonb_build_object('name', v_owner_name, 'email', v_owner_email));

  IF v_before = v_after THEN
    RETURN v_after || jsonb_build_object('orgId', p_org_id, 'changed', false, 'auditId', NULL);
  END IF;

  UPDATE public.organizations SET name = v_name, plan_tier = v_tier WHERE id = p_org_id;

  IF v_party_id IS NULL THEN
    INSERT INTO public.parties (org_id, party_type, name, first_name, last_name, email, created_by)
    VALUES (p_org_id, 'person', v_owner_name,
            nullif(public._party_first_name(v_owner_name), ''),
            nullif(public._party_last_name(v_owner_name), ''),
            v_owner_email, v_actor)
    RETURNING id INTO v_party_id;
    INSERT INTO public.party_role_assignments (org_id, party_id, role_key, scope_type, is_default)
    VALUES (p_org_id, v_party_id, 'owner', 'org', true);
  ELSE
    UPDATE public.parties
       SET name = v_owner_name,
           first_name = nullif(public._party_first_name(v_owner_name), ''),
           last_name = nullif(public._party_last_name(v_owner_name), ''),
           email = v_owner_email
     WHERE id = v_party_id AND org_id = p_org_id;
  END IF;

  IF v_platform THEN
    INSERT INTO public.admin_audit_log
      (actor_user_id, actor_email, action, target_type, target_id, org_id, before, after, description)
    VALUES (
      v_actor,
      (SELECT u.email FROM auth.users u WHERE u.id = v_actor),
      'org.update',
      'organization',
      p_org_id::text,
      p_org_id,
      v_before,
      v_after,
      'Updated organization profile'
    )
    RETURNING id INTO v_audit_id;
  ELSE
    INSERT INTO public.audit_log
      (org_id, user_id, user_name, action_type, entity_type, entity_id, before, after, description)
    VALUES (
      p_org_id,
      v_actor,
      (SELECT coalesce(nullif(btrim(pr.full_name), ''), pr.email) FROM public.profiles pr WHERE pr.id = v_actor),
      'UPDATE',
      'organization',
      p_org_id,
      v_before,
      v_after,
      'Updated organization profile'
    )
    RETURNING id INTO v_audit_id;
  END IF;

  RETURN v_after || jsonb_build_object('orgId', p_org_id, 'changed', true, 'auditId', v_audit_id);
END;
$$;
REVOKE ALL ON FUNCTION public.update_organization_profile(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_organization_profile(uuid, text, text, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
