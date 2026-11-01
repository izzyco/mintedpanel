// MINT-110 PR 2 / MINT-119 — which import rows are checked against the NPI
// Registry (both scopes), the quiet notes each row shows under each display
// setting, that every row commits whatever the registry says (A30, A39–A41),
// what is captured after commit (the registry's answers, facts only), and the
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
  ETA_MIN_DONE,
  estimateRemainingMs,
  formatTimeRemaining,
  importCommitProviderIds,
  importCommittedLines,
  importNpiAnnouncement,
  importNpiCaptureAdvisories,
  importNpiChecksKey,
  importNpiCommitWarning,
  importNpiProgressText,
  importNpiRowResult,
  importNpiStatusText,
  selectImportNpiChecks,
  summarizeImportNpiRows,
  type ImportNpiCheckItem,
  type ImportNpiOutcome,
  type ImportNpiSnapshot,
} from "./importNpiVerification";
import type { NpiRegistryRecord } from "./npiRegistry";
import {
  DEFAULT_NPI_REGISTRY_POLICY,
  NPI_REGISTRY_CHECKS,
  resolveNpiRegistryPolicy,
} from "./npiRegistryPolicy";
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

const item = (over: Partial<ImportNpiCheckItem> = {}): ImportNpiCheckItem => ({
  npi: fakeNpi(1),
  line: 2,
  firstName: "Avery",
  lastName: "Quill",
  credentials: "PT",
  taxonomyCode: "",
  disposition: "create",
  ...over,
});

const NOT_FOUND = null;
const INACTIVE = record({ status: "inactive" });
const NAME_DIFFERS = record({ firstName: "MORGAN" });

describe("selectImportNpiChecks", () => {
  it("by default checks only rows the import would create — never a match, update, skip or block", () => {
    const { rows, dispositions } = mixedImport();
    expect(dispositions.map((d) => [d.kind, d.line])).toEqual([
      ["create", 2],
      ["skip", 4],
      ["update", 5],
      ["blocked", 6],
      // B3 (Nov 1): a row with no NPI imports as a new provider, and has no NPI
      // to check.
      ["create", 7],
      ["update", 8],
    ]);
    expect(DEFAULT_NPI_REGISTRY_POLICY.importVerifyScope).toBe("new_providers");
    const expected = [item({ npi: NEW_NPI, line: 2, credentials: "", disposition: "create" })];
    expect(selectImportNpiChecks(dispositions)).toEqual(expected);
    expect(selectImportNpiChecks(dispositions, { scope: "new_providers", rows })).toEqual(expected);
  });

  it('with scope "all_rows" also checks rows that match or update an existing provider', () => {
    const { rows, dispositions } = mixedImport();
    expect(
      selectImportNpiChecks(dispositions, {
        scope: resolveNpiRegistryPolicy(null, { importVerifyScope: "all_rows" }).importVerifyScope,
        rows,
      }).map((i) => [i.npi, i.line, i.firstName, i.disposition]),
    ).toEqual([
      [NEW_NPI, 2, "Avery", "create"],
      [EXISTING_NPI, 4, "Blake", "skip"],
      [FILL_NPI, 5, "Casey", "update"],
      [MOVING_NPI, 8, "Finley", "update"],
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
      item({ npi: good, line: 2, credentials: "" }),
    ]);
    expect(selectImportNpiChecks(null)).toEqual([]);
  });

  it("keys the set of rows, not their order", () => {
    const a = item({ npi: fakeNpi(1), firstName: "A", lastName: "B" });
    const b = item({ npi: fakeNpi(2), line: 3, firstName: "C" });
    expect(importNpiChecksKey([a, b])).toBe(importNpiChecksKey([b, a]));
    expect(importNpiChecksKey([a])).not.toBe(importNpiChecksKey([a, b]));
    expect(importNpiChecksKey([])).toBe("");
  });
});

describe("importNpiRowResult — every answer an advisory, never a block (A30)", () => {
  const checked = (r: NpiRegistryRecord | null): ImportNpiOutcome => ({
    status: "checked",
    record: r,
  });
  const titles = (r: NpiRegistryRecord | null, policy = DEFAULT_NPI_REGISTRY_POLICY) =>
    importNpiRowResult(checked(r), item(), "done", policy).notes.map((n) => n.title);

  it("lists each review-step advisory on its row as a quiet one-line note", () => {
    expect(importNpiRowResult(checked(ORG_RECORD), item(), "done")).toMatchObject({
      notes: [{ tone: "warn", title: "This NPI belongs to an organization", detail: null }],
    });
    expect(importNpiRowResult(checked(NOT_FOUND), item(), "done")).toMatchObject({
      notes: [{ tone: "warn", title: "Not found in the NPI Registry", detail: null }],
    });
    expect(importNpiRowResult(checked(INACTIVE), item(), "done")).toMatchObject({
      notes: [{ title: "The NPI Registry lists this NPI as inactive", detail: null }],
    });
    expect(importNpiRowResult(checked(NAME_DIFFERS), item(), "done")).toMatchObject({
      notes: [{ title: "Found in the NPI Registry, but the name differs", detail: null }],
    });
    // A value the file gives that differs from the record found.
    expect(
      importNpiRowResult(checked(record()), item({ credentials: "OT" }), "done").notes,
    ).toEqual([{ tone: "warn", title: "Credentials OT — the registry has PT", detail: null }]);
    expect(
      importNpiRowResult(checked(record()), item({ taxonomyCode: "225X00000X" }), "done").notes.map(
        (n) => n.title,
      ),
    ).toEqual(["Taxonomy code 225X00000X — the registry has 225100000X (Physical Therapist)"]);
  });

  it('shows "Found" only for a full match with no advisory at all', () => {
    expect(importNpiRowResult(checked(record()), item(), "done")).toEqual({
      notes: [{ tone: "ok", title: "Found in the NPI Registry", detail: null }],
    });
    // Found, but a value differs: the advisory, never "Found".
    expect(titles(record({ credential: "OT" }))).toEqual(["Credentials PT — the registry has OT"]);
    // Not checked, not yet checked, or checked into an advisory: never "Found".
    for (const [outcome, phase] of [
      [undefined, "running"],
      [undefined, "stopped"],
      [
        { status: "not_checked", reason: "unavailable", message: "NPI Registry is unavailable" },
        "done",
      ],
      [{ status: "not_checked", reason: "stopped", message: "The checks were stopped" }, "stopped"],
      [checked(NOT_FOUND), "done"],
      [checked(ORG_RECORD), "done"],
      [checked(INACTIVE), "done"],
      [checked(NAME_DIFFERS), "done"],
    ] as const) {
      const result = importNpiRowResult(outcome, item(), phase);
      expect(result.notes.some((note) => note.title === "Found in the NPI Registry")).toBe(false);
      expect(result.notes.some((note) => note.tone === "ok")).toBe(false);
    }
  });

  it('never says "Found" for a hidden difference, or for a record with no name to compare', () => {
    const hidden = resolveNpiRegistryPolicy(null, {
      display: { credentialsDiffer: "backend_only" },
    });
    expect(
      importNpiRowResult(checked(record({ credential: "OT" })), item(), "done", hidden).notes,
    ).toEqual([]);
    expect(
      importNpiRowResult(checked(record()), item({ firstName: "", lastName: "" }), "done").notes,
    ).toEqual([]);
  });

  it('a "backend_only" answer shows nothing on the row — and never "Found"', () => {
    const hidden = resolveNpiRegistryPolicy(null, {
      display: Object.fromEntries(NPI_REGISTRY_CHECKS.map((check) => [check, "backend_only"])),
    });
    for (const r of [ORG_RECORD, NOT_FOUND, INACTIVE, NAME_DIFFERS, record({ credential: "OT" })]) {
      expect(importNpiRowResult(checked(r), item(), "done", hidden).notes).toEqual([]);
      // Captured for Mission Control all the same.
      const captured = importNpiCaptureAdvisories({
        items: [item()],
        snapshot: {
          phase: "done",
          total: 1,
          done: 1,
          checked: 1,
          results: new Map([[item().npi, checked(r)]]),
          etaMs: null,
        },
        policy: hidden,
        providerIdByLine: new Map([[item().line, "prov-1"]]),
      });
      expect(captured.length).toBeGreaterThan(0);
      expect(captured.every((a) => a.display === "backend_only")).toBe(true);
    }
    // Only the hidden one: the row is quiet, not "Found".
    const nameOnly = resolveNpiRegistryPolicy(null, { display: { nameMismatch: "backend_only" } });
    expect(titles(NAME_DIFFERS, nameOnly)).toEqual([]);
    expect(titles(ORG_RECORD, nameOnly)).toEqual(["This NPI belongs to an organization"]);
  });

  it("says when a row was not checked", () => {
    expect(importNpiRowResult(undefined, item(), "running").notes).toEqual([
      { tone: "neutral", title: "Not checked yet", detail: null },
    ]);
    expect(importNpiRowResult(undefined, item(), "stopped")).toMatchObject({
      notes: [{ title: "Not checked" }],
    });
    expect(
      importNpiRowResult(
        { status: "not_checked", reason: "unavailable", message: "NPI Registry is unavailable" },
        item(),
        "done",
      ).notes,
    ).toEqual([{ tone: "warn", title: "Not checked", detail: "NPI Registry is unavailable." }]);
    expect(
      importNpiRowResult(
        { status: "not_checked", reason: "stopped", message: "The checks were stopped" },
        item(),
        "stopped",
      ).notes,
    ).toEqual([{ tone: "neutral", title: "Not checked", detail: "The checks were stopped." }]);
  });
});

describe("every row commits, whatever the registry says (A30, A39–A41)", () => {
  it("rows with each registry answer stay creates in the commit plan, and the error report holds no registry data", () => {
    const answers: Array<NpiRegistryRecord | null> = [
      record(),
      ORG_RECORD,
      NOT_FOUND,
      INACTIVE,
      NAME_DIFFERS,
      record({ credential: "OT" }),
    ];
    // Six people the file names alike (each with an NPI of their own), as PTs.
    const rows: StagedImportRow[] = answers.map((_, i) => {
      const base = row(i + 2, "Avery", "Quill", fakeNpi(300 + i));
      return { ...base, mapped: { ...base.mapped, credentials: "PT" } };
    });
    const dispositions = dedupeImportRows(inputs({ rows }));
    const items = selectImportNpiChecks(dispositions);
    const results = new Map<string, ImportNpiOutcome>(
      items.map((i, index) => [i.npi, { status: "checked", record: answers[index] }]),
    );
    const snap: ImportNpiSnapshot = {
      phase: "done",
      total: items.length,
      done: items.length,
      checked: items.length,
      results,
      etaMs: null,
    };
    const summary = summarizeImportNpiRows(
      items,
      snap,
      DEFAULT_NPI_REGISTRY_POLICY,
      importCommittedLines(dispositions, {}),
    );
    // Five rows list an advisory; the full match says "Found".
    expect(summary.counts).toEqual({ notes: 5 });
    expect(summary.byLine.get(2)?.notes).toEqual([
      { tone: "ok", title: "Found in the NPI Registry", detail: null },
    ]);
    // The review's counts and the commit plan are the dedupe's, untouched.
    expect(summarizeImportPreview(dispositions, {}, 0).createProviders).toBe(6);
    const plan = buildCommitPlan(dispositions, {});
    expect(plan.creates.map((c) => c.line)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(plan.blocked_entries).toEqual([]);
    expect(JSON.stringify(plan)).not.toMatch(/NPI Registry|registry/i);
  });

  it("counts as unchecked only rows the commit would write: creates, and updates with every conflict resolved", () => {
    const rows: StagedImportRow[] = [
      row(2, "Avery", "Quill", fakeNpi(410)),
      // Same NPI as an existing provider, under another name: a name conflict.
      row(3, "Renamed", "Person", fakeNpi(411)),
    ];
    const dispositions = dedupeImportRows(
      inputs({
        rows,
        providers: [
          {
            id: "p9",
            firstName: "Original",
            lastName: "Person",
            npi: fakeNpi(411),
            specialty: null,
          },
        ],
      }),
    );
    expect(dispositions.map((d) => d.kind)).toEqual(["create", "update"]);
    const items = selectImportNpiChecks(dispositions, { scope: "all_rows", rows });
    const none: ImportNpiSnapshot = {
      phase: "stopped",
      total: 2,
      done: 0,
      checked: 0,
      results: new Map(),
      etaMs: null,
    };
    // The name conflict is unresolved: the update is not committed, not counted.
    const unresolved = importCommittedLines(dispositions, {});
    expect([...unresolved]).toEqual([2]);
    expect(
      summarizeImportNpiRows(items, none, DEFAULT_NPI_REGISTRY_POLICY, unresolved).unchecked,
    ).toBe(1);
    // Resolved either way, it is committed and counted.
    const resolved = importCommittedLines(dispositions, { p9: { name: "existing" } });
    expect([...resolved].sort()).toEqual([2, 3]);
    expect(
      summarizeImportNpiRows(items, none, DEFAULT_NPI_REGISTRY_POLICY, resolved).unchecked,
    ).toBe(2);
  });

  it("unchecked rows commit too, and the count to warn about is committed rows only", () => {
    const items = [
      item({ npi: fakeNpi(400), line: 2, disposition: "create" }),
      item({ npi: fakeNpi(401), line: 3, disposition: "update" }),
      item({ npi: fakeNpi(402), line: 4, disposition: "skip" }),
    ];
    // A skip writes nothing, so it is never among the committed lines.
    const committed = new Set([2, 3]);
    const stopped: ImportNpiSnapshot = {
      phase: "stopped",
      total: 3,
      done: 0,
      checked: 0,
      results: new Map(),
      etaMs: null,
    };
    expect(
      summarizeImportNpiRows(items, stopped, DEFAULT_NPI_REGISTRY_POLICY, committed).unchecked,
    ).toBe(2);
  });
});

describe("importCommitProviderIds", () => {
  const plan = {
    creates: [{ line: 2 }, { line: 5 }] as never,
    updates: [{ line: 9, provider_id: "p-upd" }] as never,
  };

  it("pairs creates by plan order and updates by their provider", () => {
    expect(importCommitProviderIds(plan, { createdProviderIds: ["p-a", "p-b"] })).toEqual(
      new Map([
        [2, "p-a"],
        [5, "p-b"],
        [9, "p-upd"],
      ]),
    );
  });

  it("attributes no create when the counts disagree — never the wrong provider", () => {
    expect(importCommitProviderIds(plan, { createdProviderIds: ["p-a"] })).toEqual(
      new Map([[9, "p-upd"]]),
    );
  });
});

describe("importNpiCaptureAdvisories — the registry's answers, facts only", () => {
  const items = [
    item({ npi: fakeNpi(500), line: 2, disposition: "create" }),
    item({ npi: fakeNpi(501), line: 3, disposition: "create", firstName: "Blair" }),
    item({ npi: fakeNpi(502), line: 4, disposition: "update" }),
    item({ npi: fakeNpi(503), line: 5, disposition: "create" }),
    item({ npi: fakeNpi(504), line: 6, disposition: "create" }),
    item({ npi: fakeNpi(505), line: 7, disposition: "skip" }),
  ];
  const results = new Map<string, ImportNpiOutcome>([
    [items[0].npi, { status: "checked", record: record({ npi: items[0].npi }) }],
    [items[1].npi, { status: "checked", record: record({ npi: items[1].npi }) }],
    [items[2].npi, { status: "checked", record: null }],
    [
      items[3].npi,
      { status: "not_checked", reason: "unavailable", message: "NPI Registry is unavailable" },
    ],
    [items[5].npi, { status: "checked", record: null }],
  ]);
  const snap: ImportNpiSnapshot = {
    phase: "stopped",
    total: 6,
    done: 5,
    checked: 4,
    results,
    etaMs: null,
  };
  const providerIdByLine = new Map([
    [2, "prov-2"],
    [3, "prov-3"],
    [4, "prov-4"],
    [5, "prov-5"],
    [6, "prov-6"],
    [7, "prov-7"],
  ]);
  const captured = importNpiCaptureAdvisories({
    items,
    snapshot: snap,
    policy: DEFAULT_NPI_REGISTRY_POLICY,
    providerIdByLine,
  });

  it("captures what the registry said about each committed row; rows not checked, skips and full matches add nothing", () => {
    expect(captured.map((a) => [a.record.id, a.check])).toEqual([
      ["prov-3", "npi_registry.name_mismatch"],
      ["prov-4", "npi_registry.not_found"],
    ]);
  });

  it("carries facts only: the check key and the provider — no value, name or registry data", () => {
    for (const advisory of captured) {
      expect(Object.keys(advisory).sort()).toEqual(
        ["check", "context", "display", "record", "whyItMatters"].sort(),
      );
      expect(advisory.record).toEqual({
        table: "providers",
        id: expect.stringMatching(/^prov-/),
        field: expect.any(String),
      });
      expect(advisory.context).toEqual({ confirmed: false });
    }
    const text = JSON.stringify(captured);
    for (const leaked of [
      "Blair",
      "Avery",
      "Quill",
      "AVERY",
      "QUILL",
      "DENVER",
      "PT",
      fakeNpi(501),
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("captures nothing for a row whose provider is unknown", () => {
    expect(
      importNpiCaptureAdvisories({
        items,
        snapshot: snap,
        policy: DEFAULT_NPI_REGISTRY_POLICY,
        providerIdByLine: new Map(),
      }),
    ).toEqual([]);
  });
});

describe("estimateRemainingMs", () => {
  it("shows nothing until enough rows are done to trust the rate", () => {
    expect(
      estimateRemainingMs({ done: ETA_MIN_DONE - 1, total: 100, elapsedMs: 5_000 }),
    ).toBeNull();
    expect(estimateRemainingMs({ done: 30, total: 100, elapsedMs: 0 })).toBeNull();
    expect(estimateRemainingMs({ done: 100, total: 100, elapsedMs: 90_000 })).toBeNull();
  });

  it("past 60 rows, waits for the minute the last row can go in, however fast the registry is", () => {
    // 100 rows: the last 40 go in the second minute.
    expect(estimateRemainingMs({ done: 20, total: 100, elapsedMs: 1_000 })).toBe(59_000);
    // The first 60 done in 3 s: still the rest of the minute to wait.
    expect(estimateRemainingMs({ done: 60, total: 100, elapsedMs: 3_000 })).toBe(57_000);
    // 200 rows: the last ones go in the fourth minute.
    expect(estimateRemainingMs({ done: 20, total: 200, elapsedMs: 1_000 })).toBe(179_000);
  });

  it("leaves the time spent waiting out the budget out of the pace", () => {
    // 70 done at 61 s, 53 s of it waiting: the last 30 take about 3 s, not 26.
    expect(estimateRemainingMs({ done: 70, total: 100, elapsedMs: 61_000, waitedMs: 53_000 })).toBe(
      3_429,
    );
  });

  it("uses the pace so far when the registry is slower than the budget", () => {
    // 20 rows in 20 s is one a second: 80 more take 80 s, past the minute.
    expect(estimateRemainingMs({ done: 20, total: 100, elapsedMs: 20_000 })).toBe(80_000);
    // Within one minute's budget, pace alone decides.
    expect(estimateRemainingMs({ done: 20, total: 60, elapsedMs: 2_000 })).toBe(4_000);
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

const counts = (notes: number) => ({ notes });

describe("importNpiCommitWarning — Commit never waits (A39)", () => {
  it("says committing stops the checks, and how many rows go in not checked", () => {
    expect(importNpiCommitWarning({ phase: "running", unchecked: 80 })).toBe(
      "NPI Registry checks are still running; committing stops them, and 80 rows go in not checked.",
    );
    expect(importNpiCommitWarning({ phase: "running", unchecked: 0 })).toBe(
      "NPI Registry checks are still running; committing stops them.",
    );
  });

  it("keeps saying so once the checks stopped — after a failed commit too", () => {
    expect(importNpiCommitWarning({ phase: "stopped", unchecked: 1 })).toBe(
      "1 row goes in not checked against the NPI Registry.",
    );
    expect(importNpiCommitWarning({ phase: "done", unchecked: 4 })).toBe(
      "4 rows go in not checked against the NPI Registry.",
    );
    expect(importNpiCommitWarning({ phase: "done", unchecked: 0 })).toBeNull();
  });
});

describe("progress words", () => {
  it("shows rows done of rows total while running, never calling an unchecked row checked", () => {
    expect(importNpiStatusText(snapshot({ done: 40, checked: 40 }), counts(2))).toBe(
      "40 of 100 done",
    );
    // Batch 2 was an outage: 20 done, but only 10 of them checked.
    const outage = new Map<string, ImportNpiOutcome>(
      Array.from({ length: 10 }, (_, i) => [
        `n${i}`,
        { status: "not_checked", reason: "unavailable", message: "NPI Registry is unavailable" },
      ]),
    );
    const afterOutage = snapshot({ total: 40, done: 20, checked: 10, results: outage });
    expect(importNpiStatusText(afterOutage, counts(0))).toBe("20 of 40 done, 10 not checked");
    expect(importNpiProgressText(afterOutage)).toBe("20 of 40 done, 10 not checked");
    // Rows Stop left are neither done nor counted as not checked here.
    const stopped = new Map<string, ImportNpiOutcome>([
      ["s", { status: "not_checked", reason: "stopped", message: "The checks were stopped" }],
    ]);
    expect(importNpiProgressText(snapshot({ done: 5, checked: 5, results: stopped }))).toBe(
      "5 of 100 done",
    );
    expect(importNpiStatusText(snapshot({ phase: "idle", total: 1 }), counts(0))).toBe(
      "1 NPI to check",
    );
  });

  it("has a completion state that says what was found and not checked", () => {
    expect(
      importNpiStatusText(snapshot({ phase: "done", done: 100, checked: 100 }), counts(3)),
    ).toBe("Finished — 100 of 100 checked, 3 with notes.");
    const results = new Map<string, ImportNpiOutcome>([
      [
        "a",
        { status: "not_checked", reason: "unavailable", message: "NPI Registry is unavailable" },
      ],
      [
        "b",
        { status: "not_checked", reason: "unavailable", message: "NPI Registry is unavailable" },
      ],
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
