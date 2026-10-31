import assert from "node:assert/strict";
import test from "node:test";
import { SYNC_CREATED_PORTALS } from "./catalog-sync-created-portals.mjs";
import {
  CASE_TYPE_PRECONDITION,
  PROD_REF,
  STAGING_REF,
  assertDirection,
  chunk,
  describeCreatedPortal,
  formatReport,
  normalizePortalKey,
  planAdds,
  planCreatedPortals,
  projectRef,
  splitByOrg,
  splitForms,
  splitTemplatesByCaseType,
  stripUserColumns,
  templatePortalKeys,
} from "./catalog-sync.mjs";
import { runCatalogSync } from "./sync-catalog-to-staging.mjs";

const url = (ref) => `https://${ref}.supabase.co`;

test("only prod -> staging is allowed", () => {
  assert.doesNotThrow(() => assertDirection(url(PROD_REF), url(STAGING_REF)));
  assert.throws(() => assertDirection(url(STAGING_REF), url(PROD_REF)));
  assert.throws(() => assertDirection(url(PROD_REF), url(PROD_REF)));
  assert.throws(() => assertDirection("", url(STAGING_REF)));
  assert.equal(projectRef("https://evil.example.com"), null);
});

test("planAdds returns missing rows only", () => {
  const src = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const dst = [{ id: "b" }, { id: "z" }];
  assert.deepEqual(planAdds(src, dst), [{ id: "a" }, { id: "c" }]);
  assert.deepEqual(planAdds(src, src), []);
});

test("planAdds takes a composite key", () => {
  const key = (r) => `${r.template_id}:${r.version}`;
  const src = [
    { template_id: "t", version: 1 },
    { template_id: "t", version: 2 },
  ];
  assert.deepEqual(planAdds(src, [{ template_id: "t", version: 1 }], key), [
    { template_id: "t", version: 2 },
  ]);
});

test("user columns are dropped", () => {
  assert.deepEqual(
    stripUserColumns({ id: 1, created_by: "u", published_by: "u", retired_by: "u" }),
    { id: 1 },
  );
});

test("org rows need their org on the target", () => {
  const rows = [
    { id: 1, org_id: null },
    { id: 2, org_id: "o1" },
    { id: 3, org_id: "o2" },
  ];
  const { ok, skipped } = splitByOrg(rows, new Set(["o1"]));
  assert.deepEqual(
    ok.map((r) => r.id),
    [1, 2],
  );
  assert.deepEqual(
    skipped.map((s) => s.row.id),
    [3],
  );
});

test("forms need payer and template on the target", () => {
  const have = { payers: new Set(["p"]), templates: new Set(["t"]) };
  const forms = [
    { id: 1, payer_id: "p", template_id: "t" },
    { id: 2, payer_id: "x", template_id: "t" },
    { id: 3, payer_id: "p", template_id: "x" },
  ];
  const { ok, skipped } = splitForms(forms, have);
  assert.deepEqual(
    ok.map((f) => f.id),
    [1],
  );
  assert.deepEqual(
    skipped.map((s) => s.reason),
    ["payer not on target", "template not on target"],
  );
});

test("chunk splits evenly", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

// ---------- precondition 1: legacy templates with no case type ----------

const LEGACY_NULL_CASE_TYPE = ["Anthem BCBS CO", "Medcost - NC", "Trinity Health System"];
const AETNA_KEY = "aetna-direct-contract-contract-1f94bf43c4c0";

test("a template with a NULL case type is skipped with the precondition, never defaulted", () => {
  const templates = [
    ...LEGACY_NULL_CASE_TYPE.map((name, i) => ({ id: `t${i}`, name, case_type: null })),
    { id: "t9", name: "Aetna - Direct", case_type: "contract" },
  ];
  const { ok, skipped } = splitTemplatesByCaseType(templates);
  assert.deepEqual(
    ok.map((t) => t.id),
    ["t9"],
  );
  assert.deepEqual(
    skipped.map((s) => s.row.name),
    LEGACY_NULL_CASE_TYPE,
  );
  for (const s of skipped) {
    assert.equal(s.reason, CASE_TYPE_PRECONDITION);
    assert.equal(s.row.case_type, null, "the row is reported as it is, with no case type supplied");
  }
  assert.match(CASE_TYPE_PRECONDITION, /NULL on production/);
  assert.match(CASE_TYPE_PRECONDITION, /Before you run, step 1/);
  assert.match(CASE_TYPE_PRECONDITION, /never supplies one/);
});

test("a form waiting on a held-back template names it and the reason", () => {
  const have = { payers: new Set(["p"]), templates: new Set(["t"]) };
  const held = new Map([["x", 'template x "Medcost - NC" is skipped: case_type is NULL']]);
  const { skipped } = splitForms(
    [
      { id: 1, payer_id: "p", template_id: "x" },
      { id: 2, payer_id: "p", template_id: "y" },
    ],
    have,
    held,
  );
  assert.deepEqual(
    skipped.map((s) => s.reason),
    ['template x "Medcost - NC" is skipped: case_type is NULL', "template not on target"],
  );
});

// ---------- the one portal the sync creates ----------

test("the created-portal list is one named, reviewable entry: Aetna - Direct", () => {
  assert.equal(SYNC_CREATED_PORTALS.length, 1);
  const [entry] = SYNC_CREATED_PORTALS;
  assert.equal(entry.portalKey, AETNA_KEY);
  assert.equal(entry.templateName, "Aetna - Direct");
  assert.equal(normalizePortalKey(entry.portalKey), entry.portalKey);
  assert.match(entry.name, /created by catalog sync/);
  assert.ok(!entry.name.startsWith("[hidden] "), "a hidden portal never binds");
  assert.ok(Object.isFrozen(SYNC_CREATED_PORTALS) && Object.isFrozen(entry));
});

test("template portal keys are read from every step, trimmed and lower-cased", () => {
  const keys = templatePortalKeys({
    task_definitions: [
      { steps: [{ portalKey: "  Alpha-Key " }, { stepType: "phone" }] },
      { steps: [{ portalKey: "beta" }] },
      { title: "no steps" },
    ],
  });
  assert.deepEqual([...keys], ["alpha-key", "beta"]);
  assert.equal(templatePortalKeys({ task_definitions: null }).size, 0);
});

const aetnaTemplate = (overrides = {}) => ({
  id: "tpl-aetna",
  name: "Aetna - Direct",
  org_id: null,
  payer_id: "payer-aetna",
  case_type: "contract",
  is_archived: true,
  task_definitions: [
    { title: "Submit", steps: [{ stepType: "online_form", portalKey: AETNA_KEY }] },
  ],
  ...overrides,
});
const activePayer = {
  id: "payer-aetna",
  status: "active",
  archived_at: null,
  merged_into_id: null,
};
const planFor = (templates, extra = {}) =>
  planCreatedPortals(SYNC_CREATED_PORTALS, {
    templates,
    targetPortals: [],
    targetOrgIds: new Set(),
    payersById: new Map([[activePayer.id, activePayer]]),
    ...extra,
  });

test("the Aetna portal row takes scope, payer and case type from its template, and nothing else", () => {
  const plan = planFor([aetnaTemplate()]);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.create.length, 1);
  assert.deepEqual(plan.create[0].row, {
    org_id: null,
    portal_key: AETNA_KEY,
    name: SYNC_CREATED_PORTALS[0].name,
    payer_id: "payer-aetna",
    case_type: "contract",
    form_url: null,
  });
  assert.equal(
    describeCreatedPortal(plan.create[0], { apply: false }),
    `would create portal ${AETNA_KEY} "${SYNC_CREATED_PORTALS[0].name}" for template tpl-aetna "Aetna - Direct" (global, payer payer-aetna, case type contract, no form URL, no field maps)`,
  );
  assert.match(describeCreatedPortal(plan.create[0], { apply: true }), /^created portal /);
  // An org template gets an org portal in the same org.
  const org = planFor([aetnaTemplate({ org_id: "org-1" })], { targetOrgIds: new Set(["org-1"]) });
  assert.equal(org.create[0].row.org_id, "org-1");
});

test("no portal is created when the template is not in this run, or the key is already there", () => {
  assert.match(planFor([]).skipped[0].reason, /^not needed/);
  assert.match(
    planFor([aetnaTemplate({ name: "Aetna - Direct (renamed)" })]).skipped[0].reason,
    /^not needed/,
  );
  const existing = [{ id: "portal-1", org_id: null, portal_key: AETNA_KEY.toUpperCase() }];
  const again = planFor([aetnaTemplate()], { targetPortals: existing });
  assert.equal(again.create.length, 0);
  assert.match(again.skipped[0].reason, /already on staging \(portal portal-1\)/);
  // An org template already sees a visible global row with the key.
  const shadowed = planFor([aetnaTemplate({ org_id: "org-1" })], {
    targetOrgIds: new Set(["org-1"]),
    targetPortals: existing,
  });
  assert.equal(shadowed.create.length, 0);
});

test("no portal is created that its template still could not use", () => {
  const archivedPayer = { ...activePayer, archived_at: "2026-10-01T00:00:00Z" };
  const cases = [
    [planFor([aetnaTemplate({ payer_id: null })]), /has no payer/],
    [planFor([aetnaTemplate({ org_id: "org-gone" })]), /not on staging/],
    [
      planFor([aetnaTemplate()], { payersById: new Map([[activePayer.id, archivedPayer]]) }),
      /is not active on staging/,
    ],
    [planFor([aetnaTemplate()], { payersById: new Map() }), /is not active on staging/],
    [planFor([aetnaTemplate(), aetnaTemplate({ id: "tpl-aetna-2" })]), /2 templates named/],
  ];
  for (const [plan, reason] of cases) {
    assert.equal(plan.create.length, 0);
    assert.match(plan.skipped[0].reason, reason);
  }
});

test("a template naming any other missing portal gets no portal: the list is not a rule", () => {
  const other = aetnaTemplate({
    id: "tpl-other",
    name: "Aetna - Direct",
    task_definitions: [{ steps: [{ portalKey: "some-other-missing-portal" }] }],
  });
  const plan = planFor([other]);
  assert.equal(plan.create.length, 0);
  assert.match(plan.skipped[0].reason, /^not needed/);
});

// ---------- the whole run, against in-memory stand-ins ----------

/** A stand-in for a supabase-js client with ONLY the calls the sync may make:
 * select().range(), insert(), and Storage download()/upload(). Anything else
 * (update, upsert, delete, rpc, remove) is not a function, so it throws. */
function memoryClient(tables, { refuse = () => null, files = {} } = {}) {
  const calls = [];
  const project = (row, select) =>
    select === "*"
      ? { ...row }
      : Object.fromEntries(select.split(",").map((column) => [column.trim(), row[column.trim()]]));
  return {
    calls,
    tables,
    files,
    from(table) {
      return {
        select(select = "*") {
          return {
            range(from, to) {
              calls.push(["select", table]);
              const rows = (tables[table] ?? []).slice(from, to + 1).map((r) => project(r, select));
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
        insert(input) {
          const rows = Array.isArray(input) ? input : [input];
          calls.push(["insert", table, rows.map((r) => r.id ?? r.portal_key)]);
          const message = rows.map((row) => refuse(table, row, tables)).find(Boolean);
          if (message) return Promise.resolve({ error: { message } });
          tables[table] = [...(tables[table] ?? []), ...rows.map((r) => ({ ...r }))];
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
                : { data: null, error: { message: "Object not found" } },
            );
          },
          upload(path, data, options) {
            calls.push(["upload", bucket, path, options]);
            files[path] = data;
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
}

/** Staging's two insert guards that matter here: sop_case_type_required and
 * the portal binding (validate_sop_template_portal_bindings), simplified. */
function stagingGuards(table, row, tables) {
  if (table === "portals" && row.case_type != null && !row.payer_id)
    return "portal_configuration_payer_required";
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
  return null;
}

function catalogFixture() {
  const payers = ["aetna", "anthem", "medcost", "trinity", "other"].map((key) => ({
    id: `payer-${key}`,
    name: key,
    status: "active",
    archived_at: null,
    merged_into_id: null,
  }));
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
  const aetna = { ...aetnaTemplate(), current_version: 1, created_by: "prod-user" };
  const other = {
    id: "tpl-other",
    org_id: null,
    name: "Other Payer contract",
    payer_id: "payer-other",
    case_type: "contract",
    current_version: 1,
    task_definitions: [{ steps: [{ portalKey: "other-portal-missing-everywhere" }] }],
  };
  const templates = [...legacy, aetna, other];
  const forms = templates.map((t, i) => ({
    id: `form-${i}`,
    template_id: t.id,
    payer_id: t.payer_id,
    label: `${t.name} supplement`,
    storage_path: `forms/${t.id}.pdf`,
    mime_type: "application/pdf",
    created_by: "prod-user",
  }));
  const production = {
    organizations: [],
    payers,
    portals: [],
    portal_field_maps: [],
    sop_templates: templates,
    sop_template_versions: templates.map((t) => ({ template_id: t.id, version: 1, name: t.name })),
    payer_forms: forms,
  };
  const staging = {
    organizations: [],
    payers: payers.map((p) => ({ ...p })),
    portals: [],
    portal_field_maps: [],
    sop_templates: [],
    sop_template_versions: [],
    payer_forms: [],
  };
  const files = Object.fromEntries(forms.map((f) => [f.storage_path, `%PDF ${f.id}`]));
  return { production, staging, files };
}

const byTable = (report, table) => report.find((r) => r.table === table);
const CREATED = "portals created by the sync (not on production)";
const ALLOWED_CALLS = new Set(["select", "insert", "download", "upload"]);

test("the dry run writes nothing and says it would create the Aetna portal", async () => {
  const { production, staging, files } = catalogFixture();
  const before = JSON.stringify(staging);
  const src = memoryClient(production, { files });
  const dst = memoryClient(staging, { refuse: stagingGuards });
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
  assert.equal(templates.added, 2, "Aetna - Direct and the other typed template");
  assert.equal(templates.skipped, 3);
  for (const name of LEGACY_NULL_CASE_TYPE) {
    assert.ok(
      templates.reasons.some((r) => r.includes(`"${name}": ${CASE_TYPE_PRECONDITION}`)),
      `${name} is skipped with the precondition`,
    );
  }
  const forms = byTable(report, "payer_forms");
  assert.equal(forms.added, 2);
  assert.equal(forms.skipped, 3);
  for (const reason of forms.reasons) assert.match(reason, /is skipped: case_type is NULL/);

  const text = formatReport(report, { apply: false });
  assert.match(text, /^DRY RUN \(pass --apply to write\)/);
  assert.match(text, new RegExp(`\\+ would create portal ${AETNA_KEY}`));
  assert.match(text, /sop_templates: 2 would add, 3 skipped/);
  // Production is read, never changed: the legacy rows keep their NULL case type.
  for (const t of production.sop_templates.slice(0, 3)) assert.equal(t.case_type, null);
});

test("the apply creates the portal before its template, and only ever inserts", async () => {
  const { production, staging, files } = catalogFixture();
  const src = memoryClient(production, { files });
  const dst = memoryClient(staging, { refuse: stagingGuards });
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
    !inserts.some(([, table, ids]) => table === "sop_templates" && ids[0].startsWith("tpl-legacy")),
    "a NULL case type is never sent to staging",
  );
  assert.deepEqual(
    staging.sop_templates.map((t) => t.id),
    ["tpl-aetna"],
  );
  assert.equal(staging.sop_templates[0].created_by, undefined, "user columns are dropped");

  // The unlisted dangling portal was not created; its template is refused and reported.
  const templates = byTable(report, "sop_templates");
  assert.ok(
    templates.reasons.some((r) =>
      r.startsWith('tpl-other "Other Payer contract": sop_portal_binding_ineligible'),
    ),
  );
  const forms = byTable(report, "payer_forms");
  assert.deepEqual(
    staging.payer_forms.map((f) => f.id),
    ["form-3"],
  );
  assert.ok(
    forms.reasons.some((r) =>
      r.includes('template tpl-other "Other Payer contract" was refused by staging'),
    ),
  );
  assert.deepEqual(
    dst.calls
      .filter(([kind]) => kind === "upload")
      .map(([, , path, options]) => [path, options.upsert]),
    [["forms/tpl-aetna.pdf", false]],
  );
  assert.match(byTable(report, CREATED).lines[0], new RegExp(`^created portal ${AETNA_KEY} `));

  // A second apply adds nothing new: the portal is not needed once its template is there.
  const second = await runCatalogSync({ src, dst, apply: true });
  assert.equal(staging.portals.length, 1);
  assert.equal(byTable(second, CREATED).added, 0);
  assert.match(byTable(second, CREATED).reasons[0], /not needed/);
  assert.equal(byTable(second, "payer_forms").added, 0);
});
