import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitPlan, StagedImportRow } from "@/lib/importDedupe";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  insertAssignmentRows: vi.fn(),
  ensureFirstFacilityPrimary: vi.fn(),
  listEnrollmentFacts: vi.fn(),
  createEnrollmentFact: vi.fn(),
  createFacility: vi.fn(),
  createProviderGroup: vi.fn(),
  resolveAddProviderRules: vi.fn(),
  recordUndatedAssignments: vi.fn(),
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
  insertAssignmentRows: mocks.insertAssignmentRows,
  ensureFirstFacilityPrimary: mocks.ensureFirstFacilityPrimary,
  recordUndatedAssignments: mocks.recordUndatedAssignments,
}));
vi.mock("@/services/enrollmentFacts", () => ({
  listEnrollmentFacts: mocks.listEnrollmentFacts,
  createEnrollmentFact: mocks.createEnrollmentFact,
}));
vi.mock("@/services/orgSettings", () => ({
  createFacility: mocks.createFacility,
  createProviderGroup: mocks.createProviderGroup,
}));
vi.mock("@/lib/addProviderRules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/addProviderRules")>();
  mocks.resolveAddProviderRules.mockImplementation(actual.resolveAddProviderRules);
  return { ...actual, resolveAddProviderRules: mocks.resolveAddProviderRules };
});

import { applyBatchAssignment, commitImportRun, commitSectionImportRun } from "./importRuns";
import { DEFAULT_ADD_PROVIDER_RULES } from "@/lib/addProviderRules";
import { localCalendarDate } from "@/lib/systemTokens";

const NPI = "1234567890";
const OTHER_NPI = "9998887776";
const GROUPS = [
  { id: "group-1", name: "Colorado Group", tin: "111111111", npi_type2: "1111111111" },
  { id: "group-2", name: "Utah Group", tin: "222222222", npi_type2: "2222222222" },
  { id: "group-3", name: "Arizona Group", tin: "333333333", npi_type2: "3333333333" },
];

interface CapturedWrite {
  table: string;
  payload: unknown;
}

// MINT-134's read of the assignments a commit left undated: the rows it
// returns, an error to return instead, and the filters it was read with.
const undated = {
  rows: [] as Array<{ provider_id: string; facility_id: string }>,
  error: null as unknown,
  filters: [] as unknown[][],
};

// Mock only the transport and neighboring write services. The real commit
// service snapshots staged rows, calls the RPC, and chooses relationship writes.
function installTransport(
  stagedRows: StagedImportRow[],
  facilityIds = ["facility-2", "facility-3", "facility-4", "facility-5"],
  providerStartDates: Record<string, string> = {},
) {
  const writes: CapturedWrite[] = [];
  mocks.from.mockImplementation((table: string) => {
    let ids: string[] | undefined;
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      in: (column: string, values: string[]) => {
        ids = values;
        if (table === "provider_facility_assignments") undated.filters.push(["in", column, values]);
        return builder;
      },
      is: (column: string, value: unknown) => {
        if (table === "provider_facility_assignments") undated.filters.push(["is", column, value]);
        return builder;
      },
      range: () => builder,
      abortSignal: () => builder,
      upsert: (payload: unknown) => {
        writes.push({ table, payload });
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
        if (table === "provider_facility_assignments" && undated.error)
          return Promise.resolve({ data: null, error: undated.error }).then(resolve);
        const tables: Record<string, unknown> = {
          import_rows: stagedRows,
          providers: [
            { id: "provider-1", npi: NPI },
            { id: "provider-2", npi: OTHER_NPI },
          ]
            .map((p) => ({ ...p, start_date: providerStartDates[p.id] ?? null }))
            .filter((p) => !ids || ids.includes(p.id)),
          provider_groups: GROUPS,
          facilities: facilityIds.map((id) => ({ id })),
          provider_facility_assignments: undated.rows,
        };
        if (!(table in tables)) throw new Error(`Unexpected table read: ${table}`);
        return Promise.resolve({ data: tables[table], error: null }).then(resolve);
      },
    };
    return builder;
  });
  return writes;
}

function relationshipRow(
  line: number,
  groupIndex: number,
  state: string,
  npi = NPI,
): StagedImportRow {
  return {
    line,
    mapped: {
      npi,
      group_tin: GROUPS[groupIndex].tin,
      facility_id: `facility-${line}`,
      enrollment_payer_id: "payer-1",
      enrollment_state: state,
      enrollment_effective_date: "2026-01-01",
    },
  };
}

function updatePlan(blockedLines: number[] = []): CommitPlan {
  return {
    creates: [],
    updates: [
      {
        line: 2,
        provider_id: "provider-1",
        set: { specialty: "Physical Therapy" },
        add_group_ids: [],
        add_facility_ids: [],
        license_inserts: [],
        license_updates: [],
      },
    ],
    skipped_count: 0,
    blocked_entries: blockedLines.map((line) => ({
      line,
      column: "npi",
      reason: "Provider identity requires manual review",
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  undated.rows = [];
  undated.error = null;
  undated.filters = [];
  mocks.recordUndatedAssignments.mockResolvedValue(undefined);
  mocks.rpc.mockResolvedValue({
    data: { updated: 1, updated_provider_ids: ["provider-1"] },
    error: null,
  });
  mocks.listEnrollmentFacts.mockResolvedValue([]);
  mocks.createEnrollmentFact.mockResolvedValue({ id: "fact-1" });
  mocks.insertAssignmentRows.mockResolvedValue([]);
  mocks.ensureFirstFacilityPrimary.mockResolvedValue(undefined);
});

describe("commitImportRun — P02 reviewed source-row boundary", () => {
  it("excludes every blocked same-NPI row from relationship writes while safe providers commit", async () => {
    const writes = installTransport([
      relationshipRow(2, 0, "CO"),
      relationshipRow(3, 1, "UT"),
      relationshipRow(4, 2, "AZ"),
      relationshipRow(5, 2, "AZ", OTHER_NPI),
    ]);
    const plan = updatePlan([3, 4]);
    plan.updates.push({ ...plan.updates[0], line: 5, provider_id: "provider-2" });
    mocks.rpc.mockResolvedValue({
      data: { updated: 2, updated_provider_ids: ["provider-1", "provider-2"] },
      error: null,
    });

    const result = await commitImportRun("run-1", plan);

    expect(mocks.rpc).toHaveBeenCalledWith("commit_import_run", {
      p_run_id: "run-1",
      p_plan: { ...plan, assignment_start_date: localCalendarDate(new Date()) },
    });
    expect(result.updatedProviderIds).toEqual(["provider-1", "provider-2"]);
    expect(mocks.insertAssignmentRows).toHaveBeenCalledOnce();
    expect(mocks.insertAssignmentRows).toHaveBeenCalledWith([
      { providerId: "provider-1", facilityId: "facility-2", startDate: expect.any(String) },
      { providerId: "provider-2", facilityId: "facility-5", startDate: expect.any(String) },
    ]);
    expect(writes).toEqual([
      {
        table: "provider_group_assignments",
        payload: [
          { org_id: "org-1", provider_id: "provider-1", group_id: "group-1", is_primary: false },
          { org_id: "org-1", provider_id: "provider-2", group_id: "group-3", is_primary: false },
        ],
      },
    ]);
    expect(mocks.createEnrollmentFact.mock.calls.map(([input]) => input)).toEqual([
      {
        providerId: "provider-1",
        groupId: "group-1",
        payerId: "payer-1",
        state: "CO",
        effectiveDate: "2026-01-01",
      },
      {
        providerId: "provider-2",
        groupId: "group-3",
        payerId: "payer-1",
        state: "AZ",
        effectiveDate: "2026-01-01",
      },
    ]);
    expect(result.relationships).toEqual({
      facilityAssignments: 2,
      groupAssignments: 2,
      enrollmentFacts: 2,
    });
  });

  it("writes no relationships when every relationship source line is blocked", async () => {
    const writes = installTransport([
      { line: 2, mapped: { npi: NPI, specialty: "Physical Therapy" } },
      relationshipRow(3, 0, "CO"),
      relationshipRow(4, 1, "UT"),
    ]);

    const result = await commitImportRun("run-1", updatePlan([3, 4]));

    expect(result.updated).toBe(1);
    expect(writes).toEqual([]);
    expect(mocks.insertAssignmentRows).not.toHaveBeenCalled();
    expect(mocks.createEnrollmentFact).not.toHaveBeenCalled();
    expect(result.relationships).toEqual({
      facilityAssignments: 0,
      groupAssignments: 0,
      enrollmentFacts: 0,
    });
  });

  it("preserves one provider across three groups, three states, and three license rows", async () => {
    const writes = installTransport([
      relationshipRow(2, 0, "CO"),
      relationshipRow(3, 1, "UT"),
      relationshipRow(4, 2, "AZ"),
    ]);
    const plan = updatePlan();
    plan.updates[0].add_group_ids = ["group-1", "group-2", "group-3"];
    plan.updates[0].license_inserts = ["CO", "UT", "AZ"].map((state) => ({
      state,
      license_number: `${state}-100`,
      license_type: null,
      issue_date: null,
      expiration_date: null,
    }));

    const result = await commitImportRun("run-1", plan);

    expect(mocks.rpc).toHaveBeenCalledWith("commit_import_run", {
      p_run_id: "run-1",
      p_plan: { ...plan, assignment_start_date: localCalendarDate(new Date()) },
    });
    expect(result.updatedProviderIds).toEqual(["provider-1"]);
    expect(result.relationships).toEqual({
      facilityAssignments: 3,
      groupAssignments: 3,
      enrollmentFacts: 3,
    });
    expect(mocks.insertAssignmentRows).toHaveBeenCalledWith([
      { providerId: "provider-1", facilityId: "facility-2", startDate: expect.any(String) },
      { providerId: "provider-1", facilityId: "facility-3", startDate: expect.any(String) },
      { providerId: "provider-1", facilityId: "facility-4", startDate: expect.any(String) },
    ]);
    expect(writes[0]?.payload).toEqual([
      { org_id: "org-1", provider_id: "provider-1", group_id: "group-1", is_primary: false },
      { org_id: "org-1", provider_id: "provider-1", group_id: "group-2", is_primary: false },
      { org_id: "org-1", provider_id: "provider-1", group_id: "group-3", is_primary: false },
    ]);
    expect(mocks.createEnrollmentFact.mock.calls.map(([input]) => input.state)).toEqual([
      "CO",
      "UT",
      "AZ",
    ]);
  });

  it("prunes a deleted facility while preserving live assignments and enrollment facts", async () => {
    installTransport([relationshipRow(2, 0, "CO"), relationshipRow(3, 1, "UT")], ["facility-2"]);

    const result = await commitImportRun("run-1", updatePlan());

    expect(mocks.insertAssignmentRows).toHaveBeenCalledWith([
      { providerId: "provider-1", facilityId: "facility-2", startDate: expect.any(String) },
    ]);
    expect(result.relationships).toEqual({
      facilityAssignments: 1,
      groupAssignments: 2,
      enrollmentFacts: 2,
    });
  });

  it("dates blank assignments by the Add Provider rule: the local today by default", async () => {
    installTransport([relationshipRow(2, 0, "CO")]);
    const today = localCalendarDate(new Date());

    await commitImportRun("run-1", updatePlan());

    expect(mocks.rpc.mock.calls[0][1].p_plan.assignment_start_date).toBe(today);
    expect(mocks.insertAssignmentRows).toHaveBeenCalledWith([
      { providerId: "provider-1", facilityId: "facility-2", startDate: today },
    ]);
  });

  it('saves blank assignments without a start date under "none"', async () => {
    installTransport([relationshipRow(2, 0, "CO")]);
    mocks.resolveAddProviderRules.mockReturnValueOnce({
      ...DEFAULT_ADD_PROVIDER_RULES,
      assignmentStartDateDefault: "none",
    });

    await commitImportRun("run-1", updatePlan());

    expect(mocks.rpc.mock.calls[0][1].p_plan.assignment_start_date).toBeNull();
    expect(mocks.insertAssignmentRows).toHaveBeenCalledWith([
      { providerId: "provider-1", facilityId: "facility-2", startDate: null },
    ]);
  });

  it("starts a relationship row on the provider's own start date first, as the RPC does", async () => {
    installTransport([relationshipRow(2, 0, "CO")], undefined, { "provider-1": "2026-09-01" });
    mocks.resolveAddProviderRules.mockReturnValueOnce({
      ...DEFAULT_ADD_PROVIDER_RULES,
      assignmentStartDateDefault: "none",
    });

    await commitImportRun("run-1", updatePlan());

    expect(mocks.insertAssignmentRows).toHaveBeenCalledWith([
      { providerId: "provider-1", facilityId: "facility-2", startDate: "2026-09-01" },
    ]);
  });

  it("retains the existing replay behavior without another relationship pass", async () => {
    const writes = installTransport([relationshipRow(2, 0, "CO")]);
    mocks.rpc.mockResolvedValue({
      data: { already_committed: true, updated_provider_ids: ["provider-1"] },
      error: null,
    });

    const result = await commitImportRun("run-1", updatePlan());

    expect(result.alreadyCommitted).toBe(true);
    expect(writes).toEqual([]);
    expect(mocks.insertAssignmentRows).not.toHaveBeenCalled();
    expect(mocks.createEnrollmentFact).not.toHaveBeenCalled();
    expect(mocks.ensureFirstFacilityPrimary).not.toHaveBeenCalled();
  });
});

// Every (provider, facility) pair handed to recordUndatedAssignments.
const recordedPairs = () =>
  mocks.recordUndatedAssignments.mock.calls.flatMap(([pairs]) => pairs as unknown[]);

// MINT-134 — a commit under "no default" records the facility assignments it
// left undated as assignment.start_date_missing (source import): what the
// commit RPC wrote, read back as soon as its ids are known, and what the
// relationship pass inserted. The default dates every one, so nothing is read
// or recorded.
describe("commitImportRun — the assignment.start_date_missing advisory", () => {
  const noDefault = () =>
    mocks.resolveAddProviderRules.mockReturnValueOnce({
      ...DEFAULT_ADD_PROVIDER_RULES,
      assignmentStartDateDefault: "none",
    });

  it('under "none", records every undated assignment of a created provider and the added ones of an updated provider', async () => {
    installTransport([]);
    noDefault();
    const plan = updatePlan();
    plan.updates[0].add_facility_ids = ["facility-9"];
    mocks.rpc.mockResolvedValue({
      data: {
        created: 1,
        updated: 1,
        created_provider_ids: ["provider-3"],
        updated_provider_ids: ["provider-1"],
      },
      error: null,
    });
    undated.rows = [
      { provider_id: "provider-3", facility_id: "facility-7" },
      { provider_id: "provider-1", facility_id: "facility-6" }, // on file before the import
      { provider_id: "provider-3", facility_id: "facility-8" },
      { provider_id: "provider-1", facility_id: "facility-9" },
    ];

    await commitImportRun("run-1", plan);

    expect(mocks.recordUndatedAssignments).toHaveBeenCalledOnce();
    expect(mocks.recordUndatedAssignments).toHaveBeenCalledWith(
      [
        { providerId: "provider-3", facilityId: "facility-7" },
        { providerId: "provider-3", facilityId: "facility-8" },
        { providerId: "provider-1", facilityId: "facility-9" },
      ],
      "import",
    );
    expect(undated.filters).toEqual([
      ["in", "provider_id", ["provider-3", "provider-1"]],
      ["is", "start_date", null],
    ]);
  });

  it("reads back before the relationship pass, which records the rows it inserted undated", async () => {
    installTransport([relationshipRow(2, 0, "CO")]);
    noDefault();
    mocks.insertAssignmentRows.mockResolvedValueOnce([
      { providerId: "provider-1", facilityId: "facility-2", startDate: null },
    ]);

    await commitImportRun("run-1", updatePlan());

    expect(mocks.recordUndatedAssignments.mock.calls).toEqual([
      [[], "import"],
      [[{ providerId: "provider-1", facilityId: "facility-2", startDate: null }], "import"],
    ]);
    expect(mocks.recordUndatedAssignments.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.insertAssignmentRows.mock.invocationCallOrder[0],
    );
  });

  it("a later failure doesn't lose the record", async () => {
    installTransport([]);
    noDefault();
    const plan = updatePlan();
    plan.updates[0].add_facility_ids = ["facility-9"];
    undated.rows = [{ provider_id: "provider-1", facility_id: "facility-9" }];
    mocks.ensureFirstFacilityPrimary.mockRejectedValueOnce(new Error("synthetic failure"));

    await expect(commitImportRun("run-1", plan)).rejects.toThrow("synthetic failure");

    expect(recordedPairs()).toEqual([{ providerId: "provider-1", facilityId: "facility-9" }]);
  });

  it("records nothing under the default, which dates every assignment", async () => {
    installTransport([relationshipRow(2, 0, "CO")]);
    mocks.insertAssignmentRows.mockResolvedValueOnce([
      { providerId: "provider-1", facilityId: "facility-2", startDate: "2026-11-01" },
    ]);

    await commitImportRun("run-1", updatePlan());

    expect(undated.filters).toEqual([]);
    expect(recordedPairs()).toEqual([]);
  });

  it("records nothing on a replayed commit", async () => {
    installTransport([]);
    noDefault();
    mocks.rpc.mockResolvedValue({
      data: { already_committed: true, updated_provider_ids: ["provider-1"] },
      error: null,
    });
    undated.rows = [{ provider_id: "provider-1", facility_id: "facility-9" }];

    await commitImportRun("run-1", updatePlan());

    expect(undated.filters).toEqual([]);
    expect(mocks.recordUndatedAssignments).not.toHaveBeenCalled();
  });

  it("the commit never waits for the record", async () => {
    installTransport([]);
    noDefault();
    const plan = updatePlan();
    plan.updates[0].add_facility_ids = ["facility-9"];
    undated.rows = [{ provider_id: "provider-1", facility_id: "facility-9" }];
    mocks.recordUndatedAssignments.mockReturnValue(new Promise(() => undefined));

    await expect(commitImportRun("run-1", plan)).resolves.toMatchObject({ updated: 1 });

    expect(mocks.recordUndatedAssignments).toHaveBeenCalledOnce();
  });

  it("a failed read never fails the commit", async () => {
    installTransport([]);
    noDefault();
    undated.error = { code: "XX000", message: "synthetic failure" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(commitImportRun("run-1", updatePlan())).resolves.toMatchObject({ updated: 1 });
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
        event: "advisory_record_failed",
        check_key: "assignment.start_date_missing",
        sqlstate: "XX000",
      });
      expect(mocks.recordUndatedAssignments).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// MINT-134 — the batch-assign panel saves a blank start date as none; that
// batch records the rows it actually inserted (not the plan), as soon as they
// are written.
describe("applyBatchAssignment — the assignment.start_date_missing advisory", () => {
  const plan = {
    groupInserts: [{ providerId: "provider-1", groupId: "group-1", isPrimary: true }],
    facilityInserts: [
      { providerId: "provider-1", facilityId: "facility-2" },
      { providerId: "provider-1", facilityId: "facility-3" },
      { providerId: "provider-2", facilityId: "facility-2" },
    ],
    skippedProviderIds: [],
  };
  const batch = (startDate: string | null) => ({
    runId: "run-1",
    groupId: "group-1",
    facilityIds: ["facility-2", "facility-3"],
    startDate,
    plan,
  });
  // provider-1 at facility-3 was already assigned, so the insert skipped it.
  const INSERTED = [
    { providerId: "provider-1", facilityId: "facility-2", startDate: null },
    { providerId: "provider-2", facilityId: "facility-2", startDate: null },
  ];

  it("a batch without a start date records the rows it inserted, once (source import)", async () => {
    installTransport([]);
    mocks.insertAssignmentRows.mockResolvedValueOnce(INSERTED);

    await applyBatchAssignment(batch(null));

    expect(mocks.recordUndatedAssignments).toHaveBeenCalledOnce();
    expect(mocks.recordUndatedAssignments).toHaveBeenCalledWith(INSERTED, "import");
  });

  it("a repeat click, which inserts nothing, records nothing", async () => {
    installTransport([]);
    mocks.insertAssignmentRows.mockResolvedValueOnce([]);

    await applyBatchAssignment(batch(null));

    expect(recordedPairs()).toEqual([]);
  });

  it("a dated batch records nothing", async () => {
    installTransport([]);
    mocks.insertAssignmentRows.mockResolvedValueOnce(
      INSERTED.map((r) => ({ ...r, startDate: "2026-11-01" })),
    );

    await applyBatchAssignment(batch("2026-11-01"));

    expect(recordedPairs()).toEqual([]);
  });

  it("a later failure doesn't lose the record", async () => {
    installTransport([]);
    mocks.insertAssignmentRows.mockResolvedValueOnce(INSERTED);
    mocks.ensureFirstFacilityPrimary.mockRejectedValueOnce(new Error("synthetic failure"));

    await expect(applyBatchAssignment(batch(null))).rejects.toThrow("synthetic failure");

    expect(mocks.recordUndatedAssignments).toHaveBeenCalledWith(INSERTED, "import");
  });

  it("the batch never waits for the record", async () => {
    installTransport([]);
    mocks.insertAssignmentRows.mockResolvedValueOnce(INSERTED);
    mocks.recordUndatedAssignments.mockReturnValue(new Promise(() => undefined));

    await expect(applyBatchAssignment(batch(null))).resolves.toEqual({
      groupsAdded: 1,
      facilitiesAdded: 3,
      skippedProviders: 0,
    });
  });

  it("records nothing when the save fails", async () => {
    installTransport([]);
    mocks.insertAssignmentRows.mockRejectedValueOnce(new Error("synthetic failure"));

    await expect(applyBatchAssignment(batch(null))).rejects.toThrow("synthetic failure");

    expect(mocks.recordUndatedAssignments).not.toHaveBeenCalled();
  });
});

/* ------------------------ facility section commit ------------------------ */

// Only the run header read, the committed flip and the staged-row purge touch
// the transport here; createFacility is the seam under test.
function installSectionTransport() {
  mocks.from.mockImplementation((table: string) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      update: () => builder,
      delete: () => builder,
      maybeSingle: () =>
        Promise.resolve({
          data:
            table === "import_runs"
              ? { id: "run-1", org_id: "org-1", state: "ready_for_review", error_report: null }
              : null,
          error: null,
        }),
      then: (resolve: (value: { data: unknown; error: null }) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return builder;
  });
}

const FACILITY_MAPPED: Record<string, string | null> = {
  facility_name: "Riverside Clinic",
  group_name: null,
  group_tin: "123456789",
  group_npi: null,
  street: "10 Dockside Dr",
  suite: null,
  city: "Wilmington",
  state: "NC",
  zip: "28401",
  county: null,
  phone: null,
  fax: null,
  email: null,
  appointment_phone: null,
  contact_name: null,
  accepting_new_patients: null,
  languages_offered: null,
  interpreter_languages: null,
  ada_accessible: null,
  ada_notes: null,
  effective_date: null,
};

describe("commitSectionImportRun — facility rows match the manual form", () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.createFacility
      .mockReset()
      .mockResolvedValue({ id: "facility-new", name: "Riverside Clinic" });
    installSectionTransport();
  });

  it("writes the form's defaults for blank cells instead of NULLs that override them (G4)", async () => {
    const result = await commitSectionImportRun({
      runId: "run-1",
      entityKind: "facility",
      creates: [
        {
          line: 2,
          displayName: "Riverside Clinic",
          mapped: FACILITY_MAPPED,
          groupId: "group-1",
          notes: [],
        },
      ],
      skippedCount: 0,
      blocked: [],
    });

    expect(result).toMatchObject({ alreadyCommitted: false, created: 1 });
    expect(mocks.createFacility).toHaveBeenCalledTimes(1);
    expect(mocks.createFacility).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Riverside Clinic",
        groupId: "group-1",
        acceptingNewPatients: true,
        languagesOffered: [],
        interpreterLanguages: [],
        adaCompliance: {},
        hours: {},
        effectiveDate: null,
      }),
    );
  });

  it("encodes the per-day hours columns through the locked jsonb contract and carries the go-live date (G5)", async () => {
    await commitSectionImportRun({
      runId: "run-1",
      entityKind: "facility",
      creates: [
        {
          line: 2,
          mapped: {
            ...FACILITY_MAPPED,
            effective_date: "2027-03-01",
            mon_open: "07:00",
            mon_close: "19:00",
            sat_open: "09:00",
            sat_close: "13:00",
            accepting_new_patients: "false",
            languages_offered: "English;Spanish",
            ada_accessible: "true",
            ada_notes: "Ramp at side entrance",
          },
          groupId: "group-1",
          displayName: "Riverside Clinic",
          notes: [],
        },
      ],
      skippedCount: 0,
      blocked: [],
    });

    expect(mocks.createFacility).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveDate: "2027-03-01",
        acceptingNewPatients: false,
        languagesOffered: ["English", "Spanish"],
        adaCompliance: { accessible: true, notes: "Ramp at side entrance" },
        hours: {
          mon: { status: "open", open: "07:00", close: "19:00" },
          tue: { status: "closed" },
          wed: { status: "closed" },
          thu: { status: "closed" },
          fri: { status: "closed" },
          sat: { status: "open", open: "09:00", close: "13:00" },
          sun: { status: "closed" },
        },
      }),
    );
  });
});
