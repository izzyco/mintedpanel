// MINT-91 Addendum 8 (A5): a phone left blank on a new record is written to the
// run's durable report at commit, naming the column. Provider runs write the
// warnings before the commit RPC (which appends its blocked entries after
// them); group and facility runs write them with the committed flip.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitPlan, ImportRowWarning } from "@/lib/importDedupe";
import type { ImportRunErrorEntry } from "@/types";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  createFacility: vi.fn(),
  createProviderGroup: vi.fn(),
}));

vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/audit", () => ({
  requireActiveOrg: () => "org-1",
  currentUserId: () => "user-1",
  writeAudit: vi.fn(),
}));
vi.mock("@/services/providerAssignments", () => ({
  insertAssignmentRows: vi.fn(),
  ensureFirstFacilityPrimary: vi.fn(),
}));
vi.mock("@/services/enrollmentFacts", () => ({
  listEnrollmentFacts: vi.fn().mockResolvedValue([]),
  createEnrollmentFact: vi.fn(),
}));
vi.mock("@/services/orgSettings", () => ({
  createFacility: mocks.createFacility,
  createProviderGroup: mocks.createProviderGroup,
}));

import { commitImportRun, commitSectionImportRun } from "./importRuns";

const WARNING: ImportRowWarning = {
  line: 2,
  column: "phone",
  reason: "Warning: phone is not a 10-digit US phone number, so it is left blank",
};
const SCAN_ERROR: ImportRunErrorEntry = { line: 7, column: "npi", reason: "npi is required" };

const EMPTY_PLAN: CommitPlan = { creates: [], updates: [], skipped_count: 0, blocked_entries: [] };

// One run row; import_runs updates are captured in call order alongside the RPC.
function installTransport(errorReport: ImportRunErrorEntry[] | null) {
  const calls: Array<{ kind: "update" | "rpc"; payload: unknown }> = [];
  mocks.rpc.mockImplementation((fn: string, args: unknown) => {
    calls.push({ kind: "rpc", payload: { fn, args } });
    return Promise.resolve({ data: { created: 0, updated: 0 }, error: null });
  });
  mocks.from.mockImplementation((table: string) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      delete: () => builder,
      update: (payload: unknown) => {
        if (table === "import_runs") calls.push({ kind: "update", payload });
        return builder;
      },
      maybeSingle: () =>
        Promise.resolve({
          data:
            table === "import_runs"
              ? {
                  id: "run-1",
                  org_id: "org-1",
                  state: "ready_for_review",
                  error_report: errorReport,
                }
              : null,
          error: null,
        }),
      then: (resolve: (value: { data: unknown; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return builder;
  });
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("commitImportRun — phone warnings join the run report", () => {
  it("writes the warnings after the existing entries, before the commit RPC", async () => {
    const calls = installTransport([SCAN_ERROR]);
    await commitImportRun("run-1", EMPTY_PLAN, [WARNING]);
    expect(calls.map((c) => c.kind)).toEqual(["update", "rpc"]);
    expect(calls[0].payload).toMatchObject({ error_report: [SCAN_ERROR, WARNING] });
  });

  it("does not write a warning the report already holds (a retried commit)", async () => {
    const calls = installTransport([SCAN_ERROR, WARNING]);
    await commitImportRun("run-1", EMPTY_PLAN, [WARNING]);
    expect(calls.map((c) => c.kind)).toEqual(["rpc"]);
  });

  it("writes nothing extra when there are no warnings", async () => {
    const calls = installTransport(null);
    await commitImportRun("run-1", EMPTY_PLAN);
    expect(calls.map((c) => c.kind)).toEqual(["rpc"]);
  });
});

describe("commitSectionImportRun — phone warnings join the run report", () => {
  it("appends the creates' warnings after the blocked entries, and creates without the phone", async () => {
    mocks.createFacility.mockResolvedValue({ id: "facility-new" });
    const calls = installTransport([SCAN_ERROR]);
    const blocked = { line: 3, column: "group_name", displayName: "Ghost", reason: "not found" };
    await commitSectionImportRun({
      runId: "run-1",
      entityKind: "facility",
      creates: [
        {
          line: 2,
          displayName: "River Clinic",
          mapped: { facility_name: "River Clinic", phone: null, appointment_phone: null },
          groupId: "group-1",
          notes: [],
          warnings: [WARNING],
        },
      ],
      skippedCount: 0,
      blocked: [blocked],
    });
    expect(mocks.createFacility).toHaveBeenCalledWith(expect.objectContaining({ phone: null }));
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toMatchObject({
      state: "committed",
      error_report: [SCAN_ERROR, { line: 3, column: "group_name", reason: "not found" }, WARNING],
    });
  });
});
