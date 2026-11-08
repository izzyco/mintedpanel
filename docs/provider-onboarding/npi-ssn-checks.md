# NPI and SSN checks

Status: local checks built, Nov 6, 2026. Every screen that takes an NPI or an SSN uses the shared rule. Registry lookup and SSN verification are later work.

## Goal

A provider who types a wrong NPI or SSN on the intake form finds out on the spot, and every surface that takes either number applies the same rule. Registry checks can come later without changing the screens.

## How the inputs are checked now

**NPI. One rule.** `isValidNpi` in `src/lib/providerIdentity.ts` (MINT-7) takes exactly 10 digits whose last digit is the Luhn check digit over the CMS `80840` prefix. Add Provider, the roster form, the provider record's inline edit, the import dedupe, roster export, the provider intake form (`npiProblem` in `src/lib/intakeForm.ts`) and the invite route (`validateInviteInput` in `src/server/intakeTokens.ts`) all call it. The invite route answers 422 with `NPI_FORMAT_MESSAGE` for a number that is not 10 digits and `NPI_CHECK_DIGIT_MESSAGE` for a bad check digit. The invite dialog checks the NPI in the field first. `inviteNpiProblem` in `src/lib/inviteFields.ts` gives the same two messages, and `InviteFields` shows the message under the NPI input once the field is left or holds 10 digits. Send stays disabled until it clears, because `inviteFieldsReady` requires it. The staff dialog and the practice's dialog share that field block. The staff dialog still shows the route's text above its buttons if a request gets past the field check. So a practice can no longer invite with an NPI the provider's form then rejects. The group Type 2 NPI stays length-only (`isTenDigitNpi` in `src/lib/providerGroup.ts`).

**SSN. One issuance check.** `isPossibleSsn` in `src/lib/providerIdentity.ts` takes 9 digits. It rejects area 000, 666 or 900-999, group 00, serial 0000, and the two published sample numbers 078-05-1120 and 219-09-9999. Every SSN screen shows `SSN_NOT_ISSUED_MESSAGE` for 9 digits that fail it: "This isn't a valid Social Security number. Check each digit for a typo."

- On the intake form, `ssnProblem` returns it. A flagged number keeps no last 4, the same as a number that is too short.
- The `/ssn-intake/$token` page submits only a number that passes. It shows the message in the same slot as "Enter all nine digits of the SSN."
- The staff Store SSN dialog (`SsnStoreDialog`) shows the message under the input and keeps Save disabled.

**SSN field.** `SsnField` in `src/components/intake/IntakeForm.tsx` is a password input with a Show/Hide toggle while she types. It formats the value as `123-45-6789` (`typeSsn`), keeps only the last 4 once she leaves the field, and never puts the full value in React state.

**No group NPI warning.** CMS describes the NPI as intelligence-free, so its first digit does not reliably tell an individual from a group.

## Open follow-ups

- The vault RPC (`20260717120000_ssn_vault.sql`) checks length only (`char_length = 9`).
- The intake form saves nothing yet. When saving ships, the server re-checks both numbers before the vault write.
- The intake form shows an on-file SSN as `•••-••-1234`, while the rest of the app shows `***--1234` (`maskSsn` in `src/lib/ssnMask.ts`).

## Later

1. **NPI registry lookup for the provider.** Staff already have registry search and verification (MINT-110, `/api/npi-registry/*`, writer-only). It runs on the server because the NPPES API sends no CORS headers. The provider has no Supabase session, so the intake form needs its own route, such as `POST /api/intake/npi-check`, over the same registry client. The registry adds four results:
   - `not_found` blocks;
   - `deactivated` blocks;
   - `name_mismatch` warns, because maiden and legal names differ;
   - `unavailable` never blocks.

   It can also prefill specialty (taxonomy) and license numbers from the registry. It needs an isolation-gate entry and a rate limit.

2. **SSN verification.** There is no public SSN registry. Options for the PM:
   - **SSA CBSV.** Consent Based SSN Verification is paid, needs SSA enrollment and the signed SSA-89 consent, which our consent step could carry. To confirm.
   - **Vendor check.** A background-check vendor's SSN trace at Admit.
   - **Staff check.** Keep it a person check in the 6b Verification block.

## Tests

- `src/lib/providerIdentity.test.ts` pins known-good and bad NPIs, every SSN the SSA never issues, the sample numbers, and that no file under `src/` other than `providerIdentity.ts` declares `isValidNpi`, `npiCheckDigit` or `isPossibleSsn`.
- `src/lib/intakeForm.test.ts` pins the provider-facing NPI and SSN messages.
- `src/server/intakeTokens.test.ts` pins both invite-route NPI messages.
- `src/lib/inviteFields.test.ts` pins `inviteNpiProblem` and that a wrong NPI keeps the invite from being ready.
- `e2e/ssn-vault.spec.ts` drives the Store SSN dialog and the `/ssn-intake/$token` page with a number the SSA never issues.
- `e2e/provider-onboarding-preview.spec.ts` drives the practice's invite dialog with a wrong NPI check digit.

## Risks

- **Locked fields.** NPI, SSN and DOB lock once on file, so a wrong value that slipped in before these checks needs the "Wrong? Tell us" path and a staff fix.
- **Existing rows.** Rows stored before the check digit rule may fail it. Staff edits check a stored NPI only when it changes (`recheckStoredOnEdit` defaults to false), so those rows never block an unrelated save. Count them on staging (read-only query) before deciding on a fix.
