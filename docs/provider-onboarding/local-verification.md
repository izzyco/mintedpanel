# How to verify provider onboarding on your machine

This runbook checks the whole onboarding build on a local Supabase stack. You
run the automated checks, then walk the flow by hand as a staff member and as
the provider, and after each step you query the database to see what landed
where. Nothing here touches a hosted project or sends a real email.

`data-map.md` says what each datum is and where it lands. This page shows you
the same thing on a running stack.

All commands run from the repo root. The ports below are the defaults. If you
pass `--port-base` to the setup script, use the ports it prints.

## 1. Set up the stack

1. Start Docker Desktop and wait until it says it is running.
2. Build the stack:

   ```sh
   bash scripts/e2e/local-stack-setup.sh
   ```

   The first run pulls Docker images, which takes a few minutes. With the
   images already pulled, a start from zero took 25 seconds here. It ends
   with:

   ```
   The local stack is ready.
     API     http://127.0.0.1:55421
     DB      postgresql://postgres:postgres@127.0.0.1:55422/postgres
     Studio  http://127.0.0.1:55423
   ```

   The script keeps its own Supabase project in `~/.minted-local-supabase`,
   because the repo's `supabase/config.toml` can't start a local stack
   (CLAUDE.md, Known warts). It links the repo's migrations there, creates
   the Vault secrets `ssn_vault_key` and `portal_credentials_key` with random
   values, and runs the local-only auth grants. Rerun it after you pull new
   migrations. A rerun applies only the new ones and keeps your data.

3. Start the app on the stack:

   ```sh
   SUPABASE_WORKDIR=~/.minted-local-supabase bash scripts/e2e/onboarding-local-stack.sh --serve
   ```

   When the app is up, it prints:

   ```
   Minted Panel is running on the local stack.
     App     http://127.0.0.1:8091/login
     Staff   staff@local.test / local-staff-password (admin of Local Rehab)
     Inbox   http://127.0.0.1:8092/ (every email the app sends, newest first)
     Studio  http://127.0.0.1:55423
     DB      psql "postgresql://postgres:postgres@127.0.0.1:55422/postgres"
   ```

   It made, or found from an earlier run, the practice **Local Rehab** with
   the group **Local Group** (TIN 56-1234567), the NC location **Charlotte
   Clinic**, the payer **Local Payer** with an NC network target, and a
   Local Payer enrollment SOP. The app's email goes to the inbox server, not
   to SendGrid. Leave this terminal open. Ctrl-C stops the app and the inbox,
   and the stack keeps running.

4. In a second terminal, open a database session for the queries below:

   ```sh
   psql "postgresql://postgres:postgres@127.0.0.1:55422/postgres"
   ```

   You can paste the same queries into the Studio SQL editor instead. No
   query on this page prints an SSN, a password, a token or a code.

## 2. Run the automated checks

Each check is independent. A failure names the file and the check that failed.

1. Unit tests: `npx vitest run`. A pass ends with `Test Files  N passed (N)`
   and no failed line.
2. Types: `npx tsc --noEmit`. A pass prints nothing and exits 0.
3. Lint: `npm run lint`. A pass ends with `(0 errors, N warnings)`. The
   warnings are older than onboarding.
4. SQL smokes. Each smoke is one transaction that ends in `ROLLBACK`, so it
   leaves no rows:

   ```sh
   for f in scripts/sql/provider-*-smoke.sql; do
     psql "postgresql://postgres:postgres@127.0.0.1:55422/postgres" -X -q -v ON_ERROR_STOP=1 -f "$f" || echo "FAILED $f"
   done
   ```

   A pass prints ten `NOTICE: ... smoke: all checks passed` lines, one per
   file, and no `FAILED` line. `docs/VERIFY.md` §6 maps each smoke to its
   migration.

5. Isolation gate: `node scripts/verify-isolation-local.mjs`. It runs the
   gate against a mock server, once correct and once per leak mode. A pass
   prints `OK` on every line and ends with `RESULT: PASS`.
6. Mock browser tests. They start their own dev server on port 8080, so stop
   any dev server on 8080 first. `CI=1` makes Playwright refuse to reuse one:

   ```sh
   CI=1 npx playwright test e2e/provider-intake.spec.ts e2e/provider-onboarding-preview.spec.ts \
     e2e/provider-onboarding-staff.spec.ts e2e/decoupled-generation.spec.ts e2e/case-creation.spec.ts
   ```

   A pass ends with `N passed` (56 on Nov 7) and no failed or flaky line.

7. The real-stack test. It walks the same flow as section 3 in a real browser
   against your stack, under its own practice, staff user and payer, so it
   never touches Local Rehab. It uses the same ports and log folder as
   `--serve`, so stop the `--serve` terminal first:

   ```sh
   SUPABASE_WORKDIR=~/.minted-local-supabase bash scripts/e2e/onboarding-local-stack.sh
   ```

   A pass ends with `8 passed`. Screenshots go to
   `test-results/onboarding-local-stack/screens/`.

## 3. Walk onboarding by hand

Use two browser windows. Staff work in a normal window. The provider works
in a private window, so her intake cookie and the staff login never mix.
Keep a third tab on the inbox, `http://127.0.0.1:8092/`, and reload it to see
new mail.

You invite three made-up providers:

- Anita Rao, `anita@local.test`, goes all the way to a case.
- Ben Cole, `ben@local.test`, asks for help.
- Cara Diaz, `cara@local.test`, is cancelled.

The queries filter on those addresses. To walk the flow again, reset the stack
(section 4) or invite new addresses and change them in the queries too. An
invite to an address already in the group finds the record and sends no
email.

### 3.1 Sign in as staff and invite Anita

1. In the normal window, open `http://127.0.0.1:8091/login`.
2. Sign in as `staff@local.test` with the password `local-staff-password`.
3. Go to **Providers** and choose **Invite provider**.
4. Enter First name `Anita`, Last name `Rao`, Email `anita@local.test`, and
   Group **Local Group**. Choose **Send invite**.

You see the toast "Invite sent to anita@local.test". Open her record from the
roster. The **Onboarding** card is at the top. Its tracker is on **Invited**,
Waiting on says "Anita · invited, hasn't signed in yet", Record says "Created
by this invitation", and the resend button reads "Sent · resend in 10 min".

The invite created her record, her primary group assignment and her journey:

```sql
SELECT p.first_name, p.last_name, p.status, po.created_record, po.source,
       po.opened_at, i.delivery, i.expires_at, i.revoked_at
  FROM public.providers p
  JOIN public.provider_onboardings po ON po.provider_id = p.id
  JOIN public.provider_intake_invites i ON i.onboarding_id = po.id
 WHERE p.email = 'anita@local.test';

SELECT g.name AS group_name, a.is_primary
  FROM public.provider_group_assignments a
  JOIN public.provider_groups g ON g.id = a.group_id
  JOIN public.providers p ON p.id = a.provider_id
 WHERE p.email = 'anita@local.test';
```

Expect one journey with `created_record = t`, `source = staff`,
`delivery = sent` and no `revoked_at`, and one primary assignment to Local
Group. The link token is stored only as a hash in
`provider_intake_invites.token_hash`.

### 3.2 Read the invite email

Reload the inbox tab. The newest message is to `anita@local.test`, subject
"Welcome to Local Rehab: your credentialing form". Its body has a line
`Get started: http://127.0.0.1:8091/intake/<token>`. Copy that link.

### 3.3 Sign in as the provider, with a wrong code first

1. In the private window, open the link. You see **Confirm it's you** with
   her address.
2. Choose **Send me a code**. You see **Enter your code**.
3. Reload the inbox. The newest message is "Your sign-in code for Local
   Rehab", with "Your code is NNNNNN" in the body.
4. Type a different six digits into **6-digit code**. You see "That code
   didn't work" with "4 tries left".
5. Type the right code. The form continues by itself to **Your consent**.

On the staff record, reload the page. The tracker moves to **Started** and
Waiting on says "signed in, not submitted".

```sql
SELECT c.created_at, c.delivery, c.attempts, c.consumed_at IS NOT NULL AS used
  FROM public.provider_intake_codes c
  JOIN public.provider_intake_invites i ON i.id = c.invite_id
 WHERE i.email = 'anita@local.test'
 ORDER BY c.created_at;

SELECT s.created_at, s.expires_at, s.revoked_at
  FROM public.provider_intake_sessions s
  JOIN public.provider_intake_invites i ON i.id = s.invite_id
 WHERE i.email = 'anita@local.test'
 ORDER BY s.created_at;

SELECT po.first_signed_in_at
  FROM public.provider_onboardings po
  JOIN public.providers p ON p.id = po.provider_id
 WHERE p.email = 'anita@local.test';
```

Expect one code with `attempts = 2` (the wrong try and the right one) and
`used = t`, one live session, and `first_signed_in_at` set. The code and the
session cookie are stored only as hashes.

### 3.4 Sign the consent

Type `Anita Rao` under **Type your full name to sign**, tick the checkbox, and
choose **Sign and continue**. You see **Your credentialing details**.

```sql
SELECT ic.typed_name, ic.text_version, ic.signed_at, po.consented_at
  FROM public.provider_intake_consents ic
  JOIN public.provider_onboardings po ON po.id = ic.onboarding_id
  JOIN public.providers p ON p.id = po.provider_id
 WHERE p.email = 'anita@local.test';
```

Expect one row with `typed_name = Anita Rao`, `text_version = 1`, and
`consented_at` equal to `signed_at`.

### 3.5 Fill the form

Fill these, leaving each field before the next:

| Field                  | Value                                           |
| ---------------------- | ----------------------------------------------- |
| NPI                    | `1987654328` (it passes the check digit)        |
| Specialty              | Search `Physical Therapist`, pick `225100000X`  |
| Date of birth          | `04/01/1990`                                    |
| CAQH ID                | `12345678`                                      |
| Social Security number | `123-45-6789`                                   |
| Mobile phone           | `(704) 555-0100`                                |
| Home address           | `18 Elm St`, `Charlotte`, state NC, ZIP `28203` |
| State license          | State NC, number `PT-48213`, expires 12/31/2027 |
| CAQH ProView login     | Username `anita.caqh`, any password             |
| PECOS login            | User ID `ARAO77`, any password                  |

When you leave the SSN field, the SSN goes straight to the vault. When you leave a
login's password, the login is saved and the fields turn into a **Change your
… login** button. The status line reads **Saved** about a second after you
stop typing.

On the staff record, reload. Saved so far lists the consent, "SSN on file" and
"CAQH and PECOS logins on file".

The answers are in the draft, and the SSN and the passwords are not:

```sql
SELECT d.version, d.step, d.updated_at,
       d.answers ->> 'npi' AS npi, d.answers ->> 'homeZip' AS zip,
       (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(d.answers) k) AS answer_keys,
       position('123456789' IN d.answers::text) = 0
         AND position('123-45-6789' IN d.answers::text) = 0 AS no_ssn_in_draft
  FROM public.provider_intake_drafts d
  JOIN public.provider_onboardings po ON po.id = d.onboarding_id
  JOIN public.providers p ON p.id = po.provider_id
 WHERE p.email = 'anita@local.test';
```

Expect `no_ssn_in_draft = t` and keys such as `npi`, `licenses` and
`taxonomyCode`, but no SSN or password key. `version` goes up by one on each
save.

The SSN is encrypted in the vault, and the record keeps only the last 4. This
query reports the ciphertext's size and never decrypts it:

```sql
SELECT p.ssn_last4, po.ssn_stored_at, v.algo, v.key_version,
       octet_length(v.ssn_ciphertext) AS ciphertext_bytes,
       position(convert_to('123456789', 'UTF8') IN v.ssn_ciphertext) = 0 AS not_plain_text
  FROM public.providers p
  JOIN public.provider_onboardings po ON po.provider_id = p.id
  LEFT JOIN public.provider_ssn_vault v ON v.provider_id = p.id
 WHERE p.email = 'anita@local.test';
```

Expect `ssn_last4 = 6789` and `not_plain_text = t`.

The logins keep the username in the clear and the password under the
`portal_credentials_key` secret:

```sql
SELECT c.portal, c.username, c.key_version,
       octet_length(c.password_ciphertext) AS ciphertext_bytes,
       c.onboarding_id = po.id AS from_this_journey, c.updated_at
  FROM public.provider_portal_credentials c
  JOIN public.providers p ON p.id = c.provider_id
  JOIN public.provider_onboardings po ON po.provider_id = p.id
 WHERE p.email = 'anita@local.test'
 ORDER BY c.portal;
```

Expect two rows, `caqh` and `pecos`, both `from_this_journey = t`.

### 3.6 Finish later, then come back

1. Choose **Finish later**. You see **You're signed out**.
2. Close the private window. Open a new private window and open the invite
   link again.
3. Choose **Send me a code**, read the new code in the inbox, and type it.

You land on **Your credentialing details** with every answer back. The SSN
field shows `•••-••-6789`, and each login shows its **Change** button. They
came from the server, because the new window held nothing.

Run the sessions and codes queries from 3.3 again. Expect the first session
with `revoked_at` set by Finish later, a second live session, and a second
code with `used = t`.

### 3.7 Upload documents, then take one back

1. Choose **Continue**. You see **Your documents**.
2. Upload a PDF to **CV** and another to **NC license copy**. Any small PDF
   works.
3. Choose **Remove CV**, then upload a different PDF to **CV**.

On the staff record, Saved so far now says "2 files uploaded".

```sql
SELECT u.slot_key, u.doc_type, u.file_name, u.size_bytes, u.content_type,
       u.finalized_at IS NOT NULL AS finished, u.removed_at IS NOT NULL AS removed
  FROM public.provider_intake_uploads u
  JOIN public.provider_onboardings po ON po.id = u.onboarding_id
  JOIN public.providers p ON p.id = po.provider_id
 WHERE p.email = 'anita@local.test'
 ORDER BY u.created_at;
```

Expect three rows. The first CV has `removed = t`. The rows stay as the trail
of what she sent. The files themselves wait in the private holding bucket:

```sql
SELECT o.bucket_id, o.name, o.metadata ->> 'size' AS bytes
  FROM public.providers p
  JOIN public.provider_onboardings po ON po.provider_id = p.id
  JOIN storage.objects o
    ON o.bucket_id IN ('provider-intake-uploads', 'provider-documents')
   AND (o.name LIKE 'org/' || po.org_id || '/onboarding/' || po.id || '/%'
     OR o.name LIKE 'org/' || po.org_id || '/provider/' || p.id || '/%')
 WHERE p.email = 'anita@local.test'
 ORDER BY o.bucket_id, o.name;
```

Expect two objects in `provider-intake-uploads` and none in
`provider-documents`. Remove deleted the first CV's object.

### 3.8 Submit

Choose **Submit**. The heading **Thank you for submitting!** appears. Reload
the page and you see **You've already sent your form**. The inbox has "Local Rehab has your
credentialing details" for Anita, and an alert to `ops@example.test` with a
link to her record.

On the staff record, reload. The tracker is on **Submitted**, Waiting on says
"Minted · submitted …, ready for review", and the card shows the
**Verification** block in place of Saved so far.

Her answers are now on her record:

```sql
SELECT first_name, last_name, npi, taxonomy_code, date_of_birth, caqh_id, phone,
       home_street, home_city, home_state, home_zip, ssn_last4, status
  FROM public.providers
 WHERE email = 'anita@local.test';

SELECT l.state, l.license_number, l.expiration_date, l.verified_status
  FROM public.state_licenses l
  JOIN public.providers p ON p.id = l.provider_id
 WHERE p.email = 'anita@local.test';

SELECT d.doc_type, d.file_name, d.expiration_date, d.version_number, d.file_path
  FROM public.provider_documents d
  JOIN public.providers p ON p.id = d.provider_id
 WHERE p.email = 'anita@local.test'
 ORDER BY d.doc_type;

SELECT po.submitted_at, po.submitted_email_delivery
  FROM public.provider_onboardings po
  JOIN public.providers p ON p.id = po.provider_id
 WHERE p.email = 'anita@local.test';
```

Expect the form's values on `providers`, one NC license expiring
2027-12-31, two documents (`cv` and `state_license`, the license copy with the
license's expiry), and `submitted_email_delivery = sent`. Run the storage
query from 3.7 again. The two files are now in `provider-documents`, and the
holding bucket is empty.

The audit trail holds one row per event, never a value. This query lists the
practice's latest rows, and for each one the names of the fields it recorded:

```sql
SELECT a.ts, a.action_type, a.entity_type, a.user_name, a.description,
       (SELECT string_agg(k, ', ' ORDER BY k)
          FROM jsonb_object_keys(CASE WHEN jsonb_typeof(a.after) = 'object'
                                      THEN a.after ELSE '{}' END) k) AS after_keys
  FROM public.audit_log a
  JOIN public.organizations o ON o.id = a.org_id
 WHERE o.name = 'Local Rehab'
 ORDER BY a.ts DESC
 LIMIT 20;
```

Expect "Provider submitted the onboarding form", "Provider record updated
from the onboarding form" with the changed columns and `state_licenses`, two
"Document added from the provider onboarding form" rows, and the earlier
sign-in, consent, vault and login rows.

### 3.9 Test a login and confirm a check

1. In the Verification list, on the **CAQH login works** row, choose
   **Test…**.
2. Type a reason, such as `Checking before Admit`, and choose **Show login**.
   The username and password show for a minute.
3. Choose **It works**.
4. On the **CAQH attested within 120 days** row, choose **Confirm**.

```sql
SELECT c.check_key, c.outcome, c.checked_by_name, c.checked_at, c.note IS NOT NULL AS has_note
  FROM public.provider_onboarding_checks c
  JOIN public.provider_onboardings po ON po.id = c.onboarding_id
  JOIN public.providers p ON p.id = po.provider_id
 WHERE p.email = 'anita@local.test'
 ORDER BY c.checked_at;
```

Expect `caqh_login` and `caqh_attestation`, both `confirmed` by Sam Staff.
Run the audit query from 3.8 again. The reveal is one `READ` row, "Portal
login revealed (admin click-to-reveal)", by Sam Staff, with `justification`
among its keys.

### 3.10 See generation hold her

Go to **Generation**. Anita is not a candidate. In the list of providers not
generating, her line for Local Group and Local Payer NC says "Onboarding not
finished. Admit & assign on the provider's page first", with **Open
provider**.

The database refuses her case too. This tries an insert as the staff user and
rolls it back:

```sql
BEGIN;
SELECT set_config('request.jwt.claims',
         json_build_object('sub', (SELECT id FROM auth.users WHERE email = 'staff@local.test'),
                           'role', 'authenticated')::text, true);
INSERT INTO public.credential_cases (org_id, provider_id, group_id, payer_id, state)
SELECT p.org_id, p.id, g.id, py.id, 'NC'
  FROM public.providers p
  JOIN public.provider_groups g ON g.org_id = p.org_id AND g.name = 'Local Group'
  JOIN public.payers py ON py.org_id IS NULL AND py.name = 'Local Payer'
 WHERE p.email = 'anita@local.test';
ROLLBACK;
```

Expect `ERROR: onboarding_not_admitted`, and a DETAIL line that says "This
provider's onboarding isn't finished. Admit & assign on the provider's page
before creating a case."

### 3.11 Admit & assign

1. On the card, choose **Admit & assign**.
2. Pick the location **Charlotte Clinic · Charlotte, NC** and choose **Admit &
   assign**.

You see "Anita was admitted and assigned to Charlotte Clinic.". The card
collapses to one line, "Admitted … by Sam Staff · … · Ready for
credentialing", with no buttons. Open her link in the private window again.
It shows **This invitation is no longer valid**.

```sql
SELECT po.admitted_at, u.email AS admitted_by, f.name AS location
  FROM public.provider_onboardings po
  JOIN public.providers p ON p.id = po.provider_id
  LEFT JOIN auth.users u ON u.id = po.admitted_by
  LEFT JOIN public.facilities f ON f.id = po.admitted_facility_id
 WHERE p.email = 'anita@local.test';

SELECT f.name, a.is_primary, a.start_date
  FROM public.provider_facility_assignments a
  JOIN public.facilities f ON f.id = a.facility_id
  JOIN public.providers p ON p.id = a.provider_id
 WHERE p.email = 'anita@local.test';

SELECT (SELECT count(*) FROM public.provider_intake_invites i
         WHERE i.email = 'anita@local.test' AND i.revoked_at IS NULL) AS live_invites,
       (SELECT count(*) FROM public.provider_intake_sessions s
          JOIN public.provider_intake_invites i ON i.id = s.invite_id
         WHERE i.email = 'anita@local.test' AND s.revoked_at IS NULL) AS live_sessions;
```

Expect Admit by `staff@local.test` to Charlotte Clinic, one primary
assignment, and zero live invites and sessions. Run the insert from 3.10
again. It now answers `INSERT 0 1`, and the `ROLLBACK` keeps the row out.

### 3.12 Generate her case

Go to **Generation** again. Anita is now a candidate for Local Payer NC,
with her checkbox ticked, and the onboarding line is gone. Choose **Confirm &
create 1 case**. You land on **Cases**. Her record's card now says **In credentialing**.

```sql
SELECT c.case_number, c.state, c.case_status, g.name AS group_name, py.name AS payer,
       (SELECT count(*) FROM public.tasks t WHERE t.case_id = c.id) AS tasks
  FROM public.credential_cases c
  JOIN public.providers p ON p.id = c.provider_id
  JOIN public.provider_groups g ON g.id = c.group_id
  JOIN public.payers py ON py.id = c.payer_id
 WHERE p.email = 'anita@local.test';
```

Expect one NC case for Local Group and Local Payer with one task from the SOP.

### 3.13 A help request on a second invite

1. As staff, invite `Ben` `Cole`, `ben@local.test`, Group Local Group.
2. In a new private window, open his link from the inbox, sign in with his
   code, and sign the consent as `Ben Cole`.
3. On the form, choose **I need help**. You see "We've let Local Rehab know".

The inbox has an alert to `ops@example.test`. On Ben's record, Waiting on says
"The practice · Ben asked for help …", and his Internal Notes have a note from
"Provider (onboarding form)". Choose **Mark contacted** on the card.

```sql
SELECT n.created_at, n.author_id, n.content
  FROM public.notes n
  JOIN public.providers p ON p.id = n.entity_id
 WHERE n.entity_type = 'provider' AND p.email = 'ben@local.test';

SELECT po.last_help_at, po.last_contacted_at
  FROM public.provider_onboardings po
  JOIN public.providers p ON p.id = po.provider_id
 WHERE p.email = 'ben@local.test';
```

Expect one note with no author that says "Asked for help from the onboarding
form.", and both timestamps set, `last_contacted_at` after `last_help_at`.

### 3.14 Cancel a third invite

1. As staff, invite `Cara` `Diaz`, `cara@local.test`, Group Local Group.
2. Optional. Open her link in a private window, sign in and sign the
   consent, so Cancel has more to remove. Keep that window open.
3. Before you cancel, note what she has:

   ```sql
   SELECT p.id AS provider_id, po.id AS journey_id, po.first_signed_in_at,
          (SELECT count(*) FROM public.provider_intake_consents ic
            WHERE ic.onboarding_id = po.id) AS consents
     FROM public.providers p
     JOIN public.provider_onboardings po ON po.provider_id = p.id
    WHERE p.email = 'cara@local.test';
   ```

4. On her record, choose **Cancel invitation**. The dialog says the invitation
   created Cara's record, so the record is removed too. Choose **Cancel
   invitation**.

You see "Invitation cancelled. Cara's record was removed." and land on the
roster. Her link now shows **This invitation is no longer valid**.

What Cancel left behind is the audit trail and nothing else:

```sql
SELECT (SELECT count(*) FROM public.providers WHERE email = 'cara@local.test') AS providers,
       (SELECT count(*) FROM public.provider_intake_invites WHERE email = 'cara@local.test') AS invites;

SELECT a.ts, a.description, a.after ->> 'onboarding_id' AS journey_id,
       a.after -> 'consents' AS consents
  FROM public.audit_log a
  JOIN public.organizations o ON o.id = a.org_id
 WHERE o.name = 'Local Rehab' AND a.action_type = 'DELETE' AND a.entity_type = 'provider';
```

Expect zero providers and zero invites. The journey, consents, sessions,
draft and vault rows went with the record. The DELETE row names the journey
and, for each consent she signed, its text version and time, never her typed
name. The earlier audit rows for Cara stay.

### 3.15 Pause intake

1. Pause every intake link:

   ```sql
   UPDATE public.provider_intake_settings SET paused = true;
   SELECT paused FROM public.provider_intake_settings;
   ```

2. Open Ben's invite link in a private window. You see **This form is paused
   for now** with "Try again later, or contact your practice." A form that
   was already open swaps to the same notice on its next request, such as an
   autosave. While paused,
   staff invites answer "Provider invites are paused right now. Try again
   later." Cancel still works, because it only takes access away.
3. Turn intake back on:

   ```sql
   UPDATE public.provider_intake_settings SET paused = false;
   ```

## 4. Reset and clean up

- Stop the app and the inbox: Ctrl-C in the `--serve` terminal. The inbox
  keeps mail in memory only, so a restart starts it empty.
- Stop the stack and keep its data:

  ```sh
  supabase stop --workdir ~/.minted-local-supabase
  ```

  The next `bash scripts/e2e/local-stack-setup.sh` starts it again with
  everything you made.

- Wipe the stack and start over:

  ```sh
  supabase stop --no-backup --workdir ~/.minted-local-supabase
  bash scripts/e2e/local-stack-setup.sh
  ```

  `--no-backup` deletes the database volume. Setup then applies every
  migration to an empty database and makes new random Vault keys. `--serve`
  makes Local Rehab again.

- Remove it entirely: run the `supabase stop --no-backup` line, then
  `rm -rf ~/.minted-local-supabase`. The Docker images stay for the next
  setup.
