// MINT-91 Addendum 8 (A5) — a NEW import row with an invalid phone is created
// without the phone and warned about, not blocked:
//   PW-01  provider run: the warning names the column on the new provider in
//          review; Commit sends the provider with no phone and writes the
//          warning to the run's report before the commit RPC.
//   PW-02  facility run: the same on the New facilities list; the facility is
//          created without the phone and the warning joins the run's report.
import { test, expect, type BrowserContext, type Route } from "./fixtures/legacy-access-context";

const AUTH_KEY = "sb-example-auth-token";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-10-31T12:00:00Z";
const RUN_ID = "99999991-0000-4000-8000-000000000091";
const G1 = "bbbbbbb1-0000-4000-8000-000000000001";

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

type Rows = Record<string, Record<string, unknown>[]>;

function fixtures(
  entityKind: "provider" | "facility",
  mapped: Record<string, string | null>,
): Rows {
  return {
    organizations: [
      { id: ORG_ID, name: "Tree Hill Sports Therapy", lifecycle_state: "active", created_at: NOW },
    ],
    memberships: [
      {
        org_id: ORG_ID,
        role: "admin",
        organizations: {
          name: "Tree Hill Sports Therapy",
          lifecycle_state: "active",
          created_at: NOW,
        },
      },
    ],
    profiles: [
      { id: USER_ID, full_name: "Sowmya Seed", email: "sowmya.seed@example.test", created_at: NOW },
    ],
    provider_groups: [
      {
        id: G1,
        org_id: ORG_ID,
        name: "Shelby Group 1",
        tin: "111111111",
        states: ["NC"],
        is_active: true,
        created_at: NOW,
      },
    ],
    import_runs: [
      {
        id: RUN_ID,
        org_id: ORG_ID,
        created_by: USER_ID,
        source: "internal",
        entity_kind: entityKind,
        file_name: "roster.csv",
        state: "ready_for_review",
        total_rows: 1,
        staged_rows: 1,
        error_rows: 0,
        error_report: null,
        committed_at: null,
        created_provider_ids: null,
        updated_provider_ids: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    import_rows: [
      {
        id: "import-row-2",
        org_id: ORG_ID,
        run_id: RUN_ID,
        line: 2,
        raw: mapped,
        mapped,
        row_state: "staged",
        error_column: null,
        error_reason: null,
        created_at: NOW,
      },
    ],
  };
}

interface Call {
  kind: "write" | "rpc";
  table: string;
  method: string;
  body: unknown;
}

// Minimal PostgREST mock: eq./in. filters, write-through POST/PATCH/DELETE,
// every unknown table reads as empty. commit_import_run creates the plan's
// providers and flips the run, like the real RPC (minus audit and licenses).
async function serve(context: BrowserContext, data: Rows): Promise<Call[]> {
  const calls: Call[] = [];
  let seq = 900;
  const handler = async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.includes("/auth/v1/")) return json(SESSION);

    if (url.pathname.endsWith("/rpc/commit_import_run")) {
      const body = JSON.parse(req.postData() ?? "{}") as {
        p_plan: { creates?: Array<{ provider: Record<string, unknown> }> };
      };
      calls.push({ kind: "rpc", table: "commit_import_run", method: "POST", body });
      const created = (body.p_plan.creates ?? []).map((c) => {
        const id = `imp-prov-${(seq += 1)}`;
        (data.providers ??= []).push({ id, org_id: ORG_ID, ...c.provider, created_at: NOW });
        return id;
      });
      const run = data.import_runs[0];
      Object.assign(run, { state: "committed", committed_at: NOW, created_provider_ids: created });
      data.import_rows = [];
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
    const matches = (row: Record<string, unknown>) =>
      [...url.searchParams.entries()].every(([key, raw]) => {
        if (!(key in row)) return true;
        if (raw.startsWith("eq.")) return String(row[key]) === raw.slice(3);
        if (raw.startsWith("in.(")) {
          return raw
            .slice(4, -1)
            .split(",")
            .map((s) => s.replace(/^"|"$/g, ""))
            .includes(String(row[key]));
        }
        return true;
      });
    const rows = (data[table] ?? []).filter(matches);

    if (req.method() === "HEAD") {
      return route.fulfill({ status: 200, headers: { "content-range": `*/${rows.length}` } });
    }
    if (req.method() !== "GET") {
      const body: unknown = req.postData() ? JSON.parse(req.postData() ?? "null") : null;
      calls.push({ kind: "write", table, method: req.method(), body });
      if (req.method() === "POST") {
        const inserted = (Array.isArray(body) ? body : [body]).map((b) => ({
          id: `row-${(seq += 1)}`,
          created_at: NOW,
          ...(b as Record<string, unknown>),
        }));
        (data[table] ??= []).push(...inserted);
        return json(wantsObject ? inserted[0] : inserted, 201);
      }
      if (req.method() === "PATCH") {
        for (const row of rows) Object.assign(row, body as Record<string, unknown>);
        return json(wantsObject ? (rows[0] ?? {}) : rows);
      }
      data[table] = (data[table] ?? []).filter((row) => !rows.includes(row));
      return json(rows);
    }
    if (wantsObject) {
      return rows[0] ? json(rows[0]) : json({ code: "PGRST116", message: "no rows" }, 406);
    }
    return json(rows);
  };
  await context.route(/\/(rest|auth)\/v1\//, handler);
  await context.addInitScript(
    ([authKey, session, activeOrg]) => {
      localStorage.setItem(authKey as string, JSON.stringify(session));
      localStorage.setItem(
        "minted-panel-active-org",
        JSON.stringify({ state: { activeOrgId: activeOrg }, version: 0 }),
      );
    },
    [AUTH_KEY, SESSION, ORG_ID] as const,
  );
  return calls;
}

const reportOf = (data: Rows) => data.import_runs[0].error_report as Array<Record<string, unknown>>;

test("PW-01: a new provider with an invalid phone is created without it, warned in review and in the run report", async ({
  context,
  page,
}) => {
  const data = fixtures("provider", {
    group_name: "Shelby Group 1",
    group_tin: "111111111",
    provider_first_name: "Nora",
    provider_last_name: "Newton",
    npi: "1112223338",
    phone: "abc-def-ghij",
  });
  const calls = await serve(context, data);

  await page.goto(`/import/${RUN_ID}`);
  await expect(page.getByRole("heading", { name: "Review import" })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText("Rows with blocked errors")).toBeVisible();
  await page.getByRole("button", { name: /New providers \(1\)/ }).click();
  const noraRow = page.getByRole("row", { name: /Nora Newton/ });
  await expect(
    noraRow.getByText("Warning: phone is not a 10-digit US phone number, so it is left blank"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Blocked rows/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Commit Changes" }).click();
  await page.getByRole("button", { name: "Yes, commit changes" }).click();
  await expect.poll(() => calls.filter((c) => c.kind === "rpc").length).toBe(1);

  const rpc = calls.find((c) => c.kind === "rpc")?.body as {
    p_plan: { creates: Array<{ provider: Record<string, unknown> }>; blocked_entries: unknown[] };
  };
  expect(rpc.p_plan.creates).toHaveLength(1);
  expect(rpc.p_plan.creates[0].provider).toMatchObject({ npi: "1112223338", phone: null });
  expect(rpc.p_plan.blocked_entries).toEqual([]);
  // The warning was written to the run's report BEFORE the commit RPC.
  const reportWrite = calls.findIndex((c) => c.table === "import_runs" && c.method === "PATCH");
  expect(reportWrite).toBeGreaterThanOrEqual(0);
  expect(reportWrite).toBeLessThan(calls.findIndex((c) => c.kind === "rpc"));
  expect(reportOf(data)).toEqual([
    {
      line: 2,
      column: "phone",
      reason: "Warning: phone is not a 10-digit US phone number, so it is left blank",
    },
  ]);
});

test("PW-02: a new facility with an invalid phone is created without it, warned in review and in the run report", async ({
  context,
  page,
}) => {
  const data = fixtures("facility", {
    facility_name: "River Clinic",
    group_name: null,
    group_tin: "111111111",
    group_npi: null,
    street: "20 Ocean Ave",
    city: "Wilmington",
    state: "NC",
    zip: "28401",
    phone: "CALL-NOW",
    appointment_phone: "910-555-0100",
  });
  const calls = await serve(context, data);

  await page.goto(`/import/${RUN_ID}`);
  await page.getByRole("button", { name: /New facilities \(1\)/ }).click({ timeout: 30000 });
  await expect(
    page.getByText("Warning: phone is not a 10-digit US phone number, so it is left blank"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Commit Changes" }).click();
  await page.getByRole("button", { name: "Yes, commit changes" }).click();
  await expect.poll(() => data.import_runs[0].state).toBe("committed");

  const facilityPost = calls.find((c) => c.table === "facilities" && c.method === "POST");
  const posted = (
    Array.isArray(facilityPost?.body) ? facilityPost?.body[0] : facilityPost?.body
  ) as Record<string, unknown>;
  expect(posted).toMatchObject({
    name: "River Clinic",
    phone: null,
    appointment_phone: "910-555-0100",
  });
  expect(reportOf(data)).toEqual([
    {
      line: 2,
      column: "phone",
      reason: "Warning: phone is not a 10-digit US phone number, so it is left blank",
    },
  ]);
});
