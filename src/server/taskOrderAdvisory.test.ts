import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { recordServerCompletedOutOfOrder } from "./taskOrderAdvisory";

// MINT-135: the extension routes' recorder for a task they just completed. A
// fake service-role client: awaiting the query chain is the case-tasks read,
// and rpc().abortSignal() is the ledger call (src/server/advisories.ts).
const ORG = "13500000-0000-4000-8000-00000000000a";
const USER = "13500000-0000-4000-8000-00000000000b";
const TASK = "13500000-0000-4000-8000-000000000003";
const CASE = "13500000-0000-4000-8000-00000000000c";
const REMOVED_PAYER_FORM = [
  { id: "form", stepType: "pdf", payerForm: { familyId: "f", removedAt: "2026-11-01" } },
];

function fakeDb(caseTasks: { data: unknown; error: unknown }) {
  const rpc = vi.fn((..._args: unknown[]) => ({
    abortSignal: () => Promise.resolve({ data: "row-id", error: null }),
  }));
  const from = vi.fn();
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) chain[method] = () => chain;
  chain.then = (resolve: (value: unknown) => unknown) => resolve(caseTasks);
  from.mockReturnValue(chain);
  const db = { rpc, from } as unknown as SupabaseClient<Database>;
  return { db, rpc, from };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.restoreAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("recordServerCompletedOutOfOrder", () => {
  it("records the earlier open tasks of the case as the extension's verified actor", async () => {
    const { db, rpc } = fakeDb({
      data: [
        { status: "in_progress", sort_order: 0, sop_content: [] },
        { status: "blocked", sort_order: 1, sop_content: REMOVED_PAYER_FORM },
        { status: "completed", sort_order: 2, sop_content: [] },
        { status: "not_started", sort_order: 5, sop_content: [] },
      ],
      error: null,
    });
    await recordServerCompletedOutOfOrder(
      { db, orgId: ORG, userId: USER },
      { id: TASK, caseId: CASE, sortOrder: 3 },
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_workflow_advisory", {
      p_check_key: "task.completed_out_of_order",
      p_severity: "advisory",
      p_record_table: "tasks",
      p_record_id: TASK,
      p_context: { earlier_open_count: 1 },
      p_org_id: ORG,
      p_source: "extension",
      p_actor_id: USER,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("records nothing when no earlier task is open, and reads nothing without a case", async () => {
    const done = fakeDb({
      data: [{ status: "completed", sort_order: 0, sop_content: [] }],
      error: null,
    });
    await recordServerCompletedOutOfOrder(
      { db: done.db, orgId: ORG, userId: USER },
      { id: TASK, caseId: CASE, sortOrder: 3 },
    );
    expect(done.rpc).not.toHaveBeenCalled();

    const caseless = fakeDb({ data: [], error: null });
    await recordServerCompletedOutOfOrder(
      { db: caseless.db, orgId: ORG, userId: USER },
      { id: TASK, caseId: null, sortOrder: 3 },
    );
    expect(caseless.from).not.toHaveBeenCalled();
    expect(caseless.rpc).not.toHaveBeenCalled();
  });

  it("never rejects: a failed read is one advisory_record_failed line", async () => {
    const { db, rpc } = fakeDb({ data: null, error: { code: "42501" } });
    await expect(
      recordServerCompletedOutOfOrder(
        { db, orgId: ORG, userId: USER },
        { id: TASK, caseId: CASE, sortOrder: 3 },
      ),
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "advisory_record_failed",
        check_key: "task.completed_out_of_order",
        sqlstate: "42501",
      }),
    );
  });
});
