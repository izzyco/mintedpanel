// "+ Add state" (GCM-33, MINT-143) on the Group Contracts Matrix: offered to
// writers in each specialty's heading, never to a read-only (billing) user,
// and its dialog says the column is kept with Not started records. The save
// itself is covered by notStartedRecordsForAddedState, saveAddedState (each
// toast, contractsMatrixAddState.test.ts) and createContractsIfMissing, and
// end to end by e2e/contracts-matrix.spec.ts.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const permissions = vi.hoisted(() => ({ canWrite: true }));
const createIfMissing = vi.hoisted(() => vi.fn());

const query = <T,>(data: T) => ({
  data,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
});

vi.mock("@/integrations/supabase/externalClient", () => ({ supabase: {} }));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("./ContractDetailDrawer", () => ({ ContractDetailDrawer: () => null }));

vi.mock("@/hooks/useContracts", () => ({
  useContracts: () =>
    query([
      {
        id: "c-1",
        orgId: "org-1",
        groupId: "g-1",
        payerId: "p-1",
        state: "KS",
        specialtyKey: "pt",
        contractingStatusId: "s-in-network",
        effectiveDate: null,
        tentativeEffectiveDate: null,
        expirationDate: null,
        notes: null,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ]),
  useCreateContractsIfMissing: () => ({ mutateAsync: createIfMissing, isPending: false }),
}));

vi.mock("@/hooks/useAdmin", () => ({
  usePayers: () => query([{ id: "p-1", name: "Payer 1", states: ["KS", "LA"] }]),
  useStatusConfigs: () =>
    query([
      { id: "s-not-started", label: "Not Started" },
      { id: "s-in-network", label: "In-Network" },
    ]),
}));

vi.mock("@/hooks/useEnrollmentReadiness", () => ({
  localTodayIso: () => "2026-11-01",
  useProviderReadinessFacts: () => query([]),
}));

vi.mock("@/hooks/useLookups", () => ({
  useFacilities: () => query([]),
  useOrgStateLicenses: () => query([]),
  useProviderGroups: () =>
    query([{ id: "g-1", name: "Group Name 1", tin: "00-0000001", isActive: true }]),
}));

vi.mock("@/hooks/usePayerNetworkTargets", () => ({
  usePayerNetworkTargets: () => query([]),
}));

vi.mock("@/hooks/useProviders", () => ({
  useProviderAssignments: () => query([]),
  useProviderGroupAssignments: () => query([]),
}));

vi.mock("@/lib/auth-store", () => ({
  useActiveMembership: () => ({ orgId: "org-1", orgName: "Acme Health", role: "admin" }),
  useActiveOrgId: () => "org-1",
}));

vi.mock("@/lib/permissions", () => ({
  useCanWrite: () => permissions.canWrite,
}));

vi.mock("@/services/contracts", () => ({
  ContractFollowUpWriteError: class ContractFollowUpWriteError extends Error {},
}));

import { AddStateDialog } from "./ContractsMatrixAddDialogs";
import { GroupContractsMatrix } from "./GroupContractsMatrix";

const TABLE_CELL = "Payer 1, Physical therapy, Group Name 1, KS: In-Network";

describe("+ Add state on the contracts matrix (GCM-33)", () => {
  beforeEach(() => {
    permissions.canWrite = true;
    createIfMissing.mockReset();
  });

  it("offers a writer + Add state in the specialty's heading", () => {
    const html = renderToStaticMarkup(<GroupContractsMatrix />);
    expect(html).toContain(TABLE_CELL);
    expect(html).toContain("+ Add state");
    expect(html).toContain("+ Add payer");
  });

  it("gives a read-only user no + Add state (or + Add payer), and saves nothing", () => {
    permissions.canWrite = false;
    const html = renderToStaticMarkup(<GroupContractsMatrix />);
    // The table renders; only the add affordances are gone.
    expect(html).toContain(TABLE_CELL);
    expect(html).not.toContain("+ Add state");
    expect(html).not.toContain("+ Add payer");
    expect(createIfMissing).not.toHaveBeenCalled();
  });

  it("leaves payer cells blank by default, with an optional Not started initialization", () => {
    const countFor = vi.fn(() => 12);
    const html = renderToStaticMarkup(
      <AddStateDialog
        specialtyLabel="Nutrition"
        groups={[{ id: "g-1", name: "Group Name 1" }]}
        countFor={countFor}
        onAdd={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain("Add a Nutrition state");
    expect(html).toContain(
      "Adds a Nutrition column for a group and state before any Nutrition provider works there, so contracting can start early. Payer cells remain blank (no contract record) by default.",
    );
    expect(html).toContain("Initialize payer work as Not started");
    // No state chosen yet: no count to show, and nothing computed.
    expect(html).toContain(">Add column<");
    expect(countFor).not.toHaveBeenCalled();
    expect(html).not.toMatch(/Are you sure|Confirm/);
  });
});
