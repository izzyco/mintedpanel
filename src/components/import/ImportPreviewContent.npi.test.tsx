// MINT-110 PR 2 — the import review with NPI Registry checks, hooks mocked:
// which rows are handed to the checker (both scopes), that the default policy
// leaves the review's counts unchanged, and that a "block" severity moves the
// row to Blocked rows so it is not committed. Rendered statically; no network.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dedupeImportRows, type StagedImportRow } from "@/lib/importDedupe";
import type { ImportNpiOutcome, ImportNpiSnapshot } from "@/lib/importNpiVerification";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import { npiCheckDigit } from "@/lib/providerIdentity";

const state = vi.hoisted(() => ({
  preview: {} as Record<string, unknown>,
  snapshot: null as unknown,
  admin: true,
}));

vi.mock("@/hooks/useImportRuns", () => ({
  useImportPreview: () => state.preview,
  useCommitImportRun: () => ({ isPending: false, mutate: vi.fn() }),
  useCancelImportRun: () => ({ isPending: false, mutate: vi.fn() }),
  useImportRun: () => ({}),
  isScanDrivenHere: () => false,
  useApplyBatchAssignment: () => ({ isPending: false, mutate: vi.fn() }),
  useProviderAssignmentsForRun: () => ({ groupAssignments: [], facilityAssignments: [] }),
}));
vi.mock("@/hooks/useLookups", () => ({
  useFacilities: () => ({ data: [] }),
  useProviderGroups: () => ({ data: [] }),
}));
vi.mock("@/lib/permissions", () => ({ useIsAdmin: () => state.admin }));
vi.mock("@/hooks/useImportNpiVerification", () => ({
  useImportNpiVerification: vi.fn(() => ({ snapshot: state.snapshot, stop: vi.fn() })),
}));

import { useImportNpiVerification } from "@/hooks/useImportNpiVerification";
import { ImportPreviewContent } from "./ImportPreviewContent";

function fakeNpi(n: number): string {
  const first9 = `1${String(n).padStart(8, "0")}`;
  return `${first9}${npiCheckDigit(first9)}`;
}

const NEW_A = fakeNpi(1);
const NEW_B = fakeNpi(2);
const EXISTING = fakeNpi(3);

const orgRecord: NpiRegistryRecord = {
  npi: NEW_B,
  enumerationType: "NPI-2",
  firstName: null,
  middleName: null,
  lastName: null,
  organizationName: "QUILL THERAPY LLC",
  credential: null,
  primaryTaxonomy: null,
  practiceCity: null,
  practiceState: null,
  status: "active",
  enumerationDate: null,
  otherNames: [],
};

const rows: StagedImportRow[] = [
  {
    line: 2,
    mapped: {
      provider_first_name: "Avery",
      provider_last_name: "Quill",
      npi: NEW_A,
      group_tin: "111111111",
    },
  },
  {
    line: 3,
    mapped: {
      provider_first_name: "Blair",
      provider_last_name: "Stone",
      npi: NEW_B,
      group_tin: "111111111",
    },
  },
  {
    line: 4,
    mapped: {
      provider_first_name: "Casey",
      provider_last_name: "Orr",
      npi: EXISTING,
      group_tin: "111111111",
    },
  },
];

const dispositions = dedupeImportRows({
  rows,
  providers: [{ id: "p1", firstName: "Casey", lastName: "Orr", npi: EXISTING, specialty: null }],
  groups: [{ id: "g1", name: "North Group", tin: "111111111" }],
  facilities: [],
  groupAssignments: [{ providerId: "p1", groupId: "g1" }],
  facilityAssignments: [],
  licenses: [],
});

function finished(results: Array<[string, ImportNpiOutcome]>): ImportNpiSnapshot {
  return {
    phase: "done",
    total: results.length,
    done: results.length,
    checked: results.filter(([, outcome]) => outcome.status === "checked").length,
    results: new Map(results),
    etaMs: null,
  };
}

function metric(html: string, label: string): string {
  const match = html.match(
    new RegExp(`>(\\d+)</div><div class="text-\\[12px\\] text-muted-foreground">${label}<`),
  );
  return match?.[1] ?? "missing";
}

beforeEach(() => {
  state.admin = true;
  state.preview = {
    run: {
      id: "run-1",
      state: "ready_for_review",
      totalRows: 3,
      stagedRows: 3,
      errorRows: 0,
      errorReport: null,
    },
    rows,
    dispositions,
    isLoading: false,
    isError: false,
  };
  state.snapshot = finished([
    [
      NEW_A,
      {
        status: "checked",
        record: {
          ...orgRecord,
          npi: NEW_A,
          enumerationType: "NPI-1",
          firstName: "AVERY",
          lastName: "QUILL",
          organizationName: null,
        },
      },
    ],
    [NEW_B, { status: "checked", record: orgRecord }],
  ]);
  vi.mocked(useImportNpiVerification).mockClear();
});

describe("ImportPreviewContent with NPI Registry checks", () => {
  it("hands the checker only the new providers by default, while an admin reviews", () => {
    renderToStaticMarkup(<ImportPreviewContent runId="run-1" />);
    const [items, enabled] = vi.mocked(useImportNpiVerification).mock.calls[0];
    expect(items.map((item) => item.npi)).toEqual([NEW_A, NEW_B]);
    expect(enabled).toBe(true);
  });

  it('hands it every row with an NPI when the scope is "all_rows"', () => {
    renderToStaticMarkup(<ImportPreviewContent runId="run-1" npiScope="all_rows" />);
    const [items] = vi.mocked(useImportNpiVerification).mock.calls[0];
    expect(items.map((item) => [item.npi, item.disposition])).toEqual([
      [NEW_A, "create"],
      [NEW_B, "create"],
      [EXISTING, "skip"],
    ]);
  });

  it("does not check for a non-admin or a run that is no longer reviewable", () => {
    state.admin = false;
    const html = renderToStaticMarkup(<ImportPreviewContent runId="run-1" />);
    expect(vi.mocked(useImportNpiVerification).mock.calls[0][1]).toBe(false);
    expect(html).not.toContain("NPI Registry check");
  });

  it("with the default policy an organization number is a note: the counts do not change", () => {
    const html = renderToStaticMarkup(<ImportPreviewContent runId="run-1" />);
    expect(metric(html, "New providers to create")).toBe("2");
    expect(metric(html, "Rows with blocked errors")).toBe("0");
    expect(html).toContain("Finished — 2 of 2 checked, 1 with a note.");
    expect(html).toContain('role="progressbar"');
  });

  it("a block severity holds that row back as a blocked row", () => {
    const html = renderToStaticMarkup(
      <ImportPreviewContent
        runId="run-1"
        npiSeverityFor={(kind) => (kind === "organizationNumber" ? "block" : "warn")}
      />,
    );
    expect(metric(html, "New providers to create")).toBe("1");
    expect(metric(html, "Rows with blocked errors")).toBe("1");
    expect(html).toContain("Blocked rows (1)");
    expect(html).toContain("Finished — 2 of 2 checked, 0 with notes, 1 blocked.");
    expect(html).toContain("Counts reconcile with the 3 staged rows.");
  });
});
