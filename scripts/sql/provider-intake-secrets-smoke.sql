-- Smoke test for 20261106220000_provider_intake_secrets.sql. Run it after the
-- migration is applied, as the postgres user (the owner of the tables and the
-- SECURITY DEFINER functions: on a local `supabase start`, or the SQL editor
-- on staging), with both Vault secrets (ssn_vault_key and
-- portal_credentials_key) provisioned:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/provider-intake-secrets-smoke.sql
--
-- Everything runs in one transaction and is rolled back, so it leaves no rows
-- and the Vault secret it deletes comes back. Hashes are plain strings here:
-- the RPCs only compare them. No check prints a key, an SSN or a password.
-- Any failed check raises and stops the script.
BEGIN;

DO $$
DECLARE
  v_org uuid;
  v_other_org uuid;
  v_group uuid;
  v_other_group uuid;
  v_actor uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_specialist uuid := gen_random_uuid();
  v_other_admin uuid := gen_random_uuid();
  r jsonb;
  v_provider uuid;
  v_other_provider uuid;
  v_spare_provider uuid;
  v_journey uuid;
  v_journey_2 uuid;
  v_ssn_cipher bytea;
  v_cipher bytea;
  v_opened boolean;
  v_text text;
  v_state text;
BEGIN
  INSERT INTO public.organizations (name) VALUES ('Smoke Secrets') RETURNING id INTO v_org;
  INSERT INTO public.organizations (name) VALUES ('Smoke Secrets Other') RETURNING id INTO v_other_org;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_org, 'Smoke Group') RETURNING id INTO v_group;
  INSERT INTO public.provider_groups (org_id, name) VALUES (v_other_org, 'Other Group') RETURNING id INTO v_other_group;

  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Anita', 'last_name', 'Rao', 'email', 'anita.secrets@example.test', 'group_id', v_group),
    'sec-link-a', now() + interval '30 days');
  v_provider := (r->>'provider_id')::uuid;
  v_journey := (r->>'onboarding_id')::uuid;
  ASSERT (public.issue_intake_code('sec-link-a', 'sec-code-a')->>'send')::boolean, 'code a';
  ASSERT public.verify_intake_code('sec-link-a', 'sec-code-a', 'sec-sess-a', now() + interval '2 hours') = 'ok', 'session a';

  r := public.create_provider_intake_invite(v_other_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Other', 'last_name', 'Person', 'email', 'other.secrets@example.test',
    'group_id', v_other_group), 'sec-link-b', now() + interval '30 days');
  v_other_provider := (r->>'provider_id')::uuid;
  ASSERT (public.issue_intake_code('sec-link-b', 'sec-code-b')->>'send')::boolean, 'code b';
  ASSERT public.verify_intake_code('sec-link-b', 'sec-code-b', 'sec-sess-b', now() + interval '2 hours') = 'ok', 'session b';

  -- A third provider in the same org, kept open for the no-key check at the end.
  r := public.create_provider_intake_invite(v_org, v_actor, 'Smoke', jsonb_build_object(
    'first_name', 'Spare', 'last_name', 'Person', 'email', 'spare.secrets@example.test', 'group_id', v_group),
    'sec-link-c', now() + interval '30 days');
  v_spare_provider := (r->>'provider_id')::uuid;
  ASSERT (public.issue_intake_code('sec-link-c', 'sec-code-c')->>'send')::boolean, 'code c';
  ASSERT public.verify_intake_code('sec-link-c', 'sec-code-c', 'sec-sess-c', now() + interval '2 hours') = 'ok', 'session c';

  r := public.read_intake_state('sec-sess-a', 'sec-link-a');
  ASSERT r->'logins_on_file' = '{"caqh": false, "pecos": false}'::jsonb AND r->'ssn_last4' = 'null'::jsonb
     AND r ? 'draft' AND r ? 'consented' AND r ? 'locked_fields', format('fresh state: %s', r);

  -- SSN: into the vault, the last 4 on the provider, the journey stamped.
  r := public.store_intake_ssn('sec-sess-a', 'sec-link-a', '123456789');
  ASSERT r = jsonb_build_object('result', 'stored', 'ssn_last4', '6789'), format('store ssn: %s', r);
  SELECT ssn_ciphertext INTO v_ssn_cipher
    FROM public.provider_ssn_vault WHERE provider_id = v_provider AND org_id = v_org AND created_by = v_actor;
  ASSERT v_ssn_cipher IS NOT NULL, 'vault row, actor is the inviter';
  ASSERT position(convert_to('123456789', 'UTF8') IN v_ssn_cipher) = 0, 'ssn ciphertext holds no plaintext';
  ASSERT public._ssn_decrypt(v_ssn_cipher) = '123456789', 'ssn decrypts with the ssn key';
  ASSERT (SELECT ssn_last4 FROM public.providers WHERE id = v_provider) = '6789', 'providers.ssn_last4';
  ASSERT (SELECT ssn_stored_at IS NOT NULL FROM public.provider_onboardings WHERE id = v_journey), 'ssn_stored_at';
  ASSERT (SELECT count(*) FROM public.audit_log
           WHERE org_id = v_org AND entity_type = 'provider_ssn_vault' AND entity_id = v_provider
             AND action_type = 'UPDATE' AND before IS NULL AND after IS NULL
             AND description NOT LIKE '%6789%') = 1, 'one ssn audit row, no digits';
  ASSERT public.read_intake_state('sec-sess-a', 'sec-link-a')->>'ssn_last4' = '6789', 'last 4 in state';
  BEGIN
    PERFORM public.store_intake_ssn('sec-sess-a', 'sec-link-a', '123-45-6789');
    RAISE EXCEPTION 'separators accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.store_intake_ssn('sec-sess-a', 'sec-link-a', '12345678');
    RAISE EXCEPTION 'eight digits accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  -- A session is good only under its own link: nothing read or written for
  -- another org's provider, and nothing for her through another link.
  ASSERT public.store_intake_ssn('sec-sess-a', 'sec-link-b', '123456789') IS NULL, 'ssn under another link';
  ASSERT public.store_intake_ssn('sec-sess-b', 'sec-link-a', '123456789') IS NULL, 'org b session, org a link';
  ASSERT public.store_intake_portal_login('sec-sess-a', 'sec-link-b', 'caqh', 'u', 'p') IS NULL, 'login under another link';
  ASSERT public.store_intake_ssn('sec-sess-nope', 'sec-link-a', '123456789') IS NULL, 'unknown session';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_ssn_vault WHERE provider_id = v_other_provider), 'no ssn for org b';
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_portal_credentials WHERE provider_id = v_other_provider),
    'no login for org b';

  -- Logins: stored under the portal key, replaced on a second save.
  r := public.store_intake_portal_login('sec-sess-a', 'sec-link-a', 'caqh', ' anita.caqh ', 'First-Pass-1');
  ASSERT r = jsonb_build_object('result', 'stored'), format('store login: %s', r);
  SELECT password_ciphertext INTO v_cipher FROM public.provider_portal_credentials
   WHERE provider_id = v_provider AND portal = 'caqh' AND org_id = v_org AND username = 'anita.caqh'
     AND onboarding_id = v_journey AND created_by = v_actor AND key_version = 1;
  ASSERT v_cipher IS NOT NULL, 'login row';
  ASSERT position(convert_to('First-Pass-1', 'UTF8') IN v_cipher) = 0, 'login ciphertext holds no plaintext';
  ASSERT extensions.pgp_sym_decrypt(v_cipher, public._portal_credentials_key()) = 'First-Pass-1',
    'decrypts with the portal key';
  ASSERT public._portal_credentials_key() IS DISTINCT FROM public._ssn_vault_key(), 'the two keys differ';
  BEGIN
    v_text := extensions.pgp_sym_decrypt(v_cipher, public._ssn_vault_key());
    v_opened := true;
  EXCEPTION WHEN OTHERS THEN
    v_opened := false;
  END;
  ASSERT NOT v_opened, 'the ssn key does not open a login';

  r := public.store_intake_portal_login('sec-sess-a', 'sec-link-a', 'caqh', 'anita.caqh2', 'Second-Pass-2');
  ASSERT r = jsonb_build_object('result', 'stored'), format('replace login: %s', r);
  ASSERT (SELECT count(*) FROM public.provider_portal_credentials WHERE provider_id = v_provider) = 1, 'one row per portal';
  ASSERT (SELECT username = 'anita.caqh2'
                 AND extensions.pgp_sym_decrypt(password_ciphertext, public._portal_credentials_key()) = 'Second-Pass-2'
            FROM public.provider_portal_credentials WHERE provider_id = v_provider AND portal = 'caqh'),
    'second save replaces the first';
  r := public.store_intake_portal_login('sec-sess-a', 'sec-link-a', 'pecos', 'ARAO77', 'Pecos-Pass-3');
  ASSERT public.read_intake_state('sec-sess-a', 'sec-link-a')->'logins_on_file' = '{"caqh": true, "pecos": true}'::jsonb,
    'both logins on file in state';
  ASSERT (SELECT count(*) FROM public.audit_log
           WHERE org_id = v_org AND entity_type = 'provider_portal_credential' AND entity_id = v_provider
             AND action_type = 'UPDATE' AND before IS NULL AND after ? 'portal' AND after - 'portal' = '{}'::jsonb
             AND description NOT LIKE '%anita%' AND description NOT LIKE '%Pass%') = 3,
    'one login audit row per save, portal only';
  BEGIN
    PERFORM public.store_intake_portal_login('sec-sess-a', 'sec-link-a', 'medicare', 'u', 'p');
    RAISE EXCEPTION 'unknown portal accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.store_intake_portal_login('sec-sess-a', 'sec-link-a', 'caqh', '   ', 'p');
    RAISE EXCEPTION 'blank username accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.store_intake_portal_login('sec-sess-a', 'sec-link-a', 'caqh', repeat('u', 101), 'p');
    RAISE EXCEPTION 'long username accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.store_intake_portal_login('sec-sess-a', 'sec-link-a', 'caqh', 'u', '');
    RAISE EXCEPTION 'blank password accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.store_intake_portal_login('sec-sess-a', 'sec-link-a', 'caqh', 'u', repeat('p', 201));
    RAISE EXCEPTION 'long password accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  -- Locked: after Admit, a re-invite opens a journey that locks the SSN on
  -- file. Her store is refused and the vault row is untouched.
  UPDATE public.provider_onboardings SET admitted_at = now() WHERE id = v_journey;
  UPDATE public.provider_intake_invites SET created_at = created_at - interval '11 minutes'
   WHERE provider_id = v_provider AND revoked_at IS NULL;
  r := public.resend_provider_intake_invite(v_org, v_actor, 'Smoke', v_provider, 'sec-link-a2', now() + interval '30 days');
  v_journey_2 := (r->>'onboarding_id')::uuid;
  ASSERT (SELECT 'ssn' = ANY (locked_fields) FROM public.provider_onboardings WHERE id = v_journey_2), 'ssn locked';
  ASSERT (public.issue_intake_code('sec-link-a2', 'sec-code-a2')->>'send')::boolean, 'code a2';
  ASSERT public.verify_intake_code('sec-link-a2', 'sec-code-a2', 'sec-sess-a2', now() + interval '2 hours') = 'ok', 'session a2';
  r := public.store_intake_ssn('sec-sess-a2', 'sec-link-a2', '987654321');
  ASSERT r = jsonb_build_object('result', 'locked'), format('locked: %s', r);
  ASSERT (SELECT ssn_ciphertext = v_ssn_cipher FROM public.provider_ssn_vault WHERE provider_id = v_provider),
    'locked leaves the vault row alone';
  ASSERT (SELECT ssn_last4 FROM public.providers WHERE id = v_provider) = '6789', 'locked leaves the last 4';
  ASSERT (SELECT ssn_stored_at IS NULL FROM public.provider_onboardings WHERE id = v_journey_2), 'locked: no stamp';
  ASSERT public.store_intake_ssn('sec-sess-a', 'sec-link-a', '987654321') IS NULL, 'the old session is dead';
  r := public.store_intake_portal_login('sec-sess-a2', 'sec-link-a2', 'caqh', 'anita.caqh3', 'Third-Pass-4');
  ASSERT r = jsonb_build_object('result', 'stored') AND (SELECT onboarding_id = v_journey_2
            FROM public.provider_portal_credentials WHERE provider_id = v_provider AND portal = 'caqh'),
    'a login replaced on the new journey names it';

  -- Closed once she has submitted: nothing more is stored.
  UPDATE public.provider_onboardings SET submitted_at = now() WHERE id = v_journey_2;
  ASSERT public.store_intake_ssn('sec-sess-a2', 'sec-link-a2', '987654321') = jsonb_build_object('result', 'closed'),
    'closed ssn';
  ASSERT public.store_intake_portal_login('sec-sess-a2', 'sec-link-a2', 'pecos', 'x', 'y')
         = jsonb_build_object('result', 'closed'), 'closed login';
  ASSERT (SELECT username = 'ARAO77' FROM public.provider_portal_credentials
           WHERE provider_id = v_provider AND portal = 'pecos'), 'closed writes nothing';

  -- Staff reveal: an admin of her org only, with a reason, one READ row.
  INSERT INTO auth.users (id, email) VALUES
    (v_admin, 'sec-smoke-admin@example.invalid'),
    (v_specialist, 'sec-smoke-specialist@example.invalid'),
    (v_other_admin, 'sec-smoke-other-admin@example.invalid');
  INSERT INTO public.profiles (id, full_name, email) VALUES
    (v_admin, 'Smoke Admin', 'sec-smoke-admin@example.invalid'),
    (v_specialist, 'Smoke Specialist', 'sec-smoke-specialist@example.invalid'),
    (v_other_admin, 'Smoke Other Admin', 'sec-smoke-other-admin@example.invalid')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (org_id, user_id, role) VALUES
    (v_org, v_admin, 'admin'), (v_org, v_specialist, 'specialist'), (v_other_org, v_other_admin, 'admin');

  PERFORM set_config('request.jwt.claim.sub', v_specialist::text, true),
          set_config('request.jwt.claim.role', 'authenticated', true),
          set_config('request.jwt.claims',
            json_build_object('sub', v_specialist, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.reveal_portal_credential(v_provider, 'caqh', 'Testing the login');
    v_state := 'revealed';
  EXCEPTION WHEN raise_exception THEN
    v_state := 'refused';
  END;
  RESET ROLE;
  ASSERT v_state = 'refused', 'a specialist is refused';

  PERFORM set_config('request.jwt.claim.sub', v_other_admin::text, true),
          set_config('request.jwt.claims',
            json_build_object('sub', v_other_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.reveal_portal_credential(v_provider, 'caqh', 'Testing the login');
    v_state := 'revealed';
  EXCEPTION WHEN raise_exception THEN
    v_state := 'refused';
  END;
  RESET ROLE;
  ASSERT v_state = 'refused', 'an admin of another org is refused';

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true),
          set_config('request.jwt.claims',
            json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.reveal_portal_credential(v_provider, 'caqh', '   ');
    v_state := 'revealed';
  EXCEPTION WHEN raise_exception THEN
    v_state := 'refused';
  END;
  r := public.reveal_portal_credential(v_provider, 'caqh', '  Testing the login ');
  RESET ROLE;
  ASSERT v_state = 'refused', 'a reveal needs a reason';
  ASSERT r->>'username' = 'anita.caqh3' AND r->>'password' = 'Third-Pass-4'
     AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r) k) = ARRAY['password', 'username'],
    'the admin gets the login and nothing else';
  ASSERT (SELECT count(*) FROM public.audit_log
           WHERE org_id = v_org AND entity_type = 'provider_portal_credential' AND entity_id = v_provider
             AND action_type = 'READ' AND user_id = v_admin AND user_name = 'Smoke Admin'
             AND after = jsonb_build_object('portal', 'caqh', 'justification', 'Testing the login')
             AND description NOT LIKE '%Pass%' AND description NOT LIKE '%anita%') = 1,
    'one READ audit row with the admin''s name, never the login';
  ASSERT (SELECT count(*) FROM public.audit_log
           WHERE entity_type = 'provider_portal_credential' AND action_type = 'READ' AND entity_id = v_provider) = 1,
    'refused reveals write nothing';

  PERFORM set_config('request.jwt.claim.sub', '', true),
          set_config('request.jwt.claim.role', '', true),
          set_config('request.jwt.claims', '', true);

  -- No key in Vault or the GUC: a login store raises and writes nothing.
  DELETE FROM vault.secrets WHERE name = 'portal_credentials_key';
  PERFORM set_config('app.settings.portal_credentials_key', '', true);
  BEGIN
    PERFORM public.store_intake_portal_login('sec-sess-c', 'sec-link-c', 'caqh', 'spare', 'Spare-Pass-5');
    v_state := 'stored';
  EXCEPTION WHEN raise_exception THEN
    v_state := CASE WHEN SQLERRM = 'Portal credentials key is not configured' THEN 'not_configured' ELSE SQLERRM END;
  END;
  ASSERT v_state = 'not_configured', format('no key: %s', v_state);
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_portal_credentials WHERE provider_id = v_spare_provider),
    'no key writes nothing';

  -- Deleting the provider takes her logins with it.
  DELETE FROM public.provider_group_assignments WHERE provider_id = v_provider;
  DELETE FROM public.providers WHERE id = v_provider;
  ASSERT NOT EXISTS (SELECT 1 FROM public.provider_portal_credentials WHERE provider_id = v_provider), 'logins cascade';

  -- Grants: the table is the RPCs' alone; the intake RPCs are service_role's.
  ASSERT NOT has_table_privilege('authenticated', 'public.provider_portal_credentials', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.provider_portal_credentials', 'SELECT')
     AND NOT has_table_privilege('service_role', 'public.provider_portal_credentials', 'SELECT')
     AND NOT has_table_privilege('service_role', 'public.provider_portal_credentials', 'INSERT'),
    'nobody reads or writes the table directly';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provider_portal_credentials'::regclass), 'rls on';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'provider_portal_credentials'), 'no policies';
  ASSERT has_function_privilege('service_role', 'public.store_intake_ssn(text, text, text)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.store_intake_portal_login(text, text, text, text, text)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.read_intake_state(text, text)', 'EXECUTE'), 'service_role';
  ASSERT NOT has_function_privilege('authenticated', 'public.store_intake_ssn(text, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.store_intake_ssn(text, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.store_intake_portal_login(text, text, text, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.store_intake_portal_login(text, text, text, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.read_intake_state(text, text)', 'EXECUTE'), 'no client stores';
  ASSERT NOT has_function_privilege('anon', 'public._portal_credentials_key()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public._portal_credentials_key()', 'EXECUTE')
     AND NOT has_function_privilege('service_role', 'public._portal_credentials_key()', 'EXECUTE'), 'key is private';
  ASSERT has_function_privilege('authenticated', 'public.reveal_portal_credential(uuid, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.reveal_portal_credential(uuid, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('service_role', 'public.reveal_portal_credential(uuid, text, text)', 'EXECUTE'),
    'reveal is for signed-in staff';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'block_writes_when_offboarded'
                    AND tgrelid = 'public.provider_portal_credentials'::regclass), 'offboarded freeze';

  RAISE NOTICE 'provider intake secrets smoke: all checks passed';
END;
$$;

ROLLBACK;
