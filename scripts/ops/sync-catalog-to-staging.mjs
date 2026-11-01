#!/usr/bin/env node
// Copies the shared catalog from PRODUCTION to STAGING. Additive only: rows
// missing on staging are inserted; nothing is updated or deleted. Dry run unless
// --apply. See docs/ops/catalog-sync-prod-to-staging.md.
//
//   SYNC_SOURCE_URL / SYNC_SOURCE_SERVICE_KEY   production project
//   SYNC_TARGET_URL / SYNC_TARGET_SERVICE_KEY   staging project
//
// Order matters: payers -> portals -> portal_field_maps -> the portals the sync
// creates (catalog-sync-created-portals.mjs) -> sop_templates (+versions) ->
// payer_forms (+ Storage files). The dry run lists every row missing on
// staging. The apply inserts them one at a time; when staging refuses one, the
// run reports staging's own error and carries on with the next.
//
// runCatalogSync takes the two clients and refuses any pair but production ->
// staging, so the tests drive it with in-memory stand-ins. The only client
// calls it makes are select().order().range(), insert(), and Storage
// download() / upload(upsert: false).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SYNC_CREATED_PORTALS } from "./catalog-sync-created-portals.mjs";
import {
  assertClientDirection,
  assertDirection,
  describeCreatedPortal,
  formatReport,
  formatRow,
  isStorageConflict,
  orderForms,
  parentsFirst,
  planAdds,
  planCreatedPortals,
  planFieldMaps,
  splitByOrg,
  splitForms,
  stripUserColumns,
} from "./catalog-sync.mjs";

const PAGE_ROWS = 1000;

/** Every row of a table, in a stable order: page until a page comes back
 * empty, so a server cap below PAGE_ROWS still reads everything. */
export async function readAll(client, table, select = "*", order = ["id"]) {
  const rows = [];
  for (;;) {
    let query = client.from(table).select(select);
    for (const column of order) query = query.order(column, { ascending: true });
    const { data, error } = await query.range(rows.length, rows.length + PAGE_ROWS - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) return rows;
    rows.push(...data);
  }
}

const VERSION_ORDER = ["template_id", "version"];
const ids = (rows) => new Set(rows.map((row) => row.id));

export async function runCatalogSync({ src, dst, apply, createdPortals = SYNC_CREATED_PORTALS }) {
  // The direction is checked here too, on the clients, not only in main().
  assertClientDirection(src, dst);
  const report = [];
  const held = (rows, id, label) => rows.map((s) => formatRow(id(s.row), label(s.row), s.reason));

  /** A dry run lists the rows. An apply inserts them one at a time and keeps
   * going past a refusal, which it records with staging's own message. */
  async function insertEach(table, rows, label = () => undefined) {
    const added = [];
    const refused = [];
    for (const row of rows) {
      if (apply) {
        const { error } = await dst.from(table).insert(row);
        if (error) {
          refused.push(formatRow(row.id, label(row), error.message));
          continue;
        }
      }
      added.push(row);
    }
    return { added, refused, lines: added.map((row) => formatRow(row.id, label(row))) };
  }

  const orgs = ids(await readAll(dst, "organizations", "id"));

  // 1. payers (global catalog). A payer goes in before the payers merged into it.
  const payers = parentsFirst(
    planAdds(await readAll(src, "payers"), await readAll(dst, "payers")).map(stripUserColumns),
    (row) => row.merged_into_id,
  );
  const p = await insertEach("payers", payers, (row) => row.name);
  report.push({ table: "payers", added: p.lines, skipped: p.refused });

  // 2. portals: the global ones, and those of orgs that exist on staging.
  const targetPortals = await readAll(dst, "portals");
  const sourcePortals = await readAll(src, "portals");
  const portalSplit = splitByOrg(
    planAdds(sourcePortals, targetPortals).map(stripUserColumns),
    orgs,
  );
  const portals = await insertEach("portals", portalSplit.ok, (row) => row.portal_key);
  report.push({
    table: "portals",
    added: portals.lines,
    skipped: [
      ...held(
        portalSplit.skipped,
        (row) => row.id,
        (row) => row.portal_key,
      ),
      ...portals.refused,
    ],
  });

  // 3. portal_field_maps for the portals added now: same org (NULL for a
  //    global portal) and same key, plus each org's override of a new global
  //    portal when that org is on staging (planFieldMaps).
  const mapPlan = planFieldMaps((await readAll(src, "portal_field_maps")).map(stripUserColumns), {
    addedPortals: portals.added,
    sourcePortals,
    targetPortals,
    targetOrgIds: orgs,
  });
  const m = await insertEach("portal_field_maps", mapPlan.ok, (row) => row.portal_key);
  report.push({
    table: "portal_field_maps",
    added: m.lines,
    skipped: [
      ...held(
        mapPlan.skipped,
        (row) => row.id,
        (row) => row.portal_key,
      ),
      ...m.refused,
    ],
  });

  // 4. The named portals (catalog-sync-created-portals.mjs), so they exist
  //    before the templates that need them; then the templates.
  const templates = planAdds(
    await readAll(src, "sop_templates"),
    await readAll(dst, "sop_templates"),
  ).map(stripUserColumns);
  const createdPlan = planCreatedPortals(createdPortals, {
    templates,
    targetPortals: [...targetPortals, ...portals.added],
  });
  const created = { added: [], skipped: [] };
  for (const plan of createdPlan.create) {
    const { error } = apply ? await dst.from("portals").insert(plan.row) : { error: null };
    if (error) created.skipped.push(formatRow(plan.row.portal_key, plan.row.name, error.message));
    else created.added.push(describeCreatedPortal(plan, { apply }));
  }
  for (const s of createdPlan.skipped) created.skipped.push(formatRow(s.id, s.label, s.reason));
  report.push({ table: "portals created by the sync (not on production)", ...created });

  const tpl = await insertEach("sop_templates", templates, (row) => row.name);
  report.push({ table: "sop_templates", added: tpl.lines, skipped: tpl.refused });

  // Versions of the templates added now. Staging's sop_template_seed_version
  // trigger writes each new template's current version as the template goes
  // in, so the apply reads staging's versions after the templates and leaves
  // that one out. A dry run, which inserts no template, lists it.
  const tplIds = ids(tpl.added);
  const versions = planAdds(
    (await readAll(src, "sop_template_versions", "*", VERSION_ORDER)).filter((row) =>
      tplIds.has(row.template_id),
    ),
    await readAll(dst, "sop_template_versions", "template_id,version", VERSION_ORDER),
    (r) => `${r.template_id}:${r.version}`,
  ).map(stripUserColumns);
  const v = await insertEach(
    "sop_template_versions",
    versions,
    (row) => `${row.template_id} v${row.version}`,
  );
  report.push({ table: "sop_template_versions", added: v.lines, skipped: v.refused });

  // 5. payer_forms and their Storage files, each superseded form before the
  //    form that supersedes it. A form whose payer or template is not on
  //    staging is held back before its file is uploaded.
  const have = {
    payers: ids(await readAll(dst, "payers", "id")),
    templates: ids(await readAll(dst, "sop_templates", "id")),
  };
  if (!apply) {
    for (const row of payers) have.payers.add(row.id);
    for (const row of templates) have.templates.add(row.id);
  }
  const formLabel = (f) => f.label ?? f.file_name ?? undefined;
  const formRow = (f, reason) => formatRow(f.id, formLabel(f), reason);
  const formSplit = splitForms(
    orderForms(planAdds(await readAll(src, "payer_forms"), await readAll(dst, "payer_forms"))).map(
      stripUserColumns,
    ),
    have,
  );
  const forms = { added: [], skipped: held(formSplit.skipped, (row) => row.id, formLabel) };
  for (const f of formSplit.ok) {
    if (apply) {
      const file = await src.storage.from("payer-forms").download(f.storage_path);
      if (file.error) {
        forms.skipped.push(formRow(f, `download: ${file.error.message}`));
        continue;
      }
      const up = await dst.storage.from("payer-forms").upload(f.storage_path, file.data, {
        contentType: f.mime_type ?? undefined,
        upsert: false,
      });
      // Already there (409) is fine: the row still needs inserting.
      if (up.error && !isStorageConflict(up.error)) {
        forms.skipped.push(formRow(f, `upload: ${up.error.message}`));
        continue;
      }
      const { error } = await dst.from("payer_forms").insert(f);
      if (error) {
        forms.skipped.push(formRow(f, error.message));
        continue;
      }
    }
    forms.added.push(formRow(f));
  }
  report.push({ table: "payer_forms", ...forms });
  return report;
}

function env(key) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const srcUrl = env("SYNC_SOURCE_URL");
  const dstUrl = env("SYNC_TARGET_URL");
  assertDirection(srcUrl, dstUrl);
  const { createClient } = await import("@supabase/supabase-js");
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const src = createClient(srcUrl, env("SYNC_SOURCE_SERVICE_KEY"), opts);
  const dst = createClient(dstUrl, env("SYNC_TARGET_SERVICE_KEY"), opts);
  const report = await runCatalogSync({ src, dst, apply });
  process.stdout.write(formatReport(report, { apply }));
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error(`catalog sync: ${error.message}`);
    process.exitCode = 1;
  });
}
