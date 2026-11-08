# How to turn on provider onboarding R1

This checklist turns on the R1 onboarding build on staging, then lists what
production needs later. When you finish, a staff invite on staging reaches a
real inbox, the provider's answers, SSN, logins and documents land on her
record at Submit, and staff can Admit her into case generation.

Steps marked **PM only** change a hosted project's schema, secrets, settings
or code. Agents never do them. The step 1 checks are read-only, and an agent
you direct through the Supabase MCP can run them for you. Step 6 needs a real
inbox, so you walk it yourself.

`data-map.md` says what each datum is and where it lands. CLAUDE.md
(Database, repo-only migrations) lists the migrations and their verify
queries.

## Order matters

Apply the ten migrations on a database **before** the code that calls them
runs against it. Every invite route calls `intake_paused()` and every intake
route `intake_link_paused()` before it writes, so code deployed ahead of the
migrations answers 500 on all of them. The rest of the app keeps working without the migrations. It reads no
open journeys, shows no Onboarding card, and generates as before.

Do not use `supabase db push`. It applies every repo-only migration, including
`20260810120000_purge_unreferenced_catalog_payers.sql`, which needs a second
PM sign-off, and `20261017120000_case_creation_primary_location.sql`, which
needs PM sign-off. Apply each R1 file on its own.

## Staging

Staging is Supabase project `vmznysvietfaddakkegt` and Vercel project
`prj_1t7NkRJMkjTuFXEBEP4GjfN4B6Ch`.

### 1. Check the prerequisites

Run these in the staging SQL editor. Each must return what its comment says.

```sql
-- Slice 1 (applied 2026-10-30).
SELECT count(*) FROM pg_proc WHERE proname = 'verify_intake_code';          -- 1
-- Mission Control M3: five R1 files call this function.
SELECT to_regprocedure('public.apply_offboarded_write_freeze()');            -- not null
-- Cancel reads both tables.
SELECT to_regclass('private.enrollment_scopes'),
       to_regclass('public.provider_field_verifications');                  -- both not null
-- The SSN key, from Vault or the GUC. Shows true or false, never the key.
SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'ssn_vault_key')
    OR coalesce(current_setting('app.settings.ssn_vault_key', true), '') <> ''; -- true
```

If the write-freeze function is missing, apply Mission Control M1 and M3
first, in the order CLAUDE.md gives. If a table is missing, stop and ask
engineering.

### 2. Create the portal login key (PM only)

CAQH and PECOS passwords are encrypted under their own key, never the SSN key
(PM decision 9).

1. Generate a key on your machine: `openssl rand -base64 32`.
2. Keep a copy wherever Minted keeps the SSN key. A lost key makes every
   stored login unreadable.
3. In the staging project, create a Vault secret named
   `portal_credentials_key` with that value. Use Project Settings, Vault, Add
   new secret, or run this in the SQL editor:

   ```sql
   SELECT vault.create_secret('<the key>', 'portal_credentials_key');
   ```

4. Never reuse the SSN key's value. The secrets smoke in step 3 fails if the
   two keys match.

### 3. Apply the ten migrations, in order (PM only)

For each file, in this order:

1. Apply the file from `supabase/migrations/` (the SQL editor, or the
   Supabase MCP `apply_migration`).
2. Run its verify queries and compare each result with its comment.
3. Go on only when they pass.

Then, once all ten are applied, run each file's smoke from `scripts/sql/`, in
the order below, as the `postgres` user. Paste the file into the SQL editor,
or use `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/<smoke>.sql`.
Each smoke is one transaction that ends in `ROLLBACK`, so it leaves no rows.
Any failed check raises and stops it. The smokes wait for the tenth file
because it changes what the secrets, cancel and staff smokes check, so those
three fail before it is applied.

An MCP apply records its own ledger version, not the filename. Verify the
objects, not the ledger.

**`20261106200000_provider_onboardings.sql`**, then
`provider-onboarding-smoke.sql`.

```sql
SELECT to_regclass('public.provider_onboardings'),
       to_regclass('public.provider_intake_settings');                       -- both not null
SELECT count(*) FROM information_schema.columns
 WHERE table_name IN ('provider_intake_invites', 'provider_intake_codes')
   AND column_name IN ('onboarding_id', 'delivery');                         -- 3
SELECT count(*) FROM pg_proc WHERE proname IN ('intake_paused',
  'record_intake_email_delivery', '_match_onboarding_provider',
  'revoke_intake_on_provider_change');                                      -- 4
SELECT tgname FROM pg_trigger
 WHERE tgrelid = 'public.providers'::regclass
   AND tgname = 'revoke_intake_on_provider_change';                         -- 1 row
```

**`20261106210000_provider_intake_drafts.sql`**, then
`provider-intake-drafts-smoke.sql`.

```sql
SELECT to_regclass('public.provider_intake_drafts'),
       to_regclass('public.provider_intake_consents');                       -- both not null
SELECT count(*) FROM pg_proc WHERE proname IN ('_intake_session_context',
  'read_intake_state', 'save_intake_draft', 'sign_intake_consent');          -- 4
```

**`20261106220000_provider_intake_secrets.sql`**, then
`provider-intake-secrets-smoke.sql`. This smoke needs both Vault secrets.

```sql
SELECT to_regclass('public.provider_portal_credentials');                   -- not null
SELECT count(*) FROM pg_proc WHERE proname IN ('_portal_credentials_key',
  'store_intake_ssn', 'store_intake_portal_login',
  'reveal_portal_credential');                                              -- 4
```

**`20261106230000_provider_intake_uploads.sql`**, then
`provider-intake-uploads-smoke.sql`.

```sql
SELECT to_regclass('public.provider_intake_uploads');                       -- not null
SELECT id, public, file_size_limit FROM storage.buckets
 WHERE id = 'provider-intake-uploads';                                      -- f, 26214400
SELECT count(*) FROM pg_proc WHERE proname IN ('begin_intake_upload',
  'read_intake_upload', 'finish_intake_upload', 'remove_intake_upload',
  'set_intake_upload_expiry');                                              -- 5
```

**`20261106233000_provider_intake_submit.sql`**, then
`provider-intake-submit-smoke.sql`.

```sql
SELECT count(*) FROM pg_proc WHERE proname IN ('submit_provider_intake',
  'request_intake_help');                                                   -- 2
SELECT pg_get_functiondef('public.read_intake_state(text, text)'::regprocedure)
  LIKE '%held_object_paths%';                                               -- t
```

**`20261107000000_cancel_provider_onboarding.sql`**, then
`provider-onboarding-cancel-smoke.sql`. This smoke needs both Vault secrets.

```sql
SELECT count(*) FROM pg_proc WHERE proname = 'cancel_provider_onboarding';  -- 1
```

**`20261107010000_provider_onboarding_staff.sql`**, then
`provider-onboarding-staff-smoke.sql`. This smoke needs both Vault secrets.

```sql
SELECT to_regclass('public.provider_onboarding_checks');                    -- not null
SELECT count(*) FROM information_schema.columns
 WHERE table_name = 'provider_onboardings'
   AND column_name = 'first_signed_in_at';                                  -- 1
SELECT count(*) FROM pg_proc WHERE proname IN ('record_onboarding_check',
  'mark_onboarding_contacted', 'admit_provider_onboarding',
  'read_provider_onboarding', '_onboarding_for_writer');                    -- 5
SELECT position('first_signed_in_at' IN prosrc) > 0
  FROM pg_proc WHERE proname = 'verify_intake_code';                        -- true
```

**`20261107020000_cases_wait_for_onboarding_admit.sql`**, then
`provider-onboarding-generation-smoke.sql`. This smoke needs both Vault
secrets.

```sql
SELECT tgname FROM pg_trigger
 WHERE tgrelid = 'public.credential_cases'::regclass
   AND tgname = 'block_case_until_onboarding_admitted';                     -- 1 row
```

**`20261107030000_read_provider_onboarding_missing_is_null.sql`**, then
`provider-onboarding-staff-smoke.sql` again. This smoke needs both Vault
secrets.

```sql
SELECT prosrc NOT LIKE '%onboarding_not_found%' FROM pg_proc
 WHERE proname = 'read_provider_onboarding';                                -- true
```

**`20261107040000_onboarding_review_fixes.sql`**, then
`provider-onboarding-cleanup-smoke.sql`. It pauses an offboarded org's intake
links, keeps the consent evidence on a Cancel that deletes the record, names
the admin on a login reveal, and adds the list the onboarding file cleanup
job deletes from.

```sql
SELECT count(*) FROM pg_proc WHERE proname IN ('intake_link_paused',
  'onboarding_orphan_files');                                               -- 2
SELECT prosrc LIKE '%consents%' FROM pg_proc
 WHERE proname = 'cancel_provider_onboarding';                              -- true
SELECT prosrc LIKE '%user_name%' FROM pg_proc
 WHERE proname = 'reveal_portal_credential';                                -- true
```

After the last file, confirm that every new tenant table is under the
offboarded write freeze, and that intake is not paused:

```sql
SELECT public.apply_offboarded_write_freeze();                              -- {}
SELECT paused FROM public.provider_intake_settings;                         -- f
```

### 4. Set the env vars on the staging Vercel project (PM only)

Set them in the Vercel UI on the staging project, under the Preview scope it
uses for every variable. Never set them in `vercel.json`, because its env block
is shared by both projects. A change reaches only deployments made after it.

| Variable               | Value                                                                                                                                                                                                                                                                                                                  | New in R1 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SENDGRID_API_KEY`     | The restricted Mail Send key (set for slice 1, so confirm it)                                                                                                                                                                                                                                                          | No        |
| `SENDGRID_FROM_EMAIL`  | An address on Minted's authenticated domain (confirm it)                                                                                                                                                                                                                                                               | No        |
| `APP_BASE_URL`         | The staging origin providers open, a bare `https` origin with no path (confirm it)                                                                                                                                                                                                                                     | No        |
| `SENDGRID_SANDBOX`     | Unset to deliver. `true` accepts mail without delivering it                                                                                                                                                                                                                                                            | No        |
| `ONBOARDING_OPS_EMAIL` | The inbox told when a provider submits or asks for help. Optional. Unset, no alert goes out, and the provider note is still written                                                                                                                                                                                    | Yes       |
| `CRON_SECRET`          | The bearer the daily Vercel crons send (set for the follow-up digest, so confirm it). Unset, `/api/jobs/onboarding-file-cleanup` answers 503 and the files onboarding leaves behind stay. Vercel runs crons on a production deployment only, so try the job on staging with `curl -H "Authorization: Bearer <secret>"` | No        |

Never set `SENDGRID_API_URL`. It works only under `vite dev`, for the local
capture server.

### 5. Deploy the code to staging (PM only)

Deploy the `main` commit that holds this work the way staging is deployed
today. `staging` is a fast-forward of an admitted `main` commit
(`docs/ops/environment-architecture.md` §4). Deploy only after every smoke in
step 3 passed.

### 6. Walk the flow on staging

Use a staff login with the admin role in a demo org, and your own inbox. Use
made-up values only. An SSN must look real to pass the form's check. The first
three digits are not `000`, `666` or 9xx, the middle two are not `00` and the
last four are not `0000`.

1. On `/providers`, choose **Invite provider**. Enter your name and address,
   a group, and an NPI and start date if you like. The toast says the invite
   was sent.
2. Open the email, choose **Get started**, then **Send me a code**. Enter the
   code from the second email.
3. Sign the consent with your typed name and the checkbox.
4. Fill part of the form. Close the tab, open the link again and sign in. Your
   answers come back where you left them.
5. Enter an SSN and the CAQH and PECOS logins. Each says it is on file. When
   you sign in again, the SSN shows only its last 4.
6. On the documents screen, upload a CV and one license copy for each license
   state (PDF, PNG or JPEG, 10 MB at most). Remove one and upload it again.
7. Choose **I need help** once. On the provider record, the Onboarding card
   says it is waiting on the practice until you choose **Mark contacted**.
8. Submit. You land on thank you, and a confirmation email arrives. With
   `ONBOARDING_OPS_EMAIL` set, that inbox gets an alert.
9. On the provider record, check that her answers, licenses and documents are
   on the record, the card shows the Verification block, and Readiness is
   hidden.
10. Choose **Test…** on a login, give a reason, and record whether it worked.
    Confirm the CAQH attestation check.
11. On `/generation`, find her under the providers not generating, with
    "Onboarding not finished". Her group needs an active payer target for her
    to appear there.
12. Choose **Admit & assign** and pick a location. The card collapses to one
    line, Readiness comes back, and `/generation` no longer holds her for
    onboarding.
13. Invite a second made-up provider, then choose **Cancel** on that card
    before Submit. The record is removed.
14. Optional. Run `UPDATE public.provider_intake_settings SET paused = true;`
    and open an invite link. Every intake request answers 503
    `intake_paused`, and the page shows **This form is paused for now**. Set
    `paused` back to `false`.

## Production, later

Production waits until the PM signs off the decisions R1 rests on. They are
still pending in the PM decisions doc, and `data-map.md` lists them. Then:

1. **PM only.** Apply slice 1 (`20261025120000`), Mission Control M1 and M3,
   and the ten R1 files on production (`fkvuhfsqcmujywzgczmc`), in that
   order. None of them is verified on production yet. Run the step 1
   prerequisite checks and each file's verify queries there.
2. The smokes are written for a local stack and staging. They insert
   synthetic rows and roll them back. Whether to run them on production is
   the PM's call.
3. **PM only.** Create `portal_credentials_key` in the production Vault, with
   a new value. It must differ from production's SSN key and from the
   staging key. Confirm production has an SSN key.
4. **PM only.** On the production Vercel project
   (`prj_ILhPJbkyaiptdVA8DtsmNyw3tiub`), set `SENDGRID_API_KEY`,
   `SENDGRID_FROM_EMAIL`, `APP_BASE_URL` (the production origin providers
   open) and, if wanted, `ONBOARDING_OPS_EMAIL`.
5. Confirm SendGrid domain authentication for the `SENDGRID_FROM_EMAIL`
   domain by checking SPF and DKIM on a delivered message
   (`slice-1-invite-to-form.md` §9).
6. **PM only.** Release the code to production only after steps 1 to 4. A
   release before them leaves the invite, intake and cancel routes answering
   500 there.
