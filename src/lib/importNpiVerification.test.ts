// MINT-110 PR 2 / MINT-119 — which import rows are checked against the NPI
// Registry (both scopes), each row's result kind, note and severity (both
// severities), what a block does to the review and the commit, and the
// progress words (the time-left estimate and its fallback to "N of M").
// Pure; no network.
import { describe, expect, it } from "vitest";
import {
  buildCommitPlan,
  dedupeImportRows,
  summarizeImportPreview,
  type DedupeInputs,
  type StagedImportRow,
} from "./importDedupe";
import {
  DEFAULT_IMPORT_NPI_SCOPE,
  DEFAULT_NPI_SEVERITY_FOR,
  ETA_MIN_DONE,
  NPI_REGISTRY_OUTCOME_KINDS,
  applyImportNpiBlocks,
  estimateRemainingMs,
  formatTimeRemaining,
  importNpiAnnouncement,
  importNpiChecksKey,
  importNpiRowResult,
  importNpiStatusText,
  npiPolicyCanBlock,
  registryOutcomeKinds,
  selectImportNpiChecks,
  type ImportNpiCheckItem,
  type ImportNpiOutcome,
  type ImportNpiSnapshot,
  type NpiRegistryOutcomeKind,
  type NpiRegistrySeverityFor,
} from "./importNpiVerification";
import type { NpiRegistryRecord } from "./npiRegistry";
import { npiCheckDigit } from "./providerIdentity";

function fakeNpi(n: number): string {
  const first9 = `1${String(n).padStart(8, "0")}`;
  return `${first9}${npiCheckDigit(first9)}`;
}

const record = (over: Partial<NpiRegistryRecord> = {}): NpiRegistryRecord => ({
  npi: fakeNpi(1),
  enumerationType: "NPI-1",
  firstName: "AVERY",
  middleName: null,
  lastName: "QUILL",
  organizationName: null,
  credential: "PT",
  primaryTaxonomy: { code: "225100000X", description: "Physical Therapist" },
  practiceCity: "DENVER",
  practiceState: "CO",
  status: "active",
  enumerationDate: "2015-03-02",
  otherNames: [],
  ...over,
});

const ORG_RECORD = record({
  enumerationType: "NPI-2",
  firstName: null,
  lastName: null,
  organizationName: "QUILL THERAPY LLC",
});

function inputs(over: Partial<DedupeInputs>): DedupeInputs {
  return {
    rows: [],
    providers: [],
    groups: [
      { id: "g1", name: "North Group", tin: "111111111" },
      { id: "g2", name: "South Group", tin: "222222222" },
    ],
    facilities: [],
    groupAssignments: [],
    facilityAssignments: [],
    licenses: [],
    ...over,
  };
}

const row = (
  line: number,
  first: string,
  last: string,
  npi: string | null,
  tin = "111111111",
): StagedImportRow => ({
  line,
  mapped: { provider_first_name: first, provider_last_name: last, npi, group_tin: tin },
});

const NEW_NPI = fakeNpi(10);
const EXISTING_NPI = fakeNpi(11);
const FILL_NPI = fakeNpi(12);
const MOVING_NPI = fakeNpi(14);
const BAD_NPI = `${fakeNpi(13).slice(0, 9)}${(Number(fakeNpi(13)[9]) + 1) % 10}`;

// One file with every disposition: a new provider (two lines), an exact
// duplicate, an NPI fill onto a provider with none, an existing provider
// gaining a group, a check-digit failure and a missing NPI.
function mixedImport() {
  const rows = [
    row(2, "Avery", "Quill", NEW_NPI),
    row(3, "Avery", "Quill", NEW_NPI, "222222222"),
    row(4, "Blake", "Orr", EXISTING_NPI),
    row(5, "Casey", "Vale", FILL_NPI),
    row(6, "Drew", "Nash", BAD_NPI),
    row(7, "Emery", "Pike", null),
    row(8, "Finley", "Roe", MOVING_NPI, "222222222"),
  ];
  const dispositions = dedupeImportRows(
    inputs({
      providers: [
        { id: "p1", firstName: "Blake", lastName: "Orr", npi: EXISTING_NPI, specialty: null },
        { id: "p2", firstName: "Casey", lastName: "Vale", npi: null, specialty: null },
        { id: "p3", firstName: "Finley", lastName: "Roe", npi: MOVING_NPI, specialty: null },
      ],
      groupAssignments: [
        { providerId: "p1", groupId: "g1" },
        { providerId: "p3", groupId: "g1" },
      ],
      rows,
    }),
  );
  return { rows, dispositions };
}

describe("selectImportNpiChecks", () => {
  it("by default checks only rows the import would create — never a match, update, skip or block", () => {
    const { rows, dispositions } = mixedImport();
    expect(dispositions.map((d) => [d.kind, d.line])).toEqual([
      ["create", 2],
      ["skip", 4],
      ["update", 5],
      ["blocked", 6],
      ["blocked", 7],
      ["update", 8],
    ]);
    expect(DEFAULT_IMPORT_NPI_SCOPE).toBe("new_providers");
    const expected = [
      { npi: NEW_NPI, line: 2, firstName: "Avery", lastName: "Quill", disposition: "create" },
    ];
    expect(selectImportNpiChecks(dispositions)).toEqual(expected);
    expect(selectImportNpiChecks(dispositions, { scope: "new_providers", rows })).toEqual(expected);
  });

  it('with scope "all_rows" also checks rows that match or update an existing provider', () => {
    const { rows, dispositions } = mixedImport();
    expect(selectImportNpiChecks(dispositions, { scope: "all_rows", rows })).toEqual([
      { npi: NEW_NPI, line: 2, firstName: "Avery", lastName: "Quill", disposition: "create" },
      { npi: EXISTING_NPI, line: 4, firstName: "Blake", lastName: "Orr", disposition: "skip" },
      { npi: FILL_NPI, line: 5, firstName: "Casey", lastName: "Vale", disposition: "update" },
      { npi: MOVING_NPI, line: 8, firstName: "Finley", lastName: "Roe", disposition: "update" },
    ]);
    // Without the staged rows there is no NPI to read for a match.
    expect(selectImportNpiChecks(dispositions, { scope: "all_rows" })).toHaveLength(1);
  });

  it("strips separators and drops an NPI that fails the check digit", () => {
    const good = fakeNpi(20);
    const dashed = `${good.slice(0, 3)}-${good.slice(3)}`;
    const create = dedupeImportRows(inputs({ rows: [row(2, "Avery", "Quill", good)] }))[0];
    if (create.kind !== "create") throw new Error("expected a create");
    const tampered = { ...create, npi: "1234567890", line: 9 };
    expect(selectImportNpiChecks([{ ...create, npi: dashed }, tampered])).toEqual([
      { npi: good, line: 2, firstName: "Avery", lastName: "Quill", disposition: "create" },
    ]);
    expect(selectImportNpiChecks(null)).toEqual([]);
  });

  it("keys the set of rows, not their order", () => {
    const a: ImportNpiCheckItem = {
      npi: fakeNpi(1),
      line: 2,
      firstName: "A",
      lastName: "B",
      disposition: "create",
    };
    const b: ImportNpiCheckItem = { ...a, npi: fakeNpi(2), line: 3, firstName: "C" };
    expect(importNpiChecksKey([a, b])).toBe(importNpiChecksKey([b, a]));
    expect(importNpiChecksKey([a])).not.toBe(importNpiChecksKey([a, b]));
    expect(importNpiChecksKey([])).toBe("");
  });
});

describe("importNpiRowResult", () => {
  const typed = { firstName: "Avery", lastName: "Quill" };
  const checked = (r: NpiRegistryRecord | null): ImportNpiOutcome => ({
    status: "checked",
    record: r,
  });

  it("gives every answer a stable kind and the forms' wording, all warnings by default", () => {
    expect(importNpiRowResult(checked(record()), typed, "running")).toEqual({
      kind: "found",
      outcomes: [],
      severity: "ok",
      note: {
        tone: "ok",
        title: "Found in the NPI Registry",
        detail: "AVERY QUILL, PT · Physical Therapist · DENVER, CO",
      },
      blockReason: null,
    });
    expect(importNpiRowResult(checked(record({ firstName: "MORGAN" })), typed, "done")).toEqual({
      kind: "nameMismatch",
      outcomes: ["nameMismatch"],
      severity: "warn",
      note: {
        tone: "warn",
        title: "Found in the NPI Registry, but the name differs",
        detail: "The registry lists MORGAN QUILL, PT · Physical Therapist · DENVER, CO.",
      },
      blockReason: null,
    });
    expect(
      importNpiRowResult(checked(record({ status: "inactive" })), typed, "done"),
    ).toMatchObject({
      kind: "inactive",
      severity: "warn",
      note: { tone: "warn", title: "The NPI Registry lists this NPI as inactive" },
    });
    // An organization (NPI-2) number warns; it never blocks by default.
    expect(importNpiRowResult(checked(ORG_RECORD), typed, "done")).toEqual({
      kind: "organizationNumber",
      outcomes: ["organizationNumber"],
      severity: "warn",
      note: {
        tone: "warn",
        title: "This NPI belongs to an organization",
        detail: "The registry lists QUILL THERAPY LLC. A provider's Type 1 NPI is an individual's.",
      },
      blockReason: null,
    });
    // Not found: the form's "You can still save" line is not repeated per row.
    expect(importNpiRowResult(checked(null), typed, "done")).toMatchObject({
      kind: "notFound",
      severity: "warn",
      note: {
        tone: "warn",
        title: "Not found in the NPI Registry",
        detail: "Re-check the number; deactivated NPIs are not listed.",
      },
    });
  });

  it("lists every outcome that applies: inactive and under another name", () => {
    expect(registryOutcomeKinds(record({ status: "inactive", lastName: "ROE" }), typed)).toEqual([
      "inactive",
      "nameMismatch",
    ]);
    expect(registryOutcomeKinds(null, typed)).toEqual(["notFound"]);
    expect(registryOutcomeKinds(record(), typed)).toEqual([]);
  });

  it("blocks with a plain reason when a policy sets that outcome to block", () => {
    const blockNameMismatch: NpiRegistrySeverityFor = (kind) =>
      kind === "nameMismatch" ? "block" : "warn";
    expect(
      importNpiRowResult(
        checked(record({ firstName: "MORGAN" })),
        typed,
        "done",
        blockNameMismatch,
      ),
    ).toMatchObject({
      kind: "nameMismatch",
      severity: "block",
      blockReason:
        "Not imported — the name differs from the NPI Registry. Correct the row and re-import.",
    });
    // A second outcome that blocks still blocks the row when the first warns.
    expect(
      importNpiRowResult(
        checked(record({ status: "inactive", firstName: "MORGAN" })),
        typed,
        "done",
        blockNameMismatch,
      ),
    ).toMatchObject({ kind: "inactive", severity: "block" });
    // Other outcomes keep warning.
    expect(importNpiRowResult(checked(ORG_RECORD), typed, "done", blockNameMismatch)).toMatchObject(
      { severity: "warn", blockReason: null },
    );
    const reasons = Object.fromEntries(
      NPI_REGISTRY_OUTCOME_KINDS.map((kind) => {
        const r =
          kind === "organizationNumber"
            ? ORG_RECORD
            : kind === "notFound"
              ? null
              : kind === "inactive"
                ? record({ status: "inactive" })
                : record({ firstName: "MORGAN" });
        return [kind, importNpiRowResult(checked(r), typed, "done", () => "block").blockReason];
      }),
    ) as Record<NpiRegistryOutcomeKind, string>;
    expect(reasons).toEqual({
      organizationNumber:
        "Not imported — the NPI belongs to an organization in the NPI Registry. Correct the row and re-import.",
      notFound: "Not imported — the NPI is not in the NPI Registry. Correct the row and re-import.",
      nameMismatch:
        "Not imported — the name differs from the NPI Registry. Correct the row and re-import.",
      inactive:
        "Not imported — the NPI Registry lists this NPI as inactive. Correct the row and re-import.",
    });
  });

  it("never blocks a row that was not checked, whatever the policy", () => {
    const blockAll: NpiRegistrySeverityFor = () => "block";
    for (const reason of ["unavailable", "rate_limited", "stopped"] as const) {
      const result = importNpiRowResult({ status: "not_checked", reason }, typed, "done", blockAll);
      expect(result.kind).toBe("notChecked");
      expect(result.blockReason).toBeNull();
      expect(result.severity).not.toBe("block");
    }
    expect(importNpiRowResult(undefined, typed, "running", blockAll)).toMatchObject({
      kind: "pending",
      blockReason: null,
      note: { title: "Not checked yet" },
    });
    expect(importNpiRowResult(undefined, typed, "stopped", blockAll)).toMatchObject({
      kind: "notChecked",
      note: { title: "Not checked" },
    });
    expect(
      importNpiRowResult({ status: "not_checked", reason: "unavailable" }, typed, "done").note,
    ).toEqual({ tone: "warn", title: "Not checked — NPI Registry is unavailable", detail: null });
    expect(
      importNpiRowResult({ status: "not_checked", reason: "rate_limited" }, typed, "done").note
        .title,
    ).toBe("Not checked — too many NPI Registry checks");
    expect(
      importNpiRowResult({ status: "not_checked", reason: "stopped" }, typed, "stopped").note,
    ).toEqual({ tone: "neutral", title: "Not checked — the checks were stopped", detail: null });
  });

  it("knows whether a policy can block at all", () => {
    expect(npiPolicyCanBlock(DEFAULT_NPI_SEVERITY_FOR)).toBe(false);
    expect(npiPolicyCanBlock((kind) => (kind === "inactive" ? "block" : "warn"))).toBe(true);
  });
});

describe("applyImportNpiBlocks", () => {
  it("leaves the review untouched when nothing blocks (the default policy)", () => {
    const { dispositions } = mixedImport();
    expect(applyImportNpiBlocks(dispositions, new Map())).toBe(dispositions);
  });

  it("holds a blocked new provider back: every source line blocked, the counts reconcile, nothing committed", () => {
    const { dispositions } = mixedImport();
    const reason =
      "Not imported — the NPI is not in the NPI Registry. Correct the row and re-import.";
    const reviewed = applyImportNpiBlocks(dispositions, new Map([[2, reason]]));
    expect(reviewed.filter((d) => d.kind === "create")).toHaveLength(0);
    expect(reviewed.filter((d) => d.kind === "blocked" && d.reason === reason)).toEqual([
      { kind: "blocked", line: 2, column: "npi", displayName: "Avery Quill", reason },
      { kind: "blocked", line: 3, column: "npi", displayName: "Avery Quill", reason },
    ]);
    const before = summarizeImportPreview(dispositions, {}, 0);
    const after = summarizeImportPreview(reviewed, {}, 0);
    expect(after.createProviders).toBe(before.createProviders - 1);
    expect(after.blockedRows).toBe(before.blockedRows + 2);
    expect(after.stagedRowsCovered).toBe(before.stagedRowsCovered);
    const plan = buildCommitPlan(reviewed, {});
    expect(plan.creates).toHaveLength(0);
    expect(plan.blocked_entries).toEqual(
      expect.arrayContaining([
        { line: 2, column: "npi", reason },
        { line: 3, column: "npi", reason },
      ]),
    );
  });

  it('with scope "all_rows" a blocked update is held back too; a skip writes nothing and stays a skip', () => {
    const { dispositions } = mixedImport();
    const reason =
      "Not imported — the name differs from the NPI Registry. Correct the row and re-import.";
    const reviewed = applyImportNpiBlocks(
      dispositions,
      new Map([
        [8, reason],
        [4, reason],
      ]),
    );
    expect(reviewed.find((d) => d.line === 8)).toMatchObject({ kind: "blocked", reason });
    expect(reviewed.find((d) => d.line === 4)).toMatchObject({ kind: "skip" });
    const plan = buildCommitPlan(reviewed, { p2: { npi: "imported" } });
    expect(plan.updates.map((u) => u.provider_id)).toEqual(["p2"]);
  });
});

describe("estimateRemainingMs", () => {
  const budget = 60;

  it("shows nothing until enough rows are done to trust the rate", () => {
    expect(
      estimateRemainingMs({
        done: ETA_MIN_DONE - 1,
        total: 100,
        elapsedMs: 5_000,
        budgetPerMinute: budget,
      }),
    ).toBeNull();
    expect(
      estimateRemainingMs({ done: 30, total: 100, elapsedMs: 0, budgetPerMinute: budget }),
    ).toBeNull();
    expect(
      estimateRemainingMs({ done: 100, total: 100, elapsedMs: 90_000, budgetPerMinute: budget }),
    ).toBeNull();
  });

  it("caps a fast start at the budget rate", () => {
    // 20 rows in 2 s (or 0.3 s) rode the burst; the other 80 go at one a second.
    expect(
      estimateRemainingMs({ done: 20, total: 100, elapsedMs: 2_000, budgetPerMinute: budget }),
    ).toBe(80_000);
    expect(
      estimateRemainingMs({ done: 20, total: 100, elapsedMs: 300, budgetPerMinute: budget }),
    ).toBe(80_000);
  });

  it("uses the observed rate when the registry is slower than the budget", () => {
    // 20 rows in 40 s is one every 2 s.
    expect(
      estimateRemainingMs({ done: 20, total: 60, elapsedMs: 40_000, budgetPerMinute: budget }),
    ).toBe(80_000);
  });
});

describe("formatTimeRemaining", () => {
  it("rounds to words people read at a glance", () => {
    expect(formatTimeRemaining(4_000)).toBe("A few seconds left");
    expect(formatTimeRemaining(12_000)).toBe("About 20 seconds left");
    expect(formatTimeRemaining(40_000)).toBe("About 40 seconds left");
    expect(formatTimeRemaining(52_000)).toBe("About 1 minute left");
    expect(formatTimeRemaining(80_000)).toBe("About 1 minute left");
    expect(formatTimeRemaining(100_000)).toBe("About 2 minutes left");
    expect(formatTimeRemaining(9 * 60_000)).toBe("About 9 minutes left");
  });
});

function snapshot(over: Partial<ImportNpiSnapshot>): ImportNpiSnapshot {
  return {
    phase: "running",
    total: 100,
    done: 0,
    checked: 0,
    results: new Map(),
    etaMs: null,
    ...over,
  };
}

const counts = (notes: number, blocked = 0) => ({ notes, blocked });

describe("progress words", () => {
  it("shows rows done of rows total while running", () => {
    expect(importNpiStatusText(snapshot({ done: 40, checked: 40 }), counts(2))).toBe(
      "40 of 100 checked",
    );
    expect(importNpiStatusText(snapshot({ phase: "idle", total: 1 }), counts(0))).toBe(
      "1 NPI to check",
    );
  });

  it("has a completion state that says what was found, blocked and not checked", () => {
    expect(
      importNpiStatusText(snapshot({ phase: "done", done: 100, checked: 100 }), counts(3)),
    ).toBe("Finished — 100 of 100 checked, 3 with notes.");
    expect(
      importNpiStatusText(snapshot({ phase: "done", done: 100, checked: 100 }), counts(3, 2)),
    ).toBe("Finished — 100 of 100 checked, 3 with notes, 2 blocked.");
    const results = new Map<string, ImportNpiOutcome>([
      ["a", { status: "not_checked", reason: "unavailable" }],
      ["b", { status: "not_checked", reason: "unavailable" }],
    ]);
    expect(
      importNpiStatusText(snapshot({ phase: "done", done: 100, checked: 98, results }), counts(1)),
    ).toBe(
      "Finished — 98 of 100 checked, 1 with a note. 2 not checked — the NPI Registry is unavailable.",
    );
    expect(
      importNpiStatusText(snapshot({ phase: "stopped", done: 100, checked: 40 }), counts(0)),
    ).toBe("Stopped — 40 of 100 checked, 0 with notes. Rows not checked say so.");
  });

  it("announces at the start, each quarter and the end — not every row", () => {
    const said = new Set<string>();
    for (let done = 0; done < 100; done += 1) {
      said.add(importNpiAnnouncement(snapshot({ done, checked: done }), counts(0)));
    }
    expect([...said]).toEqual([
      "Checking 100 NPIs in the NPI Registry.",
      "NPI Registry checks 25% done.",
      "NPI Registry checks 50% done.",
      "NPI Registry checks 75% done.",
    ]);
    expect(
      importNpiAnnouncement(snapshot({ phase: "done", done: 100, checked: 100 }), counts(2)),
    ).toBe("NPI Registry checks finished: 100 of 100 checked, 2 with notes.");
    expect(importNpiAnnouncement(snapshot({ phase: "idle" }), counts(0))).toBe("");
  });
});
