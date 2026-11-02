import { beforeEach, describe, expect, it, vi } from "vitest";

// MINT-135: completing a task while earlier tasks of its case are open is
// allowed and recorded, after the save, as task.completed_out_of_order. The
// service works the count out itself from the case's tasks. The client is a
// chain: maybeSingle() is getTask's read, single() the status update, and
// awaiting the chain itself is the case-tasks read. The advisory helper is
// mocked so the suite sees exactly what would be recorded.
const recordAdvisoryMock = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({
  before: { data: null as unknown, error: null as unknown },
  update: { data: null as unknown, error: null as unknown },
  caseTasks: { data: null as unknown, error: null as unknown },
  filters: [] as unknown[][],
}));

vi.mock("@/integrations/supabase/externalClient", () => {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "select", "update"]) chain[method] = () => chain;
  chain.eq = (...args: unknown[]) => {
    db.filters.push(args);
    return chain;
  };
  chain.maybeSingle = async () => db.before;
  chain.single = async () => db.update;
  chain.then = (resolve: (value: unknown) => unknown) => resolve(db.caseTasks);
  return { supabase: chain };
});
vi.mock("@/lib/audit", () => ({
  currentUserId: () => "user-1",
  requireActiveOrg: () => "org-1",
  writeAudit: vi.fn(),
}));
vi.mock("@/services/advisories", () => ({
  recordAdvisory: (...args: unknown[]) => recordAdvisoryMock(...args),
}));
vi.mock("@/services/taskSteps", () => ({ completeTaskStep: vi.fn() }));
vi.mock("@/services/touches", () => ({ logNote: vi.fn() }));

import { updateTaskStatus } from "./tasks";

const TASK = "13500000-0000-4000-8000-000000000003";
const REMOVED_PAYER_FORM = [
  {
    id: "form",
    order: 1,
    label: "Send payer form",
    isCompleted: false,
    stepType: "pdf",
    payerForm: { familyId: "family-1", removedAt: "2026-11-01T00:00:00Z" },
  },
];

function taskRow(status: string, extra: Record<string, unknown> = {}) {
  return { id: TASK, org_id: "org-1", case_id: "case-1", sort_order: 3, status, ...extra };
}

/** Let the fire-and-forget recording settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("updateTaskStatus: out-of-order completion (MINT-135)", () => {
  beforeEach(() => {
    recordAdvisoryMock.mockReset();
    vi.restoreAllMocks();
    db.filters = [];
    db.before = { data: taskRow("in_progress"), error: null };
    db.update = { data: taskRow("completed"), error: null };
    db.caseTasks = {
      data: [
        { status: "in_progress", sort_order: 0, sop_content: [] },
        { status: "blocked", sort_order: 1, sop_content: REMOVED_PAYER_FORM },
        { status: "completed", sort_order: 2, sop_content: [] },
        { status: "in_progress", sort_order: 3, sop_content: [] },
        { status: "not_started", sort_order: 4, sop_content: [] },
      ],
      error: null,
    };
  });

  it("records the earlier open tasks of the case, skipping a removed payer form", async () => {
    await expect(updateTaskStatus(TASK, "completed")).resolves.toMatchObject({
      id: TASK,
      status: "completed",
    });
    await settle();
    expect(db.filters).toContainEqual(["case_id", "case-1"]);
    expect(recordAdvisoryMock).toHaveBeenCalledTimes(1);
    expect(recordAdvisoryMock).toHaveBeenCalledWith(
      "task.completed_out_of_order",
      { table: "tasks", id: TASK },
      { earlier_open_count: 1 },
    );
  });

  it("records nothing when the task was already completed", async () => {
    db.before = { data: taskRow("completed"), error: null };
    await updateTaskStatus(TASK, "completed");
    await settle();
    expect(recordAdvisoryMock).not.toHaveBeenCalled();
  });

  it("records nothing when every earlier task is done or removed", async () => {
    db.caseTasks = {
      data: [
        { status: "completed", sort_order: 0, sop_content: [] },
        { status: "blocked", sort_order: 1, sop_content: REMOVED_PAYER_FORM },
      ],
      error: null,
    };
    await updateTaskStatus(TASK, "completed");
    await settle();
    expect(recordAdvisoryMock).not.toHaveBeenCalled();
  });

  it("records nothing for another status, a task without a case, or a failed save", async () => {
    db.update = { data: taskRow("blocked"), error: null };
    await updateTaskStatus(TASK, "blocked");
    db.before = { data: taskRow("in_progress", { case_id: null }), error: null };
    db.update = { data: taskRow("completed", { case_id: null }), error: null };
    await updateTaskStatus(TASK, "completed");
    db.before = { data: taskRow("in_progress"), error: null };
    const failure = new Error("update failed");
    db.update = { data: null, error: failure };
    await expect(updateTaskStatus(TASK, "completed")).rejects.toBe(failure);
    await settle();
    expect(recordAdvisoryMock).not.toHaveBeenCalled();
  });

  it("never fails the save when the case-tasks read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.caseTasks = { data: null, error: { code: "42501", message: "denied" } };
    await expect(updateTaskStatus(TASK, "completed")).resolves.toMatchObject({ id: TASK });
    await settle();
    expect(recordAdvisoryMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "advisory_record_failed",
        check_key: "task.completed_out_of_order",
        sqlstate: "42501",
      }),
    );
  });
});
