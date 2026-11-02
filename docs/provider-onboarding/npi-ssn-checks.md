# NPI and SSN checks: plan

Status: plan only, Nov 2, 2026. Nothing here is built. Ivan flagged both intake inputs as needing review.

## Goal

A provider who types a wrong NPI or SSN on the intake form finds out on the spot, and every surface that takes either number applies the same rule. Ship a strict local check now; add registry checks later behind the same seam, without changing the screens.

## How the inputs are checked today

**NPI. Four different rules.**

| Where                        | Rule                                        | File                                               |
| ---------------------------- | ------------------------------------------- | -------------------------------------------------- |
| Intake form (provider)       | 10 digits + Luhn check digit (80840 prefix) | `src/lib/intakeForm.ts` `isValidNpi`               |
| Roster import/export         | 10 digits + Luhn check digit                | `src/lib/rosterTransforms.ts` `isValidNpi`         |
| Staff roster and group forms | Length 10 only                              | `src/lib/providerGroup.ts` `isValidNpi`            |
| Invite route (server)        | `/^\d{10}$/` only                           | `src/server/intakeTokens.ts` `validateInviteInput` |

So a practice can invite with an NPI the provider's form then rejects, and a typo passes the staff forms.

**SSN. Length only.** The intake form keeps the last 4 once 9 digits are typed (`SsnField` in `src/components/intake/IntakeForm.tsx`). The vault RPC (`20260717120000_ssn_vault.sql`) also checks only `char_length = 9`. Numbers the SSA never issues (area 000, 666 or 900–999, group 00, serial 0000) pass everywhere.

**UX problems in the SSN field.** The input is a password field that masks as soon as focus leaves it, with no show toggle and no way to re-read the value. A transposed digit can't be caught by the provider, and the screen shows `•••-••-1234` while the rest of the app shows `***--1234` (`src/lib/ssnMask.ts`).

## Plan

### Now (one PR, pure code, no backend)

1. **One rule module.** Add `src/lib/identifiers.ts` with `checkNpi(value)` and `checkSsn(value)`. Each returns `{ level: "ok" | "block" | "warn", message?: string }`, which is the seam later checks plug into.
   - `checkNpi`: 10 digits, Luhn with the 80840 prefix, and a Type 1 hint (an individual's NPI starts with 1; a 2 is a group NPI, so warn "This looks like a group NPI").
   - `checkSsn`: 9 digits, and block the structurally impossible: area 000, 666 or 900–999; group 00; serial 0000; plus the well-known sample numbers (078-05-1120, 219-09-9999).
2. **Migrate every caller, then delete the copies.** The intake form, roster transforms, staff forms and the invite route all call `checkNpi`. Delete the other three `isValidNpi` functions in the same PR. A test greps `src/` so a fourth copy fails the suite.
3. **Server re-checks.** The invite route uses `checkNpi` (server copy of the same module; it is pure). When saving ships, the intake submit RPC caller re-checks both numbers before the vault write.
4. **SSN field UX.**
   - Add a Show/Hide toggle while typing, so she can read it back.
   - Format as `123-45-6789` while typing.
   - Keep only the last 4 after leaving the field.
   - Show the on-file value with the shared `maskSsn` format.
   - Keep the full value out of React state as today.

### Later (behind the same seam)

5. **NPI registry lookup.** Add a server route, `POST /api/intake/npi-check`, that calls the public NPPES NPI Registry API (`https://npiregistry.cms.hhs.gov/api/?version=2.1&number=…`). It goes through the server because the registry likely doesn't allow browser calls (to confirm). The registry adds four results:
   - `not_found` blocks;
   - `deactivated` blocks;
   - `name_mismatch` warns, because maiden and legal names differ;
   - `unavailable` never blocks.

   It can also prefill specialty (taxonomy) and license numbers from the registry. It needs an isolation-gate entry and a rate limit.

6. **SSN verification.** There is no public SSN registry. Options for the PM:
   - **SSA CBSV.** Consent Based SSN Verification is paid, needs SSA enrollment and the signed SSA-89 consent, which our consent step could carry. To confirm.
   - **Vendor check.** A background-check vendor's SSN trace at Admit.
   - **Staff check.** Keep it a person check in the 6b Verification block.

   Whichever it is, it returns the same `{ level, message }` shape.

## Tests (write first)

- Known-good NPIs pass. One wrong check digit blocks. A Type 2 NPI warns.
- SSNs with area 000, 666 or 9xx, group 00 or serial 0000 block. The sample numbers block. A normal number passes.
- The invite route rejects a bad check digit with a 422.
- The SSN field shows the typed digits only while Show is on, and the draft never holds more than the last 4.
- A grep test fails if any file other than `src/lib/identifiers.ts` defines an NPI or SSN check.

## Risks and open questions

- **Locked fields.** NPI, SSN and DOB lock once on file, so a wrong value that slipped in before these checks needs the "Wrong? Tell us" path and a staff fix.
- **Existing rows.** Some may fail the stricter NPI rule. Roster import already applies it, but staff-entered and invite-entered rows may not. Count them on staging before the PR (read-only query).
- **What Ivan saw.** Which inputs looked wrong, and how? A rejected real NPI, a typo that passed, or the SSN masking? That decides whether step 4 or step 1 goes first.
