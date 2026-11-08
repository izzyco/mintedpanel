-- Smoke test for 20261107000000_cancel_provider_onboarding.sql. Run it after
-- the migration is applied, as the postgres user (the owner of the tables and
-- the SECURITY DEFINER functions: on a local `supabase start`, or the SQL
-- editor on staging), with both Vault secrets (ssn_vault_key and
-- portal_credentials_key) provisioned:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/provider-onboarding-cancel-smoke.sql
--
-- Everything runs in one transaction and is rolled back, so it leaves no rows.
-- It touches no Storage object: the cancel route deletes the files. Hashes
-- are plain strings here: the RPCs only compare them. No check prints an SSN
-- or a password. Any failed check raises and stops the script.
BEGIN;

CREATE FUNCTION pg_temp.sign_in(p_link text, p_session text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  ASSERT (public.issue_intake_code(p_link, p_link || '-code')->>'send')::boolean, 'code for ' || p_link;
  ASSERT public.verify_intake_code(p_link, p_link || '-code', p_session, now() + interval '2 hours') = 'ok',
    'session for ' || p_link;
END;
$$;

DO $$
DECLARE
  v_org uuid;
  v_other_org uuid;
  v_group uuid;
  v_group_b uuid;
  v_actor uuid := gen_random_uuid();
  v_staff uuid := gen_random_uuid();
  r jsonb;
  v_provider uuid;
  v_journey uuid;
  v_cv uuid;
  v_coi uuid;
  v_audit_before int;
  v_gap uuid;
  v_gap_journey uuid;
  v_gap_cipher bytea;
  v_fresh uuid;
  v_fresh_journey uuid;
  v_kept uuid;
  v_kept_journey uuid;
  v_cased uuid;
  v_cased_journey uuid;
  v_joined uuid;
  v_payer uuid;
  v_done uuid;
  v_frozen uuid;
  v_frozen_journey uuid;
  v_state text;
  v_signed_at timestamptz;
BEGIN
  INSERT INTO public.organizations (name) VALUES ('Smoke Cancel') RETURNING id INTO v_org;
  INSERT INTO public.organizations (name) VALUES ('Smoke Cancel Other') RETURNING id INTO v_other_org;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group') RETURNING id INTO v_group;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group B') RETURNING id INTO v_group_b;
  INSERT INTO auth.users (id, email) VALUES (v_staff, 'cancel-smoke-staff@example.invalid');
  INSERT INTO public.profiles (id, full_name, email)
    VALUES (v_staff, 'Smoke Staff', 'cancel-smoke-staff@example.invalid')
    ON CONFLICT (id) DO NOTHING;

  -- A new hire who filled in everything but Submit: help asked, a staff
  -- note, licenses, consent, a draft, her SSN, both logins, three uploads
  -- (one replaced, so removed) and an SMS consent.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Anita', 'last_name', 'Rao', 'email', 'anita.cancel@example.test', 'group_id', v_group),
    'cx-link-a', now() + interval '30 days');
  v_provider := (r->>'provider_id')::uuid;
  v_journey := (r->>'onboarding_id')::uuid;
  PERFORM pg_temp.sign_in('cx-link-a', 'cx-sess-a');
  ASSERT public.sign_intake_consent('cx-sess-a', 'cx-link-a', 'Anita Rao', 1)->>'result' = 'signed', 'consent';
  ASSERT public.save_intake_draft('cx-sess-a', 'cx-link-a', jsonb_build_object('lastName', 'Rao-Smith'),
                                  'documents', 0)->>'result' = 'saved', 'draft';
  ASSERT public.store_intake_ssn('cx-sess-a', 'cx-link-a', '123456789')->>'result' = 'stored', 'ssn';
  ASSERT public.store_intake_portal_login('cx-sess-a', 'cx-link-a', 'caqh', 'anita.r', 'Pass-1')->>'result' = 'stored', 'caqh';
  ASSERT public.store_intake_portal_login('cx-sess-a', 'cx-link-a', 'pecos', 'anita.p', 'Pass-2')->>'result' = 'stored', 'pecos';
  r := public.begin_intake_upload('cx-sess-a', 'cx-link-a', 'cv', 'cv', 'cv.pdf', 100, 'application/pdf', NULL);
  v_cv := (r->>'upload_id')::uuid;
  PERFORM public.finish_intake_upload('cx-sess-a', 'cx-link-a', v_cv, 100);
  PERFORM public.begin_intake_upload('cx-sess-a', 'cx-link-a', 'coi', 'coi', 'old.pdf', 100, 'application/pdf', NULL);
  r := public.begin_intake_upload('cx-sess-a', 'cx-link-a', 'coi', 'coi', 'coi.pdf', 100, 'application/pdf', '2027-06-30');
  v_coi := (r->>'upload_id')::uuid;
  ASSERT public.request_intake_help('cx-sess-a', 'cx-link-a', 'help', NULL)->>'result' = 'requested', 'help';
  INSERT INTO public.notes (org_id, entity_type, entity_id, content, author_id)
    VALUES (v_org, 'provider', v_provider, 'Called her about the start date.', v_staff);
  INSERT INTO public.state_licenses (org_id, provider_id, state, license_number, expiration_date)
    VALUES (v_org, v_provider, 'NC', 'PT-1', '2027-12-31'), (v_org, v_provider, 'SC', 'SC-1', '2027-12-31');
  INSERT INTO public.sms_consents (org_id, provider_id, phone_e164, source, consent_text_version)
    VALUES (v_org, v_provider, '+17045550100', 'intake_form', 'v1');
  ASSERT (SELECT count(*) FROM public.provider_intake_uploads WHERE onboarding_id = v_journey) = 3, 'three uploads';
  v_signed_at := (SELECT signed_at FROM public.provider_intake_consents WHERE onboarding_id = v_journey);
  v_audit_before := (SELECT count(*) FROM public.audit_log WHERE org_id = v_org);

  -- service_role only.
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_provider);
    v_state := 'ran';
  EXCEPTION WHEN insufficient_privilege THEN
    v_state := 'refused';
  END;
  RESET ROLE;
  ASSERT v_state = 'refused', 'authenticated cannot call cancel';

  -- Another org's id for her is a miss, and changes nothing.
  r := public.cancel_provider_onboarding(v_other_org, v_staff, 'Staff', v_provider);
  ASSERT r = jsonb_build_object('result', 'not_found'), format('other org: %s', r);
  ASSERT (SELECT revoked_at IS NULL FROM public.provider_intake_invites WHERE provider_id = v_provider),
    'other org revoked nothing';
  ASSERT public.read_intake_state('cx-sess-a', 'cx-link-a') IS NOT NULL, 'other org: she is still signed in';

  r := public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_provider);
  ASSERT r = jsonb_build_object('result', 'deleted', 'storage', jsonb_build_array(
    jsonb_build_object('bucket', 'provider-intake-uploads',
                       'prefix', format('org/%s/onboarding/%s/', v_org, v_journey)),
    jsonb_build_object('bucket', 'provider-documents',
                       'prefix', format('org/%s/provider/%s/', v_org, v_provider)))),
    format('deleted: %s', r);

  ASSERT NOT EXISTS (SELECT 1 FROM public.providers WHERE id = v_provider), 'provider gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_group_assignments WHERE provider_id = v_provider), 'assignments gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.state_licenses WHERE provider_id = v_provider), 'licenses gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.notes WHERE entity_type = 'provider' AND entity_id = v_provider),
    'help request and staff note gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_invites WHERE provider_id = v_provider), 'invites gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_codes c
                       WHERE c.code_hash = 'cx-link-a-code'), 'codes gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_sessions WHERE token_hash = 'cx-sess-a'), 'sessions gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_onboardings WHERE id = v_journey), 'journey gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_drafts WHERE onboarding_id = v_journey), 'draft gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_consents WHERE onboarding_id = v_journey), 'consents gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_uploads WHERE onboarding_id = v_journey), 'upload rows gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_ssn_vault WHERE provider_id = v_provider), 'SSN gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_portal_credentials WHERE provider_id = v_provider), 'logins gone';
  ASSERT (SELECT count(*) FROM public.sms_consents
           WHERE org_id = v_org AND provider_id IS NULL AND phone_e164 = '+17045550100') = 1,
    'the SMS consent evidence stays, detached';
  ASSERT (SELECT count(*) FROM public.audit_log WHERE org_id = v_org) = v_audit_before + 1, 'one new audit row';
  ASSERT (SELECT action_type = 'DELETE' AND user_id = v_staff AND user_name = 'Staff'
                 AND after = jsonb_build_object('onboarding_id', v_journey, 'consents', jsonb_build_array(
                   jsonb_build_object('text_version', 1, 'signed_at', v_signed_at)))
                 AND after::text NOT LIKE '%Anita%'
            FROM public.audit_log
           WHERE org_id = v_org AND entity_type = 'provider' AND entity_id = v_provider
             AND action_type = 'DELETE'),
    'the DELETE audit row keeps ids and what she consented to when, never her typed name';
  ASSERT EXISTS (SELECT 1 FROM public.audit_log WHERE org_id = v_org AND entity_id = v_provider
                    AND action_type = 'CREATE'), 'earlier audit rows stay';

  -- Twice is a miss, and a new invite of the same person starts over.
  ASSERT public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_provider)
         = jsonb_build_object('result', 'not_found'), 'second cancel';
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Anita', 'last_name', 'Rao', 'email', 'anita.cancel@example.test', 'group_id', v_group),
    'cx-link-a2', now() + interval '30 days');
  ASSERT r->>'result' = 'created' AND (r->>'provider_id')::uuid <> v_provider
     AND (r->>'onboarding_id')::uuid <> v_journey, format('a new invite after cancel: %s', r);
  ASSERT (SELECT created_record FROM public.provider_onboardings WHERE id = (r->>'onboarding_id')::uuid),
    'the new record is the new journey''s';

  -- A gap-fill journey on a provider staff added, SSN already on file: the
  -- journey's logins go and its uploads are marked removed; the record and
  -- its SSN stay.
  INSERT INTO public.providers (org_id, first_name, last_name, email, status, group_id)
    VALUES (v_org, 'Gina', 'Gap', 'gina.gap@example.test', 'active', v_group) RETURNING id INTO v_gap;
  INSERT INTO public.provider_group_assignments (org_id, provider_id, group_id, is_primary)
    VALUES (v_org, v_gap, v_group, true);
  PERFORM public._ssn_vault_upsert(v_gap, v_org, '987654321', v_staff);
  v_gap_cipher := (SELECT ssn_ciphertext FROM public.provider_ssn_vault WHERE provider_id = v_gap);
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_gap, 'cx-link-g', now() + interval '30 days');
  v_gap_journey := (r->>'onboarding_id')::uuid;
  ASSERT (SELECT NOT created_record AND 'ssn' = ANY (locked_fields)
            FROM public.provider_onboardings WHERE id = v_gap_journey), 'gap-fill journey locks the SSN';
  PERFORM pg_temp.sign_in('cx-link-g', 'cx-sess-g');
  ASSERT public.sign_intake_consent('cx-sess-g', 'cx-link-g', 'Gina Gap', 1)->>'result' = 'signed', 'gap consent';
  ASSERT public.save_intake_draft('cx-sess-g', 'cx-link-g', jsonb_build_object('mobile', '7045550111'),
                                  'form', 0)->>'result' = 'saved', 'gap draft';
  ASSERT public.store_intake_ssn('cx-sess-g', 'cx-link-g', '111223333')->>'result' = 'locked', 'locked SSN';
  ASSERT public.store_intake_portal_login('cx-sess-g', 'cx-link-g', 'caqh', 'gina.c', 'Pass-3')->>'result' = 'stored',
    'gap login';
  r := public.begin_intake_upload('cx-sess-g', 'cx-link-g', 'cv', 'cv', 'cv.pdf', 100, 'application/pdf', NULL);
  v_cv := (r->>'upload_id')::uuid;
  PERFORM public.finish_intake_upload('cx-sess-g', 'cx-link-g', v_cv, 100);

  r := public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_gap);
  ASSERT r = jsonb_build_object('result', 'closed', 'storage', jsonb_build_array(
    jsonb_build_object('bucket', 'provider-intake-uploads',
                       'prefix', format('org/%s/onboarding/%s/', v_org, v_gap_journey)),
    jsonb_build_object('bucket', 'provider-documents',
                       'prefix', format('org/%s/provider/%s/%s/', v_org, v_gap, v_cv)))),
    format('gap-fill closed: %s', r);
  ASSERT (SELECT cancelled_at IS NOT NULL AND cancelled_by = v_staff AND submitted_at IS NULL
            FROM public.provider_onboardings WHERE id = v_gap_journey), 'journey cancelled by staff';
  ASSERT (SELECT status = 'active' AND ssn_last4 = '4321' FROM public.providers WHERE id = v_gap),
    'record and its last 4 untouched';
  ASSERT (SELECT ssn_ciphertext = v_gap_cipher FROM public.provider_ssn_vault WHERE provider_id = v_gap),
    'the SSN on file before the journey stays';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_portal_credentials WHERE provider_id = v_gap), 'her login gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_drafts WHERE onboarding_id = v_gap_journey), 'draft gone';
  ASSERT (SELECT count(*) = 1 AND bool_and(removed_at IS NOT NULL)
            FROM public.provider_intake_uploads WHERE onboarding_id = v_gap_journey),
    'her upload row stays, marked removed';
  ASSERT (SELECT count(*) FROM public.provider_intake_consents WHERE onboarding_id = v_gap_journey) = 1, 'consent kept';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_invites WHERE provider_id = v_gap AND revoked_at IS NULL),
    'invites revoked';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_intake_sessions WHERE token_hash = 'cx-sess-g' AND revoked_at IS NULL),
    'session revoked';
  ASSERT public.read_intake_state('cx-sess-g', 'cx-link-g') IS NULL, 'she is signed out';
  ASSERT (SELECT action_type = 'UPDATE' AND user_id = v_staff
                 AND after = jsonb_build_object('provider_id', v_gap, 'logins_removed', 1, 'ssn_removed', false)
            FROM public.audit_log
           WHERE org_id = v_org AND entity_type = 'provider_onboarding' AND entity_id = v_gap_journey),
    'one UPDATE audit row on the journey';
  ASSERT public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_gap)
         = jsonb_build_object('result', 'not_found'), 'second cancel of a closed journey';

  -- A later invite opens a new journey on the kept record.
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_gap, 'cx-link-g2', now() + interval '30 days');
  ASSERT r->>'result' = 'resent' AND (r->>'onboarding_id')::uuid <> v_gap_journey, format('re-invite: %s', r);

  -- A gap-fill journey that stored the SSN (none on file when it opened)
  -- takes it back with it.
  INSERT INTO public.providers (org_id, first_name, last_name, email, status, group_id)
    VALUES (v_org, 'Fern', 'Fresh', 'fern.fresh@example.test', 'active', v_group) RETURNING id INTO v_fresh;
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_fresh, 'cx-link-f', now() + interval '30 days');
  v_fresh_journey := (r->>'onboarding_id')::uuid;
  PERFORM pg_temp.sign_in('cx-link-f', 'cx-sess-f');
  ASSERT public.store_intake_ssn('cx-sess-f', 'cx-link-f', '222334444')->>'result' = 'stored', 'fresh SSN';
  r := public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_fresh);
  ASSERT r->>'result' = 'closed', format('fresh closed: %s', r);
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_ssn_vault WHERE provider_id = v_fresh), 'her SSN gone';
  ASSERT (SELECT ssn_last4 IS NULL FROM public.providers WHERE id = v_fresh), 'last 4 cleared';
  ASSERT (SELECT (after->>'ssn_removed')::boolean FROM public.audit_log
           WHERE entity_type = 'provider_onboarding' AND entity_id = v_fresh_journey), 'audit says the SSN went';

  -- Staff saved an SSN after hers: theirs stays.
  INSERT INTO public.providers (org_id, first_name, last_name, email, status, group_id)
    VALUES (v_org, 'Kay', 'Kept', 'kay.kept@example.test', 'active', v_group) RETURNING id INTO v_kept;
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_kept, 'cx-link-k', now() + interval '30 days');
  v_kept_journey := (r->>'onboarding_id')::uuid;
  PERFORM pg_temp.sign_in('cx-link-k', 'cx-sess-k');
  ASSERT public.store_intake_ssn('cx-sess-k', 'cx-link-k', '333445555')->>'result' = 'stored', 'kept SSN';
  UPDATE public.provider_ssn_vault SET updated_at = now() + interval '1 minute', updated_by = v_staff
   WHERE provider_id = v_kept;
  ASSERT public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_kept)->>'result' = 'closed', 'kept closed';
  ASSERT EXISTS (SELECT 1 FROM public.provider_ssn_vault WHERE provider_id = v_kept), 'staff''s SSN stays';
  ASSERT (SELECT ssn_last4 = '5555' FROM public.providers WHERE id = v_kept), 'staff''s last 4 stays';

  -- A record the journey created that now has a case is closed, not deleted.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Cora', 'last_name', 'Cased', 'email', 'cora.cased@example.test', 'group_id', v_group),
    'cx-link-c', now() + interval '30 days');
  v_cased := (r->>'provider_id')::uuid;
  v_cased_journey := (r->>'onboarding_id')::uuid;
  INSERT INTO public.payers (name) VALUES ('Smoke Cancel Payer') RETURNING id INTO v_payer;
  INSERT INTO public.credential_cases (org_id, provider_id, group_id, payer_id, state)
    VALUES (v_org, v_cased, v_group, v_payer, 'NC');
  INSERT INTO public.state_licenses (org_id, provider_id, state, license_number, expiration_date)
    VALUES (v_org, v_cased, 'NC', 'PT-9', '2027-12-31');
  r := public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_cased);
  ASSERT r->>'result' = 'closed', format('cased: %s', r);
  ASSERT (SELECT count(*) FROM public.state_licenses WHERE provider_id = v_cased) = 1
     AND EXISTS (SELECT 1 FROM public.provider_group_assignments WHERE provider_id = v_cased)
     AND (SELECT cancelled_at IS NOT NULL FROM public.provider_onboardings WHERE id = v_cased_journey),
    'the record and its case stay; the journey is cancelled';

  -- A record another group joined is closed, not deleted.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Jo', 'last_name', 'Joined', 'email', 'jo.joined@example.test', 'group_id', v_group),
    'cx-link-j', now() + interval '30 days');
  v_joined := (r->>'provider_id')::uuid;
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Jo', 'last_name', 'Joined', 'email', 'jo.joined@example.test', 'group_id', v_group_b),
    'cx-link-j2', now() + interval '30 days');
  ASSERT r->>'result' = 'added_group', format('second group: %s', r);
  ASSERT public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_joined)->>'result' = 'closed', 'joined closed';
  ASSERT (SELECT count(*) FROM public.provider_group_assignments WHERE provider_id = v_joined) = 2,
    'both groups keep her';

  -- After Submit, cancel writes nothing.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Sam', 'last_name', 'Sent', 'email', 'sam.sent@example.test', 'group_id', v_group),
    'cx-link-s', now() + interval '30 days');
  v_done := (r->>'provider_id')::uuid;
  UPDATE public.provider_onboardings SET submitted_at = now() WHERE id = (r->>'onboarding_id')::uuid;
  ASSERT public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_done)
         = jsonb_build_object('result', 'already_submitted'), 'submitted';
  ASSERT (SELECT cancelled_at IS NULL FROM public.provider_onboardings WHERE provider_id = v_done)
     AND (SELECT revoked_at IS NULL FROM public.provider_intake_invites WHERE provider_id = v_done),
    'a submitted journey and its invite are untouched';

  -- An offboarded org's API session can't cancel.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Fay', 'last_name', 'Frozen', 'email', 'fay.frozen@example.test', 'group_id', v_group),
    'cx-link-o', now() + interval '30 days');
  v_frozen := (r->>'provider_id')::uuid;
  v_frozen_journey := (r->>'onboarding_id')::uuid;
  UPDATE public.organizations SET lifecycle_state = 'offboarded' WHERE id = v_org;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.cancel_provider_onboarding(v_org, v_staff, 'Staff', v_frozen);
    v_state := 'ran';
  EXCEPTION WHEN insufficient_privilege THEN
    v_state := SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  ASSERT v_state = 'org_offboarded', format('offboarded: %s', v_state);
  ASSERT (SELECT cancelled_at IS NULL FROM public.provider_onboardings WHERE id = v_frozen_journey)
     AND EXISTS (SELECT 1 FROM public.providers WHERE id = v_frozen), 'offboarded: nothing changed';
  RAISE NOTICE 'provider onboarding cancel smoke: all checks passed';
END;
$$;

ROLLBACK;
