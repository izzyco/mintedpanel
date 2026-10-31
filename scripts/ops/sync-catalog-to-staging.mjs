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
// payer_forms (+ Storage files). Portal field maps are copied only for portals
// this run adds (same org and key), so a portal staging already has keeps its
// own maps. A template whose case_type is NULL on production is skipped, never
// defaulted (runbook precondition 1). A template staging's insert guards would
// refuse is not sent, in either mode, so the dry run and the apply agree.
//
// runCatalogSync takes the two clients and refuses any pair but production ->
// staging, so the tests drive it with in-memory stand-ins. The only client
// calls it makes are select(count: exact).order().range(), insert(), and
// Storage download() / upload(upsert: false).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SYNC_CREATED_PORTALS } from "./catalog-sync-created-portals.mjs";
import {
  assertClientDirection,
  assertDirection,
  chunk,
  describeCreatedPortal,
  formatReport,
  formatSkip,
  isStorageConflict,
  orderForms,
  parentsFirst,
  planAdds,
  planCreatedPortals,
  planFieldMaps,
  splitByOrg,
  splitForms,
  splitTemplatesByCaseType,
  splitTemplatesByGuard,
  stripUserColumns,
} from "./catalog-sync.mjs";

const PAGE_ROWS = 1000;

/**
 * Every row of a table, in a stable order, or an error. Each page asks for the
 * exact count; the read ends when it has that many rows, and fails loudly if
 * the count moves or a page comes back empty first, so a capped or racing read
 * is never silently incomplete.
 */
export async function readAll(client, table, select = "*", order = ["id"]) {
  const rows = [];
  let expected;
  for (;;) {
    let query = client.from(table).select(select, { count: "exact" });
    for (const column of order) query = query.order(column, { ascending: true });
    const { data, error, count } = await query.range(rows.length, rows.length + PAGE_ROWS - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!Array.isArray(data)) throw new Error(`${table}: the read returned no rows payload`);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error(`${table}: the read returned no exact count, so it cannot be checked`);
    if (expected === undefined) expected = count;
    else if (count !== expected)
      throw new Error(`${table}: changed during the read (${expected} rows, then ${count})`);
    rows.push(...data);
    if (rows.length > expected)
      throw new Error(`${table}: read ${rows.length} rows, more than its count of ${expected}`);
    if (rows.length === expected) return rows;
    if (data.length === 0)
      throw new Error(
        `${table}: read ${rows.length} of ${expected} rows; the rest never came back`,
      );
  }
}

const VERSION_ORDER = ["template_id", "version"];

export async function runCatalogSync({ src, dst, apply, createdPortals = SYNC_CREATED_PORTALS }) {
  // The direction is checked here too, on the clients, not only in main().
  assertClientDirection(src, dst);
  const report = [];
  const note = (table, added, skipped = [], lines = []) => {
    report.push({ table, added, skipped: skipped.length, reasons: skipped.map(formatSkip), lines });
  };

  /** Insert rows that are missing, one at a time so a guard rejecting one row does not stop the rest. */
  async function insertEach(table, rows, label = () => undefined) {
    const added = [];
    const skipped = [];
    for (const row of rows) {
      if (!apply) {
        added.push(row);
        continue;
      }
      const { error } = await dst.from(table).insert(row);
      if (error) skipped.push({ id: row.id, label: label(row), reason: error.message });
      else added.push(row);
    }
    return { added, skipped };
  }

  async function insertBatches(table, rows) {
    if (!apply) return { added: rows, skipped: [] };
    const added = [];
    const skipped = [];
    for (const batch of chunk(rows, 50)) {
      const { error } = await dst.from(table).insert(batch);
      if (!error) added.push(...batch);
      else {
        const each = await insertEach(table, batch);
        added.push(...each.added);
        skipped.push(...each.skipped);
      }
    }
    return { added, skipped };
  }

  const orgs = new Set((await readAll(dst, "organizations", "id")).map((o) => o.id));
  // Org-owned rows the sync never copies; a template naming a group staging
  // lacks fails sop_templates_group_id_fkey.
  const groups = new Set((await readAll(dst, "provider_groups", "id")).map((g) => g.id));

  // 1. payers (global catalog)
  const targetPayers = await readAll(dst, "payers");
  // A payer goes in before the payers merged into it (merged_into_id).
  const payers = parentsFirst(
    planAdds(await readAll(src, "payers"), targetPayers).map(stripUserColumns),
    (row) => row.merged_into_id,
  );
  const p = await insertBatches("payers", payers);
  note("payers", p.added.length, p.skipped);

  // 2. portals
  const targetPortals = await readAll(dst, "portals");
  const portalPlan = planAdds(await readAll(src, "portals"), targetPortals).map(stripUserColumns);
  const portalSplit = splitByOrg(portalPlan, orgs);
  const portals = await insertBatches("portals", portalSplit.ok);
  note("portals", portals.added.length, [
    ...portalSplit.skipped.map((s) => ({ id: s.row.portal_key, reason: s.reason })),
    ...portals.skipped,
  ]);

  // 3. portal_field_maps, only for portals added now: same org (NULL for a
  //    global portal) and same key, plus each org's override of a new global
  //    portal when that org is on staging (planFieldMaps).
  const mapPlan = planFieldMaps((await readAll(src, "portal_field_maps")).map(stripUserColumns), {
    addedPortals: portals.added,
    targetPortals,
    targetOrgIds: orgs,
  });
  const m = await insertBatches("portal_field_maps", mapPlan.ok);
  note("portal_field_maps", m.added.length, [
    ...mapPlan.skipped.map((s) => ({ id: s.row.id, label: s.row.portal_key, reason: s.reason })),
    ...m.skipped,
  ]);

  // 4. sop_templates. Precondition 1 first: a NULL case type is skipped, never
  //    defaulted. Then the named portals the remaining templates need, so they
  //    exist before staging's binding guard checks the template insert. Then
  //    the guard itself, restated (templateRefusal): a template it would
  //    refuse is not sent, and the dry run says so.
  const tplSplit = splitTemplatesByCaseType(
    planAdds(await readAll(src, "sop_templates"), await readAll(dst, "sop_templates")).map(
      stripUserColumns,
    ),
  );
  const payersById = new Map([...targetPayers, ...p.added].map((row) => [row.id, row]));
  const bindablePortals = [...targetPortals, ...portals.added];
  const createdPlan = planCreatedPortals(createdPortals, {
    templates: tplSplit.ok,
    targetPortals: bindablePortals,
    targetOrgIds: orgs,
    targetGroupIds: groups,
    payersById,
  });
  const created = [];
  const createdSkipped = [...createdPlan.skipped];
  for (const plan of createdPlan.create) {
    if (apply) {
      const { error } = await dst.from("portals").insert(plan.row);
      if (error) {
        createdSkipped.push({
          id: plan.row.portal_key,
          label: plan.row.name,
          reason: error.message,
        });
        continue;
      }
    }
    bindablePortals.push(plan.row);
    created.push(describeCreatedPortal(plan, { apply }));
  }
  note("portals created by the sync (not on production)", created.length, createdSkipped, created);

  const guarded = splitTemplatesByGuard(tplSplit.ok, {
    portals: bindablePortals,
    payersById,
    targetOrgIds: orgs,
    targetGroupIds: groups,
  });
  const refusedReason = (message) =>
    apply ? `not sent: staging would refuse it: ${message}` : `would be refused: ${message}`;
  const tpl = await insertEach("sop_templates", guarded.ok, (row) => row.name);
  note("sop_templates", tpl.added.length, [
    ...tplSplit.skipped.map((s) => ({ id: s.row.id, label: s.row.name, reason: s.reason })),
    ...guarded.refused.map((s) => ({
      id: s.row.id,
      label: s.row.name,
      reason: refusedReason(s.refusal.message),
    })),
    ...tpl.skipped,
  ]);
  // Staging's sop_template_seed_version trigger writes each new template's
  // current version from the head row as it is inserted; that copy stays, and
  // production's row for that version is not sent. A dry run leaves it out too.
  const tplIds = new Set(tpl.added.map((t) => t.id));
  const haveVersions = apply
    ? await readAll(dst, "sop_template_versions", "template_id,version", VERSION_ORDER)
    : tpl.added
        .filter((t) => t.current_version != null)
        .map((t) => ({ template_id: t.id, version: t.current_version }));
  const versions = planAdds(
    (await readAll(src, "sop_template_versions", "*", VERSION_ORDER)).filter((row) =>
      tplIds.has(row.template_id),
    ),
    haveVersions,
    (r) => `${r.template_id}:${r.version}`,
  ).map(stripUserColumns);
  const v = await insertEach("sop_template_versions", versions);
  note("sop_template_versions", v.added.length, v.skipped);

  // 5. payer_forms and their Storage files. A form whose template is held
  //    back or refused names that template and the reason.
  const skippedTemplates = new Map([
    ...tplSplit.skipped.map((s) => [
      s.row.id,
      `template ${s.row.id} "${s.row.name}" is skipped: case_type is NULL on production (precondition 1)`,
    ]),
    ...guarded.refused.map((s) => [
      s.row.id,
      `template ${s.row.id} "${s.row.name}" would be refused: ${s.refusal.message}`,
    ]),
    ...tpl.skipped.map((s) => [
      s.id,
      `template ${s.id} "${s.label ?? "?"}" was refused by staging: ${s.reason}`,
    ]),
  ]);
  const targetPayerIds = new Set((await readAll(dst, "payers", "id")).map((r) => r.id));
  const targetTemplates = new Set((await readAll(dst, "sop_templates", "id")).map((r) => r.id));
  if (!apply) {
    for (const r of payers) targetPayerIds.add(r.id);
    for (const r of guarded.ok) targetTemplates.add(r.id);
  }
  const targetForms = await readAll(dst, "payer_forms");
  // By family and version, each superseded form before the form that
  // supersedes it (supersedes_id references payer_forms).
  const formPlan = orderForms(planAdds(await readAll(src, "payer_forms"), targetForms)).map(
    stripUserColumns,
  );
  const haveForms = new Set(targetForms.map((row) => row.id));
  const formLabel = (f) => f.label ?? f.file_name ?? undefined;
  const formSplit = splitForms(
    formPlan,
    { payers: targetPayerIds, templates: targetTemplates },
    skippedTemplates,
  );
  const formsAdded = [];
  const formsSkipped = formSplit.skipped.map((s) => ({
    id: s.row.id,
    label: formLabel(s.row),
    reason: s.reason,
  }));
  for (const f of formSplit.ok) {
    // Checked before any upload, so a form that cannot go in leaves no file.
    if (f.supersedes_id && !haveForms.has(f.supersedes_id)) {
      formsSkipped.push({
        id: f.id,
        label: formLabel(f),
        reason: `supersedes form ${f.supersedes_id}, which is not on staging and is not added in this run`,
      });
      continue;
    }
    if (!apply) {
      formsAdded.push(f);
      haveForms.add(f.id);
      continue;
    }
    const file = await src.storage.from("payer-forms").download(f.storage_path);
    if (file.error) {
      formsSkipped.push({
        id: f.id,
        label: formLabel(f),
        reason: `download: ${file.error.message}`,
      });
      continue;
    }
    const up = await dst.storage
      .from("payer-forms")
      .upload(f.storage_path, file.data, { contentType: f.mime_type ?? undefined, upsert: false });
    // Already there (409) is fine: the row still needs inserting.
    if (up.error && !isStorageConflict(up.error)) {
      formsSkipped.push({ id: f.id, label: formLabel(f), reason: `upload: ${up.error.message}` });
      continue;
    }
    const ins = await insertEach("payer_forms", [f], formLabel);
    if (ins.skipped.length) formsSkipped.push(...ins.skipped);
    else {
      formsAdded.push(f);
      haveForms.add(f.id);
    }
  }
  note("payer_forms", formsAdded.length, formsSkipped);

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
