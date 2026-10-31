// MINT-116 — createProviderWithDetails takes the assignments' start date the
// wizard resolved (the date its Review step shows), and refuses an undated
// assignment set before the provider is written. Synthetic data only.
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
