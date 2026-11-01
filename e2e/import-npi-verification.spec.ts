// MINT-110 PR 2 / MINT-119 — NPI Registry checks while an import is reviewed,
// over the mock harness. /api/npi-registry/verify-batch is mocked at the
// browser: nothing reaches our server's route or NPPES. Synthetic names and
// check-digit-valid made-up NPIs only. The page clock is installed so the
// budget's pacing waits (one batch of ten every ~10 s after a burst of 20) can
// be skipped with fastForward instead of waited out.
//   1. A 100-row provider CSV goes through the wizard's bulk import (upload →
//      scan → Ready for review → Review & commit). The review checks the 100
//      new providers' NPIs ten at a time: the progress bar advances, the time
//      left shows once it can be estimated, and the panel ends in a
//      completion state. Each row carries its note (an organization number,
//      not found, a different name); nothing else on the review changes and
//      every row stays committable. Only NPIs are sent.
//   2. Cancelling the import mid-check aborts the request in flight and no
//      further lookups are sent.
//   3. Stop ends the checks: rows left say "not checked", focus lands on the
//      status line (not the page body), and Commit still works.
//   4. Leaving the review mid-check aborts the request in flight and no
//      further lookups are sent.
//   5. A39: Commit never waits for the checks: while one is still in flight,
//      the confirm step says how many go in not checked, the commit goes
//      through with every row, and the check in flight is aborted.
import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type Route,
} from "./fixtures/legacy-access-context";
import type { NpiRegistryRecord } from "../src/lib/npiRegistry";

const AUTH_KEY = "sb-example-auth-token";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "99999991-0000-4000-8000-0000000000aa";
const NOW = "2026-10-31T12:00:00Z";

const SESSION = {
  access_token: "fake-access-token",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 9999999999,
  refresh_token: "fake-refresh-token",
  user: {
    id: USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: "sowmya.seed@example.test",
    app_metadata: { provider: "email" },
    user_metadata: { full_name: "Sowmya Seed" },
    created_at: "2026-07-09T00:00:00Z",
  },
};

/* --------------------------- Synthetic providers -------------------------- */

// The CMS check digit (Luhn over the 80840 prefix), so every NPI below is
// well formed and made up.
function npiCheckDigit(first9: string): number {
  const prefixed = `80840${first9}`;
  let sum = 0;
  let double = true;
  for (let index = prefixed.length - 1; index >= 0; index -= 1) {
    let digit = Number(prefixed[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

function fakeNpi(n: number): string {
  const first9 = `1${String(500000 + n).padStart(8, "0")}`;
  return `${first9}${npiCheckDigit(first9)}`;
}

const FIRSTS = [
  "Avery",
  "Blair",
  "Casey",
  "Devon",
  "Emery",
  "Finley",
  "Harper",
  "Jordan",
  "Kendall",
  "Logan",
];
const LASTS = ["Quill", "Stone", "Vale", "Marsh", "Pike", "Roe", "Orr", "Nash", "Lark", "Wren"];

interface SynthProvider {
  first: string;
  last: string;
  npi: string;
}

const PROVIDERS: SynthProvider[] = Array.from({ length: 100 }, (_, i) => ({
  first: FIRSTS[i % 10],
  last: LASTS[Math.floor(i / 10)],
  npi: fakeNpi(i),
}));

// Three rows the registry answers differently.
const ORG_INDEX = 6;
const NOT_FOUND_INDEX = 12;
const NAME_DIFFERS_INDEX = 20;

function registryRecord(p: SynthProvider, index: number): NpiRegistryRecord | null {
  if (index === NOT_FOUND_INDEX) return null;
  const base: NpiRegistryRecord = {
    npi: p.npi,
    enumerationType: "NPI-1",
    firstName: p.first.toUpperCase(),
    middleName: null,
    lastName: p.last.toUpperCase(),
    organizationName: null,
    credential: "PT",
    primaryTaxonomy: { code: "225100000X", description: "Physical Therapist" },
    practiceCity: "CHARLOTTE",
    practiceState: "NC",
    status: "active",
    enumerationDate: "2016-01-04",
    otherNames: [],
  };
  if (index === ORG_INDEX) {
    return {
      ...base,
      enumerationType: "NPI-2",
      firstName: null,
      lastName: null,
      credential: null,
      organizationName: "SYNTHETIC THERAPY GROUP LLC",
    };
  }
  if (index === NAME_DIFFERS_INDEX) return { ...base, firstName: "MORGAN" };
  return base;
}

const RECORDS = new Map(PROVIDERS.map((p, i) => [p.npi, registryRecord(p, i)]));

/* --------------------------------- CSV ----------------------------------- */

const TEMPLATE_HEADERS = [
  "group_name",
  "group_tin",
  "group_npi",
  "provider_first_name",
  "provider_middle_initial",
  "provider_last_name",
  "credentials",
  "gender",
  "date_of_birth",
  "ssn_last4",
  "email",
  "phone",
  "npi",
  "caqh_id",
  "caqh_last_attested_date",
  "is_new_grad",
  "specialty",
  "taxonomy_code",
  "start_date",
  "degree",
  "school_name",
  "graduation_date",
  "license_state",
  "license_number",
  "license_type",
  "license_issue_date",
  "license_expiration_date",
  "facility_name",
  "enrollment_payer",
  "enrollment_state",
  "enrollment_effective_date",
];

function csvLine(p: SynthProvider, i: number): string {
  const cells: Record<string, string> = {
    group_name: "Tree Hill Sports Therapy LLC",
    group_tin: "12-3456789",
    provider_first_name: p.first,
    provider_last_name: p.last,
    credentials: "PT",
    email: `synthetic.${i}@example.test`,
    npi: p.npi,
    is_new_grad: "no",
    specialty: "Physical Therapy",
    license_state: "NC",
    license_number: `PT-SYN-${String(i).padStart(3, "0")}`,
  };
  return TEMPLATE_HEADERS.map((h) => cells[h] ?? "").join(",");
}

const CSV = [TEMPLATE_HEADERS.join(","), ...PROVIDERS.map(csvLine)].join("\n");

/* ------------------------------ Supabase mock ----------------------------- */

function makeFixtures(): Record<string, Record<string, unknown>[]> {
  return {
    organizations: [
      {
        id: ORG_ID,
        name: "Tree Hill Sports Therapy",
        lifecycle_state: "prospect",
        created_at: NOW,
      },
    ],
    memberships: [
      {
        org_id: ORG_ID,
        role: "admin",
        organizations: {
          name: "Tree Hill Sports Therapy",
          lifecycle_state: "prospect",
          created_at: NOW,
        },
      },
    ],
    profiles: [
      { id: USER_ID, full_name: "Sowmya Seed", email: "sowmya.seed@example.test", created_at: NOW },
    ],
    provider_groups: [
      {
        id: GROUP_ID,
        org_id: ORG_ID,
        name: "Tree Hill Sports Therapy LLC",
        tin: "123456789",
        is_active: true,
        states: ["NC"],
        created_at: NOW,
      },
    ],
    notes: [],
    user_table_prefs: [],
    credential_cases: [],
    status_configs: [],
    audit_log: [],
    party_role_assignments: [],
    facilities: [],
    providers: [],
    state_licenses: [],
    provider_group_assignments: [],
    provider_facility_assignments: [],
    payers: [],
    org_payer_assignments: [],
    payer_network_targets: [],
    provider_documents: [],
    group_insurance_policies: [],
    contracts: [],
    tasks: [],
    import_runs: [],
    import_rows: [],
  };
}

// A ready-for-review run with the 100 rows already staged (tests 2 and 3).
function stagedFixtures(): Record<string, Record<string, unknown>[]> {
  const fixtures = makeFixtures();
  fixtures.import_runs = [
    {
      id: RUN_ID,
      org_id: ORG_ID,
      created_by: USER_ID,
      source: "onboarding",
      entity_kind: "provider",
      file_name: "synthetic-roster.csv",
      state: "ready_for_review",
      total_rows: 100,
      staged_rows: 100,
      error_rows: 0,
      error_report: null,
      committed_at: null,
      created_provider_ids: null,
      updated_provider_ids: null,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  fixtures.import_rows = PROVIDERS.map((p, i) => {
    const mapped = {
      group_tin: "123456789",
      group_id: GROUP_ID,
      provider_first_name: p.first,
      provider_last_name: p.last,
      npi: p.npi,
      license_state: "NC",
      license_number: `PT-SYN-${String(i).padStart(3, "0")}`,
    };
    return {
      id: `import-row-${i}`,
      org_id: ORG_ID,
      run_id: RUN_ID,
      line: i + 2,
      raw: mapped,
      mapped,
      row_state: "staged",
      error_column: null,
      error_reason: null,
      created_at: NOW,
    };
  });
  return fixtures;
}

interface WireLog {
  commitCalls: number;
  /** The last commit plan's row counts and its error-report text. */
  lastPlan?: { creates: number; blocked: number; blockedText: string };
}

function makeHandler(fixtures: Record<string, Record<string, unknown>[]>, wire: WireLog) {
  let seq = 100;
  return async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname.includes("/auth/v1/")) return json(SESSION);
    if (url.pathname.endsWith("/rpc/claim_invites")) return json(0);
    if (url.pathname.endsWith("/rpc/stage_import_rows")) {
      const body = JSON.parse(req.postData() ?? "{}") as {
        p_run_id: string;
        p_rows: Array<Record<string, unknown>>;
      };
      for (const e of body.p_rows) {
        fixtures.import_rows.push({
          id: `import-row-${seq++}`,
          org_id: ORG_ID,
          run_id: body.p_run_id,
          line: e.line,
          raw: e.raw,
          mapped: e.mapped,
          row_state: e.row_state,
          error_column: e.error_column,
          error_reason: e.error_reason,
          created_at: NOW,
        });
      }
      const run = fixtures.import_runs.find((r) => r.id === body.p_run_id);
      if (run) {
        const mine = fixtures.import_rows.filter((r) => r.run_id === run.id);
        run.staged_rows = mine.filter((r) => r.row_state === "staged").length;
        run.error_rows = mine.filter((r) => r.row_state === "error").length;
      }
      return json(null);
    }
    if (url.pathname.endsWith("/rpc/commit_import_run")) {
      wire.commitCalls += 1;
      const body = JSON.parse(req.postData() ?? "{}") as {
        p_run_id: string;
        p_plan: { creates?: unknown[]; blocked_entries?: unknown[] };
      };
      wire.lastPlan = {
        creates: (body.p_plan.creates ?? []).length,
        blocked: (body.p_plan.blocked_entries ?? []).length,
        blockedText: JSON.stringify(body.p_plan.blocked_entries ?? []),
      };
      const run = fixtures.import_runs.find((r) => r.id === body.p_run_id);
      const created = (body.p_plan.creates ?? []).map(() => `imp-prov-${seq++}`);
      if (run) {
        run.state = "committed";
        run.created_provider_ids = created;
        run.updated_provider_ids = [];
      }
      fixtures.import_rows = fixtures.import_rows.filter((r) => r.run_id !== body.p_run_id);
      return json({
        already_committed: false,
        created: created.length,
        updated: 0,
        created_provider_ids: created,
        updated_provider_ids: [],
      });
    }
    if (url.pathname.includes("/rest/v1/rpc/")) return json(0);

    const table = url.pathname.split("/rest/v1/")[1] ?? "";
    const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    const matchFilters = (row: Record<string, unknown>): boolean => {
      for (const [key, raw] of url.searchParams.entries()) {
        if (["select", "order", "limit", "offset", "or"].includes(key)) continue;
        if (!(key in row)) continue;
        if (raw.startsWith("eq.") && String(row[key]) !== raw.slice(3)) return false;
        if (raw.startsWith("neq.") && String(row[key]) === raw.slice(4)) return false;
        if (raw.startsWith("in.(")) {
          const ids = raw
            .slice(4, -1)
            .split(",")
            .map((s) => s.replace(/^"|"$/g, ""));
          if (!ids.includes(String(row[key]))) return false;
        }
      }
      return true;
    };

    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() ?? "[]") as
        Record<string, unknown> | Record<string, unknown>[];
      const rows = (Array.isArray(body) ? body : [body]).map((r) => ({
        id: table === "import_runs" ? RUN_ID : `row-${seq++}`,
        created_at: NOW,
        updated_at: NOW,
        error_report: null,
        ...r,
      }));
      fixtures[table] = [...(fixtures[table] ?? []), ...rows];
      return json(wantsObject ? rows[0] : rows, 201);
    }
    if (req.method() === "PATCH") {
      const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
      const targets = (fixtures[table] ?? []).filter(matchFilters);
      for (const t of targets) Object.assign(t, body);
      return json(wantsObject ? (targets[0] ?? {}) : targets);
    }
    if (req.method() === "DELETE") {
      const rows = fixtures[table] ?? [];
      const removed = rows.filter(matchFilters);
      fixtures[table] = rows.filter((r) => !removed.includes(r));
      return json(removed);
    }
    const rows = (fixtures[table] ?? []).filter(matchFilters);
    if (wantsObject) {
      if (rows.length === 0) return json({ code: "PGRST116", message: "no rows" }, 406);
      return json(rows[0]);
    }
    return json(rows);
  };
}

function seedAuth(context: BrowserContext) {
  return context.addInitScript(
    ([authKey, session, activeOrg]) => {
      localStorage.setItem(authKey as string, JSON.stringify(session));
      localStorage.setItem(
        "minted-panel-active-org",
        JSON.stringify({ state: { activeOrgId: activeOrg }, version: 0 }),
      );
    },
    [AUTH_KEY, SESSION, ORG_ID] as const,
  );
}

/* ------------------------- The batch route, mocked ------------------------- */

interface BatchCall {
  body: Record<string, unknown>;
  authorization: string | undefined;
}

/** Answers each NPI from RECORDS. `holdFrom` (1-based) leaves that call and
 * later ones unanswered, so a test can cancel while a request is in flight. */
// Requests a test leaves unanswered on purpose wait on this gate inside their
// route handler (the pattern npi-registry.spec.ts uses), and each test's end
// opens it: every handler then finishes, so nothing is left pending in the
// browser the worker shares with the next spec.
let openGate: () => void = () => undefined;
let gate: Promise<void> = Promise.resolve();
test.beforeEach(() => {
  gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
});
test.afterEach(() => {
  openGate();
});

async function mockBatchRoute(context: BrowserContext, opts: { holdFrom?: number } = {}) {
  const calls: BatchCall[] = [];
  await context.route(/\/api\/npi-registry\/verify-batch/, async (route) => {
    const req = route.request();
    const body = req.postDataJSON() as Record<string, unknown>;
    calls.push({ body, authorization: req.headers()["authorization"] });
    if (opts.holdFrom !== undefined && calls.length >= opts.holdFrom) {
      await gate;
      // The page gave up on it long ago; answer, and ignore that it is gone.
      await route.fulfill({ status: 503, body: "" }).catch(() => undefined);
      return;
    }
    const npis = (body.npis as string[]) ?? [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          results: npis.map((npi) => ({
            npi,
            status: "checked",
            record: RECORDS.get(npi) ?? null,
          })),
        },
        error: null,
        meta: null,
      }),
    });
  });
  return calls;
}

function progressBar(page: Page) {
  return page.getByRole("progressbar", { name: "NPI Registry checks" });
}

async function expectChecked(page: Page, done: number) {
  await expect(progressBar(page)).toHaveAttribute("aria-valuenow", String(done), {
    timeout: 15000,
  });
}

async function openStagedReview(page: Page) {
  await page.goto(`/import/${RUN_ID}`);
  await expect(page.getByRole("heading", { name: "Review import" })).toBeVisible({
    timeout: 30000,
  });
}

/* --------------------------------- Tests --------------------------------- */

test("MINT-119: a 100-row upload checks new providers' NPIs with progress, time left and a completion state", async ({
  context,
  page,
}) => {
  test.setTimeout(150_000);
  const fixtures = makeFixtures();
  const wire: WireLog = { commitCalls: 0 };
  await context.route(/\/(rest|auth)\/v1\//, makeHandler(fixtures, wire));
  const calls = await mockBatchRoute(context);
  await seedAuth(context);
  await page.clock.install();

  // Upload through the wizard's bulk provider import, exactly as staff do.
  await page.goto("/onboarding/wizard");
  const section = page.locator("#wizard-providers");
  await expect(section).toBeVisible({ timeout: 30000 });
  await section.getByText("Bulk provider import").click();
  await section.locator('input[type="file"]').setInputFiles({
    name: "synthetic-roster.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(CSV, "utf8"),
  });
  await expect(section.getByText("100 data rows")).toBeVisible();
  await section.getByRole("button", { name: "Start import" }).click();
  await expect(section.getByText("Ready for review", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  // No registry call before the review: only new providers, known after dedupe.
  expect(calls).toHaveLength(0);
  await section.getByRole("link", { name: /Review & commit/ }).click();
  await expect(page.getByRole("heading", { name: "Review import" })).toBeVisible({
    timeout: 30000,
  });

  // The review screen is otherwise what it was.
  await expect(page.getByText("Counts reconcile with the 100 staged rows.")).toBeVisible();
  const bar = progressBar(page);
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("aria-valuemax", "100");
  await expect(page.getByRole("button", { name: "Stop checks" })).toBeVisible();

  // The burst of 20 goes at once, then the time left can be estimated.
  await expectChecked(page, 20);
  await expect(page.getByText("20 of 100 done", { exact: true })).toBeVisible();
  await expect(bar).toHaveAttribute("aria-valuetext", "20 of 100 done");
  await expect(page.getByText("About 1 minute left")).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Checking 100 NPIs in the NPI Registry." }),
  ).toHaveCount(1);

  // Each further batch waits for budget; skip the waits and watch it advance.
  let previous = 20;
  while (previous < 100) {
    await page.clock.fastForward(11_000);
    await expectChecked(page, previous + 10);
    previous += 10;
  }

  // The completion state.
  await expect(
    page.getByText("Finished — 100 of 100 checked, 3 with notes.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop checks" })).toHaveCount(0);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "NPI Registry checks finished: 100 of 100 checked" }),
  ).toHaveCount(1);

  // Ten requests of ten, every NPI once, only NPIs sent, with the session.
  expect(calls).toHaveLength(10);
  const sent = calls.flatMap((call) => call.body.npis as string[]);
  expect(new Set(sent).size).toBe(100);
  expect(sent.sort()).toEqual(PROVIDERS.map((p) => p.npi).sort());
  for (const call of calls) {
    expect(Object.keys(call.body)).toEqual(["npis"]);
    expect(call.authorization).toBe("Bearer fake-access-token");
  }

  // Each row's note, in the New providers table.
  await page.getByRole("button", { name: "New providers (100)", exact: true }).click();
  const rowFor = (p: SynthProvider) =>
    page.getByRole("row").filter({ has: page.getByRole("cell", { name: p.npi, exact: true }) });
  // Each advisory shows on its row as one quiet line; nothing to confirm.
  const note = (p: SynthProvider, text: string) =>
    rowFor(p)
      .getByRole("listitem")
      .filter({ hasText: new RegExp(`^${text}$`) });
  await expect(note(PROVIDERS[ORG_INDEX], "This NPI belongs to an organization")).toBeVisible();
  await expect(note(PROVIDERS[NOT_FOUND_INDEX], "Not found in the NPI Registry")).toBeVisible();
  await expect(
    note(PROVIDERS[NAME_DIFFERS_INDEX], "Found in the NPI Registry, but the name differs"),
  ).toBeVisible();
  await expect(rowFor(PROVIDERS[ORG_INDEX]).getByRole("button")).toHaveCount(0);
  // "Found" only where the registry fully matched: 97 rows, never the other three.
  await expect(note(PROVIDERS[0], "Found in the NPI Registry")).toBeVisible();
  for (const index of [ORG_INDEX, NOT_FOUND_INDEX, NAME_DIFFERS_INDEX]) {
    await expect(note(PROVIDERS[index], "Found in the NPI Registry")).toHaveCount(0);
  }
  await expect(
    page.getByRole("listitem").filter({ hasText: /^Found in the NPI Registry$/ }),
  ).toHaveCount(97);

  // Every row commits, whatever the registry said; nothing is blocked, and the
  // error report carries no registry data.
  await expect(page.getByRole("button", { name: /^Blocked rows/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Commit Changes", exact: true }).click();
  // Everything was checked: nothing to warn about.
  await expect(page.getByText(/go in not checked/)).toHaveCount(0);
  await page.getByRole("button", { name: "Yes, commit changes", exact: true }).click();
  await expect(page.getByText("100 providers created · 0 updated", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  expect(wire.commitCalls).toBe(1);
  expect(wire.lastPlan).toEqual({ creates: 100, blocked: 0, blockedText: "[]" });
  expect(calls).toHaveLength(10);
});

test("MINT-119: cancelling the import stops the lookups and aborts the one in flight", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const fixtures = stagedFixtures();
  await context.route(/\/(rest|auth)\/v1\//, makeHandler(fixtures, { commitCalls: 0 }));
  // The third request is never answered: it is in flight when staff cancel.
  const calls = await mockBatchRoute(context, { holdFrom: 3 });
  const failed: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/npi-registry/verify-batch")) failed.push(request.url());
  });
  await seedAuth(context);
  await page.clock.install();

  await openStagedReview(page);
  await expectChecked(page, 20);
  await page.clock.fastForward(11_000);
  await expect.poll(() => calls.length).toBe(3);

  await page.getByRole("button", { name: "Cancel Import", exact: true }).click();
  await page.getByRole("button", { name: "Yes, cancel import", exact: true }).click();
  await expect(page.getByText("Import cancelled — staged rows removed")).toBeVisible({
    timeout: 15000,
  });
  await expect.poll(() => failed.length).toBe(1);

  // Time passes; nothing more is asked.
  for (let i = 0; i < 6; i += 1) await page.clock.fastForward(11_000);
  expect(calls).toHaveLength(3);
  expect(fixtures.import_runs[0].state).toBe("cancelled");
});

test("MINT-119: Stop ends the checks, rows left say so, and the import can still be committed", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const fixtures = stagedFixtures();
  const wire: WireLog = { commitCalls: 0 };
  await context.route(/\/(rest|auth)\/v1\//, makeHandler(fixtures, wire));
  const calls = await mockBatchRoute(context);
  await seedAuth(context);
  await page.clock.install();

  await openStagedReview(page);
  await expectChecked(page, 20);
  const stop = page.getByRole("button", { name: "Stop checks" });
  await stop.focus();
  await stop.press("Enter");

  const status = page.getByText(
    "Stopped — 20 of 100 checked, 2 with notes. Rows not checked say so.",
    { exact: true },
  );
  await expect(status).toBeVisible();
  // The bar stays where the checks stopped.
  await expect(progressBar(page)).toHaveAttribute("aria-valuenow", "20");
  // Focus did not fall to the page body when Stop went away.
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? "")).toBe("P");
  for (let i = 0; i < 3; i += 1) await page.clock.fastForward(11_000);
  expect(calls).toHaveLength(2);

  await page.getByRole("button", { name: "New providers (100)", exact: true }).click();
  const lastRow = page.getByRole("row").filter({
    has: page.getByRole("cell", { name: PROVIDERS[99].npi, exact: true }),
  });
  await expect(lastRow).toContainText("Not checked The checks were stopped.");
  await expect(lastRow.getByText("Found in the NPI Registry", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Commit Changes", exact: true }).click();
  // The confirm step says how many go in not checked; nothing to type.
  await expect(
    page.getByText("80 rows go in not checked against the NPI Registry.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Yes, commit changes", exact: true }).click();
  await expect(page.getByText("100 providers created · 0 updated", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  expect(wire.commitCalls).toBe(1);
});

test("MINT-119: leaving the review mid-check aborts the lookup in flight and sends no more", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const fixtures = stagedFixtures();
  await context.route(/\/(rest|auth)\/v1\//, makeHandler(fixtures, { commitCalls: 0 }));
  const calls = await mockBatchRoute(context, { holdFrom: 3 });
  const failed: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/npi-registry/verify-batch")) failed.push(request.url());
  });
  await seedAuth(context);
  await page.clock.install();

  await openStagedReview(page);
  await expectChecked(page, 20);
  await page.clock.fastForward(11_000);
  await expect.poll(() => calls.length).toBe(3);

  // In-app navigation away from the review unmounts it.
  await page.getByRole("link", { name: "Back to import" }).click();
  await expect(page).toHaveURL(/\/providers/, { timeout: 15000 });
  await expect.poll(() => failed.length).toBe(1);
  for (let i = 0; i < 6; i += 1) await page.clock.fastForward(11_000);
  expect(calls).toHaveLength(3);
  // Nothing about the run changed: leaving is not cancelling.
  expect(fixtures.import_runs[0].state).toBe("ready_for_review");
});

test("A39: Commit never waits for the checks — it stops them and every row goes in", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const fixtures = stagedFixtures();
  const wire: WireLog = { commitCalls: 0 };
  await context.route(/\/(rest|auth)\/v1\//, makeHandler(fixtures, wire));
  // The third request never answers: it is still in flight at Commit.
  const calls = await mockBatchRoute(context, { holdFrom: 3 });
  const failed: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/npi-registry/verify-batch")) failed.push(request.url());
  });
  await seedAuth(context);
  await page.clock.install();

  await openStagedReview(page);
  await expectChecked(page, 20);
  await page.clock.fastForward(11_000);
  await expect.poll(() => calls.length).toBe(3);

  await page.getByRole("button", { name: "Commit Changes", exact: true }).click();
  await expect(
    page.getByText(
      "NPI Registry checks are still running; committing stops them, and 80 rows go in not checked.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Yes, commit changes", exact: true }).click();
  // The commit goes through while the held check never answered.
  await expect(page.getByText("100 providers created · 0 updated", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  expect(wire.commitCalls).toBe(1);
  expect(wire.lastPlan).toEqual({ creates: 100, blocked: 0, blockedText: "[]" });
  // Committing stopped the checks: the one in flight was aborted, none followed.
  await expect.poll(() => failed.length).toBe(1);
  for (let i = 0; i < 4; i += 1) await page.clock.fastForward(11_000);
  expect(calls).toHaveLength(3);
});
