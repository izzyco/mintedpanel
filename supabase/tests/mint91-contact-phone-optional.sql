-- MINT-91 U8 contact phone packet: a contact saves with its office phone
-- blank, end to end through the database
-- (supabase/migrations/20261101120000_mint91_contact_phone_optional.sql).
--
-- Run after all migrations in a disposable PostgreSQL database, never against
-- hosted. CI's Migration dry-run job runs it after applying them:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/mint91-contact-phone-optional.sql
-- Every row it writes is synthetic and rolled back.
--
-- What it checks:
--   - assert_contact_valid accepts a blank, whitespace, JSON-null or missing
--     phone_office, and still refuses each other required field;
--   - create_organization (5-arg, as an authenticated caller) creates the org
--     with a blank customer phone and stores it as NULL, and an entered sales
--     rep phone is still stored;
--   - submit_capture (as anon) saves a blank phone as NULL and uses the link;
--   - submit_inbound_lead (as anon) saves a blank or missing phone as NULL,
--     still stores an entered one, and still refuses a missing email;
--   - both functions keep their security mode, search_path and grants.
--
-- It needs a superuser connection (fixtures, SET ROLE) and the anon,
-- authenticated and service_role roles. The functions under test are
-- SECURITY DEFINER or called by one, so they read and write as their owner.
--
-- A check reads its statement's snapshot, so a call whose effect is checked
-- runs as its own statement first, never inside the checking statement.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;
-- Hosted Supabase grants authenticated USAGE on the auth schema; CI's plain
-- PostgreSQL seed does not. Mirror the hosted grant inside this rollback-only
-- transaction (the mint19 / mint58 / mint134 precedent).
GRANT USAGE ON SCHEMA auth TO authenticated;
SET LOCAL client_min_messages = warning;

DO $$
BEGIN
  IF NOT coalesce(
    (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), false
  ) THEN
    RAISE EXCEPTION 'mint91-contact-phone-optional.sql must run as a superuser';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles
       WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'mint91-contact-phone-optional.sql needs the anon, authenticated and service_role roles';
  END IF;
  IF to_regprocedure('public.assert_contact_valid(jsonb, text)') IS NULL
     OR to_regprocedure('public.create_organization(text, text, text, jsonb, jsonb)') IS NULL
     OR to_regprocedure('public.submit_capture(text, jsonb)') IS NULL
     OR to_regprocedure('public.submit_inbound_lead(jsonb)') IS NULL
     OR to_regclass('public.public_rpc_attempts') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'mint91-contact-phone-optional.sql runs after supabase/migrations/20261101120000_mint91_contact_phone_optional.sql';
  END IF;
END;
$$;

CREATE TEMP TABLE m91_results (name text PRIMARY KEY, passed boolean NOT NULL);
CREATE TEMP TABLE m91_calls (name text PRIMARY KEY, result text NOT NULL);

CREATE FUNCTION pg_temp.m91_mark(p_name text, p_passed boolean) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO pg_temp.m91_results VALUES (p_name, coalesce(p_passed, false))
$$;

-- The error message p_statement raises, or NULL when it runs cleanly.
CREATE FUNCTION pg_temp.m91_error(p_statement text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_message text;
BEGIN
  BEGIN
    EXECUTE p_statement;
    RETURN NULL;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    RETURN v_message;
  END;
END;
$$;

-- Run p_statement (one SELECT of one value) as p_role, signed in as p_sub
-- (NULL: no auth.uid()), the way PostgREST runs a call from a verified JWT.
-- Returns 'ok:<value>' or 'error:<message>'. The role and the claim end with
-- the call: a failure rolls its block back, and a success resets both. The
-- statement is built as the superuser, so the caller role never reads pg_temp.
CREATE FUNCTION pg_temp.m91_as(p_role text, p_sub uuid, p_statement text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_value text;
  v_message text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE p_statement INTO v_value;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RETURN 'ok:' || coalesce(v_value, '');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    RETURN 'error:' || v_message;
  END;
END;
$$;

-- A complete contact; each case below removes or blanks one key.
CREATE FUNCTION pg_temp.m91_contact() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'name', 'Mint Ninetyone',
    'first_name', 'Mint',
    'last_name', 'Ninetyone',
    'email', 'm91-contact@example.invalid',
    'phone_office', '303-555-0100',
    'address_line1', '1 Synthetic Way',
    'city', 'Denver',
    'state', 'CO',
    'postal_code', '80202'
  )
$$;

INSERT INTO auth.users (id, email) VALUES
  ('39100000-0000-4000-a000-000000000091', 'm91-operator@example.invalid');
INSERT INTO public.profiles (id, full_name, email) VALUES
  ('39100000-0000-4000-a000-000000000091', 'MINT-91 Synthetic Operator',
   'm91-operator@example.invalid');

-- ---------------------------------------------------------------------------
-- 1. assert_contact_valid: the phone is optional, nothing else changed.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m91_mark('helper_accepts_' || c.label,
  pg_temp.m91_error(format(
    'SELECT public.assert_contact_valid(%L::jsonb, %L)', c.contact::text, 'Customer contact'
  )) IS NULL)
  FROM (VALUES
    ('an_entered_phone', pg_temp.m91_contact()),
    ('a_blank_phone', pg_temp.m91_contact() || '{"phone_office": ""}'),
    ('a_whitespace_phone', pg_temp.m91_contact() || '{"phone_office": "   "}'),
    ('a_json_null_phone', pg_temp.m91_contact() || '{"phone_office": null}'),
    ('a_missing_phone', pg_temp.m91_contact() - 'phone_office')
  ) AS c(label, contact);

SELECT pg_temp.m91_mark('helper_still_refuses_' || c.label,
  pg_temp.m91_error(format(
    'SELECT public.assert_contact_valid(%L::jsonb, %L)', c.contact::text, 'Customer contact'
  )) = c.message)
  FROM (VALUES
    ('a_blank_name', pg_temp.m91_contact() || '{"name": ""}',
     'Customer contact name is required'),
    ('a_missing_email', pg_temp.m91_contact() - 'email',
     'Customer contact email is required'),
    ('an_invalid_email', pg_temp.m91_contact() || '{"email": "not-an-email"}',
     'Customer contact email is not valid'),
    ('a_blank_street', pg_temp.m91_contact() || '{"address_line1": " "}',
     'Customer contact street address is required'),
    ('a_blank_city', pg_temp.m91_contact() || '{"city": ""}',
     'Customer contact city is required'),
    ('a_blank_state', pg_temp.m91_contact() - 'state',
     'Customer contact state is required'),
    ('a_blank_postal_code', pg_temp.m91_contact() || '{"postal_code": ""}',
     'Customer contact postal code is required')
  ) AS c(label, contact, message);

-- ---------------------------------------------------------------------------
-- 2. create_organization (5-arg) as an authenticated caller: a blank customer
--    phone saves as NULL; an entered sales rep phone is still stored.
-- ---------------------------------------------------------------------------
INSERT INTO pg_temp.m91_calls
SELECT c.name, pg_temp.m91_as('authenticated', '39100000-0000-4000-a000-000000000091', format(
         'SELECT public.create_organization(%L, %L, %L, %L::jsonb, %L::jsonb)',
         c.org_name, 'Owner Synthetic', 'm91-owner@example.invalid',
         c.customer::text, c.sales_rep::text))
  FROM (VALUES
    ('create_org_blank_customer_phone', 'MINT-91 Synthetic Organization',
     pg_temp.m91_contact() || '{"phone_office": ""}',
     pg_temp.m91_contact()
       || '{"email": "m91-rep@example.invalid", "phone_office": " 303-555-0177 "}'),
    ('create_org_blank_city', 'MINT-91 Synthetic Refused Organization',
     pg_temp.m91_contact() || '{"phone_office": "", "city": ""}', NULL)
  ) AS c(name, org_name, customer, sales_rep);

SELECT pg_temp.m91_mark('create_org_with_a_blank_customer_phone_succeeds',
  (SELECT result LIKE 'ok:%' FROM pg_temp.m91_calls WHERE name = 'create_org_blank_customer_phone'));

SELECT pg_temp.m91_mark('create_org_saves_a_blank_customer_phone_as_null',
  EXISTS (
    SELECT 1
      FROM public.organizations AS o
      JOIN public.party_role_assignments AS a ON a.org_id = o.id
      JOIN public.parties AS p ON p.id = a.party_id AND p.org_id = o.id
     WHERE o.name = 'MINT-91 Synthetic Organization'
       AND a.role_key = 'customer_escalation_contact'
       AND p.email = 'm91-contact@example.invalid'
       AND p.phone_office IS NULL
  ));

SELECT pg_temp.m91_mark('create_org_still_stores_an_entered_sales_rep_phone',
  EXISTS (
    SELECT 1
      FROM public.organizations AS o
      JOIN public.party_role_assignments AS a ON a.org_id = o.id
      JOIN public.parties AS p ON p.id = a.party_id AND p.org_id = o.id
     WHERE o.name = 'MINT-91 Synthetic Organization'
       AND a.role_key = 'sales_rep'
       AND p.phone_office = '303-555-0177'
  ));

SELECT pg_temp.m91_mark('create_org_still_refuses_a_blank_city',
  (SELECT result = 'error:Customer contact city is required'
     FROM pg_temp.m91_calls WHERE name = 'create_org_blank_city'));

SELECT pg_temp.m91_mark('create_org_refusal_wrote_nothing',
  NOT EXISTS (
    SELECT 1 FROM public.organizations WHERE name = 'MINT-91 Synthetic Refused Organization'
  ));

-- The public RPCs are throttled per caller (submit_inbound_lead allows 5
-- attempts an hour). Clear the attempt log for both, inside this rolled-back
-- transaction, so an earlier step in the job can't throttle the calls below.
DELETE FROM public.public_rpc_attempts
 WHERE rpc_name IN ('submit_capture', 'submit_inbound_lead');

-- ---------------------------------------------------------------------------
-- 3. submit_capture as anon: a blank phone is saved as NULL (the capture
--    overwrites the party, here one that had a phone) and the link is used.
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (id, name) VALUES
  ('18100000-0000-4000-a000-000000000091', 'MINT-91 Synthetic Capture Organization');
INSERT INTO public.parties (
  id, org_id, party_type, name, email, phone_office, created_by
) VALUES (
  '66100000-0000-4000-a000-000000000091', '18100000-0000-4000-a000-000000000091', 'person',
  'Before Capture', 'm91-contact@example.invalid', '303-555-0100',
  '39100000-0000-4000-a000-000000000091'
);
INSERT INTO public.party_capture_links (
  id, org_id, party_id, recipient_email, token_hash, state, expires_at, created_by
) VALUES (
  '77100000-0000-4000-a000-000000000091', '18100000-0000-4000-a000-000000000091',
  '66100000-0000-4000-a000-000000000091', 'm91-contact@example.invalid',
  encode(sha256(convert_to('m91-capture-token', 'UTF8')), 'hex'),
  'active', now() + interval '1 hour', '39100000-0000-4000-a000-000000000091'
);

INSERT INTO pg_temp.m91_calls
SELECT 'capture_blank_phone', pg_temp.m91_as('anon', NULL, format(
         'SELECT public.submit_capture(%L, %L::jsonb)',
         'm91-capture-token', (pg_temp.m91_contact() || '{"phone_office": ""}')::text));

SELECT pg_temp.m91_mark('capture_submit_with_a_blank_phone_succeeds',
  (SELECT result = 'ok:' || jsonb_build_object('ok', true, 'state', 'used')::text
     FROM pg_temp.m91_calls WHERE name = 'capture_blank_phone'));

SELECT pg_temp.m91_mark('capture_saves_a_blank_phone_as_null',
  EXISTS (
    SELECT 1 FROM public.parties
     WHERE id = '66100000-0000-4000-a000-000000000091'
       AND name = 'Mint Ninetyone'
       AND phone_office IS NULL
  ));

SELECT pg_temp.m91_mark('capture_link_is_used',
  EXISTS (
    SELECT 1 FROM public.party_capture_links
     WHERE id = '77100000-0000-4000-a000-000000000091' AND state = 'used'
  ));

-- ---------------------------------------------------------------------------
-- 4. submit_inbound_lead as anon: blank and missing phones save as NULL, an
--    entered one is stored trimmed, a missing email is still refused.
-- ---------------------------------------------------------------------------

INSERT INTO pg_temp.m91_calls
SELECT c.name, pg_temp.m91_as('anon', NULL, format(
         'SELECT public.submit_inbound_lead(%L::jsonb)', c.payload::text))
  FROM (VALUES
    ('lead_blank_phone', jsonb_build_object(
       'org_name', 'MINT-91 Synthetic Lead Blank', 'contact_name', 'Lead Blank',
       'contact_email', 'm91-lead@example.invalid', 'contact_phone', '  ',
       'company_website', '')),
    ('lead_no_phone_key', jsonb_build_object(
       'org_name', 'MINT-91 Synthetic Lead Missing', 'contact_name', 'Lead Missing',
       'contact_email', 'm91-lead@example.invalid')),
    ('lead_entered_phone', jsonb_build_object(
       'org_name', 'MINT-91 Synthetic Lead Entered', 'contact_name', 'Lead Entered',
       'contact_email', 'm91-lead@example.invalid', 'contact_phone', ' 303-555-0188 ')),
    ('lead_missing_email', jsonb_build_object(
       'org_name', 'MINT-91 Synthetic Lead Refused', 'contact_name', 'Lead Refused',
       'contact_phone', ''))
  ) AS c(name, payload);

SELECT pg_temp.m91_mark(c.check_name,
  (SELECT result = c.expected FROM pg_temp.m91_calls WHERE name = c.call_name))
  FROM (VALUES
    ('lead_with_a_blank_phone_succeeds', 'lead_blank_phone', 'ok:{"ok": true}'),
    ('lead_with_no_phone_key_succeeds', 'lead_no_phone_key', 'ok:{"ok": true}'),
    ('lead_with_an_entered_phone_succeeds', 'lead_entered_phone', 'ok:{"ok": true}'),
    ('lead_still_refuses_a_missing_email', 'lead_missing_email', 'error:Email is required')
  ) AS c(check_name, call_name, expected);

SELECT pg_temp.m91_mark('lead_saves_a_blank_phone_as_null',
  EXISTS (SELECT 1 FROM public.inbound_leads
           WHERE org_name = 'MINT-91 Synthetic Lead Blank' AND contact_phone IS NULL
             AND status = 'new'));
SELECT pg_temp.m91_mark('lead_saves_a_missing_phone_as_null',
  EXISTS (SELECT 1 FROM public.inbound_leads
           WHERE org_name = 'MINT-91 Synthetic Lead Missing' AND contact_phone IS NULL));
SELECT pg_temp.m91_mark('lead_still_stores_an_entered_phone',
  EXISTS (SELECT 1 FROM public.inbound_leads
           WHERE org_name = 'MINT-91 Synthetic Lead Entered'
             AND contact_phone = '303-555-0188'));
SELECT pg_temp.m91_mark('lead_refusal_wrote_nothing',
  NOT EXISTS (SELECT 1 FROM public.inbound_leads
               WHERE org_name = 'MINT-91 Synthetic Lead Refused'));

-- ---------------------------------------------------------------------------
-- 5. Security mode, search_path and grants are what they were.
-- ---------------------------------------------------------------------------
SELECT pg_temp.m91_mark('helper_is_security_invoker_with_public_search_path',
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc
           WHERE oid = 'public.assert_contact_valid(jsonb, text)'::regprocedure
             AND NOT prosecdef
             AND proconfig = ARRAY['search_path=public']));
SELECT pg_temp.m91_mark('lead_rpc_is_security_definer_with_public_search_path',
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc
           WHERE oid = 'public.submit_inbound_lead(jsonb)'::regprocedure
             AND prosecdef
             AND proconfig = ARRAY['search_path=public']));
SELECT pg_temp.m91_mark('acl_' || g.label,
  has_function_privilege(g.role, g.fn, 'EXECUTE') = g.expected)
  FROM (VALUES
    ('anon_calls_the_lead_rpc', 'anon', 'public.submit_inbound_lead(jsonb)', true),
    ('authenticated_calls_the_lead_rpc', 'authenticated', 'public.submit_inbound_lead(jsonb)', true),
    ('anon_cannot_call_the_helper', 'anon', 'public.assert_contact_valid(jsonb, text)', false),
    ('authenticated_cannot_call_the_helper', 'authenticated',
     'public.assert_contact_valid(jsonb, text)', false)
  ) AS g(label, role, fn, expected);

-- ---------------------------------------------------------------------------
-- Report.
-- ---------------------------------------------------------------------------
SELECT name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END
  FROM pg_temp.m91_results ORDER BY name;

-- On any failure, print every call's result to show where it went wrong.
SELECT 'call ' || c.name || ' -> ' || c.result
  FROM pg_temp.m91_calls AS c
 WHERE EXISTS (SELECT 1 FROM pg_temp.m91_results WHERE NOT passed)
 ORDER BY c.name;

DO $$
DECLARE v_failed text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO v_failed
    FROM pg_temp.m91_results WHERE NOT passed;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'MINT-91 contact phone assertions failed: %', v_failed;
  END IF;
END;
$$;

-- The ROLLBACK also undoes the auth USAGE grant.
ROLLBACK;
\echo MINT-91 contact phone packet passed.
