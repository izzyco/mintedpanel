# How to verify provider onboarding on your machine

This runbook checks the whole onboarding build on a local Supabase stack. You
run the automated checks, then walk the flow by hand as a staff member and as
the provider. Nothing here touches a hosted project or sends a real email.

`data-map.md` says what each datum is and where it lands. Each step of the
walk below names the `data-map.md` section that shows its result. Run every
command from the repo root, and use the URLs the scripts print.

## 1. Set up the stack

1. Start Docker Desktop and wait until it says it is running.
2. Build the stack, then follow what it prints:

   ```sh
   bash scripts/e2e/local-stack-setup.sh
   ```

   The first run pulls Docker images, which takes a few minutes. Rerun it
   after you pull new migrations. A rerun applies only the new ones and keeps
   your data.

3. Start the app on the stack:

   ```sh
   bash scripts/e2e/onboarding-local-stack.sh --serve
   ```

   It prints the app URL, the staff login, the inbox URL and the database
   URL, then stays up. It makes, or finds from an earlier run, the practice
   **Local Rehab** with the group **Local Group**, the NC location **Charlotte
   Clinic** and the payer **Local Payer**. The app's email goes to the inbox,
   not to SendGrid. Leave this terminal open. Ctrl-C stops the app and the
   inbox, and the stack keeps running.

4. In a second terminal, open `psql` on the database URL it printed. No query
   on this page prints an SSN, a password, a token or a code.

## 2. Run the automated checks

Each check is independent. A failure names the file and the check that failed.
`docs/VERIFY.md` §6 holds the smoke, gate and local-stack commands.

1. Unit tests: `npx vitest run`. A pass ends with `Test Files  N passed (N)`
   and no failed line.
2. Types: `npx tsc --noEmit`. A pass prints nothing and exits 0.
3. Lint: `npm run lint`. A pass ends with `(0 errors, N warnings)`. The
   warnings are older than onboarding.
4. SQL smokes, all ten against the local database:

   ```sh
   for f in scripts/sql/provider-*-smoke.sql; do
     psql "<database URL>" -X -q -v ON_ERROR_STOP=1 -f "$f" || echo "FAILED $f"
   done
   ```

   A pass prints ten `NOTICE: ... smoke: all checks passed` lines and no
   `FAILED` line.

5. Isolation gate. A pass prints `OK` on every line and ends with
   `RESULT: PASS`.
6. Mock browser tests. They start their own dev server on port 8080, so stop
   any dev server on 8080 first. `CI=1` makes Playwright refuse to reuse one:

   ```sh
   CI=1 npx playwright test e2e/provider-intake.spec.ts e2e/provider-onboarding-preview.spec.ts \
     e2e/provider-onboarding-staff.spec.ts e2e/decoupled-generation.spec.ts e2e/case-creation.spec.ts
   ```

   A pass ends with `N passed` and no failed or flaky line.

7. The local-stack run. It uses the same ports as `--serve`, so stop the
   `--serve` terminal first. A pass ends with `8 passed`.

## 3. Walk onboarding by hand

Staff work in a normal window. The provider works in a private window, so her
intake cookie and the staff login never mix. Keep a tab on the inbox and
reload it to see new mail. You invite three made-up providers. Anita Rao
(`anita@local.test`) goes all the way to a case, Ben Cole (`ben@local.test`)
is cancelled, and Cara Diaz (`cara@local.test`) asks for help. To walk the
flow again, reset the stack (section 4) or invite new addresses.

1. Sign in to the app as the staff login `--serve` printed.
2. On **Providers**, choose **Invite provider** and invite Anita Rao,
   `anita@local.test`, in **Local Group**. See The journey and Invite.
3. In the inbox, open the newest mail to Anita and copy its **Get started**
   link. See Invite, "Invite email outcome".
4. In a private window, open the link, choose **Send me a code**, type a wrong
   code, then the code from the inbox. See Sign-in.
5. Sign the consent as `Anita Rao`. See Consent.
6. Fill the form with NPI `1987654328`, specialty Physical Therapist (`225100000X`), SSN
   `123-45-6789`, an NC license and both logins. See Form answers and Secrets.
7. Choose **Finish later**, open the link in a new private window and sign in
   again. Her answers, the SSN's last 4 and both logins come back. See Form
   answers, "Where she was (form or documents)".
8. Choose **Continue**, upload a PDF to **CV** and to **NC license copy**, then
   remove the CV and upload another. See Documents.
9. Choose **Submit**, then run the audit query below. See Help, Submit and
   hand-off, "Submit" and "Ops alert (Submit or help)".
10. On her record, choose **Test…** on the CAQH login row, give a reason and
    choose **It works**. Confirm the CAQH attestation check. See Staff side.
11. Go to **Generation**. Anita is held with "Onboarding not finished". See
    Case creation waits for Admit.
12. Choose **Admit & assign** and pick **Charlotte Clinic**. See Help, Submit
    and hand-off, "Admit and location", and What revokes access, "Admit".
13. On **Generation**, choose **Confirm & create 1 case**. Her card says **In
    credentialing**. See Staff side.
14. Invite Ben Cole, `ben@local.test`, then choose **Cancel invitation** on his
    card. See Cancel.
15. Invite Cara Diaz, `cara@local.test`. As her, sign in, sign the consent and
    choose **I need help**. On her card, choose **Mark contacted**. See Help,
    Submit and hand-off, "Help request" and "Practice contacted".
16. Run `UPDATE public.provider_intake_settings SET paused = true;` and open
    Cara's link. It shows **This form is paused for now**. Set `paused` back
    to `false`. See What revokes access.

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

After Submit, expect "Provider submitted the onboarding form", "Provider record
updated from the onboarding form" with the changed columns and
`state_licenses`, two "Document added from the provider onboarding form" rows,
and the earlier sign-in, consent, vault and login rows. After step 10 the
reveal is one `READ` row, "Portal login revealed (admin click-to-reveal)", with
`justification` among its keys.

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
