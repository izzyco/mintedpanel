// MINT-91 Addendum 8 (A5): a phone replaced or left blank on a new record is
// written to the run's durable report, naming the column, on every path:
//   providers — after the commit RPC succeeds, so a failed commit leaves the
//     report as it was; a replayed commit adds what's missing, never twice;
//   groups and facilities — before the creates, so a record that lands before
//     a later create fails keeps its warning; a retry never writes one twice.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitPlan, ImportRowWarning, SectionCreateEntry } from "@/lib/importDedupe";
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

const warning = (line: number, column = "phone"): ImportRowWarning => ({
  line,
  column,
  reason: "Warning: Phone isn't a US number, so it was left blank.",
  review: `Phone "abc-${line}" isn't a US number, so it will be left blank.`,
  leftBlank: true,
});
const entry = (w: ImportRowWarning): ImportRunErrorEntry => ({
  line: w.line,
  column: w.column,
  reason: w.reason,
  severity: "warning",
});
const SCAN_ERROR: ImportRunErrorEntry = { line: 9, column: "npi", reason: "npi is required" };
const EMPTY_PLAN: CommitPlan = { creates: [], updates: [], skipped_count: 0, blocked_entries: [] };

interface Run {
  id: string;
  org_id: string;
  state: string;
  error_report: ImportRunErrorEntry[] | null;
}

// A stateful run row: an update applies only while its `state` filter still
// matches, like PostgREST. The commit RPC flips the run (or fails on demand).
function installTransport(run: Run, opts: { rpcFails?: boolean; failReportWrites?: number } = {}) {
  const log: string[] = [];
  let failReportWrites = opts.failReportWrites ?? 0;
  mocks.rpc.mockImplementation((fn: string) => {
    log.push(`rpc:${fn}`);
    if (opts.rpcFails) return Promise.resolve({ data: null, error: { message: "commit failed" } });
    const already = run.state === "committed";
    run.state = "committed";
    return Promise.resolve({ data: { already_committed: already }, error: null });
  });
  mocks.from.mockImplementation((table: string) => {
    let update: Partial<Run> | null = null;
    const filters: Record<string, unknown> = {};
    const builder = {
      select: () => builder,
      order: () => builder,
      delete: () => builder,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      },
      update: (payload: Partial<Run>) => {
        update = payload;
        return builder;
      },
      maybeSingle: () =>
        Promise.resolve({ data: table === "import_runs" ? { ...run } : null, error: null }),
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
        if (table === "import_runs" && update) {
          const isReportOnly = !("state" in update);
          if (isReportOnly && failReportWrites > 0) {
            failReportWrites -= 1;
            log.push("report:failed");
            return Promise.resolve({ data: null, error: { message: "write failed" } }).then(
              resolve,
            );
          }
          if (filters.state === undefined || filters.state === run.state) {
            Object.assign(run, update);
            log.push(isReportOnly ? "report" : `flip:${String(update.state)}`);
          }
        }
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return builder;
  });
  return log;
}

const readyRun = (report: ImportRunErrorEntry[] | null = null): Run => ({
  id: "run-1",
  org_id: "org-1",
  state: "ready_for_review",
  error_report: report,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("commitImportRun — provider warnings are written after the commit (P2-2)", () => {
  it("leaves the run's report untouched when the commit RPC fails", async () => {
    const run = readyRun([SCAN_ERROR]);
    const log = installTransport(run, { rpcFails: true });
    await expect(commitImportRun("run-1", EMPTY_PLAN, [entry(warning(2))])).rejects.toThrow(
      "commit failed",
    );
    expect(log).toEqual(["rpc:commit_import_run"]);
    expect(run).toMatchObject({ state: "ready_for_review", error_report: [SCAN_ERROR] });
  });

  it("appends the warnings once the commit succeeds", async () => {
    const run = readyRun([SCAN_ERROR]);
    const log = installTransport(run);
    await commitImportRun("run-1", EMPTY_PLAN, [entry(warning(2))]);
    expect(log).toEqual(["rpc:commit_import_run", "report"]);
    expect(run.error_report).toEqual([SCAN_ERROR, entry(warning(2))]);
  });

  it("says so when the report write fails, and a replayed commit adds it exactly once", async () => {
    const run = readyRun(null);
    installTransport(run, { failReportWrites: 1 });
    await expect(commitImportRun("run-1", EMPTY_PLAN, [entry(warning(2))])).rejects.toThrow(
      "The import committed, but its phone warnings weren't added to the run's report. Commit again now to add them. If this page reloads first, they can't be added: the run's staged rows are already gone.",
    );
    expect(run).toMatchObject({ state: "committed", error_report: null });

    await commitImportRun("run-1", EMPTY_PLAN, [entry(warning(2))]);
    await commitImportRun("run-1", EMPTY_PLAN, [entry(warning(2))]);
    expect(run.error_report).toEqual([entry(warning(2))]);
  });
});

describe("commitSectionImportRun — section warnings are written before the creates (P2-2)", () => {
  const groupCreate = (line: number): SectionCreateEntry => ({
    line,
    displayName: `Group ${line}`,
    mapped: { name: `Group ${line}`, tin: `55500${line}000`, billing_phone: null },
    groupId: null,
    notes: [],
    warnings: [warning(line, "billing_phone")],
  });

  it("keeps a landed group's warning when a later create fails, and a retry never repeats one", async () => {
    const run = readyRun([SCAN_ERROR]);
    const log = installTransport(run);
    mocks.createProviderGroup
      .mockResolvedValueOnce({ id: "group-2" })
      .mockRejectedValueOnce(new Error("insert failed"))
      .mockResolvedValue({ id: "group-3" });

    await expect(
      commitSectionImportRun({
        runId: "run-1",
        entityKind: "provider_group",
        creates: [groupCreate(2), groupCreate(3)],
        skippedCount: 0,
        blocked: [],
      }),
    ).rejects.toThrow("insert failed");
    expect(run.state).toBe("ready_for_review");
    expect(run.error_report).toEqual([
      SCAN_ERROR,
      entry(warning(2, "billing_phone")),
      entry(warning(3, "billing_phone")),
    ]);

    // On the retry the landed group reads as existing, so only row 3 creates.
    const blocked = { line: 4, column: "group_tin", displayName: "Ghost", reason: "Missing TIN" };
    await commitSectionImportRun({
      runId: "run-1",
      entityKind: "provider_group",
      creates: [groupCreate(3)],
      skippedCount: 1,
      blocked: [blocked],
    });
    expect(run.state).toBe("committed");
    expect(run.error_report).toEqual([
      SCAN_ERROR,
      entry(warning(2, "billing_phone")),
      entry(warning(3, "billing_phone")),
      { line: 4, column: "group_tin", reason: "Missing TIN" },
    ]);
    expect(log.filter((l) => l === "report")).toHaveLength(1);
  });

  it("creates the facility with the phone the rule chose", async () => {
    mocks.createFacility.mockResolvedValue({ id: "facility-new" });
    const run = readyRun(null);
    installTransport(run);
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
          warnings: [warning(2)],
        },
      ],
      skippedCount: 0,
      blocked: [],
    });
    expect(mocks.createFacility).toHaveBeenCalledWith(expect.objectContaining({ phone: null }));
    expect(run.error_report).toEqual([entry(warning(2))]);
  });
});
