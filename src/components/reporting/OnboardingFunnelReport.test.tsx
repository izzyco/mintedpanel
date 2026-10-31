import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOnboardingFunnelRows,
  DEFAULT_ONBOARDING_FUNNEL_RULES,
  visibleOnboardingFunnelStages,
  type OnboardingFunnelInput,
  type OnboardingFunnelProviderFacts,
  type OnboardingFunnelStage,
} from "@/lib/onboardingFunnel";

const state = vi.hoisted(() => ({
  stage: null as string | null,
  intakeReadable: false,
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
    rows: buildOnboardingFunnelRows(funnelInput(), "2026-10-20", DEFAULT_ONBOARDING_FUNNEL_RULES),
    stages: visibleOnboardingFunnelStages(state.intakeReadable),
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
      },
    ],
    groupMemberships: [{ providerId: "p-ready", groupId: "g-1", startDate: null, endDate: null }],
    // Dee's only case was denied; by default every case counts.
    cases: [{ providerId: "p-denied", state: "TX", status: "denied" }],
    intakeReadable: false,
  };
}

function render(stage: OnboardingFunnelStage | null = null): string {
  state.stage = stage;
  return renderToStaticMarkup(<OnboardingFunnelReport />);
}

/** The stage card titles, in the order they render. */
function cardTitles(html: string): string[] {
  return [...html.matchAll(/Step \d+<\/span><span[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]);
}

beforeEach(() => {
  state.stage = null;
  state.intakeReadable = false;
});

describe("Provider Onboarding report", () => {
  it("shows the five provider stages in funnel order, without Invited", () => {
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
    expect(html).toContain("lg:grid-cols-5");
  });

  it("lists a verified provider with no group or location under Verified, awaiting assignment", () => {
    const html = render("verified_awaiting_assignment");
    expect(html).toContain("Verified, awaiting assignment · 1");
    expect(html).toContain("What&#x27;s needed");
    expect(html).toContain("Bea Unassigned");
    expect(html).toContain("Needs a group and a location");
    expect(html).not.toContain("Eve Pending");
  });

  it("lists only unverified providers under Submitted", () => {
    const html = render("submitted");
    expect(html).toContain("Submitted · 1");
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

  it("adds Invited as the first stage once the intake tables can be read", () => {
    state.intakeReadable = true;
    const html = render();
    expect(cardTitles(html)).toEqual([
      "Invited",
      "Profile incomplete",
      "Submitted",
      "Verified, awaiting assignment",
      "Ready for credentialing",
      "Credentialing",
    ]);
    expect(html).toContain("xl:grid-cols-6");
  });
});
