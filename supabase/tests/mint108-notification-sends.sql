-- MINT-108 notification_sends packet: claim_notification_send /
-- finish_notification_send and the access boundary of notification_sends
-- (supabase/migrations/20261101100100_notification_sends.sql).
--
-- Run after all migrations in a disposable PostgreSQL database, never against
-- hosted. CI's Migration dry-run job runs it right after the MINT-107 packet:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/mint108-notification-sends.sql
-- Every row it writes is synthetic and rolled back.
--
-- It needs only what that job seeds: a superuser connection (it writes
-- fixtures, reads the table and switches role) and the anon, authenticated
-- and service_role roles, created NOLOGIN with none of Supabase's
-- attributes. So service_role has no BYPASSRLS here, and the packet reads the
-- table only as the superuser. The first block checks these and stops with a
-- plain message.
--
-- Single session. Concurrency rests on notification_sends_pkey, proved here
-- by a direct second insert failing 23505. A check never shares a statement
-- with a call that writes: it would read that statement's snapshot, from
-- before the write.
--
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
    RAISE EXCEPTION 'mint108-notification-sends.sql must run as a superuser';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles
       WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'mint108-notification-sends.sql needs the anon, authenticated and service_role roles';
  END IF;
  IF to_regclass('public.notification_sends') IS NULL
     OR to_regclass('public.organizations') IS NULL
     OR to_regprocedure('public.claim_notification_send(text, text, uuid, uuid)') IS NULL
     OR to_regprocedure('public.finish_notification_send(text, text, uuid, uuid, text)') IS NULL
     OR (SELECT prorettype FROM pg_catalog.pg_proc
          WHERE oid = to_regprocedure('public.claim_notification_send(text, text, uuid, uuid)'))
        <> 'boolean'::regtype THEN
    RAISE EXCEPTION 'mint108-notification-sends.sql runs after supabase/migrations/20261101100100_notification_sends.sql';
  END IF;
END;
$$;

CREATE TEMP TABLE m108_results (name text PRIMARY KEY, passed boolean NOT NULL);
CREATE TEMP TABLE m108_flags (name text PRIMARY KEY, flag boolean);
GRANT ALL ON m108_results TO authenticated, service_role;
GRANT ALL ON m108_flags TO authenticated, service_role;

CREATE FUNCTION pg_temp.m108_mark(p_name text, p_passed boolean) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO pg_temp.m108_results VALUES (p_name, coalesce(p_passed, false))
$$;

CREATE FUNCTION pg_temp.m108_flag(p_name text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT flag FROM pg_temp.m108_flags WHERE name = p_name
$$;

CREATE FUNCTION pg_temp.m108_expect_state(p_state text, p_statement text) RETURNS boolean
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

-- The one row of a key, as (outcome) or NULL.
CREATE FUNCTION pg_temp.m108_outcome(p_slot text, p_org uuid, p_recipient uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT outcome FROM public.notification_sends
   WHERE job = 'followup-digest' AND slot = p_slot
     AND org_id = p_org AND recipient_user_id = p_recipient
$$;

CREATE FUNCTION pg_temp.m108_rows() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM public.notification_sends
   WHERE org_id IN ('10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000a2')
$$;

-- Two synthetic orgs and two recipients (actor ids; no profile needed).
INSERT INTO public.organizations (id, name) VALUES
  ('10800000-0000-4000-a000-0000000000a1', 'MINT-108 packet org A'),
  ('10800000-0000-4000-a000-0000000000a2', 'MINT-108 packet org B');

-- ---------------------------------------------------------------------------
-- Key A: claim, skip while claimed, finish sent, skip after sent.
-- ---------------------------------------------------------------------------
INSERT INTO pg_temp.m108_flags VALUES ('a-claim-1', public.claim_notification_send(
  'followup-digest', '2026-10-31',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1'));
INSERT INTO pg_temp.m108_flags VALUES ('a-claim-2', public.claim_notification_send(
  'followup-digest', '2026-10-31',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1'));

SELECT pg_temp.m108_mark('claim_takes_a_new_key_as_one_claimed_row',
  pg_temp.m108_flag('a-claim-1')
  AND pg_temp.m108_outcome('2026-10-31', '10800000-0000-4000-a000-0000000000a1',
        '10800000-0000-4000-a000-0000000000b1') = 'claimed'
  AND (SELECT claimed_at = now() FROM public.notification_sends
        WHERE slot = '2026-10-31' AND org_id = '10800000-0000-4000-a000-0000000000a1'));
SELECT pg_temp.m108_mark('claim_while_claimed_returns_false_and_writes_nothing',
  pg_temp.m108_flag('a-claim-2') IS FALSE AND pg_temp.m108_rows() = 1);

INSERT INTO pg_temp.m108_flags VALUES ('a-finish-sent', public.finish_notification_send(
  'followup-digest', '2026-10-31',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1', 'sent'));
SELECT pg_temp.m108_mark('finish_records_sent',
  pg_temp.m108_flag('a-finish-sent')
  AND pg_temp.m108_outcome('2026-10-31', '10800000-0000-4000-a000-0000000000a1',
        '10800000-0000-4000-a000-0000000000b1') = 'sent');

INSERT INTO pg_temp.m108_flags VALUES ('a-claim-3', public.claim_notification_send(
  'followup-digest', '2026-10-31',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1'));
INSERT INTO pg_temp.m108_flags VALUES ('a-finish-again', public.finish_notification_send(
  'followup-digest', '2026-10-31',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1', 'failed'));
SELECT pg_temp.m108_mark('claim_after_sent_returns_false_and_writes_nothing',
  pg_temp.m108_flag('a-claim-3') IS FALSE AND pg_temp.m108_rows() = 1);
SELECT pg_temp.m108_mark('finish_on_a_sent_row_returns_false_and_leaves_it_sent',
  pg_temp.m108_flag('a-finish-again') IS FALSE
  AND pg_temp.m108_outcome('2026-10-31', '10800000-0000-4000-a000-0000000000a1',
        '10800000-0000-4000-a000-0000000000b1') = 'sent');

-- Every part of the key is its own send: another slot (a twice-a-day second
-- send), another recipient, another org, another job.
INSERT INTO pg_temp.m108_flags VALUES ('key-slot', public.claim_notification_send(
  'followup-digest', '2026-10-31:2',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1'));
INSERT INTO pg_temp.m108_flags VALUES ('key-recipient', public.claim_notification_send(
  'followup-digest', '2026-10-31',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b2'));
INSERT INTO pg_temp.m108_flags VALUES ('key-org', public.claim_notification_send(
  'followup-digest', '2026-10-31',
  '10800000-0000-4000-a000-0000000000a2', '10800000-0000-4000-a000-0000000000b1'));
INSERT INTO pg_temp.m108_flags VALUES ('key-job', public.claim_notification_send(
  'other-job', '2026-10-31',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1'));
SELECT pg_temp.m108_mark('every_part_of_the_key_is_its_own_send',
  pg_temp.m108_flag('key-slot') AND pg_temp.m108_flag('key-recipient')
  AND pg_temp.m108_flag('key-org') AND pg_temp.m108_flag('key-job')
  AND pg_temp.m108_rows() = 5);

-- ---------------------------------------------------------------------------
-- Key B: a definite rejection marks the row failed, and a later claim takes
-- the same row again; a maybe-delivered send stays claimed.
-- ---------------------------------------------------------------------------
INSERT INTO pg_temp.m108_flags VALUES ('b-claim-1', public.claim_notification_send(
  'followup-digest', '2026-11-01',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1'));
INSERT INTO pg_temp.m108_flags VALUES ('b-finish-failed', public.finish_notification_send(
  'followup-digest', '2026-11-01',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1', 'failed'));
SELECT pg_temp.m108_mark('finish_records_failed',
  pg_temp.m108_flag('b-claim-1') AND pg_temp.m108_flag('b-finish-failed')
  AND pg_temp.m108_outcome('2026-11-01', '10800000-0000-4000-a000-0000000000a1',
        '10800000-0000-4000-a000-0000000000b1') = 'failed');

UPDATE public.notification_sends SET claimed_at = now() - interval '2 hours'
 WHERE slot = '2026-11-01' AND org_id = '10800000-0000-4000-a000-0000000000a1';
INSERT INTO pg_temp.m108_flags VALUES ('b-claim-2', public.claim_notification_send(
  'followup-digest', '2026-11-01',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1'));
SELECT pg_temp.m108_mark('claim_after_failure_takes_the_same_row_again',
  pg_temp.m108_flag('b-claim-2')
  AND (SELECT count(*) FROM public.notification_sends
        WHERE slot = '2026-11-01' AND org_id = '10800000-0000-4000-a000-0000000000a1') = 1
  AND pg_temp.m108_outcome('2026-11-01', '10800000-0000-4000-a000-0000000000a1',
        '10800000-0000-4000-a000-0000000000b1') = 'claimed'
  AND (SELECT claimed_at = now() FROM public.notification_sends
        WHERE slot = '2026-11-01' AND org_id = '10800000-0000-4000-a000-0000000000a1'));

-- No finish: it may have been delivered. However old, it is never claimed again.
UPDATE public.notification_sends SET claimed_at = now() - interval '3 days'
 WHERE slot = '2026-11-01' AND org_id = '10800000-0000-4000-a000-0000000000a1';
INSERT INTO pg_temp.m108_flags VALUES ('b-claim-3', public.claim_notification_send(
  'followup-digest', '2026-11-01',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1'));
SELECT pg_temp.m108_mark('a_claim_left_claimed_is_never_claimed_again_however_old',
  pg_temp.m108_flag('b-claim-3') IS FALSE
  AND pg_temp.m108_outcome('2026-11-01', '10800000-0000-4000-a000-0000000000a1',
        '10800000-0000-4000-a000-0000000000b1') = 'claimed'
  AND (SELECT claimed_at < now() - interval '2 days' FROM public.notification_sends
        WHERE slot = '2026-11-01' AND org_id = '10800000-0000-4000-a000-0000000000a1'));

INSERT INTO pg_temp.m108_flags VALUES ('b-finish-sent', public.finish_notification_send(
  'followup-digest', '2026-11-01',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1', 'sent'));
INSERT INTO pg_temp.m108_flags VALUES ('b-claim-4', public.claim_notification_send(
  'followup-digest', '2026-11-01',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1'));
SELECT pg_temp.m108_mark('a_retried_send_can_be_sent_and_then_holds',
  pg_temp.m108_flag('b-finish-sent') AND pg_temp.m108_flag('b-claim-4') IS FALSE
  AND pg_temp.m108_outcome('2026-11-01', '10800000-0000-4000-a000-0000000000a1',
        '10800000-0000-4000-a000-0000000000b1') = 'sent');

INSERT INTO pg_temp.m108_flags VALUES ('finish-missing', public.finish_notification_send(
  'followup-digest', '2099-01-01',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1', 'sent'));
SELECT pg_temp.m108_mark('finish_on_a_missing_key_returns_false_and_writes_nothing',
  pg_temp.m108_flag('finish-missing') IS FALSE
  AND pg_temp.m108_outcome('2099-01-01', '10800000-0000-4000-a000-0000000000a1',
        '10800000-0000-4000-a000-0000000000b1') IS NULL);

-- ---------------------------------------------------------------------------
-- Refusals.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m108_mark('primary_key_refuses_a_second_row_for_a_key',
  pg_temp.m108_expect_state('23505',
    $$INSERT INTO public.notification_sends (org_id, job, slot, recipient_user_id, outcome)
      VALUES ('10800000-0000-4000-a000-0000000000a1', 'followup-digest', '2026-11-01',
              '10800000-0000-4000-a000-0000000000b1', 'failed')$$));
SELECT pg_temp.m108_mark('claim_refuses_an_invalid_job_name',
  pg_temp.m108_expect_state('23514',
    $$SELECT public.claim_notification_send('Follow Up', '2026-10-31',
        '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1')$$));
SELECT pg_temp.m108_mark('claim_refuses_an_invalid_slot',
  pg_temp.m108_expect_state('23514',
    $$SELECT public.claim_notification_send('followup-digest', 'Jane Doe 1961-04-12',
        '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1')$$));
SELECT pg_temp.m108_mark('claim_refuses_an_unknown_org',
  pg_temp.m108_expect_state('23503',
    $$SELECT public.claim_notification_send('followup-digest', '2026-10-31',
        '10800000-0000-4000-a000-0000000000ff', '10800000-0000-4000-a000-0000000000b1')$$));
SELECT pg_temp.m108_mark('claim_refuses_a_missing_recipient',
  pg_temp.m108_expect_state('23502',
    $$SELECT public.claim_notification_send('followup-digest', '2026-10-31',
        '10800000-0000-4000-a000-0000000000a1', NULL)$$));
SELECT pg_temp.m108_mark('finish_refuses_claimed_as_an_outcome',
  pg_temp.m108_expect_state('22023',
    $$SELECT public.finish_notification_send('followup-digest', '2026-10-31:2',
        '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1',
        'claimed')$$));
SELECT pg_temp.m108_mark('finish_refuses_a_null_or_unknown_outcome',
  pg_temp.m108_expect_state('22023',
    $$SELECT public.finish_notification_send('followup-digest', '2026-10-31:2',
        '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1',
        NULL)$$)
  AND pg_temp.m108_expect_state('22023',
    $$SELECT public.finish_notification_send('followup-digest', '2026-10-31:2',
        '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1',
        'bounced')$$));
SELECT pg_temp.m108_mark('check_refuses_an_unknown_outcome',
  pg_temp.m108_expect_state('23514',
    $$UPDATE public.notification_sends SET outcome = 'bounced'
       WHERE slot = '2026-10-31:2' AND org_id = '10800000-0000-4000-a000-0000000000a1'$$));
SELECT pg_temp.m108_mark('refusals_leave_the_rows_as_they_were',
  pg_temp.m108_rows() = 6
  AND pg_temp.m108_outcome('2026-10-31:2', '10800000-0000-4000-a000-0000000000a1',
        '10800000-0000-4000-a000-0000000000b1') = 'claimed');

-- ---------------------------------------------------------------------------
-- No PHI and no receipt: the key, the outcome and when it was claimed.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m108_mark('table_holds_the_key_the_outcome_and_claimed_at_only',
  (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.notification_sends'::regclass AND attnum > 0 AND NOT attisdropped)
  = ARRAY['org_id', 'job', 'slot', 'recipient_user_id', 'outcome', 'claimed_at']);
-- The primary key leads with org_id, so it also serves the org FK's cascade.
SELECT pg_temp.m108_mark('primary_key_is_the_send_key_and_the_only_index',
  (SELECT array_agg(a.attname::text ORDER BY k.ord)
     FROM pg_catalog.pg_index AS i
     CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_catalog.pg_attribute AS a
       ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE i.indrelid = 'public.notification_sends'::regclass AND i.indisprimary)
  = ARRAY['org_id', 'job', 'slot', 'recipient_user_id']
  AND (SELECT count(*) FROM pg_catalog.pg_index
        WHERE indrelid = 'public.notification_sends'::regclass) = 1);

-- ---------------------------------------------------------------------------
-- Access boundary.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m108_mark('rls_is_enabled_with_no_policy',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.notification_sends'::regclass)
  AND NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'notification_sends'
  ));

SELECT pg_temp.m108_mark('anon_and_authenticated_cannot_touch_the_table',
  NOT has_table_privilege('anon', 'public.notification_sends',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  AND NOT has_table_privilege('authenticated', 'public.notification_sends',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  AND NOT has_table_privilege('public', 'public.notification_sends',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));

SELECT pg_temp.m108_mark('service_role_reads_the_table_and_writes_only_through_the_rpcs',
  has_table_privilege('service_role', 'public.notification_sends', 'SELECT')
  AND NOT has_table_privilege('service_role', 'public.notification_sends',
        'INSERT, UPDATE, DELETE, TRUNCATE'));

SELECT pg_temp.m108_mark('only_service_role_executes_the_rpcs',
  has_function_privilege('service_role',
    'public.claim_notification_send(text, text, uuid, uuid)', 'EXECUTE')
  AND has_function_privilege('service_role',
    'public.finish_notification_send(text, text, uuid, uuid, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.claim_notification_send(text, text, uuid, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.finish_notification_send(text, text, uuid, uuid, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.claim_notification_send(text, text, uuid, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.finish_notification_send(text, text, uuid, uuid, text)', 'EXECUTE')
  AND NOT has_function_privilege('public',
    'public.claim_notification_send(text, text, uuid, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public',
    'public.finish_notification_send(text, text, uuid, uuid, text)', 'EXECUTE'));

SELECT pg_temp.m108_mark('rpcs_are_security_definer_with_an_empty_search_path',
  (SELECT count(*) FROM pg_proc AS p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('claim_notification_send', 'finish_notification_send')
       AND p.prosecdef
       AND EXISTS (
         SELECT 1 FROM unnest(p.proconfig) AS c WHERE c IN ('search_path=""', 'search_path=')
       )) = 2);

SELECT pg_temp.m108_mark('no_ledger_of_runs_or_org_slots_exists',
  to_regclass('public.job_runs') IS NULL
  AND to_regclass('public.notification_org_slots') IS NULL
  AND to_regproc('public.claim_job_run') IS NULL
  AND to_regproc('public.complete_notification_org_slot') IS NULL);

SET LOCAL ROLE service_role;
INSERT INTO pg_temp.m108_flags VALUES ('s-claim', public.claim_notification_send(
  'followup-digest', 'slot-s',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1'));
INSERT INTO pg_temp.m108_flags VALUES ('s-finish', public.finish_notification_send(
  'followup-digest', 'slot-s',
  '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1', 'sent'));
RESET ROLE;
SELECT pg_temp.m108_mark('service_role_can_claim_and_finish',
  pg_temp.m108_flag('s-claim') AND pg_temp.m108_flag('s-finish')
  AND pg_temp.m108_outcome('slot-s', '10800000-0000-4000-a000-0000000000a1',
        '10800000-0000-4000-a000-0000000000b1') = 'sent');

SET LOCAL ROLE authenticated;
SELECT pg_temp.m108_mark('authenticated_cannot_call_the_claim',
  pg_temp.m108_expect_state('42501',
    $$SELECT public.claim_notification_send('followup-digest', 'slot-x',
        '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1')$$));
SELECT pg_temp.m108_mark('authenticated_cannot_call_the_finish',
  pg_temp.m108_expect_state('42501',
    $$SELECT public.finish_notification_send('followup-digest', 'slot-s',
        '10800000-0000-4000-a000-0000000000a1', '10800000-0000-4000-a000-0000000000b1',
        'failed')$$));
SELECT pg_temp.m108_mark('authenticated_cannot_read_the_table',
  pg_temp.m108_expect_state('42501', $$SELECT count(*) FROM public.notification_sends$$));
RESET ROLE;

SELECT name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END
  FROM pg_temp.m108_results ORDER BY name;

DO $$
DECLARE v_failed text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO v_failed
    FROM pg_temp.m108_results WHERE NOT passed;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'MINT-108 notification_sends assertions failed: %', v_failed;
  END IF;
END;
$$;

ROLLBACK;
\echo MINT-108 notification_sends packet passed.
