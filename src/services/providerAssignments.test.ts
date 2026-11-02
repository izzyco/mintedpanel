// MINT-96 — setAssignments (the E1.4 editor save) never refuses a blank
// start date: a new row inserts and an existing row updates with
// start_date null ("Start date needed"). Synthetic data only.
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
  writeAudit: (...args: unknown[]) => transport.audit(...args),
}));

import { setAssignments } from "./providerAssignments";

type Row = Record<string, unknown>;
let writes: Array<{ method: string; table: string; body: unknown }> = [];

const STORED: Row[] = [
  {
    id: "pfa-1",
    org_id: "org-1",
    provider_id: "prov-1",
    facility_id: "fac-1",
    is_primary: true,
    start_date: "2026-10-01",
    created_at: "2026-10-01T00:00:00Z",
  },
];

beforeEach(() => {
  writes = [];
  transport.fetch.mockReset();
  transport.audit.mockReset();
  transport.audit.mockResolvedValue(undefined);
  transport.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const table = new URL(String(input)).pathname.split("/").at(-1)!;
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    if (method !== "GET") writes.push({ method, table, body });
    const result = method === "GET" ? STORED : [];
    return new Response(JSON.stringify(result), {
      status: method === "POST" ? 201 : 200,
      headers: { "content-type": "application/json" },
    });
  });
});

describe("setAssignments — a blank start date saves as missing", () => {
  it("inserts a new row and updates an existing one with start_date null", async () => {
    await setAssignments("prov-1", [
      { facilityId: "fac-1", startDate: "", isPrimary: true },
      { facilityId: "fac-2", startDate: "  ", isPrimary: false },
    ]);

    expect(writes.filter((w) => w.table === "provider_facility_assignments")).toEqual([
      { method: "PATCH", table: "provider_facility_assignments", body: { start_date: null } },
      {
        method: "POST",
        table: "provider_facility_assignments",
        body: [
          {
            org_id: "org-1",
            provider_id: "prov-1",
            facility_id: "fac-2",
            is_primary: false,
            start_date: null,
          },
        ],
      },
    ]);
    expect(transport.audit).toHaveBeenCalledOnce();
  });
});
