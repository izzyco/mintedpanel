// MINT-116 — createProviderWithDetails takes the assignments' start date the
// wizard resolved (the date its Review step shows), and refuses an undated
// assignment set before the provider is written. MINT-96 A7 — the CREATE
// audit row marks each assignment whose start date was filled in, never one
// that was entered. Synthetic data only.
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

import { ASSIGNMENT_START_DATE_REQUIRED, createProviderWithDetails } from "./providers";
import { localCalendarDate } from "@/lib/systemTokens";

type Row = Record<string, unknown>;
let writes: Array<{ table: string; body: Row | Row[] }> = [];

beforeEach(() => {
  writes = [];
  transport.fetch.mockReset();
  transport.audit.mockReset();
  transport.audit.mockResolvedValue(undefined);
  transport.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const table = new URL(String(input)).pathname.split("/").at(-1)!;
    const body = JSON.parse(String(init?.body ?? "null")) as Row | Row[];
    writes.push({ table, body });
    const single = new Headers(init?.headers).get("accept")?.includes("vnd.pgrst.object");
    const result =
      table === "providers"
        ? { id: "prov-new", ...(body as Row) }
        : Array.isArray(body)
          ? body
          : [];
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

  it("refuses before anything is written when facilities are selected and nothing dates them", async () => {
    await expect(
      createProviderWithDetails({
        provider: provider(null),
        licenses: [],
        facilityIds: ["fac-1"],
        assignmentStartDate: null,
      }),
    ).rejects.toThrow(ASSIGNMENT_START_DATE_REQUIRED);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(transport.audit).not.toHaveBeenCalled();
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

  it("without a resolved date, keeps the provider's start date, else today", async () => {
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
    expect(startDates("provider_facility_assignments")).toEqual([localCalendarDate(new Date())]);
  });
});

describe("createProviderWithDetails — the audit row records a defaulted start date (A7)", () => {
  const auditAfter = () =>
    (
      transport.audit.mock.calls.at(-1)?.[0] as {
        after: { facilityAssignments?: Row[]; facilityIds: string[] };
      }
    ).after;

  it("marks every assignment whose date the wizard's rule filled in", async () => {
    await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: ["fac-1", "fac-2"],
      assignmentStartDate: "2026-11-02",
      assignmentStartDateDefaulted: true,
    });
    expect(auditAfter().facilityAssignments).toEqual([
      { facilityId: "fac-1", isPrimary: true, startDate: "2026-11-02", startDateDefaulted: true },
      { facilityId: "fac-2", isPrimary: false, startDate: "2026-11-02", startDateDefaulted: true },
    ]);
  });

  it("never marks an entered date", async () => {
    await createProviderWithDetails({
      provider: provider("2026-11-15"),
      licenses: [],
      facilityIds: ["fac-1"],
      assignmentStartDate: "2026-11-15",
      assignmentStartDateDefaulted: false,
    });
    expect(auditAfter().facilityAssignments).toEqual([
      { facilityId: "fac-1", isPrimary: true, startDate: "2026-11-15" },
    ]);
    expect(auditAfter().facilityAssignments?.[0]).not.toHaveProperty("startDateDefaulted");
  });

  it("doesn't mark a date the caller gave for the assignments while the provider has none", async () => {
    // The flag follows who filled the assignment date, not the provider's.
    await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: ["fac-1"],
      assignmentStartDate: "2026-11-02",
    });
    expect(startDates("providers")).toEqual([null]);
    expect(auditAfter().facilityAssignments).toEqual([
      { facilityId: "fac-1", isPrimary: true, startDate: "2026-11-02" },
    ]);
  });

  it("omits the assignment list when no facility is selected (the roster form)", async () => {
    await createProviderWithDetails({ provider: provider(null), licenses: [], facilityIds: [] });
    expect(auditAfter()).not.toHaveProperty("facilityAssignments");
    expect(auditAfter().facilityIds).toEqual([]);
  });

  it("records the exact date written, also when the service fills in today", async () => {
    await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: ["fac-1"],
    });
    const today = localCalendarDate(new Date());
    expect(startDates("provider_facility_assignments")).toEqual([today]);
    expect(auditAfter().facilityAssignments).toEqual([
      { facilityId: "fac-1", isPrimary: true, startDate: today, startDateDefaulted: true },
    ]);
  });

  it("lists no assignment that failed to save, and then omits the list", async () => {
    transport.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const table = new URL(String(input)).pathname.split("/").at(-1)!;
      const body = JSON.parse(String(init?.body ?? "null")) as Row;
      if (table === "provider_facility_assignments")
        return new Response(JSON.stringify({ code: "23514", message: "check violation" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      return new Response(JSON.stringify({ id: "prov-new", ...body }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await createProviderWithDetails({
      provider: provider(null),
      licenses: [],
      facilityIds: ["fac-1"],
      assignmentStartDate: "2026-11-02",
      assignmentStartDateDefaulted: true,
    });
    expect(result.warnings[0]).toMatch(/^Facility assignments not saved/);
    expect(auditAfter()).not.toHaveProperty("facilityAssignments");
  });
});
