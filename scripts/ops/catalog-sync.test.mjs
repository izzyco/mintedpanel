import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { SYNC_CREATED_PORTALS } from "./catalog-sync-created-portals.mjs";
import {
  CASE_TYPE_PRECONDITION,
  PROD_REF,
  STAGING_REF,
  TEMPLATE_GUARD_MIGRATIONS,
  assertClientDirection,
  assertDirection,
  chunk,
  clientUrl,
  describeCreatedPortal,
  isStorageConflict,
  normalizePortalKey,
  orderForms,
  parentsFirst,
  planAdds,
  planCreatedPortals,
  projectRef,
  splitByOrg,
  splitForms,
  splitTemplatesByCaseType,
  splitTemplatesByGuard,
  stripUserColumns,
  templatePortalKeys,
  templateRefusal,
} from "./catalog-sync.mjs";

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

test("a created portal is dropped when another key on its template would still be refused", () => {
  const twoKeys = aetnaTemplate({
    task_definitions: [
      { steps: [{ portalKey: AETNA_KEY }, { stepType: "online_form", portalKey: "aetna-other" }] },
    ],
  });
  const plan = planFor([twoKeys]);
  assert.equal(plan.create.length, 0);
  assert.equal(
    plan.skipped[0].reason,
    'template tpl-aetna would still be refused: key "aetna-other" (sop_portal_binding_ineligible); nothing created',
  );
  // With the other key bound on staging, the portal is created.
  const bound = planFor([twoKeys], {
    targetPortals: [
      {
        id: "p2",
        org_id: null,
        portal_key: "aetna-other",
        name: "Other",
        payer_id: "payer-aetna",
        case_type: "contract",
      },
    ],
  });
  assert.equal(bound.create.length, 1);
});

// ---------- staging's template insert guards, restated ----------

const portal = (overrides = {}) => ({
  id: "portal-1",
  org_id: null,
  portal_key: "k",
  name: "Portal",
  payer_id: "payer-aetna",
  case_type: "contract",
  ...overrides,
});
const typed = (overrides = {}) =>
  aetnaTemplate({ task_definitions: [{ steps: [{ portalKey: "k" }] }], ...overrides });
const refusalOf = (template, portals, payers = [activePayer]) =>
  templateRefusal(template, {
    portals,
    payersById: new Map(payers.map((p) => [p.id, p])),
  })?.code ?? null;

test("the binding check accepts exactly one visible row with the template's type and payer", () => {
  assert.equal(refusalOf(typed(), [portal()]), null);
  assert.equal(refusalOf(typed(), [portal({ portal_key: "  K " })]), null, "lower(btrim()) match");
  assert.equal(refusalOf(typed(), []), "sop_portal_binding_ineligible");
  assert.equal(
    refusalOf(typed(), [portal({ case_type: "enrollment" })]),
    "sop_portal_binding_ineligible",
  );
  assert.equal(
    refusalOf(typed(), [portal({ payer_id: "payer-x" })]),
    "sop_portal_binding_ineligible",
  );
  assert.equal(
    refusalOf(typed(), [portal({ name: "[hidden] Portal" })]),
    "sop_portal_binding_ineligible",
    "a hidden row never binds",
  );
  assert.equal(
    refusalOf(typed(), [portal(), portal({ id: "portal-2" })]),
    "sop_portal_binding_ambiguous",
  );
});

test("a global row needs an active payer; an org row does not", () => {
  const archived = { ...activePayer, archived_at: "2026-10-01T00:00:00Z" };
  const merged = { ...activePayer, merged_into_id: "payer-other" };
  const retired = { ...activePayer, status: "retired" };
  for (const payer of [archived, merged, retired])
    assert.equal(refusalOf(typed(), [portal()], [payer]), "sop_portal_binding_ineligible");
  assert.equal(refusalOf(typed(), [portal()], []), "sop_portal_binding_ineligible");
  const orgTemplate = typed({ org_id: "org-1" });
  assert.equal(refusalOf(orgTemplate, [portal({ org_id: "org-1" })], [archived]), null);
});

test("an org row shadows the global row with the same key, even an unusable one", () => {
  const orgTemplate = typed({ org_id: "org-1" });
  assert.equal(refusalOf(orgTemplate, [portal()]), null, "no org row: the global row serves");
  assert.equal(
    refusalOf(orgTemplate, [
      portal(),
      portal({ id: "portal-org", org_id: "org-1", case_type: "enrollment" }),
    ]),
    "sop_portal_binding_ineligible",
  );
  assert.equal(
    refusalOf(orgTemplate, [
      portal(),
      portal({ id: "portal-org", org_id: "org-1", name: "[hidden] x" }),
    ]),
    null,
    "a hidden org row does not shadow",
  );
  assert.equal(
    refusalOf(typed(), [portal({ org_id: "org-1" })]),
    "sop_portal_binding_ineligible",
    "a global template never sees org rows",
  );
});

test("step rules: an online form needs a portal, a step type must be known, steps must be a list", () => {
  const withSteps = (steps) => typed({ task_definitions: [{ steps }] });
  assert.equal(
    refusalOf(withSteps([{ stepType: "online_form" }]), []),
    "sop_portal_binding_required",
  );
  assert.equal(
    refusalOf(withSteps([{}]), []),
    "sop_portal_binding_required",
    "no type = online form",
  );
  assert.equal(refusalOf(withSteps([{ stepType: "phone" }]), []), null);
  assert.equal(refusalOf(withSteps([{ stepType: "carrier_pigeon" }]), []), "sop_step_type_invalid");
  assert.equal(
    refusalOf(typed({ task_definitions: [{ steps: {} }] }), []),
    "sop_task_steps_invalid",
  );
  assert.equal(refusalOf(typed({ task_definitions: {} }), []), "task_definitions_invalid");
  assert.equal(refusalOf(typed({ case_type: null }), []), "sop_case_type_required");
  assert.equal(
    refusalOf(typed({ id: "00000000-0000-4000-a000-00000000e17b", task_definitions: [] }), []),
    "fallback_sop_case_type_invalid",
  );
  const split = splitTemplatesByGuard([typed(), typed({ id: "t-org", org_id: "org-gone" })], {
    portals: [portal()],
    payersById: new Map([[activePayer.id, activePayer]]),
    targetOrgIds: new Set(),
  });
  assert.deepEqual(
    split.ok.map((t) => t.id),
    ["tpl-aetna"],
  );
  assert.equal(split.refused[0].refusal.code, "org_not_on_target");
});

test("the restated guards are the latest definitions in supabase/migrations", async () => {
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  for (const [fn, expected] of Object.entries(TEMPLATE_GUARD_MIGRATIONS)) {
    const defining = [];
    const definition = new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`);
    for (const name of files) {
      if (definition.test(await readFile(new URL(name, dir), "utf8"))) defining.push(name);
    }
    assert.ok(defining.length > 0, `${fn} is defined somewhere`);
    assert.equal(
      defining.at(-1),
      expected,
      `${fn} was redefined after ${expected}: update templateRefusal, then this pin`,
    );
  }
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
