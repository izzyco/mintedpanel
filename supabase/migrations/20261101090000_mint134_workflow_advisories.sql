-- MINT-134 workflow advisories: the backend ledger behind the Oct 31 2026 rule
-- "every workflow completes end to end".
--
-- Only security, access control, tenant isolation, privacy, financial, legal
-- and factual-accuracy checks may stop an action. Every other check is an
-- advisory: the action proceeds, the front end stays quiet, and one row here
-- records which check was bypassed, on which record, by whom, from where and
-- when. A row with severity_at_time 'block' records the other case: a
-- critical check stopped an action and someone must know (an SMS refused, a
-- digest skipped for a coordinator with no email). Mission Control lists both
-- later as "Bypassed checks" (M6b). This migration is only the capture: no
-- workflow writes a row yet.
--
-- The check registry is code, not data: src/lib/advisoryChecks.ts holds each
-- check_key with its domain, what it protects, whether it is critical, its
-- "why it matters" text, the record tables it may name and the context keys
-- it may carry. The database accepts only the registered check keys (the
-- VALUES list in private.workflow_advisory_check_key_valid), so a key can't
-- carry text either. A new check key, a new context key or a new value in a
-- context vocabulary is a migration. src/lib/advisoryChecks.contract.test.ts
-- mirrors every vocabulary below against this file's text.
--
-- No PHI, ever. Ids, check keys and check facts only: never provider PII, an
-- entered value, a registry value, a date or free text. record_label is NOT a
-- column: Mission Control's list RPC (a follow-up) computes it from the live
-- row, so a stored name can never outlive the provider.
--
-- context holds declared facts only. Its keys are a closed list (CONTEXT_KEYS
-- in src/lib/advisoryChecks.ts, the VALUES list in
-- private.workflow_advisory_context_valid), and each key has one kind:
--   count         an integer from 0 to the key's own bound: line 100000,
--                 count 9999, the step and list counts 10 to 99. The bounds
--                 of every count key in one context multiply to under
--                 10,000,000, so no context can carry a number of 7 digits
--                 or more (an NPI, a phone, an SSN, a yyyymmdd date), even
--                 split across keys.
--   id, ids       a lowercase UUID, or a set of up to 20, naming an existing
--                 record of the org (a global payer or SOP template counts).
--   token, tokens one value, or a set of up to 20, from the key's closed
--                 vocabulary.
-- A set is sorted (byte order) with no repeats, so its order carries nothing.
--   flag          a boolean (no key uses it yet).
-- There are no open tokens, no free keys and no free check keys, so no field
-- accepts text, an arbitrary number or an arbitrary UUID: a name, an email,
-- an NPI, a phone or a date can't be stored as text under any spelling (a
-- letter prefix, digits split by underscores, a key that is itself the
-- data). These walls stop plain text and accidental leaks, nothing more. A
-- deliberate direct caller with a codebook can still encode data in its
-- choices: which check key and listed values it picks, which org records it
-- names, and its counts. One row's choices add up to well over 7 digits, and
-- rows are unlimited, so such a caller could encode an identifier, as bounded
-- choices, never as text.
-- private.workflow_advisory_context_valid() checks the shape (as the table
-- CHECK and in both record RPCs); private.workflow_advisory_context_ids_in_org()
-- checks the ids (in the record RPCs only: it reads tables, so it can't be a
-- CHECK, and a direct superuser write skips it). isAdvisoryContextValid() and
-- pickDeclared() apply the same shape rules in code before any call.
--
-- Append-only. The only UPDATE is the resolve stamp (resolved_at and
-- resolved_by, NULL to a value, once), applied by resolve_workflow_advisories
-- when a server-side re-check passes; private.workflow_advisories_guard()
-- refuses every other change, including clearing or moving a stamp. No API
-- role holds INSERT, UPDATE or DELETE. The organizations foreign key cascades,
-- so offboarding a tenant still removes its rows.
--
-- Access. RLS on with no policies. service_role may SELECT; nothing is granted
-- to anon or authenticated. Rows are written only through three SECURITY
-- DEFINER RPCs:
--   record_workflow_advisory     authenticated (the actor is auth.uid()) and
--                                service_role (the /api and extension routes
--                                pass the verified actor). Any other caller is
--                                refused in the body.
--   record_job_advisory          service_role. A scheduled job's row has no
--                                actor, and one open row per (org, check,
--                                record) absorbs every repeat until resolved.
--   resolve_workflow_advisories  service_role. Stamps every open row for an
--                                (org, check, record).
-- The read RPC (list_workflow_advisories) and the platform-admin SELECT policy
-- wait for #540's is_platform_admin() and ship in a follow-up.
--
-- Who is calling. A SECURITY DEFINER body runs as its owner, so current_user
-- is the owner there and cannot tell the browser from the server. The caller
-- is the session's SET ROLE, read with current_setting('role'), not the JWT
-- role claim. On hosted, PostgREST connects as authenticator (a member of
-- anon, authenticated and service_role) and sets the role for each request
-- from the signed JWT. No request can change it: PostgREST runs only the API
-- schemas' functions, and none of them runs SET or set_config on role. So a
-- browser session is authenticated, and only a request signed with the
-- service key is service_role. The source is bound to the caller:
-- authenticated may send panel or import, service_role api or extension. The
-- actor's role is read from public.memberships for (org, actor), never taken
-- from the caller; the vocabulary is memberships_role_check's: admin,
-- specialist, billing. record_job_advisory and resolve_workflow_advisories
-- check the session role too (service_role only), so a later SECURITY
-- DEFINER function can't run them under its owner's EXECUTE privilege.
--
-- E6.12 restricted external (client) identities record and resolve nothing.
-- For the browser that is app_authz.is_restricted_external() (it reads
-- auth.uid()). Under the service key auth.uid() is NULL and guard.ts makes no
-- restricted check, so the actor and the resolver a server passes go through
-- app_authz.is_restricted_external_user(p_user_id): the same body with
-- p_user_id in place of auth.uid(), read the same proven way. It is SECURITY
-- DEFINER, owned by minted_e612_authz_owner (NOBYPASSRLS), and reads the
-- forced-RLS tables through E6.12's SELECT grant and owner policies, so it
-- needs nothing from the RPCs' owner but EXECUTE. Unlike the original it
-- names a user, so it is never granted to authenticated or anon (a signed-in
-- user could otherwise ask about someone else): only to service_role and to
-- this migration's executor, which owns the advisory RPCs.
--
-- The record must belong to the org. record_table is a closed set of tables
-- that exist on main and carry org_id: providers, provider_groups, facilities,
-- credential_cases, tasks, touches, import_runs, roster_mappings,
-- sop_templates. private.workflow_advisory_record_in_org() checks
-- (id, org_id) on the named table; a global SOP template (org_id NULL) is no
-- org's record. organizations, profiles and notification_sequences from the
-- design are not in the set: the first has no org_id (it is the org), the
-- second is not owned by an org, and the third is not on main. A check whose
-- record is one of them gains it in its conversion PR's migration.
--
-- Functions referenced by a CHECK or a trigger use CREATE OR REPLACE: a DROP
-- would fail on re-run because the constraint or trigger depends on them.
-- Every signature is new, so CREATE OR REPLACE leaves no PostgREST overload.
--
-- Edited in place before any apply (Nov 1 2026, review of #568: declared
-- context keys only, closed vocabularies, per-key count bounds, context ids
-- checked in the org, source bound to the caller). It has never been applied
-- to a hosted database; it has only run in CI's ephemeral Migration dry-run.
-- Once it is applied anywhere, further changes go in a new migration.
--
-- Additive and re-runnable. REPO-ONLY until an operator applies it, staging
-- first. Nothing calls the RPCs yet; once a conversion PR does, its helper
-- logs advisory_record_failed with SQLSTATE PGRST202 and carries on until the
-- apply, so the workflow is never blocked by a missing ledger.
-- Verify the OBJECTS, not a ledger filename (supabase-migrations skill):
--   SELECT to_regclass('public.workflow_advisories');                  -- non-null
--   SELECT proname, pg_get_function_identity_arguments(oid), prosecdef, proconfig
--     FROM pg_proc WHERE proname IN ('record_workflow_advisory',
--       'record_job_advisory', 'resolve_workflow_advisories');
--     -> p_org_id uuid, p_check_key text, p_severity text, p_record_table text,
--        p_record_id uuid, p_source text, p_context jsonb, p_actor_id uuid | true | {search_path=""}
--     -> p_job text, p_org_id uuid, p_check_key text, p_severity text,
--        p_record_table text, p_record_id uuid, p_context jsonb             | true | {search_path=""}
--     -> p_org_id uuid, p_check_key text, p_record_table text, p_record_id uuid,
--        p_resolved_by uuid                                               | true | {search_path=""}
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'public.workflow_advisories'::regclass AND NOT tgisinternal;
--     -> workflow_advisories_guard
--   SELECT has_function_privilege('anon',
--            'public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)',
--            'EXECUTE'),
--          has_table_privilege('authenticated', 'public.workflow_advisories', 'SELECT');
--     -> false | false
--   SELECT pg_get_userbyid(p.proowner), p.prosecdef,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE'),
--          has_function_privilege('anon', p.oid, 'EXECUTE'),
--          has_function_privilege('service_role', p.oid, 'EXECUTE'),
--          has_function_privilege(
--            (SELECT pg_get_userbyid(r.proowner) FROM pg_proc AS r
--              WHERE r.oid = 'public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)'::regprocedure),
--            p.oid, 'EXECUTE')
--     FROM pg_proc AS p
--    WHERE p.oid = 'app_authz.is_restricted_external_user(uuid)'::regprocedure;
--     -> minted_e612_authz_owner | true | false | false | true | true
--        (the last is the advisory RPCs' owner; false after an ownership
--        change: re-run this migration as the new owner, or re-grant)
--   The behavioural packet, supabase/tests/mint134-workflow-advisories.sql,
--   needs a superuser and runs only in CI's disposable database, never hosted.

-- ---------------------------------------------------------------------------
-- 0. The registered check keys: CHECKS in src/lib/advisoryChecks.ts, row for
--    row (advisoryChecks.contract.test.ts compares them). Any other key is
--    refused, as the table CHECK and in both record RPCs and the resolve
--    RPC. A new check is a migration that replaces this function; adding a
--    key leaves every stored row valid, and a key is never removed while
--    rows carry it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.workflow_advisory_check_key_valid(p_check_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT p_check_key IS NOT NULL AND EXISTS (
    SELECT 1
      FROM (VALUES
        ('assignment.start_date_missing'),
        ('config.override_ignored'),
        ('digest.org_failed'),
        ('digest.recipient_no_email'),
        ('digest.rules_fallback'),
        ('digest.send_time_fallback'),
        ('digest.step_unusable'),
        ('digest.unassigned_follow_ups'),
        ('generation.no_sop'),
        ('generation.required_attribute_missing'),
        ('generation.sop_tie'),
        ('import.group_npi_unusable'),
        ('import.npi_missing'),
        ('import.npi_unusable'),
        ('import.phone_dropped'),
        ('notification.cc_member_lapsed'),
        ('notification.schedule_invalid'),
        ('notification.sms_disabled'),
        ('notification.template_unavailable'),
        ('npi.missing'),
        ('npi.stored_check_digit_invalid'),
        ('npi_registry.inactive'),
        ('npi_registry.name_mismatch'),
        ('npi_registry.not_found'),
        ('npi_registry.organization_number'),
        ('npi_registry.unchecked'),
        ('roster_export.override'),
        ('task.completed_out_of_order'),
        ('task.step_out_of_order'),
        ('touch.other_without_context')
      ) AS k(check_key)
     WHERE k.check_key = p_check_key
  );
$function$;

REVOKE ALL ON FUNCTION private.workflow_advisory_check_key_valid(text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.workflow_advisory_check_key_valid(text) IS
  'MINT-134: true when p_check_key is one of the registered workflow advisory check keys (CHECKS in src/lib/advisoryChecks.ts). A new check key is a migration.';

-- ---------------------------------------------------------------------------
-- 1. Context shape validators. No writes. They live in `private` so PostgREST
--    never exposes them as /rpc/ endpoints. The table CHECK runs the shape
--    validator as the writing role; the only writers are the SECURITY DEFINER
--    RPCs below, which run as the owner, so no API role needs EXECUTE on them.
-- ---------------------------------------------------------------------------

-- A set of up to 20 strings, sorted in byte order with no repeats (so the
-- order carries nothing): lowercase UUIDs when p_allowed is NULL, otherwise
-- values from p_allowed. pickDeclared() sorts with JavaScript's default sort,
-- which is the same byte order for these ASCII values.
CREATE OR REPLACE FUNCTION private.workflow_advisory_context_set_valid(
  p_value jsonb,
  p_allowed text[]
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
DECLARE
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  -- The type first, so no array length is ever asked of a scalar.
  IF pg_catalog.jsonb_typeof(p_value) <> 'array' THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_array_length(p_value) > 20 THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_value) AS e(element)
     WHERE pg_catalog.jsonb_typeof(e.element) <> 'string'
  ) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
           SELECT 1 FROM pg_catalog.jsonb_array_elements_text(p_value) AS e(element)
            WHERE CASE WHEN p_allowed IS NULL THEN e.element !~ v_uuid
                       ELSE NOT (e.element = ANY (p_allowed)) END
         )
     AND NOT EXISTS (
           SELECT 1
             FROM (SELECT e.element,
                          pg_catalog.lag(e.element) OVER (ORDER BY e.ord) AS previous
                     FROM pg_catalog.jsonb_array_elements_text(p_value)
                          WITH ORDINALITY AS e(element, ord)) AS pair
            WHERE pair.previous IS NOT NULL
              AND NOT (pair.previous COLLATE pg_catalog."C" < pair.element COLLATE pg_catalog."C")
         );
END;
$function$;

-- A whole context: a flat object of at most 16 declared keys, each value of
-- its key's kind, and count bounds that multiply to under 10,000,000. The
-- VALUES list is CONTEXT_KEYS in src/lib/advisoryChecks.ts, row for row
-- (advisoryChecks.contract.test.ts compares them).
CREATE OR REPLACE FUNCTION private.workflow_advisory_context_valid(p_context jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
DECLARE
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_key text;
  v_value jsonb;
  v_type text;
  v_kind text;
  v_max integer;
  v_allowed text[];
  v_number numeric;
  v_keys integer := 0;
  v_capacity numeric := 1;
BEGIN
  IF p_context IS NULL OR pg_catalog.jsonb_typeof(p_context) <> 'object' THEN
    RETURN false;
  END IF;
  FOR v_key, v_value IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_context) AS e LOOP
    v_keys := v_keys + 1;
    IF v_keys > 16 THEN
      RETURN false;
    END IF;

    -- A key that isn't declared is refused, whatever its value.
    SELECT d.kind, d.max_value, d.allowed
      INTO v_kind, v_max, v_allowed
      FROM (VALUES
        ('attributes', 'tokens', NULL, ARRAY['caqh_id', 'caqh_attested', 'npi', 'dob', 'ssn_last4']),
        ('case_type', 'token', NULL, ARRAY['contract', 'enrollment', 'recredentialing']),
        ('column', 'token', NULL, ARRAY['npi', 'npi_type2', 'group_npi', 'phone', 'fax', 'appointment_phone', 'billing_phone', 'billing_fax', 'corr_phone', 'corr_fax', 'cred_phone', 'cred_fax']),
        ('count', 'count', 9999, NULL),
        ('earlier_open_count', 'count', 99, NULL),
        ('facility_ids', 'ids', NULL, NULL),
        ('import_run_id', 'id', NULL, NULL),
        ('layer', 'token', NULL, ARRAY['platform', 'org']),
        ('line', 'count', 100000, NULL),
        ('payer_id', 'id', NULL, NULL),
        ('recipient_id', 'id', NULL, NULL),
        ('removed_count', 'count', 20, NULL),
        ('step_order', 'count', 99, NULL),
        ('step_position', 'count', 10, NULL),
        ('surface', 'token', NULL, ARRAY['add_provider', 'roster_form', 'record_edit', 'import']),
        ('template_ids', 'ids', NULL, NULL)
      ) AS d(context_key, kind, max_value, allowed)
     WHERE d.context_key = v_key;
    IF NOT FOUND THEN
      RETURN false;
    END IF;

    -- Each branch tests the JSON type before anything that needs it (a
    -- numeric cast, an array length), so no value makes the validator error.
    v_type := pg_catalog.jsonb_typeof(v_value);
    IF v_kind = 'flag' THEN
      IF v_type <> 'boolean' THEN
        RETURN false;
      END IF;
    ELSIF v_kind = 'count' THEN
      IF v_type <> 'number' THEN
        RETURN false;
      END IF;
      v_number := (v_value #>> '{}')::numeric;
      IF v_number < 0 OR v_number <> pg_catalog.trunc(v_number) OR v_number > v_max THEN
        RETURN false;
      END IF;
      v_capacity := v_capacity * (v_max + 1);
    ELSIF v_kind = 'id' THEN
      IF v_type <> 'string' THEN
        RETURN false;
      END IF;
      IF (v_value #>> '{}') !~ v_uuid THEN
        RETURN false;
      END IF;
    ELSIF v_kind = 'ids' THEN
      IF NOT private.workflow_advisory_context_set_valid(v_value, NULL) THEN
        RETURN false;
      END IF;
    ELSIF v_kind = 'token' THEN
      IF v_type <> 'string' THEN
        RETURN false;
      END IF;
      IF NOT ((v_value #>> '{}') = ANY (v_allowed)) THEN
        RETURN false;
      END IF;
    ELSIF v_kind = 'tokens' THEN
      IF NOT private.workflow_advisory_context_set_valid(v_value, v_allowed) THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;

  -- No context may carry a 7-digit number or longer split across its counts.
  RETURN v_capacity < 10000000;
END;
$function$;

REVOKE ALL ON FUNCTION private.workflow_advisory_context_set_valid(jsonb, text[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.workflow_advisory_context_valid(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.workflow_advisory_context_set_valid(jsonb, text[]) IS
  'MINT-134: a JSON array of up to 20 strings in strictly ascending byte order (sorted, no repeats), each a lowercase UUID (p_allowed NULL) or a value of p_allowed.';
COMMENT ON FUNCTION private.workflow_advisory_context_valid(jsonb) IS
  'MINT-134: a workflow advisory context is a flat object of at most 16 declared keys (the closed list in this function, mirrored by CONTEXT_KEYS in src/lib/advisoryChecks.ts). count: an integer 0 to the key''s bound; id/ids: a lowercase UUID or a set of up to 20; token/tokens: a value or a set of up to 20 from the key''s closed vocabulary; flag: a boolean. The bounds of the count keys present multiply to under 10,000,000.';

-- ---------------------------------------------------------------------------
-- 2. The ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workflow_advisories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  check_key text NOT NULL,
  severity_at_time text NOT NULL,
  record_table text NOT NULL,
  record_id uuid NOT NULL,
  -- Actor ids, not foreign keys (the notification_sends convention): removing
  -- a profile must not rewrite history.
  actor_id uuid,
  actor_role text,
  source text NOT NULL,
  job text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  bypassed_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  -- A registered check key only. A new key is a migration.
  CONSTRAINT workflow_advisories_check_key_check CHECK (
    private.workflow_advisory_check_key_valid(check_key)
  ),
  -- advisory: the action proceeded. block: a critical check stopped it.
  CONSTRAINT workflow_advisories_severity_check CHECK (
    severity_at_time IN ('advisory', 'block')
  ),
  CONSTRAINT workflow_advisories_record_table_check CHECK (
    record_table IN ('providers', 'provider_groups', 'facilities', 'credential_cases', 'tasks',
                     'touches', 'import_runs', 'roster_mappings', 'sop_templates')
  ),
  -- memberships_role_check's vocabulary, read from memberships at the time.
  CONSTRAINT workflow_advisories_actor_role_check CHECK (
    actor_role IS NULL OR actor_role IN ('admin', 'specialist', 'billing')
  ),
  CONSTRAINT workflow_advisories_source_check CHECK (
    source IN ('panel', 'extension', 'api', 'import', 'job')
  ),
  -- A job row names its job (job_runs_job_check's pattern); no other row does.
  CONSTRAINT workflow_advisories_job_check CHECK (
    ((source = 'job') = (job IS NOT NULL))
    AND (job IS NULL OR job ~ '^[a-z][a-z0-9-]{0,47}$')
  ),
  -- A job row has no actor; every other row has an actor and a role.
  CONSTRAINT workflow_advisories_actor_check CHECK (
    ((source = 'job') = (actor_id IS NULL))
    AND ((actor_id IS NULL) = (actor_role IS NULL))
  ),
  CONSTRAINT workflow_advisories_context_check CHECK (
    private.workflow_advisory_context_valid(context)
  ),
  CONSTRAINT workflow_advisories_resolved_check CHECK (
    resolved_by IS NULL OR resolved_at IS NOT NULL
  )
);

-- Mission Control's filters: org, check, open, newest first.
CREATE INDEX IF NOT EXISTS workflow_advisories_org_idx
  ON public.workflow_advisories (org_id, bypassed_at DESC);
CREATE INDEX IF NOT EXISTS workflow_advisories_check_idx
  ON public.workflow_advisories (check_key, bypassed_at DESC);
CREATE INDEX IF NOT EXISTS workflow_advisories_open_idx
  ON public.workflow_advisories (bypassed_at DESC) WHERE resolved_at IS NULL;
-- Serves resolve_workflow_advisories.
CREATE INDEX IF NOT EXISTS workflow_advisories_record_idx
  ON public.workflow_advisories (org_id, check_key, record_table, record_id)
  WHERE resolved_at IS NULL;
-- A job that re-detects a condition every run records it once until it is
-- resolved. Rows from people are not deduplicated: each bypass is its own row.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_advisories_one_open_job_row
  ON public.workflow_advisories (org_id, check_key, record_table, record_id)
  WHERE resolved_at IS NULL AND source = 'job';

ALTER TABLE public.workflow_advisories ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.workflow_advisories FROM public, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.workflow_advisories TO service_role;

COMMENT ON TABLE public.workflow_advisories IS
  'Workflow advisories (MINT-134): one row each time a noncritical check was bypassed (the action proceeded) or a critical check stopped an action someone must know about. Ids, check keys and validated check facts only, never PHI; no stored record label. Append-only: the only UPDATE is the resolve stamp. service_role SELECT only; written by record_workflow_advisory, record_job_advisory and resolve_workflow_advisories.';
COMMENT ON COLUMN public.workflow_advisories.check_key IS
  'A registered check key (CHECKS in src/lib/advisoryChecks.ts, mirrored by private.workflow_advisory_check_key_valid), e.g. npi_registry.not_found. Any other key is refused.';
COMMENT ON COLUMN public.workflow_advisories.severity_at_time IS
  'advisory (the action proceeded) or block (a critical check stopped it and someone must know). Fixed by the registry at write time.';
COMMENT ON COLUMN public.workflow_advisories.record_table IS
  'The table of the record the check was about, from a closed set of org-owned tables. With record_id it names the record; its label is computed at read time, never stored.';
COMMENT ON COLUMN public.workflow_advisories.record_id IS
  'The record''s id. Checked to belong to org_id when the row is written.';
COMMENT ON COLUMN public.workflow_advisories.actor_id IS
  'Who did it: the verified user (auth.uid() for the browser, the guard''s user for /api and the extension). NULL exactly for a job row. An actor id, not a foreign key.';
COMMENT ON COLUMN public.workflow_advisories.actor_role IS
  'The actor''s memberships.role in org_id at the time (admin, specialist or billing), read by the RPC, never passed by the caller. NULL exactly for a job row.';
COMMENT ON COLUMN public.workflow_advisories.source IS
  'Where it came from: panel, extension, api, import, or job.';
COMMENT ON COLUMN public.workflow_advisories.job IS
  'The registered job name when source is job, else NULL.';
COMMENT ON COLUMN public.workflow_advisories.context IS
  'Flat validated facts declared by the check (counts, flags, tokens, ids), e.g. {"import_run_id": "...", "line": 12}. Never a name, an entered value, a registry value, a date or free text.';
COMMENT ON COLUMN public.workflow_advisories.bypassed_at IS
  'When it happened (database time).';
COMMENT ON COLUMN public.workflow_advisories.resolved_at IS
  'When a server-side re-check passed. Set once by resolve_workflow_advisories; never cleared or moved.';
COMMENT ON COLUMN public.workflow_advisories.resolved_by IS
  'The org member whose re-check resolved it, or NULL for a job. An actor id, not a foreign key.';

-- ---------------------------------------------------------------------------
-- 3. Append-only guard. BEFORE UPDATE: every column but the stamp is frozen,
--    and the stamp goes NULL -> value once. Runs before the CHECKs, so a
--    refused change always reports workflow_advisory_append_only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.workflow_advisories_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.check_key IS DISTINCT FROM OLD.check_key
     OR NEW.severity_at_time IS DISTINCT FROM OLD.severity_at_time
     OR NEW.record_table IS DISTINCT FROM OLD.record_table
     OR NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.actor_role IS DISTINCT FROM OLD.actor_role
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.job IS DISTINCT FROM OLD.job
     OR NEW.context IS DISTINCT FROM OLD.context
     OR NEW.bypassed_at IS DISTINCT FROM OLD.bypassed_at
     -- A stamped row is final: the stamp can't be cleared, moved or
     -- re-attributed.
     OR OLD.resolved_at IS NOT NULL
     -- The one allowed update sets the stamp.
     OR NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workflow_advisory_append_only';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.workflow_advisories_guard()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS workflow_advisories_guard ON public.workflow_advisories;
CREATE TRIGGER workflow_advisories_guard
  BEFORE UPDATE ON public.workflow_advisories
  FOR EACH ROW EXECUTE FUNCTION private.workflow_advisories_guard();

COMMENT ON FUNCTION private.workflow_advisories_guard() IS
  'MINT-134: BEFORE UPDATE on workflow_advisories. Refuses (42501 workflow_advisory_append_only) any change but stamping resolved_at (and resolved_by) on an open row, once.';

-- ---------------------------------------------------------------------------
-- 4. Does the record belong to the org? One branch per record_table in the
--    closed set; anything else is false. Called by the SECURITY DEFINER RPCs,
--    so it reads as the owner and RLS does not hide rows from it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.workflow_advisory_record_in_org(
  p_record_table text,
  p_record_id uuid,
  p_org_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  RETURN CASE p_record_table
    WHEN 'providers' THEN EXISTS (
      SELECT 1 FROM public.providers AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'provider_groups' THEN EXISTS (
      SELECT 1 FROM public.provider_groups AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'facilities' THEN EXISTS (
      SELECT 1 FROM public.facilities AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'credential_cases' THEN EXISTS (
      SELECT 1 FROM public.credential_cases AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'tasks' THEN EXISTS (
      SELECT 1 FROM public.tasks AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'touches' THEN EXISTS (
      SELECT 1 FROM public.touches AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'import_runs' THEN EXISTS (
      SELECT 1 FROM public.import_runs AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'roster_mappings' THEN EXISTS (
      SELECT 1 FROM public.roster_mappings AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    WHEN 'sop_templates' THEN EXISTS (
      SELECT 1 FROM public.sop_templates AS r WHERE r.id = p_record_id AND r.org_id = p_org_id)
    ELSE false
  END;
END;
$function$;

REVOKE ALL ON FUNCTION private.workflow_advisory_record_in_org(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.workflow_advisory_record_in_org(text, uuid, uuid) IS
  'MINT-134: true when the record (record_table, record_id) exists with org_id = p_org_id. Closed set of org-owned tables; false for any other table.';

-- Every id in a context names an existing record of the org: import_run_id an
-- import run, facility_ids facilities, recipient_id a member, payer_id a payer
-- and template_ids SOP templates (the org's own or a global catalog row,
-- org_id NULL). An id key without a branch here is refused. These read
-- tables, so they run in the record RPCs, after the shape check, and are not
-- part of the table CHECK.
CREATE OR REPLACE FUNCTION private.workflow_advisory_context_id_in_org(
  p_key text,
  p_id uuid,
  p_org_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  RETURN CASE p_key
    WHEN 'import_run_id' THEN EXISTS (
      SELECT 1 FROM public.import_runs AS r WHERE r.id = p_id AND r.org_id = p_org_id)
    WHEN 'facility_ids' THEN EXISTS (
      SELECT 1 FROM public.facilities AS r WHERE r.id = p_id AND r.org_id = p_org_id)
    WHEN 'recipient_id' THEN EXISTS (
      SELECT 1 FROM public.memberships AS r WHERE r.user_id = p_id AND r.org_id = p_org_id)
    WHEN 'payer_id' THEN EXISTS (
      SELECT 1 FROM public.payers AS r
       WHERE r.id = p_id AND (r.org_id = p_org_id OR r.org_id IS NULL))
    WHEN 'template_ids' THEN EXISTS (
      SELECT 1 FROM public.sop_templates AS r
       WHERE r.id = p_id AND (r.org_id = p_org_id OR r.org_id IS NULL))
    ELSE false
  END;
END;
$function$;

-- Run only on a context that passed private.workflow_advisory_context_valid,
-- so every *_id value is a UUID and every *_ids value an array of them.
CREATE OR REPLACE FUNCTION private.workflow_advisory_context_ids_in_org(
  p_context jsonb,
  p_org_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_key text;
  v_value jsonb;
  v_id text;
BEGIN
  FOR v_key, v_value IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_context) AS e LOOP
    IF v_key ~ '_ids$' THEN
      FOR v_id IN SELECT e.element FROM pg_catalog.jsonb_array_elements_text(v_value) AS e(element) LOOP
        IF NOT private.workflow_advisory_context_id_in_org(v_key, v_id::uuid, p_org_id) THEN
          RETURN false;
        END IF;
      END LOOP;
    ELSIF v_key ~ '_id$' THEN
      IF NOT private.workflow_advisory_context_id_in_org(v_key, (v_value #>> '{}')::uuid, p_org_id) THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION private.workflow_advisory_context_id_in_org(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.workflow_advisory_context_ids_in_org(jsonb, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.workflow_advisory_context_id_in_org(text, uuid, uuid) IS
  'MINT-134: true when a context id under p_key names an existing record of the org (import run, facility, member; payer or SOP template of the org or the global catalog). False for any key without a branch.';
COMMENT ON FUNCTION private.workflow_advisory_context_ids_in_org(jsonb, uuid) IS
  'MINT-134: true when every *_id and *_ids value of a shape-valid context names an existing record of the org.';

-- ---------------------------------------------------------------------------
-- E6.12 for a user the server names: app_authz.is_restricted_external()'s
-- body, keyed on p_user_id instead of auth.uid(). A restricted external
-- (client) identity has a classification in any state and no active
-- internal-staff row.
--
-- It must read the forced-RLS private tables the way the original does: as
-- minted_e612_authz_owner (NOBYPASSRLS), through E6.12's SELECT grant and
-- owner policies. So the function is created as that role. This block uses
-- E6.12's handoff capabilities (20260925035408): for its duration the
-- executor gets SET on the owner role and the owner gets CREATE on
-- app_authz, unless they already have them, and both are put back exactly
-- before the transaction commits. Inside, the block SETs ROLE to the owner,
-- creates (or replaces) the function and its ACL as the owner, and RESETs.
-- Creating it as the owner, rather than creating it here and then running
-- ALTER OWNER, keeps the migration re-runnable by a non-superuser executor
-- (only the owner may replace the function). And the grant to the executor
-- comes from the new owner, so no ownership change can rewrite it.
--
-- Grants. The original takes no argument, so authenticated only learns about
-- itself. This one names a user, so it goes to service_role and to the
-- executor that owns the advisory RPCs (their SECURITY DEFINER bodies call
-- it), never to authenticated or anon.
--
-- The executor needs either SET on minted_e612_authz_owner already, or the
-- right to grant it: the ADMIN OPTION it holds as the role's creator
-- (PostgreSQL 16+), or CREATEROLE (15). That is the executor that applied
-- 20260925035408, the E6.12 handoff's own assumption. Apply as the executor
-- itself (log in as it): PostgreSQL checks SET ROLE against the session
-- user, so a session that SET ROLE'd into the executor is refused at the top
-- of the block (workflow_advisory_apply_as_the_executor_itself).
--
-- EXECUTE goes to the executor by name. If the advisory RPCs ever change
-- owner (ALTER FUNCTION ... OWNER TO, REASSIGN OWNED), re-run this migration
-- as the new owner, or have minted_e612_authz_owner GRANT EXECUTE ON
-- FUNCTION app_authz.is_restricted_external_user(uuid) TO it. Until then,
-- every service_role record and named resolve fails with 42501. The verify
-- query in this header checks that the RPCs' owner holds EXECUTE.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_executor_name name := current_user;
  v_executor_oid oid := v_executor_name::regrole;
  v_owner_name constant name := 'minted_e612_authz_owner';
  v_owner_oid oid := v_owner_name::regrole;
  v_had_effective_set boolean := pg_has_role(v_executor_name, v_owner_name, 'SET');
  v_had_effective_create boolean := has_schema_privilege(v_owner_name, 'app_authz', 'CREATE');
  v_had_direct_selfgrant boolean := false;
  v_admin_option boolean;
  v_inherit_option boolean;
  v_set_option boolean;
  v_bool_admin text;
  v_bool_inherit text;
  v_bool_set text;
  v_previous_role text := pg_catalog.current_setting('role');
BEGIN
  -- SET ROLE is checked against the session user, not the current one (E6.12's
  -- ALTER OWNER was checked against the current user). The temporary SET
  -- below goes to the executor, so an operator who logged in as someone else
  -- and SET ROLE'd into the executor would be refused halfway. Stop first,
  -- before anything changes, and say how to apply it.
  IF session_user <> current_user
     AND NOT pg_has_role(session_user, v_owner_name, 'SET') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'workflow_advisory_apply_as_the_executor_itself',
      HINT = format(
        'Connect as %I and apply this migration again. SET ROLE into it from %I is not enough: PostgreSQL checks SET ROLE against the session user.',
        current_user, session_user
      );
  END IF;

  IF NOT v_had_effective_set THEN
    SELECT m.admin_option, m.inherit_option, m.set_option
      INTO v_admin_option, v_inherit_option, v_set_option
      FROM pg_auth_members m
     WHERE m.roleid = v_owner_oid
       AND m.member = v_executor_oid
       AND m.grantor = v_executor_oid;
    v_had_direct_selfgrant := FOUND;

    -- Explicit options are required here: INHERIT is deliberately false, while
    -- SET is the only capability needed to act as the owner.
    EXECUTE format(
      'GRANT %I TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_USER',
      v_owner_name,
      v_executor_name
    );
  END IF;

  IF NOT v_had_effective_create THEN
    EXECUTE format('GRANT CREATE ON SCHEMA app_authz TO %I', v_owner_name);
  END IF;

  -- As the owner: the function, its ACL and its comment.
  EXECUTE format('SET LOCAL ROLE %I', v_owner_name);
  EXECUTE $create$
    CREATE OR REPLACE FUNCTION app_authz.is_restricted_external_user(p_user_id uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = ''
    AS $body$
      SELECT EXISTS (
        SELECT 1
          FROM private.client_identity_classifications c
         WHERE c.auth_user_id = p_user_id
           AND c.state IN ('pending', 'active', 'expired', 'revoked')
      )
      AND NOT EXISTS (
        SELECT 1
          FROM private.internal_staff s
         WHERE s.auth_user_id = p_user_id
           AND s.active
      );
    $body$
  $create$;
  EXECUTE 'REVOKE ALL ON FUNCTION app_authz.is_restricted_external_user(uuid) FROM PUBLIC, anon, authenticated';
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION app_authz.is_restricted_external_user(uuid) TO service_role, %I',
    v_executor_name
  );
  EXECUTE $comment$
    COMMENT ON FUNCTION app_authz.is_restricted_external_user(uuid) IS
      'MINT-134: app_authz.is_restricted_external() for a named user (a client identity classification in any state and no active internal_staff row). Owned by minted_e612_authz_owner, which reads the forced-RLS tables through E6.12''s grants and policies. service_role and the advisory RPCs'' owner only: never authenticated or anon, since it names a user.'
  $comment$;
  -- Back to the session's role as it was before the block.
  IF v_previous_role = 'none' THEN
    EXECUTE 'RESET ROLE';
  ELSE
    EXECUTE format('SET LOCAL ROLE %I', v_previous_role);
  END IF;

  IF NOT v_had_effective_create THEN
    EXECUTE format('REVOKE CREATE ON SCHEMA app_authz FROM %I', v_owner_name);
  END IF;

  IF NOT v_had_effective_set THEN
    IF v_had_direct_selfgrant THEN
      v_bool_admin := CASE WHEN v_admin_option THEN 'TRUE' ELSE 'FALSE' END;
      v_bool_inherit := CASE WHEN v_inherit_option THEN 'TRUE' ELSE 'FALSE' END;
      v_bool_set := CASE WHEN v_set_option THEN 'TRUE' ELSE 'FALSE' END;
      EXECUTE format(
        'GRANT %I TO %I WITH ADMIN %s, INHERIT %s, SET %s GRANTED BY CURRENT_USER',
        v_owner_name,
        v_executor_name,
        v_bool_admin,
        v_bool_inherit,
        v_bool_set
      );
    ELSE
      EXECUTE format('REVOKE %I FROM %I GRANTED BY CURRENT_USER', v_owner_name, v_executor_name);
    END IF;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. Shared argument checks for both record RPCs (no reads, no writes).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.workflow_advisory_assert_args(
  p_org_id uuid,
  p_check_key text,
  p_severity text,
  p_record_table text,
  p_record_id uuid,
  p_context jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_org_required';
  END IF;
  IF NOT private.workflow_advisory_check_key_valid(p_check_key) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_check_key_invalid';
  END IF;
  IF p_severity IS NULL OR p_severity NOT IN ('advisory', 'block') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_severity_invalid';
  END IF;
  IF p_record_table IS NULL
     OR p_record_table NOT IN ('providers', 'provider_groups', 'facilities', 'credential_cases',
                               'tasks', 'touches', 'import_runs', 'roster_mappings',
                               'sop_templates') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_record_table_invalid';
  END IF;
  IF p_record_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_record_required';
  END IF;
  IF NOT private.workflow_advisory_context_valid(p_context) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_context_invalid';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION private.workflow_advisory_assert_args(uuid, text, text, text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.workflow_advisory_assert_args(uuid, text, text, text, uuid, jsonb) IS
  'MINT-134: raises 22023 with a stable workflow_advisory_* key when an org, check key, severity, record table, record id or context is missing or outside its vocabulary.';

-- ---------------------------------------------------------------------------
-- 6. record_workflow_advisory: a person's action (panel, import, /api,
--    extension). Returns the new row's id.
--
--    Caller rules (complete_sop_task_step's, read from the session role):
--      authenticated  the actor is auth.uid(); a different p_actor_id is
--                     refused, so a browser can't record in someone's name.
--                     A restricted external client (E6.12) is refused.
--                     source panel or import.
--      service_role   the /api and extension routes, after JWT and membership
--                     resolution in guard.ts, pass p_actor_id, which must not
--                     be a restricted client. source api or extension.
--      anyone else    refused.
--    source job is never accepted here (record_job_advisory owns it). The
--    actor must be a member of p_org_id, which keeps the org from being
--    forged; the record and every context id must belong to that org.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_workflow_advisory(
  p_org_id uuid,
  p_check_key text,
  p_severity text,
  p_record_table text,
  p_record_id uuid,
  p_source text,
  p_context jsonb DEFAULT '{}'::jsonb,
  p_actor_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_caller text := pg_catalog.current_setting('role', true);
  v_actor uuid;
  v_role text;
  v_context jsonb := coalesce(p_context, '{}'::jsonb);
  v_id uuid;
BEGIN
  IF v_caller = 'authenticated' THEN
    v_actor := auth.uid();
    IF v_actor IS NULL OR (p_actor_id IS NOT NULL AND p_actor_id <> v_actor) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workflow_advisory_actor_mismatch';
    END IF;
    -- E6.12: a restricted external (client) identity records nothing, the
    -- refusal the other SECURITY DEFINER RPCs make.
    IF app_authz.is_restricted_external() THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workflow_advisory_restricted_client';
    END IF;
    -- A browser session records its own panel or import actions.
    IF p_source IS NULL OR p_source NOT IN ('panel', 'import') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_source_invalid';
    END IF;
  ELSIF v_caller = 'service_role' THEN
    IF p_actor_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_actor_required';
    END IF;
    v_actor := p_actor_id;
    -- guard.ts makes no E6.12 check, so the actor a route names is checked
    -- here.
    IF app_authz.is_restricted_external_user(v_actor) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workflow_advisory_restricted_client';
    END IF;
    -- The /api and extension routes record what their verified user did.
    IF p_source IS NULL OR p_source NOT IN ('api', 'extension') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_source_invalid';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workflow_advisory_caller_not_allowed';
  END IF;

  PERFORM private.workflow_advisory_assert_args(
    p_org_id, p_check_key, p_severity, p_record_table, p_record_id, v_context
  );

  -- Membership before the record lookup, so a non-member learns nothing
  -- about another org's records.
  SELECT m.role INTO v_role
    FROM public.memberships AS m
   WHERE m.org_id = p_org_id
     AND m.user_id = v_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workflow_advisory_not_a_member';
  END IF;

  IF NOT private.workflow_advisory_record_in_org(p_record_table, p_record_id, p_org_id) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_record_not_in_org';
  END IF;
  IF NOT private.workflow_advisory_context_ids_in_org(v_context, p_org_id) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_context_not_in_org';
  END IF;

  INSERT INTO public.workflow_advisories (
    org_id, check_key, severity_at_time, record_table, record_id,
    actor_id, actor_role, source, job, context
  ) VALUES (
    p_org_id, p_check_key, p_severity, p_record_table, p_record_id,
    v_actor, v_role, p_source, NULL, v_context
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. record_job_advisory: a scheduled job's finding (no actor). Returns the
--    new row's id, or NULL when an open job row for (org, check, record)
--    already exists: a job that re-detects the condition every run records it
--    once until resolved (the claim_job_run pattern).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_job_advisory(
  p_job text,
  p_org_id uuid,
  p_check_key text,
  p_severity text,
  p_record_table text,
  p_record_id uuid,
  p_context jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_context jsonb := coalesce(p_context, '{}'::jsonb);
  v_id uuid;
BEGIN
  -- The grant is service_role's alone; the session role check also stops a
  -- SECURITY DEFINER caller from running this under its owner's privilege.
  IF pg_catalog.current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workflow_advisory_caller_not_allowed';
  END IF;
  IF p_job IS NULL OR p_job !~ '^[a-z][a-z0-9-]{0,47}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_job_invalid';
  END IF;
  PERFORM private.workflow_advisory_assert_args(
    p_org_id, p_check_key, p_severity, p_record_table, p_record_id, v_context
  );
  IF NOT private.workflow_advisory_record_in_org(p_record_table, p_record_id, p_org_id) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_record_not_in_org';
  END IF;
  IF NOT private.workflow_advisory_context_ids_in_org(v_context, p_org_id) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workflow_advisory_context_not_in_org';
  END IF;

  -- An open job row for the key makes this insert a no-op, which leaves v_id
  -- NULL. The target names the partial index, so any other conflict raises.
  INSERT INTO public.workflow_advisories (
    org_id, check_key, severity_at_time, record_table, record_id,
    actor_id, actor_role, source, job, context
  ) VALUES (
    p_org_id, p_check_key, p_severity, p_record_table, p_record_id,
    NULL, NULL, 'job', p_job, v_context
  )
  ON CONFLICT (org_id, check_key, record_table, record_id)
    WHERE resolved_at IS NULL AND source = 'job' DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 8. resolve_workflow_advisories: a server-side re-check passed. Stamps every
--    open row (from people and jobs) for (org, check, record) and returns how
--    many. resolved_by is the member whose re-check it was, or NULL for a job.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_workflow_advisories(
  p_org_id uuid,
  p_check_key text,
  p_record_table text,
  p_record_id uuid,
  p_resolved_by uuid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_count integer;
BEGIN
  -- The grant is service_role's alone; the session role check also stops a
  -- SECURITY DEFINER caller from running this under its owner's privilege.
  IF pg_catalog.current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workflow_advisory_caller_not_allowed';
  END IF;
  PERFORM private.workflow_advisory_assert_args(
    p_org_id, p_check_key, 'advisory', p_record_table, p_record_id, '{}'::jsonb
  );
  IF p_resolved_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.memberships AS m
     WHERE m.org_id = p_org_id AND m.user_id = p_resolved_by
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workflow_advisory_not_a_member';
  END IF;
  IF p_resolved_by IS NOT NULL AND app_authz.is_restricted_external_user(p_resolved_by) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workflow_advisory_restricted_client';
  END IF;

  UPDATE public.workflow_advisories
     SET resolved_at = pg_catalog.now(),
         resolved_by = p_resolved_by
   WHERE org_id = p_org_id
     AND check_key = p_check_key
     AND record_table = p_record_table
     AND record_id = p_record_id
     AND resolved_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)
  FROM public, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_job_advisory(text, uuid, text, text, text, uuid, jsonb)
  FROM public, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_workflow_advisories(uuid, text, text, uuid, uuid)
  FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_job_advisory(text, uuid, text, text, text, uuid, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_workflow_advisories(uuid, text, text, uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.record_workflow_advisory(uuid, text, text, text, uuid, text, jsonb, uuid) IS
  'MINT-134: record a bypassed (advisory) or stopped (block) check on an org record. authenticated: the actor is auth.uid(), a different p_actor_id is refused, source panel or import; service_role: p_actor_id is required and must not be a restricted client, source api or extension; any other caller is refused. The actor must be an org member (role read from memberships); the record and every context id must belong to the org. Context limited to declared keys. Returns the row id.';
COMMENT ON FUNCTION public.record_job_advisory(text, uuid, text, text, text, uuid, jsonb) IS
  'MINT-134: record a scheduled job''s finding (source job, no actor; the record and every context id must belong to the org). Returns the row id, or NULL when an open job row already exists for (org, check, record). service_role only, by grant and by session role.';
COMMENT ON FUNCTION public.resolve_workflow_advisories(uuid, text, text, uuid, uuid) IS
  'MINT-134: stamp resolved_at (and resolved_by, an org member or NULL for a job) on every open row for (org, check, record) after a server-side re-check passed. Returns the number stamped. service_role only, by grant and by session role; a resolver must not be a restricted client.';

NOTIFY pgrst, 'reload schema';
