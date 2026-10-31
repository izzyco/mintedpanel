// Whole runs of the prod -> staging catalog sync against in-memory stand-ins
// for the two projects. Nothing here opens a connection. Imports only
// runCatalogSync, formatReport and the key helpers, so the file also runs
// against an older copy of the script to show what each case caught.
import assert from "node:assert/strict";
import test from "node:test";
import { SYNC_CREATED_PORTALS } from "./catalog-sync-created-portals.mjs";
import { formatReport, normalizePortalKey, templatePortalKeys } from "./catalog-sync.mjs";
import { runCatalogSync } from "./sync-catalog-to-staging.mjs";

const PROD_URL = "https://fkvuhfsqcmujywzgczmc.supabase.co";
const STAGING_URL = "https://vmznysvietfaddakkegt.supabase.co";
const AETNA_KEY = "aetna-direct-contract-contract-1f94bf43c4c0";
const LEGACY_NULL_CASE_TYPE = ["Anthem BCBS CO", "Medcost - NC", "Trinity Health System"];
const CASE_TYPE_PRECONDITION =
  "case_type is NULL on production. Set its case type on production first (runbook: Before you run, step 1); the sync never supplies one";
const CREATED = "portals created by the sync (not on production)";
const ALLOWED_CALLS = new Set(["select", "insert", "download", "upload"]);

const clone = (value) => JSON.parse(JSON.stringify(value));
const byTable = (report, table) => report.find((r) => r.table === table);

/**
 * A stand-in for a supabase-js client with ONLY the calls the sync may make:
 * select(count).order().range(), insert(), and Storage download()/upload().
 * Anything else (update, upsert, delete, rpc, remove) is not a function, so
 * it throws. A multi-row insert is all or nothing, and each row is checked
 * against the rows before it in the same insert (stricter than Postgres, which
 * checks foreign keys at the end of the statement).
 *
 * Options: refuse(table, row, tables) -> message; afterInsert(table, row,
 * tables) for triggers; capRows, the server's max rows per read; vanishAfter,
 * rows past which a read comes back empty; countDrift, added to the count
 * after the first page; uploadError(path, options) -> error.
 */
function memoryClient(tables, options = {}) {
  const {
    url,
    refuse = () => null,
    files = {},
    afterInsert = () => {},
    capRows = Infinity,
    vanishAfter = Infinity,
    countDrift = 0,
    uploadError,
  } = options;
  const calls = [];
  const compare = (a, b) =>
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  const project = (row, select) =>
    select === "*"
      ? { ...row }
      : Object.fromEntries(select.split(",").map((column) => [column.trim(), row[column.trim()]]));
  return {
    supabaseUrl: url,
    calls,
    tables,
    files,
    from(table) {
      return {
        select(select = "*", selectOptions = {}) {
          const orders = [];
          const builder = {
            order(column) {
              orders.push(column);
              return builder;
            },
            range(from, to) {
              calls.push(["select", table]);
              const all = [...(tables[table] ?? [])].sort(
                (a, b) =>
                  orders.reduce((result, column) => result || compare(a[column], b[column]), 0) ||
                  0,
              );
              const end = Math.min(to + 1, from + capRows, vanishAfter);
              const data = all.slice(from, Math.max(from, end)).map((r) => project(r, select));
              const count =
                selectOptions.count === "exact" ? all.length + (from > 0 ? countDrift : 0) : null;
              return Promise.resolve({ data, error: null, count });
            },
          };
          return builder;
        },
        insert(input) {
          const rows = Array.isArray(input) ? input : [input];
          calls.push(["insert", table, rows.map((r) => r.id ?? r.portal_key)]);
          const staged = [];
          for (const row of rows) {
            const view = { ...tables, [table]: [...(tables[table] ?? []), ...staged] };
            const message = refuse(table, row, view);
            if (message) return Promise.resolve({ error: { message } });
            staged.push({ ...row });
          }
          tables[table] = [...(tables[table] ?? []), ...staged];
          for (const row of staged) afterInsert(table, row, tables);
          return Promise.resolve({ error: null });
        },
      };
    },
    storage: {
      from(bucket) {
        return {
          download(path) {
            calls.push(["download", bucket, path]);
            return Promise.resolve(
              path in files
                ? { data: files[path], error: null }
                : {
                    data: null,
                    error: { status: 404, statusCode: "404", message: "Object not found" },
                  },
            );
          },
          upload(path, data, uploadOptions) {
            calls.push(["upload", bucket, path, uploadOptions]);
            const custom = uploadError?.(path, uploadOptions);
            if (custom) return Promise.resolve({ error: custom });
            if (path in files && !uploadOptions.upsert)
              return Promise.resolve({
                error: { status: 409, statusCode: "409", message: "Duplicate" },
              });
            files[path] = data;
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
}

/** Staging's insert guards, simplified and independent of the code under
 * test: the case type is required, every key a template names must have a
 * visible portal in its scope with its case type and payer, a typed portal
 * needs a payer, and the self-references must exist. */
function stagingGuards(table, row, tables) {
  if (table === "portals" && row.case_type != null && !row.payer_id)
    return "portal_configuration_payer_required";
  if (
    table === "portals" &&
    row.payer_id &&
    !(tables.payers ?? []).some((p) => p.id === row.payer_id)
  )
    return 'insert or update on table "portals" violates foreign key constraint "portals_payer_id_fkey"';
  if (table === "payers" && row.merged_into_id) {
    if (!(tables.payers ?? []).some((p) => p.id === row.merged_into_id))
      return 'insert or update on table "payers" violates foreign key constraint "payers_merged_into_id_fkey"';
  }
  if (table === "payer_forms" && row.supersedes_id) {
    if (!(tables.payer_forms ?? []).some((f) => f.id === row.supersedes_id))
      return 'insert or update on table "payer_forms" violates foreign key constraint "payer_forms_supersedes_id_fkey"';
  }
  if (table !== "sop_templates") return null;
  if (row.case_type == null) return "sop_case_type_required";
  for (const key of templatePortalKeys(row)) {
    const bound = (tables.portals ?? []).some(
      (p) =>
        normalizePortalKey(p.portal_key) === key &&
        (p.org_id ?? null) === (row.org_id ?? null) &&
        p.case_type === row.case_type &&
        p.payer_id === row.payer_id,
    );
    if (!bound)
      return `sop_portal_binding_ineligible: portal key "${key}" has no compatible case type, payer, or owner scope`;
  }
  // The foreign keys, checked after the BEFORE INSERT guards.
  if (row.group_id && !(tables.provider_groups ?? []).some((g) => g.id === row.group_id))
    return 'insert or update on table "sop_templates" violates foreign key constraint "sop_templates_group_id_fkey"';
  if (row.payer_id && !(tables.payers ?? []).some((p) => p.id === row.payer_id))
    return 'insert or update on table "sop_templates" violates foreign key constraint "sop_templates_payer_id_fkey"';
  return null;
}

/** Staging's AFTER INSERT sop_template_seed_version: version current_version
 * from the head row. */
function seedVersionTrigger(table, row, tables) {
  if (table !== "sop_templates") return;
  tables.sop_template_versions = [
    ...(tables.sop_template_versions ?? []),
    {
      id: `trigger-${row.id}`,
      template_id: row.id,
      version: row.current_version,
      name: row.name,
      seededByTrigger: true,
    },
  ];
}

const payer = (key, extra = {}) => ({
  id: `payer-${key}`,
  name: key,
  status: "active",
  archived_at: null,
  merged_into_id: null,
  ...extra,
});

const aetnaTemplate = (overrides = {}) => ({
  id: "tpl-aetna",
  org_id: null,
  name: "Aetna - Direct",
  payer_id: "payer-aetna",
  case_type: "contract",
  is_archived: true,
  current_version: 1,
  created_by: "prod-user",
  task_definitions: [
    { title: "Submit", steps: [{ stepType: "online_form", portalKey: AETNA_KEY }] },
  ],
  ...overrides,
});

function emptyProject(extra = {}) {
  return {
    organizations: [],
    payers: [],
    portals: [],
    portal_field_maps: [],
    sop_templates: [],
    sop_template_versions: [],
    payer_forms: [],
    ...extra,
  };
}

/** The Oct 27 shape: the three NULL case types, Aetna - Direct, and one typed
 * template whose portal exists nowhere (staging refuses it). */
function catalogFixture() {
  const payers = ["aetna", "anthem", "medcost", "trinity", "other"].map((key) => payer(key));
  const legacy = LEGACY_NULL_CASE_TYPE.map((name, i) => ({
    id: `tpl-legacy-${i}`,
    org_id: null,
    name,
    payer_id: payers[i + 1].id,
    case_type: null,
    current_version: 1,
    created_by: "prod-user",
    task_definitions: [],
  }));
  const other = {
    id: "tpl-other",
    org_id: null,
    name: "Other Payer contract",
    payer_id: "payer-other",
    case_type: "contract",
    current_version: 1,
    task_definitions: [{ steps: [{ portalKey: "other-portal-missing-everywhere" }] }],
  };
  const templates = [...legacy, aetnaTemplate(), other];
  const forms = templates.map((t, i) => ({
    id: `form-${i}`,
    template_id: t.id,
    payer_id: t.payer_id,
    family_id: `family-${i}`,
    version: 1,
    supersedes_id: null,
    label: `${t.name} supplement`,
    storage_path: `forms/${t.id}.pdf`,
    mime_type: "application/pdf",
    created_by: "prod-user",
  }));
  const production = emptyProject({
    payers,
    sop_templates: templates,
    sop_template_versions: templates.map((t) => ({
      id: `v-${t.id}-1`,
      template_id: t.id,
      version: 1,
      name: t.name,
    })),
    payer_forms: forms,
  });
  const staging = emptyProject({ payers: payers.map((p) => ({ ...p })) });
  const files = Object.fromEntries(forms.map((f) => [f.storage_path, `%PDF ${f.id}`]));
  return { production, staging, files };
}

function clients(production, staging, { files = {}, stagingFiles = {}, ...extra } = {}) {
  return {
    src: memoryClient(production, { url: PROD_URL, files }),
    dst: memoryClient(staging, {
      url: STAGING_URL,
      refuse: stagingGuards,
      afterInsert: seedVersionTrigger,
      files: stagingFiles,
      ...extra,
    }),
  };
}

// ---------- the Oct 27 shape ----------

test("the dry run writes nothing and says it would create the Aetna portal", async () => {
  const { production, staging, files } = catalogFixture();
  const before = JSON.stringify(staging);
  const { src, dst } = clients(production, staging, { files });
  const report = await runCatalogSync({ src, dst, apply: false });

  assert.equal(JSON.stringify(staging), before, "staging is unchanged");
  assert.deepEqual(
    [...new Set([...src.calls, ...dst.calls].map(([kind]) => kind))],
    ["select"],
    "a dry run only reads",
  );
  const created = byTable(report, CREATED);
  assert.equal(created.added, 1);
  assert.match(created.lines[0], new RegExp(`^would create portal ${AETNA_KEY} `));
  const templates = byTable(report, "sop_templates");
  for (const name of LEGACY_NULL_CASE_TYPE) {
    assert.ok(
      templates.reasons.some((r) => r.includes(`"${name}": ${CASE_TYPE_PRECONDITION}`)),
      `${name} is skipped with the precondition`,
    );
  }
  const text = formatReport(report, { apply: false });
  assert.match(text, /^DRY RUN \(pass --apply to write\)/);
  assert.match(text, new RegExp(`\\+ would create portal ${AETNA_KEY}`));
  for (const t of production.sop_templates.slice(0, 3)) assert.equal(t.case_type, null);
});

test("the dry run says 'would be refused' for a template staging's binding guard refuses, and for its forms", async () => {
  const { production, staging, files } = catalogFixture();
  const { src, dst } = clients(production, staging, { files });
  const report = await runCatalogSync({ src, dst, apply: false });
  const templates = byTable(report, "sop_templates");
  assert.equal(templates.added, 1, "only Aetna - Direct would go in");
  assert.ok(
    templates.reasons.some(
      (r) =>
        r.startsWith('tpl-other "Other Payer contract": would be refused: ') &&
        r.includes('portal key "other-portal-missing-everywhere"'),
    ),
  );
  const forms = byTable(report, "payer_forms");
  assert.equal(forms.added, 1);
  assert.ok(
    forms.reasons.some((r) =>
      r.includes('template tpl-other "Other Payer contract" would be refused: '),
    ),
  );
});

test("the dry run and the apply report the same counts, table by table", async () => {
  const { production, staging, files } = catalogFixture();
  const dry = await runCatalogSync({
    ...clients(production, clone(staging), { files }),
    apply: false,
  });
  const app = await runCatalogSync({ ...clients(production, staging, { files }), apply: true });
  for (const row of dry) {
    const applied = byTable(app, row.table);
    assert.deepEqual(
      [row.added, row.skipped],
      [applied.added, applied.skipped],
      `${row.table}: dry run ${row.added}/${row.skipped}, apply ${applied.added}/${applied.skipped}`,
    );
  }
});

test("the apply creates the portal before its template, and only ever inserts", async () => {
  const { production, staging, files } = catalogFixture();
  const { src, dst } = clients(production, staging, { files });
  const report = await runCatalogSync({ src, dst, apply: true });

  assert.ok(
    [...src.calls, ...dst.calls].every(([kind]) => ALLOWED_CALLS.has(kind)),
    "no update, upsert, delete or rpc",
  );
  assert.deepEqual(staging.portals, [
    {
      org_id: null,
      portal_key: AETNA_KEY,
      name: SYNC_CREATED_PORTALS[0].name,
      payer_id: "payer-aetna",
      case_type: "contract",
      form_url: null,
    },
  ]);
  assert.deepEqual(staging.portal_field_maps, [], "no field maps for the created portal");
  const inserts = dst.calls.filter(([kind]) => kind === "insert");
  const portalAt = inserts.findIndex(
    ([, table, ids]) => table === "portals" && ids[0] === AETNA_KEY,
  );
  const templateAt = inserts.findIndex(
    ([, table, ids]) => table === "sop_templates" && ids[0] === "tpl-aetna",
  );
  assert.ok(portalAt >= 0 && portalAt < templateAt, "portal first, then its template");
  assert.ok(
    !inserts.some(
      ([, table, ids]) =>
        table === "sop_templates" && (ids[0].startsWith("tpl-legacy") || ids[0] === "tpl-other"),
    ),
    "neither a NULL case type nor a template the guard refuses is sent",
  );
  assert.deepEqual(
    staging.sop_templates.map((t) => t.id),
    ["tpl-aetna"],
  );
  assert.equal(staging.sop_templates[0].created_by, undefined, "user columns are dropped");
  assert.ok(
    byTable(report, "sop_templates").reasons.some((r) =>
      r.startsWith('tpl-other "Other Payer contract": not sent: staging would refuse it: '),
    ),
  );
  assert.deepEqual(
    staging.payer_forms.map((f) => f.id),
    ["form-3"],
  );
  assert.deepEqual(
    dst.calls
      .filter(([kind]) => kind === "upload")
      .map(([, , path, options]) => [path, options.upsert]),
    [["forms/tpl-aetna.pdf", false]],
  );
  assert.match(byTable(report, CREATED).lines[0], new RegExp(`^created portal ${AETNA_KEY} `));

  // A second apply adds nothing new.
  const second = await runCatalogSync({ src, dst, apply: true });
  assert.equal(staging.portals.length, 1);
  assert.equal(byTable(second, CREATED).added, 0);
  assert.match(byTable(second, CREATED).reasons[0], /not needed/);
  assert.equal(byTable(second, "payer_forms").added, 0);
});

// ---------- review P2 1: a created portal its template still could not use ----------

test("no portal is created when another key on its template would still be refused", async () => {
  const tpl = aetnaTemplate({
    current_version: 2,
    task_definitions: [
      {
        steps: [
          { stepType: "online_form", portalKey: AETNA_KEY },
          { stepType: "online_form", portalKey: "aetna-other-missing" },
        ],
      },
    ],
  });
  const production = emptyProject({
    payers: [payer("aetna")],
    sop_templates: [tpl],
    sop_template_versions: [1, 2].map((version) => ({
      id: `v${version}`,
      template_id: tpl.id,
      version,
      name: `v${version}`,
    })),
  });
  const staging = emptyProject({ payers: [payer("aetna")] });
  const dry = await runCatalogSync({ ...clients(production, clone(staging)), apply: false });
  const created = byTable(dry, CREATED);
  assert.equal(created.added, 0);
  assert.match(
    created.reasons[0],
    /template tpl-aetna would still be refused: key "aetna-other-missing"/,
  );
  // With no portal created, the template is refused on its first key.
  assert.match(
    byTable(dry, "sop_templates").reasons[0],
    /would be refused: sop_portal_binding_ineligible/,
  );

  const { src, dst } = clients(production, staging);
  await runCatalogSync({ src, dst, apply: true });
  assert.deepEqual(staging.portals, [], "no unused global portal is left behind");
  assert.deepEqual(staging.sop_templates, []);
  assert.ok(!dst.calls.some(([kind, table]) => kind === "insert" && table === "portals"));
});

// ---------- review P3: versions, reads, order, field maps, uploads, direction ----------

test("the dry run's version count leaves out the copy staging's trigger writes", async () => {
  const tpl = {
    ...aetnaTemplate(),
    id: "tpl-b",
    name: "B",
    current_version: 3,
    task_definitions: [],
  };
  const production = emptyProject({
    payers: [payer("aetna")],
    sop_templates: [tpl],
    sop_template_versions: [1, 2, 3].map((version) => ({
      id: `v${version}`,
      template_id: tpl.id,
      version,
      name: `production v${version}`,
    })),
  });
  const staging = emptyProject({ payers: [payer("aetna")] });
  const dry = await runCatalogSync({ ...clients(production, clone(staging)), apply: false });
  const app = await runCatalogSync({ ...clients(production, staging), apply: true });
  assert.equal(byTable(dry, "sop_template_versions").added, 2);
  assert.equal(byTable(app, "sop_template_versions").added, 2);
  assert.equal(staging.sop_template_versions.length, 3);
  assert.equal(
    staging.sop_template_versions.find((v) => v.version === 3).seededByTrigger,
    true,
    "staging keeps the trigger's copy of the current version",
  );
});

test("a server cap below the page size still reads every row", async () => {
  const payers = ["a", "b", "c", "d", "e"].map((key) => payer(key));
  const production = emptyProject({ payers });
  const staging = emptyProject();
  const report = await runCatalogSync({
    src: memoryClient(production, { url: PROD_URL, capRows: 2 }),
    dst: memoryClient(staging, { url: STAGING_URL, capRows: 2 }),
    apply: false,
  });
  assert.equal(byTable(report, "payers").added, 5);
});

test("a read that stops short of its count, or whose count moves, fails loudly", async () => {
  const production = emptyProject({ payers: ["a", "b", "c", "d", "e"].map((key) => payer(key)) });
  await assert.rejects(
    runCatalogSync({
      src: memoryClient(production, { url: PROD_URL, capRows: 2, vanishAfter: 3 }),
      dst: memoryClient(emptyProject(), { url: STAGING_URL }),
      apply: false,
    }),
    /payers: read 3 of 5 rows/,
  );
  await assert.rejects(
    runCatalogSync({
      src: memoryClient(production, { url: PROD_URL, capRows: 2, countDrift: 1 }),
      dst: memoryClient(emptyProject(), { url: STAGING_URL }),
      apply: false,
    }),
    /payers: changed during the read/,
  );
});

test("a payer goes in before the payers merged into it", async () => {
  const survivor = payer("survivor");
  const loser = payer("loser", { status: "merged", merged_into_id: survivor.id });
  const production = emptyProject({ payers: [loser, survivor] });
  // The stand-in sorts reads by id; "payer-loser" < "payer-survivor".
  const staging = emptyProject();
  const report = await runCatalogSync({ ...clients(production, staging), apply: true });
  assert.deepEqual(
    staging.payers.map((p) => p.id),
    ["payer-survivor", "payer-loser"],
  );
  assert.equal(byTable(report, "payers").skipped, 0);
});

test("a superseded form goes in first, and a form whose predecessor cannot leaves no file", async () => {
  const tpl = { ...aetnaTemplate(), id: "tpl-c", name: "C", task_definitions: [] };
  const form = (id, version, supersedes) => ({
    id,
    template_id: tpl.id,
    payer_id: "payer-aetna",
    family_id: "family-c",
    version,
    supersedes_id: supersedes,
    label: "C supplement",
    storage_path: `payer/aetna/family-c/${version}/c.pdf`,
    mime_type: "application/pdf",
  });
  // "f-a" sorts before "f-b", so a read by id returns version 2 first.
  const v2 = form("f-a", 2, "f-b");
  const v1 = form("f-b", 1, null);
  const production = emptyProject({
    payers: [payer("aetna")],
    sop_templates: [tpl],
    payer_forms: [v2, v1],
  });
  const files = { [v1.storage_path]: "one", [v2.storage_path]: "two" };
  const staging = emptyProject({ payers: [payer("aetna")] });
  const stagingFiles = {};
  const report = await runCatalogSync({
    ...clients(production, staging, { files, stagingFiles }),
    apply: true,
  });
  assert.deepEqual(
    staging.payer_forms.map((f) => f.id),
    ["f-b", "f-a"],
  );
  assert.equal(byTable(report, "payer_forms").skipped, 0);

  // Version 1's file is missing on production: version 2 is skipped before
  // its upload, so no orphan file lands on staging.
  const missing = { [v2.storage_path]: "two" };
  const staging2 = emptyProject({ payers: [payer("aetna")] });
  const stagingFiles2 = {};
  const second = await runCatalogSync({
    ...clients(production, staging2, { files: missing, stagingFiles: stagingFiles2 }),
    apply: true,
  });
  assert.deepEqual(staging2.payer_forms, []);
  assert.deepEqual(Object.keys(stagingFiles2), [], "no file without its row");
  assert.ok(byTable(second, "payer_forms").reasons.some((r) => r.includes("supersedes form f-b")));
});

test("field maps follow the org and key of a portal this run adds, not the key alone", async () => {
  const key = "shared-key";
  const globalPortal = {
    id: "portal-global",
    org_id: null,
    portal_key: key,
    name: "Shared",
    payer_id: "payer-aetna",
    case_type: null,
  };
  const orgPortal = { ...globalPortal, id: "portal-org", org_id: "org-x", name: "Org X copy" };
  const stagingMap = { id: "map-staging", org_id: null, portal_key: key, field: "staging's own" };
  const production = emptyProject({
    organizations: [{ id: "org-x" }],
    payers: [payer("aetna")],
    portals: [globalPortal, orgPortal],
    portal_field_maps: [
      { id: "map-global", org_id: null, portal_key: key, field: "production global" },
      { id: "map-org", org_id: "org-x", portal_key: key, field: "production org x" },
    ],
  });
  const staging = emptyProject({
    organizations: [{ id: "org-x" }],
    payers: [payer("aetna")],
    portals: [{ ...globalPortal }],
    portal_field_maps: [stagingMap],
  });
  await runCatalogSync({ ...clients(production, staging), apply: true });
  assert.deepEqual(
    staging.portal_field_maps.map((m) => m.id),
    ["map-staging", "map-org"],
    "the portal staging already had keeps its own maps",
  );
});

test("an upload is 'already there' only on status 409, whatever the message says", async () => {
  const tpl = { ...aetnaTemplate(), id: "tpl-d", name: "D", task_definitions: [] };
  const form = {
    id: "f-d",
    template_id: tpl.id,
    payer_id: "payer-aetna",
    family_id: "family-d",
    version: 1,
    supersedes_id: null,
    label: "D supplement",
    storage_path: "payer/aetna/family-d/1/d.pdf",
    mime_type: "application/pdf",
  };
  const production = emptyProject({
    payers: [payer("aetna")],
    sop_templates: [tpl],
    payer_forms: [form],
  });
  const files = { [form.storage_path]: "d" };

  // A 409 without the word "exists": the file is there, so the row goes in.
  const staging = emptyProject({ payers: [payer("aetna")] });
  await runCatalogSync({
    ...clients(production, staging, { files, stagingFiles: { [form.storage_path]: "d" } }),
    apply: true,
  });
  assert.deepEqual(
    staging.payer_forms.map((f) => f.id),
    ["f-d"],
  );

  // Any other refusal, even one that says "exists", keeps the row out.
  const staging2 = emptyProject({ payers: [payer("aetna")] });
  const report = await runCatalogSync({
    ...clients(production, staging2, {
      files,
      uploadError: () => ({
        status: 415,
        statusCode: "415",
        message: "mime type exists in deny list",
      }),
    }),
    apply: true,
  });
  assert.deepEqual(staging2.payer_forms, []);
  assert.match(byTable(report, "payer_forms").reasons[0], /upload: mime type exists in deny list/);
});

test("runCatalogSync itself refuses any pair of clients but production -> staging", async () => {
  const cases = [
    [STAGING_URL, PROD_URL],
    [PROD_URL, PROD_URL],
    [STAGING_URL, STAGING_URL],
    [undefined, STAGING_URL],
    ["https://example.test", STAGING_URL],
  ];
  for (const [from, to] of cases) {
    const src = memoryClient(emptyProject(), { url: from });
    const dst = memoryClient(emptyProject(), { url: to });
    await assert.rejects(
      runCatalogSync({ src, dst, apply: false }),
      /must be the (production|staging) project|cannot tell which project/,
      String([from, to]),
    );
    assert.deepEqual([...src.calls, ...dst.calls], [], "refused before any read");
  }
});

// ---------- re-review: foreign keys, org overrides, degenerate tasks ----------

test("no portal is created when its template names a group staging lacks", async () => {
  const tpl = aetnaTemplate({ group_id: "prod-group-1" });
  const production = emptyProject({ payers: [payer("aetna")], sop_templates: [tpl] });
  const staging = emptyProject({ payers: [payer("aetna")], provider_groups: [] });
  const dry = await runCatalogSync({ ...clients(production, clone(staging)), apply: false });
  assert.equal(byTable(dry, CREATED).added, 0);
  assert.match(
    byTable(dry, CREATED).reasons[0],
    /template tpl-aetna would still be refused: group prod-group-1 is not on staging \(sop_templates_group_id_fkey -> provider_groups\); nothing created/,
  );
  assert.match(
    byTable(dry, "sop_templates").reasons[0],
    /would be refused: .*also group prod-group-1/,
  );

  const { src, dst } = clients(production, staging);
  const app = await runCatalogSync({ src, dst, apply: true });
  assert.deepEqual(staging.portals, [], "no portal left behind for a template that cannot go in");
  assert.ok(!dst.calls.some(([kind]) => kind === "insert"), "nothing is sent");
  for (const row of dry)
    assert.deepEqual(
      [row.added, row.skipped],
      [byTable(app, row.table).added, byTable(app, row.table).skipped],
    );

  // With the group on staging, the portal and the template both go in.
  const withGroup = emptyProject({
    payers: [payer("aetna")],
    provider_groups: [{ id: "prod-group-1" }],
  });
  await runCatalogSync({ ...clients(production, withGroup), apply: true });
  assert.equal(withGroup.portals.length, 1);
  assert.deepEqual(
    withGroup.sop_templates.map((t) => t.id),
    ["tpl-aetna"],
  );
});

test("a template whose payer is on neither project is not sent, in either mode", async () => {
  const tpl = {
    ...aetnaTemplate(),
    id: "tpl-ghost",
    name: "Ghost",
    payer_id: "payer-ghost",
    task_definitions: [],
  };
  const production = emptyProject({ sop_templates: [tpl] });
  const dry = await runCatalogSync({ ...clients(production, emptyProject()), apply: false });
  assert.equal(byTable(dry, "sop_templates").added, 0);
  assert.match(
    byTable(dry, "sop_templates").reasons[0],
    /would be refused: payer payer-ghost is not on staging \(sop_templates_payer_id_fkey -> payers\)/,
  );
  const staging = emptyProject();
  const { src, dst } = clients(production, staging);
  await runCatalogSync({ src, dst, apply: true });
  assert.ok(!dst.calls.some(([kind, table]) => kind === "insert" && table === "sop_templates"));
});

test("an org's override of a new global portal goes with it when the org is on staging", async () => {
  const globalPortal = {
    id: "portal-k",
    org_id: null,
    portal_key: "k",
    name: "K",
    payer_id: "payer-aetna",
    case_type: null,
  };
  const production = emptyProject({
    organizations: [{ id: "org-x" }, { id: "org-y" }, { id: "org-z" }],
    payers: [payer("aetna")],
    portals: [globalPortal],
    portal_field_maps: [
      { id: "m-global", org_id: null, portal_key: "k" },
      { id: "m-orgx", org_id: "org-x", portal_key: "k" },
      { id: "m-orgy", org_id: "org-y", portal_key: "k" },
      { id: "m-orgz", org_id: "org-z", portal_key: "k" },
    ],
  });
  const staging = emptyProject({
    organizations: [{ id: "org-x" }, { id: "org-z" }],
    payers: [payer("aetna")],
    // org-z already has its own k portal on staging, which keeps its own maps.
    portals: [{ ...globalPortal, id: "portal-k-z", org_id: "org-z", name: "K for Z" }],
  });
  const dry = await runCatalogSync({ ...clients(production, clone(staging)), apply: false });
  const maps = byTable(dry, "portal_field_maps");
  assert.equal(maps.added, 2);
  assert.ok(maps.reasons.some((r) => r.startsWith('m-orgy "k": org org-y is not on staging')));
  assert.ok(
    maps.reasons.some((r) => r.startsWith('m-orgz "k": org org-z already has its own k portal')),
  );
  await runCatalogSync({ ...clients(production, staging), apply: true });
  assert.deepEqual(
    staging.portal_field_maps.map((m) => m.id),
    ["m-global", "m-orgx"],
  );
});

test("degenerate task shapes are refused the way jsonb's ? operator reads them", async () => {
  const shapes = [["steps"], "steps", { steps: null }];
  const production = emptyProject({
    payers: [payer("aetna")],
    sop_templates: shapes.map((task, i) => ({
      ...aetnaTemplate(),
      id: `tpl-shape-${i}`,
      name: `Shape ${i}`,
      task_definitions: [task],
    })),
  });
  const dry = await runCatalogSync({
    ...clients(production, emptyProject({ payers: [payer("aetna")] })),
    apply: false,
  });
  const templates = byTable(dry, "sop_templates");
  assert.equal(templates.added, 0);
  assert.equal(
    templates.reasons.filter((r) => r.includes("would be refused: sop_task_steps_invalid")).length,
    3,
  );
});

test("an org's own maps never become overrides of the global portal when its own portal fails", async () => {
  const globalPortal = {
    id: "portal-g",
    org_id: null,
    portal_key: "k",
    name: "K",
    payer_id: "payer-aetna",
    case_type: null,
  };
  // org-x's own k portal names a payer staging does not have, so it is refused.
  const orgPortal = {
    ...globalPortal,
    id: "portal-o",
    org_id: "org-x",
    name: "K (org x)",
    payer_id: "payer-missing",
  };
  const production = emptyProject({
    organizations: [{ id: "org-x" }],
    payers: [payer("aetna")],
    portals: [globalPortal, orgPortal],
    portal_field_maps: [
      { id: "m-g", org_id: null, portal_key: "k" },
      { id: "m-o", org_id: "org-x", portal_key: "k" },
    ],
  });
  const staging = emptyProject({ organizations: [{ id: "org-x" }], payers: [payer("aetna")] });
  const report = await runCatalogSync({ ...clients(production, staging), apply: true });
  assert.deepEqual(
    staging.portals.map((p) => p.id),
    ["portal-g"],
  );
  assert.deepEqual(
    staging.portal_field_maps.map((m) => m.id),
    ["m-g"],
    "org-x's own map is not copied as an override of the global k",
  );
  assert.match(
    byTable(report, "portal_field_maps").reasons[0],
    /^m-o "k": the map belongs to org org-x's own k portal on production, which this run did not add on staging/,
  );
});
