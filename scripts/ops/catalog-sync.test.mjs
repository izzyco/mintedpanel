import assert from "node:assert/strict";
import test from "node:test";
import { SYNC_CREATED_PORTALS } from "./catalog-sync-created-portals.mjs";
import {
  PROD_REF,
  STAGING_REF,
  assertClientDirection,
  assertDirection,
  clientUrl,
  describeCreatedPortal,
  formatReport,
  isStorageConflict,
  normalizePortalKey,
  orderForms,
  parentsFirst,
  planAdds,
  planCreatedPortals,
  planFieldMaps,
  projectRef,
  splitByOrg,
  splitForms,
  stripUserColumns,
  templatePortalKeys,
} from "./catalog-sync.mjs";

const url = (ref) => `https://${ref}.supabase.co`;
const AETNA_KEY = "aetna-direct-contract-contract-1f94bf43c4c0";

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

test("forms need payer and template on staging", () => {
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
    ["payer x is not on staging", "template x is not on staging"],
  );
});

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
const planFor = (templates, targetPortals = []) =>
  planCreatedPortals(SYNC_CREATED_PORTALS, { templates, targetPortals });

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
  assert.equal(planFor([aetnaTemplate({ org_id: "org-1" })]).create[0].row.org_id, "org-1");
});

test("no portal is created when the template is not missing, or the key is already there", () => {
  assert.match(planFor([]).skipped[0].reason, /^not needed/);
  assert.match(
    planFor([aetnaTemplate({ name: "Aetna - Direct (renamed)" })]).skipped[0].reason,
    /^not needed/,
  );
  const existing = [{ id: "portal-1", org_id: null, portal_key: AETNA_KEY.toUpperCase() }];
  const again = planFor([aetnaTemplate()], existing);
  assert.equal(again.create.length, 0);
  assert.match(again.skipped[0].reason, /already on staging \(portal portal-1\)/);
  // The same key in another scope does not count.
  assert.equal(planFor([aetnaTemplate({ org_id: "org-1" })], existing).create.length, 1);
  assert.match(
    planFor([aetnaTemplate(), aetnaTemplate({ id: "tpl-aetna-2" })]).skipped[0].reason,
    /2 templates named "Aetna - Direct"/,
  );
  assert.match(
    planFor([aetnaTemplate({ case_type: null })]).skipped[0].reason,
    /no payer or no case type/,
  );
  // Any other missing portal is never created: the list is not a rule.
  const other = aetnaTemplate({
    id: "tpl-other",
    name: "Other",
    task_definitions: [{ steps: [{ portalKey: "other-missing" }] }],
  });
  assert.deepEqual(planFor([other]).create, []);
});

test("the report lists every row: + missing or added, - held back or refused", () => {
  const report = [
    { table: "payers", added: ['p1 "Aetna"'], skipped: [] },
    { table: "sop_templates", added: [], skipped: ['t1 "Anthem BCBS CO": sop_case_type_required'] },
  ];
  assert.equal(
    formatReport(report, { apply: false }),
    'DRY RUN (pass --apply to write)\npayers: 1 missing on staging, 0 held back\n  + p1 "Aetna"\nsop_templates: 0 missing on staging, 1 held back\n  - t1 "Anthem BCBS CO": sop_case_type_required\n',
  );
  assert.match(formatReport(report, { apply: true }), /^APPLIED\npayers: 1 added, 0 not added\n/);
});

// ---------- order, conflicts, direction ----------

test("parents go before children; the rest keep their order", () => {
  const rows = [
    { id: "c", parent: "b" },
    { id: "x", parent: null },
    { id: "b", parent: "a" },
    { id: "a", parent: "outside" },
  ];
  assert.deepEqual(
    parentsFirst(rows, (r) => r.parent).map((r) => r.id),
    ["a", "b", "c", "x"],
  );
  const cycle = [
    { id: "p", parent: "q" },
    { id: "q", parent: "p" },
  ];
  assert.equal(parentsFirst(cycle, (r) => r.parent).length, 2);
  const forms = orderForms([
    { id: "3", family_id: "f", version: 2, supersedes_id: "9" },
    { id: "9", family_id: "f", version: 1, supersedes_id: null },
    { id: "1", family_id: "e", version: 1, supersedes_id: null },
  ]);
  assert.deepEqual(
    forms.map((f) => f.id),
    ["1", "9", "3"],
  );
});

test("an upload conflict is status 409, never a message match", () => {
  assert.equal(isStorageConflict({ status: 409, message: "Duplicate" }), true);
  assert.equal(isStorageConflict({ status: 400, statusCode: "409", message: "x" }), true);
  assert.equal(isStorageConflict({ status: 400, message: "The resource already exists" }), false);
  assert.equal(isStorageConflict(null), false);
});

test("the client direction check reads each client's own project URL", () => {
  const client = (supabaseUrl) => ({ supabaseUrl });
  assert.doesNotThrow(() => assertClientDirection(client(url(PROD_REF)), client(url(STAGING_REF))));
  assert.throws(() => assertClientDirection(client(url(STAGING_REF)), client(url(PROD_REF))));
  assert.throws(() => clientUrl({}), /cannot tell which project/);
  assert.throws(() => clientUrl(null), /cannot tell which project/);
});

// ---------- field maps ----------

test("field maps: own org and key, plus org overrides of a new global portal", () => {
  const added = [
    { org_id: null, portal_key: "g" },
    { org_id: "org-1", portal_key: "o" },
  ];
  const { ok, skipped } = planFieldMaps(
    [
      { id: 1, org_id: null, portal_key: "g" },
      { id: 2, org_id: "org-1", portal_key: "g" },
      { id: 3, org_id: "org-gone", portal_key: "g" },
      { id: 4, org_id: "org-2", portal_key: "g" },
      { id: 5, org_id: "org-1", portal_key: "o" },
      { id: 6, org_id: null, portal_key: "o" },
      { id: 7, org_id: null, portal_key: "old" },
    ],
    {
      addedPortals: added,
      targetPortals: [{ org_id: "org-2", portal_key: "g" }],
      targetOrgIds: new Set(["org-1", "org-2"]),
    },
  );
  assert.deepEqual(
    ok.map((m) => m.id),
    [1, 2, 5],
  );
  assert.deepEqual(
    skipped.map((s) => [s.row.id, s.reason.split(",")[0]]),
    [
      [3, "org org-gone is not on staging"],
      [4, "org org-2 already has its own g portal on staging"],
    ],
  );
  // An org map whose own portal is on production, but was not added here,
  // stays with that portal: it is never read as an override of the global g.
  const held = planFieldMaps([{ id: 8, org_id: "org-1", portal_key: "g" }], {
    addedPortals: added,
    sourcePortals: [
      { org_id: null, portal_key: "g" },
      { org_id: "org-1", portal_key: "g" },
    ],
    targetPortals: [],
    targetOrgIds: new Set(["org-1"]),
  });
  assert.deepEqual(held.ok, []);
  assert.match(
    held.skipped[0].reason,
    /^the map belongs to org org-1's own g portal on production, which this run did not add on staging/,
  );
});
