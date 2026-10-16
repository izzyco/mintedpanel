import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, PropsWithChildren } from "react";
import type { Portal, PortalFieldMap } from "@/types";
import type { RegistryDecision } from "./FieldRegistryList";
import type { RegistryRow } from "@/lib/fieldRegistry";

// decideRegistry routes a Leave blank decision by tier: shared rows go through
// the global training RPC with {approved, leave_blank}; org rows go through
// the org writer (markFieldMapLeaveBlank, behind useLeaveBlankField). The
// FieldRegistryList mock hands back the onDecide closure so the test can call
// it after a static render.
const state = vi.hoisted(() => ({
  maps: [] as unknown[],
  portals: [] as unknown[],
  onDecide: null as null | ((row: RegistryRow, decision: RegistryDecision) => Promise<void>),
  leaveBlank: vi.fn().mockResolvedValue(undefined),
  trainGlobal: vi.fn().mockResolvedValue(undefined),
  manual: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/integrations/supabase/externalClient", () => ({ supabase: {} }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-router", () => ({ useLocation: () => ({ pathname: "/templates/edit" }) }));
vi.mock("@/lib/auth-store", () => ({ useActiveOrgId: () => "org-1" }));
vi.mock("@/hooks/usePortals", () => {
  const mutation = () => ({ isPending: false, mutateAsync: vi.fn().mockResolvedValue(undefined) });
  return {
    usePortals: () => ({ data: state.portals }),
    usePortalFieldMaps: () => ({ data: state.maps }),
    usePortalMappingResetPreview: () => ({ data: 0, isLoading: false, isError: false }),
    useResetPortalMapping: mutation,
    useStaleOrgOverridesForReview: () => ({ data: [] }),
    useReviewOrgPortalFieldMapBase: mutation,
    useCreatePortal: mutation,
  };
});
vi.mock("@/hooks/useAdmin", () => ({
  useSops: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("@/hooks/useMappingReview", () => {
  const mutation = () => ({ isPending: false, mutateAsync: vi.fn().mockResolvedValue(undefined) });
  return {
    useApproveField: mutation,
    useFinishTraining: mutation,
    useManualField: () => ({ isPending: false, mutateAsync: state.manual }),
    useLeaveBlankField: () => ({ isPending: false, mutateAsync: state.leaveBlank }),
    useTokenCatalog: () => ({ data: [] }),
    useReproposeField: mutation,
    useSetFieldMapHardcoded: mutation,
    useSetFieldMapTransform: mutation,
    useUpdateSharedFieldRegistry: mutation,
    useAddSharedRegistryField: mutation,
  };
});
vi.mock("@/hooks/useGlobalAuthoring", () => {
  const mutation = () => ({ isPending: false, mutateAsync: vi.fn().mockResolvedValue(undefined) });
  return {
    useSetGlobalPortalFlags: mutation,
    useTrainGlobalFieldMap: () => ({ isPending: false, mutateAsync: state.trainGlobal }),
  };
});
vi.mock("@/hooks/useFormDrift", () => ({ useFormDrift: () => ({ driftByPortal: new Map() }) }));
vi.mock("@/components/PortalDrawer", () => ({ PortalDrawer: () => null }));
vi.mock("@/components/templates/FieldRegistryList", () => ({
  FieldRegistryList: (props: {
    onDecide: (row: RegistryRow, decision: RegistryDecision) => Promise<void>;
  }) => {
    state.onDecide = props.onDecide;
    return null;
  },
}));
vi.mock("@/components/StatusPill", () => ({
  StatusPill: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled, onClick }: ComponentProps<"button">) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: PropsWithChildren) => <div>{children}</div>,
  CollapsibleContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));
vi.mock("lucide-react", () => ({ CheckCircle2: () => null, ChevronDown: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { FormStepPanel } from "./FormStepPanel";

function map(overrides: Partial<PortalFieldMap>): PortalFieldMap {
  return {
    id: "shared-map",
    orgId: null,
    portalKey: "bcbs-enrollment",
    urlPattern: null,
    pageStep: null,
    mapType: "web",
    selector: "#middle",
    selectorFallbacks: null,
    source: "token",
    token: "provider.middleName",
    hardcodedValue: null,
    transform: null,
    fieldType: "text",
    notes: null,
    status: "approved",
    fieldLabel: "Middle name",
    formSection: null,
    confidence: null,
    mappingGeneration: 2,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

// The registry list mounts only once the step resolves a portal, so the
// shared configuration for the key is always present.
const SHARED_PORTAL: Portal = {
  id: "shared-config",
  orgId: null,
  portalKey: "bcbs-enrollment",
  name: "BCBS Enrollment",
  payerId: "payer-1",
  formUrl: "https://payer.example/form",
  caseType: "enrollment",
  requiresExplicitSelection: true,
  mappingGeneration: 2,
  isVerified: false,
  lastVerifiedAt: null,
  provenAt: null,
  urlChangedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

function renderPanel() {
  renderToStaticMarkup(
    <FormStepPanel
      portalKey="bcbs-enrollment"
      templatePayerId="payer-1"
      templateCaseType="enrollment"
      canEdit
      isGlobalAuthoring={false}
      defaultOpen
    />,
  );
  const decide = state.onDecide;
  if (!decide) throw new Error("FieldRegistryList did not mount");
  return decide;
}

beforeEach(() => {
  state.onDecide = null;
  state.portals = [SHARED_PORTAL];
  state.leaveBlank.mockClear();
  state.trainGlobal.mockClear();
  state.manual.mockClear();
});

describe("FormStepPanel decideRegistry — Leave blank", () => {
  it("sends {approved, leave_blank} through the global trainer for a shared row", async () => {
    const shared = map({ id: "shared-map", orgId: null });
    state.maps = [shared];
    const decide = renderPanel();

    await decide(shared as unknown as RegistryRow, { kind: "leave_blank" });

    expect(state.trainGlobal).toHaveBeenCalledTimes(1);
    expect(state.trainGlobal).toHaveBeenCalledWith({
      id: "shared-map",
      patch: { status: "approved", source: "leave_blank", expectedMappingGeneration: 2 },
    });
    expect(state.leaveBlank).not.toHaveBeenCalled();
    expect(state.manual).not.toHaveBeenCalled();
  });

  it("calls the org leave-blank writer, never the manual one, for an org row", async () => {
    const org = map({ id: "org-map", orgId: "org-1", mappingGeneration: 3 });
    state.maps = [org];
    const decide = renderPanel();

    await decide(org as unknown as RegistryRow, { kind: "leave_blank" });

    expect(state.leaveBlank).toHaveBeenCalledTimes(1);
    expect(state.leaveBlank).toHaveBeenCalledWith({
      id: "org-map",
      fieldLabel: "Middle name",
      expectedMappingGeneration: 3,
    });
    expect(state.trainGlobal).not.toHaveBeenCalled();
    expect(state.manual).not.toHaveBeenCalled();
  });
});
