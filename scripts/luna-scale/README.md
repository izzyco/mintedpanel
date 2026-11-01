# Luna-scale synthetic org: staging runbook (MINT-82 / RC-07)

One synthetic organization, **Luna Demo (synthetic)**, at Luna scale: about 3,500
providers in 50 groups, 200 locations and 25 states, with 7 payers and about 5,600
credentialing cases. It exists so staging can exercise everything that breaks
past PostgREST's 1,000-row cap (MINT-14). It is fully synthetic and fully
reversible.

**Never run it against production.** The runner and the SQL both refuse the
production project and the production cluster, whatever the environment says.

## What it creates

`npm run seed:luna-scale -- --dry-run` prints the plan without connecting. It
is one fixed dataset, with its dates anchored on the apply day:

| Table                           |   Rows | Notes                                                              |
| ------------------------------- | -----: | ------------------------------------------------------------------ |
| `organizations`                 |      1 | upserted; never deleted (see Teardown)                             |
| `status_configs`                |     22 | the canonical set `create_organization` seeds                      |
| `payers`                        |      7 | **org-scoped** (`org_id` = the Luna org), not global               |
| `org_payer_assignments`         |      7 |                                                                    |
| `provider_groups`               |     50 | state LLCs, `00xxxxxxx` TINs                                       |
| `facilities`                    |    204 | 200 under the groups, covering all 25 states; 4 edge cases (below) |
| `payer_network_targets`         |    536 | group × state × payer covering that state                          |
| `providers`                     |  3,500 |                                                                    |
| `provider_group_assignments`    |  3,465 | one primary each; the 35 "no group" providers have none            |
| `provider_facility_assignments` |  4,094 | one primary each; 20% have a second location; 70 have none         |
| `state_licenses`                |  3,854 |                                                                    |
| `credential_cases`              |  5,610 | one per (provider, group, payer, state)                            |
| `case_facilities`               |  5,798 | primary row for every case, plus later-added locations             |
| `tasks`                         |  5,610 | one per case                                                       |
| `touches`                       |  9,921 | touchpoints and notes                                              |
| `case_status_history`           | 20,498 | full chain per case, from the system seed row                      |
| `enrollment_facts`              |  1,467 | approved, effective, not terminated                                |
| `memberships`                   |  0 – n | only from `--member-email`                                         |
| **total**                       | 64,644 | one transaction, about 19 MiB of SQL                               |

The organization insert also fires `roster_engine_seed_org_templates`, which adds
three `roster_templates` rows. That table is append-only by trigger.

The mix:

- **Provider Onboarding funnel** (MINT-81, with #560's stages and group rules
  through Addendum 8), **under the platform-default funnel configuration**: the
  default stage list and rules. The funnel's stages and rules are
  configuration, so an organization or platform override can place these
  providers differently. Under the default, every stage it shows without
  intake data has members. Each held provider shows exactly one kind of gap,
  except the 35 with no group, who show two staff-side reasons (below):
  - Profile incomplete, 420: 70 each with no NPI, no CAQH ID, no date of birth,
    no SSN last 4, no license, and no license for the state they work in.
  - Submitted, 348: 87 each with an unverified license, an expired
    license (status still `active`), CAQH attested more than 120 days ago, and a
    record pending verification.
  - Verified, awaiting assignment, 174: verified, held only by assignment gaps.
    - No group, 35: they work at a group's clinic, but no membership is
      recorded. Each row lists two reasons, in this order: "No group
      assigned yet", then "Location … is under …, not the provider's
      group". Both are staff-side group gaps (A23): with no current group,
      a location that fails only because its group is not theirs is a group
      problem, never the provider's. They have no location gap of their
      own, and no group text ever appears in Submitted. Recording the
      membership clears both.
    - Needs a location, 70: in a group, no clinic yet.
    - "Location … is under …, not the provider's group", 52: their clinic
      belongs to one group, their membership is in the next one.
    - "Location has no valid state on record", 17: they work at a clinic of
      their group and at one of the 2 _Luna Demo New Clinic_ locations, which
      groups 01 and 02 added before entering an address (no street, state,
      ZIP or go-live date).
  - Ready for credentialing, 315:
    - 280 work only at clinics of their own group, as does every provider
      outside the five assignment scenarios;
    - 35 are in a group and work only at one of the 2 _Luna Demo Unassigned
      Clinic_ locations, which belong to no group. A location with no group
      counts for any provider (#560, A22), so they are Ready. With that rule
      turned off, they would be held with "Location … has no group".
  - Credentialing, 2,208.
  - 35 terminated providers, which the funnel does not count.

  The 4 edge-case locations are added on top of the 200 group clinics. No
  case, target or other provider uses them.

- **Case status**:
  - approved 1,964 (1,550 effective, 414 awaiting an effective date);
  - submitted 841, not started 792, in review 760, in progress 555;
  - denied 421, action required 277.
- **Billing Readiness change feed** (approval transitions, terminations,
  license expirations):
  - last 7 days: 114, 4, 9;
  - last 30 days: 359, 16, 43;
  - last 90 days: 861, 57, 123.

  There are no "location linked" events: the feed needs
  `case_facilities.created_by`, which references `auth.users`, so the seed
  leaves it null rather than invent an actor.

- **Follow-ups** on open cases (`touches.next_follow_up_date` on the latest
  touch): 849 overdue, 250 due today, 1,334 upcoming.

The dataset takes no count flags. The ticket text says "one national group";
the planning session asked for about 50 groups, so it has 50.

## What makes it safe

- **Synthetic by construction.**
  - Names come from a seeded PRNG over invented surnames.
  - NPIs pass the CMS Luhn check, using the `80840` prefix, the same rule as
    `isValidNpi` (MINT-7). Synthetic prefixes: `2999…` for individuals and
    `2998…` for groups. Real NPIs start with 1 or 2, and NPPES has issued the
    1-series. These were not checked against NPPES, because lookups are not
    allowed, so a collision is unlikely but not proven.
  - Addresses are on Example Way, Synthetic Ave, Placeholder Rd, Fixture Ln and
    Sample St, with `000nn` ZIPs.
  - Phones are `(555) 555-01nn`, and emails are `@example.test`.
  - Date of birth is always `1970-01-01` and SSN last-4 is always `0000`. The
    schema does not require them, but the funnel's "Profile incomplete" stage
    checks for their presence, so without them no provider could reach a later
    stage.
- **Scoped to its org.**
  - Every row carries `org_id` = the Luna org, including the payers. The
    apply, the teardown and the verifier select rows by that id, and nothing
    else.
  - Row ids are deterministic, so the same dataset always has the same ids.
  - No receipts: the seed writes nothing to `audit_log`.
- **Nothing outside its org.**
  - The payers are org-scoped, so no other org's catalog grows.
  - No row in another organization is read or written. The isolation-gate
    expected counts (Kansas / South Park providers) are untouched.
  - `--member-email` refuses the UAT personas (`@minted.invalid`) and the
    isolation-gate logins, which are hard-coded (`testkansas@minted.com`,
    `testsouthpark@minted.com`), plus `KANSAS_EMAIL`, `SPVIEW_EMAIL` and anything
    in `LUNA_SCALE_PROTECTED_EMAILS` when set. The gate's single-org assertions
    fail the moment one of those logins joins a second org.
  - The SQL refuses a member of a UAT org, always. It also refuses a member who
    already belongs to any other org, unless you pass `--allow-multi-org-member`
    (your own staging login usually does belong to other orgs).
- **Target guards**, all before any connection:
  - `SUPABASE_URL` and `LUNA_DATABASE_URL` must name the same project.
  - That project must be in `LUNA_SCALE_ALLOWED_PROJECT_REFS`.
  - The production ref is refused even if it is listed.
  - `LUNA_DATABASE_URL` is parsed strictly: exactly one `@` (percent-encode an
    `@` in the password as `%40`), no `,` anywhere in the host part (no libpq host
    lists), a plain hostname or IPv4 host, path `/postgres`, and at most
    `sslmode=require|verify-full`. Routing overrides (`host=`, `hostaddr=`) are
    refused.
  - psql never receives the URL. The validated host, port, user, password and
    database are passed one by one as `PG*` variables, after every inherited
    `PG*` variable is stripped, so libpq cannot read the URL differently.
  - `--confirm` must be the exact token for the action and the project.
- **Database identity.** Before writing, the runner reads `pg_control_system()`:
  - pinned staging must be cluster `7662742571317219726`;
  - any other allowlisted project must match `LUNA_SCALE_EXPECTED_DATABASE_IDENTITY`;
  - production (`7642734024280108049`) is refused.

  The SQL repeats the check inside the transaction, against the identity and
  token the runner passes, so pasting the SQL into an editor fails before it
  writes anything.

- **All or nothing.** The SQL is one transaction. It commits only when every
  seed table holds exactly the planned number of rows in the Luna org
  (`planCounts`), so a trigger that added a row there would abort it too.

## Why a psql transaction, not batched PostgREST writes

It is the pattern `scripts/uat/seed-staging-uat.mjs` already uses: pure SQL fed
to `psql` with `ON_ERROR_STOP` and an identity guard. It is also better on every
axis that matters here:

- **Atomic.** About 65k rows over the REST API would be about 130 separate
  500-row requests. One failure midway would leave a half-built org that needs
  its own cleanup.
- **No caps.** The 1,000-row read cap and the request-body limits do not apply.
- **No service-role key.** The REST path needs a service-role key; this only
  needs the database URL the UAT seed already uses.

Inserts are plain multi-row `INSERT`s, 500 rows per statement, each well under
1 MB. The apply empties the org's seed tables first, so nothing conflicts.

One cost: sequences never roll back. Every apply inserts the 5,610 cases afresh,
so it uses that many `credential_cases_case_number_seq` values, even when it
fails after the case insert. Case numbers stay unique; the range just has gaps.

## Prerequisites

- Node 22 and `psql` 15 or later on the operator machine.
- The staging database URL: the direct host
  `db.vmznysvietfaddakkegt.supabase.co:5432`, user `postgres`, or the session
  pooler `aws-0-ca-central-1.pooler.supabase.com:5432`, user
  `postgres.vmznysvietfaddakkegt`, for example
  `postgresql://postgres.vmznysvietfaddakkegt:<password>@aws-0-ca-central-1.pooler.supabase.com:5432/postgres?sslmode=require`.
- For `--member-email`: the login must already exist on staging, with a
  `profiles` row. Create it through the app first.

The URL carries the database password. Paste it at a prompt inside a one-off
subshell, so it exists only for that one command and never reaches shell
history. **Never `export` it in your own shell, and never put it in `~/.zshrc`
or any profile**: a secret in a profile reaches every shell started afterwards,
agent shells included. This helper holds no secret; every step below runs
through it and asks for the URL:

```sh
# zsh; in bash use: read -rsp "Staging database URL: " DB_URL
luna() (
  read -rs "DB_URL?Staging database URL: " && echo
  SUPABASE_URL=https://vmznysvietfaddakkegt.supabase.co \
  LUNA_DATABASE_URL="$DB_URL" \
  LUNA_SCALE_ALLOWED_PROJECT_REFS=vmznysvietfaddakkegt \
    npm run "$@"
)
```

## Apply

```sh
# 1. Plan: no connection, nothing written. Check the target line says "staging vmznysvietfaddakkegt".
luna seed:luna-scale -- --dry-run --member-email you@yourdomain.com

# 2. Apply, and give your own staging login access (admin by default; --member-role specialist|billing).
#    Add --allow-multi-org-member if that login already belongs to another org.
luna seed:luna-scale -- --apply \
  --confirm "SEED LUNA SCALE ON vmznysvietfaddakkegt" \
  --member-email you@yourdomain.com

# 3. Verify: read-only; every seed table in the org against the planned counts.
luna verify:luna-scale
```

Sign in as that user and switch to **Luna Demo (synthetic)**.

- **Re-running** step 2 rebuilds the org: in one transaction it deletes every
  row of the Luna org from the seed tables and inserts the dataset again. That
  also removes anything added to those tables in the Luna org through the app.
  Members stay.
- **Adding another member later**: run step 2 again with the new
  `--member-email`. It rebuilds the data and adds the member.
- **Dates are relative to the apply day**, so a re-apply also refreshes the
  7/30/90-day windows and the follow-up buckets.
- **The prod-to-staging catalog sync** (`docs/ops/catalog-sync-prod-to-staging.md`)
  is independent of this seed: run them in either order.

## Teardown

```sh
luna seed:luna-scale -- --dry-run --teardown        # what it would remove
luna seed:luna-scale -- --teardown --confirm "TEAR DOWN LUNA SCALE ON vmznysvietfaddakkegt"
luna verify:luna-scale                              # the inactive org, no rows, no members
```

The teardown deletes every row of the Luna org from these tables, children
first:

1. `enrollment_facts`, `case_status_history`, `touches`, `tasks`,
   `case_facilities`, `credential_cases`;
2. `state_licenses`, the two assignment tables, `providers`;
3. `payer_network_targets`, `facilities`, `provider_groups`,
   `org_payer_assignments`, `payers`, `status_configs`;
4. `memberships`.

It then sets the organization `inactive`. The database's own foreign keys
decide the rest: a row added through the app that cascades from Luna data goes
with it, and one that blocks the delete stops the teardown and rolls it all
back. The error names the table; delete those rows in the Luna org and run the
teardown again.

**What stays, by design:**

- The organization row: `inactive`, with no members, so nobody sees it.
- Its three `roster_templates` rows. The roster ledger is append-only by
  trigger, with `ON DELETE RESTRICT` to `organizations`, so no seed can ever
  delete an organization row once it exists. The UAT fixture's organizations
  stay for the same reason.
- Any `audit_log` rows the app wrote for the org, which are never deleted.

A later apply reactivates the same org.

## Local mode and the CI job

`--local-rehearsal` is a closed mode, for a loopback Supabase
(`supabase start`) only:

- Both `SUPABASE_URL` and `LUNA_DATABASE_URL` must be on `127.0.0.1` or
  `localhost`. Anything else is refused in this mode, even an allowlisted
  staging project.
- Production's ref is refused on either URL.
- Hosted staging's cluster identity is refused.
- The tokens are `SEED LUNA SCALE ON local` and `TEAR DOWN LUNA SCALE ON local`.

The CI job **Luna-scale seed (local Supabase)** (`luna-scale-seed` in
`.github/workflows/ci.yml`) proves the SQL on every run:

1. It starts and resets local Supabase the way the UAT seed job does, including
   the duplicate-timestamp workaround.
2. It seeds the UAT fixture as pre-existing data, and creates a member login and
   a login that belongs to a UAT org.
3. It fingerprints every public row outside the Luna org (`verify:luna-scale
--fingerprint`, one md5 per table).
4. It runs `--dry-run`, `--apply` (with a member), and `verify:luna-scale`,
   which fails on any seed table whose row count in the org differs from the
   plan.
5. It runs a second `--apply` and checks that it rebuilt the org: verify
   passes again, the cases hold new case numbers, and the member is still
   there.
6. It checks that a member of a UAT org is refused and that the transaction
   rolls back (case numbers unchanged, no membership added).
7. It runs `--teardown`, then verify: the org is inactive with no seed rows and
   no members.
8. It checks that the outside fingerprint is unchanged after the applies and
   after the teardown, then re-seeds and tears down once more.

## Known limits

- **Enrollment Explorer cells stay empty.** The Explorer reads payer products,
  group product targets and enrollment scopes from `private.*` ledgers. Those
  are append-only, so a seed could never remove them, and this seed does not
  write them. On staging the Explorer shows the active cohort (about 2,200
  providers, in 50-provider pages) with the "No payer products are configured"
  note.
- **The Explorer's staff report checks `private.internal_staff`.** That manifest
  is written outside this seed, so a member added here may need that row before
  the staff Explorer serves them.
