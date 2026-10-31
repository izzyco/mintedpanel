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
rule. A template that names any other missing portal is inserted as it is,
staging refuses it, and the run lists it as skipped.

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

It creates nothing, and says why, when the template is already on staging, a row
with the key is already visible to it, the template has no payer, its org is not
on staging, or, for a global template, its payer is not active on staging (the
template would be refused anyway). If production later gets a real portal with
this key, staging keeps the sync's row: the copy is refused as a duplicate key
and reported. Replace it deliberately.

## What it copies

| Table                                     | Rule                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `payers`                                  | missing ids                                                                                  |
| `portals`                                 | missing ids; org-owned rows only if the org exists on staging                                |
| `portal_field_maps`                       | only for portals added in the same run                                                       |
| `portals` (created)                       | the named entries above, only                                                                |
| `sop_templates` + `sop_template_versions` | missing ids with a case type (step 1); staging's guard triggers decide, rejects are reported |
| `payer_forms` + Storage `payer-forms`     | missing ids with their payer and template on staging; file is copied                         |

`created_by` / `published_by` / `retired_by` are dropped (those users do not
exist on staging).

## Run

```sh
export SYNC_SOURCE_URL=https://fkvuhfsqcmujywzgczmc.supabase.co   # production
export SYNC_SOURCE_SERVICE_KEY=...                                  # production service role
export SYNC_TARGET_URL=https://vmznysvietfaddakkegt.supabase.co    # staging
export SYNC_TARGET_SERVICE_KEY=...                                  # staging service role

npm run sync:catalog-to-staging              # dry run: reads both, writes nothing
npm run sync:catalog-to-staging -- --apply   # writes
```

The script refuses any other source/target pair. Keys come from the operator's
shell; never commit them.

Both modes print one block per table: how many rows it would add (or added),
and every row it would skip (or skipped), with its id, its name and the reason.

## The 14 payer forms left on Oct 27

The Oct 27 run left 14 payer forms (PDFs) on production only, and the list was
not written down. It is not needed: **the dry run lists every payer form it would
skip, with the reason**, and a form held back by its template names that
template. Most of the 14 are expected to clear once the three templates have a
case type on production and the Aetna portal exists, because a form is copied
only when its template is on staging.

The dry run cannot foresee a template that staging refuses at apply time for
another reason. The apply lists that template, and each of its forms, with
staging's error.

## Not copied

Rows that exist on both sides but differ (production ahead) are **not**
updated. Promote those deliberately.
