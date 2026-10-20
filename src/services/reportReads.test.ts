// Reporting Center source reads at the PostgREST boundary: denial history
// skips status-history seeds, list reads page past the server's max-rows cap
// with an id tiebreak, return shapes stay what the shared screens expect, and
// the Audit Log's date bounds both reach the server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { useAuthStore } from "@/lib/auth-store";
import { listAuditLog } from "./audit";
import { getCases, listCaseDenialEntries, listOrgCaseFacilityLinks } from "./cases";

type Row = Record<string, unknown>;
const SERVER_MAX_ROWS = 1000;

interface RequestCapture {
  table: string;
  url: URL;
  prefer: string;
}

/** Serves fixed rows per table: honors offset/limit, caps a page at the
 * server's max-rows, and answers an exact count in content-range. */
function serve(rowsByTable: Record<string, Row[]>) {
  const requests: RequestCapture[] = [];
  transport.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const table = url.pathname.split("/").at(-1) ?? "";
    const headers = new Headers(init?.headers);
    requests.push({ table, url, prefer: headers.get("prefer") ?? "" });
    const source = rowsByTable[table] ?? [];
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(
      Number(url.searchParams.get("limit") ?? SERVER_MAX_ROWS),
      SERVER_MAX_ROWS,
    );
    const page = source.slice(offset, offset + limit);
    const contentRange =
      page.length === 0
        ? `*/${source.length}`
        : `${offset}-${offset + page.length - 1}/${source.length}`;
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json", "content-range": contentRange },
    });
  });
  return requests;
}

function denial(id: number, over: Row = {}): Row {
  return {
    id: `h${String(id).padStart(4, "0")}`,
    case_id: `c${id}`,
    reason_code_id: "r1",
    note: null,
    changed_at: "2026-09-01T12:00:00Z",
    from_status: "in_review",
    actor_kind: "user",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ activeOrgId: "org-1" });
});
afterEach(() => {
  useAuthStore.setState({ activeOrgId: null });
});

describe("listCaseDenialEntries", () => {
  it("skips status-history seeds — a migration-seeded denial is not dated migration day", async () => {
    serve({
      case_status_history: [
        denial(1),
        // The E6.0 migration seed for an already-denied case.
        denial(2, {
          from_status: null,
          actor_kind: "system",
          reason_code_id: null,
          changed_at: "2026-07-19T00:00:00Z",
          note: "Unified case status migration (E6.0)",
        }),
        // A system AUTO-transition is a real denial event.
        denial(3, { actor_kind: "system", from_status: "submitted" }),
      ],
    });
    const entries = await listCaseDenialEntries();
    expect(entries.map((e) => e.caseId)).toEqual(["c1", "c3"]);
    expect(entries[0]).toEqual({
      caseId: "c1",
      reasonCodeId: "r1",
      note: null,
      changedAt: "2026-09-01T12:00:00Z",
    });
  });

  it("reads every denial past the server's max-rows cap, org-scoped and id-tiebroken", async () => {
    const requests = serve({
      case_status_history: Array.from({ length: 1234 }, (_, i) => denial(i)),
    });
    const entries = await listCaseDenialEntries();
    expect(entries).toHaveLength(1234);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.url.searchParams.get("org_id")).toBe("eq.org-1");
      expect(request.url.searchParams.get("to_status")).toBe("eq.denied");
      expect(request.url.searchParams.get("order")).toBe("changed_at.desc,id.asc");
      expect(request.prefer).toContain("count=exact");
    }
  });
});

describe("getCases", () => {
  it("returns every case past 1000 rows, ordered newest first with an id tiebreak", async () => {
    const cases = Array.from({ length: 1100 }, (_, i) => ({
      id: `case-${i}`,
      provider_id: "p1",
      payer_id: "py1",
      state: "TX",
      case_status: "submitted",
      created_at: "2026-09-01T00:00:00Z",
    }));
    const requests = serve({ credential_cases: cases });
    const rows = await getCases({ state: "TX" });
    expect(rows).toHaveLength(1100);
    expect(rows[0]).toMatchObject({ id: "case-0", providerId: "p1", caseStatus: "submitted" });
    expect(requests[0].url.searchParams.get("state")).toBe("eq.TX");
    expect(requests[0].url.searchParams.get("order")).toBe("created_at.desc,id.asc");
  });
});

describe("listOrgCaseFacilityLinks", () => {
  it("returns the org's case × location links as ids only", async () => {
    const requests = serve({
      case_facilities: [
        { id: "cf1", case_id: "c1", facility_id: "f1" },
        { id: "cf2", case_id: "c1", facility_id: "f2" },
      ],
    });
    expect(await listOrgCaseFacilityLinks()).toEqual([
      { caseId: "c1", facilityId: "f1" },
      { caseId: "c1", facilityId: "f2" },
    ]);
    expect(requests[0].url.searchParams.get("org_id")).toBe("eq.org-1");
    expect(requests[0].url.searchParams.get("select")).toBe("id,case_id,facility_id");
  });
});

describe("listAuditLog", () => {
  it("sends both date bounds to the server — inclusive since, exclusive until", async () => {
    const requests = serve({ audit_log: [] });
    await listAuditLog({
      since: "2026-10-05T04:00:00.000Z",
      until: "2026-10-06T04:00:00.000Z",
      limit: 1000,
    });
    expect(requests[0].url.searchParams.getAll("ts")).toEqual([
      "gte.2026-10-05T04:00:00.000Z",
      "lt.2026-10-06T04:00:00.000Z",
    ]);
  });
});
