// Whole runs of the prod -> staging catalog sync against in-memory stand-ins
// for the two projects. Nothing here opens a connection.
import assert from "node:assert/strict";
import test from "node:test";
import { SYNC_CREATED_PORTALS } from "./catalog-sync-created-portals.mjs";
import { formatReport, normalizePortalKey, templatePortalKeys } from "./catalog-sync.mjs";
import { runCatalogSync } from "./sync-catalog-to-staging.mjs";

const PROD_URL = "https://fkvuhfsqcmujywzgczmc.supabase.co";
const STAGING_URL = "https://vmznysvietfaddakkegt.supabase.co";
const AETNA_KEY = "aetna-direct-contract-contract-1f94bf43c4c0";
const LEGACY_NULL_CASE_TYPE = ["Anthem BCBS CO", "Medcost - NC", "Trinity Health System"];
const CREATED = "portals created by the sync (not on production)";
const ALLOWED_CALLS = new Set(["select", "insert", "download", "upload"]);

const clone = (value) => JSON.parse(JSON.stringify(value));
const byTable = (report, table) => report.find((r) => r.table === table);

/**
 * A stand-in for a supabase-js client with ONLY the calls the sync may make:
 * select().order().range(), insert(), and Storage download()/upload().
 * Anything else (update, upsert, delete, rpc, remove) is not a function, so
 * it throws. A multi-row insert is all or nothing, and each row is checked
 * against the rows before it in the same insert (stricter than Postgres, which
 * checks foreign keys at the end of the statement).
 *
 * Options: refuse(table, row, tables) -> message; afterInsert(table, row,
 * tables) for triggers; capRows, the server's max rows per read;
 * uploadError(path, options) -> error.
 */
function memoryClient(tables, options = {}) {
  const {
    url,
    refuse = () => null,
    files = {},
    afterInsert = () => {},
    capRows = Infinity,
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
        select(select = "*") {
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
              const end = Math.min(to + 1, from + capRows);
              const data = all.slice(from, Math.max(from, end)).map((r) => project(r, select));
              return Promise.resolve({ data, error: null });
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
  current_version: 2,
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
    sop_template_versions: templates.flatMap((t) =>
      Array.from({ length: t.current_version }, (_, i) => ({
        id: `v-${t.id}-${i + 1}`,
        template_id: t.id,
        version: i + 1,
        name: t.name,
      })),
    ),
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

test("the dry run writes nothing and lists every row missing on staging", async () => {
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
  assert.deepEqual(byTable(report, "payers").added, [], "staging has every payer");
  const templates = byTable(report, "sop_templates");
  assert.deepEqual(
    templates.added,
    production.sop_templates.map((t) => `${t.id} "${t.name}"`).sort(),
    "every missing template is listed, NULL case types included",
  );
  assert.deepEqual(templates.skipped, []);
  // Every version of every missing template, the current one included.
  assert.equal(byTable(report, "sop_template_versions").added.length, 6);
  assert.equal(byTable(report, "payer_forms").added.length, 5);
  const created = byTable(report, CREATED);
  assert.equal(created.added.length, 1);
  assert.match(created.added[0], new RegExp(`^would create portal ${AETNA_KEY} `));
  const text = formatReport(report, { apply: false });
  assert.match(text, /^DRY RUN \(pass --apply to write\)\npayers: 0 missing on staging/);
  assert.match(text, /\nportal_field_maps: 0 missing on staging, 0 held back\n/);
  assert.match(text, new RegExp(`\\+ would create portal ${AETNA_KEY}`));
  assert.match(text, /\n {2}\+ tpl-legacy-0 "Anthem BCBS CO"\n/);
});

test("the apply inserts one row at a time, reports staging's refusal and carries on", async () => {
  const { production, staging, files } = catalogFixture();
  const { src, dst } = clients(production, staging, { files });
  const report = await runCatalogSync({ src, dst, apply: true });

  assert.ok(
    [...src.calls, ...dst.calls].every(([kind]) => ALLOWED_CALLS.has(kind)),
    "no update, upsert, delete or rpc",
  );
  assert.deepEqual(
    [...new Set(src.calls.map(([kind]) => kind))].sort(),
    ["download", "select"],
    "production is only read, even during an apply",
  );
  assert.deepEqual(production, catalogFixture().production, "production rows are unchanged");
  const inserts = dst.calls.filter(([kind]) => kind === "insert");
  assert.ok(
    inserts.every(([, , ids]) => ids.length === 1),
    "one row per insert",
  );

  // Staging refuses the three NULL case types and the template whose portal
  // exists nowhere; each is reported with staging's own message.
  const templates = byTable(report, "sop_templates");
  assert.deepEqual(templates.added, ['tpl-aetna "Aetna - Direct"']);
  LEGACY_NULL_CASE_TYPE.forEach((name, i) =>
    assert.ok(templates.skipped.includes(`tpl-legacy-${i} "${name}": sop_case_type_required`)),
  );
  assert.ok(
    templates.skipped.some((line) =>
      line.startsWith('tpl-other "Other Payer contract": sop_portal_binding_ineligible'),
    ),
  );
  assert.deepEqual(
    staging.sop_templates.map((t) => t.id),
    ["tpl-aetna"],
  );
  assert.equal(staging.sop_templates[0].created_by, undefined, "user columns are dropped");

  // The Aetna portal goes in before its template, with no field maps.
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
  assert.deepEqual(staging.portal_field_maps, []);
  const portalAt = inserts.findIndex(
    ([, table, ids]) => table === "portals" && ids[0] === AETNA_KEY,
  );
  const templateAt = inserts.findIndex(
    ([, table, ids]) => table === "sop_templates" && ids[0] === "tpl-aetna",
  );
  assert.ok(portalAt >= 0 && portalAt < templateAt, "portal first, then its template");
  assert.match(byTable(report, CREATED).added[0], new RegExp(`^created portal ${AETNA_KEY} `));

  // Staging's trigger wrote version 2 as the template went in; only version 1 is sent.
  assert.deepEqual(byTable(report, "sop_template_versions").added, [
    'v-tpl-aetna-1 "tpl-aetna v1"',
  ]);
  assert.deepEqual(
    staging.sop_template_versions.map((v) => `${v.template_id}:${v.version}`).sort(),
    ["tpl-aetna:1", "tpl-aetna:2"],
  );

  // Forms of refused templates are held back before their file is uploaded.
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
  assert.ok(
    byTable(report, "payer_forms").skipped.includes(
      'form-0 "Anthem BCBS CO supplement": template tpl-legacy-0 is not on staging',
    ),
  );

  // A second apply adds nothing new and reports the same refusals again.
  const second = await runCatalogSync({ src, dst, apply: true });
  assert.equal(staging.portals.length, 1);
  assert.deepEqual(byTable(second, CREATED).added, []);
  assert.match(byTable(second, CREATED).skipped[0], /not needed/);
  assert.deepEqual(byTable(second, "sop_templates").added, []);
  assert.equal(byTable(second, "sop_templates").skipped.length, 4);
  assert.deepEqual(byTable(second, "payer_forms").added, []);
});

test("a server cap below the page size still reads every row", async () => {
  const payers = Array.from({ length: 23 }, (_, i) => payer(`p${String(i).padStart(2, "0")}`));
  const production = emptyProject({ payers });
  const staging = emptyProject();
  const src = memoryClient(production, { url: PROD_URL, capRows: 7 });
  const dst = memoryClient(staging, { url: STAGING_URL, capRows: 7 });
  const report = await runCatalogSync({ src, dst, apply: true });
  assert.equal(byTable(report, "payers").added.length, 23);
  assert.equal(staging.payers.length, 23);
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
  assert.deepEqual(byTable(report, "payers").skipped, []);
});

test("a superseded form goes in before the form that supersedes it", async () => {
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
  const report = await runCatalogSync({ ...clients(production, staging, { files }), apply: true });
  assert.deepEqual(
    staging.payer_forms.map((f) => f.id),
    ["f-b", "f-a"],
  );
  assert.deepEqual(byTable(report, "payer_forms").skipped, []);
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
  const dry = await runCatalogSync({ ...clients(production, clone(staging)), apply: false });
  assert.deepEqual(byTable(dry, "portal_field_maps").added, ['map-org "shared-key"']);
  await runCatalogSync({ ...clients(production, staging), apply: true });
  assert.deepEqual(
    staging.portal_field_maps.map((m) => m.id),
    ["map-staging", "map-org"],
    "the portal staging already had keeps its own maps",
  );
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
  assert.equal(maps.added.length, 2);
  assert.ok(maps.skipped.some((r) => r.startsWith('m-orgy "k": org org-y is not on staging')));
  assert.ok(
    maps.skipped.some((r) => r.startsWith('m-orgz "k": org org-z already has its own k portal')),
  );
  await runCatalogSync({ ...clients(production, staging), apply: true });
  assert.deepEqual(
    staging.portal_field_maps.map((m) => m.id),
    ["m-global", "m-orgx"],
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
  assert.match(
    byTable(report, "portals").skipped[0],
    /^portal-o "k": insert or update on table "portals" violates foreign key constraint/,
  );
  assert.deepEqual(
    staging.portal_field_maps.map((m) => m.id),
    ["m-g"],
    "org-x's own map is not copied as an override of the global k",
  );
  assert.match(
    byTable(report, "portal_field_maps").skipped[0],
    /^m-o "k": the map belongs to org org-x's own k portal on production, which this run did not add on staging/,
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
  assert.match(byTable(report, "payer_forms").skipped[0], /upload: mime type exists in deny list/);
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
