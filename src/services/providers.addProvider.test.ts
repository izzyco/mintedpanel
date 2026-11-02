// MINT-116 — createProviderWithDetails takes the assignments' start date the
// wizard resolved (the date its Review step shows). Under "no default" an
// undated assignment set saves as an accurate draft, never refused. The
// CREATE audit row is unchanged: no date is marked as defaulted. Synthetic
// data only.
import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ fetch: vi.fn(), audit: vi.fn() }));
vi.mock("@/integrations/supabase/externalClient", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  return {
    supabase: createClient("http://127.0.0.1:1", "synthetic-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (...args) => transport.fetch(...args) },
    }),
  };
});
vi.mock("@/lib/audit", () => ({
  requireActiveOrg: () => "org-1",
  currentUserId: () => "user-1",
  writeAudit: (...args: unknown[]) => transport.audit(...args),
}));

import { createProviderWithDetails } from "./providers";

type Row = Record<string, unknown>;
let writes: Array<{ table: string; body: Row | Row[] }> = [];
// The created provider's id, and a table (or RPC) whose request fails.
let createdId = "prov-new";
let failing: string | null = null;

beforeEach(() => {
  writes = [];
  createdId = "prov-new";
  failing = null;
  transport.fetch.mockReset();
  transport.audit.mockReset();
  transport.audit.mockResolvedValue(undefined);
  transport.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const table = new URL(String(input)).pathname.split("/").at(-1)!;
    const body = JSON.parse(String(init?.body ?? "null")) as Row | Row[];
    writes.push({ table, body });
    if (table === failing)
      return new Response(JSON.stringify({ code: "XX000", message: "synthetic failure" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    const single = new Headers(init?.headers).get("accept")?.includes("vnd.pgrst.object");
    const result =
      table === "providers" ? { id: createdId, ...(body as Row) } : Array.isArray(body) ? body : [];
    return new Response(JSON.stringify(single ? result : [result]), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  });
});

const provider = (startDate: string | null) => ({
  firstName: "Synthetic",
  lastName: "Provider",
  startDate,
  status: "onboarding" as const,
});
const startDates = (table: string) =>
  writes
    .filter((w) => w.table === table)
    .flatMap((w) => (Array.isArray(w.body) ? w.body : [w.body]))
    .map((r) => r.start_date);

describe("createProviderWithDetails — the assignments' start date", () => {
  it("writes the resolved date on every assignment and leaves a blank provider date null", async () => {
    await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: ["fac-1", "fac-2"],
      assignmentStartDate: "2026-11-02",
    });
    expect(startDates("providers")).toEqual([null]);
    expect(startDates("provider_facility_assignments")).toEqual(["2026-11-02", "2026-11-02"]);
  });

  it("saves the provider and its assignments without a start date when nothing dates them", async () => {
    const result = await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: ["fac-1", "fac-2"],
      assignmentStartDate: null,
    });
    expect(result.warnings).toEqual([]);
    expect(startDates("providers")).toEqual([null]);
    expect(startDates("provider_facility_assignments")).toEqual([null, null]);
  });

  it("saves a provider with no facility selected even when nothing would date one", async () => {
    const result = await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: [],
      assignmentStartDate: null,
    });
    expect(result.provider.id).toBe("prov-new");
    expect(writes.map((w) => w.table)).toEqual(["providers"]);
  });

  it("without a resolved date, keeps the provider's start date, else none", async () => {
    await createProviderWithDetails({
      provider: provider("2026-11-15"),
      licenses: [],
      facilityIds: ["fac-1"],
    });
    expect(startDates("provider_facility_assignments")).toEqual(["2026-11-15"]);
    writes = [];
    await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: ["fac-1"],
    });
    expect(startDates("provider_facility_assignments")).toEqual([null]);
  });
});

describe("createProviderWithDetails — the audit row", () => {
  it("records the saved facilities as ids, with no start date or defaulted mark", async () => {
    await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: ["fac-1"],
      assignmentStartDate: "2026-11-02",
    });
    const after = (transport.audit.mock.calls.at(-1)?.[0] as { after: Row }).after;
    expect(Object.keys(after).sort()).toEqual([
      "facilityIds",
      "groupAssignments",
      "licenses",
      "provider",
    ]);
    expect(after.facilityIds).toEqual(["fac-1"]);
  });
});

// MINT-134 — Add Provider under "no default" records the undated assignments
// once, after the save, through the never-throw helper.
describe("createProviderWithDetails — the assignment.start_date_missing advisory", () => {
  const PROVIDER = "aaaaaaaa-0000-4000-8000-000000000001";
  const FAC_A = "ffffffff-0000-4000-8000-00000000000a";
  const FAC_B = "ffffffff-0000-4000-8000-00000000000b";
  const recorded = () => writes.filter((w) => w.table === "record_workflow_advisory");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  beforeEach(() => {
    createdId = PROVIDER;
  });

  it("records once, on the provider, naming every facility saved without a date", async () => {
    await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: [FAC_B, FAC_A],
      assignmentStartDate: null,
    });
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0].body).toEqual({
      p_check_key: "assignment.start_date_missing",
      p_severity: "advisory",
      p_record_table: "providers",
      p_record_id: PROVIDER,
      p_context: { facility_ids: [FAC_A, FAC_B] },
      p_org_id: "org-1",
      p_source: "panel",
    });
    await settle();
    expect(recorded()).toHaveLength(1);
  });

  it("records nothing when the assignments are dated or there are none", async () => {
    await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: [FAC_A],
      assignmentStartDate: "2026-11-02",
    });
    await createProviderWithDetails({
      provider: provider("2026-11-15"),
      licenses: [],
      facilityIds: [FAC_A],
    });
    await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: [],
      assignmentStartDate: null,
    });
    await settle();
    expect(recorded()).toEqual([]);
  });

  it("records nothing when the facility assignments did not save", async () => {
    failing = "provider_facility_assignments";
    const result = await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: [FAC_A],
      assignmentStartDate: null,
    });
    expect(result.warnings).toHaveLength(1);
    await settle();
    expect(recorded()).toEqual([]);
  });

  it("a failed record never fails the save", async () => {
    failing = "record_workflow_advisory";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await createProviderWithDetails({
        provider: provider(null),
        licenses: [],
        facilityIds: [FAC_A],
        assignmentStartDate: null,
      });
      expect(result.provider.id).toBe(PROVIDER);
      expect(result.warnings).toEqual([]);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
        event: "advisory_record_failed",
        check_key: "assignment.start_date_missing",
        sqlstate: "XX000",
      });
    } finally {
      warn.mockRestore();
    }
  });
});
