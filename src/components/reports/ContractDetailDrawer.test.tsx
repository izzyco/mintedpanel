import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Contract } from "@/types";

vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: {},
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="dialog-content" className={className}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/hooks/useContracts", () => ({
  useUpsertContract: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/useAdmin", () => ({
  useStatusConfigs: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/lib/auth-store", () => ({
  useActiveOrgId: () => "mock-org-id",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [], isPending: false, isError: false }),
}));

vi.mock("@/components/reports/ContractSopAssignmentPanel", () => ({
  ContractSopAssignmentPanel: () => <div data-testid="mock-sop-panel">Contract SOP Panel</div>,
}));

import { ContractDetailDrawer } from "./ContractDetailDrawer";

describe("ContractDetailDrawer", () => {
  it("renders with max-h-[90vh] and overflow-y-auto to enable scrolling when content overflows", () => {
    const html = renderToStaticMarkup(
      <ContractDetailDrawer
        open={true}
        onClose={vi.fn()}
        contract={
          {
            id: "contract-1",
            groupId: "group-1",
            payerId: "payer-1",
            state: "CO",
          } as Contract
        }
        groupId="group-1"
        payerId="payer-1"
        state="CO"
        groupName="Colorado Fitness Physio, PLLC"
        payerName="Aetna"
      />,
    );

    expect(html).toContain("max-h-[90vh]");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("Aetna — CO");
    expect(html).toContain("Save Contract");
  });
});
