# Provider onboarding data map

Engineering source of truth for every datum on the way from a staff invite to
Admit. Built from the code as of migration `20261107040000`. Every row here
is built. CLAUDE.md lists the routes and RPCs in brief (The routes › Provider
onboarding, and Key RPCs). SCHEMA.md describes the tables (Provider
onboarding). `r1-operator-steps.md` holds the apply steps.
`local-verification.md` walks the flow on a local stack and shows each datum
landing with a SQL query.

## The journey

One `provider_onboardings` row per onboarding (one open per provider). An
invite that creates the provider opens it with `created_record = true`. A
resend with no open journey opens one with `created_record = false` and
`locked_fields` set to whichever of SSN, NPI and date of birth are on file at
that moment. Backfilled journeys (invites sent before the table existed) have
`created_record = false` and no locks. Stage and waiting-on are derived from
the timestamps, never stored (`src/lib/providerOnboarding.ts`).

"Locked" below means: on file when the journey opened, so the provider sees
the value and asks for a fix instead of typing over it (decision 3, D4).

## Invite (staff, `POST /api/provider-invites`)

| Datum                        | Who provides it  | Prefilled from | Where it lands                                                                                                                                                                | Locked rule                             | Outside API at create        | Stored where now                       |
| ---------------------------- | ---------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------- | -------------------------------------- |
| First and last name          | Staff            |                | `providers.first_name`, `last_name` on create                                                                                                                                 | Never                                   | Yes                          | `providers`                            |
| Email                        | Staff            |                | `providers.email` (lowercased) and `provider_intake_invites.email`                                                                                                            | Never; a change revokes the open invite | Yes                          | `providers`, `provider_intake_invites` |
| Group                        | Staff            |                | Primary `provider_group_assignments` row and the `providers.group_id` mirror on create; a non-primary assignment when an email or NPI match is outside the group (decision 4) | Never                                   | Yes                          | `provider_group_assignments`           |
| NPI                          | Staff (optional) |                | `providers.npi` on create                                                                                                                                                     | Locked once on file                     | Yes                          | `providers`                            |
| Start date                   | Staff (optional) |                | `providers.start_date` on create                                                                                                                                              | Never                                   | Yes                          | `providers`                            |
| Source and outside reference | The caller       |                | `provider_onboardings.source`, `external_ref`                                                                                                                                 | Never changes                           | Yes (`api`, with its own id) | `provider_onboardings`                 |
| Invite email outcome         | Server           |                | `provider_intake_invites.delivery` (sent, sandbox, failed), set once                                                                                                          |                                         | Never                        | `provider_intake_invites`              |

The match rule (`_match_onboarding_provider`) runs first. One provider with
that email or NPI in the group: nothing is written. One outside the group:
that group is added to her record and no email goes out. More than one
provider: nothing is written (409).

## Sign-in (provider, `/api/intake/*`)

| Datum         | Who provides it | Prefilled from | Where it lands                                                                                                                      | Locked rule | Outside API at create | Stored where now           |
| ------------- | --------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------- | -------------------------- |
| Link token    | Server          |                | sha256 in `provider_intake_invites.token_hash`                                                                                      |             | Never                 | `provider_intake_invites`  |
| Sign-in code  | Server          |                | sha256 in `provider_intake_codes.code_hash`; outcome in `.delivery`                                                                 |             | Never                 | `provider_intake_codes`    |
| Session       | Server          |                | sha256 in `provider_intake_sessions.token_hash`, HttpOnly cookie                                                                    |             | Never                 | `provider_intake_sessions` |
| First sign-in | Server          |                | `provider_onboardings.first_signed_in_at`, set by `verify_intake_code` on the journey's first good code; the tracker's Started step | Set once    | Never                 | `provider_onboardings`     |

Every read and write after sign-in (`state`, `draft`, `consent`, `ssn`,
`login`, `upload-intent`, `upload-finalize`, `upload-remove`, `upload-expiry`,
`submit`, `help`) resolves her journey from the session cookie and the link
together
(`_intake_session_context`): a session opened under another link, an expired
or revoked session, a revoked invite or a cancelled journey reads nothing.

Before any of that, every intake action but signout asks
`intake_link_paused` with her link's hash. It answers true while intake is
paused, and while the link's org is offboarded (any stage that is not
writable, `org_is_writable`). Then the route answers 503 `intake_paused`
before it reads or writes anything else, so an offboarded org's link sends
no code. The write freeze would refuse her sign-in there, because
`verify_intake_code` sets `first_signed_in_at`.

## Consent

| Datum                                                   | Who provides it | Prefilled from | Where it lands                                                                   | Locked rule                                                                    | Outside API at create | Stored where now                                                |
| ------------------------------------------------------- | --------------- | -------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------- |
| Typed name, checkbox, consent text version, server time | Provider        |                | `provider_intake_consents` (append-only) and `provider_onboardings.consented_at` | `consented_at` is set by the first signature; signing again appends a row only | Never                 | `provider_intake_consents`, `provider_onboardings.consented_at` |

The checkbox is required to sign and is not stored on its own: a signature
row exists only when it was checked. The text version must be the current one
(`src/lib/intakeConsent.ts`); the route refuses any other.

## Form answers (saved as she goes; merged on Submit)

Saved as a draft (`provider_intake_drafts.answers`, never the SSN or a
password) about a second after she stops typing, and before Continue, Back and
Finish later, with an optimistic version (a stale one is a 409 and the form
reloads). An answer is hers or null: a value she did not enter is never
copied into the draft, so a later staff edit is not overwritten by a stale
copy. `save_intake_draft` drops the key of any field locked on the journey.
On Submit (`submit_provider_intake`) each answer she gave overwrites its
column (decision 3, D7), except a locked field, which the RPC drops again.
Email and status are never touched. One UPDATE audit row on the provider
keeps the before and after of the changed columns and licenses only (F6),
never the SSN, a password or a username.

| Datum                             | Who provides it                | Prefilled from                             | Where it lands on Submit                                                         | Locked rule           | Outside API at create | Stored where now                                                                               |
| --------------------------------- | ------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------- | --------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| First and last name               | Provider                       | Record (the invite's names for a new hire) | `providers.first_name`, `last_name`                                              | Never                 | Yes                   | `provider_intake_drafts.answers`                                                               |
| Email                             | Sign-in code proves it         | Invite                                     | Not changed by Submit                                                            | Changed only by staff | Yes                   | `providers`                                                                                    |
| NPI                               | Provider                       | Record                                     | `providers.npi`                                                                  | Locked once on file   | Yes                   | `provider_intake_drafts.answers` (never when locked)                                           |
| Taxonomy code                     | Provider                       | Record                                     | `providers.taxonomy_code`                                                        | Never                 | No                    | `provider_intake_drafts.answers`                                                               |
| Date of birth                     | Provider                       | Record                                     | `providers.date_of_birth`                                                        | Locked once on file   | No                    | `provider_intake_drafts.answers` (never when locked)                                           |
| CAQH ID                           | Provider                       | Record                                     | `providers.caqh_id`                                                              | Never                 | No                    | `provider_intake_drafts.answers`                                                               |
| Mobile                            | Provider                       | Record                                     | `providers.phone` (D11)                                                          | Never                 | No                    | `provider_intake_drafts.answers`                                                               |
| Home address                      | Provider                       | Record                                     | `providers.home_street`, `home_city`, `home_state`, `home_zip`                   | Never                 | No                    | `provider_intake_drafts.answers`                                                               |
| Licenses (state, number, expiry)  | Provider                       | `state_licenses`                           | Matched on state: update number and expiry, insert new states, never delete (D6) | Never                 | No                    | `provider_intake_drafts.answers.licenses` (each row keeps its state, even one from the record) |
| Where she was (form or documents) | Server, from Continue and Back |                                            | Not merged; signing in resumes there                                             |                       | Never                 | `provider_intake_drafts.step`                                                                  |

Licenses on Submit, each answer row as she saw it (her values, else the
state's newest license, as the form shows it): a license with that number in
that state takes the expiry; otherwise the state's newest license, once,
takes the number and expiry; otherwise a new license is inserted. A number
or expiry change returns that license to unverified, as a staff renewal
does. A license she did not list stays as it is.

## Secrets

Each is sent to the vault when she leaves its field (D5), in its own request
(`POST /api/intake/ssn`, `POST /api/intake/login`), never in the draft. The
full SSN and the passwords never enter React state, a log, an audit row or a
response: the SSN route answers the last 4, the login route answers "on
file". Signing in again shows the last 4 and which logins are on file
(`read_intake_state`). Staff read a login back only with
`reveal_portal_credential`: an admin of her org, a typed reason, one READ
audit row with the admin's name (D13). The staff screen is Test… on the Onboarding card, which
shows the login for a minute and then records whether it worked.

| Datum                              | Who provides it | Prefilled from            | Where it lands                                                                                                                                                                                                                         | Locked rule                                                                           | Outside API at create | Stored where now                                        |
| ---------------------------------- | --------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------- |
| Full SSN                           | Provider        | Last 4 shown when on file | `provider_ssn_vault` through `store_intake_ssn` (`_ssn_vault_upsert`, the SSN key; the inviter is the vault row's actor), `providers.ssn_last4`, `provider_onboardings.ssn_stored_at`                                                  | Locked once on file: the RPC answers `locked` (409 `field_locked`) and writes nothing | Never                 | `provider_ssn_vault` (encrypted), `providers.ssn_last4` |
| CAQH ProView username and password | Provider        | Whether one is on file    | `provider_portal_credentials` (`portal` `caqh`) through `store_intake_portal_login`: username in the clear, password under the `portal_credentials_key` Vault secret (never the SSN key), `onboarding_id` of the journey that wrote it | Never; a second save replaces the first                                               | Never                 | `provider_portal_credentials` (password encrypted)      |
| PECOS user ID and password         | Provider        | Whether one is on file    | `provider_portal_credentials` (`portal` `pecos`), as above                                                                                                                                                                             | Never; a second save replaces the first                                               | Never                 | `provider_portal_credentials` (password encrypted)      |

## Documents

Each file uploads as she picks it, into the private `provider-intake-uploads`
bucket (service role only, 25 MiB, PDF, PNG or JPEG), and waits there with a
`provider_intake_uploads` row until Submit copies it into the vault (D8). The
vault has no delete; the holding area does, so she can take a file back until
she submits.

The route checks the slot, kind, type and size (10 MB, `INTAKE_MAX_BYTES`),
and `begin_intake_upload` picks the path
`org/<org>/onboarding/<journey>/<upload id>/<safe file name>` (the name through
`safeFileName`, never as she typed it). The browser PUTs the file straight to a
signed URL for that path; the file never passes through `/api`. Finalize lists
the object and needs the declared size and type before
`finish_intake_upload` counts it; anything else is deleted and the upload
removed (422). A new file in a slot removes the old upload and deletes its
object. Remove marks the row removed and deletes the object; a retry answers
the same, so a failed delete finishes on the next try. Removed rows stay as
the trail of what she sent. Signing in again shows her finished uploads
(`read_intake_state.uploads`); a file still on its way, or failed, lives only
in the page, which keeps the File until it lands so Try again can resend it.

On Submit the route copies each finished upload whose slot is still on her
form (a license copy for a state she removed is not) from the holding bucket
to `provider-documents` at
`org/<org>/provider/<provider>/<upload id>/1/<safe file name>`
(`documentObjectPath`; family = upload id, version 1). A copy that is
already there counts, so a retried Submit converges. Storage says so with a
409 in `statusCode` or `status` (a string or a number), or with "duplicate"
or "already exists" in its error or message. Local Storage answers status
400 with statusCode "409". Only then does `submit_provider_intake` insert the
`provider_documents` rows, id = upload id, so a row never points at a missing
file.

When the RPC does not commit (`draft_conflict`, `npi_in_use`,
`intake_closed`, a dead session) or anything in the copies or the RPC
throws, the route deletes the vault copies this Submit made or found, then
answers as before. A copy whose upload id has a `provider_documents` row
stays, because a thrown error can be a lost answer from an RPC that
committed. `already_submitted` deletes nothing.

After a Submit that commits, every object her journey put in the holding
bucket is deleted, and so is the vault copy of every upload of hers that did
not go in (replaced, or its slot left her form), which only an earlier
failed Submit can have made. Both are best effort; a failure is logged with
identifiers only and the cleanup job finishes it. The
`provider_intake_uploads` rows stay as the trail.

### The cleanup job

`GET /api/jobs/onboarding-file-cleanup` (`src/server/jobs/onboardingFileCleanup.ts`,
the jobs runner's cron bearer, a daily Vercel cron at 18:30 UTC) deletes the
files no step reads again, through Storage. `onboarding_orphan_files` names
them, oldest first, 500 a run, only when older than 3 hours (a signed upload
URL lives 2):

- in `provider-intake-uploads`, a file under
  `org/<org>/onboarding/<journey>/<upload id>/` whose upload row is missing or
  removed, or whose journey is submitted, admitted, cancelled or gone. This
  covers a signed URL used after Remove or Cancel, a failed delete, and an
  abandoned upload once her journey ends;
- in `provider-documents`, a file under
  `org/<org>/provider/<provider>/<upload id>/` where the upload belongs to
  that org's and provider's journey, the journey is submitted, admitted or
  cancelled, and no `provider_documents` row has the upload's id.

No other vault path is ever named, and the job refuses a list that names
one before it deletes anything. It reports counts only (`files_found`,
`holding_removed`, `vault_removed`, `remove_failed`). A Cancel deletes her
upload rows (or her whole record), so a vault copy whose Cancel delete
failed is not found by the second rule; only a failed delete of the holding
files is.

| Datum                                                                   | Who provides it | Prefilled from              | Where it lands on Submit                                                                     | Locked rule | Outside API at create | Stored where now                                                                                                         |
| ----------------------------------------------------------------------- | --------------- | --------------------------- | -------------------------------------------------------------------------------------------- | ----------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| CV (required)                                                           | Provider        |                             | `provider_documents` (`cv`), `provider-documents` bucket                                     | Never       | No                    | `provider-intake-uploads` bucket; `provider_intake_uploads` (`slot_key` `cv`)                                            |
| One license copy per license state (required)                           | Provider        | Expiry from the license row | `provider_documents` (`state_license`), expiry = that state's license expiry after the merge | Never       | No                    | `provider-intake-uploads`; `provider_intake_uploads` (`slot_key` `license:XX`, no date of its own)                       |
| Diploma, board certification, own liability insurance, other (optional) | Provider        |                             | `provider_documents`                                                                         | Never       | No                    | `provider-intake-uploads`; `provider_intake_uploads` (`diploma`, `board_cert`, `coi`, `other`)                           |
| Liability policy expiry                                                 | Provider        |                             | `provider_documents.expiration_date` of the COI                                              | Never       | No                    | `provider_intake_uploads.expires_on` (a COI only), saved on each complete date through `set_intake_upload_expiry`        |
| File name, size, type                                                   | Her device      |                             | `provider_documents.file_name`                                                               | Never       | No                    | `provider_intake_uploads.file_name` (storage-safe), `size_bytes` (as declared and checked), `content_type`; never logged |

## Help, Submit and hand-off

`POST /api/intake/submit {t, version}` runs the form's own rules on the
server (`intakeSubmission` in `src/lib/intakeAnswers.ts`: signed consent,
`missingFields`, `missingDocuments`, and answers the record can't take, such
as an NPI that fails its check digit). Anything left is a 422
`intake_incomplete` with `meta.missing`, the summary keys, before a file is
copied. A version other than her saved draft's is a 409 `draft_conflict`. An
NPI she entered that is on another provider's record in the org is a 409
`npi_in_use`: nothing is written and no records are merged. A retry after a
lost response answers success and sends nothing again.

`POST /api/intake/help {t, reason}` (`{kind: "help"}` or `{kind: "fix",
field: "npi" | "dateOfBirth" | "ssn"}`) works before and after Submit until
Admit or Cancel. A second request within 60 seconds is a no-op success. The
page says it was sent only once the server has it.

| Datum                                       | Who provides it | Prefilled from | Where it lands                                                                                                                                                                                                                                                          | Locked rule      | Outside API at create | Stored where now                                                 |
| ------------------------------------------- | --------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------- | ---------------------------------------------------------------- |
| Help request                                | Provider        |                | A provider note (`notes`, entity `provider`, no author; Internal Notes names it "Provider (onboarding form)") in a plain sentence that never carries a value; `provider_onboardings.last_help_at`; one CREATE audit row; email to `ONBOARDING_OPS_EMAIL` when set (D10) |                  | Never                 | `notes`, `provider_onboardings.last_help_at`                     |
| Practice contacted                          | Staff           |                | `provider_onboardings.last_contacted_at` through `mark_onboarding_contacted` (Mark contacted on the card), one UPDATE audit row                                                                                                                                         |                  | Never                 | `provider_onboardings.last_contacted_at`                         |
| Submit                                      | Provider        |                | `provider_onboardings.submitted_at` and one UPDATE audit row; her confirmation email (`intake_submitted`, once) with its outcome in `submitted_email_delivery`; the ops alert when set (D10)                                                                            | Once per journey | Never                 | `provider_onboardings.submitted_at`, `.submitted_email_delivery` |
| Ops alert (Submit or help)                  | Server          |                | Email to `ONBOARDING_OPS_EMAIL` (`onboarding_ops_alert`): the practice and a link to `/providers/<id>`, never her name or an answer; not recorded                                                                                                                       |                  | Never                 | Not stored                                                       |
| Person checks (CAQH attestation and others) | Staff           |                | `provider_onboarding_checks` through `record_onboarding_check` (append-only, latest wins, D12), one UPDATE audit row on the journey without the note                                                                                                                    |                  | Never                 | `provider_onboarding_checks`                                     |
| Admit and location                          | Staff           |                | `provider_onboardings.admitted_at`, `admitted_by`, `admitted_facility_id` and her `provider_facility_assignments` row, through `admit_provider_onboarding`; one UPDATE audit row                                                                                        | Ends the journey | Never                 | `provider_onboardings`, `provider_facility_assignments`          |
| Cancel                                      | Staff           |                | The record deleted, or `provider_onboardings.cancelled_at`, `cancelled_by` and what the journey wrote removed (D9; see Cancel)                                                                                                                                          | Ends the journey | Never                 | `provider_onboardings.cancelled_at`, `.cancelled_by`             |

## Staff side (provider record and roster)

The Onboarding card sits at the top of the provider record while her journey
is open, and becomes one line ("Admitted <date> by <name> · <location> ·
Ready for credentialing", or In credentialing once she has a case) after
Admit. A cancelled journey shows nothing. Readiness on the Cases tab is
hidden while the journey is open (PM decision 5). The roster reads open
journeys under RLS for its Onboarding toggle and pill; `GET /api/providers`
is not involved.

The card reads `read_provider_onboarding` (any member of her org): the latest
journey, its invite (address, when sent, delivery outcome, how many sends),
the latest check per key, which logins are on file and whether an SSN is on
file (booleans only), how many finished uploads she has, whether she has a
case, and whether another provider in the org has her NPI. Every value on the
card is derived from that and the record in `src/lib/onboardingCard.ts`,
with dates against a passed-in today.

| Shown                        | Derived from                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Tracker step                 | `opened_at`, `first_signed_in_at`, `submitted_at`, `admitted_at`; In credentialing only after Admit with a case |
| Waiting on                   | Her until Submit; the practice while `last_help_at` is after `last_contacted_at`; Minted after Submit           |
| Saved so far (before Submit) | `consented_at`, finished uploads, SSN and logins on file                                                        |
| Verification (after Submit)  | The registry below                                                                                              |

| Check                                | Kind   | Confirmed when                                                                                                                                    |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| NPI                                  | Auto   | `providers.npi` passes the check digit (a failing one is a problem)                                                                               |
| NPI not on another provider          | Auto   | No other provider in the org has it                                                                                                               |
| CAQH ID                              | Auto   | `providers.caqh_id` is set                                                                                                                        |
| CAQH attested within 120 days        | Person | Staff confirm it; the record's attestation date is shown beside it (D12)                                                                          |
| `XX` license verified, one per state | Auto   | That state's newest license has PSV `verified` and has not expired (the Licenses tab's PSV is the answer; a failed PSV or an expiry is a problem) |
| Date of birth and SSN on file        | Auto   | `date_of_birth` set and an SSN in the vault                                                                                                       |
| CAQH and PECOS logins on file        | Auto   | Both logins in `provider_portal_credentials`                                                                                                      |
| Required documents on file           | Auto   | A current CV and at least one current license copy per license state                                                                              |
| CAQH login works, PECOS login works  | Person | Staff confirm; an admin can Test… first                                                                                                           |

Admit & assign is open after Submit. Its location list is the active
locations of her current groups (the RPC checks the same rule). A location
outside her license states is a warning she can be assigned past, never a
block. Admit writes her assignment to the location when she has none (start
date from `providers.start_date`; primary when she has no primary), sets
`admitted_*`, and revokes her invites and sessions. It never changes
`providers.status` (D1, D2). Checks still pending are listed in the dialog
and do not block it.

## Case creation waits for Admit (PM decision 11, D3)

A provider whose open journey has `created_record = true` gets no case until
Admit or Cancel ends that journey. A gap-fill journey (`created_record =
false`) never holds her cases. `onboardingHeldProviderIds` in
`src/lib/providerOnboarding.ts` is the one rule the browser applies, over the
open journeys read under RLS (`listOpenProviderOnboardings`).

| Surface              | What staff see                                                                                                                                                                                                                     | Built from                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/generation`        | She is never a candidate and never counted in the confirm bar. The not-generating list names her under each active target of her group: "Onboarding not finished. Admit & assign on the provider's page first", with Open provider | The `onboardingHeldProviderIds` input to `buildGenerationPreview` (no row) and the `onboarding_not_admitted` skip in `buildGenerationSkips` (`src/lib/generationPreview.ts`), named ahead of a missing location, which Admit assigns |
| New case on `/cases` | She can be picked. A notice says "This provider's onboarding isn't finished. Admit & assign on the provider's page before creating a case." with Open provider, and Create stays off                                               | `ManualCaseModal`                                                                                                                                                                                                                    |
| Database (backstop)  | A case insert for her from any session with JWT claims raises `onboarding_not_admitted` (P0001) with that sentence as DETAIL; the browser shows the same sentence, and a generation run ledgers it as the row's reason             | Trigger `block_case_until_onboarding_admitted` on `credential_cases` (migration `20261107020000`); `translateDbError` in `src/lib/dbErrors.ts`                                                                                       |

Sessions without JWT claims (migrations, seeds, operator SQL) are not held,
the pattern of the generation stage gate. Imports create no case. A database
without `provider_onboardings` holds nobody: the open-journey read answers an
empty list.

## Cancel (staff, `POST /api/provider-invites/:providerId/cancel`)

Writers only, before Submit only (a submitted journey is a 409
`already_submitted`; no open journey in the caller's org is a 404). It works
while intake is paused, because it only takes access away.
`cancel_provider_onboarding` runs in one transaction under the resend lock
and revokes every invite of hers and every session they opened. Then:

- **Deleted** (`outcome: "deleted"`): the invite created the record
  (`created_record`) and nothing else is on it: no case, task, enrollment
  fact or scope, generation exclusion or run row, fill record, document,
  location assignment, field verification, other journey, or second group.
  Her provider notes (help requests and staff notes), licenses and group
  assignment are deleted, then the record. Invites, codes, sessions, the
  journey, draft, consents, upload rows, SSN vault row, SSN intake links,
  logins and registry pulls go with it (cascade). An SMS consent stays,
  detached from the record. One DELETE audit row on the provider: the
  journey id and, for each consent she signed, its text version and signed
  time (never the typed name). Earlier audit rows stay.
- **Closed** (`outcome: "closed"`): anything else, such as an existing
  provider invited to fill gaps, or a record that now has a case. The
  journey gets `cancelled_at` and `cancelled_by`. Her draft and upload rows
  are deleted, and so are the logins this journey wrote (`onboarding_id`).
  The SSN she stored goes too (the vault row and `ssn_last4`), unless it was
  locked or staff saved one after hers. Her consent rows stay. One UPDATE
  audit row on the journey with `logins_removed` and `ssn_removed`.

After the commit the route deletes every object under the prefixes the RPC
names: `org/<org>/onboarding/<journey>/` in `provider-intake-uploads`, and in
`provider-documents` the whole `org/<org>/provider/<provider>/` (deleted) or
each held upload's `org/<org>/provider/<provider>/<upload id>/` (closed),
which only a Submit refused after its copies can have filled. A Storage
failure is logged with identifiers only and still answers 200. The cleanup
job later deletes the holding files. It can't find the vault prefixes,
because Cancel deleted their upload rows. A later invite of the same person
starts a new journey: a new record after a delete, a resend on the kept
record after a close.

## What revokes access

| Event                                                     | Effect                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Resend                                                    | Old invite revoked, its sessions dead, same journey                              |
| Staff change the record's email (case and spaces ignored) | Open invite and its sessions revoked; journey stays open for a resend            |
| Provider terminated                                       | Same as an email change                                                          |
| `provider_intake_settings.paused`                         | Every route but Cancel and signout answers 503 `intake_paused`, nothing written  |
| Her org offboarded (a stage that is not writable)         | Every intake route but signout answers 503 `intake_paused` for her link          |
| Cancel                                                    | Invites and sessions revoked; journey ends or the record is deleted              |
| Admit                                                     | Journey's invites and their sessions revoked; a later resend opens a new journey |

## Decisions this rests on

- PM decisions doc rows (Nov 1 and 2, pending PM sign-off): one journey per
  provider, anyone can be invited, her answers overwrite except SSN, NPI and
  date of birth once on file, an email or NPI match in another group joins the
  existing record with no email, consent is a typed name and a checkbox kept
  as the signed record, CAQH and PECOS passwords use their own key, staff
  Cancel, auto-revoke on email change or termination, generation waits for
  Admit.
- Nov 2: Cancel removes the provider's record (D9 narrows it to records the
  journey created with nothing else attached).
- Nov 6: an outside system may create a provider and set it up for intake.
  Not built (D14); `source` and `external_ref` keep room for it.
- Engineering defaults D1 to D16 in the R1 build plan. The ones that shape
  this map: D1 (journey row, never `providers.status`), D3 (only an invite
  that created the record holds case creation), D4 (locks are a
  snapshot), D5 (SSN and logins go straight to the vault), D6 (license merge),
  D7 (her answer wins), D8 (held uploads), D11 (mobile is `providers.phone`),
  D13 (login reveal), D16 (off switch).
- Two providers matching one invite is refused, not guessed. This follows the
  practice invite design (`classifyInvite` in `src/lib/providerOnboarding.ts`).
