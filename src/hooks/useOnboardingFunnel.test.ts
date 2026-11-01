// useOnboardingFunnel wires the read to the report: rows from the funnel,
// under the configuration that came with the read, and the stages to show
// from it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ONBOARDING_FUNNEL_CONFIG,
  resolveOnboardingFunnelConfig,
  type OnboardingFunnelRead,
} from "@/lib/onboardingFunnel";

const holder = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: holder.data, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/lib/auth-store", () => ({ useActiveOrgId: () => "org-1" }));
vi.mock("@/hooks/useEnrollmentReadiness", () => ({ localTodayIso: () => "2026-10-20" }));
vi.mock("@/services/onboardingFunnel", () => ({ getOnboardingFunnelInput: vi.fn() }));

import { useOnboardingFunnel } from "@/hooks/useOnboardingFunnel";

function data(): OnboardingFunnelRead {
  return {
    providers: [
      {
        providerId: "p-1",
        name: "Ann Example",
        npi: "1234567893",
        caqhIdPresent: true,
        caqhLastAttestedDate: "2026-09-01",
        dobPresent: true,
        ssnLast4Present: true,
        pendingVerification: false,
      },
    ],
    licenses: [
      { providerId: "p-1", state: "NC", verifiedStatus: "verified", expirationDate: "2027-06-30" },
    ],
    locations: [],
    groupMemberships: [],
    cases: [],
    config: DEFAULT_ONBOARDING_FUNNEL_CONFIG,
  };
}

beforeEach(() => {
  holder.data = undefined;
});

describe("useOnboardingFunnel", () => {
  it("shows the five stages and the rows from the read", () => {
    holder.data = data();
    const result = useOnboardingFunnel();
    expect(result.stages.map((s) => s.key)).toEqual([
      "profile_incomplete",
      "submitted",
      "verified_awaiting_assignment",
      "ready_for_credentialing",
      "credentialing",
    ]);
    expect(result.rows).toMatchObject([
      {
        providerId: "p-1",
        stage: "verified_awaiting_assignment",
        gaps: ["Needs a location", "No group assigned yet"],
      },
    ]);
  });

  it("builds the rows under the configuration that came with the read", () => {
    const read = data();
    read.cases = [{ providerId: "p-1", state: "NC", status: "not_pursuing" }];
    holder.data = read;
    expect(useOnboardingFunnel().rows?.[0].stage).toBe("credentialing");
    holder.data = {
      ...read,
      config: resolveOnboardingFunnelConfig(
        null,
        { rules: { caseStatusesNotCountedAsCredentialing: ["not_pursuing"] } },
        120,
      ),
    };
    expect(useOnboardingFunnel().rows?.[0].stage).toBe("verified_awaiting_assignment");
  });

  it("shows the default stages while the read is still loading", () => {
    const result = useOnboardingFunnel();
    expect(result.rows).toBeUndefined();
    expect(result.stages).toEqual(DEFAULT_ONBOARDING_FUNNEL_CONFIG.stages);
  });
});
