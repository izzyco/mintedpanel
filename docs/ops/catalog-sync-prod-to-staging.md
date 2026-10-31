# Catalog sync: production to staging

Keeps staging's shared catalog at least as complete as production's. **Additive
only**: rows missing on staging are inserted; nothing is updated or deleted, so
staging-only test rows and staging edits survive.

## Who runs it, and when

- **Sowmya runs it, the dry run and the apply,** from her own machine, with the
  production and staging service-role keys in her shell. No agent or CI job
  runs it against either project, dry run included: agents have no keys, and
  cloud sandboxes block egress to `*.supabase.co`.
- **It is independent of the Luna-scale seed** (MINT-82,
  `scripts/luna-scale/README.md`): run them in either order. The seed writes
  only rows in its own synthetic org, its payers are scoped to that org, and it
  writes no portals, SOP templates or payer forms; nothing in it reads the
  shared catalog. The sync copies production rows by id into the global catalog,
  or into production orgs that exist on staging, so it never writes into the
  Luna org, and no row it copies can reference a seed row. The seed's teardown
  refuses only when a row it did not create references a seed row, so the sync
  cannot block it.

## Before you run

1. **Set a case type on production for three legacy templates:**
   `Anthem BCBS CO`, `Medcost - NC` and `Trinity Health System`. Their
   `case_type` is NULL on production, and staging refuses a template without one
   (`sop_case_type_required`). Set it in the production Template Editor by
   publishing a new version with the case type; the app changes a case type only
   through a publish. A typed publish runs production's portal-binding check, so
   a step with no valid portal has to be fixed there first.

   **The sync never supplies a default case type.** Until this is done, the dry
   run and the apply list each of the three under `sop_templates` as skipped:

   ```
   - <id> "Anthem BCBS CO": case_type is NULL on production. Set its case type on production first (runbook: Before you run, step 1); the sync never supplies one
   ```

   Each payer form attached to one of them is listed under `payer_forms` as
   skipped, naming the template.

2. Nothing to do for `Aetna - Direct`: the sync creates its portal (next
   section).

## The one portal the sync creates

`Aetna - Direct` (archived, contract) points at portal
`aetna-direct-contract-contract-1f94bf43c4c0`, which exists on neither project,
so staging's binding guard refused the template on Oct 27. The sync now creates
that portal on staging just before it inserts the template.

It is one named entry in `scripts/ops/catalog-sync-created-portals.mjs`, not a
rule. A template that names any other missing portal is not sent, and the run
lists it as one staging would refuse (next section).

The row it writes, and why:

| Column       | Value                                                                  | Why                                                                    |
| ------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `org_id`     | the template's (NULL for a global template)                            | the guard looks for the key in the template's own scope                |
| `portal_key` | `aetna-direct-contract-contract-1f94bf43c4c0`                          | the template's key, as the guard compares it (trimmed, lower case)     |
| `name`       | `Aetna - Direct contract (created by catalog sync; not on production)` | required; marks it as the sync's; a `[hidden] ` name would not bind    |
| `payer_id`   | the template's payer                                                   | the guard needs the same payer, and a typed portal must have one       |
| `case_type`  | the template's (`contract`)                                            | the guard needs the same case type                                     |
| `form_url`   | NULL                                                                   | production has no row, so there is no URL to copy                      |
| the rest     | column defaults and the insert trigger                                 | new id, unverified, no proof, explicit selection, mapping generation 1 |

No field maps are written for it. The dry run shows it as:

```
portals created by the sync (not on production): 1 would add, 0 skipped
  + would create portal aetna-direct-contract-contract-1f94bf43c4c0 "Aetna - Direct contract (created by catalog sync; not on production)" for template <id> "Aetna - Direct" (global | org <id>, payer <id>, case type contract, no form URL, no field maps)
```

It creates nothing, and says why, when:

- the template is already on staging, or a row with the key is already visible
  to it;
- the template has no payer, or its org is not on staging;
- for a global template, its payer is not active on staging;
- **the template would still be refused** for another reason, by the same
  check the templates get (next section). Typically another portal key on it
  does not bind, or it names a production group that staging does not have:
  `template <id> would still be refused: key "<key>" (sop_portal_binding_ineligible); nothing created`,
  or
  `template <id> would still be refused: group <id> is not on staging (sop_templates_group_id_fkey -> provider_groups); nothing created`.
  An insert-only sync could never take back a portal nothing uses, so it is
  never created on the chance.

If production later gets a real portal with this key, staging keeps the sync's
row: the copy is refused as a duplicate key and reported. Replace it
deliberately.

## Templates staging would refuse

Before it inserts a template, the sync checks it the way staging's insert
guards do (`guard_typed_sop_template` and
`validate_sop_template_portal_bindings`, restated in `templateRefusal` in
`scripts/ops/catalog-sync.mjs`; a test fails when a migration redefines
either). For each portal key on the template, an org row shadows the global row
with that key, a `[hidden] ` row never binds, the row picked needs the
template's case type and payer, and a global row also needs an active payer.
An online-form step with no portal, an unknown step type, or a malformed task
list also refuses it. So does each of the template's foreign keys: its org,
its **group** (`provider_groups` are org-owned and never copied, so a
production group is often missing on staging) and its payer must be on staging,
the payer counting this run's copies.

The check follows **the repo's migrations**. A test rebuilds every trigger and
foreign key on `sop_templates` from `supabase/migrations/` and fails when one
appears or goes, and another pins the two guard functions. A hot-fix applied to
staging but not committed as a migration would make the dry run disagree with
staging; the apply would then report staging's own error.

A template that fails is **not sent, in either mode**, so the dry run and the
apply agree. The dry run lists it as `would be refused: <guard message>` (the
apply as `not sent: staging would refuse it: <guard message>`), and each payer
form attached to it says `template <id> "<name>" would be refused: …`.

## What it copies

| Table                                     | Rule                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `payers`                                  | missing ids                                                                      |
| `portals`                                 | missing ids; org-owned rows only if the org exists on staging                    |
| `portal_field_maps`                       | for portals added in the same run: same org and key, plus org overrides (below)  |
| `portals` (created)                       | the named entries above, only                                                    |
| `sop_templates` + `sop_template_versions` | missing ids with a case type (step 1) that staging's guards would accept (above) |
| `payer_forms` + Storage `payer-forms`     | missing ids with their payer and template on staging; file is copied             |

- `created_by` / `published_by` / `retired_by` are dropped (those users do not
  exist on staging).
- **Versions.** Staging's `sop_template_seed_version` trigger writes each new
  template's current version from the head row as it is inserted. Staging keeps
  that copy, and production's row for that version is not sent; the earlier
  versions are copied. The dry run counts the same way.
- **Order.** A payer goes in before the payers merged into it; payer forms go in
  by family and version, each superseded form before the form that supersedes
  it. A form whose predecessor is neither on staging nor added in the run is
  skipped before its file is uploaded.
- **Complete reads.** Every read is ordered and asks for an exact count; a read
  that comes back short of its count, or whose count changes during the read,
  stops the run with an error instead of copying part of a table. Production's
  `portal_field_maps` change with live extension use, so this can happen. An
  apply that stops partway has already inserted the tables before it; that is
  safe, because the sync only inserts what is missing. Run it again.
- **Storage.** A file already on staging (HTTP 409) is kept and its row still
  goes in; any other upload error skips the row.
- **Field maps.** A map goes with the new portal of its own org and key. An
  org's override of a **new global portal** (same key, `org_id` set) goes too,
  when that org is on staging and has no portal of its own with that key there.
  Any other override of a new global portal is listed with the reason (`org …
is not on staging`, or `org … already has its own … portal on staging, which
keeps its own maps`). Maps of portals staging already had are left alone.
- **Field maps are a shared-state exception.** CLAUDE.md's shared-state rule 1
  says `portal_field_maps` rows change through Supabase MCP only, never from
  code. This operator-run sync inserts field maps on staging for the portals it
  copies, so each run is an exception to that rule. **Sowmya confirms it before
  an apply that would add field maps**: the dry run's `portal_field_maps` line
  shows how many.

## Run

Paste the two service-role keys at prompts, inside a one-off subshell, so they
exist only for that one command. **Never `export` them in your own shell, and
never put them in `~/.zshrc` or any profile**: a key in a profile reaches every
shell started afterwards, agent shells included. Never commit them.

```sh
# Dry run: reads both projects, writes nothing. (zsh; in bash use read -rsp "prompt" VAR)
(
  read -rs "SRC_KEY?Production service-role key: " && echo
  read -rs "DST_KEY?Staging service-role key: " && echo
  SYNC_SOURCE_URL=https://fkvuhfsqcmujywzgczmc.supabase.co SYNC_SOURCE_SERVICE_KEY="$SRC_KEY" \
  SYNC_TARGET_URL=https://vmznysvietfaddakkegt.supabase.co SYNC_TARGET_SERVICE_KEY="$DST_KEY" \
    npm run sync:catalog-to-staging
)

# Apply: the same, with -- --apply on the last line:
#     npm run sync:catalog-to-staging -- --apply
```

The keys end with the subshell. The script refuses any source/target pair but
production to staging, checked on the URLs and again on the two clients.

Both modes print one block per table: how many rows it would add (or added),
and every row it would skip (or skipped), with its id, its name and the reason.

## The 14 payer forms left on Oct 27

The Oct 27 run left 14 payer forms (PDFs) on production only, and the list was
not written down. It is not needed: **the dry run lists every payer form it would
skip, with the reason**, and a form held back by its template names that
template. Most of the 14 are expected to clear once the three templates have a
case type on production and the Aetna portal exists, because a form is copied
only when its template is on staging. A template that names a production group
staging does not have stays out, with its forms, and the dry run says so; the
sync never copies or invents a group.

The dry run predicts staging's insert guards and the template's foreign keys
(above), so a form whose template would be refused is listed with that reason
in both modes. What only shows at apply time, with staging's error:

- a Storage file that is missing on production (the form is skipped);
- a refusal from a rule that is on staging but not in the repo's migrations;
- a read whose count changes mid-run (the run stops; run it again).

## Not copied

Rows that exist on both sides but differ (production ahead) are **not**
updated. Promote those deliberately.
