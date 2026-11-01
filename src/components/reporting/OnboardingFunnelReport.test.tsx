import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOnboardingFunnelRows,
  DEFAULT_ONBOARDING_FUNNEL_CONFIG,
  DEFAULT_ONBOARDING_FUNNEL_STAGES,
  resolveOnboardingFunnelConfig,
  visibleOnboardingFunnelStages,
  type OnboardingFunnelInput,
  type OnboardingFunnelConfig,
  type OnboardingFunnelProviderFacts,
  type OnboardingFunnelStageKey,
} from "@/lib/onboardingFunnel";

const state = vi.hoisted(() => ({
  stage: null as string | null,
  config: null as OnboardingFunnelConfig | null,
}));

// The report opens on Profile incomplete; a test can open another stage.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) =>
      actual.useState(initial === "profile_incomplete" && state.stage ? state.stage : initial),
  };
});
vi.mock("@/hooks/useOnboardingFunnel", () => ({
  useOnboardingFunnel: () => ({
    orgId: "org-1",
    rows: buildOnboardingFunnelRows(
      funnelInput(),
      "2026-10-20",
      state.config ?? DEFAULT_ONBOARDING_FUNNEL_CONFIG,
    ),
    stages: visibleOnboardingFunnelStages(state.config ?? DEFAULT_ONBOARDING_FUNNEL_CONFIG),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

import { OnboardingFunnelReport } from "./OnboardingFunnelReport";

const complete = (providerId: string, name: string): OnboardingFunnelProviderFacts => ({
  providerId,
  name,
  npi: "1234567893",
  caqhIdPresent: true,
  caqhLastAttestedDate: "2026-09-01",
  dobPresent: true,
  ssnLast4Present: true,
  pendingVerification: false,
});

function funnelInput(): OnboardingFunnelInput {
  return {
    providers: [
      { ...complete("p-new", "Ann Newhire"), npi: null },
      complete("p-unassigned", "Bea Unassigned"),
      complete("p-ready", "Cal Ready"),
      complete("p-denied", "Dee Enrolling"),
      { ...complete("p-pending", "Eve Pending"), pendingVerification: true },
    ],
    licenses: ["p-new", "p-unassigned", "p-ready", "p-pending"].map((providerId) => ({
      providerId,
      state: "TX",
      verifiedStatus: "verified",
      expirationDate: "2027-06-30",
    })),
    locations: [
      {
        providerId: "p-ready",
        locationId: "f-dallas",
        locationName: "Dallas",
        state: "TX",
        groupId: "g-1",
        groupName: "Rose City Rehab",
        assignmentStartDate: null,
      },
    ],
    groupMemberships: [
      {
        providerId: "p-ready",
        groupId: "g-1",
        groupName: "Rose City Rehab",
        groupActive: true,
        startDate: null,
        endDate: null,
      },
    ],
    // Dee's only case was denied; by default every case counts.
    cases: [{ providerId: "p-denied", state: "TX", status: "denied" }],
  };
}

function render(stage: OnboardingFunnelStageKey | null = null): string {
  state.stage = stage;
  return renderToStaticMarkup(<OnboardingFunnelReport />);
}

/** The stage card titles, in the order they render. */
function cardTitles(html: string): string[] {
  return [...html.matchAll(/Step \d+<\/span><span[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]);
}

beforeEach(() => {
  state.stage = null;
  state.config = null;
});

describe("Provider Onboarding report", () => {
  it("shows the five provider stages in funnel order", () => {
    const html = render();
    expect(cardTitles(html)).toEqual([
      "Profile incomplete",
      "Submitted",
      "Verified, awaiting assignment",
      "Ready for credentialing",
      "Credentialing",
    ]);
    expect(html).not.toContain("Awaiting verification");
    expect(html).not.toContain("Ready to credential<");
    // Five cards: three across on a laptop, five from 1280px.
    expect(html).toContain("lg:grid-cols-3 xl:grid-cols-5");
  });

  it("lists a verified provider with no group or location under Verified, awaiting assignment", () => {
    const html = render("verified_awaiting_assignment");
    expect(html).toContain("Verified, awaiting assignment · 1");
    expect(html).toContain("What&#x27;s needed");
    expect(html).toContain("Bea Unassigned");
    expect(html).toContain("Needs a location");
    expect(html).toContain("No group assigned yet");
    expect(html).not.toContain("Eve Pending");
  });

  it("lists only unverified providers under Submitted, described as complete and not verified", () => {
    const html = render("submitted");
    expect(html).toContain("Submitted · 1");
    expect(html).toContain("Information is complete but not yet verified.");
    expect(html).toContain("Eve Pending");
    expect(html).toContain("Record pending verification");
    expect(html).not.toContain("Bea Unassigned");
  });

  it("keeps Credentialing to one count with no case-status breakdown", () => {
    const html = render("credentialing");
    expect(html).toContain("Credentialing · 1");
    expect(html).toContain("Dee Enrolling");
    expect(html).not.toContain("What&#x27;s needed");
    expect(html).not.toMatch(/denied|approved|withdrawn|case status/i);
  });

  it("renders an organization's labels and descriptions", () => {
    state.config = resolveOnboardingFunnelConfig(
      null,
      {
        stageText: {
          ready_for_credentialing: {
            label: "Ready to start",
            description: "Ready for payer work.",
          },
          credentialing: { label: "With payers", description: "Has a case." },
        },
      },
      120,
    );
    const html = render();
    expect(cardTitles(html)).toEqual([
      "Profile incomplete",
      "Submitted",
      "Verified, awaiting assignment",
      "Ready to start",
      "With payers",
    ]);
    expect(html).toContain("Ready for payer work.");
    expect(DEFAULT_ONBOARDING_FUNNEL_STAGES[3].label).toBe("Ready for credentialing");
  });

  it("lays four cards out in one row when Verified, awaiting assignment is hidden", () => {
    state.config = resolveOnboardingFunnelConfig(
      { assignmentRequiredForReady: false, statelessLocationHolds: false },
      null,
      120,
    );
    const html = render();
    expect(cardTitles(html)).toEqual([
      "Profile incomplete",
      "Submitted",
      "Ready for credentialing",
      "Credentialing",
    ]);
    expect(html).toContain("lg:grid-cols-4");
    expect(html).not.toContain("xl:grid-cols-5");
  });
});
