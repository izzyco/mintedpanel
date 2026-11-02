// MINT-91: a warning in a run's report (a value left out of a created record)
// is not a row that failed to stage, so the ready run's card doesn't count it.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ImportRun, ImportRunErrorEntry } from "@/types";

const state = vi.hoisted(() => ({ report: [] as ImportRunErrorEntry[] }));

vi.mock("@/hooks/useImportRuns", () => ({
  useImportRun: () => ({
    isLoading: false,
    data: {
      id: "run-1",
      orgId: "org-1",
      createdBy: "user-1",
      source: "internal",
      entityKind: "provider_group",
      fileName: "groups.csv",
      state: "ready_for_review",
      totalRows: 3,
      stagedRows: 3,
      errorRows: 0,
      errorReport: state.report,
      committedAt: null,
      createdProviderIds: null,
      updatedProviderIds: null,
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
    } satisfies ImportRun,
  }),
  useCancelImportRun: () => ({ mutate: vi.fn(), isPending: false }),
  isScanDrivenHere: () => false,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import { ImportRunPanel } from "./ImportRunPanel";

const WARNING: ImportRunErrorEntry = {
  line: 2,
  column: "billing_phone",
  reason: "Warning: Billing phone isn't a US number, so it was left blank.",
  severity: "warning",
};

describe("ImportRunPanel — warnings are not unstaged rows", () => {
  it("doesn't count a warning as a row that could not be staged", () => {
    state.report = [WARNING];
    const html = renderToStaticMarkup(<ImportRunPanel runId="run-1" variant="internal" />);
    expect(html).not.toContain("could not be staged");
    expect(html).toContain("Download error report");
  });

  it("still counts the real staging errors beside a warning", () => {
    state.report = [WARNING, { line: 5, column: "group_tin", reason: "group_tin is required" }];
    const html = renderToStaticMarkup(<ImportRunPanel runId="run-1" variant="internal" />);
    expect(html).toContain("1 row");
    expect(html).toContain("could not be staged");
  });
});
