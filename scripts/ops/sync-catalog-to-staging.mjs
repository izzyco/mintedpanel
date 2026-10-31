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
// this run adds, so a portal staging already has keeps its own maps. A
// template whose case_type is NULL on production is skipped, never defaulted
// (runbook precondition 1).
//
// runCatalogSync takes the two clients, so the tests drive it with in-memory
// stand-ins; the only client calls it makes are select().range(), insert(),
// and Storage download() / upload(upsert: false).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SYNC_CREATED_PORTALS } from "./catalog-sync-created-portals.mjs";
import {
  assertDirection,
  chunk,
  describeCreatedPortal,
  formatReport,
  formatSkip,
  planAdds,
  planCreatedPortals,
  splitByOrg,
  splitForms,
  splitTemplatesByCaseType,
  stripUserColumns,
} from "./catalog-sync.mjs";

async function all(client, table, select = "*") {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from(table)
      .select(select)
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

export async function runCatalogSync({ src, dst, apply, createdPortals = SYNC_CREATED_PORTALS }) {
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

  const orgs = new Set((await all(dst, "organizations", "id")).map((o) => o.id));

  // 1. payers (global catalog)
  const targetPayers = await all(dst, "payers");
  const payers = planAdds(await all(src, "payers"), targetPayers).map(stripUserColumns);
  const p = await insertBatches("payers", payers);
  note("payers", p.added.length, p.skipped);

  // 2. portals
  const targetPortals = await all(dst, "portals");
  const portalPlan = planAdds(await all(src, "portals"), targetPortals).map(stripUserColumns);
  const portalSplit = splitByOrg(portalPlan, orgs);
  const portals = await insertBatches("portals", portalSplit.ok);
  note("portals", portals.added.length, [
    ...portalSplit.skipped.map((s) => ({ id: s.row.portal_key, reason: s.reason })),
    ...portals.skipped,
  ]);

  // 3. portal_field_maps, only for portals added now
  const newKeys = new Set(portals.added.map((r) => r.portal_key));
  const maps = (await all(src, "portal_field_maps"))
    .filter((m) => newKeys.has(m.portal_key))
    .map(stripUserColumns);
  const m = await insertBatches("portal_field_maps", maps);
  note("portal_field_maps", m.added.length, m.skipped);

  // 4. sop_templates. Precondition 1 first: a NULL case type is skipped, never
  //    defaulted. Then the named portals the remaining templates need, so they
  //    exist before staging's binding guard checks the template insert.
  const tplSplit = splitTemplatesByCaseType(
    planAdds(await all(src, "sop_templates"), await all(dst, "sop_templates")).map(
      stripUserColumns,
    ),
  );
  const createdPlan = planCreatedPortals(createdPortals, {
    templates: tplSplit.ok,
    targetPortals: [...targetPortals, ...portals.added],
    targetOrgIds: orgs,
    payersById: new Map([...targetPayers, ...p.added].map((row) => [row.id, row])),
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
    created.push(describeCreatedPortal(plan, { apply }));
  }
  note("portals created by the sync (not on production)", created.length, createdSkipped, created);

  const tpl = await insertEach("sop_templates", tplSplit.ok, (row) => row.name);
  note("sop_templates", tpl.added.length, [
    ...tplSplit.skipped.map((s) => ({ id: s.row.id, label: s.row.name, reason: s.reason })),
    ...tpl.skipped,
  ]);
  const tplIds = new Set(tpl.added.map((t) => t.id));
  const haveVersions = apply ? await all(dst, "sop_template_versions", "template_id,version") : [];
  const versions = planAdds(
    (await all(src, "sop_template_versions")).filter((v) => tplIds.has(v.template_id)),
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
    ...tpl.skipped.map((s) => [
      s.id,
      `template ${s.id} "${s.label ?? "?"}" was refused by staging: ${s.reason}`,
    ]),
  ]);
  const targetPayerIds = new Set((await all(dst, "payers", "id")).map((r) => r.id));
  const targetTemplates = new Set((await all(dst, "sop_templates", "id")).map((r) => r.id));
  if (!apply) {
    for (const r of payers) targetPayerIds.add(r.id);
    for (const r of tplSplit.ok) targetTemplates.add(r.id);
  }
  const formPlan = planAdds(await all(src, "payer_forms"), await all(dst, "payer_forms")).map(
    stripUserColumns,
  );
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
    if (!apply) {
      formsAdded.push(f);
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
    if (up.error && !/exists/i.test(up.error.message)) {
      formsSkipped.push({ id: f.id, label: formLabel(f), reason: `upload: ${up.error.message}` });
      continue;
    }
    const ins = await insertEach("payer_forms", [f], formLabel);
    if (ins.skipped.length) formsSkipped.push(...ins.skipped);
    else formsAdded.push(f);
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
