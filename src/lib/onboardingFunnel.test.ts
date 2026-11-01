import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAQH_ATTESTATION_WINDOW_DAYS,
  explainCaqhAttestationWindowDays,
} from "@/lib/caqhAttestation";
import { CASE_STATUSES, type CaseStatus } from "@/lib/caseStatus";
import {
  buildOnboardingFunnelRows,
  DEFAULT_ONBOARDING_FUNNEL_CONFIG,
  DEFAULT_ONBOARDING_FUNNEL_RULES,
  DEFAULT_ONBOARDING_FUNNEL_STAGES,
  effectiveOnboardingFunnelConfig,
  explainOnboardingFunnelConfig,
  INVITE_OUTSTANDING_TAG,
  MAX_ONBOARDING_FUNNEL_STAGES,
  ONBOARDING_FUNNEL_GATES,
  onboardingFunnelStageCounts,
  onboardingFunnelStates,
  NO_GROUP_GAP,
  ONBOARDING_FUNNEL_PROFILE_FIELDS,
  placeOnboardingFunnelStages,
  resolveOnboardingFunnelConfig,
  resolveOnboardingFunnelRules,
  STATELESS_LOCATION_GAP,
  validateOnboardingFunnelConfig,
  validateOnboardingFunnelOrganizationOverride,
  validateOnboardingFunnelPlatformOverride,
  visibleOnboardingFunnelStages,
  type OnboardingFunnelConfig,
  type OnboardingFunnelOrganizationOverride,
  type OnboardingFunnelPlatformOverride,
  type OnboardingFunnelDimensions,
  type OnboardingFunnelGate,
  type OnboardingFunnelInput,
  type OnboardingFunnelIntakeFacts,
  type OnboardingFunnelLocationInput,
  type OnboardingFunnelMembershipInput,
  type OnboardingFunnelProfileField,
  type OnboardingFunnelProviderFacts,
  type OnboardingFunnelRules,
  type OnboardingFunnelRulesOverride,
  type OnboardingFunnelStageConfig,
} from "@/lib/onboardingFunnel";

const TODAY = "2026-10-20";
const DEFAULT = DEFAULT_ONBOARDING_FUNNEL_RULES;
const CAQH = DEFAULT_CAQH_ATTESTATION_WINDOW_DAYS;
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
  assignmentStartDate: null,
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
  caqhAttestationWindowDays: CAQH,
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
    // A23: the missing group is a staff-side gap. Without a group, a
    // location under someone else's group is part of that gap too.
    expect(rowsOf(data).map((r) => [r.providerId, r.stage, r.gaps])).toEqual([
      ["both", "ready_for_credentialing", []],
      ["grouponly", "verified_awaiting_assignment", ["Needs a location"]],
      [
        "locationonly",
        "verified_awaiting_assignment",
        [NO_GROUP_GAP, "Location NC Clinic is under Rose City Rehab, not the provider's group"],
      ],
      ["neither", "verified_awaiting_assignment", ["Needs a location", NO_GROUP_GAP]],
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

  it("lists a stateless location next to the license gap, never the missing group", () => {
    const data = input();
    data.groupMemberships = [];
    data.locations = [at("ready", "nowhere")];
    data.licenses = [{ ...verified("ready", "NC"), verifiedStatus: "unverified" }];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "submitted",
      gaps: ["NC license not board-verified", STATELESS_LOCATION_GAP],
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
      at("nogroup", "NC", { groupId: null, groupName: null }),
      at("mismatch", "NC", underShelby),
      at("stateless", null),
      at("pending", "NC"),
    ];
    data.groupMemberships = [member("mismatch"), member("stateless"), member("pending")];
    data.cases = [];
    const rows = rowsOf(data);
    expect(rows.map((r) => [r.providerId, r.stage, r.gaps])).toEqual([
      // Their ungrouped location counts (A22); only the group is missing.
      ["nogroup", "verified_awaiting_assignment", [NO_GROUP_GAP]],
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
    // A23: a missing group is never listed as the provider's reason, and
    // without a group the location's mismatch is part of that staff gap.
    data.groupMemberships = [];
    expect(rowFor(data, "unverified")).toMatchObject({
      stage: "submitted",
      gaps: ["TX license not board-verified"],
    });
    expect(rowFor(data, "unverified")?.dimensions.groupGaps).toEqual([
      NO_GROUP_GAP,
      "Location TX Clinic is under Shelby Sports Rehab, not the provider's group",
    ]);
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

  it("lists a missing group as a staff-side gap, beside per-location reasons (A23)", () => {
    const data = input();
    data.groupMemberships = [];
    data.locations = [at("ready", "NC", { ...underShelby, locationName: "Austin" })];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: [
        NO_GROUP_GAP,
        "Location Austin is under Shelby Sports Rehab, not the provider's group",
      ],
    });
    // An ungrouped location counts for them too (A22): only the group is left.
    data.locations = [at("ready", "NC", { locationName: "Home", groupId: null, groupName: null })];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: [NO_GROUP_GAP],
    });
  });

  it("counts a location with no group for any provider by default (A22), and not when the rule is off", () => {
    const data = input();
    data.locations = [
      at("ready", "NC", { locationName: "Durham", groupId: null, groupName: null }),
    ];
    expect(rowFor(data, "ready")).toMatchObject({ stage: "ready_for_credentialing", gaps: [] });
    const off = resolveOnboardingFunnelRules(null, { ungroupedLocationCounts: false });
    expect(rowFor(data, "ready", off)).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Location Durham has no group"],
    });
    // A location under another group still never counts (A21).
    data.locations = [at("ready", "NC", { ...underShelby, locationName: "Austin" })];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Location Austin is under Shelby Sports Rehab, not the provider's group"],
    });
  });

  it("matches against any of several current groups", () => {
    const data = input();
    data.locations = [at("ready", "NC", underShelby)];
    data.groupMemberships = [member("ready"), member("ready", null, underShelby)];
    expect(rowFor(data, "ready")).toMatchObject({ stage: "ready_for_credentialing" });
  });
});

const DURHAM_MISMATCH = "Location Durham is under Rose City Rehab, not the provider's group";

describe("accurate reasons when the location's group is the provider's own", () => {
  // Fay is a current member of Shelby Sports Rehab; her only location is
  // under Rose City Rehab, where her membership does not count.
  function lapsed(rose: Partial<OnboardingFunnelMembershipInput>) {
    const data = input();
    data.locations = [at("ready", "NC", { locationName: "Durham" })];
    data.groupMemberships = [member("ready", null, underShelby), member("ready", null, rose)];
    return data;
  }

  // With a current group, staff see the location's mismatch and, beside it,
  // why her Rose membership does not count (A23: both staff-side here).
  it("says the membership ended", () => {
    expect(rowFor(lapsed({ endDate: "2026-10-01" }), "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: [DURHAM_MISMATCH, "Membership in Rose City Rehab ended 2026-10-01"],
    });
  });

  it("says when the membership starts, while future memberships do not count", () => {
    const off = resolveOnboardingFunnelRules(null, { futureMembershipCounts: false });
    const data = lapsed({ startDate: "2026-11-01" });
    expect(rowFor(data, "ready")).toMatchObject({ stage: "ready_for_credentialing" });
    expect(rowFor(data, "ready", off)).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: [DURHAM_MISMATCH, "Membership in Rose City Rehab starts 2026-11-01"],
    });
  });

  it("says the group is inactive", () => {
    expect(rowFor(lapsed({ groupActive: false }), "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: [DURHAM_MISMATCH, "Group Rose City Rehab is inactive"],
    });
  });

  it("never calls a group the read cannot see inactive", () => {
    const data = input();
    data.groupMemberships = [
      member("ready", null, { groupId: "g-unseen", groupName: null, groupActive: null }),
    ];
    data.locations = [at("ready", "NC", { groupId: "g-unseen", groupName: null })];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Membership group not found"],
    });
    // Beside a current group, the location's mismatch shows too.
    data.groupMemberships = [...data.groupMemberships, member("ready", null, underShelby)];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: [
        "Location NC Clinic is under another group, not the provider's group",
        "Membership group not found",
      ],
    });
    expect(rowFor(data, "ready")?.gaps.join(" ")).not.toMatch(/inactive/);
    // A known inactive group with no name on record still says only what is known.
    data.groupMemberships = [member("ready", null, { groupName: null, groupActive: false })];
    data.locations = [at("ready", "NC")];
    expect(rowFor(data, "ready")?.gaps).toEqual(["The provider's group is inactive"]);
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
      gaps: ["Needs a location", "Group Rose City Rehab is inactive"],
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
    // A current group is still needed either way, as a staff-side gap (A23).
    data.groupMemberships = [];
    expect(rowFor(data, "ready", off)).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: [NO_GROUP_GAP],
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
      gaps: ["Needs a location", NO_GROUP_GAP],
    });
    const row = rowFor(data, "ready", off);
    expect(row).toMatchObject({ stage: "ready_for_credentialing", gaps: [] });
    // The dimensions are still computed; they just do not hold her.
    expect(row?.dimensions).toMatchObject({
      assigned: false,
      assignmentGaps: ["Needs a location"],
      grouped: false,
      groupGaps: [NO_GROUP_GAP],
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
      assignmentGaps: ["Needs a location"],
      grouped: false,
      groupGaps: [NO_GROUP_GAP],
      statesValid: true,
      stateGaps: [],
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
      assignmentGaps: ["Needs a location"],
      grouped: false,
      groupGaps: [NO_GROUP_GAP],
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
      caqhAttestationWindowDays: 120,
    });
    expect(Object.isFrozen(DEFAULT_ONBOARDING_FUNNEL_STAGES[2])).toBe(true);
  });

  it("describes the stages without depending on a rule, and Submitted as complete, not sent", () => {
    const copy = Object.fromEntries(
      DEFAULT_ONBOARDING_FUNNEL_STAGES.map((s) => [s.label, s.description]),
    );
    expect(copy).toEqual({
      Invited: "Invited to the intake form. Nothing sent back yet.",
      // Neutral (A18): the required fields are a setting (A26).
      "Profile incomplete": "A required profile field is missing.",
      Submitted: "Information is complete but not yet verified.",
      "Verified, awaiting assignment":
        "Verified; the group, the location, or a location's record still needs attention.",
      "Ready for credentialing": "Meets every requirement for credentialing.",
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

  it("hides a stage no provider could reach under the rules in force", () => {
    const visible = (rules: OnboardingFunnelRulesOverride) =>
      visibleOnboardingFunnelStages(
        resolveOnboardingFunnelConfig(null, { rules }, CAQH),
        false,
      ).map((s) => s.key);
    // A24: the two rules are independent, so Verified, awaiting assignment is
    // hidden only when neither holds anyone.
    expect(visible({ assignmentRequiredForReady: false, statelessLocationHolds: false })).toEqual([
      "profile_incomplete",
      "submitted",
      "ready_for_credentialing",
      "credentialing",
    ]);
    expect(visible({ assignmentRequiredForReady: false })).toContain(
      "verified_awaiting_assignment",
    );
    expect(visible({ statelessLocationHolds: false })).toContain("verified_awaiting_assignment");
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
    const config = resolveOnboardingFunnelConfig(
      null,
      {
        stageText: {
          submitted: { label: "Complete, not verified", description: "Waiting on verification." },
        },
      },
      CAQH,
    );
    const rows = buildOnboardingFunnelRows(input(), TODAY, config);
    expect(rows.map((r) => r.stage)).toEqual(rowsOf(input()).map((r) => r.stage));
    expect(visibleOnboardingFunnelStages(config, false)[1]).toMatchObject({
      key: "submitted",
      label: "Complete, not verified",
    });
  });

  it("lets Minted merge stages with a menu gate, listing every gap", () => {
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
    const config = resolveOnboardingFunnelConfig({ stages }, null, CAQH);
    expect(config.stages.map((s) => s.key)).toEqual(stages.map((s) => s.key));
    const data = input();
    data.groupMemberships = data.groupMemberships.filter((m) => m.providerId !== "unverified");
    const rows = buildOnboardingFunnelRows(data, TODAY, config);
    // A25: the merged view lists every gap, the staff-side group gap included.
    expect(rows.find((r) => r.providerId === "unverified")).toMatchObject({
      stage: "not_ready",
      gaps: [
        "TX license not board-verified",
        NO_GROUP_GAP,
        "Location tx Clinic is under Rose City Rehab, not the provider's group",
      ],
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
    const rows = buildOnboardingFunnelRows(input(), TODAY, {
      stages,
      rules: DEFAULT,
      caqhAttestationWindowDays: CAQH,
    });
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
      const rows = buildOnboardingFunnelRows(input(), TODAY, {
        stages,
        rules: DEFAULT,
        caqhAttestationWindowDays: CAQH,
      });
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

  /** Every combination of the dimensions the gates read. */
  function everyDimension(): OnboardingFunnelDimensions[] {
    const all: OnboardingFunnelDimensions[] = [];
    for (const complete of flags)
      for (const verified of flags)
        for (const assigned of flags)
          for (const grouped of flags)
            for (const statesValid of flags)
              for (const hasCountedCase of flags)
                for (const intake of intakes)
                  all.push({
                    complete,
                    completenessGaps: complete ? [] : ["No NPI"],
                    verified,
                    verificationGaps: verified ? [] : ["Record pending verification"],
                    assigned,
                    assignmentGaps: assigned ? [] : ["Needs a location"],
                    grouped,
                    groupGaps: grouped ? [] : [NO_GROUP_GAP],
                    statesValid,
                    stateGaps: statesValid ? [] : [STATELESS_LOCATION_GAP],
                    hasCase: hasCountedCase,
                    caseCount: hasCountedCase ? 1 : 0,
                    caseStatuses: hasCountedCase ? ["in_progress"] : [],
                    hasCountedCase,
                    intake,
                  });
    return all;
  }

  /** The PM's placement, written out plainly (D61 to D76, A23, A24, A28). */
  function expectedStage(d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules): string {
    if (d.hasCountedCase) return "credentialing";
    const invited = d.intake?.invited === true && !d.intake.intakeSubmitted;
    if (invited && (!rules.completeRecordMovesPastInvite || !d.complete)) return "invited";
    if (!d.complete) return "profile_incomplete";
    if (!d.verified) return "submitted";
    const assignmentHeld = rules.assignmentRequiredForReady && (!d.assigned || !d.grouped);
    const stateHeld = rules.statelessLocationHolds && !d.statesValid;
    if (assignmentHeld || stateHeld) return "verified_awaiting_assignment";
    return "ready_for_credentialing";
  }

  // Every combination, no sampling: 256 dimension combinations under 1,024
  // rule combinations, 262,144 placements. Each rule combination is set up
  // once (one validation, one visible-stage read, one batch placement), and
  // each placement is checked in plain code with the problems collected, so
  // a failure still names every bad placement. With one expect per placement
  // this took about 3 s locally and 16 s on CI (run 41282244702, Nov 1),
  // past vitest's 5 s default. It now takes under 1 s locally; the explicit
  // 60 s timeout keeps headroom for a CI runner about 5 times slower.
  it(
    "places every combination of dimensions in exactly one visible stage, under every rule",
    { timeout: 60_000 },
    () => {
      const dimensions = everyDimension();
      const problems: string[] = [];
      let checked = 0;
      for (const licenseWithoutExpiryHolds of flags)
        for (const statelessLocationHolds of flags)
          for (const assignmentRequiredForReady of flags)
            for (const futureMembershipCounts of flags)
              for (const futureLocationAssignmentCounts of flags)
                for (const locationMustBeInProviderGroup of flags)
                  for (const ungroupedLocationCounts of flags)
                    for (const completeRecordMovesPastInvite of flags)
                      for (const caseStatusesNotCountedAsCredentialing of [
                        [],
                        ["denied"],
                      ] as CaseStatus[][])
                        for (const requiredProfileFields of [
                          [...ONBOARDING_FUNNEL_PROFILE_FIELDS],
                          ["npi"],
                        ] as OnboardingFunnelProfileField[][]) {
                          const rules: OnboardingFunnelRules = {
                            caseStatusesNotCountedAsCredentialing,
                            requiredProfileFields,
                            licenseWithoutExpiryHolds,
                            statelessLocationHolds,
                            assignmentRequiredForReady,
                            futureMembershipCounts,
                            futureLocationAssignmentCounts,
                            locationMustBeInProviderGroup,
                            ungroupedLocationCounts,
                            completeRecordMovesPastInvite,
                          };
                          const label = JSON.stringify(rules);
                          const config = withRules(rules);
                          const invalid = validateOnboardingFunnelConfig(config);
                          if (invalid.length > 0) problems.push(`${label}: ${invalid.join(" ")}`);
                          // Read and unread from one call: unread is read
                          // without the intake-gated stages.
                          const shown = visibleOnboardingFunnelStages(config, true);
                          const visible = {
                            read: new Set(shown.map((s) => s.key)),
                            unread: new Set(
                              shown.filter((s) => !s.needsIntakeData).map((s) => s.key),
                            ),
                          };
                          const placed = placeOnboardingFunnelStages(dimensions, config);
                          dimensions.forEach((d, i) => {
                            const { stage, gaps } = placed[i];
                            const fail = (why: string) =>
                              problems.push(`${label} ${JSON.stringify(d)}: ${why}`);
                            const expected = expectedStage(d, rules);
                            if (stage !== expected)
                              fail(`placed in ${stage}, expected ${expected}`);
                            if (!visible[d.intake === null ? "unread" : "read"].has(stage))
                              fail(`placed in ${stage}, which is hidden`);
                            // A23: a missing group is never the provider's
                            // reason; it is listed under awaiting assignment.
                            if (stage === "submitted" && gaps.includes(NO_GROUP_GAP))
                              fail("Submitted lists the missing group");
                            if (
                              stage === "verified_awaiting_assignment" &&
                              gaps.includes(NO_GROUP_GAP) !==
                                (assignmentRequiredForReady && !d.grouped)
                            )
                              fail("awaiting assignment lists the missing group wrongly");
                            checked += 1;
                          });
                        }
      expect(problems).toEqual([]);
      expect(checked).toBe(1024 * 256);
    },
  );
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

  it("rejects a list that leaves some providers without a stage, under any value of a gate's rule", () => {
    // Review P2: this list validated before, and put an unassigned provider
    // with no case in Credentialing.
    const list = [
      stage("profile_incomplete", "incomplete", "Profile incomplete"),
      stage("submitted", "complete_unverified", "Submitted"),
      stage("ready_for_credentialing", "ready", "Ready for credentialing"),
      stage("credentialing", "has_case", "Credentialing"),
    ];
    const gap =
      'A provider who is complete, verified, with a location that counts, in a group, with a location missing its state, with no case, would fit no stage when Ready requires assignment; a location with no state holds; a complete record moves past Invited, and 6 other kinds of provider would too. Add a stage for them, or end with an "everyone else" stage ("any").';
    expect(valid(list)).toEqual([gap]);
    // Even under rules that hold nobody: an organization's rules could, so
    // the list must hold under every combination of them (A24).
    expect(
      valid(list, { ...DEFAULT, assignmentRequiredForReady: false, statelessLocationHolds: false }),
    ).toEqual([gap]);
  });

  it("accepts a list whose last stage is reachable under only some values of the gates' rules", () => {
    // Everyone else catches the unassigned and the stateless while a rule
    // holds them; with both rules off, Ready takes them and Everyone else is
    // empty (hidden). The two rules are independent (A24).
    const list = [
      stage("incomplete", "incomplete", "Profile incomplete"),
      stage("submitted", "complete_unverified", "Submitted"),
      stage("ready", "ready", "Ready"),
      stage("cred", "has_case", "Credentialing"),
      stage("other", "any", "Everyone else"),
    ];
    expect(valid(list)).toEqual([]);
    expect(valid(list, { ...DEFAULT, assignmentRequiredForReady: false })).toEqual([]);
    const visible = (rules: Partial<OnboardingFunnelRules>) =>
      visibleOnboardingFunnelStages(
        { stages: list, rules: { ...DEFAULT, ...rules }, caqhAttestationWindowDays: CAQH },
        false,
      ).map((s) => s.key);
    expect(visible({ assignmentRequiredForReady: false, statelessLocationHolds: false })).toEqual([
      "incomplete",
      "submitted",
      "ready",
      "cred",
    ]);
    // Either rule on its own still holds someone, so Everyone else shows.
    expect(visible({ assignmentRequiredForReady: false })).toContain("other");
    expect(visible({ statelessLocationHolds: false })).toContain("other");
    expect(visible({})).toContain("other");
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
      requiredProfileFields: ["npi", "caqhId", "dateOfBirth", "ssnLast4", "stateLicense"],
      licenseWithoutExpiryHolds: true,
      statelessLocationHolds: true,
      assignmentRequiredForReady: true,
      futureMembershipCounts: true,
      futureLocationAssignmentCounts: true,
      locationMustBeInProviderGroup: true,
      ungroupedLocationCounts: true,
      completeRecordMovesPastInvite: true,
    });
    expect(resolveOnboardingFunnelRules()).toEqual(DEFAULT_ONBOARDING_FUNNEL_RULES);
    expect(resolveOnboardingFunnelRules(null, null)).toEqual(DEFAULT_ONBOARDING_FUNNEL_RULES);
    expect(Object.isFrozen(DEFAULT_ONBOARDING_FUNNEL_RULES)).toBe(true);
  });

  it("takes the organization's value, else the platform's, else the default, field by field", () => {
    const platform: OnboardingFunnelRules = {
      caseStatusesNotCountedAsCredentialing: ["not_pursuing"],
      requiredProfileFields: ["npi", "stateLicense"],
      licenseWithoutExpiryHolds: false,
      statelessLocationHolds: false,
      assignmentRequiredForReady: false,
      futureMembershipCounts: false,
      futureLocationAssignmentCounts: false,
      locationMustBeInProviderGroup: false,
      ungroupedLocationCounts: false,
      completeRecordMovesPastInvite: false,
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
  const MINTED = DEFAULT_ONBOARDING_FUNNEL_CONFIG;

  it("is the platform default when nothing overrides it", () => {
    expect(resolveOnboardingFunnelConfig(null, null, CAQH)).toEqual(
      DEFAULT_ONBOARDING_FUNNEL_CONFIG,
    );
    expect(resolveOnboardingFunnelConfig(null, null, CAQH)).toEqual(
      DEFAULT_ONBOARDING_FUNNEL_CONFIG,
    );
  });

  it("takes Minted's stage list, with an organization's labels, and rules field by field", () => {
    const config = resolveOnboardingFunnelConfig(
      { stages: custom, rules: { statelessLocationHolds: false } },
      {
        stageText: { not_ready: { label: "Still to do" } },
        rules: { futureMembershipCounts: false },
      },
      CAQH,
    );
    expect(config.stages).toEqual([
      { key: "not_ready", label: "Still to do", description: "d", gate: "not_ready" },
      custom[1],
      custom[2],
    ]);
    expect(config.rules).toEqual({
      ...DEFAULT,
      statelessLocationHolds: false,
      futureMembershipCounts: false,
    });
  });

  it("never lets an organization's rules replace Minted's stage list", () => {
    // Review P2 (probe3 A): Minted's five stages, and an organization that
    // turns off assignment for Ready and relabels Everyone else.
    const minted: OnboardingFunnelStageConfig[] = [
      { key: "incomplete", label: "Profile incomplete", description: "d", gate: "incomplete" },
      { key: "submitted", label: "Submitted", description: "d", gate: "complete_unverified" },
      { key: "ready", label: "Ready", description: "d", gate: "ready" },
      { key: "cred", label: "Credentialing", description: "d", gate: "has_case" },
      { key: "other", label: "Everyone else", description: "d", gate: "any" },
    ];
    const org: OnboardingFunnelOrganizationOverride = {
      rules: { assignmentRequiredForReady: false, statelessLocationHolds: false },
      stageText: { other: { label: "Others" } },
    };
    const mintedConfig = resolveOnboardingFunnelConfig({ stages: minted }, null, CAQH);
    expect(validateOnboardingFunnelOrganizationOverride(org, mintedConfig)).toEqual([]);
    const config = resolveOnboardingFunnelConfig({ stages: minted }, org, CAQH);
    expect(config.stages.map((s) => [s.key, s.gate, s.label])).toEqual([
      ["incomplete", "incomplete", "Profile incomplete"],
      ["submitted", "complete_unverified", "Submitted"],
      ["ready", "ready", "Ready"],
      ["cred", "has_case", "Credentialing"],
      ["other", "any", "Others"],
    ]);
    expect(config.rules.assignmentRequiredForReady).toBe(false);
    // The organization's rules empty Everyone else, so it is hidden: intended.
    // (Either rule left on would still hold someone there, A24.)
    expect(visibleOnboardingFunnelStages(config, false).map((s) => s.key)).toEqual([
      "incomplete",
      "submitted",
      "ready",
      "cred",
    ]);
  });

  it("reports rules that would break Minted's list, and then applies none of the layer", () => {
    // Only reachable when the caller passes a list that is not valid on its
    // own; the save path must pass Minted's resolved configuration.
    const org: OnboardingFunnelOrganizationOverride = {
      rules: { assignmentRequiredForReady: true },
      stageText: { ready_for_credentialing: { label: "Go" } },
    };
    const errors = validateOnboardingFunnelOrganizationOverride(org, {
      stages: broken,
      rules: DEFAULT,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.every((e) => e.startsWith("With this organization's rules, Minted's stages fail: ")),
    ).toBe(true);
  });

  it("lets an organization rename and re-describe stages, but never reorder or re-gate them", () => {
    const org: OnboardingFunnelOrganizationOverride = {
      stageText: {
        credentialing: { label: "With payers", description: "A case is open with a payer." },
        submitted: { description: "Complete; verification is next." },
      },
    };
    const config = resolveOnboardingFunnelConfig(null, org, CAQH);
    expect(config.stages.map((s) => [s.key, s.gate])).toEqual(
      DEFAULT_ONBOARDING_FUNNEL_STAGES.map((s) => [s.key, s.gate]),
    );
    expect(config.stages[5]).toMatchObject({
      label: "With payers",
      description: "A case is open with a payer.",
    });
    expect(config.stages[2]).toMatchObject({
      label: "Submitted",
      description: "Complete; verification is next.",
    });
    // A reordered list from an organization is refused, and changes nothing.
    const reordered = {
      stages: [...DEFAULT_ONBOARDING_FUNNEL_STAGES].reverse(),
    } as unknown as OnboardingFunnelOrganizationOverride;
    expect(validateOnboardingFunnelOrganizationOverride(reordered, MINTED)).toEqual([
      "An organization cannot change the stage list: Minted sets the stages, their order and their gates. Change labels and descriptions instead.",
    ]);
    expect(resolveOnboardingFunnelConfig(null, reordered, CAQH)).toEqual(
      DEFAULT_ONBOARDING_FUNNEL_CONFIG,
    );
  });

  it("applies an organization's layer whole or not at all, rules included", () => {
    const withList = {
      stages: custom,
      rules: { assignmentRequiredForReady: false },
    } as unknown as OnboardingFunnelOrganizationOverride;
    expect(resolveOnboardingFunnelConfig(null, withList, CAQH)).toEqual(
      DEFAULT_ONBOARDING_FUNNEL_CONFIG,
    );
    // Probe3 G: good copy and a good rule beside an unknown rule key.
    const mixed = {
      stageText: { submitted: { label: "S2" } },
      rules: { futureMembershipCounts: false, bogus: 1 },
    } as unknown as OnboardingFunnelOrganizationOverride;
    expect(validateOnboardingFunnelOrganizationOverride(mixed, MINTED)).toEqual([
      '"bogus" is not a funnel rule.',
    ]);
    const config = resolveOnboardingFunnelConfig(null, mixed, CAQH);
    expect(config.stages[2].label).toBe("Submitted");
    expect(config.rules.futureMembershipCounts).toBe(true);
  });

  it("refuses an organization's copy for a stage Minted does not have, whole", () => {
    const org: OnboardingFunnelOrganizationOverride = {
      stageText: {
        submitted: { label: "Complete, not verified" },
        on_hold: { label: "On hold" },
      },
    };
    expect(validateOnboardingFunnelOrganizationOverride(org, MINTED)).toEqual([
      '"on_hold" is not one of Minted\'s stages, so it cannot be relabelled.',
    ]);
    // Not even the valid part goes live: Minted's copy stays.
    expect(resolveOnboardingFunnelConfig(null, org, CAQH).stages).toEqual(
      DEFAULT_ONBOARDING_FUNNEL_STAGES,
    );
    // Checked against Minted's list, not the default one.
    expect(
      validateOnboardingFunnelOrganizationOverride(
        { stageText: { not_ready: { label: "x" } } },
        { stages: custom, rules: DEFAULT },
      ),
    ).toEqual([]);
  });

  it("refuses a label that is another stage's own label, so stages cannot swap names", () => {
    const swap: OnboardingFunnelOrganizationOverride = {
      stageText: {
        submitted: { label: "Ready for credentialing" },
        ready_for_credentialing: { label: "Submitted" },
      },
    };
    expect(validateOnboardingFunnelOrganizationOverride(swap, MINTED)).toEqual([
      '"submitted": "Ready for credentialing" is Minted\'s label for "ready_for_credentialing".',
      '"ready_for_credentialing": "Submitted" is Minted\'s label for "submitted".',
    ]);
    expect(resolveOnboardingFunnelConfig(null, swap, CAQH).stages).toEqual(
      DEFAULT_ONBOARDING_FUNNEL_STAGES,
    );
    // Case and spaces do not get around it, and a hidden stage's label counts.
    expect(
      validateOnboardingFunnelOrganizationOverride(
        { stageText: { submitted: { label: "  ready FOR credentialing " } } },
        MINTED,
      ),
    ).toHaveLength(1);
    expect(
      validateOnboardingFunnelOrganizationOverride(
        { stageText: { submitted: { label: "Invited" } } },
        MINTED,
      ),
    ).toEqual(['"submitted": "Invited" is Minted\'s label for "invited".']);
  });

  it("checks an organization's labels, descriptions and rules", () => {
    const org = {
      stageText: {
        submitted: { label: " ", gate: "ready" },
        invited: { label: "x".repeat(61), description: "" },
        credentialing: { label: "With payers" },
        verified_awaiting_assignment: { label: "With Payers" },
        profile_incomplete: "Missing things",
      },
      rules: { statelessLocationHolds: "no", showDenied: true },
    } as unknown as OnboardingFunnelOrganizationOverride;
    expect(validateOnboardingFunnelOrganizationOverride(org, MINTED)).toEqual([
      '"submitted": only the label and the description can change.',
      '"submitted": the label cannot be empty.',
      '"invited": keep the label to 60 characters.',
      '"invited": the description cannot be empty.',
      '"profile_incomplete": give a label, a description, or both.',
      'The label "With payers" would be used twice.',
      'The rule "statelessLocationHolds" must be on or off.',
      '"showDenied" is not a funnel rule.',
    ]);
    expect(validateOnboardingFunnelOrganizationOverride(null, MINTED)).toEqual([]);
    expect(
      validateOnboardingFunnelOrganizationOverride(
        "abc" as unknown as OnboardingFunnelOrganizationOverride,
        MINTED,
      ),
    ).toEqual(["An organization's funnel settings must be an object."]);
  });

  it("ignores inherited keys in an organization's copy", () => {
    const proto = JSON.parse(
      '{"stageText": {"__proto__": {"label": "x"}, "submitted": {"label": "S2"}}}',
    ) as OnboardingFunnelOrganizationOverride;
    expect(validateOnboardingFunnelOrganizationOverride(proto, MINTED)).toEqual([
      '"__proto__" is not one of Minted\'s stages, so it cannot be relabelled.',
    ]);
    expect(resolveOnboardingFunnelConfig(null, proto, CAQH).stages[2].label).toBe("Submitted");
  });

  it("never lets a platform list that fails validation go live", () => {
    expect(resolveOnboardingFunnelConfig({ stages: broken }, null, CAQH).stages).toEqual(
      DEFAULT_ONBOARDING_FUNNEL_STAGES,
    );
    for (const stages of [[null], [1, null], [custom[0], null], "abc", {}, [{}]]) {
      const platform = { stages } as unknown as OnboardingFunnelPlatformOverride;
      expect(resolveOnboardingFunnelConfig(platform, null, CAQH).stages).toEqual(
        DEFAULT_ONBOARDING_FUNNEL_STAGES,
      );
      expect(
        visibleOnboardingFunnelStages({ stages, rules: DEFAULT } as OnboardingFunnelConfig, false),
      ).toHaveLength(5);
    }
  });

  it("copies only the stage fields, so the default cannot be changed through them", () => {
    const extra = custom.map((s) => ({ ...s, note: "stray" }));
    const config = resolveOnboardingFunnelConfig({ stages: extra }, null, CAQH);
    expect(config.stages[0]).toEqual(custom[0]);
    expect(config.stages[0]).not.toHaveProperty("note");
    const fallback = resolveOnboardingFunnelConfig(
      null,
      {
        stageText: { submitted: { label: "Complete, not verified" } },
      },
      CAQH,
    );
    expect(fallback.stages[2]).not.toBe(DEFAULT_ONBOARDING_FUNNEL_STAGES[2]);
    expect(DEFAULT_ONBOARDING_FUNNEL_STAGES[2].label).toBe("Submitted");
    expect(fallback.rules).not.toBe(DEFAULT_ONBOARDING_FUNNEL_RULES);
  });
});

describe("stored keys that name built-in properties", () => {
  // Review P2 (2558313a): "__proto__" and "__defineGetter__" crashed the
  // organization validator, and "toString" and "constructor" passed as rules.
  const MINTED = DEFAULT_ONBOARDING_FUNNEL_CONFIG;
  const hostile = ["__proto__", "__defineGetter__", "toString", "constructor"];

  for (const key of hostile) {
    it(`reports "${key}" as an unknown rule in an organization's layer, and never crashes`, () => {
      const org = JSON.parse(`{"rules": {"${key}": true}}`) as OnboardingFunnelOrganizationOverride;
      expect(validateOnboardingFunnelOrganizationOverride(org, MINTED)).toEqual([
        `"${key}" is not a funnel rule.`,
      ]);
      expect(resolveOnboardingFunnelConfig(null, org, CAQH)).toEqual(
        DEFAULT_ONBOARDING_FUNNEL_CONFIG,
      );
    });

    it(`reports "${key}" as an unknown rule in Minted's layer, and never crashes`, () => {
      const platform = JSON.parse(
        `{"rules": {"${key}": true}}`,
      ) as OnboardingFunnelPlatformOverride;
      expect(validateOnboardingFunnelPlatformOverride(platform)).toEqual([
        `"${key}" is not a funnel rule.`,
      ]);
      expect(resolveOnboardingFunnelConfig(platform, null, CAQH)).toEqual(
        DEFAULT_ONBOARDING_FUNNEL_CONFIG,
      );
      // A whole configuration carrying the key is refused too, and the
      // funnel still runs on the default.
      const full: OnboardingFunnelConfig = {
        ...DEFAULT_ONBOARDING_FUNNEL_CONFIG,
        rules: JSON.parse(
          JSON.stringify(DEFAULT_ONBOARDING_FUNNEL_RULES).replace(/}$/, `,"${key}":true}`),
        ) as OnboardingFunnelRules,
      };
      expect(Object.hasOwn(full.rules, key)).toBe(true);
      expect(validateOnboardingFunnelConfig(full)).toEqual([`"${key}" is not a funnel rule.`]);
      expect(buildOnboardingFunnelRows(input(), TODAY, full).map((r) => r.stage)).toEqual(
        rowsOf(input()).map((r) => r.stage),
      );
    });
  }

  it("never reads a rule value from a prototype", () => {
    const inherited = Object.create({
      assignmentRequiredForReady: false,
    }) as OnboardingFunnelRulesOverride;
    expect(resolveOnboardingFunnelRules(null, inherited)).toEqual(DEFAULT);
    expect(resolveOnboardingFunnelRules(inherited, null)).toEqual(DEFAULT);
  });
});

describe("validateOnboardingFunnelPlatformOverride", () => {
  it("checks Minted's rules and stage list", () => {
    expect(validateOnboardingFunnelPlatformOverride(null)).toEqual([]);
    expect(
      validateOnboardingFunnelPlatformOverride({
        stages: [...DEFAULT_ONBOARDING_FUNNEL_STAGES],
        rules: { assignmentRequiredForReady: false },
      }),
    ).toEqual([]);
    expect(
      validateOnboardingFunnelPlatformOverride(
        "abc" as unknown as OnboardingFunnelPlatformOverride,
      ),
    ).toEqual(["Minted's funnel settings must be an object."]);
    expect(
      validateOnboardingFunnelPlatformOverride({
        rules: { statelessLocationHolds: "no" } as unknown as OnboardingFunnelRulesOverride,
      }),
    ).toEqual(['The rule "statelessLocationHolds" must be on or off.']);
    expect(
      validateOnboardingFunnelPlatformOverride({
        stages: [
          { key: "ready_for_credentialing", label: "Ready", description: "d", gate: "ready" },
        ],
      }),
    ).toHaveLength(1);
  });
});

describe("Oct 31 answers (Addendum 8)", () => {
  it("A24: assignment and the no-state hold are independent settings", () => {
    const data = input();
    // Fay: a stateless location next to a valid one, in her group.
    data.locations = [at("ready", null), at("ready", "NC")];
    const assignmentOff = resolveOnboardingFunnelRules(null, { assignmentRequiredForReady: false });
    expect(rowFor(data, "ready", assignmentOff)).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: [STATELESS_LOCATION_GAP],
    });
    // No location at all, with the no-state hold off: assignment still holds.
    data.locations = [];
    data.licenses = [verified("ready", "NC")];
    const statelessOff = resolveOnboardingFunnelRules(null, { statelessLocationHolds: false });
    expect(rowFor(data, "ready", statelessOff)).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Needs a location"],
    });
  });

  it("A26: the fields that make a profile complete are a setting", () => {
    const data = input();
    data.providers = [
      { ...complete("ready", "Fay Ready"), dobPresent: false, ssnLast4Present: false },
    ];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "profile_incomplete",
      gaps: ["No date of birth", "No SSN last 4"],
    });
    const fewer = resolveOnboardingFunnelRules(null, {
      requiredProfileFields: ["stateLicense", "npi", "caqhId"],
    });
    expect(fewer.requiredProfileFields).toEqual(["npi", "caqhId", "stateLicense"]);
    expect(rowFor(data, "ready", fewer)).toMatchObject({ stage: "ready_for_credentialing" });
    // Without a required license, a provider with none is complete.
    data.licenses = [];
    const noLicense = resolveOnboardingFunnelRules(null, { requiredProfileFields: ["npi"] });
    expect(rowFor(data, "ready", noLicense)?.dimensions.complete).toBe(true);
  });

  it("A26: CAQH attestation is held only when a CAQH ID is required or on file", () => {
    const data = input();
    data.providers = [
      { ...complete("ready", "Fay Ready"), caqhIdPresent: false, caqhLastAttestedDate: null },
    ];
    const noCaqh = resolveOnboardingFunnelRules(null, {
      requiredProfileFields: ["npi", "dateOfBirth", "ssnLast4", "stateLicense"],
    });
    expect(rowFor(data, "ready", noCaqh)).toMatchObject({ stage: "ready_for_credentialing" });
    // A CAQH ID on file is still attested, required or not.
    data.providers = [{ ...complete("ready", "Fay Ready"), caqhLastAttestedDate: null }];
    expect(rowFor(data, "ready", noCaqh)).toMatchObject({
      stage: "submitted",
      gaps: ["CAQH never attested"],
    });
  });

  it("A26: the CAQH window is the shared setting the configuration carries", () => {
    const data = input();
    // Attested 2026-09-01: 49 days before TODAY.
    const withWindow = (days: number): OnboardingFunnelConfig => ({
      ...withRules(DEFAULT),
      caqhAttestationWindowDays: days,
    });
    expect(
      buildOnboardingFunnelRows(data, TODAY, withWindow(30)).find((r) => r.providerId === "ready"),
    ).toMatchObject({ stage: "submitted", gaps: ["CAQH attestation older than 30 days"] });
    expect(
      buildOnboardingFunnelRows(data, TODAY, withWindow(60)).find((r) => r.providerId === "ready"),
    ).toMatchObject({ stage: "ready_for_credentialing" });
    expect(resolveOnboardingFunnelConfig(null, null, 45).caqhAttestationWindowDays).toBe(45);
    // A bad value never runs: the platform default does.
    expect(resolveOnboardingFunnelConfig(null, null, 0).caqhAttestationWindowDays).toBe(120);
  });

  it("A26: a license with no expiry is not current by default, and counts when the rule is off", () => {
    const data = input();
    data.licenses = [{ ...verified("ready", "NC"), expirationDate: null }];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "submitted",
      gaps: ["NC license has no expiration date"],
    });
    const off = resolveOnboardingFunnelRules(null, { licenseWithoutExpiryHolds: false });
    expect(rowFor(data, "ready", off)).toMatchObject({ stage: "ready_for_credentialing" });
    // With the rule off, a no-expiry license outranks an expired one.
    data.licenses = [
      { ...verified("ready", "NC"), expirationDate: "2025-01-01" },
      { ...verified("ready", "NC"), expirationDate: null },
    ];
    expect(rowFor(data, "ready", off)).toMatchObject({ stage: "ready_for_credentialing" });
    expect(rowFor(data, "ready")).toMatchObject({ gaps: ["NC license expired"] });
  });

  it("A27: future-dated location assignments count by default, and not when the rule is off", () => {
    const off = resolveOnboardingFunnelRules(null, { futureLocationAssignmentCounts: false });
    const data = input();
    data.locations = [
      at("ready", "NC", { locationName: "Durham", assignmentStartDate: "2026-11-01" }),
    ];
    expect(rowFor(data, "ready")).toMatchObject({ stage: "ready_for_credentialing" });
    expect(rowFor(data, "ready", off)).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Assignment to Durham starts 2026-11-01"],
    });
    // Started today, or no start date: counts either way.
    for (const assignmentStartDate of [TODAY, null]) {
      data.locations = [at("ready", "NC", { assignmentStartDate })];
      expect(rowFor(data, "ready", off)).toMatchObject({ stage: "ready_for_credentialing" });
    }
    // A separate setting from future-dated memberships.
    expect(off.futureMembershipCounts).toBe(true);
  });

  it("A28: a complete record moves past Invited, with the invite as a tag", () => {
    const data = input();
    data.intakeReadable = true;
    data.intake = [
      { providerId: "ready", intakeSubmitted: false },
      { providerId: "missing", intakeSubmitted: false },
      { providerId: "enrolling", intakeSubmitted: false },
    ];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "ready_for_credentialing",
      tags: [INVITE_OUTSTANDING_TAG],
    });
    // An incomplete record still sits in Invited, with no tag.
    expect(rowFor(data, "missing")).toMatchObject({ stage: "invited", tags: [] });
    // A case wins, and the invite still shows.
    expect(rowFor(data, "enrolling")).toMatchObject({
      stage: "credentialing",
      tags: [INVITE_OUTSTANDING_TAG],
    });
    // The precedence is a setting: off, Invited outranks the complete record.
    const off = resolveOnboardingFunnelRules(null, { completeRecordMovesPastInvite: false });
    expect(rowFor(data, "ready", off)).toMatchObject({ stage: "invited", tags: [] });
    // While intake cannot be read, nobody is tagged.
    data.intakeReadable = false;
    expect(rowsOf(data).every((r) => r.tags.length === 0)).toBe(true);
  });

  it("A29: nothing checks or warns on label wording", () => {
    const worded = DEFAULT_ONBOARDING_FUNNEL_STAGES.map((s) =>
      s.key === "submitted" ? { ...s, label: "Sent to payer", description: "Transmitted." } : s,
    );
    expect(validateOnboardingFunnelConfig({ stages: worded, rules: DEFAULT })).toEqual([]);
    expect(
      validateOnboardingFunnelOrganizationOverride(
        { stageText: { submitted: { label: "Submitted to payer" } } },
        DEFAULT_ONBOARDING_FUNNEL_CONFIG,
      ),
    ).toEqual([]);
  });
});

describe("A19: explainOnboardingFunnelConfig says which layer was ignored and why", () => {
  const broken: OnboardingFunnelStageConfig[] = [
    { key: "ready_for_credentialing", label: "Ready", description: "d", gate: "ready" },
  ];

  it("reports nothing when every stored layer was used", () => {
    expect(explainOnboardingFunnelConfig(null, null, CAQH)).toEqual({
      config: DEFAULT_ONBOARDING_FUNNEL_CONFIG,
      ignored: [],
    });
    const used = explainOnboardingFunnelConfig(
      { rules: { futureMembershipCounts: false } },
      { stageText: { submitted: { label: "Complete" } } },
      CAQH,
    );
    expect(used.ignored).toEqual([]);
    expect(used.config.stages[2].label).toBe("Complete");
  });

  it("reports an invalid organization layer, which falls back to Minted's setup", () => {
    const org = {
      stageText: { submitted: { label: "Complete" } },
      rules: { statelessLocationHolds: "no" },
    } as unknown as OnboardingFunnelOrganizationOverride;
    const result = explainOnboardingFunnelConfig(
      { rules: { futureMembershipCounts: false } },
      org,
      CAQH,
    );
    expect(result.ignored).toEqual([
      {
        layer: "organization",
        part: "layer",
        reasons: ['The rule "statelessLocationHolds" must be on or off.'],
      },
    ]);
    // Minted's setup ran: its rule, and none of the organization's copy.
    expect(result.config.rules.futureMembershipCounts).toBe(false);
    expect(result.config.stages[2].label).toBe("Submitted");
  });

  it("reports an invalid platform stage list or rule, which fall back to the default", () => {
    const platform = {
      stages: broken,
      rules: { ungroupedLocationCounts: "yes", bogus: 1 },
    } as unknown as OnboardingFunnelPlatformOverride;
    const result = explainOnboardingFunnelConfig(platform, null, CAQH);
    expect(result.ignored).toEqual([
      {
        layer: "platform",
        part: "rules",
        reasons: [
          'The rule "ungroupedLocationCounts" must be on or off.',
          '"bogus" is not a funnel rule.',
        ],
      },
      {
        layer: "platform",
        part: "stages",
        reasons: [expect.stringContaining("would fit no stage")],
      },
    ]);
    expect(result.config.stages).toEqual(DEFAULT_ONBOARDING_FUNNEL_STAGES);
    expect(result.config.rules).toEqual(DEFAULT);
    expect(
      explainOnboardingFunnelConfig(
        "abc" as unknown as OnboardingFunnelPlatformOverride,
        null,
        CAQH,
      ).ignored,
    ).toEqual([
      {
        layer: "platform",
        part: "layer",
        reasons: ["Minted's funnel settings must be an object."],
      },
    ]);
  });

  it("matches resolveOnboardingFunnelConfig", () => {
    const platform = { stages: broken };
    const org = { stageText: { submitted: { label: "Complete" } } };
    expect(resolveOnboardingFunnelConfig(platform, org, CAQH)).toEqual(
      explainOnboardingFunnelConfig(platform, org, CAQH).config,
    );
  });
});

describe("A23: a group problem is never the provider's reason (review of 209c1dfd)", () => {
  // Bea: complete but pending verification, so she sits in Submitted. Her
  // only membership and her only location are in Rose City Rehab.
  function pendingAtRose(membership: Partial<OnboardingFunnelMembershipInput> | null) {
    const data = input();
    data.providers = [{ ...complete("bea", "Bea Pending"), pendingVerification: true }];
    data.licenses = [verified("bea", "NC")];
    data.locations = [at("bea", "NC", { locationName: "Durham" })];
    data.groupMemberships = membership ? [member("bea", null, membership)] : [];
    data.cases = [];
    return data;
  }

  const cases: Array<{
    name: string;
    membership: Partial<OnboardingFunnelMembershipInput> | null;
    rules?: OnboardingFunnelRules;
    staff: string[];
  }> = [
    {
      name: "a membership that ended",
      membership: { endDate: "2026-10-01" },
      staff: ["Membership in Rose City Rehab ended 2026-10-01"],
    },
    {
      name: "an inactive group",
      membership: { groupActive: false },
      staff: ["Group Rose City Rehab is inactive"],
    },
    {
      name: "a group the read cannot see",
      membership: { groupActive: null, groupName: null },
      staff: ["Membership group not found"],
    },
    {
      name: "a membership that starts later, while future memberships do not count",
      membership: { startDate: "2026-12-01" },
      rules: resolveOnboardingFunnelRules(null, { futureMembershipCounts: false }),
      staff: ["Membership in Rose City Rehab starts 2026-12-01"],
    },
    {
      name: "no membership at all",
      membership: null,
      staff: [NO_GROUP_GAP, "Location Durham is under Rose City Rehab, not the provider's group"],
    },
  ];

  for (const { name, membership, rules = DEFAULT, staff } of cases) {
    it(`keeps ${name} out of Submitted and lists it for staff`, () => {
      const data = pendingAtRose(membership);
      const row = rowFor(data, "bea", rules);
      expect(row).toMatchObject({ stage: "submitted", gaps: ["Record pending verification"] });
      expect(row?.dimensions).toMatchObject({
        assigned: false,
        assignmentGaps: [],
        grouped: false,
        groupGaps: staff,
      });
      // Once verified, staff see it under Verified, awaiting assignment.
      data.providers = [complete("bea", "Bea Pending")];
      expect(rowFor(data, "bea", rules)).toMatchObject({
        stage: "verified_awaiting_assignment",
        gaps: staff,
      });
    });
  }

  for (const { name, membership, rules = DEFAULT, staff } of cases.filter((c) => c.membership)) {
    it(`keeps ${name} out of Submitted beside a current group, with the plain mismatch`, () => {
      // Bea is also a current member of Shelby Sports Rehab (review of bf0d3082).
      const data = pendingAtRose(membership);
      data.groupMemberships = [
        ...data.groupMemberships,
        member("bea", null, { ...underShelby, groupActive: true }),
      ];
      const mismatch = DURHAM_MISMATCH;
      const row = rowFor(data, "bea", rules);
      expect(row).toMatchObject({
        stage: "submitted",
        gaps: ["Record pending verification", mismatch],
      });
      expect(row?.dimensions).toMatchObject({
        assigned: false,
        assignmentGaps: [mismatch],
        grouped: true,
        groupGaps: staff,
      });
      // Verified, staff see both under awaiting assignment.
      data.providers = [complete("bea", "Bea Pending")];
      expect(rowFor(data, "bea", rules)).toMatchObject({
        stage: "verified_awaiting_assignment",
        gaps: [mismatch, ...staff],
      });
    });
  }

  it("keeps a real location mismatch for a provider who has a current group", () => {
    const data = pendingAtRose({ ...underShelby });
    expect(rowFor(data, "bea")).toMatchObject({
      stage: "submitted",
      gaps: [
        "Record pending verification",
        "Location Durham is under Rose City Rehab, not the provider's group",
      ],
    });
  });

  it("never shows a group gap in Submitted, across real records and rules", () => {
    // Every mix of membership and location below, verified or not, under
    // every on/off setting that shapes a membership or location reason.
    const memberships: Array<Array<Partial<OnboardingFunnelMembershipInput>>> = [
      [],
      [{}],
      [{ endDate: "2026-10-01" }],
      [{ groupActive: false }],
      [{ groupActive: null, groupName: null, groupId: "g-unseen" }],
      [{ startDate: "2026-12-01" }],
      [{ ...underShelby }, { endDate: "2026-10-01" }],
      [{ ...underShelby, startDate: "2026-12-01" }],
    ];
    const locations: Array<Array<Partial<OnboardingFunnelLocationInput>>> = [
      [],
      [{}],
      [{ ...underShelby }],
      [{ groupId: null, groupName: null }],
      [{ state: null }],
      [{ assignmentStartDate: "2026-12-01" }],
      [{}, { ...underShelby, state: "SC" }],
      [{ groupId: "g-unseen", groupName: null }],
    ];
    const flags = [true, false];
    let submitted = 0;
    for (const futureMembershipCounts of flags)
      for (const futureLocationAssignmentCounts of flags)
        for (const ungroupedLocationCounts of flags)
          for (const locationMustBeInProviderGroup of flags)
            for (const assignmentRequiredForReady of flags)
              for (const statelessLocationHolds of flags) {
                const rules: OnboardingFunnelRules = {
                  ...DEFAULT,
                  futureMembershipCounts,
                  futureLocationAssignmentCounts,
                  ungroupedLocationCounts,
                  locationMustBeInProviderGroup,
                  assignmentRequiredForReady,
                  statelessLocationHolds,
                };
                const providers: OnboardingFunnelProviderFacts[] = [];
                const licenses: OnboardingFunnelInput["licenses"][number][] = [];
                const groupMemberships: OnboardingFunnelMembershipInput[] = [];
                const locationRows: OnboardingFunnelLocationInput[] = [];
                memberships.forEach((ms, mi) =>
                  locations.forEach((ls, li) =>
                    [true, false].forEach((pending) => {
                      const id = `p-${mi}-${li}-${pending}`;
                      providers.push({ ...complete(id, id), pendingVerification: pending });
                      licenses.push(verified(id, "NC"), verified(id, "SC"));
                      ms.forEach((m) => groupMemberships.push(member(id, null, m)));
                      ls.forEach((l, i) =>
                        locationRows.push(
                          at(id, "NC", { locationId: `f-${id}-${i}`, locationName: `L${i}`, ...l }),
                        ),
                      );
                    }),
                  ),
                );
                const data: OnboardingFunnelInput = {
                  providers,
                  licenses,
                  locations: locationRows,
                  groupMemberships,
                  cases: [],
                  intakeReadable: false,
                };
                for (const row of rowsOf(data, rules)) {
                  if (row.stage !== "submitted") continue;
                  submitted += 1;
                  for (const gap of row.gaps) {
                    expect(row.dimensions.groupGaps).not.toContain(gap);
                    // No membership or group text, for anyone.
                    expect(gap).not.toMatch(
                      /^(Membership |Group |The provider's group|No group assigned)/,
                    );
                    // Without a current group, not even a location's mismatch.
                    if (!row.dimensions.grouped)
                      expect(gap).not.toMatch(/not the provider's group$/);
                  }
                }
              }
    expect(submitted).toBeGreaterThan(1000);
  });
});

describe("own-property reads and the CAQH window report (P3s)", () => {
  it("never applies copy or rules an organization layer only inherits", () => {
    const inherited = Object.create({
      stageText: { submitted: { label: "Hacked" } },
      rules: { assignmentRequiredForReady: false },
    }) as OnboardingFunnelOrganizationOverride;
    const result = explainOnboardingFunnelConfig(null, inherited, CAQH);
    expect(result.ignored).toEqual([]);
    expect(result.config).toEqual(DEFAULT_ONBOARDING_FUNNEL_CONFIG);
    // Own copy whose label is inherited is not applied either.
    const ownText = {
      stageText: { submitted: Object.create({ label: "Hacked" }) },
    } as unknown as OnboardingFunnelOrganizationOverride;
    expect(explainOnboardingFunnelConfig(null, ownText, CAQH).config.stages[2].label).toBe(
      "Submitted",
    );
  });

  it("never reads a stage field or a config field from a prototype", () => {
    const inheritedStage = Object.create({
      key: "submitted",
      label: "S",
      description: "d",
      gate: "any",
    }) as OnboardingFunnelStageConfig;
    expect(validateOnboardingFunnelConfig({ stages: [inheritedStage], rules: DEFAULT })).toContain(
      'Stage 1: "undefined" is not a gate on the menu.',
    );
    const inheritedConfig = Object.create({
      stages: [{ key: "a", label: "A", description: "d", gate: "any" }],
      rules: DEFAULT,
      caqhAttestationWindowDays: 30,
    }) as OnboardingFunnelConfig;
    const effective = effectiveOnboardingFunnelConfig(inheritedConfig);
    expect(effective.stages).toEqual(DEFAULT_ONBOARDING_FUNNEL_STAGES);
    expect(effective.caqhAttestationWindowDays).toBe(120);
  });

  it("reports an invalid CAQH window instead of silently using the default", () => {
    expect(explainCaqhAttestationWindowDays(90, 0)).toEqual({
      windowDays: 90,
      ignored: [
        {
          layer: "organization",
          reasons: ["The CAQH attestation window must be a whole number of days from 1 to 365."],
        },
      ],
    });
    expect(explainCaqhAttestationWindowDays("90", null)).toMatchObject({
      windowDays: 120,
      ignored: [{ layer: "platform" }],
    });
    expect(explainCaqhAttestationWindowDays(null, 45)).toEqual({ windowDays: 45, ignored: [] });
    expect(explainOnboardingFunnelConfig(null, null, 0)).toEqual({
      config: DEFAULT_ONBOARDING_FUNNEL_CONFIG,
      ignored: [
        {
          layer: "shared",
          part: "caqhAttestationWindowDays",
          reasons: ["The CAQH attestation window must be a whole number of days from 1 to 365."],
        },
      ],
    });
  });
});
