// MINT-116 — insertAssignmentRows' blank start date follows the Add Provider
// rule: today by default (every caller), refused under "none". Synthetic ids.
import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
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
  writeAudit: vi.fn(),
}));

import { insertAssignmentRows } from "./providerAssignments";
import { localCalendarDate } from "@/lib/systemTokens";

let bodies: Array<Array<Record<string, unknown>>> = [];
beforeEach(() => {
  bodies = [];
  transport.fetch.mockReset();
  transport.fetch.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "[]")));
    return new Response("[]", { status: 201, headers: { "content-type": "application/json" } });
  });
});

const rows = [
  { providerId: "p1", facilityId: "f1", isPrimary: true, startDate: null },
  { providerId: "p1", facilityId: "f2", startDate: "2026-11-15" },
];

describe("insertAssignmentRows — a blank start date", () => {
  it("starts today by default, and keeps an entered date", async () => {
    await insertAssignmentRows(rows);
    const today = localCalendarDate(new Date());
    expect(bodies).toHaveLength(1);
    expect(bodies[0].map((r) => r.start_date)).toEqual([today, "2026-11-15"]);
    await insertAssignmentRows(rows, "today");
    expect(bodies[1].map((r) => r.start_date)).toEqual([today, "2026-11-15"]);
  });

  it('is refused under "none", before anything is written', async () => {
    await expect(insertAssignmentRows(rows, "none")).rejects.toThrow(
      "Each facility assignment needs a start date.",
    );
    await expect(
      insertAssignmentRows([{ providerId: "p1", facilityId: "f1", startDate: "  " }], "none"),
    ).rejects.toThrow("Each facility assignment needs a start date.");
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('writes dated rows under "none" unchanged', async () => {
    await insertAssignmentRows([rows[1]], "none");
    expect(bodies[0]).toEqual([
      {
        org_id: "org-1",
        provider_id: "p1",
        facility_id: "f2",
        is_primary: false,
        start_date: "2026-11-15",
      },
    ]);
  });
});
