// MINT-73 / D22 — the read behind "Days open" stopping at approval or denial:
// one org-scoped, complete read of the status-history rows into the stopping
// statuses (never one per case), and no read at all when nothing stops.
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
import { caseAgeStopTimes, DEFAULT_CASE_AGE_RULES } from "@/lib/caseAge";
import { listCaseTransitionsInto } from "./cases";

type Row = Record<string, unknown>;
const SERVER_MAX_ROWS = 1000;

function serve(rows: Row[]) {
  const urls: URL[] = [];
  transport.fetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(
      Number(url.searchParams.get("limit") ?? SERVER_MAX_ROWS),
      SERVER_MAX_ROWS,
    );
    const page = rows.slice(offset, offset + limit);
    const contentRange =
      page.length === 0
        ? `*/${rows.length}`
        : `${offset}-${offset + page.length - 1}/${rows.length}`;
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json", "content-range": contentRange },
    });
  });
  return urls;
}

const row = (i: number, over: Row = {}): Row => ({
  id: `h${String(i).padStart(4, "0")}`,
  case_id: `c${i}`,
  from_status: "in_review",
  to_status: "approved",
  actor_kind: "user",
  changed_at: "2026-09-15T10:00:00Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ activeOrgId: "org-1" });
});
afterEach(() => {
  useAuthStore.setState({ activeOrgId: null });
});

describe("listCaseTransitionsInto", () => {
  it("reads every row into the stopping statuses, org-scoped, past the max-rows cap", async () => {
    const urls = serve(Array.from({ length: 1234 }, (_, i) => row(i)));
    const rows = await listCaseTransitionsInto(["approved", "denied"]);
    expect(rows).toHaveLength(1234);
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url.pathname).toMatch(/\/case_status_history$/);
      expect(url.searchParams.get("org_id")).toBe("eq.org-1");
      expect(url.searchParams.get("to_status")).toBe("in.(approved,denied)");
      expect(url.searchParams.get("order")).toBe("changed_at.asc,id.asc");
    }
    expect(rows[0]).toEqual({
      caseId: "c0",
      fromStatus: "in_review",
      toStatus: "approved",
      actorKind: "user",
      changedAt: "2026-09-15T10:00:00Z",
    });
  });

  it("returns the fields the stop needs, so a seed is still recognised and skipped", async () => {
    serve([
      row(1),
      row(2, { from_status: null, actor_kind: "system", changed_at: "2026-07-19T00:00:00Z" }),
    ]);
    const stops = caseAgeStopTimes(
      await listCaseTransitionsInto(["approved", "denied"]),
      DEFAULT_CASE_AGE_RULES,
    );
    expect([...stops.keys()]).toEqual(["c1"]);
  });

  it("reads nothing when no status stops the count (the 'never' rule)", async () => {
    serve([row(1)]);
    expect(await listCaseTransitionsInto([])).toEqual([]);
    expect(transport.fetch).not.toHaveBeenCalled();
  });
});
