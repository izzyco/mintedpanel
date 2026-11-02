// MINT-110 PR 2 / MINT-134 — the import commit hands its NPI advisories to the
// capture: the run's id, and a builder over the plan it committed and the
// providers the commit returned. Rendered statically with the confirm step
// open (no DOM here): the "Yes, commit changes" handler is taken from the
// button and run, and the commit mutation's onSuccess is driven by hand. No
// network; the capture itself is mocked.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCommitPlan,
  dedupeImportRows,
  type CommitPlan,
  type StagedImportRow,
} from "@/lib/importDedupe";
import {
  importCommitProviderIds,
  importNpiCaptureAdvisories,
  selectImportNpiChecks,
  type ImportNpiSnapshot,
} from "@/lib/importNpiVerification";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import { DEFAULT_NPI_REGISTRY_POLICY } from "@/lib/npiRegistryPolicy";
import { NPI_FORMAT_MESSAGE, npiCheckDigit } from "@/lib/providerIdentity";

const state = vi.hoisted(() => ({
  preview: {} as Record<string, unknown>,
  snapshot: null as unknown,
  confirm: null as null | (() => void),
}));
const commitMutate = vi.hoisted(() => vi.fn());

// The confirm step opens on Commit Changes; with no DOM to click, every
// boolean state starts true, so it renders open (the drill-downs open too).
vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => actual.useState(initial === false ? true : initial),
  };
});
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => {
    if (children === "Yes, commit changes") state.confirm = onClick ?? null;
    return <button type="button">{children}</button>;
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/hooks/useImportRuns", () => ({
  useImportPreview: () => state.preview,
  useCommitImportRun: () => ({ isPending: false, mutate: commitMutate }),
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
vi.mock("@/lib/permissions", () => ({ useIsAdmin: () => true }));
vi.mock("@/hooks/useNpiRegistry", () => ({
  useNpiRegistryPolicy: () => DEFAULT_NPI_REGISTRY_POLICY,
}));
vi.mock("@/services/importNpiAdvisoryCapture", () => ({
  captureImportNpiAdvisories: vi.fn(),
}));
vi.mock("@/hooks/useImportNpiVerification", () => ({
  useImportNpiVerification: () => ({
    snapshot: state.snapshot,
    stop: vi.fn(),
    read: () => state.snapshot,
  }),
}));

import { captureImportNpiAdvisories } from "@/services/importNpiAdvisoryCapture";
import { ImportPreviewContent } from "./ImportPreviewContent";

function fakeNpi(n: number): string {
  const first9 = `1${String(n).padStart(8, "0")}`;
  return `${first9}${npiCheckDigit(first9)}`;
}

const NEW_A = fakeNpi(1);

// Line 2: a new provider with an NPI. Line 3: a new provider with none (B3).
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
      npi: null,
      group_tin: "111111111",
    },
  },
];

const dispositions = dedupeImportRows({
  rows,
  providers: [],
  groups: [{ id: "g1", name: "North Group", tin: "111111111" }],
  facilities: [],
  groupAssignments: [],
  facilityAssignments: [],
  licenses: [],
});

// The registry answered for line 2: an organization's number.
const orgRecord: NpiRegistryRecord = {
  npi: NEW_A,
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
const snapshot: ImportNpiSnapshot = {
  phase: "done",
  total: 1,
  done: 1,
  checked: 1,
  results: new Map([[NEW_A, { status: "checked", record: orgRecord }]]),
  etaMs: null,
};

const committed = {
  alreadyCommitted: false,
  created: 2,
  updated: 0,
  createdProviderIds: ["p-avery", "p-blair"],
  updatedProviderIds: [],
  relationships: { facilityAssignments: 0, groupAssignments: 0, enrollmentFacts: 0 },
};

type CommitOptions = { onSuccess: (result: typeof committed) => void };

beforeEach(() => {
  state.confirm = null;
  state.snapshot = snapshot;
  state.preview = {
    run: {
      id: "run-7",
      state: "ready_for_review",
      totalRows: 3,
      stagedRows: 2,
      errorRows: 1,
      // A scan error for a malformed NPI: held back, so it records nothing.
      errorReport: [{ line: 4, column: "npi", reason: NPI_FORMAT_MESSAGE }],
    },
    rows,
    dispositions,
    isLoading: false,
    isError: false,
    settled: true,
  };
  commitMutate.mockClear();
  vi.mocked(captureImportNpiAdvisories).mockClear();
});

function commit(): { plan: CommitPlan; options: CommitOptions } {
  renderToStaticMarkup(<ImportPreviewContent runId="run-7" />);
  expect(state.confirm).toBeTypeOf("function");
  state.confirm?.();
  expect(commitMutate).toHaveBeenCalledTimes(1);
  const [variables, options] = commitMutate.mock.calls[0] as [
    { runId: string; plan: CommitPlan },
    CommitOptions,
  ];
  expect(variables.runId).toBe("run-7");
  return { plan: variables.plan, options };
}

describe("ImportPreviewContent's commit hands its NPI advisories to the capture", () => {
  it("passes the run id, and a builder over the committed plan and the created providers", () => {
    const { plan, options } = commit();
    expect(plan).toEqual(buildCommitPlan(dispositions, {}));
    expect(captureImportNpiAdvisories).not.toHaveBeenCalled();

    options.onSuccess(committed);
    expect(captureImportNpiAdvisories).toHaveBeenCalledTimes(1);
    const [runId, build] = vi.mocked(captureImportNpiAdvisories).mock.calls[0];
    expect(runId).toBe("run-7");

    const built = build();
    const providerIdByLine = importCommitProviderIds(plan, committed);
    expect(built.registry).toEqual(
      importNpiCaptureAdvisories({
        items: selectImportNpiChecks(dispositions, { rows }),
        snapshot,
        policy: DEFAULT_NPI_REGISTRY_POLICY,
        providerIdByLine,
      }),
    );
    expect(built.registry).toMatchObject([
      {
        line: 2,
        advisories: [
          {
            check: "npi_registry.organization_number",
            record: { table: "providers", id: "p-avery" },
          },
        ],
      },
    ]);
    // The blank-NPI create, on the provider the commit returned for it; the
    // scan row held back for its NPI adds nothing.
    expect(built.rows).toEqual([
      { check: "import.npi_missing", record: { table: "providers", id: "p-blair" }, line: 3 },
    ]);
  });

  it("hands nothing over when the run was already committed", () => {
    const { options } = commit();
    options.onSuccess({ ...committed, alreadyCommitted: true });
    expect(captureImportNpiAdvisories).not.toHaveBeenCalled();
  });
});
