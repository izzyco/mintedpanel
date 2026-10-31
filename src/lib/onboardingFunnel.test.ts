import { describe, expect, it } from "vitest";
import { CASE_STATUSES, type CaseStatus } from "@/lib/caseStatus";
import {
  buildOnboardingFunnelRows,
  DEFAULT_ONBOARDING_FUNNEL_CONFIG,
  DEFAULT_ONBOARDING_FUNNEL_RULES,
  DEFAULT_ONBOARDING_FUNNEL_STAGES,
  MAX_ONBOARDING_FUNNEL_STAGES,
  ONBOARDING_FUNNEL_GATES,
  onboardingFunnelStageCounts,
  onboardingFunnelStates,
  placeOnboardingFunnelStage,
  resolveOnboardingFunnelConfig,
  resolveOnboardingFunnelRules,
  STATELESS_LOCATION_GAP,
  validateOnboardingFunnelConfig,
  visibleOnboardingFunnelStages,
  type OnboardingFunnelConfig,
  type OnboardingFunnelConfigOverride,
  type OnboardingFunnelDimensions,
  type OnboardingFunnelGate,
  type OnboardingFunnelInput,
  type OnboardingFunnelIntakeFacts,
  type OnboardingFunnelLocationInput,
  type OnboardingFunnelMembershipInput,
  type OnboardingFunnelProviderFacts,
  type OnboardingFunnelRules,
  type OnboardingFunnelStageConfig,
} from "@/lib/onboardingFunnel";

const TODAY = "2026-10-20";
const DEFAULT = DEFAULT_ONBOARDING_FUNNEL_RULES;
const GROUP = "g-rose";
const OTHER_GROUP = "g-shelby";

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

const verified = (providerId: string, state: string) => ({
  providerId,
  state,
  verifiedStatus: "verified",
  expirationDate: "2027-06-30",
});

/** An assignment to an active location under Rose City Rehab unless overridden. */
const at = (
  providerId: string,
  state: string | null,
  over: Partial<OnboardingFunnelLocationInput> = {},
): OnboardingFunnelLocationInput => ({
  providerId,
  locationId: `f-${providerId}-${state ?? "none"}`,
  locationName: `${state ?? "Stateless"} Clinic`,
  state,
  groupId: GROUP,
  groupName: "Rose City Rehab",
  ...over,
});

const underShelby = { groupId: OTHER_GROUP, groupName: "Shelby Sports Rehab" };

/** A membership in Rose City Rehab (active) unless overridden. */
const member = (
  providerId: string,
  endDate: string | null = null,
  over: Partial<OnboardingFunnelMembershipInput> = {},
): OnboardingFunnelMembershipInput => ({
  providerId,
  groupId: GROUP,
  groupName: "Rose City Rehab",
  groupActive: true,
  startDate: null,
  endDate,
  ...over,
});

const kase = (providerId: string, state: string, status: CaseStatus | null = "in_progress") => ({
  providerId,
  state,
  status,
});

function input(): OnboardingFunnelInput {
  return {
    providers: [
      { ...complete("missing", "Ann Missing"), npi: null, ssnLast4Present: false },
      complete("nolicense", "Bea Nolicense"),
      complete("wrongstate", "Cal Wrongstate"),
      complete("unverified", "Dee Unverified"),
      { ...complete("stale", "Eve Stale"), caqhLastAttestedDate: "2026-01-01" },
      complete("ready", "Fay Ready"),
      { ...complete("enrolling", "Gus Enrolling"), caqhIdPresent: false },
    ],
    licenses: [
      verified("wrongstate", "KS"),
      { ...verified("unverified", "TX"), verifiedStatus: "unverified" },
      verified("stale", "NC"),
      verified("ready", "NC"),
      { ...verified("ready", "SC"), expirationDate: "2025-01-01" },
    ],
    locations: [
      at("wrongstate", "MO"),
      at("unverified", "tx"),
      at("stale", "NC"),
      at("ready", "NC"),
    ],
    groupMemberships: [member("unverified"), member("stale"), member("ready")],
    cases: [kase("enrolling", "CO")],
    intakeReadable: false,
  };
}

/** The default stages under the given rules. */
const withRules = (rules: OnboardingFunnelRules): OnboardingFunnelConfig => ({
  stages: DEFAULT_ONBOARDING_FUNNEL_STAGES,
  rules,
});

function rowsOf(data: OnboardingFunnelInput, rules: OnboardingFunnelRules = DEFAULT) {
  return buildOnboardingFunnelRows(data, TODAY, withRules(rules));
}

function rowFor(
  data: OnboardingFunnelInput,
  providerId: string,
  rules: OnboardingFunnelRules = DEFAULT,
) {
  return rowsOf(data, rules).find((r) => r.providerId === providerId);
}

describe("provider onboarding funnel", () => {
  it("places every provider in exactly one stage with the gaps that hold them there", () => {
    const rows = rowsOf(input());
    expect(rows.map((r) => [r.providerId, r.stage, r.gaps])).toEqual([
      ["missing", "profile_incomplete", ["No NPI", "No SSN last 4", "No state license"]],
      ["nolicense", "profile_incomplete", ["No state license"]],
      ["wrongstate", "profile_incomplete", ["No MO license"]],
      ["unverified", "submitted", ["TX license not board-verified"]],
      ["stale", "submitted", ["CAQH attestation older than 120 days"]],
      // The expired SC license is outside the state Fay works in.
      ["ready", "ready_for_credentialing", []],
      // A case means credentialing has started, whatever else is open.
      ["enrolling", "credentialing", []],
    ]);
    const counts = onboardingFunnelStageCounts(rows, DEFAULT_ONBOARDING_FUNNEL_STAGES);
    expect(counts).toEqual({
      invited: 0,
      profile_incomplete: 3,
      submitted: 2,
      verified_awaiting_assignment: 0,
      ready_for_credentialing: 1,
      credentialing: 1,
    });
    expect(Object.values(counts).reduce((n, c) => n + c, 0)).toBe(rows.length);
  });

  it("holds a verified provider in Verified, awaiting assignment until they have a group and a location", () => {
    const data = input();
    data.providers = [
      complete("both", "Ada Both"),
      complete("grouponly", "Ben Grouponly"),
      complete("locationonly", "Cy Locationonly"),
      complete("neither", "Di Neither"),
    ];
    data.licenses = data.providers.map((p) => verified(p.providerId, "NC"));
    data.locations = [at("both", "NC"), at("locationonly", "NC")];
    data.groupMemberships = [member("both"), member("grouponly")];
    data.cases = [];
    expect(rowsOf(data).map((r) => [r.providerId, r.stage, r.gaps])).toEqual([
      ["both", "ready_for_credentialing", []],
      ["grouponly", "verified_awaiting_assignment", ["Needs a location"]],
      ["locationonly", "verified_awaiting_assignment", ["Needs a group"]],
      ["neither", "verified_awaiting_assignment", ["Needs a group and a location"]],
    ]);
  });

  it("does not count a group membership that ended before today, and says so", () => {
    const data = input();
    data.groupMemberships = [member("ready", "2026-10-19")];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Membership in Rose City Rehab ended 2026-10-19"],
    });
    data.groupMemberships = [member("ready", TODAY)];
    expect(rowFor(data, "ready")).toMatchObject({ stage: "ready_for_credentialing" });
  });

  it("judges every license on file when no location is assigned, and never calls that Ready", () => {
    const data = input();
    data.locations = [];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "submitted",
      gaps: ["SC license expired", "Needs a location"],
    });
    data.licenses = data.licenses.filter((l) => !(l.providerId === "ready" && l.state === "SC"));
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Needs a location"],
    });
  });

  it("never lets a location with no valid state reach Ready", () => {
    // Fay: complete profile, verified unexpired NC license, current group
    // membership. Her only active location has no usable state: her
    // licenses on file are judged, and the location holds her.
    for (const state of [null, "", "Kansas", "N1"]) {
      const data = input();
      data.licenses = [verified("ready", "NC")];
      data.locations = [at("ready", state)];
      expect(rowFor(data, "ready")).toMatchObject({
        stage: "verified_awaiting_assignment",
        gaps: [STATELESS_LOCATION_GAP],
      });
    }
    expect(STATELESS_LOCATION_GAP).toBe("Location has no valid state on record");
  });

  it("never calls a provider verified when a stateless location hides a bad license", () => {
    // Review P1: one stateless location and an unverified NC license that
    // expired in 2020. She was "verified" because nothing was judged.
    const data = input();
    data.licenses = [
      { ...verified("ready", "NC"), verifiedStatus: "unverified", expirationDate: "2020-03-31" },
    ];
    data.locations = [at("ready", null)];
    const row = rowFor(data, "ready");
    expect(row).toMatchObject({
      stage: "submitted",
      gaps: ["NC license not board-verified", "NC license expired", STATELESS_LOCATION_GAP],
    });
    expect(row?.dimensions.verified).toBe(false);
    // Fixing the location's state does not move her back up the funnel.
    data.locations = [at("ready", "NC")];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "submitted",
      gaps: ["NC license not board-verified", "NC license expired"],
    });
  });

  it("holds a provider when any one of their locations has no state", () => {
    // Fay's NC location passes, but a second location has no state, so its
    // license cannot be judged and she is not verified for every place she works.
    for (const state of [null, "N1"]) {
      const data = input();
      data.locations = [at("ready", state), at("ready", "NC")];
      expect(rowFor(data, "ready")).toMatchObject({
        stage: "verified_awaiting_assignment",
        gaps: [STATELESS_LOCATION_GAP],
      });
    }
  });

  it("still judges the valid locations next to a stateless one", () => {
    const data = input();
    data.licenses = [{ ...verified("ready", "NC"), verifiedStatus: "unverified" }];
    data.locations = [at("ready", ""), at("ready", "NC")];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "submitted",
      gaps: ["NC license not board-verified", STATELESS_LOCATION_GAP],
    });
  });

  it("lists a stateless location next to the license and group gaps", () => {
    const data = input();
    data.groupMemberships = [];
    data.locations = [at("ready", "nowhere")];
    data.licenses = [{ ...verified("ready", "NC"), verifiedStatus: "unverified" }];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "submitted",
      gaps: ["NC license not board-verified", "Needs a group", STATELESS_LOCATION_GAP],
    });
  });

  it("counts any case as Credentialing, even for an incomplete, unassigned profile", () => {
    const data = input();
    data.cases = [kase("missing", "TX")];
    expect(rowFor(data, "missing")).toMatchObject({ stage: "credentialing", gaps: [] });
  });

  it("places a complete, unverified provider with a case in Credentialing", () => {
    const data = input();
    data.cases = [kase("unverified", "TX", "submitted")];
    const row = rowFor(data, "unverified");
    expect(row).toMatchObject({ stage: "credentialing", gaps: [] });
    expect(row?.dimensions).toMatchObject({
      complete: true,
      verified: false,
      verificationGaps: ["TX license not board-verified"],
      hasCountedCase: true,
    });
  });

  it("flags never-attested CAQH and pending records, and lists states for the filter", () => {
    const data = input();
    data.providers = [
      { ...complete("ready", "Fay Ready"), caqhLastAttestedDate: null, pendingVerification: true },
    ];
    expect(rowsOf(data)[0]).toMatchObject({
      stage: "submitted",
      gaps: ["CAQH never attested", "Record pending verification"],
    });
    expect(onboardingFunnelStates(rowsOf(input()))).toEqual(["CO", "KS", "MO", "NC", "SC", "TX"]);
  });

  it("names a license with no expiration date instead of calling it expired", () => {
    const data = input();
    data.licenses = data.licenses.map((l) =>
      l.providerId === "ready" && l.state === "NC" ? { ...l, expirationDate: null } : l,
    );
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "submitted",
      gaps: ["NC license has no expiration date"],
    });
  });

  it("treats a future CAQH attestation date as not current, with its own reason", () => {
    const data = input();
    data.providers = [{ ...complete("ready", "Fay Ready"), caqhLastAttestedDate: "2026-11-01" }];
    expect(rowsOf(data)[0]).toMatchObject({
      stage: "submitted",
      gaps: ["CAQH attestation date is in the future"],
    });
  });

  it("does not let a license with an invalid state code satisfy the license requirement", () => {
    const data = input();
    data.providers = [complete("bad", "Hal Badstate")];
    data.licenses = [verified("bad", "Z9")];
    data.locations = [];
    data.groupMemberships = [];
    expect(rowsOf(data)[0]).toMatchObject({
      stage: "profile_incomplete",
      gaps: ["License state is missing or invalid"],
    });
    data.licenses = [...data.licenses, verified("bad", "nc")];
    data.locations = [at("bad", "NC")];
    data.groupMemberships = [member("bad")];
    expect(rowsOf(data)[0]).toMatchObject({ stage: "ready_for_credentialing", states: ["NC"] });
  });
});

describe("Submitted and Verified, awaiting assignment", () => {
  it("puts verification gaps in Submitted and assignment-only gaps in Verified, awaiting assignment", () => {
    const data = input();
    data.providers = [
      complete("nogroup", "Ada Nogroup"),
      complete("mismatch", "Ben Mismatch"),
      complete("stateless", "Cy Stateless"),
      { ...complete("pending", "Di Pending"), pendingVerification: true },
    ];
    data.licenses = data.providers.map((p) => verified(p.providerId, "NC"));
    data.locations = [
      at("nogroup", "NC"),
      at("mismatch", "NC", underShelby),
      at("stateless", null),
      at("pending", "NC"),
    ];
    data.groupMemberships = [member("mismatch"), member("stateless"), member("pending")];
    data.cases = [];
    const rows = rowsOf(data);
    expect(rows.map((r) => [r.providerId, r.stage, r.gaps])).toEqual([
      ["nogroup", "verified_awaiting_assignment", ["Needs a group"]],
      [
        "mismatch",
        "verified_awaiting_assignment",
        ["Location NC Clinic is under Shelby Sports Rehab, not the provider's group"],
      ],
      ["stateless", "verified_awaiting_assignment", [STATELESS_LOCATION_GAP]],
      ["pending", "submitted", ["Record pending verification"]],
    ]);
    expect(onboardingFunnelStageCounts(rows, DEFAULT_ONBOARDING_FUNNEL_STAGES)).toMatchObject({
      submitted: 1,
      verified_awaiting_assignment: 3,
    });
  });

  it("keeps a provider with both verification and assignment gaps in Submitted and lists both", () => {
    const data = input();
    data.locations = [at("unverified", "TX", underShelby)];
    expect(rowFor(data, "unverified")).toMatchObject({
      stage: "submitted",
      gaps: [
        "TX license not board-verified",
        "Location TX Clinic is under Shelby Sports Rehab, not the provider's group",
      ],
    });
    data.groupMemberships = [];
    expect(rowFor(data, "unverified")).toMatchObject({
      stage: "submitted",
      gaps: ["TX license not board-verified", "Needs a group"],
    });
  });
});

describe("a location must be under the provider's group", () => {
  it("counts a location under a group the provider is a current member of", () => {
    expect(rowFor(input(), "ready")).toMatchObject({ stage: "ready_for_credentialing", gaps: [] });
  });

  it("holds a provider whose only location is under another group, naming both", () => {
    const data = input();
    data.locations = [at("ready", "NC", { ...underShelby, locationName: "Austin" })];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Location Austin is under Shelby Sports Rehab, not the provider's group"],
    });
  });

  it("is satisfied by a matching second location next to a mismatched one", () => {
    const data = input();
    data.licenses = [...data.licenses, verified("ready", "TX")];
    data.locations = [
      at("ready", "TX", { ...underShelby, locationName: "Austin" }),
      at("ready", "NC"),
    ];
    expect(rowFor(data, "ready")).toMatchObject({ stage: "ready_for_credentialing", gaps: [] });
  });

  it("still asks for a license in the state of a mismatched location", () => {
    // The Austin location does not count toward Ready, but Fay is still
    // assigned to work there, so its state needs a license like any other.
    const data = input();
    data.locations = [
      at("ready", "TX", { ...underShelby, locationName: "Austin" }),
      at("ready", "NC"),
    ];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "profile_incomplete",
      gaps: ["No TX license"],
    });
  });

  it("says only 'Needs a group' when the provider has no membership at all", () => {
    const data = input();
    data.groupMemberships = [];
    data.locations = [at("ready", "NC", { ...underShelby, locationName: "Austin" })];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Needs a group"],
    });
  });

  it("names a location with no group", () => {
    const data = input();
    data.locations = [
      at("ready", "NC", { locationName: "Durham", groupId: null, groupName: null }),
    ];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Location Durham has no group"],
    });
  });

  it("matches against any of several current groups", () => {
    const data = input();
    data.locations = [at("ready", "NC", underShelby)];
    data.groupMemberships = [member("ready"), member("ready", null, underShelby)];
    expect(rowFor(data, "ready")).toMatchObject({ stage: "ready_for_credentialing" });
  });
});

describe("accurate reasons when the location's group is the provider's own", () => {
  // Fay is a current member of Shelby Sports Rehab; her only location is
  // under Rose City Rehab, where her membership does not count.
  function lapsed(rose: Partial<OnboardingFunnelMembershipInput>) {
    const data = input();
    data.locations = [at("ready", "NC", { locationName: "Durham" })];
    data.groupMemberships = [member("ready", null, underShelby), member("ready", null, rose)];
    return data;
  }

  it("says the membership ended", () => {
    expect(rowFor(lapsed({ endDate: "2026-10-01" }), "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Membership in Rose City Rehab ended 2026-10-01"],
    });
  });

  it("says when the membership starts, while future memberships do not count", () => {
    const off = resolveOnboardingFunnelRules(null, { futureMembershipCounts: false });
    const data = lapsed({ startDate: "2026-11-01" });
    expect(rowFor(data, "ready")).toMatchObject({ stage: "ready_for_credentialing" });
    expect(rowFor(data, "ready", off)).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Membership in Rose City Rehab starts 2026-11-01"],
    });
  });

  it("says the group is inactive", () => {
    expect(rowFor(lapsed({ groupActive: false }), "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Group Rose City Rehab is inactive"],
    });
  });

  it("names the lapsed membership when it is the provider's only one", () => {
    const data = input();
    data.groupMemberships = [member("ready", null, { groupActive: false })];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Group Rose City Rehab is inactive"],
    });
    data.locations = [];
    data.licenses = [verified("ready", "NC")];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Group Rose City Rehab is inactive", "Needs a location"],
    });
  });
});

describe("configurable rules", () => {
  it("counts a case in every status by default, and ignores the statuses listed as not counting", () => {
    for (const status of CASE_STATUSES) {
      const data = input();
      data.cases = [kase("ready", "CO", status)];
      expect(rowFor(data, "ready")?.stage).toBe("credentialing");
    }
    const rules = resolveOnboardingFunnelRules(null, {
      caseStatusesNotCountedAsCredentialing: ["not_pursuing", "denied"],
    });
    const data = input();
    data.cases = [kase("ready", "CO", "not_pursuing")];
    // The policy only decides the stage: the case is still a fact, and CO
    // is still a state she touches.
    const row = rowFor(data, "ready", rules);
    expect(row).toMatchObject({ stage: "ready_for_credentialing", states: ["CO", "NC", "SC"] });
    expect(row?.dimensions).toMatchObject({
      hasCase: true,
      caseCount: 1,
      caseStatuses: ["not_pursuing"],
      hasCountedCase: false,
    });
    data.cases = [kase("ready", "CO", "denied"), kase("ready", "TX", "approved")];
    expect(rowFor(data, "ready", rules)).toMatchObject({
      stage: "credentialing",
      states: ["CO", "NC", "SC", "TX"],
    });
    // A case whose stored status is not a known one always counts.
    data.cases = [kase("ready", "CO", null)];
    expect(rowFor(data, "ready", rules)?.stage).toBe("credentialing");
  });

  it("holds a provider for a stateless location by default, and not when the rule is off", () => {
    const off = resolveOnboardingFunnelRules({ statelessLocationHolds: false });
    const data = input();
    data.locations = [at("ready", null), at("ready", "NC")];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: [STATELESS_LOCATION_GAP],
    });
    expect(rowFor(data, "ready", off)).toMatchObject({ stage: "ready_for_credentialing" });
  });

  it("judges every license on file when no location has a valid state, either way", () => {
    const off = resolveOnboardingFunnelRules({ statelessLocationHolds: false });
    const data = input();
    data.licenses = [verified("ready", "NC")];
    data.locations = [at("ready", "")];
    // With the rule off, the stateless location counts as a location in her group.
    expect(rowFor(data, "ready", off)).toMatchObject({ stage: "ready_for_credentialing" });
    data.licenses = [{ ...verified("ready", "NC"), verifiedStatus: "unverified" }];
    expect(rowFor(data, "ready", off)).toMatchObject({
      stage: "submitted",
      gaps: ["NC license not board-verified"],
    });
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "submitted",
      gaps: ["NC license not board-verified", STATELESS_LOCATION_GAP],
    });
  });

  it("counts a membership that starts in the future by default, and not when the rule is off", () => {
    const off = resolveOnboardingFunnelRules(null, { futureMembershipCounts: false });
    const data = input();
    data.groupMemberships = [member("ready", null, { startDate: "2026-11-01" })];
    expect(rowFor(data, "ready")).toMatchObject({ stage: "ready_for_credentialing" });
    expect(rowFor(data, "ready", off)).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Membership in Rose City Rehab starts 2026-11-01"],
    });
    // Started today, or no start date on record: current either way.
    for (const startDate of [TODAY, null]) {
      data.groupMemberships = [member("ready", null, { startDate })];
      expect(rowFor(data, "ready", off)).toMatchObject({ stage: "ready_for_credentialing" });
    }
    // An ended membership never counts, whatever the rule.
    data.groupMemberships = [member("ready", "2026-10-19", { startDate: "2026-01-01" })];
    expect(rowFor(data, "ready")?.stage).toBe("verified_awaiting_assignment");
    expect(rowFor(data, "ready", off)?.stage).toBe("verified_awaiting_assignment");
  });

  it("requires a location under the provider's group by default, and not when the rule is off", () => {
    const off = resolveOnboardingFunnelRules({ locationMustBeInProviderGroup: false });
    const data = input();
    data.locations = [at("ready", "NC", { ...underShelby, locationName: "Austin" })];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Location Austin is under Shelby Sports Rehab, not the provider's group"],
    });
    expect(rowFor(data, "ready", off)).toMatchObject({ stage: "ready_for_credentialing" });
    // A current group is still needed either way.
    data.groupMemberships = [];
    expect(rowFor(data, "ready", off)).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Needs a group"],
    });
  });

  it("requires assignment for Ready by default, and not when the rule is off", () => {
    const off = resolveOnboardingFunnelRules({ assignmentRequiredForReady: false });
    const data = input();
    data.locations = [];
    data.groupMemberships = [];
    data.licenses = [verified("ready", "NC")];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Needs a group and a location"],
    });
    const row = rowFor(data, "ready", off);
    expect(row).toMatchObject({ stage: "ready_for_credentialing", gaps: [] });
    // The dimension is still computed; it just does not hold her.
    expect(row?.dimensions).toMatchObject({
      assigned: false,
      assignmentGaps: ["Needs a group and a location"],
    });
    // Submitted then lists the verification gaps alone.
    data.providers = [{ ...complete("ready", "Fay Ready"), pendingVerification: true }];
    expect(rowFor(data, "ready", off)).toMatchObject({
      stage: "submitted",
      gaps: ["Record pending verification"],
    });
  });
});

describe("per-provider dimensions", () => {
  it("computes complete, verified, assigned and the case facts on their own, whatever the stage", () => {
    const data = input();
    data.providers = [{ ...complete("all", "Ann Allgaps"), npi: null, pendingVerification: true }];
    data.licenses = [verified("all", "NC")];
    data.locations = [];
    data.groupMemberships = [];
    data.cases = [kase("all", "TX", "denied")];
    const rules = resolveOnboardingFunnelRules(null, {
      caseStatusesNotCountedAsCredentialing: ["denied"],
    });
    const [row] = rowsOf(data, rules);
    expect(row.dimensions).toEqual({
      complete: false,
      completenessGaps: ["No NPI"],
      verified: false,
      verificationGaps: ["Record pending verification"],
      assigned: false,
      assignmentGaps: ["Needs a group and a location"],
      hasCase: true,
      caseCount: 1,
      caseStatuses: ["denied"],
      hasCountedCase: false,
      intake: null,
    });
    // The stage reads the dimensions; its gaps are the ones its gate lists.
    expect(row).toMatchObject({
      stage: "profile_incomplete",
      gaps: ["No NPI"],
      states: ["NC", "TX"],
    });
  });

  it("keeps computing the other dimensions for a provider with a case", () => {
    const row = rowFor(input(), "enrolling");
    expect(row).toMatchObject({ stage: "credentialing", gaps: [] });
    expect(row?.dimensions).toMatchObject({
      complete: false,
      completenessGaps: ["No CAQH ID", "No state license"],
      verified: true,
      assigned: false,
      assignmentGaps: ["Needs a group and a location"],
      hasCase: true,
      caseCount: 1,
      caseStatuses: ["in_progress"],
      hasCountedCase: true,
    });
  });
});

describe("intake facts", () => {
  function withIntake(readable: boolean): OnboardingFunnelInput {
    const data = input();
    data.intakeReadable = readable;
    data.intake = [
      { providerId: "missing", intakeSubmitted: false },
      { providerId: "nolicense", intakeSubmitted: true },
      { providerId: "enrolling", intakeSubmitted: false },
    ];
    return data;
  }

  it("is unknown while the intake tables cannot be read, and never inferred", () => {
    const rows = rowsOf(withIntake(false));
    expect(rows.every((r) => r.dimensions.intake === null)).toBe(true);
    expect(rows.some((r) => r.stage === "invited")).toBe(false);
    expect(rowFor(withIntake(false), "missing")?.stage).toBe("profile_incomplete");
  });

  it("places an invited provider who has not sent the form back in Invited, once readable", () => {
    const data = withIntake(true);
    expect(rowFor(data, "missing")).toMatchObject({
      stage: "invited",
      gaps: [],
      dimensions: { intake: { invited: true, intakeSubmitted: false } },
    });
    // Sent back: placed by the record like anyone else.
    expect(rowFor(data, "nolicense")).toMatchObject({
      stage: "profile_incomplete",
      dimensions: { intake: { invited: true, intakeSubmitted: true } },
    });
    // Not invited at all: a fact once readable, not a guess.
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "ready_for_credentialing",
      dimensions: { intake: { invited: false, intakeSubmitted: false } },
    });
    // A case still wins.
    expect(rowFor(data, "enrolling")?.stage).toBe("credentialing");
  });
});

describe("stage configuration", () => {
  it("defaults to the PM's six stages and labels, in order", () => {
    expect(DEFAULT_ONBOARDING_FUNNEL_STAGES.map((s) => [s.key, s.label, s.gate])).toEqual([
      ["invited", "Invited", "invited_not_submitted"],
      ["profile_incomplete", "Profile incomplete", "incomplete"],
      ["submitted", "Submitted", "complete_unverified"],
      ["verified_awaiting_assignment", "Verified, awaiting assignment", "verified_unassigned"],
      ["ready_for_credentialing", "Ready for credentialing", "ready"],
      ["credentialing", "Credentialing", "has_case"],
    ]);
    expect(DEFAULT_ONBOARDING_FUNNEL_CONFIG).toEqual({
      stages: DEFAULT_ONBOARDING_FUNNEL_STAGES,
      rules: DEFAULT_ONBOARDING_FUNNEL_RULES,
    });
    expect(Object.isFrozen(DEFAULT_ONBOARDING_FUNNEL_STAGES[2])).toBe(true);
  });

  it("describes the stages without depending on a rule, and Submitted as complete, not sent", () => {
    const copy = Object.fromEntries(
      DEFAULT_ONBOARDING_FUNNEL_STAGES.map((s) => [s.label, s.description]),
    );
    expect(copy).toEqual({
      Invited: "Invited to the intake form. Nothing sent back yet.",
      "Profile incomplete": "Missing NPI, CAQH ID, demographics, or a license.",
      Submitted: "Information is complete but not yet verified.",
      "Verified, awaiting assignment":
        "Verified; the group, the location, or a location's record still needs attention.",
      "Ready for credentialing": "Meets every requirement for credentialing. No case yet.",
      Credentialing: "Has at least one credentialing case.",
    });
    expect(copy.Submitted).not.toMatch(/sent|transmit|submitted to|filed|payer/i);
    const text = Object.entries(copy).flat().join(" ");
    expect(text).not.toMatch(/Awaiting verification|Ready to credential\b/);
    expect(text).not.toMatch(/approved|denied|withdrawn|underway|any status/i);
  });

  it("hides intake-gated stages until the intake tables can be read", () => {
    expect(
      visibleOnboardingFunnelStages(DEFAULT_ONBOARDING_FUNNEL_CONFIG, false).map((s) => s.key),
    ).toEqual([
      "profile_incomplete",
      "submitted",
      "verified_awaiting_assignment",
      "ready_for_credentialing",
      "credentialing",
    ]);
    expect(
      visibleOnboardingFunnelStages(DEFAULT_ONBOARDING_FUNNEL_CONFIG, true).map((s) => s.key),
    ).toEqual(DEFAULT_ONBOARDING_FUNNEL_STAGES.map((s) => s.key));
    expect(rowsOf(input()).some((r) => r.stage === "invited")).toBe(false);
  });

  it("hides a stage whose gate cannot match under the rules in force", () => {
    const config = resolveOnboardingFunnelConfig(null, {
      rules: { assignmentRequiredForReady: false },
    });
    expect(visibleOnboardingFunnelStages(config, false).map((s) => s.key)).toEqual([
      "profile_incomplete",
      "submitted",
      "ready_for_credentialing",
      "credentialing",
    ]);
  });

  it("lists gaps only for the stages whose gate has them", () => {
    expect(
      visibleOnboardingFunnelStages(DEFAULT_ONBOARDING_FUNNEL_CONFIG, true)
        .filter((s) => s.listsGaps)
        .map((s) => s.key),
    ).toEqual(["profile_incomplete", "submitted", "verified_awaiting_assignment"]);
  });

  it("offers a fixed menu of gates", () => {
    expect(ONBOARDING_FUNNEL_GATES.map((g) => g.key)).toEqual([
      "invited_not_submitted",
      "incomplete",
      "complete_unverified",
      "verified_unassigned",
      "not_ready",
      "ready",
      "has_case",
      "any",
    ]);
    expect(ONBOARDING_FUNNEL_GATES.every((g) => g.description.length > 0)).toBe(true);
  });

  it("lets an organization rename a stage without moving anyone", () => {
    const config = resolveOnboardingFunnelConfig(null, {
      stages: DEFAULT_ONBOARDING_FUNNEL_STAGES.map((s) =>
        s.key === "submitted"
          ? { ...s, label: "Complete, not verified", description: "Waiting on verification." }
          : s,
      ),
    });
    const rows = buildOnboardingFunnelRows(input(), TODAY, config);
    expect(rows.map((r) => r.stage)).toEqual(rowsOf(input()).map((r) => r.stage));
    expect(visibleOnboardingFunnelStages(config, false)[1]).toMatchObject({
      key: "submitted",
      label: "Complete, not verified",
    });
  });

  it("lets an organization merge stages with a menu gate, listing every gap", () => {
    const stages: OnboardingFunnelStageConfig[] = [
      {
        key: "profile_incomplete",
        label: "Profile incomplete",
        description: "d",
        gate: "incomplete",
      },
      { key: "not_ready", label: "Not ready", description: "d", gate: "not_ready" },
      { key: "ready_for_credentialing", label: "Ready", description: "d", gate: "ready" },
      { key: "credentialing", label: "Credentialing", description: "d", gate: "has_case" },
    ];
    const config = resolveOnboardingFunnelConfig(null, { stages });
    expect(config.stages.map((s) => s.key)).toEqual(stages.map((s) => s.key));
    const data = input();
    data.groupMemberships = data.groupMemberships.filter((m) => m.providerId !== "unverified");
    const rows = buildOnboardingFunnelRows(data, TODAY, config);
    expect(rows.find((r) => r.providerId === "unverified")).toMatchObject({
      stage: "not_ready",
      gaps: ["TX license not board-verified", "Needs a group"],
    });
    expect(onboardingFunnelStageCounts(rows, config.stages)).toEqual({
      profile_incomplete: 3,
      not_ready: 2,
      ready_for_credentialing: 1,
      credentialing: 1,
    });
  });

  it("places each provider by the first stage whose gate matches", () => {
    const stages: OnboardingFunnelStageConfig[] = [
      { key: "credentialing", label: "Credentialing", description: "d", gate: "has_case" },
      { key: "everyone_else", label: "Everyone else", description: "d", gate: "any" },
    ];
    expect(validateOnboardingFunnelConfig({ stages, rules: DEFAULT })).toEqual([]);
    const rows = buildOnboardingFunnelRows(input(), TODAY, { stages, rules: DEFAULT });
    expect(onboardingFunnelStageCounts(rows, stages)).toEqual({
      credentialing: 1,
      everyone_else: 6,
    });
  });

  it("runs the default stages when a configuration fails validation, so nobody is dropped", () => {
    const expected = rowsOf(input()).map((r) => r.stage);
    for (const stages of [
      [],
      [{ key: "ready_for_credentialing", label: "Ready", description: "d", gate: "ready" }],
      [null],
    ] as unknown as OnboardingFunnelStageConfig[][]) {
      const rows = buildOnboardingFunnelRows(input(), TODAY, { stages, rules: DEFAULT });
      expect(rows.map((r) => r.stage)).toEqual(expected);
      expect(rows.some((r) => r.stage === "")).toBe(false);
    }
  });
});

describe("the default configuration is exhaustive", () => {
  const flags = [true, false];
  const intakes: Array<OnboardingFunnelIntakeFacts | null> = [
    null,
    { invited: false, intakeSubmitted: false },
    { invited: true, intakeSubmitted: false },
    { invited: true, intakeSubmitted: true },
  ];

  function dims(
    complete: boolean,
    verified: boolean,
    assigned: boolean,
    hasCountedCase: boolean,
    intake: OnboardingFunnelIntakeFacts | null,
  ): OnboardingFunnelDimensions {
    return {
      complete,
      completenessGaps: complete ? [] : ["No NPI"],
      verified,
      verificationGaps: verified ? [] : ["Record pending verification"],
      assigned,
      assignmentGaps: assigned ? [] : ["Needs a group"],
      hasCase: hasCountedCase,
      caseCount: hasCountedCase ? 1 : 0,
      caseStatuses: hasCountedCase ? ["in_progress"] : [],
      hasCountedCase,
      intake,
    };
  }

  /** The PM's placement, written out plainly. */
  function expectedStage(d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules): string {
    if (d.hasCountedCase) return "credentialing";
    if (d.intake?.invited && !d.intake.intakeSubmitted) return "invited";
    if (!d.complete) return "profile_incomplete";
    if (!d.verified) return "submitted";
    if (!d.assigned && rules.assignmentRequiredForReady) return "verified_awaiting_assignment";
    return "ready_for_credentialing";
  }

  it("places every combination of dimensions in exactly one visible stage, under every rule", () => {
    let checked = 0;
    for (const statelessLocationHolds of flags)
      for (const futureMembershipCounts of flags)
        for (const locationMustBeInProviderGroup of flags)
          for (const assignmentRequiredForReady of flags)
            for (const caseStatusesNotCountedAsCredentialing of [
              [],
              ["denied"],
            ] as CaseStatus[][]) {
              const rules: OnboardingFunnelRules = {
                caseStatusesNotCountedAsCredentialing,
                statelessLocationHolds,
                futureMembershipCounts,
                locationMustBeInProviderGroup,
                assignmentRequiredForReady,
              };
              const config = withRules(rules);
              expect(validateOnboardingFunnelConfig(config)).toEqual([]);
              for (const complete of flags)
                for (const verified of flags)
                  for (const assigned of flags)
                    for (const hasCountedCase of flags)
                      for (const intake of intakes) {
                        const d = dims(complete, verified, assigned, hasCountedCase, intake);
                        const placed = placeOnboardingFunnelStage(d, config);
                        expect(placed.stage).toBe(expectedStage(d, rules));
                        const visible = visibleOnboardingFunnelStages(config, intake !== null);
                        expect(visible.map((s) => s.key)).toContain(placed.stage);
                        checked += 1;
                      }
            }
    expect(checked).toBe(32 * 64);
  });
});

describe("validateOnboardingFunnelConfig", () => {
  const stage = (
    key: string,
    gate: OnboardingFunnelGate,
    label = key,
  ): OnboardingFunnelStageConfig => ({ key, label, description: `${label} providers`, gate });
  const valid = (stages: unknown, rules = DEFAULT) =>
    validateOnboardingFunnelConfig({
      stages: stages as OnboardingFunnelStageConfig[],
      rules,
    });

  it("passes the default configuration, with either assignment rule", () => {
    expect(validateOnboardingFunnelConfig(DEFAULT_ONBOARDING_FUNNEL_CONFIG)).toEqual([]);
    expect(
      valid([...DEFAULT_ONBOARDING_FUNNEL_STAGES], {
        ...DEFAULT,
        assignmentRequiredForReady: false,
      }),
    ).toEqual([]);
  });

  it("rejects a list that leaves some providers without a stage, under the rules in force", () => {
    // Review P2: this list validated before, and put an unassigned provider
    // with no case in Credentialing.
    const list = [
      stage("profile_incomplete", "incomplete", "Profile incomplete"),
      stage("submitted", "complete_unverified", "Submitted"),
      stage("ready_for_credentialing", "ready", "Ready for credentialing"),
      stage("credentialing", "has_case", "Credentialing"),
    ];
    expect(valid(list)).toEqual([
      'A provider who is complete, verified, not assigned, with no case, would fit no stage. Add a stage for them, or end with an "everyone else" stage ("any").',
    ]);
    // When Ready does not require assignment, the same list covers everyone.
    expect(valid(list, { ...DEFAULT, assignmentRequiredForReady: false })).toEqual([]);
  });

  it("rejects a gate that is not on the menu", () => {
    expect(
      valid([
        stage("a", "incomplete"),
        stage("b", "has_license" as OnboardingFunnelGate),
        stage("c", "any"),
      ]),
    ).toContain('Stage 2: "has_license" is not a gate on the menu.');
  });

  it("rejects duplicate and malformed keys", () => {
    const errors = valid([
      stage("a", "incomplete"),
      stage("a", "ready", "A again"),
      stage("Bad Key", "has_case"),
      stage("c", "any"),
    ]);
    expect(errors).toContain('Stage 2: the key "a" is already used.');
    expect(errors).toContain(
      "Stage 3: the key must start with a lowercase letter and use only lowercase letters, digits and underscores.",
    );
  });

  it('allows "everyone else" only as the last stage', () => {
    expect(valid([stage("a", "any"), stage("b", "has_case")])).toContain(
      'Stage 1: only the last stage can take everyone else ("any").',
    );
    expect(valid([])).toEqual(["Add at least one stage."]);
  });

  it(`caps the list at ${MAX_ONBOARDING_FUNNEL_STAGES} stages`, () => {
    expect(
      valid([...DEFAULT_ONBOARDING_FUNNEL_STAGES, stage("everyone_else", "any", "Everyone else")]),
    ).toContain("Use at most 6 stages.");
  });

  it("rejects empty, long and duplicate labels, and a missing description", () => {
    const errors = valid([
      { ...stage("a", "incomplete"), label: " " },
      { ...stage("b", "complete_unverified"), label: "x".repeat(61) },
      stage("c", "ready", "Ready"),
      { ...stage("d", "any"), label: "ready", description: "" },
    ]);
    expect(errors).toEqual([
      "Stage 1: add a label.",
      "Stage 2: keep the label to 60 characters.",
      'Stage 4: the label "ready" is already used.',
      "Stage 4: add a description.",
    ]);
  });

  it("rejects a stage the stages before it always take everyone from", () => {
    expect(
      valid([
        stage("profile_incomplete", "incomplete", "Profile incomplete"),
        stage("not_ready", "not_ready", "Not ready"),
        stage("submitted", "complete_unverified", "Submitted"),
        stage("credentialing", "any", "Credentialing"),
      ]),
    ).toEqual([
      '"Submitted" can never be reached: the stages before it take everyone its gate would.',
    ]);
  });

  it("rejects rules of the wrong shape", () => {
    const rules = {
      ...DEFAULT,
      caseStatusesNotCountedAsCredentialing: ["withdrawn"],
      futureMembershipCounts: "yes",
    } as unknown as OnboardingFunnelRules;
    expect(valid([...DEFAULT_ONBOARDING_FUNNEL_STAGES], rules)).toEqual([
      "Case statuses that do not count must be known case statuses.",
      'The rule "futureMembershipCounts" must be on or off.',
    ]);
  });

  it("reports malformed stored lists instead of crashing", () => {
    expect(valid([null])).toEqual(["Stage 1 is not a stage."]);
    expect(valid([1, null])).toEqual(["Stage 1 is not a stage.", "Stage 2 is not a stage."]);
    expect(valid([stage("credentialing", "any", "Credentialing"), null])).toContain(
      "Stage 2 is not a stage.",
    );
    expect(valid("abc")).toEqual(["The stages must be a list."]);
    expect(valid({})).toEqual(["The stages must be a list."]);
    expect(valid([{}])).toEqual([
      "Stage 1: the key must start with a lowercase letter and use only lowercase letters, digits and underscores.",
      "Stage 1: add a label.",
      "Stage 1: add a description.",
      'Stage 1: "undefined" is not a gate on the menu.',
    ]);
  });
});

describe("resolveOnboardingFunnelRules", () => {
  it("defaults to today's behaviour", () => {
    expect(DEFAULT_ONBOARDING_FUNNEL_RULES).toEqual({
      caseStatusesNotCountedAsCredentialing: [],
      statelessLocationHolds: true,
      futureMembershipCounts: true,
      locationMustBeInProviderGroup: true,
      assignmentRequiredForReady: true,
    });
    expect(resolveOnboardingFunnelRules()).toEqual(DEFAULT_ONBOARDING_FUNNEL_RULES);
    expect(resolveOnboardingFunnelRules(null, null)).toEqual(DEFAULT_ONBOARDING_FUNNEL_RULES);
    expect(Object.isFrozen(DEFAULT_ONBOARDING_FUNNEL_RULES)).toBe(true);
  });

  it("takes the organization's value, else the platform's, else the default, field by field", () => {
    const platform: OnboardingFunnelRules = {
      caseStatusesNotCountedAsCredentialing: ["not_pursuing"],
      statelessLocationHolds: false,
      futureMembershipCounts: false,
      locationMustBeInProviderGroup: false,
      assignmentRequiredForReady: false,
    };
    expect(resolveOnboardingFunnelRules(platform)).toEqual(platform);
    expect(
      resolveOnboardingFunnelRules(platform, {
        futureMembershipCounts: true,
        assignmentRequiredForReady: true,
      }),
    ).toEqual({ ...platform, futureMembershipCounts: true, assignmentRequiredForReady: true });
    expect(
      resolveOnboardingFunnelRules(
        { statelessLocationHolds: false },
        { futureMembershipCounts: false },
      ),
    ).toEqual({ ...DEFAULT, statelessLocationHolds: false, futureMembershipCounts: false });
  });

  it("inherits on null or undefined, but not on false or an empty list", () => {
    const platform = {
      caseStatusesNotCountedAsCredentialing: ["denied"] as CaseStatus[],
      statelessLocationHolds: false,
    };
    expect(
      resolveOnboardingFunnelRules(platform, {
        caseStatusesNotCountedAsCredentialing: null,
        statelessLocationHolds: undefined,
        futureMembershipCounts: null,
      }),
    ).toEqual({ ...DEFAULT, ...platform });
    expect(
      resolveOnboardingFunnelRules(platform, {
        caseStatusesNotCountedAsCredentialing: [],
        futureMembershipCounts: false,
      }),
    ).toEqual({
      ...DEFAULT,
      caseStatusesNotCountedAsCredentialing: [],
      statelessLocationHolds: false,
      futureMembershipCounts: false,
    });
    expect(
      resolveOnboardingFunnelRules(
        { statelessLocationHolds: true },
        { statelessLocationHolds: false },
      ).statelessLocationHolds,
    ).toBe(false);
  });

  it("skips a stored value of the wrong shape, as if it were missing", () => {
    const stored = {
      caseStatusesNotCountedAsCredentialing: ["withdrawn"],
      statelessLocationHolds: "no",
      locationMustBeInProviderGroup: false,
    } as unknown as OnboardingFunnelRules;
    expect(resolveOnboardingFunnelRules({ futureMembershipCounts: false }, stored)).toEqual({
      ...DEFAULT,
      futureMembershipCounts: false,
      locationMustBeInProviderGroup: false,
    });
    expect(resolveOnboardingFunnelRules("abc" as unknown as OnboardingFunnelRules, null)).toEqual(
      DEFAULT,
    );
  });

  it("returns its own de-duplicated status list", () => {
    const list: CaseStatus[] = ["denied", "denied", "not_pursuing"];
    const resolved = resolveOnboardingFunnelRules({ caseStatusesNotCountedAsCredentialing: list });
    expect(resolved.caseStatusesNotCountedAsCredentialing).toEqual(["denied", "not_pursuing"]);
    expect(resolved.caseStatusesNotCountedAsCredentialing).not.toBe(list);
    expect(resolveOnboardingFunnelRules().caseStatusesNotCountedAsCredentialing).not.toBe(
      DEFAULT_ONBOARDING_FUNNEL_RULES.caseStatusesNotCountedAsCredentialing,
    );
  });
});

describe("resolveOnboardingFunnelConfig", () => {
  const custom: OnboardingFunnelStageConfig[] = [
    { key: "not_ready", label: "Not ready", description: "d", gate: "not_ready" },
    { key: "ready_for_credentialing", label: "Ready", description: "d", gate: "ready" },
    { key: "credentialing", label: "Credentialing", description: "d", gate: "has_case" },
  ];
  const broken: OnboardingFunnelStageConfig[] = [
    { key: "ready_for_credentialing", label: "Ready", description: "d", gate: "ready" },
  ];

  it("is the platform default when nothing overrides it", () => {
    expect(resolveOnboardingFunnelConfig()).toEqual(DEFAULT_ONBOARDING_FUNNEL_CONFIG);
    expect(resolveOnboardingFunnelConfig(null, null)).toEqual(DEFAULT_ONBOARDING_FUNNEL_CONFIG);
  });

  it("takes the organization's stages, else the platform's, and rules field by field", () => {
    const config = resolveOnboardingFunnelConfig(
      { stages: custom, rules: { statelessLocationHolds: false } },
      { rules: { futureMembershipCounts: false } },
    );
    expect(config.stages.map((s) => s.key)).toEqual(custom.map((s) => s.key));
    expect(config.rules).toEqual({
      ...DEFAULT,
      statelessLocationHolds: false,
      futureMembershipCounts: false,
    });
    expect(
      resolveOnboardingFunnelConfig(
        { stages: custom },
        { stages: DEFAULT_ONBOARDING_FUNNEL_STAGES },
      ).stages,
    ).toEqual(DEFAULT_ONBOARDING_FUNNEL_STAGES);
  });

  it("never lets a stage list that fails validation go live", () => {
    expect(resolveOnboardingFunnelConfig({ stages: custom }, { stages: broken }).stages).toEqual(
      custom,
    );
    expect(resolveOnboardingFunnelConfig({ stages: broken }, { stages: broken }).stages).toEqual(
      DEFAULT_ONBOARDING_FUNNEL_STAGES,
    );
    for (const stages of [[null], [1, null], [custom[0], null], "abc", {}, [{}]]) {
      const override = { stages } as unknown as OnboardingFunnelConfigOverride;
      expect(resolveOnboardingFunnelConfig(null, override).stages).toEqual(
        DEFAULT_ONBOARDING_FUNNEL_STAGES,
      );
      expect(
        visibleOnboardingFunnelStages({ stages, rules: DEFAULT } as OnboardingFunnelConfig, false),
      ).toHaveLength(5);
    }
  });

  it("copies only the stage fields, so the default cannot be changed through them", () => {
    const extra = custom.map((s) => ({ ...s, note: "stray" }));
    const config = resolveOnboardingFunnelConfig(null, { stages: extra });
    expect(config.stages[0]).toEqual(custom[0]);
    expect(config.stages[0]).not.toHaveProperty("note");
    const fallback = resolveOnboardingFunnelConfig();
    expect(fallback.stages[0]).not.toBe(DEFAULT_ONBOARDING_FUNNEL_STAGES[0]);
    expect(fallback.rules).not.toBe(DEFAULT_ONBOARDING_FUNNEL_RULES);
  });
});
