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

import { recordUndatedAssignments, setAssignments } from "./providerAssignments";

type Row = Record<string, unknown>;
let writes: Array<{ method: string; table: string; body: unknown }> = [];
// What the assignment read returns, and a table (or RPC) whose request fails.
let storedRows: Row[] = [];
let failing: string | null = null;

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
  storedRows = STORED;
  failing = null;
  transport.fetch.mockReset();
  transport.audit.mockReset();
  transport.audit.mockResolvedValue(undefined);
  transport.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const table = new URL(String(input)).pathname.split("/").at(-1)!;
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    if (method !== "GET") writes.push({ method, table, body });
    if (method !== "GET" && table === failing)
      return new Response(JSON.stringify({ code: "XX000", message: "synthetic failure" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    const result = method === "GET" ? storedRows : [];
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

// MINT-134 — the record panel's add dialog and the assignment editors both
// save through setAssignments. A save that leaves an assignment undated
// records assignment.start_date_missing once, after the save, naming only the
// facilities whose date that save made blank.
describe("setAssignments — the assignment.start_date_missing advisory", () => {
  const PROVIDER = "aaaaaaaa-0000-4000-8000-000000000001";
  const FAC_A = "ffffffff-0000-4000-8000-00000000000a"; // dated, primary
  const FAC_B = "ffffffff-0000-4000-8000-00000000000b"; // already undated
  const FAC_C = "ffffffff-0000-4000-8000-00000000000c"; // dated
  const FAC_D = "ffffffff-0000-4000-8000-00000000000d"; // not assigned yet
  const row = (id: string, facilityId: string, startDate: string | null, isPrimary = false) => ({
    id,
    org_id: "org-1",
    provider_id: PROVIDER,
    facility_id: facilityId,
    is_primary: isPrimary,
    start_date: startDate,
    created_at: "2026-10-01T00:00:00Z",
  });
  // What the editors send for the stored rows as they stand ("" for no date).
  const AS_STORED = [
    { facilityId: FAC_A, startDate: "2026-10-01", isPrimary: true },
    { facilityId: FAC_B, startDate: "", isPrimary: false },
    { facilityId: FAC_C, startDate: "2026-10-05", isPrimary: false },
  ];
  const recorded = () =>
    writes.filter((w) => w.table === "record_workflow_advisory").map((w) => w.body as Row);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  beforeEach(() => {
    storedRows = [
      row("pfa-a", FAC_A, "2026-10-01", true),
      row("pfa-b", FAC_B, null),
      row("pfa-c", FAC_C, "2026-10-05"),
    ];
  });

  it("the record panel's add dialog: a facility added without a date records it alone", async () => {
    await setAssignments(PROVIDER, [
      ...AS_STORED,
      { facilityId: FAC_D, startDate: "", isPrimary: false },
    ]);
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0]).toEqual({
      p_check_key: "assignment.start_date_missing",
      p_severity: "advisory",
      p_record_table: "providers",
      p_record_id: PROVIDER,
      p_context: { facility_ids: [FAC_D] },
      p_org_id: "org-1",
      p_source: "panel",
    });
    await settle();
    expect(recorded()).toHaveLength(1);
  });

  it("the assignment editor: a cleared date and a new undated facility record once, together", async () => {
    await setAssignments(PROVIDER, [
      { facilityId: FAC_D, startDate: " ", isPrimary: false },
      { facilityId: FAC_A, startDate: "2026-10-01", isPrimary: true },
      { facilityId: FAC_B, startDate: "", isPrimary: false },
      { facilityId: FAC_C, startDate: "", isPrimary: false },
    ]);
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0].p_context).toEqual({ facility_ids: [FAC_C, FAC_D] });
    await settle();
    expect(recorded()).toHaveLength(1);
  });

  it("records nothing on an unrelated edit, even with an undated assignment on file", async () => {
    // A new date, a dated facility added and one removed; the undated row is
    // left as it was.
    await setAssignments(PROVIDER, [
      { facilityId: FAC_A, startDate: "2026-10-02", isPrimary: true },
      { facilityId: FAC_B, startDate: "", isPrimary: false },
      { facilityId: FAC_D, startDate: "2026-11-01", isPrimary: false },
    ]);
    expect(
      writes.filter((w) => w.table === "provider_facility_assignments").map((w) => w.method),
    ).toEqual(["PATCH", "DELETE", "POST"]);
    await settle();
    expect(recorded()).toEqual([]);
  });

  it("records nothing when the save fails", async () => {
    failing = "provider_facility_assignments";
    await expect(
      setAssignments(PROVIDER, [
        ...AS_STORED,
        { facilityId: FAC_D, startDate: "", isPrimary: false },
      ]),
    ).rejects.toThrow();
    await settle();
    expect(recorded()).toEqual([]);
  });

  it("a failed record never fails the save", async () => {
    failing = "record_workflow_advisory";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        setAssignments(PROVIDER, [
          ...AS_STORED,
          { facilityId: FAC_D, startDate: "", isPrimary: false },
        ]),
      ).resolves.toBeUndefined();
      expect(transport.audit).toHaveBeenCalledOnce();
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

// The helper Add Provider, the batch-assign panel and the CSV import share.
describe("recordUndatedAssignments — one row per provider", () => {
  const P1 = "aaaaaaaa-0000-4000-8000-000000000001";
  const P2 = "aaaaaaaa-0000-4000-8000-000000000002";
  const F1 = "ffffffff-0000-4000-8000-000000000001";
  const F2 = "ffffffff-0000-4000-8000-000000000002";
  const recorded = () =>
    writes.filter((w) => w.table === "record_workflow_advisory").map((w) => w.body as Row);

  it("sends each provider once, with its facilities, under the source given", async () => {
    await recordUndatedAssignments(
      [
        { providerId: P1, facilityId: F2 },
        { providerId: P2, facilityId: F1 },
        { providerId: P1, facilityId: F1 },
      ],
      "import",
    );
    expect(recorded().map((r) => [r.p_record_id, r.p_context, r.p_source])).toEqual([
      [P1, { facility_ids: [F1, F2] }, "import"],
      [P2, { facility_ids: [F1] }, "import"],
    ]);
  });

  it("sends nothing for nothing, and resolves when every send fails", async () => {
    await recordUndatedAssignments([]);
    expect(recorded()).toEqual([]);
    failing = "record_workflow_advisory";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        recordUndatedAssignments([
          { providerId: P1, facilityId: F1 },
          { providerId: P2, facilityId: F1 },
        ]),
      ).resolves.toBeUndefined();
      expect(recorded()).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
