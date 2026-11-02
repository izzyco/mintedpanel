import { beforeEach, describe, expect, it, vi } from "vitest";

// MINT-135: completing a task while earlier tasks are open is allowed and
// recorded, after the save, as task.completed_out_of_order. The client is a
// chain whose terminal calls resolve the row; the advisory helper is mocked so
// the suite sees exactly what would be recorded.
const recordAdvisoryMock = vi.hoisted(() => vi.fn());
const saved = vi.hoisted(() => ({
  update: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/integrations/supabase/externalClient", () => {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "select", "update", "eq"]) chain[method] = () => chain;
  chain.maybeSingle = async () => ({ data: { id: "task-2", status: "in_progress" }, error: null });
  chain.single = async () => saved.update;
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
vi.mock("@/lib/payerForms", () => ({ markPayerFormRemoved: vi.fn() }));

import { updateTaskStatus } from "./tasks";

describe("updateTaskStatus: out-of-order completion (MINT-135)", () => {
  beforeEach(() => {
    recordAdvisoryMock.mockReset();
    saved.update = { data: { id: "task-2", status: "completed" }, error: null };
  });

  it("records task.completed_out_of_order with the earlier open count after the save", async () => {
    await expect(updateTaskStatus("task-2", "completed", 2)).resolves.toMatchObject({
      id: "task-2",
      status: "completed",
    });
    expect(recordAdvisoryMock).toHaveBeenCalledTimes(1);
    expect(recordAdvisoryMock).toHaveBeenCalledWith(
      "task.completed_out_of_order",
      { table: "tasks", id: "task-2" },
      { earlier_open_count: 2 },
    );
  });

  it("records nothing for an in-order completion or another status", async () => {
    await updateTaskStatus("task-2", "completed");
    await updateTaskStatus("task-2", "completed", 0);
    saved.update = { data: { id: "task-2", status: "in_progress" }, error: null };
    await updateTaskStatus("task-2", "in_progress", 3);
    expect(recordAdvisoryMock).not.toHaveBeenCalled();
  });

  it("records nothing when the save fails", async () => {
    const failure = new Error("update failed");
    saved.update = { data: null, error: failure };
    await expect(updateTaskStatus("task-2", "completed", 1)).rejects.toBe(failure);
    expect(recordAdvisoryMock).not.toHaveBeenCalled();
  });
});
