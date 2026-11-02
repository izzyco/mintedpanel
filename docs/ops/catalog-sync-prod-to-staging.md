# Catalog sync: production to staging

Keeps staging's shared catalog at least as complete as production's. **Additive
only**: rows missing on staging are inserted; nothing is updated or deleted, so
staging-only test rows and staging edits survive.

## Who runs it, and when

- **Sowmya runs it, the dry run and the apply,** from her own machine, with the
  production and staging service-role keys pasted at prompts (see Run). No agent
  or CI job runs it against either project, dry run included: agents have no
  keys, and cloud sandboxes block egress to `*.supabase.co`.
- **It is independent of the Luna-scale seed** (MINT-82,
  `scripts/luna-scale/README.md`): run them in either order. The seed writes
  only rows in its own synthetic org, its payers are scoped to that org, and it
  writes no portals, SOP templates or payer forms; nothing in it reads the
  shared catalog. The sync copies production rows by id into the global catalog,
  or into production orgs that exist on staging, so it never writes into the
  Luna org, and no row it copies references a Luna row.

## How it works

- **The dry run lists every row missing on staging**, table by table, and
  writes nothing.
- **The apply inserts those rows one at a time.** When staging refuses one, the
  run records staging's own error for that row and carries on with the next.
  Staging's guards and foreign keys decide; the sync does not predict them.
- Run the dry run first: its `portal_field_maps` line shows how many field maps
  the apply will copy.

## Before you run

1. **Set a case type on production for three legacy templates:**
   `Anthem BCBS CO`, `Medcost - NC` and `Trinity Health System`. Their
   `case_type` is NULL on production, and staging refuses a template without one.
   Set it in the production Template Editor by publishing a new version with the
   case type; the app changes a case type only through a publish. A typed
   publish runs production's portal-binding check, so a step with no valid
   portal has to be fixed there first.

   **The sync never supplies a default case type.** Until this is done, the dry
   run lists the three as missing, and the apply shows staging's refusal for
   each under `sop_templates`:

   ```
   - <id> "Anthem BCBS CO": sop_case_type_required
   ```

   Each payer form attached to one of them is then held back under
   `payer_forms`, before its file is uploaded:
   `- <id> "<label>": template <id> is not on staging`.

2. Nothing to do for `Aetna - Direct`: the sync creates its portal (next
   section).

## The one portal the sync creates

`Aetna - Direct` (archived, contract) points at portal
`aetna-direct-contract-contract-1f94bf43c4c0`, which exists on neither project,
so staging's binding guard refused the template on Oct 27. The sync creates
that portal on staging just before it inserts the template (Sowmya, Oct 31).

It is one named entry in `scripts/ops/catalog-sync-created-portals.mjs`, not a
rule. A template that names any other missing portal is sent as it is, and the
run shows staging's refusal.

The row it writes, and why:

| Column       | Value                                                                  | Why                                                     |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `org_id`     | the template's (NULL for a global template)                            | the guard looks for the key in the template's own scope |
| `portal_key` | `aetna-direct-contract-contract-1f94bf43c4c0`                          | the template's key, trimmed and lower case              |
| `name`       | `Aetna - Direct contract (created by catalog sync; not on production)` | marks it as the sync's                                  |
| `payer_id`   | the template's payer                                                   | the guard needs the same payer                          |
| `case_type`  | the template's (`contract`)                                            | the guard needs the same case type                      |
| `form_url`   | NULL                                                                   | production has no row, so there is no URL to copy       |
| the rest     | column defaults and the insert trigger                                 | new id, unverified, no proof, explicit selection, gen 1 |

No field maps are written for it. The dry run shows it as:

```
portals created by the sync (not on production): 1 missing on staging, 0 held back
  + would create portal aetna-direct-contract-contract-1f94bf43c4c0 "Aetna - Direct contract (created by catalog sync; not on production)" for template <id> "Aetna - Direct" (global | org <id>, payer <id>, case type contract, no form URL, no field maps)
```

It creates the portal only when the `Aetna - Direct` template is missing on
staging (so the same run inserts it) and staging has no portal with that key in
the template's scope. Otherwise it creates nothing and says why (`not needed`,
or `already on staging`). If staging then refuses the template for another
reason, the portal stays and the template's refusal is shown; the next run
finds the portal already there and sends the template again.

If production later gets a real portal with this key, staging keeps the sync's
row: the copy is refused as a duplicate key and reported. Replace it
deliberately.

## What it copies

| Table                                     | Rule                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `payers`                                  | missing ids                                                                   |
| `portals`                                 | missing ids; org-owned rows only if the org exists on staging                 |
| `portal_field_maps`                       | for portals added in the same run: same org and key, plus org overrides       |
| `portals` (created)                       | the named entry above, only                                                   |
| `sop_templates` + `sop_template_versions` | missing ids; the versions of the templates added in the run                   |
| `payer_forms` + Storage `payer-forms`     | missing ids whose payer and template are on staging; the file is copied first |

- `created_by` / `published_by` / `retired_by` are dropped (those users do not
  exist on staging).
- **Versions.** Staging's `sop_template_seed_version` trigger writes each new
  template's current version as the template goes in. The apply reads staging's
  versions after the templates, so it leaves that version out and copies the
  earlier ones. The dry run, which inserts no template, lists it too.
- **Order.** A payer goes in before the payers merged into it; payer forms go in
  by family and version, each superseded form before the form that supersedes
  it.
- **Reads.** Every read pages in a stable order until a page comes back empty,
  so the PostgREST row cap never cuts a table short. A row added on production
  while the run reads may be missed; the next run copies it.
- **Storage.** A file already on staging (HTTP 409) is kept and its row still
  goes in; any other download or upload error skips the row. A form whose row
  staging then refuses leaves its file on staging; a later run reuses it.
- **Field maps.** A map goes with the new portal of its own org and key. An
  org's override of a **new global portal** (same key, `org_id` set) goes too,
  when that org is on staging and has no portal of its own with that key there
  or on production (an org map whose own portal this run did not add stays out:
  it belongs to that portal, not to the global one). Any other override of a new
  global portal is held back with the reason (`org … is not on staging`, or
  `org … already has its own … portal on staging, which keeps its own maps`).
  Maps of portals staging already had are left alone.
- **Field maps are copied (Sowmya, Nov 1).** The dry run shows the
  `portal_field_maps` count first; the apply copies them. There is no separate
  confirmation. Field-map writes go through audited paths: this staging sync
  now, Mission Control map approvals later. An extension URL-pattern change
  ships with its matching database change in the same PR.

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

Both modes print one block per table, with its count, then one line per row:

- dry run: `+ <id> "<name>"` for each row missing on staging, and
  `- <id> "<name>": <reason>` for each row the sync holds back (an org that is
  not on staging, a field map that stays with its own portal, a form whose
  payer or template is not there);
- apply: `+` for each row added, and `-` for each row not added, with
  staging's own error when staging refused it.

## The 14 payer forms left on Oct 27

The Oct 27 run left 14 payer forms (PDFs) on production only, and the list was
not written down. It is not needed: **the dry run lists every missing payer
form**, and the apply shows, for each one it could not add, why: its template
or payer is not on staging, its Storage file is missing on production, or
staging refused the row. Most of the 14 are expected to clear once the three
templates have a case type on production and the Aetna portal exists. A
template that names a production group staging does not have is refused by
staging (`sop_templates_group_id_fkey`), and its forms stay out with it; the
sync never copies or invents a group.

## Not copied

Rows that exist on both sides but differ (production ahead) are **not**
updated. Promote those deliberately.
