-- MINT-107 notification sequences regression packet: RLS, grants, CHECKs,
-- triggers, Minted's platform defaults (no default digest schedule, G2),
-- save_notification_sequence, and the consent archive (D5)
-- (supabase/migrations/20261031051500_notification_sequences.sql).
--
-- Run after all migrations in a disposable PostgreSQL database, never against
-- hosted. CI's Migration dry-run job runs it right after the MINT-106 packet:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/mint107-notification-sequences.sql
-- Every row it writes is synthetic and rolled back.
--
-- It needs a superuser connection (it writes fixtures, switches role, toggles
-- triggers and column grants, deletes a synthetic org) and the anon,
-- authenticated and service_role
-- roles. CI creates those as bare NOLOGIN roles, so the packet emulates the
-- two hosted Supabase attributes it relies on, inside its own transaction:
-- USAGE on schema auth (auth.uid()) and BYPASSRLS on service_role. The first
-- block checks the prerequisites and stops with a plain message.
--
-- A check reads its statement's snapshot, so a write whose effect is checked
-- runs as its own statement first, never inside the checking statement.
-- m107_probe runs a write and then its check as two statements inside one
-- PL/pgSQL block (each EXECUTE takes a fresh snapshot), then rolls the block
-- back, so a probe leaves no row, revision or audit entry behind.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;
SET LOCAL client_min_messages = warning;

DO $$
BEGIN
  IF NOT coalesce(
    (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), false
  ) THEN
    RAISE EXCEPTION 'mint107-notification-sequences.sql must run as a superuser';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles
       WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'mint107-notification-sequences.sql needs the anon, authenticated and service_role roles';
  END IF;
  IF to_regclass('public.notification_sequences') IS NULL
     OR to_regclass('public.notification_sequence_steps') IS NULL
     OR to_regclass('public.notification_sequence_defaults') IS NULL
     OR to_regclass('public.notification_sequence_default_steps') IS NULL
     OR to_regclass('public.sms_consents') IS NULL
     OR to_regclass('public.sms_consent_archive') IS NULL
     OR to_regprocedure('public.save_notification_sequence(uuid, text, jsonb)') IS NULL
     OR to_regprocedure('private.notification_cc_recipients_valid(jsonb)') IS NULL
     OR to_regprocedure('private.notification_stop_conditions_valid(text[])') IS NULL
     OR to_regprocedure('private.notification_time_zone_valid(text)') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'apply every migration through 20261031051500_notification_sequences.sql first';
  END IF;
END;
$$;

-- CI seeds authenticated and service_role without the hosted attributes this
-- packet relies on. Emulate them only inside this rollback-only transaction
-- (the mint19 / mint60 precedent); both are restored before the ROLLBACK.
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
ALTER ROLE service_role BYPASSRLS;
-- Fire the deferred step-set checks at the end of each statement, so a
-- probe sees them inside this transaction (it never commits).
SET CONSTRAINTS ALL IMMEDIATE;

CREATE TEMP TABLE m107_results (name text PRIMARY KEY, passed boolean NOT NULL);
GRANT ALL ON m107_results TO anon, authenticated, service_role;

CREATE FUNCTION pg_temp.m107_mark(p_name text, p_passed boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pg_temp.m107_results VALUES (p_name, coalesce(p_passed, false));
END;
$$;

CREATE FUNCTION pg_temp.m107_expect_state(p_state text, p_statement text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  BEGIN
    EXECUTE p_statement;
    RETURN false;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    RETURN v_state = p_state;
  END;
END;
$$;

CREATE FUNCTION pg_temp.m107_expect_message(p_fragment text, p_statement text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v_message text;
BEGIN
  BEGIN
    EXECUTE p_statement;
    RETURN false;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    RETURN position(p_fragment IN v_message) > 0;
  END;
END;
$$;

-- Run p_statement, then p_check (a SELECT of one boolean) as its own
-- statement, then undo both. True only when the statement succeeded and the
-- check held.
CREATE FUNCTION pg_temp.m107_probe(p_statement text, p_check text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean := false;
BEGIN
  BEGIN
    EXECUTE p_statement;
    EXECUTE p_check INTO v_ok;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'm107_probe_rolled_back';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'm107_probe_rolled_back' THEN
      RETURN coalesce(v_ok, false);
    END IF;
    RETURN false;
  END;
END;
$$;

CREATE FUNCTION pg_temp.m107_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text,
    true
  );
END;
$$;

-- An intake payload: steps on the given offsets, step 3 cc'ing the
-- specialist and then all admins; its own stop conditions, Minted's target.
CREATE FUNCTION pg_temp.m107_intake(p_offsets int[], p_expected int DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'stop_conditions', jsonb_build_array('submitted', 'withdrawn'),
    'target_days_to_ready', NULL,
    'expected_revision', p_expected,
    'steps', (
      SELECT jsonb_agg(jsonb_build_object(
               'offset_days', o.offset_days,
               'channel', 'email',
               'template_key', 'intake_reminder_first',
               'cc_recipients', CASE WHEN o.ordinal = 3 THEN jsonb_build_array(
                 jsonb_build_object('kind', 'user', 'user_id', '10700000-0000-4000-a000-000000000002'),
                 jsonb_build_object('kind', 'role', 'role', 'admin'))
                 ELSE '[]'::jsonb END)
             ORDER BY o.ordinal)
        FROM unnest(p_offsets) WITH ORDINALITY AS o(offset_days, ordinal)
    )
  );
$$;

-- A digest payload: one daily email step with the given cc list.
CREATE FUNCTION pg_temp.m107_digest(p_expected int DEFAULT NULL, p_cc jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'expected_revision', p_expected,
    'steps', jsonb_build_array(jsonb_build_object(
      'offset_days', 0,
      'channel', 'email',
      'template_key', 'followup_digest_daily',
      'cc_recipients', p_cc))
  );
$$;

GRANT EXECUTE ON FUNCTION pg_temp.m107_mark(text, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.m107_expect_state(text, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.m107_expect_message(text, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.m107_probe(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.m107_as(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.m107_intake(int[], int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.m107_digest(int, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures: org A (admin, specialist, billing), org B (admin), a signed-in
-- user with no membership, and one provider in each org.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users(id, email) VALUES
  ('10700000-0000-4000-a000-000000000001', 'm107-admin-a@example.invalid'),
  ('10700000-0000-4000-a000-000000000002', 'm107-specialist-a@example.invalid'),
  ('10700000-0000-4000-a000-000000000003', 'm107-billing-a@example.invalid'),
  ('10700000-0000-4000-a000-000000000004', 'm107-admin-b@example.invalid'),
  ('10700000-0000-4000-a000-000000000005', 'm107-no-org@example.invalid');
INSERT INTO public.profiles(id, full_name, email) VALUES
  ('10700000-0000-4000-a000-000000000001', 'MINT-107 Admin A', 'm107-admin-a@example.invalid'),
  ('10700000-0000-4000-a000-000000000002', 'MINT-107 Specialist A', 'm107-specialist-a@example.invalid'),
  ('10700000-0000-4000-a000-000000000003', 'MINT-107 Billing A', 'm107-billing-a@example.invalid'),
  ('10700000-0000-4000-a000-000000000004', 'MINT-107 Admin B', 'm107-admin-b@example.invalid'),
  ('10700000-0000-4000-a000-000000000005', 'MINT-107 No Org', 'm107-no-org@example.invalid');
INSERT INTO public.organizations(id, name) VALUES
  ('10700000-0000-4000-a000-00000000000a', 'MINT-107 Synthetic Org A'),
  ('10700000-0000-4000-a000-00000000000b', 'MINT-107 Synthetic Org B');
INSERT INTO public.memberships(org_id, user_id, role) VALUES
  ('10700000-0000-4000-a000-00000000000a', '10700000-0000-4000-a000-000000000001', 'admin'),
  ('10700000-0000-4000-a000-00000000000a', '10700000-0000-4000-a000-000000000002', 'specialist'),
  ('10700000-0000-4000-a000-00000000000a', '10700000-0000-4000-a000-000000000003', 'billing'),
  ('10700000-0000-4000-a000-00000000000b', '10700000-0000-4000-a000-000000000004', 'admin');
INSERT INTO public.providers(id, org_id, first_name, last_name, status) VALUES
  ('10700000-0000-4000-a000-0000000a0001', '10700000-0000-4000-a000-00000000000a',
   'Synthetic', 'Provider A', 'onboarding'),
  ('10700000-0000-4000-a000-0000000b0001', '10700000-0000-4000-a000-00000000000b',
   'Synthetic', 'Provider B', 'onboarding');

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m107_mark('rpc_execute_authenticated_only',
  has_function_privilege('authenticated',
    'public.save_notification_sequence(uuid,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.save_notification_sequence(uuid,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('service_role',
    'public.save_notification_sequence(uuid,text,jsonb)', 'EXECUTE'));
SELECT pg_temp.m107_mark('rpc_is_security_invoker_with_empty_search_path',
  (SELECT NOT p.prosecdef
          AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c
                       WHERE c IN ('search_path=""', 'search_path='))
     FROM pg_proc AS p
    WHERE p.oid = 'public.save_notification_sequence(uuid,text,jsonb)'::regprocedure));
SELECT pg_temp.m107_mark('validators_are_private_and_executable_by_writers',
  to_regprocedure('public.notification_cc_recipients_valid(jsonb)') IS NULL
  AND to_regprocedure('public.notification_stop_conditions_valid(text[])') IS NULL
  AND to_regprocedure('public.notification_time_zone_valid(text)') IS NULL
  AND has_function_privilege('authenticated',
    'private.notification_cc_recipients_valid(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role',
    'private.notification_stop_conditions_valid(text[])', 'EXECUTE')
  -- The zone validator runs inside a SECURITY DEFINER trigger, not a CHECK.
  AND NOT has_function_privilege('authenticated',
    'private.notification_time_zone_valid(text)', 'EXECUTE')
  AND has_function_privilege('service_role',
    'private.notification_time_zone_valid(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'private.notification_cc_recipients_valid(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'private.notification_time_zone_valid(text)', 'EXECUTE'));
SELECT pg_temp.m107_mark('anon_has_no_table_access',
  NOT has_table_privilege('anon', 'public.notification_sequences', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.notification_sequence_steps', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.notification_sequence_defaults', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.notification_sequence_default_steps', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.sms_consents', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.sms_consent_archive', 'SELECT'));
-- One privilege per call: a comma list is true when ANY listed privilege is held.
SELECT pg_temp.m107_mark('authenticated_table_grants',
  has_table_privilege('authenticated', 'public.notification_sequences', 'SELECT')
  -- A9: on/off is Minted's; Addendum 10: so is the digest frequency.
  AND NOT has_column_privilege('authenticated', 'public.notification_sequences', 'enabled', 'INSERT')
  AND NOT has_column_privilege('authenticated', 'public.notification_sequences', 'enabled', 'UPDATE')
  AND NOT has_column_privilege('authenticated', 'public.notification_sequences',
    'digest_frequency', 'INSERT')
  AND NOT has_column_privilege('authenticated', 'public.notification_sequences',
    'digest_frequency', 'UPDATE')
  AND has_column_privilege('authenticated', 'public.notification_sequences',
    'stop_conditions', 'UPDATE')
  AND has_column_privilege('authenticated', 'public.notification_sequences',
    'target_days_to_ready', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.notification_sequences', 'DELETE')
  AND has_table_privilege('authenticated', 'public.notification_sequence_steps', 'SELECT')
  AND has_table_privilege('authenticated', 'public.notification_sequence_steps', 'INSERT')
  AND has_table_privilege('authenticated', 'public.notification_sequence_steps', 'UPDATE')
  AND has_table_privilege('authenticated', 'public.notification_sequence_steps', 'DELETE')
  AND has_table_privilege('authenticated', 'public.sms_consents', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.sms_consents', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.sms_consents', 'UPDATE')
  AND NOT has_table_privilege('service_role', 'public.sms_consents', 'DELETE'));
-- Answer 5, S7, A9 and Addendum 10: on/off, the digest frequency, the send
-- time (hour, zone, second hour), the weekly weekday and the digest cc
-- setting are Minted's.
SELECT pg_temp.m107_mark('platform_columns_have_no_authenticated_write_grant',
  (SELECT bool_and(
            NOT has_column_privilege('authenticated', 'public.notification_sequences', c, 'INSERT')
            AND NOT has_column_privilege('authenticated', 'public.notification_sequences', c, 'UPDATE')
            AND has_column_privilege('service_role', 'public.notification_sequences', c, 'UPDATE'))
     FROM unnest(ARRAY['enabled', 'digest_frequency', 'send_hour', 'send_time_zone',
                       'second_send_hour', 'digest_weekday', 'digest_cc_allowed']) AS c)
  -- Nor the columns the stamp trigger owns.
  AND NOT has_column_privilege('authenticated', 'public.notification_sequences',
    'updated_by', 'UPDATE')
  AND NOT has_column_privilege('authenticated', 'public.notification_sequences',
    'revision', 'UPDATE')
  AND NOT has_column_privilege('authenticated', 'public.notification_sequences',
    'purpose', 'UPDATE'));
-- Answer 3: the defaults are read-only for every browser role.
SELECT pg_temp.m107_mark('defaults_are_read_only_for_authenticated',
  has_table_privilege('authenticated', 'public.notification_sequence_defaults', 'SELECT')
  AND has_table_privilege('authenticated', 'public.notification_sequence_default_steps', 'SELECT')
  AND NOT has_any_column_privilege('authenticated',
    'public.notification_sequence_defaults', 'INSERT')
  AND NOT has_any_column_privilege('authenticated',
    'public.notification_sequence_defaults', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.notification_sequence_defaults', 'DELETE')
  AND NOT has_any_column_privilege('authenticated',
    'public.notification_sequence_default_steps', 'INSERT')
  AND NOT has_any_column_privilege('authenticated',
    'public.notification_sequence_default_steps', 'UPDATE')
  AND NOT has_table_privilege('authenticated',
    'public.notification_sequence_default_steps', 'DELETE')
  AND has_table_privilege('service_role', 'public.notification_sequence_defaults', 'UPDATE')
  AND has_table_privilege('service_role', 'public.notification_sequence_default_steps', 'INSERT'));
SELECT pg_temp.m107_mark('rls_enabled_on_all_six',
  (SELECT count(*) = 6 AND bool_and(relrowsecurity) FROM pg_class
    WHERE oid IN ('public.notification_sequences'::regclass,
                  'public.notification_sequence_steps'::regclass,
                  'public.notification_sequence_defaults'::regclass,
                  'public.notification_sequence_default_steps'::regclass,
                  'public.sms_consents'::regclass,
                  'public.sms_consent_archive'::regclass)));

-- The deferred step rules run as the owner, so a committing role that cannot
-- see the sequence row never skips them (review, Oct 31).
SELECT pg_temp.m107_mark('step_set_check_runs_as_definer_with_empty_search_path',
  (SELECT p.prosecdef
          AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c
                       WHERE c IN ('search_path=""', 'search_path='))
     FROM pg_proc AS p
    WHERE p.oid = 'private.notification_sequence_steps_check_set()'::regprocedure));
-- Every notification_sequences column is classified for the stamp trigger:
-- the platform-managed ones are on its allow-list and in v_not_org_owned,
-- and "org settings unchanged" is the row minus those and the stamp columns.
-- A new column fails this until someone decides which it is.
SELECT pg_temp.m107_mark('notification_sequences_columns_are_all_classified',
  (SELECT array_agg(column_name::text ORDER BY column_name)
          = '{bounce_escalation_step,created_at,digest_cc_allowed,digest_frequency,digest_weekday,enabled,id,org_id,purpose,revision,second_send_hour,send_hour,send_time_zone,stop_conditions,target_days_to_ready,updated_at,updated_by}'
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notification_sequences')
  AND (SELECT bool_and(position(format('NEW.%1$s IS DISTINCT FROM OLD.%1$s', c) IN p.prosrc) > 0
                       AND position(quote_literal(c) IN p.prosrc) > 0)
         FROM pg_proc AS p,
              unnest(ARRAY['enabled', 'digest_frequency', 'send_hour', 'send_time_zone',
                           'second_send_hour', 'digest_weekday', 'digest_cc_allowed']) AS c
        WHERE p.oid = 'private.notification_sequences_stamp()'::regprocedure));

-- anon writes nothing, anywhere.
SET LOCAL ROLE anon;
SELECT pg_temp.m107_mark('anon_cannot_write_any_of_the_six_tables',
  pg_temp.m107_expect_state('42501', $$INSERT INTO public.notification_sequences (org_id, purpose)
    VALUES ('10700000-0000-4000-a000-00000000000a', 'intake_reminder')$$)
  AND pg_temp.m107_expect_state('42501', $$UPDATE public.notification_sequences SET enabled = true$$)
  AND pg_temp.m107_expect_state('42501', $$DELETE FROM public.notification_sequences$$)
  AND pg_temp.m107_expect_state('42501', $$INSERT INTO public.notification_sequence_steps
      (sequence_id, org_id, position, offset_days, channel, template_key)
    VALUES ('10700000-0000-4000-a000-0000000f0001', '10700000-0000-4000-a000-00000000000a', 1, 1, 'email',
            'intake_reminder_first')$$)
  AND pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequence_steps SET offset_days = 1$$)
  AND pg_temp.m107_expect_state('42501', $$DELETE FROM public.notification_sequence_steps$$)
  AND pg_temp.m107_expect_state('42501', $$INSERT INTO public.notification_sequence_defaults
      (purpose, digest_cc_allowed) VALUES ('followup_digest', true)$$)
  AND pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequence_defaults SET target_days_to_ready = 1$$)
  AND pg_temp.m107_expect_state('42501', $$DELETE FROM public.notification_sequence_defaults$$)
  AND pg_temp.m107_expect_state('42501', $$INSERT INTO public.notification_sequence_default_steps
      (purpose, position, offset_days, channel, template_key)
    VALUES ('intake_reminder', 4, 9, 'email', 'intake_reminder_final')$$)
  AND pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequence_default_steps SET offset_days = 1$$)
  AND pg_temp.m107_expect_state('42501',
    $$DELETE FROM public.notification_sequence_default_steps$$)
  AND pg_temp.m107_expect_state('42501', $$INSERT INTO public.sms_consents
      (org_id, provider_id, phone_e164, source, consent_text_version)
    VALUES ('10700000-0000-4000-a000-00000000000a', '10700000-0000-4000-a000-0000000a0001', '+15555550100',
            'intake_form', 'sms-consent.v1')$$)
  AND pg_temp.m107_expect_state('42501',
    $$UPDATE public.sms_consents SET revoked_source = 'sms_stop'$$)
  AND pg_temp.m107_expect_state('42501', $$DELETE FROM public.sms_consents$$)
  AND pg_temp.m107_expect_state('42501', $$INSERT INTO public.sms_consent_archive
      (id, org_id, phone_e164, consented_at, source, consent_text_version, created_at)
    VALUES ('10700000-0000-4000-a000-0000000c0099', '10700000-0000-4000-a000-00000000000a',
            '+15555550100', now(), 'intake_form', 'sms-consent.v1', now())$$)
  AND pg_temp.m107_expect_state('42501', $$DELETE FROM public.sms_consent_archive$$));
RESET ROLE;

-- Answer 5: the zone is checked when it is written, by a trigger, not by a
-- CHECK that a later tzdata release could turn against stored rows. Only an
-- org row has a zone (G2: the default has no schedule).
SELECT pg_temp.m107_mark('time_zone_is_checked_on_write_not_by_a_check',
  NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid IN ('public.notification_sequences'::regclass,
                        'public.notification_sequence_defaults'::regclass)
       AND pg_get_constraintdef(oid) LIKE '%notification_time_zone_valid%')
  AND (SELECT count(*) = 1 FROM pg_trigger
        WHERE tgname = 'notification_sequences_send_time_zone_check'
          AND tgrelid = 'public.notification_sequences'::regclass
          AND NOT tgisinternal)
  AND NOT EXISTS (SELECT 1 FROM pg_trigger
                   WHERE tgname = 'notification_sequence_defaults_send_time_zone_check'));

-- ---------------------------------------------------------------------------
-- The shape of inheritance (answer 3).
-- ---------------------------------------------------------------------------
-- A default has no org, no PHI, no cc list, and no enabled column: it can
-- never switch an org on.
SELECT pg_temp.m107_mark('defaults_have_no_org_no_enabled_no_cc',
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('notification_sequence_defaults', 'notification_sequence_default_steps')
       AND column_name IN ('org_id', 'enabled', 'cc_recipients')));
-- An org row's settings start unset (inherit); enabled starts false.
SELECT pg_temp.m107_mark('org_settings_default_to_inherit',
  (SELECT count(*) = 9 AND bool_and(is_nullable = 'YES' AND column_default IS NULL)
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notification_sequences'
      AND column_name IN ('stop_conditions', 'target_days_to_ready', 'bounce_escalation_step',
                          'digest_frequency', 'send_hour', 'send_time_zone',
                          'second_send_hour', 'digest_weekday', 'digest_cc_allowed'))
  AND (SELECT is_nullable = 'NO' AND column_default = 'false'
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'notification_sequences'
          AND column_name = 'enabled'));
-- G2: there is no default digest. Its schedule (how often, the weekly day,
-- the hour, the zone, the second hour) exists only on an org row, once Minted
-- sets the digest up for that org; the default has no such columns.
SELECT pg_temp.m107_mark('defaults_have_no_digest_schedule',
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('notification_sequence_defaults', 'notification_sequence_default_steps')
       AND column_name IN ('digest_frequency', 'digest_weekday', 'send_hour',
                           'send_time_zone', 'second_send_hour'))
  AND (SELECT array_agg(column_name::text ORDER BY column_name)
              = '{bounce_escalation_step,created_at,digest_cc_allowed,purpose,stop_conditions,target_days_to_ready,updated_at}'
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'notification_sequence_defaults'));
SELECT pg_temp.m107_mark('defaults_seeded_with_days_1_2_3_and_an_unscheduled_digest',
  (SELECT stop_conditions = '{submitted,paused,withdrawn,provider_replied}'
          AND target_days_to_ready = 14
     FROM public.notification_sequence_defaults WHERE purpose = 'intake_reminder')
  -- G2: the digest default is its audience (digest_cc_allowed, below) and its
  -- one step, nothing else.
  AND (SELECT stop_conditions IS NULL AND target_days_to_ready IS NULL
         FROM public.notification_sequence_defaults WHERE purpose = 'followup_digest')
  -- Days 1, 2 and 3 after the invite (Sowmya, Oct 31; was 2, 4 and 7).
  AND (SELECT array_agg(offset_days ORDER BY position) = '{1,2,3}'
              AND array_agg(template_key ORDER BY position)
                  = '{intake_reminder_first,intake_reminder_second,intake_reminder_final}'
              AND bool_and(channel = 'email')
         FROM public.notification_sequence_default_steps WHERE purpose = 'intake_reminder')
  AND (SELECT count(*) = 1 AND bool_and(offset_days = 0 AND channel = 'email'
                                        AND template_key = 'followup_digest_daily')
         FROM public.notification_sequence_default_steps WHERE purpose = 'followup_digest')
  AND (SELECT count(*) = 2 FROM public.notification_sequence_defaults));
-- Policy as configuration (MINT-113): the decided bounce step (1, Oct 30) and
-- digest audience (no cc, D59) are seeded settings, each on its own purpose.
SELECT pg_temp.m107_mark('defaults_seed_the_decided_policy_settings',
  (SELECT bounce_escalation_step = 1 AND digest_cc_allowed IS NULL
     FROM public.notification_sequence_defaults WHERE purpose = 'intake_reminder')
  AND (SELECT bounce_escalation_step IS NULL AND digest_cc_allowed = false
         FROM public.notification_sequence_defaults WHERE purpose = 'followup_digest'));
-- The bounce step is the org's own (like its cc lists): column grants for
-- authenticated, nullable, no default (NULL inherits). digest_cc_allowed is
-- Minted's on both layers (S7): the default and the org row's override
-- exist, and authenticated can write neither; service_role can.
SELECT pg_temp.m107_mark('bounce_step_is_org_owned_and_digest_cc_is_minted_only',
  has_column_privilege('authenticated', 'public.notification_sequences',
    'bounce_escalation_step', 'INSERT')
  AND has_column_privilege('authenticated', 'public.notification_sequences',
    'bounce_escalation_step', 'UPDATE')
  AND (SELECT is_nullable = 'YES' AND column_default IS NULL
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'notification_sequences'
          AND column_name = 'bounce_escalation_step')
  AND (SELECT count(*) = 2 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('notification_sequences', 'notification_sequence_defaults')
          AND column_name = 'digest_cc_allowed')
  AND NOT has_column_privilege('authenticated', 'public.notification_sequences',
    'digest_cc_allowed', 'INSERT')
  AND NOT has_column_privilege('authenticated', 'public.notification_sequences',
    'digest_cc_allowed', 'UPDATE')
  AND has_column_privilege('service_role', 'public.notification_sequences',
    'digest_cc_allowed', 'UPDATE')
  AND NOT has_column_privilege('authenticated', 'public.notification_sequence_defaults',
    'digest_cc_allowed', 'UPDATE')
  AND NOT has_column_privilege('authenticated', 'public.notification_sequence_defaults',
    'bounce_escalation_step', 'UPDATE')
  AND has_column_privilege('service_role', 'public.notification_sequence_defaults',
    'digest_cc_allowed', 'UPDATE'));
-- S7: the digest cc setting has an org override too, platform-managed like
-- send_hour: nullable (NULL inherits), no default, no authenticated grant.
SELECT pg_temp.m107_mark('org_digest_cc_override_is_platform_managed',
  (SELECT is_nullable = 'YES' AND column_default IS NULL
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notification_sequences'
      AND column_name = 'digest_cc_allowed')
  AND NOT has_column_privilege('authenticated', 'public.notification_sequences',
    'digest_cc_allowed', 'INSERT')
  AND NOT has_column_privilege('authenticated', 'public.notification_sequences',
    'digest_cc_allowed', 'UPDATE')
  AND has_column_privilege('service_role', 'public.notification_sequences',
    'digest_cc_allowed', 'UPDATE'));

-- ---------------------------------------------------------------------------
-- Validators (pure, apart from the zone list).
-- ---------------------------------------------------------------------------
SELECT pg_temp.m107_mark('cc_validator_truth_table',
  private.notification_cc_recipients_valid('[]')
  AND private.notification_cc_recipients_valid(
    '[{"kind":"user","user_id":"10700000-0000-4000-a000-000000000002"},{"kind":"role","role":"admin"}]')
  AND NOT private.notification_cc_recipients_valid('{}')
  AND NOT private.notification_cc_recipients_valid('[{"kind":"role","role":"owner"}]')
  AND NOT private.notification_cc_recipients_valid('[{"kind":"role","role":"admin","extra":1}]')
  AND NOT private.notification_cc_recipients_valid('[{"kind":"user"}]')
  AND NOT private.notification_cc_recipients_valid(
    '[{"kind":"user","user_id":"10700000-0000-4000-A000-000000000002"}]')
  AND NOT private.notification_cc_recipients_valid('[{"kind":"role","role":"admin"},{"kind":"role","role":"admin"}]')
  AND NOT private.notification_cc_recipients_valid('["admin"]')
  AND NOT private.notification_cc_recipients_valid(
    (SELECT jsonb_agg(jsonb_build_object('kind', 'user', 'user_id',
              lpad(g::text, 8, '0') || '-0000-4000-8000-000000000000'))
       FROM generate_series(1, 21) AS g)));
SELECT pg_temp.m107_mark('stop_condition_validator_truth_table',
  -- A11: at least one stop condition.
  NOT private.notification_stop_conditions_valid('{}')
  AND private.notification_stop_conditions_valid('{submitted}')
  AND private.notification_stop_conditions_valid('{submitted,paused,withdrawn,provider_replied}')
  AND NOT private.notification_stop_conditions_valid('{submitted,submitted}')
  AND NOT private.notification_stop_conditions_valid('{bounced}')
  AND NOT private.notification_stop_conditions_valid(ARRAY['submitted', NULL]::text[])
  AND NOT coalesce(private.notification_stop_conditions_valid(NULL), false));
-- Answer 5: the digest's time zone is a real IANA zone.
SELECT pg_temp.m107_mark('time_zone_validator_truth_table',
  private.notification_time_zone_valid('America/Chicago')
  AND private.notification_time_zone_valid('America/New_York')
  AND private.notification_time_zone_valid('America/Argentina/Buenos_Aires')
  AND private.notification_time_zone_valid('Etc/UTC')
  AND NOT private.notification_time_zone_valid('Mars/Olympus_Mons')
  AND NOT private.notification_time_zone_valid('america/chicago')
  AND NOT private.notification_time_zone_valid('CST')
  AND NOT private.notification_time_zone_valid('EST5EDT')
  AND NOT private.notification_time_zone_valid('+05:00')
  AND NOT private.notification_time_zone_valid('')
  AND NOT coalesce(private.notification_time_zone_valid(NULL), false));

-- ---------------------------------------------------------------------------
-- The save RPC as org A's admin.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000001');

-- Save 1: create intake (revision 1).
SELECT public.save_notification_sequence(
  '10700000-0000-4000-a000-00000000000a', 'intake_reminder', pg_temp.m107_intake('{2,4,7}'));
SELECT pg_temp.m107_mark('admin_creates_intake_off_leaving_unset_settings_to_inherit',
  (SELECT revision = 1 AND NOT enabled
      AND target_days_to_ready IS NULL
      AND send_hour IS NULL AND send_time_zone IS NULL
      AND stop_conditions = '{submitted,withdrawn}'
      AND updated_by = '10700000-0000-4000-a000-000000000001'
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'));
SELECT pg_temp.m107_mark('steps_saved_in_order_with_ordered_cc',
  (SELECT array_agg(offset_days ORDER BY position) = '{2,4,7}'
      AND array_agg(position ORDER BY position) = '{1,2,3}'
     FROM public.notification_sequence_steps
    WHERE org_id = '10700000-0000-4000-a000-00000000000a')
  AND (SELECT cc_recipients -> 0 ->> 'kind' = 'user' AND cc_recipients -> 1 ->> 'role' = 'admin'
         FROM public.notification_sequence_steps
        WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND position = 3));

-- Save 2: replace the steps (revision 2).
SELECT public.save_notification_sequence(
  '10700000-0000-4000-a000-00000000000a', 'intake_reminder', pg_temp.m107_intake('{3,9}', 1));
SELECT pg_temp.m107_mark('resave_replaces_steps_and_bumps_revision',
  (SELECT revision = 2 FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder')
  AND (SELECT array_agg(offset_days ORDER BY position) = '{3,9}'
         FROM public.notification_sequence_steps
        WHERE org_id = '10700000-0000-4000-a000-00000000000a'));

SELECT pg_temp.m107_mark('stale_revision_is_a_conflict', pg_temp.m107_expect_message(
  'notification_sequence_conflict',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'intake_reminder', pg_temp.m107_intake('{3,9}', 1))$$));
SELECT pg_temp.m107_mark('stale_revision_sqlstate_pt409', pg_temp.m107_expect_state(
  'PT409',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'intake_reminder', pg_temp.m107_intake('{3,9}', NULL))$$));
SELECT pg_temp.m107_mark('create_with_a_revision_is_a_conflict', pg_temp.m107_expect_state(
  'PT409',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'followup_digest', pg_temp.m107_digest(5))$$));

-- Save 3: create the digest (revision 1).
SELECT public.save_notification_sequence(
  '10700000-0000-4000-a000-00000000000a', 'followup_digest', pg_temp.m107_digest());
SELECT pg_temp.m107_mark('digest_saves_one_step_with_no_intake_settings',
  -- A9: a row the admin creates is off; Minted switches it on.
  (SELECT NOT enabled AND target_days_to_ready IS NULL AND stop_conditions IS NULL
      AND send_hour IS NULL AND send_time_zone IS NULL AND second_send_hour IS NULL
      AND digest_frequency IS NULL AND digest_weekday IS NULL
      AND bounce_escalation_step IS NULL AND digest_cc_allowed IS NULL
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest')
  AND (SELECT count(*) = 1 AND bool_and(cc_recipients = '[]'::jsonb)
         FROM public.notification_sequence_steps
        WHERE org_id = '10700000-0000-4000-a000-00000000000a'
          AND template_key = 'followup_digest_daily'));
-- Answer 2: the digest goes to coordinators only.
SELECT pg_temp.m107_mark('digest_cc_rejected_by_the_rpc', pg_temp.m107_expect_message(
  'notification_digest_has_no_cc',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'followup_digest', pg_temp.m107_digest(1, '[{"kind":"role","role":"specialist"}]'))$$));
SELECT pg_temp.m107_mark('digest_two_steps_rejected', pg_temp.m107_expect_message(
  'notification_digest_single_step',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'followup_digest', '{"expected_revision":1,"steps":[
        {"offset_days":0,"channel":"email","template_key":"followup_digest_daily","cc_recipients":[]},
        {"offset_days":1,"channel":"email","template_key":"followup_digest_daily","cc_recipients":[]}]}')$$));
SELECT pg_temp.m107_mark('digest_intake_settings_rejected', pg_temp.m107_expect_state(
  '22023',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'followup_digest', pg_temp.m107_digest(1) || '{"stop_conditions":["submitted"]}'::jsonb)$$));
SELECT pg_temp.m107_mark('unknown_purpose_rejected', pg_temp.m107_expect_state(
  '22023',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'payment_reminder', pg_temp.m107_intake('{2}'))$$));
SELECT pg_temp.m107_mark('cc_non_member_rejected', pg_temp.m107_expect_message(
  'notification_cc_user_not_member',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'intake_reminder', jsonb_set(pg_temp.m107_intake('{2}', 2), '{steps,0,cc_recipients}',
        '[{"kind":"user","user_id":"10700000-0000-4000-a000-000000000004"}]'))$$));
SELECT pg_temp.m107_mark('offsets_must_increase', pg_temp.m107_expect_message(
  'notification_step_offsets_not_increasing',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'intake_reminder', pg_temp.m107_intake('{4,4}', 2))$$));
SELECT pg_temp.m107_mark('template_must_match_purpose', pg_temp.m107_expect_message(
  'notification_step_template_purpose_mismatch',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'intake_reminder', jsonb_set(pg_temp.m107_intake('{2}', 2), '{steps,0,template_key}',
        '"followup_digest_daily"'))$$));
-- Answer 5 and A9: the save path cannot carry a platform-managed setting,
-- on/off included, whichever way.
SELECT pg_temp.m107_mark('rpc_refuses_platform_managed_settings',
  pg_temp.m107_expect_message('notification_platform_setting',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'intake_reminder', pg_temp.m107_intake('{3,9}', 2) || '{"enabled":true}'::jsonb)$$)
  AND pg_temp.m107_expect_state('42501',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'intake_reminder', pg_temp.m107_intake('{3,9}', 2) || '{"enabled":false}'::jsonb)$$)
  AND pg_temp.m107_expect_message('notification_platform_setting',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(1) || '{"second_send_hour":15}'::jsonb)$$)
  AND pg_temp.m107_expect_message('notification_platform_setting',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(1) || '{"digest_weekday":3}'::jsonb)$$)
  AND pg_temp.m107_expect_message('notification_platform_setting',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(1) || '{"send_hour":6}'::jsonb)$$)
  AND pg_temp.m107_expect_message('notification_platform_setting',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest',
        pg_temp.m107_digest(1) || '{"send_time_zone":"America/New_York"}'::jsonb)$$));
SELECT pg_temp.m107_mark('rpc_refuses_the_digest_cc_setting',
  pg_temp.m107_expect_message('notification_platform_setting',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(1) || '{"digest_cc_allowed":true}'::jsonb)$$)
  AND pg_temp.m107_expect_state('42501',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(1) || '{"digest_cc_allowed":false}'::jsonb)$$));
-- A13: compression is gone, so its key is just an unknown setting now.
SELECT pg_temp.m107_mark('compression_is_gone',
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('notification_sequences', 'notification_sequence_defaults')
       AND column_name = 'compress_toward_start_date')
  AND pg_temp.m107_expect_message('notification_sequence_invalid: unknown setting',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'intake_reminder',
        pg_temp.m107_intake('{3,9}', 2) || '{"compress_toward_start_date":false}'::jsonb)$$));
-- Addendum 10 (#561 Q2): Minted picks the digest frequency per org, so the
-- save path refuses the key whatever its value, on either purpose.
SELECT pg_temp.m107_mark('rpc_refuses_the_digest_frequency',
  pg_temp.m107_expect_message('notification_platform_setting: digest_frequency',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(1) || '{"digest_frequency":"weekly"}'::jsonb)$$)
  AND pg_temp.m107_expect_state('42501',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(1) || '{"digest_frequency":"twice_daily"}'::jsonb)$$)
  AND pg_temp.m107_expect_state('42501',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(1) || '{"digest_frequency":null}'::jsonb)$$)
  AND pg_temp.m107_expect_message('notification_platform_setting: digest_frequency',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'intake_reminder',
        pg_temp.m107_intake('{3,9}', 2) || '{"digest_frequency":"daily"}'::jsonb)$$));
-- A11 and A12, through the RPC.
SELECT pg_temp.m107_mark('rpc_refuses_an_empty_stop_list',
  pg_temp.m107_expect_message('notification_stop_condition_required',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'intake_reminder',
        jsonb_set(pg_temp.m107_intake('{3,9}', 2), '{stop_conditions}', '[]'))$$));
SELECT pg_temp.m107_mark('rpc_refuses_an_intake_step_on_the_invite_day',
  pg_temp.m107_expect_message('notification_intake_starts_day_1',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'intake_reminder', pg_temp.m107_intake('{0,3}', 2))$$));
SELECT pg_temp.m107_mark('rpc_refuses_unknown_settings', pg_temp.m107_expect_message(
  'notification_sequence_invalid: unknown setting',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'intake_reminder', pg_temp.m107_intake('{3,9}', 2) || '{"cc_everyone":true}'::jsonb)$$));
SELECT pg_temp.m107_mark('failed_saves_left_the_saved_rows_alone',
  (SELECT revision = 2 AND NOT enabled
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder')
  AND (SELECT revision = 1 AND send_hour IS NULL AND send_time_zone IS NULL
              AND digest_cc_allowed IS NULL
         FROM public.notification_sequences
        WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest')
  AND (SELECT array_agg(offset_days ORDER BY position) = '{3,9}'
         FROM public.notification_sequence_steps
        WHERE org_id = '10700000-0000-4000-a000-00000000000a'
          AND sequence_id = (SELECT id FROM public.notification_sequences
                              WHERE org_id = '10700000-0000-4000-a000-00000000000a'
                                AND purpose = 'intake_reminder')));

-- Answer 3: an admin overrides a default, then goes back to it.
-- Save 4: override the target (revision 3).
SELECT public.save_notification_sequence(
  '10700000-0000-4000-a000-00000000000a', 'intake_reminder',
  jsonb_set(pg_temp.m107_intake('{3,9}', 2), '{target_days_to_ready}', '21'));
SELECT pg_temp.m107_mark('admin_overrides_the_default_target',
  (SELECT revision = 3 AND target_days_to_ready = 21
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'));
-- Save 5: back to Minted's target, stop conditions and steps (revision 4).
SELECT public.save_notification_sequence(
  '10700000-0000-4000-a000-00000000000a', 'intake_reminder',
  jsonb_set(jsonb_set(pg_temp.m107_intake('{3,9}', 3), '{steps}', 'null'),
            '{stop_conditions}', 'null'));
SELECT pg_temp.m107_mark('back_to_the_default_clears_the_overrides_and_own_steps',
  (SELECT revision = 4 AND target_days_to_ready IS NULL AND stop_conditions IS NULL
          AND NOT enabled
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder')
  AND NOT EXISTS (
    SELECT 1 FROM public.notification_sequence_steps
     WHERE sequence_id = (SELECT id FROM public.notification_sequences
                           WHERE org_id = '10700000-0000-4000-a000-00000000000a'
                             AND purpose = 'intake_reminder'))
  -- The defaults themselves are untouched.
  AND (SELECT count(*) = 3 FROM public.notification_sequence_default_steps
        WHERE purpose = 'intake_reminder'));
-- Save 6: its own steps again, for the rest of the packet, and one stop
-- condition of its own (at least one is required, A11) (revision 5).
SELECT public.save_notification_sequence(
  '10700000-0000-4000-a000-00000000000a', 'intake_reminder',
  jsonb_set(pg_temp.m107_intake('{3,9}', 4), '{stop_conditions}', '["submitted"]'));
SELECT pg_temp.m107_mark('rpc_saves_the_orgs_own_single_stop_condition',
  (SELECT stop_conditions = '{submitted}'
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'));
SELECT pg_temp.m107_mark('own_steps_override_the_default_steps_again',
  (SELECT revision = 5
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder')
  AND (SELECT array_agg(offset_days ORDER BY position) = '{3,9}'
         FROM public.notification_sequence_steps
        WHERE org_id = '10700000-0000-4000-a000-00000000000a'
          AND template_key LIKE 'intake_reminder_%'));

-- The bounce escalation step through the save RPC (probes: rolled back, so
-- the revisions and audit counts below are unchanged). No key so far: the
-- org inherits Minted's step.
SELECT pg_temp.m107_mark('saves_without_a_bounce_step_inherit_it',
  (SELECT bounce_escalation_step IS NULL AND revision = 5
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'));
SELECT pg_temp.m107_mark('rpc_saves_the_orgs_own_bounce_step',
  pg_temp.m107_probe(
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'intake_reminder', pg_temp.m107_intake('{3,9}', 5) || '{"bounce_escalation_step":2}'::jsonb)$$,
    $$SELECT bounce_escalation_step = 2 AND revision = 6
        FROM public.notification_sequences
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$));
SELECT pg_temp.m107_mark('rpc_saves_bounce_escalation_off_as_zero',
  pg_temp.m107_probe(
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'intake_reminder', pg_temp.m107_intake('{3,9}', 5) || '{"bounce_escalation_step":0}'::jsonb)$$,
    $$SELECT bounce_escalation_step = 0
        FROM public.notification_sequences
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$));
SELECT pg_temp.m107_mark('rpc_saves_a_null_bounce_step_as_inherit',
  pg_temp.m107_probe(
    $$DO $d$ BEGIN
        UPDATE public.notification_sequences SET bounce_escalation_step = 4
         WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder';
        PERFORM public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
          'intake_reminder', pg_temp.m107_intake('{3,9}', 6) || '{"bounce_escalation_step":null}'::jsonb);
      END $d$ $$,
    $$SELECT bounce_escalation_step IS NULL AND revision = 7
        FROM public.notification_sequences
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$));
SELECT pg_temp.m107_mark('rpc_saves_the_highest_bounce_step',
  pg_temp.m107_probe(
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'intake_reminder', pg_temp.m107_intake('{3,9}', 5) || '{"bounce_escalation_step":10}'::jsonb)$$,
    $$SELECT bounce_escalation_step = 10
        FROM public.notification_sequences
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$));
SELECT pg_temp.m107_mark('rpc_refuses_a_bad_bounce_step',
  (SELECT bool_and(pg_temp.m107_expect_message(
            'notification_sequence_invalid: bounce_escalation_step',
            format($$SELECT public.save_notification_sequence(
                       '10700000-0000-4000-a000-00000000000a', 'intake_reminder',
                       pg_temp.m107_intake('{3,9}', 5) || %L::jsonb)$$, bad))
                   AND pg_temp.m107_expect_state('22023',
            format($$SELECT public.save_notification_sequence(
                       '10700000-0000-4000-a000-00000000000a', 'intake_reminder',
                       pg_temp.m107_intake('{3,9}', 5) || %L::jsonb)$$, bad)))
     FROM unnest(ARRAY['{"bounce_escalation_step":11}', '{"bounce_escalation_step":-1}',
                       '{"bounce_escalation_step":1.5}', '{"bounce_escalation_step":"1"}',
                       '{"bounce_escalation_step":true}', '{"bounce_escalation_step":100}'])
          AS b(bad)));
SELECT pg_temp.m107_mark('rpc_refuses_a_bounce_step_on_the_digest', pg_temp.m107_expect_message(
  'notification_sequence_invalid: digest_has_no_intake_settings',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'followup_digest', pg_temp.m107_digest(1) || '{"bounce_escalation_step":1}'::jsonb)$$));
-- A direct admin write of the bounce step is an edit of the org's settings.
SELECT pg_temp.m107_mark('direct_bounce_step_write_is_an_attributed_org_edit',
  pg_temp.m107_probe(
    $$UPDATE public.notification_sequences SET bounce_escalation_step = 3
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$,
    $$SELECT bounce_escalation_step = 3 AND revision = 6
             AND updated_by = '10700000-0000-4000-a000-000000000001'
        FROM public.notification_sequences
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$));
SELECT pg_temp.m107_mark('probes_left_the_intake_row_alone',
  (SELECT bounce_escalation_step IS NULL AND revision = 5
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder')
  -- Saves 1 to 6 only.
  AND (SELECT count(*) = 6 FROM public.audit_log
        WHERE org_id = '10700000-0000-4000-a000-00000000000a'
          AND entity_type = 'notification_sequence'));

-- ---------------------------------------------------------------------------
-- Direct PostgREST-style writes as org A's admin.
-- ---------------------------------------------------------------------------
-- Attributed to the verified caller (revision 6).
UPDATE public.notification_sequences SET target_days_to_ready = 20
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder';
SELECT pg_temp.m107_mark('direct_update_is_attributed_and_bumps_revision',
  (SELECT updated_by = '10700000-0000-4000-a000-000000000001' AND revision = 6
          AND target_days_to_ready = 20
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'));
SELECT pg_temp.m107_mark('updated_by_cannot_be_written_directly', pg_temp.m107_expect_state(
  '42501',
  $$UPDATE public.notification_sequences SET updated_by = '10700000-0000-4000-a000-000000000004'
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$));
-- Answer 5 and A9: no direct write reaches a platform-managed column either:
-- an org admin can turn notifications neither on nor off.
SELECT pg_temp.m107_mark('direct_platform_column_writes_are_refused',
  pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequences SET enabled = true
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$)
  AND pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequences SET enabled = false
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$)
  AND pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequences SET digest_weekday = 3
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequences SET send_hour = 6
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequences SET send_time_zone = 'America/New_York'
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('42501',
    $$INSERT INTO public.notification_sequences (org_id, purpose, enabled)
      VALUES ('10700000-0000-4000-a000-00000000000b', 'intake_reminder', true)$$));
-- Addendum 10: nor can an admin set the digest frequency directly.
SELECT pg_temp.m107_mark('org_admin_cannot_set_the_digest_frequency',
  pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequences SET digest_frequency = 'weekly'
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('42501',
    $$INSERT INTO public.notification_sequences (org_id, purpose, digest_frequency)
      VALUES ('10700000-0000-4000-a000-00000000000b', 'followup_digest', 'weekly')$$));
SELECT pg_temp.m107_mark('org_admin_cannot_set_the_digest_cc_override',
  pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequences SET digest_cc_allowed = true
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('42501',
    $$INSERT INTO public.notification_sequences (org_id, purpose, digest_cc_allowed)
      VALUES ('10700000-0000-4000-a000-00000000000b', 'followup_digest', true)$$));

-- The stamp trigger is a second wall: even with a widened column grant, a
-- write to a platform-managed column by anyone but Minted's own roles is
-- refused, on INSERT and UPDATE. It is an allow-list, so anon is refused by
-- the trigger itself, before RLS gets to it.
RESET ROLE;
GRANT INSERT (enabled, send_hour, digest_cc_allowed, digest_frequency),
      UPDATE (enabled, send_hour, digest_cc_allowed, digest_frequency)
  ON TABLE public.notification_sequences TO authenticated;
GRANT INSERT (org_id, purpose, enabled)
  ON TABLE public.notification_sequences TO anon;
SET LOCAL ROLE authenticated;
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000001');
SELECT pg_temp.m107_mark('stamp_trigger_backs_up_the_column_grant',
  pg_temp.m107_expect_message('notification_platform_setting',
    $$UPDATE public.notification_sequences SET enabled = true
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$)
  AND pg_temp.m107_expect_message('notification_platform_setting',
    $$UPDATE public.notification_sequences SET send_hour = 6
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_message('notification_platform_setting',
    $$UPDATE public.notification_sequences SET digest_frequency = 'weekly'
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$));
SELECT pg_temp.m107_mark('stamp_trigger_backs_up_the_digest_cc_grant',
  pg_temp.m107_expect_message('notification_platform_setting',
    $$UPDATE public.notification_sequences SET digest_cc_allowed = true
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$));
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000004');
SELECT pg_temp.m107_mark('stamp_trigger_backs_up_the_digest_cc_grant_on_insert',
  pg_temp.m107_expect_message('notification_platform_setting',
    $$INSERT INTO public.notification_sequences (org_id, purpose, digest_cc_allowed)
      VALUES ('10700000-0000-4000-a000-00000000000b', 'followup_digest', true)$$));
SELECT pg_temp.m107_mark('stamp_trigger_backs_up_the_column_grant_on_insert',
  pg_temp.m107_expect_message('notification_platform_setting',
    $$INSERT INTO public.notification_sequences (org_id, purpose, enabled)
      VALUES ('10700000-0000-4000-a000-00000000000b', 'intake_reminder', true)$$)
  AND pg_temp.m107_expect_message('notification_platform_setting',
    $$INSERT INTO public.notification_sequences (org_id, purpose, send_hour)
      VALUES ('10700000-0000-4000-a000-00000000000b', 'followup_digest', 6)$$)
  AND pg_temp.m107_expect_message('notification_platform_setting',
    $$INSERT INTO public.notification_sequences (org_id, purpose, digest_frequency)
      VALUES ('10700000-0000-4000-a000-00000000000b', 'followup_digest', 'weekly')$$));
SET LOCAL ROLE anon;
SELECT pg_temp.m107_mark('stamp_trigger_allows_only_minted_roles',
  pg_temp.m107_expect_message('notification_platform_setting',
    $$INSERT INTO public.notification_sequences (org_id, purpose, enabled)
      VALUES ('10700000-0000-4000-a000-00000000000b', 'intake_reminder', true)$$));
RESET ROLE;
REVOKE INSERT (enabled, send_hour, digest_cc_allowed, digest_frequency),
       UPDATE (enabled, send_hour, digest_cc_allowed, digest_frequency)
  ON TABLE public.notification_sequences FROM authenticated;
REVOKE INSERT (org_id, purpose, enabled)
  ON TABLE public.notification_sequences FROM anon;

-- Org A's intake id, for the probes below that cannot read it themselves.
CREATE TEMP TABLE m107_ids AS
  SELECT id AS intake_id FROM public.notification_sequences
   WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder';
GRANT SELECT ON m107_ids TO authenticated, service_role;

-- A direct step write bumps the sequence's revision once per transaction.
-- This whole packet is one transaction, so now() never moves and the
-- sequence was already stamped; backdate it (stamp trigger off, as the
-- owner) to look like a sequence last saved in an earlier transaction.
ALTER TABLE public.notification_sequences DISABLE TRIGGER notification_sequences_stamp;
UPDATE public.notification_sequences SET updated_at = now() - interval '1 hour'
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder';
ALTER TABLE public.notification_sequences ENABLE TRIGGER notification_sequences_stamp;
SET LOCAL ROLE authenticated;
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000001');
UPDATE public.notification_sequence_steps SET cc_recipients = '[{"kind":"role","role":"billing"}]'
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND position = 1
   AND template_key LIKE 'intake_reminder_%';
UPDATE public.notification_sequence_steps SET cc_recipients = '[{"kind":"role","role":"admin"}]'
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND position = 2
   AND template_key LIKE 'intake_reminder_%';
SELECT pg_temp.m107_mark('direct_step_writes_bump_revision_once',
  (SELECT revision = 7 AND updated_by = '10700000-0000-4000-a000-000000000001'
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'));
-- A step's created_at is the insert time, never a value the client sent.
-- (The sequence was stamped in this transaction already, so no bump.)
WITH ins AS (
  INSERT INTO public.notification_sequence_steps
    (sequence_id, org_id, position, offset_days, channel, template_key, created_at)
  SELECT intake_id, '10700000-0000-4000-a000-00000000000a', 3, 20, 'email', 'intake_reminder_final', '2000-01-01T00:00:00Z'
    FROM m107_ids
  RETURNING created_at
)
SELECT pg_temp.m107_mark('step_created_at_is_the_insert_time',
  (SELECT count(*) = 1 AND bool_and(created_at = now()) FROM ins));
DELETE FROM public.notification_sequence_steps
 WHERE sequence_id = (SELECT intake_id FROM m107_ids) AND position = 3;
SELECT pg_temp.m107_mark('save_holding_the_pre_step_write_revision_conflicts',
  pg_temp.m107_expect_message('notification_sequence_conflict',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'intake_reminder', pg_temp.m107_intake('{3,9}', 6))$$));
-- Saves 1, 2, 4, 5 and 6 are audited; the direct writes are not.
SELECT pg_temp.m107_mark('direct_writes_are_not_audited',
  (SELECT count(*) = 5 FROM public.audit_log
    WHERE org_id = '10700000-0000-4000-a000-00000000000a'
      AND entity_type = 'notification_sequence'
      AND entity_id = (SELECT id FROM public.notification_sequences
                        WHERE org_id = '10700000-0000-4000-a000-00000000000a'
                          AND purpose = 'intake_reminder')));
-- Answer 2, by a direct write.
SELECT pg_temp.m107_mark('direct_digest_cc_rejected', pg_temp.m107_expect_message(
  'notification_digest_has_no_cc',
  $$UPDATE public.notification_sequence_steps SET cc_recipients = '[{"kind":"role","role":"admin"}]'
     WHERE org_id = '10700000-0000-4000-a000-00000000000a'
       AND template_key = 'followup_digest_daily'$$));

-- ... and by a direct INSERT of the digest's one step with a cc list.
SELECT pg_temp.m107_mark('direct_digest_cc_insert_rejected', pg_temp.m107_expect_message(
  'notification_digest_has_no_cc',
  $$DO $d$ BEGIN
      DELETE FROM public.notification_sequence_steps
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND template_key = 'followup_digest_daily';
      INSERT INTO public.notification_sequence_steps
        (sequence_id, org_id, position, offset_days, channel, template_key, cc_recipients)
      SELECT id, org_id, 1, 0, 'email', 'followup_digest_daily', '[{"kind":"role","role":"admin"}]'
        FROM public.notification_sequences
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest';
    END $d$ $$));

SELECT pg_temp.m107_mark('identity_columns_have_no_update_grant', pg_temp.m107_expect_state(
  '42501',
  $$UPDATE public.notification_sequences SET purpose = 'followup_digest'
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$));
SELECT pg_temp.m107_mark('admin_cannot_delete_a_sequence', pg_temp.m107_expect_state(
  '42501',
  $$DELETE FROM public.notification_sequences
     WHERE org_id = '10700000-0000-4000-a000-00000000000a'$$));

-- Answer 3: an org admin cannot write Minted's defaults by any path.
SELECT pg_temp.m107_mark('org_admin_cannot_write_the_defaults',
  pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequence_defaults SET target_days_to_ready = 30
       WHERE purpose = 'intake_reminder'$$)
  AND pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequence_defaults SET stop_conditions = '{submitted}'
       WHERE purpose = 'intake_reminder'$$)
  AND pg_temp.m107_expect_state('42501',
    $$INSERT INTO public.notification_sequence_defaults (purpose, digest_cc_allowed)
      VALUES ('followup_digest', true)$$)
  AND pg_temp.m107_expect_state('42501',
    $$DELETE FROM public.notification_sequence_defaults$$)
  AND pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequence_default_steps SET offset_days = 1
       WHERE purpose = 'intake_reminder' AND position = 1$$)
  AND pg_temp.m107_expect_state('42501',
    $$INSERT INTO public.notification_sequence_default_steps
        (purpose, position, offset_days, channel, template_key)
      VALUES ('intake_reminder', 4, 9, 'email', 'intake_reminder_final')$$)
  AND pg_temp.m107_expect_state('42501',
    $$DELETE FROM public.notification_sequence_default_steps$$));
-- Nor relax the digest's audience, or change Minted's bounce step.
SELECT pg_temp.m107_mark('org_admin_cannot_change_the_policy_defaults',
  pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequence_defaults SET digest_cc_allowed = true
       WHERE purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('42501',
    $$UPDATE public.notification_sequence_defaults SET bounce_escalation_step = 0
       WHERE purpose = 'intake_reminder'$$));
SELECT pg_temp.m107_mark('defaults_unchanged_after_the_admin_tried',
  (SELECT target_days_to_ready = 14
     FROM public.notification_sequence_defaults WHERE purpose = 'intake_reminder')
  AND (SELECT digest_cc_allowed = false FROM public.notification_sequence_defaults
        WHERE purpose = 'followup_digest')
  AND (SELECT count(*) = 4 FROM public.notification_sequence_default_steps));

-- ---------------------------------------------------------------------------
-- Other roles in org A.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000002');
SELECT pg_temp.m107_mark('specialist_reads_but_cannot_save',
  (SELECT count(*) = 2 FROM public.notification_sequences)
  AND pg_temp.m107_expect_message('notification_sequence_not_authorized',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'intake_reminder', pg_temp.m107_intake('{2}', 7))$$));

SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000003');
SELECT pg_temp.m107_mark('billing_reads_sequences_and_steps',
  (SELECT count(*) = 2 FROM public.notification_sequences)
  AND (SELECT count(*) = 3 FROM public.notification_sequence_steps));
SELECT pg_temp.m107_mark('org_a_member_reads_the_defaults',
  (SELECT count(*) = 2 FROM public.notification_sequence_defaults)
  AND (SELECT count(*) = 4 FROM public.notification_sequence_default_steps));
SELECT pg_temp.m107_mark('billing_cannot_insert', pg_temp.m107_expect_state(
  '42501',
  $$INSERT INTO public.notification_sequence_steps
      (sequence_id, org_id, position, offset_days, channel, template_key)
    SELECT id, org_id, 5, 50, 'email', 'intake_reminder_first'
      FROM public.notification_sequences WHERE purpose = 'intake_reminder'$$));
-- Data-modifying CTEs must be top-level statements.
WITH changed AS (
  UPDATE public.notification_sequences SET target_days_to_ready = 30 RETURNING 1
)
SELECT pg_temp.m107_mark('billing_update_touches_nothing', count(*) = 0) FROM changed;
WITH gone AS (
  DELETE FROM public.notification_sequence_steps RETURNING 1
)
SELECT pg_temp.m107_mark('billing_delete_touches_nothing', count(*) = 0) FROM gone;

-- ---------------------------------------------------------------------------
-- Org B's admin sees nothing of org A and cannot write it, but reads the
-- same defaults.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000004');
SELECT pg_temp.m107_mark('other_org_reads_nothing',
  (SELECT count(*) = 0 FROM public.notification_sequences)
  AND (SELECT count(*) = 0 FROM public.notification_sequence_steps)
  AND (SELECT count(*) = 0 FROM public.sms_consents));
SELECT pg_temp.m107_mark('org_b_member_reads_the_defaults',
  (SELECT count(*) = 2 FROM public.notification_sequence_defaults)
  AND (SELECT count(*) = 4 FROM public.notification_sequence_default_steps));
SELECT pg_temp.m107_mark('other_org_admin_cannot_save', pg_temp.m107_expect_state(
  '42501',
  $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
      'intake_reminder', pg_temp.m107_intake('{2}', 7))$$));
SELECT pg_temp.m107_mark('other_org_admin_cannot_insert_into_org_a', pg_temp.m107_expect_state(
  '42501',
  $$INSERT INTO public.notification_sequences (org_id, purpose)
    VALUES ('10700000-0000-4000-a000-00000000000a', 'followup_digest')$$));
-- A step into org A's sequence: under org A, RLS refuses it; under org B, the
-- composite FK does (the sequence is not org B's).
SELECT pg_temp.m107_mark('other_org_admin_cannot_add_a_step_to_org_a',
  pg_temp.m107_expect_state('42501', $$
    INSERT INTO public.notification_sequence_steps
      (sequence_id, org_id, position, offset_days, channel, template_key)
    SELECT intake_id, '10700000-0000-4000-a000-00000000000a', 8, 80, 'email', 'intake_reminder_first' FROM m107_ids$$)
  AND pg_temp.m107_expect_state('23503', $$
    INSERT INTO public.notification_sequence_steps
      (sequence_id, org_id, position, offset_days, channel, template_key)
    SELECT intake_id, '10700000-0000-4000-a000-00000000000b', 8, 80, 'email', 'intake_reminder_first' FROM m107_ids$$));
WITH changed AS (
  UPDATE public.notification_sequence_steps SET offset_days = 50
   WHERE sequence_id IN (SELECT intake_id FROM m107_ids) RETURNING 1
)
SELECT pg_temp.m107_mark('other_org_admin_updates_no_org_a_step', count(*) = 0) FROM changed;
WITH gone AS (
  DELETE FROM public.notification_sequence_steps
   WHERE sequence_id IN (SELECT intake_id FROM m107_ids) RETURNING 1
)
SELECT pg_temp.m107_mark('other_org_admin_deletes_no_org_a_step', count(*) = 0) FROM gone;

-- A signed-in user who belongs to no org reads no defaults.
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000005');
SELECT pg_temp.m107_mark('user_with_no_org_reads_no_defaults',
  (SELECT count(*) = 0 FROM public.notification_sequence_defaults)
  AND (SELECT count(*) = 0 FROM public.notification_sequence_default_steps)
  AND (SELECT count(*) = 0 FROM public.notification_sequences));

RESET ROLE;

-- ---------------------------------------------------------------------------
-- Table CHECKs and keys, as the owner so RLS and grants are out of the way.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m107_mark('check_channel', pg_temp.m107_expect_state('23514', $$
  INSERT INTO public.notification_sequence_steps
    (sequence_id, org_id, position, offset_days, channel, template_key)
  SELECT intake_id, '10700000-0000-4000-a000-00000000000a', 8, 80, 'fax', 'intake_reminder_first'
    FROM m107_ids$$));
SELECT pg_temp.m107_mark('check_template_key_format', pg_temp.m107_expect_state('23514', $$
  INSERT INTO public.notification_sequence_steps
    (sequence_id, org_id, position, offset_days, channel, template_key)
  SELECT intake_id, '10700000-0000-4000-a000-00000000000a', 8, 80, 'email', 'Intake Reminder'
    FROM m107_ids$$));
SELECT pg_temp.m107_mark('check_offset_bounds', pg_temp.m107_expect_state('23514', $$
  INSERT INTO public.notification_sequence_steps
    (sequence_id, org_id, position, offset_days, channel, template_key)
  SELECT intake_id, '10700000-0000-4000-a000-00000000000a', 8, 91, 'email', 'intake_reminder_first'
    FROM m107_ids$$));
SELECT pg_temp.m107_mark('check_position_bounds', pg_temp.m107_expect_state('23514', $$
  INSERT INTO public.notification_sequence_steps
    (sequence_id, org_id, position, offset_days, channel, template_key)
  SELECT intake_id, '10700000-0000-4000-a000-00000000000a', 11, 80, 'email', 'intake_reminder_first'
    FROM m107_ids$$));
SELECT pg_temp.m107_mark('check_cc_shape', pg_temp.m107_expect_state('23514', $$
  INSERT INTO public.notification_sequence_steps
    (sequence_id, org_id, position, offset_days, channel, template_key, cc_recipients)
  SELECT intake_id, '10700000-0000-4000-a000-00000000000a', 8, 80, 'email', 'intake_reminder_first',
         '[{"kind":"role","role":"owner"}]'
    FROM m107_ids$$));
SELECT pg_temp.m107_mark('unique_position_per_sequence', pg_temp.m107_expect_state('23505', $$
  INSERT INTO public.notification_sequence_steps
    (sequence_id, org_id, position, offset_days, channel, template_key)
  SELECT intake_id, '10700000-0000-4000-a000-00000000000a', 1, 1, 'email', 'intake_reminder_first'
    FROM m107_ids$$));
SELECT pg_temp.m107_mark('step_org_must_match_sequence_org', pg_temp.m107_expect_state('23503', $$
  INSERT INTO public.notification_sequence_steps
    (sequence_id, org_id, position, offset_days, channel, template_key)
  SELECT intake_id, '10700000-0000-4000-a000-00000000000b', 8, 80, 'email', 'intake_reminder_first'
    FROM m107_ids$$));
SELECT pg_temp.m107_mark('check_stop_conditions', pg_temp.m107_expect_state('23514', $$
  UPDATE public.notification_sequences SET stop_conditions = '{submitted,bounced}'
   WHERE id = (SELECT intake_id FROM m107_ids)$$));
SELECT pg_temp.m107_mark('check_target_bounds', pg_temp.m107_expect_state('23514', $$
  UPDATE public.notification_sequences SET target_days_to_ready = 91
   WHERE id = (SELECT intake_id FROM m107_ids)$$));
SELECT pg_temp.m107_mark('check_digest_has_no_intake_settings',
  pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET stop_conditions = '{submitted}'
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET stop_conditions = '{}'
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET target_days_to_ready = 14
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET bounce_escalation_step = 1
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$));
-- A8: the frequency and weekday are bounded, and the digest's own. (Each
-- probe sets the whole schedule, so only the CHECK named can refuse it.)
SELECT pg_temp.m107_mark('check_digest_frequency_and_weekday',
  pg_temp.m107_expect_message('notification_sequences_digest_frequency_check', $$
    UPDATE public.notification_sequences
       SET digest_frequency = 'hourly', digest_weekday = 1, send_hour = 8,
           send_time_zone = 'America/Chicago', second_send_hour = 14
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_message('notification_sequences_digest_weekday_check', $$
    UPDATE public.notification_sequences
       SET digest_frequency = 'weekly', digest_weekday = 8, send_hour = 8,
           send_time_zone = 'America/Chicago', second_send_hour = 14
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET digest_frequency = 'daily'
     WHERE id = (SELECT intake_id FROM m107_ids)$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET digest_weekday = 1
     WHERE id = (SELECT intake_id FROM m107_ids)$$));
-- A10 and G2: the digest's schedule (how often, the weekly day, the hour, the
-- zone, the second hour) is one group on an org row, all set or all NULL;
-- the second hour after the first.
SELECT pg_temp.m107_mark('check_digest_schedule_is_one_group',
  pg_temp.m107_expect_message('notification_sequences_digest_schedule_check', $$
    UPDATE public.notification_sequences SET send_hour = 8
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_message('notification_sequences_digest_schedule_check', $$
    UPDATE public.notification_sequences SET send_time_zone = 'America/Chicago'
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_message('notification_sequences_digest_schedule_check', $$
    UPDATE public.notification_sequences SET digest_frequency = 'weekly'
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  -- The send time alone is no longer a schedule: how often and the day too.
  AND pg_temp.m107_expect_message('notification_sequences_digest_schedule_check', $$
    UPDATE public.notification_sequences
       SET send_hour = 8, send_time_zone = 'America/Chicago', second_send_hour = 14
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_message('notification_sequences_digest_schedule_check', $$
    UPDATE public.notification_sequences
       SET digest_frequency = 'daily', digest_weekday = 1, send_hour = 8,
           send_time_zone = 'America/Chicago'
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_message('notification_sequences_second_send_hour_check', $$
    UPDATE public.notification_sequences
       SET digest_frequency = 'daily', digest_weekday = 1, send_hour = 15,
           send_time_zone = 'America/Chicago', second_send_hour = 9
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_probe($$
    UPDATE public.notification_sequences
       SET digest_frequency = 'daily', digest_weekday = 1, send_hour = 8,
           send_time_zone = 'America/Chicago', second_send_hour = 14
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$,
    $$SELECT send_hour = 8 AND second_send_hour = 14 AND digest_frequency = 'daily'
        FROM public.notification_sequences
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$));
-- A11: never an empty stop list, on an org row or a default.
SELECT pg_temp.m107_mark('check_stop_conditions_not_empty',
  pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET stop_conditions = '{}'
     WHERE id = (SELECT intake_id FROM m107_ids)$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequence_defaults SET stop_conditions = '{}'
     WHERE purpose = 'intake_reminder'$$));
-- A12: no intake step on the invite day, by a direct write or on a default.
SELECT pg_temp.m107_mark('no_intake_step_on_the_invite_day',
  pg_temp.m107_expect_message('notification_intake_starts_day_1', $$
    UPDATE public.notification_sequence_steps SET offset_days = 0
     WHERE sequence_id = (SELECT intake_id FROM m107_ids) AND position = 1$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequence_default_steps SET offset_days = 0
     WHERE purpose = 'intake_reminder' AND position = 1$$));
SELECT pg_temp.m107_mark('check_intake_has_no_send_time',
  pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET send_hour = 8
     WHERE id = (SELECT intake_id FROM m107_ids)$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET send_time_zone = 'America/Chicago'
     WHERE id = (SELECT intake_id FROM m107_ids)$$));
SELECT pg_temp.m107_mark('check_intake_has_no_digest_cc_setting', pg_temp.m107_expect_state('23514', $$
  UPDATE public.notification_sequences SET digest_cc_allowed = true
   WHERE id = (SELECT intake_id FROM m107_ids)$$));
SELECT pg_temp.m107_mark('check_send_hour_bounds',
  pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET send_hour = 24
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET send_hour = -1
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$));
SELECT pg_temp.m107_mark('check_bounce_escalation_step_bounds',
  pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET bounce_escalation_step = 11
     WHERE id = (SELECT intake_id FROM m107_ids)$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET bounce_escalation_step = -1
     WHERE id = (SELECT intake_id FROM m107_ids)$$));
SELECT pg_temp.m107_mark('check_digest_has_no_bounce_step', pg_temp.m107_expect_state('23514', $$
  UPDATE public.notification_sequences SET bounce_escalation_step = 1
   WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$));
-- Each default carries its own policy setting, always set, and not the other's.
SELECT pg_temp.m107_mark('defaults_keep_each_policy_setting_on_its_purpose',
  pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequence_defaults SET bounce_escalation_step = NULL
     WHERE purpose = 'intake_reminder'$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequence_defaults SET bounce_escalation_step = 11
     WHERE purpose = 'intake_reminder'$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequence_defaults SET digest_cc_allowed = false
     WHERE purpose = 'intake_reminder'$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequence_defaults SET digest_cc_allowed = NULL
     WHERE purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequence_defaults SET bounce_escalation_step = 1
     WHERE purpose = 'followup_digest'$$));
SELECT pg_temp.m107_mark('check_send_time_zone_is_iana',
  pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET send_time_zone = 'Mars/Olympus_Mons'
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_message('notification_invalid_time_zone', $$
    UPDATE public.notification_sequences SET send_time_zone = 'CST'
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$));
-- A zone a later tzdata no longer knows does not block an unrelated update;
-- writing it again is refused. (Simulated: stored with the trigger off.)
-- (The whole schedule is set, A10 and G2: Minted sets the digest up.)
ALTER TABLE public.notification_sequences DISABLE TRIGGER notification_sequences_send_time_zone_check;
UPDATE public.notification_sequences
   SET digest_frequency = 'weekly', digest_weekday = 1, send_hour = 8,
       send_time_zone = 'Gone/Zone', second_send_hour = 14
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest';
ALTER TABLE public.notification_sequences ENABLE TRIGGER notification_sequences_send_time_zone_check;
-- (The unrelated update is Minted's: the frequency, which keeps the revision.)
UPDATE public.notification_sequences SET digest_frequency = 'daily'
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest';
SELECT pg_temp.m107_mark('a_stored_zone_is_not_rechecked_by_an_unrelated_update',
  (SELECT digest_frequency = 'daily' AND send_time_zone = 'Gone/Zone' AND revision = 1
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest')
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequences SET send_time_zone = 'Gone/Zone'
     WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$));
SELECT pg_temp.m107_mark('unique_org_purpose', pg_temp.m107_expect_state('23505', $$
  INSERT INTO public.notification_sequences (org_id, purpose)
  VALUES ('10700000-0000-4000-a000-00000000000a', 'intake_reminder')$$));
SELECT pg_temp.m107_mark('direct_digest_second_step_rejected', pg_temp.m107_expect_message(
  'notification_digest_single_step', $$
  INSERT INTO public.notification_sequence_steps
    (sequence_id, org_id, position, offset_days, channel, template_key)
  SELECT id, org_id, 2, 1, 'email', 'followup_digest_daily'
    FROM public.notification_sequences
   WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'$$));
SELECT pg_temp.m107_mark('identity_is_immutable', pg_temp.m107_expect_message(
  'notification_sequence_identity_immutable',
  $$UPDATE public.notification_sequences SET purpose = 'followup_digest'
     WHERE id = (SELECT intake_id FROM m107_ids)$$));

-- The defaults keep the same rules as an org's steps, and stay complete.
SELECT pg_temp.m107_mark('default_steps_keep_the_step_rules',
  pg_temp.m107_expect_message('notification_digest_single_step', $$
    INSERT INTO public.notification_sequence_default_steps
      (purpose, position, offset_days, channel, template_key)
    VALUES ('followup_digest', 2, 1, 'email', 'followup_digest_daily')$$)
  -- Day 3 again after the default's last step on day 3: not increasing.
  AND pg_temp.m107_expect_message('notification_step_offsets_not_increasing', $$
    INSERT INTO public.notification_sequence_default_steps
      (purpose, position, offset_days, channel, template_key)
    VALUES ('intake_reminder', 4, 3, 'email', 'intake_reminder_final')$$)
  AND pg_temp.m107_expect_state('23514', $$
    INSERT INTO public.notification_sequence_default_steps
      (purpose, position, offset_days, channel, template_key)
    VALUES ('intake_reminder', 4, 9, 'email', 'followup_digest_daily')$$)
  AND pg_temp.m107_expect_state('23514', $$
    INSERT INTO public.notification_sequence_default_steps
      (purpose, position, offset_days, channel, template_key)
    VALUES ('intake_reminder', 4, 9, 'fax', 'intake_reminder_final')$$)
  AND pg_temp.m107_expect_state('23503', $$
    INSERT INTO public.notification_sequence_default_steps
      (purpose, position, offset_days, channel, template_key)
    VALUES ('payment_reminder', 1, 1, 'email', 'payment_reminder_first')$$));
SELECT pg_temp.m107_mark('defaults_stay_complete_for_their_purpose',
  pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequence_defaults SET target_days_to_ready = NULL
     WHERE purpose = 'intake_reminder'$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequence_defaults SET target_days_to_ready = 14
     WHERE purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_state('23514', $$
    UPDATE public.notification_sequence_defaults SET stop_conditions = '{bounced}'
     WHERE purpose = 'intake_reminder'$$)
  AND pg_temp.m107_expect_state('23514', $$
    INSERT INTO public.notification_sequence_defaults (purpose) VALUES ('payment_reminder')$$)
  AND pg_temp.m107_expect_message('notification_default_identity_immutable', $$
    UPDATE public.notification_sequence_defaults SET purpose = 'followup_digest'
     WHERE purpose = 'intake_reminder'$$));
-- Answer 3: a default always has its steps, exactly one for the digest.
SELECT pg_temp.m107_mark('defaults_keep_at_least_one_step',
  pg_temp.m107_expect_message('notification_default_needs_a_step', $$
    DELETE FROM public.notification_sequence_default_steps WHERE purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_message('notification_default_needs_a_step', $$
    DELETE FROM public.notification_sequence_default_steps WHERE purpose = 'intake_reminder'$$));
-- A default inserted without steps is refused. Getting there takes deleting
-- one first, which only works with the delete guard off (rolled back).
SELECT pg_temp.m107_mark('a_default_inserted_without_steps_is_refused',
  pg_temp.m107_expect_message('notification_default_needs_a_step', $$DO $d$ BEGIN
      ALTER TABLE public.notification_sequence_defaults
        DISABLE TRIGGER notification_sequence_defaults_no_delete;
      DELETE FROM public.notification_sequence_defaults WHERE purpose = 'followup_digest';
      INSERT INTO public.notification_sequence_defaults (purpose, digest_cc_allowed)
      VALUES ('followup_digest', false);
    END $d$ $$));
-- A default is never deleted, even by the owner: every org would lose it.
SELECT pg_temp.m107_mark('owner_cannot_delete_a_default', pg_temp.m107_expect_message(
  'notification_default_cannot_be_deleted',
  $$DELETE FROM public.notification_sequence_defaults WHERE purpose = 'followup_digest'$$));
SELECT pg_temp.m107_mark('defaults_still_complete_after_the_probes',
  (SELECT count(*) = 3 FROM public.notification_sequence_default_steps
    WHERE purpose = 'intake_reminder')
  AND (SELECT count(*) = 1 FROM public.notification_sequence_default_steps
        WHERE purpose = 'followup_digest')
  AND (SELECT count(*) = 2 FROM public.notification_sequence_defaults)
  AND (SELECT tgenabled = 'O' FROM pg_trigger
        WHERE tgname = 'notification_sequence_defaults_no_delete'));
SELECT pg_temp.m107_mark('no_row_means_off',
  NOT EXISTS (SELECT 1 FROM public.notification_sequences
               WHERE org_id = '10700000-0000-4000-a000-00000000000b'));

-- ---------------------------------------------------------------------------
-- Minted (service_role) sets the platform-managed settings: an org's digest
-- schedule, on/off, and the defaults themselves. An admin's later save
-- leaves Minted's settings alone.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;
UPDATE public.notification_sequences
   SET send_hour = 6, send_time_zone = 'America/New_York'
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest';
-- A9: Minted switches org A's intake reminders on.
UPDATE public.notification_sequences SET enabled = true
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder';
SELECT pg_temp.m107_mark('service_role_writes_platform_settings',
  (SELECT send_hour = 6 AND send_time_zone = 'America/New_York'
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest')
  AND (SELECT enabled FROM public.notification_sequences
        WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder')
  AND pg_temp.m107_probe(
    $$UPDATE public.notification_sequence_defaults SET target_days_to_ready = 15
       WHERE purpose = 'intake_reminder'$$,
    $$SELECT target_days_to_ready = 15 FROM public.notification_sequence_defaults
       WHERE purpose = 'intake_reminder'$$));
-- G2: an org's digest is set up when Minted writes its whole schedule; until
-- then it has none (org B has no row at all). A partial schedule is refused.
SELECT pg_temp.m107_mark('minted_sets_up_an_orgs_digest_schedule_whole',
  pg_temp.m107_probe(
    $$INSERT INTO public.notification_sequences
        (org_id, purpose, digest_frequency, digest_weekday, send_hour, send_time_zone,
         second_send_hour)
      VALUES ('10700000-0000-4000-a000-00000000000b', 'followup_digest', 'twice_daily', 1, 9,
              'America/Denver', 15)$$,
    $$SELECT NOT enabled AND digest_frequency = 'twice_daily' AND send_hour = 9
             AND send_time_zone = 'America/Denver' AND second_send_hour = 15
             AND digest_weekday = 1 AND revision = 1
        FROM public.notification_sequences
       WHERE org_id = '10700000-0000-4000-a000-00000000000b' AND purpose = 'followup_digest'$$)
  AND pg_temp.m107_expect_message('notification_sequences_digest_schedule_check',
    $$INSERT INTO public.notification_sequences
        (org_id, purpose, send_hour, send_time_zone, second_send_hour)
      VALUES ('10700000-0000-4000-a000-00000000000b', 'followup_digest', 8, 'America/Chicago', 14)$$)
  AND NOT EXISTS (SELECT 1 FROM public.notification_sequences
                   WHERE org_id = '10700000-0000-4000-a000-00000000000b'));
-- A change by Minted to its own settings alone is not an edit of the org's:
-- the revision and the author of the org's settings stay, so an admin editing
-- now is not told someone else saved.
SELECT pg_temp.m107_mark('platform_only_change_keeps_the_org_revision_and_author',
  (SELECT revision = 7 AND updated_by = '10700000-0000-4000-a000-000000000001'
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder')
  AND (SELECT revision = 1 FROM public.notification_sequences
        WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'));
-- The bounce step is the org's, so a Minted write that changes it with a
-- platform setting is an edit of the org's settings: it bumps the revision.
SELECT pg_temp.m107_mark('minted_change_with_the_bounce_step_bumps_the_revision',
  pg_temp.m107_probe(
    $$UPDATE public.notification_sequences
         SET enabled = false, bounce_escalation_step = 2
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$,
    $$SELECT revision = 8 AND updated_by IS NULL AND bounce_escalation_step = 2
        FROM public.notification_sequences
       WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder'$$));
-- Nor can Minted delete a default, though service_role holds DELETE.
SELECT pg_temp.m107_mark('service_role_cannot_delete_a_default', pg_temp.m107_expect_message(
  'notification_default_cannot_be_deleted',
  $$DELETE FROM public.notification_sequence_defaults$$));
SELECT pg_temp.m107_mark('both_defaults_remain',
  (SELECT count(*) = 2 FROM public.notification_sequence_defaults)
  AND (SELECT count(*) = 4 FROM public.notification_sequence_default_steps));
-- Addendum 10: Minted sets the org's digest frequency, as it sets the send
-- time. A platform-only change: the revision and the author stay.
UPDATE public.notification_sequences SET digest_frequency = 'weekly'
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest';
SELECT pg_temp.m107_mark('minted_sets_the_orgs_digest_frequency',
  (SELECT digest_frequency = 'weekly' AND revision = 1
          AND updated_by = '10700000-0000-4000-a000-000000000001'
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'));

SET LOCAL ROLE authenticated;
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000001');
-- Save 7 (intake) and save 8 (digest), each at its current revision.
SELECT public.save_notification_sequence(
  '10700000-0000-4000-a000-00000000000a', 'intake_reminder',
  pg_temp.m107_intake('{3,9}', (SELECT revision FROM public.notification_sequences
                                 WHERE org_id = '10700000-0000-4000-a000-00000000000a'
                                   AND purpose = 'intake_reminder')));
SELECT public.save_notification_sequence(
  '10700000-0000-4000-a000-00000000000a', 'followup_digest',
  pg_temp.m107_digest((SELECT revision FROM public.notification_sequences
                        WHERE org_id = '10700000-0000-4000-a000-00000000000a'
                          AND purpose = 'followup_digest')));
SELECT pg_temp.m107_mark('admin_save_keeps_the_platform_overrides',
  -- A9: an admin's save never touches Minted's on/off.
  (SELECT enabled AND revision = 8
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'intake_reminder')
  -- Addendum 10: nor the frequency Minted set.
  AND (SELECT send_hour = 6 AND send_time_zone = 'America/New_York' AND revision = 2
              AND digest_frequency = 'weekly'
              AND updated_by = '10700000-0000-4000-a000-000000000001'
         FROM public.notification_sequences
        WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest'));

-- ---------------------------------------------------------------------------
-- D59 as Minted's setting: digest_cc_allowed on the digest default. While it
-- is false (seeded) the RPC and a direct write refuse a digest cc (asserted
-- above). Minted turns it on, as Mission Control will (MINT-113): the same
-- writes go through (probes, rolled back). Minted turns it off again: refused.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;
UPDATE public.notification_sequence_defaults SET digest_cc_allowed = true
 WHERE purpose = 'followup_digest';
SET LOCAL ROLE authenticated;
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000001');
SELECT pg_temp.m107_mark('digest_cc_saved_once_minted_allows_it',
  pg_temp.m107_probe(
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(2, '[{"kind":"role","role":"specialist"}]'))$$,
    $$SELECT cc_recipients = '[{"kind":"role","role":"specialist"}]'::jsonb
        FROM public.notification_sequence_steps
       WHERE org_id = '10700000-0000-4000-a000-00000000000a'
         AND template_key = 'followup_digest_daily'$$));
SELECT pg_temp.m107_mark('direct_digest_cc_allowed_once_minted_allows_it',
  pg_temp.m107_probe(
    $$UPDATE public.notification_sequence_steps SET cc_recipients = '[{"kind":"role","role":"admin"}]'
       WHERE org_id = '10700000-0000-4000-a000-00000000000a'
         AND template_key = 'followup_digest_daily'$$,
    $$SELECT cc_recipients = '[{"kind":"role","role":"admin"}]'::jsonb
        FROM public.notification_sequence_steps
       WHERE org_id = '10700000-0000-4000-a000-00000000000a'
         AND template_key = 'followup_digest_daily'$$));
SET LOCAL ROLE service_role;
UPDATE public.notification_sequence_defaults SET digest_cc_allowed = false
 WHERE purpose = 'followup_digest';
SET LOCAL ROLE authenticated;
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000001');
SELECT pg_temp.m107_mark('digest_cc_refused_again_once_minted_turns_it_off',
  pg_temp.m107_expect_message('notification_digest_has_no_cc',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(2, '[{"kind":"role","role":"specialist"}]'))$$)
  AND pg_temp.m107_expect_message('notification_digest_has_no_cc',
    $$UPDATE public.notification_sequence_steps SET cc_recipients = '[{"kind":"role","role":"admin"}]'
       WHERE org_id = '10700000-0000-4000-a000-00000000000a'
         AND template_key = 'followup_digest_daily'$$));
SELECT pg_temp.m107_mark('digest_audience_back_to_coordinators_only',
  (SELECT digest_cc_allowed = false FROM public.notification_sequence_defaults
    WHERE purpose = 'followup_digest')
  AND (SELECT revision = 2 AND bool_and(st.cc_recipients = '[]'::jsonb)
         FROM public.notification_sequences AS s
         JOIN public.notification_sequence_steps AS st ON st.sequence_id = s.id
        WHERE s.org_id = '10700000-0000-4000-a000-00000000000a' AND s.purpose = 'followup_digest'
        GROUP BY s.revision));

-- The same setting per org (S7): Minted sets an override on org A's row.
-- It is a platform-only change, so the org's revision and author stay.
SET LOCAL ROLE service_role;
UPDATE public.notification_sequences SET digest_cc_allowed = true
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest';
SELECT pg_temp.m107_mark('org_digest_cc_override_keeps_the_revision_and_author',
  (SELECT digest_cc_allowed AND revision = 2
          AND updated_by = '10700000-0000-4000-a000-000000000001'
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest')
  AND (SELECT digest_cc_allowed = false FROM public.notification_sequence_defaults
        WHERE purpose = 'followup_digest'));
SET LOCAL ROLE authenticated;
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000001');
SELECT pg_temp.m107_mark('digest_cc_saved_under_the_orgs_override',
  pg_temp.m107_probe(
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(2, '[{"kind":"role","role":"specialist"}]'))$$,
    $$SELECT st.cc_recipients = '[{"kind":"role","role":"specialist"}]'::jsonb
             AND s.digest_cc_allowed
        FROM public.notification_sequence_steps AS st
        JOIN public.notification_sequences AS s ON s.id = st.sequence_id
       WHERE s.org_id = '10700000-0000-4000-a000-00000000000a'
         AND s.purpose = 'followup_digest'$$)
  AND pg_temp.m107_probe(
    $$UPDATE public.notification_sequence_steps SET cc_recipients = '[{"kind":"role","role":"admin"}]'
       WHERE org_id = '10700000-0000-4000-a000-00000000000a'
         AND template_key = 'followup_digest_daily'$$,
    $$SELECT cc_recipients = '[{"kind":"role","role":"admin"}]'::jsonb
        FROM public.notification_sequence_steps
       WHERE org_id = '10700000-0000-4000-a000-00000000000a'
         AND template_key = 'followup_digest_daily'$$));
-- Org B inherits Minted's default (off): its digest still refuses a cc.
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000004');
SELECT pg_temp.m107_mark('another_orgs_digest_still_refuses_cc',
  pg_temp.m107_expect_message('notification_digest_has_no_cc',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000b',
        'followup_digest', pg_temp.m107_digest(NULL, '[{"kind":"role","role":"admin"}]'))$$));
-- An org override off wins over a default that allows a cc.
SET LOCAL ROLE service_role;
UPDATE public.notification_sequence_defaults SET digest_cc_allowed = true
 WHERE purpose = 'followup_digest';
UPDATE public.notification_sequences SET digest_cc_allowed = false
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest';
SET LOCAL ROLE authenticated;
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000001');
SELECT pg_temp.m107_mark('org_override_off_beats_a_default_that_allows_cc',
  pg_temp.m107_expect_message('notification_digest_has_no_cc',
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(2, '[{"kind":"role","role":"specialist"}]'))$$)
  AND pg_temp.m107_expect_message('notification_digest_has_no_cc',
    $$UPDATE public.notification_sequence_steps SET cc_recipients = '[{"kind":"role","role":"admin"}]'
       WHERE org_id = '10700000-0000-4000-a000-00000000000a'
         AND template_key = 'followup_digest_daily'$$));
-- Back to inheriting Minted's default (off).
SET LOCAL ROLE service_role;
UPDATE public.notification_sequences SET digest_cc_allowed = NULL
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest';
UPDATE public.notification_sequence_defaults SET digest_cc_allowed = false
 WHERE purpose = 'followup_digest';
SELECT pg_temp.m107_mark('org_digest_cc_back_to_inherit',
  (SELECT digest_cc_allowed IS NULL AND revision = 2
     FROM public.notification_sequences
    WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest')
  AND (SELECT digest_cc_allowed = false FROM public.notification_sequence_defaults
        WHERE purpose = 'followup_digest'));

-- A digest cc list stored while the setting was on is inert once it goes off
-- (review, Oct 31): writes that leave it alone pass, a write that sets one is
-- refused, and the next save clears it. Set up as Minted: on, store, off.
UPDATE public.notification_sequences SET digest_cc_allowed = true
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest';
UPDATE public.notification_sequence_steps SET cc_recipients = '[{"kind":"role","role":"specialist"}]'
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND template_key = 'followup_digest_daily';
UPDATE public.notification_sequences SET digest_cc_allowed = NULL
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND purpose = 'followup_digest';
SET LOCAL ROLE authenticated;
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000001');
SELECT pg_temp.m107_mark('stored_digest_cc_is_inert_after_the_setting_goes_off',
  pg_temp.m107_probe(
    $$UPDATE public.notification_sequence_steps SET offset_days = 0
       WHERE org_id = '10700000-0000-4000-a000-00000000000a'
         AND template_key = 'followup_digest_daily'$$,
    $$SELECT cc_recipients = '[{"kind":"role","role":"specialist"}]'::jsonb
        FROM public.notification_sequence_steps
       WHERE org_id = '10700000-0000-4000-a000-00000000000a'
         AND template_key = 'followup_digest_daily'$$)
  AND pg_temp.m107_expect_message('notification_digest_has_no_cc',
    $$UPDATE public.notification_sequence_steps SET cc_recipients = '[{"kind":"role","role":"admin"}]'
       WHERE org_id = '10700000-0000-4000-a000-00000000000a'
         AND template_key = 'followup_digest_daily'$$));
SELECT pg_temp.m107_mark('a_save_clears_a_stale_digest_cc',
  pg_temp.m107_probe(
    $$SELECT public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(2))$$,
    $$SELECT cc_recipients = '[]'::jsonb
        FROM public.notification_sequence_steps
       WHERE org_id = '10700000-0000-4000-a000-00000000000a'
         AND template_key = 'followup_digest_daily'$$));
SET LOCAL ROLE service_role;
UPDATE public.notification_sequence_steps SET cc_recipients = '[]'
 WHERE org_id = '10700000-0000-4000-a000-00000000000a' AND template_key = 'followup_digest_daily';
SELECT pg_temp.m107_mark('stale_digest_cc_cleaned_up_without_a_revision',
  (SELECT st.cc_recipients = '[]'::jsonb AND s.revision = 2 AND s.digest_cc_allowed IS NULL
     FROM public.notification_sequence_steps AS st
     JOIN public.notification_sequences AS s ON s.id = st.sequence_id
    WHERE s.org_id = '10700000-0000-4000-a000-00000000000a' AND s.purpose = 'followup_digest'));
RESET ROLE;

-- No digest default at all (a broken database) reads as "no cc", for the RPC
-- and for a direct write. Getting there takes deleting the default with its
-- delete guard off, as the owner; both probes roll back. The caller is still
-- org A's admin (request.jwt.claim.sub), which the RPC checks.
SELECT pg_temp.m107_mark('a_missing_digest_default_refuses_digest_cc',
  pg_temp.m107_expect_message('notification_digest_has_no_cc', $$DO $d$ BEGIN
      ALTER TABLE public.notification_sequence_defaults
        DISABLE TRIGGER notification_sequence_defaults_no_delete;
      DELETE FROM public.notification_sequence_defaults WHERE purpose = 'followup_digest';
      PERFORM public.save_notification_sequence('10700000-0000-4000-a000-00000000000a',
        'followup_digest', pg_temp.m107_digest(2, '[{"kind":"role","role":"specialist"}]'));
    END $d$ $$)
  AND pg_temp.m107_expect_message('notification_digest_has_no_cc', $$DO $d$ BEGIN
      ALTER TABLE public.notification_sequence_defaults
        DISABLE TRIGGER notification_sequence_defaults_no_delete;
      DELETE FROM public.notification_sequence_defaults WHERE purpose = 'followup_digest';
      UPDATE public.notification_sequence_steps
         SET cc_recipients = '[{"kind":"role","role":"admin"}]'
       WHERE org_id = '10700000-0000-4000-a000-00000000000a'
         AND template_key = 'followup_digest_daily';
    END $d$ $$));
SELECT pg_temp.m107_mark('defaults_intact_after_the_missing_default_probes',
  (SELECT count(*) = 2 FROM public.notification_sequence_defaults)
  AND (SELECT count(*) = 1 FROM public.notification_sequence_default_steps
        WHERE purpose = 'followup_digest')
  AND (SELECT tgenabled = 'O' FROM pg_trigger
        WHERE tgname = 'notification_sequence_defaults_no_delete'));

-- ---------------------------------------------------------------------------
-- sms_consents.

-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;
INSERT INTO public.sms_consents
  (id, org_id, provider_id, phone_e164, source, consent_text_version)
VALUES ('10700000-0000-4000-a000-0000000c0001', '10700000-0000-4000-a000-00000000000a',
        '10700000-0000-4000-a000-0000000a0001', '+15555550123', 'intake_form', 'sms-consent.v1');
SELECT pg_temp.m107_mark('service_role_records_consent',
  EXISTS (SELECT 1 FROM public.sms_consents WHERE id = '10700000-0000-4000-a000-0000000c0001'));
SELECT pg_temp.m107_mark('consent_phone_must_be_e164', pg_temp.m107_expect_state('23514', $$
  INSERT INTO public.sms_consents (org_id, provider_id, phone_e164, source, consent_text_version)
  VALUES ('10700000-0000-4000-a000-00000000000a', '10700000-0000-4000-a000-0000000a0001',
          '555-555-0123', 'intake_form', 'sms-consent.v1')$$));
SELECT pg_temp.m107_mark('consent_source_is_closed', pg_temp.m107_expect_state('23514', $$
  INSERT INTO public.sms_consents (org_id, provider_id, phone_e164, source, consent_text_version)
  VALUES ('10700000-0000-4000-a000-00000000000a', '10700000-0000-4000-a000-0000000a0001',
          '+15555550199', 'guessed', 'sms-consent.v1')$$));
SELECT pg_temp.m107_mark('staff_recorded_consent_needs_the_recorder',
  pg_temp.m107_expect_state('23514', $$
    INSERT INTO public.sms_consents (org_id, provider_id, phone_e164, source, consent_text_version)
    VALUES ('10700000-0000-4000-a000-00000000000a', '10700000-0000-4000-a000-0000000a0001',
            '+15555550188', 'staff_recorded', 'sms-consent.v1')$$));
-- With the recorder it is saved, and stays: provider A now has a live consent
-- for +15555550188 as well, which the counts below include.
INSERT INTO public.sms_consents
  (org_id, provider_id, phone_e164, source, consent_text_version, recorded_by)
VALUES ('10700000-0000-4000-a000-00000000000a', '10700000-0000-4000-a000-0000000a0001',
        '+15555550188', 'staff_recorded', 'sms-consent.v1',
        '10700000-0000-4000-a000-000000000001');
SELECT pg_temp.m107_mark('staff_recorded_consent_with_the_recorder_is_saved',
  EXISTS (SELECT 1 FROM public.sms_consents
           WHERE provider_id = '10700000-0000-4000-a000-0000000a0001'
             AND phone_e164 = '+15555550188' AND source = 'staff_recorded'
             AND recorded_by = '10700000-0000-4000-a000-000000000001'
             AND revoked_at IS NULL));
SELECT pg_temp.m107_mark('consent_provider_must_be_in_org', pg_temp.m107_expect_state('23503', $$
  INSERT INTO public.sms_consents (org_id, provider_id, phone_e164, source, consent_text_version)
  VALUES ('10700000-0000-4000-a000-00000000000a', '10700000-0000-4000-a000-0000000b0001',
          '+15555550199', 'intake_form', 'sms-consent.v1')$$));
SELECT pg_temp.m107_mark('one_live_consent_per_number', pg_temp.m107_expect_state('23505', $$
  INSERT INTO public.sms_consents (org_id, provider_id, phone_e164, source, consent_text_version)
  VALUES ('10700000-0000-4000-a000-00000000000a', '10700000-0000-4000-a000-0000000a0001',
          '+15555550123', 'sms_keyword', 'sms-consent.v1')$$));
SELECT pg_temp.m107_mark('consent_evidence_is_immutable', pg_temp.m107_expect_message(
  'sms_consent_immutable', $$
  UPDATE public.sms_consents SET phone_e164 = '+15555550124'
   WHERE id = '10700000-0000-4000-a000-0000000c0001'$$));
SELECT pg_temp.m107_mark('revocation_needs_both_columns', pg_temp.m107_expect_state('23514', $$
  UPDATE public.sms_consents SET revoked_at = now()
   WHERE id = '10700000-0000-4000-a000-0000000c0001'$$));
UPDATE public.sms_consents SET revoked_at = now(), revoked_source = 'sms_stop'
 WHERE id = '10700000-0000-4000-a000-0000000c0001';
SELECT pg_temp.m107_mark('revocation_is_stamped_once',
  (SELECT revoked_source = 'sms_stop' FROM public.sms_consents
    WHERE id = '10700000-0000-4000-a000-0000000c0001')
  AND pg_temp.m107_expect_message('sms_consent_immutable', $$
    UPDATE public.sms_consents SET revoked_source = 'provider_request'
     WHERE id = '10700000-0000-4000-a000-0000000c0001'$$));
INSERT INTO public.sms_consents (org_id, provider_id, phone_e164, source, consent_text_version)
VALUES ('10700000-0000-4000-a000-00000000000a', '10700000-0000-4000-a000-0000000a0001',
        '+15555550123', 'sms_keyword', 'sms-consent.v2');
SELECT pg_temp.m107_mark('consent_can_be_given_again_after_revocation',
  (SELECT count(*) = 2 AND count(*) FILTER (WHERE revoked_at IS NULL) = 1
     FROM public.sms_consents
    WHERE provider_id = '10700000-0000-4000-a000-0000000a0001'
      AND phone_e164 = '+15555550123'));
SELECT pg_temp.m107_mark('service_role_cannot_delete_consent', pg_temp.m107_expect_state('42501', $$
  DELETE FROM public.sms_consents WHERE id = '10700000-0000-4000-a000-0000000c0001'$$));

SET LOCAL ROLE authenticated;
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000003');
SELECT pg_temp.m107_mark('member_reads_own_org_consents',
  (SELECT count(*) = 3 FROM public.sms_consents));
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000004');
SELECT pg_temp.m107_mark('other_org_reads_no_consents',
  (SELECT count(*) = 0 FROM public.sms_consents));
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000001');
SELECT pg_temp.m107_mark('admin_cannot_write_consent', pg_temp.m107_expect_state('42501', $$
  INSERT INTO public.sms_consents (org_id, provider_id, phone_e164, source, consent_text_version)
  VALUES ('10700000-0000-4000-a000-00000000000a', '10700000-0000-4000-a000-0000000a0001',
          '+15555550177', 'staff_recorded', 'sms-consent.v1')$$));
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Consent evidence survives a provider delete (compliance). The provider FK
-- nulls provider_id only (ON DELETE SET NULL (provider_id)); the number, the
-- timestamps, the source, the text version and the revocation stay, and the
-- row gains no copy of the provider's data.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m107_mark('consent_provider_fk_detaches_instead_of_cascading',
  (SELECT c.confdeltype = 'n'
          AND c.confdelsetcols = ARRAY[(
            SELECT a.attnum FROM pg_attribute AS a
             WHERE a.attrelid = 'public.sms_consents'::regclass AND a.attname = 'provider_id'
          )]::int2[]
     FROM pg_constraint AS c
    WHERE c.conrelid = 'public.sms_consents'::regclass
      AND c.conname = 'sms_consents_provider_fkey')
  AND (SELECT is_nullable = 'YES' FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sms_consents'
          AND column_name = 'provider_id')
  AND (SELECT is_nullable = 'NO' FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sms_consents'
          AND column_name = 'org_id'));
SELECT pg_temp.m107_mark('consent_rows_hold_no_provider_details',
  (SELECT array_agg(column_name::text ORDER BY column_name)
          = '{consent_text_version,consented_at,created_at,id,org_id,phone_e164,provider_id,recorded_by,revoked_at,revoked_source,source}'
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sms_consents'));

SET LOCAL ROLE service_role;
SELECT pg_temp.m107_mark('consent_needs_a_provider_on_insert',
  pg_temp.m107_expect_message('sms_consent_needs_a_provider', $$
    INSERT INTO public.sms_consents (org_id, provider_id, phone_e164, source, consent_text_version)
    VALUES ('10700000-0000-4000-a000-00000000000a', NULL, '+15555550144', 'intake_form',
            'sms-consent.v1')$$)
  AND pg_temp.m107_expect_state('23502', $$
    INSERT INTO public.sms_consents (org_id, phone_e164, source, consent_text_version)
    VALUES ('10700000-0000-4000-a000-00000000000a', '+15555550144', 'intake_form',
            'sms-consent.v1')$$));
-- No writer detaches a consent from a provider who still exists, live or revoked.
SELECT pg_temp.m107_mark('consent_cannot_be_detached_while_the_provider_exists',
  pg_temp.m107_expect_message('sms_consent_immutable', $$
    UPDATE public.sms_consents SET provider_id = NULL
     WHERE id = '10700000-0000-4000-a000-0000000c0001'$$)
  AND pg_temp.m107_expect_message('sms_consent_immutable', $$
    UPDATE public.sms_consents SET provider_id = NULL
     WHERE provider_id = '10700000-0000-4000-a000-0000000a0001'
       AND phone_e164 = '+15555550188'$$));
RESET ROLE;

-- Provider C in org A, with one live consent and one revoked one.
INSERT INTO public.providers(id, org_id, first_name, last_name, status) VALUES
  ('10700000-0000-4000-a000-0000000a0002', '10700000-0000-4000-a000-00000000000a',
   'Synthetic', 'Provider C', 'onboarding');
SET LOCAL ROLE service_role;
INSERT INTO public.sms_consents
  (id, org_id, provider_id, phone_e164, source, consent_text_version)
VALUES ('10700000-0000-4000-a000-0000000c0002', '10700000-0000-4000-a000-00000000000a',
        '10700000-0000-4000-a000-0000000a0002', '+15555550166', 'intake_form', 'sms-consent.v1');
INSERT INTO public.sms_consents
  (id, org_id, provider_id, phone_e164, source, consent_text_version, recorded_by)
VALUES ('10700000-0000-4000-a000-0000000c0003', '10700000-0000-4000-a000-00000000000a',
        '10700000-0000-4000-a000-0000000a0002', '+15555550155', 'staff_recorded', 'sms-consent.v1',
        '10700000-0000-4000-a000-000000000001');
UPDATE public.sms_consents SET revoked_at = now(), revoked_source = 'provider_request'
 WHERE id = '10700000-0000-4000-a000-0000000c0003';
RESET ROLE;
-- The hard delete the staging UAT reseed does (as the owner). With the old
-- CASCADE both consent rows went with it.
DELETE FROM public.providers WHERE id = '10700000-0000-4000-a000-0000000a0002';
SELECT pg_temp.m107_mark('consent_evidence_survives_a_provider_delete',
  NOT EXISTS (SELECT 1 FROM public.providers WHERE id = '10700000-0000-4000-a000-0000000a0002')
  AND (SELECT count(*) = 2
              AND bool_and(provider_id IS NULL
                           AND org_id = '10700000-0000-4000-a000-00000000000a'
                           AND consent_text_version = 'sms-consent.v1'
                           AND consented_at = now() AND created_at = now())
              AND count(*) FILTER (
                WHERE id = '10700000-0000-4000-a000-0000000c0002'
                  AND phone_e164 = '+15555550166' AND source = 'intake_form'
                  AND recorded_by IS NULL AND revoked_at IS NULL AND revoked_source IS NULL) = 1
              AND count(*) FILTER (
                WHERE id = '10700000-0000-4000-a000-0000000c0003'
                  AND phone_e164 = '+15555550155' AND source = 'staff_recorded'
                  AND recorded_by = '10700000-0000-4000-a000-000000000001'
                  AND revoked_at = now() AND revoked_source = 'provider_request') = 1
         FROM public.sms_consents
        WHERE id IN ('10700000-0000-4000-a000-0000000c0002',
                     '10700000-0000-4000-a000-0000000c0003')));

-- A detached row is still evidence: nothing else changes, it cannot be
-- re-pointed at another provider, and it cannot be deleted; a STOP from that
-- number can still be recorded on the live one.
SET LOCAL ROLE service_role;
SELECT pg_temp.m107_mark('a_detached_consent_stays_evidence',
  pg_temp.m107_expect_message('sms_consent_immutable', $$
    UPDATE public.sms_consents SET phone_e164 = '+15555550167'
     WHERE id = '10700000-0000-4000-a000-0000000c0002'$$)
  AND pg_temp.m107_expect_message('sms_consent_immutable', $$
    UPDATE public.sms_consents SET provider_id = '10700000-0000-4000-a000-0000000a0001'
     WHERE id = '10700000-0000-4000-a000-0000000c0002'$$)
  AND pg_temp.m107_expect_message('sms_consent_immutable', $$
    UPDATE public.sms_consents SET revoked_source = 'sms_stop'
     WHERE id = '10700000-0000-4000-a000-0000000c0003'$$)
  AND pg_temp.m107_expect_state('42501', $$
    DELETE FROM public.sms_consents WHERE id = '10700000-0000-4000-a000-0000000c0002'$$));
SELECT pg_temp.m107_mark('a_detached_live_consent_can_still_be_revoked',
  pg_temp.m107_probe(
    $$UPDATE public.sms_consents SET revoked_at = now(), revoked_source = 'sms_stop'
       WHERE id = '10700000-0000-4000-a000-0000000c0002'$$,
    $$SELECT revoked_source = 'sms_stop' AND provider_id IS NULL
        FROM public.sms_consents WHERE id = '10700000-0000-4000-a000-0000000c0002'$$));
SET LOCAL ROLE authenticated;
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000003');
SELECT pg_temp.m107_mark('members_still_read_the_detached_consents',
  (SELECT count(*) = 2 FROM public.sms_consents WHERE provider_id IS NULL));
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000004');
SELECT pg_temp.m107_mark('other_org_reads_no_detached_consents',
  (SELECT count(*) = 0 FROM public.sms_consents));
RESET ROLE;

-- The FK action runs as the table owner, not as the deleting role: even with
-- UPDATE on sms_consents revoked, service_role's provider delete detaches the
-- consent (probe, rolled back; the grant is restored after).
INSERT INTO public.providers(id, org_id, first_name, last_name, status) VALUES
  ('10700000-0000-4000-a000-0000000a0003', '10700000-0000-4000-a000-00000000000a',
   'Synthetic', 'Provider D', 'onboarding');
SET LOCAL ROLE service_role;
INSERT INTO public.sms_consents
  (id, org_id, provider_id, phone_e164, source, consent_text_version)
VALUES ('10700000-0000-4000-a000-0000000c0004', '10700000-0000-4000-a000-00000000000a',
        '10700000-0000-4000-a000-0000000a0003', '+15555550133', 'intake_form', 'sms-consent.v1');
RESET ROLE;
REVOKE UPDATE ON TABLE public.sms_consents FROM service_role;
SET LOCAL ROLE service_role;
SELECT pg_temp.m107_mark('service_role_provider_delete_detaches_through_the_owner',
  NOT has_table_privilege('service_role', 'public.sms_consents', 'UPDATE')
  AND pg_temp.m107_probe(
    $$DELETE FROM public.providers WHERE id = '10700000-0000-4000-a000-0000000a0003'$$,
    $$SELECT provider_id IS NULL AND phone_e164 = '+15555550133' AND revoked_at IS NULL
        FROM public.sms_consents WHERE id = '10700000-0000-4000-a000-0000000c0004'$$));
RESET ROLE;
GRANT UPDATE ON TABLE public.sms_consents TO service_role;

-- ---------------------------------------------------------------------------
-- D5: consent evidence survives an org delete. A BEFORE DELETE trigger copies
-- each deleted consent row to sms_consent_archive (org_id a plain uuid, no
-- foreign key), whatever deletes it. RLS is forced there with no policies,
-- and only service_role holds a grant (SELECT).
-- ---------------------------------------------------------------------------
SELECT pg_temp.m107_mark('consent_archive_is_forced_rls_and_service_role_read_only',
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
    WHERE oid = 'public.sms_consent_archive'::regclass)
  AND NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = 'sms_consent_archive')
  AND has_table_privilege('service_role', 'public.sms_consent_archive', 'SELECT')
  AND NOT has_table_privilege('service_role', 'public.sms_consent_archive', 'INSERT')
  AND NOT has_table_privilege('service_role', 'public.sms_consent_archive', 'UPDATE')
  AND NOT has_table_privilege('service_role', 'public.sms_consent_archive', 'DELETE')
  AND NOT has_any_column_privilege('authenticated', 'public.sms_consent_archive', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.sms_consent_archive', 'DELETE')
  -- org_id is a plain uuid: no foreign key can take the row with the org.
  AND NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.sms_consent_archive'::regclass AND contype = 'f')
  -- The consent row's own columns, and when it was archived.
  AND (SELECT array_agg(column_name::text ORDER BY column_name)
              = '{archived_at,consent_text_version,consented_at,created_at,id,org_id,phone_e164,provider_id,recorded_by,revoked_at,revoked_source,source}'
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sms_consent_archive')
  -- A row-level BEFORE DELETE trigger (tgtype 1 row + 2 before + 8 delete),
  -- SECURITY DEFINER with an empty search_path.
  AND (SELECT count(*) = 1 FROM pg_trigger
        WHERE tgrelid = 'public.sms_consents'::regclass
          AND tgname = 'sms_consents_archive_before_delete'
          AND tgtype = 11 AND NOT tgisinternal)
  AND (SELECT p.prosecdef
              AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c
                           WHERE c IN ('search_path=""', 'search_path='))
         FROM pg_proc AS p
        WHERE p.oid = 'private.sms_consents_archive_before_delete()'::regprocedure));

-- Org C: one provider with a live consent and a revoked one. It is deleted
-- as the owner the way a synthetic org is cleaned up (no app path deletes an
-- org): its provider first (providers_org_id_fkey does not cascade, and that
-- delete detaches the consents), its seeded roster templates with their
-- guard off, then the org, whose FK cascades to the consents. Each consent is
-- archived before it goes.
INSERT INTO public.organizations(id, name) VALUES
  ('10700000-0000-4000-a000-00000000000c', 'MINT-107 Synthetic Org C');
INSERT INTO public.providers(id, org_id, first_name, last_name, status) VALUES
  ('10700000-0000-4000-a000-0000000c1001', '10700000-0000-4000-a000-00000000000c',
   'Synthetic', 'Provider E', 'onboarding');
SET LOCAL ROLE service_role;
INSERT INTO public.sms_consents
  (id, org_id, provider_id, phone_e164, source, consent_text_version)
VALUES ('10700000-0000-4000-a000-0000000c0005', '10700000-0000-4000-a000-00000000000c',
        '10700000-0000-4000-a000-0000000c1001', '+15555550111', 'intake_form', 'sms-consent.v1');
INSERT INTO public.sms_consents
  (id, org_id, provider_id, phone_e164, source, consent_text_version, recorded_by)
VALUES ('10700000-0000-4000-a000-0000000c0006', '10700000-0000-4000-a000-00000000000c',
        '10700000-0000-4000-a000-0000000c1001', '+15555550112', 'staff_recorded', 'sms-consent.v2',
        '10700000-0000-4000-a000-000000000001');
UPDATE public.sms_consents SET revoked_at = now(), revoked_source = 'sms_stop'
 WHERE id = '10700000-0000-4000-a000-0000000c0006';
SELECT pg_temp.m107_mark('nothing_archived_before_a_delete',
  NOT EXISTS (SELECT 1 FROM public.sms_consent_archive));
RESET ROLE;
DELETE FROM public.providers WHERE id = '10700000-0000-4000-a000-0000000c1001';
ALTER TABLE public.roster_templates DISABLE TRIGGER USER;
DELETE FROM public.roster_templates WHERE org_id = '10700000-0000-4000-a000-00000000000c';
ALTER TABLE public.roster_templates ENABLE TRIGGER USER;
DELETE FROM public.organizations WHERE id = '10700000-0000-4000-a000-00000000000c';
SET LOCAL ROLE service_role;
SELECT pg_temp.m107_mark('an_org_delete_leaves_its_consents_in_the_archive',
  NOT EXISTS (SELECT 1 FROM public.organizations
               WHERE id = '10700000-0000-4000-a000-00000000000c')
  AND NOT EXISTS (SELECT 1 FROM public.sms_consents
                   WHERE org_id = '10700000-0000-4000-a000-00000000000c')
  -- The evidence as it was, detached from the provider deleted before it.
  AND (SELECT count(*) = 2
              AND bool_and(org_id = '10700000-0000-4000-a000-00000000000c'
                           AND provider_id IS NULL
                           AND consented_at = now() AND created_at = now()
                           AND archived_at = now())
              AND count(*) FILTER (
                WHERE id = '10700000-0000-4000-a000-0000000c0005'
                  AND phone_e164 = '+15555550111' AND source = 'intake_form'
                  AND consent_text_version = 'sms-consent.v1' AND recorded_by IS NULL
                  AND revoked_at IS NULL AND revoked_source IS NULL) = 1
              AND count(*) FILTER (
                WHERE id = '10700000-0000-4000-a000-0000000c0006'
                  AND phone_e164 = '+15555550112' AND source = 'staff_recorded'
                  AND consent_text_version = 'sms-consent.v2'
                  AND recorded_by = '10700000-0000-4000-a000-000000000001'
                  AND revoked_at = now() AND revoked_source = 'sms_stop') = 1
         FROM public.sms_consent_archive)
  -- Org A's consents are untouched.
  AND (SELECT count(*) = 6 FROM public.sms_consents
        WHERE org_id = '10700000-0000-4000-a000-00000000000a'));
RESET ROLE;
-- Any other delete is archived too (as the owner; probe, rolled back).
SELECT pg_temp.m107_mark('any_consent_delete_is_archived',
  pg_temp.m107_probe(
    $$DELETE FROM public.sms_consents WHERE id = '10700000-0000-4000-a000-0000000c0001'$$,
    $$SELECT count(*) = 1 FROM public.sms_consent_archive
       WHERE id = '10700000-0000-4000-a000-0000000c0001'
         AND org_id = '10700000-0000-4000-a000-00000000000a'
         AND provider_id = '10700000-0000-4000-a000-0000000a0001'
         AND revoked_source = 'sms_stop'$$));
-- Members read their org's consents, never the archive, admins included.
SET LOCAL ROLE authenticated;
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000003');
SELECT pg_temp.m107_mark('members_cannot_read_the_archive',
  pg_temp.m107_expect_state('42501', $$SELECT count(*) FROM public.sms_consent_archive$$)
  AND (SELECT count(*) > 0 FROM public.sms_consents));
SELECT pg_temp.m107_as('10700000-0000-4000-a000-000000000001');
SELECT pg_temp.m107_mark('admins_cannot_read_or_write_the_archive',
  pg_temp.m107_expect_state('42501', $$SELECT 1 FROM public.sms_consent_archive$$)
  AND pg_temp.m107_expect_state('42501',
    $$DELETE FROM public.sms_consent_archive
       WHERE org_id = '10700000-0000-4000-a000-00000000000c'$$));
RESET ROLE;


-- ---------------------------------------------------------------------------
-- Audit rows: one per successful save (8: two creates, six updates),
-- attributed to the admin, config only.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m107_mark('each_save_writes_one_attributed_audit_row',
  (SELECT count(*) = 8
      AND bool_and(user_id = '10700000-0000-4000-a000-000000000001')
      AND count(*) FILTER (WHERE action_type = 'CREATE') = 2
      AND count(*) FILTER (WHERE action_type = 'UPDATE') = 6
     FROM public.audit_log
    WHERE org_id = '10700000-0000-4000-a000-00000000000a'
      AND entity_type = 'notification_sequence'));

SELECT name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END
  FROM pg_temp.m107_results ORDER BY name;

DO $$
DECLARE v_failed text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO v_failed
    FROM pg_temp.m107_results WHERE NOT passed;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'MINT-107 notification sequences assertions failed: %', v_failed;
  END IF;
END;
$$;

-- Undo the CI emulation (the ROLLBACK would too; this keeps it explicit).
ALTER ROLE service_role NOBYPASSRLS;
REVOKE USAGE ON SCHEMA auth FROM authenticated, service_role;
ROLLBACK;
\echo MINT-107 notification sequences packet passed.
