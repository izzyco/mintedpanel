import { describe, expect, it } from "vitest";
import { CASE_STATUSES, type CaseStatus } from "@/lib/caseStatus";
import {
  buildOnboardingFunnelRows,
  DEFAULT_ONBOARDING_FUNNEL_CONFIG,
  DEFAULT_ONBOARDING_FUNNEL_RULES,
  DEFAULT_ONBOARDING_FUNNEL_STAGES,
  ONBOARDING_FUNNEL_GATES,
  onboardingFunnelStageCounts,
  onboardingFunnelStates,
  resolveOnboardingFunnelConfig,
  resolveOnboardingFunnelRules,
  STATELESS_LOCATION_GAP,
  validateOnboardingFunnelConfig,
  visibleOnboardingFunnelStages,
  type OnboardingFunnelConfig,
  type OnboardingFunnelGate,
  type OnboardingFunnelInput,
  type OnboardingFunnelLocationInput,
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

const member = (
  providerId: string,
  endDate: string | null = null,
  over: { groupId?: string; startDate?: string | null } = {},
) => ({ providerId, groupId: GROUP, startDate: null, endDate, ...over });

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

  it("does not count a group membership that ended before today", () => {
    const data = input();
    data.groupMemberships = [member("ready", "2026-10-19")];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Needs a group"],
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
    // membership. Her only active location has no usable state, so there is
    // no working state to judge and no all-licenses fallback.
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

  it("lists a stateless location next to the other assignment gaps", () => {
    const data = input();
    data.groupMemberships = [];
    data.locations = [at("ready", "nowhere")];
    data.licenses = [{ ...verified("ready", "NC"), verifiedStatus: "unverified" }];
    // With a location there is no fallback, so the unverified NC license is
    // not judged: only the missing group and the missing state hold her.
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Needs a group", STATELESS_LOCATION_GAP],
    });
  });

  it("counts any case as Credentialing, even for an incomplete, unassigned profile", () => {
    const data = input();
    data.cases = [kase("missing", "TX")];
    expect(rowFor(data, "missing")).toMatchObject({ stage: "credentialing", gaps: [] });
  });

  it("flags never-attested CAQH and pending records, and lists states for the filter", () => {
    const data = input();
    data.providers = [
      { ...complete("ready", "Fay Ready"), caqhLastAttestedDate: null, pendingVerification: true },
    ];
    const rows = rowsOf(data);
    expect(rows[0]).toMatchObject({
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
    const data = input();
    expect(rowFor(data, "ready")).toMatchObject({ stage: "ready_for_credentialing", gaps: [] });
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

  it("says only 'Needs a group' when the provider has no current group at all", () => {
    const data = input();
    data.groupMemberships = [];
    data.locations = [at("ready", "NC", { ...underShelby, locationName: "Austin" })];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Needs a group"],
    });
  });

  it("names a location with no group, and one in a group whose membership ended", () => {
    const data = input();
    data.locations = [
      at("ready", "NC", { locationName: "Durham", groupId: null, groupName: null }),
      at("ready", "NC", { ...underShelby, locationName: "Austin" }),
    ];
    data.groupMemberships = [
      member("ready"),
      member("ready", "2026-10-01", { groupId: OTHER_GROUP }),
    ];
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: [
        "Location Austin is under Shelby Sports Rehab, not the provider's group",
        "Location Durham has no group",
      ],
    });
  });

  it("matches against any of several current groups", () => {
    const data = input();
    data.locations = [at("ready", "NC", underShelby)];
    data.groupMemberships = [member("ready"), member("ready", null, { groupId: OTHER_GROUP })];
    expect(rowFor(data, "ready")).toMatchObject({ stage: "ready_for_credentialing" });
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
    // The ignored case leaves Fay where her record puts her, and its state
    // no longer counts as one she touches.
    expect(rowFor(data, "ready", rules)).toMatchObject({
      stage: "ready_for_credentialing",
      states: ["NC", "SC"],
    });
    data.cases = [kase("ready", "CO", "denied"), kase("ready", "TX", "approved")];
    expect(rowFor(data, "ready", rules)).toMatchObject({
      stage: "credentialing",
      states: ["NC", "SC", "TX"],
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

  it("with the stateless rule off, judges every license when no location has a valid state", () => {
    const off = resolveOnboardingFunnelRules({ statelessLocationHolds: false });
    const data = input();
    data.licenses = [verified("ready", "NC")];
    data.locations = [at("ready", "")];
    // The stateless location still counts as a location in her group.
    expect(rowFor(data, "ready", off)).toMatchObject({ stage: "ready_for_credentialing" });
    data.licenses = [{ ...verified("ready", "NC"), verifiedStatus: "unverified" }];
    expect(rowFor(data, "ready", off)).toMatchObject({
      stage: "submitted",
      gaps: ["NC license not board-verified"],
    });
    // With the rule on, there is nothing to judge and the hold stands alone.
    expect(rowFor(data, "ready")).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: [STATELESS_LOCATION_GAP],
    });
  });

  it("counts a membership that starts in the future by default, and not when the rule is off", () => {
    const off = resolveOnboardingFunnelRules(null, { futureMembershipCounts: false });
    const data = input();
    data.groupMemberships = [member("ready", null, { startDate: "2026-11-01" })];
    expect(rowFor(data, "ready")).toMatchObject({ stage: "ready_for_credentialing" });
    expect(rowFor(data, "ready", off)).toMatchObject({
      stage: "verified_awaiting_assignment",
      gaps: ["Needs a group"],
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

describe("per-provider dimensions", () => {
  it("computes complete, verified, assigned and case on their own, whatever the stage", () => {
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
      hasCase: false,
      caseStatuses: ["denied"],
      intake: null,
    });
    // The stage reads the dimensions; its gaps are the ones its gate lists.
    expect(row).toMatchObject({ stage: "profile_incomplete", gaps: ["No NPI"] });
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
      caseStatuses: ["in_progress"],
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

describe("location and assignment rules", () => {
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

  it("judges every license on file for a stateless-only location when assignment is not required", () => {
    const off = resolveOnboardingFunnelRules({ assignmentRequiredForReady: false });
    const data = input();
    data.licenses = [{ ...verified("ready", "NC"), verifiedStatus: "unverified" }];
    data.locations = [at("ready", null)];
    expect(rowFor(data, "ready", off)).toMatchObject({
      stage: "submitted",
      gaps: ["NC license not board-verified"],
    });
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
      ["credentialing", "Credentialing", "any"],
    ]);
    expect(DEFAULT_ONBOARDING_FUNNEL_CONFIG).toEqual({
      stages: DEFAULT_ONBOARDING_FUNNEL_STAGES,
      rules: DEFAULT_ONBOARDING_FUNNEL_RULES,
    });
    expect(Object.isFrozen(DEFAULT_ONBOARDING_FUNNEL_STAGES[2])).toBe(true);
  });

  it("describes Submitted as complete and not yet verified, never as something sent", () => {
    const copy = Object.fromEntries(
      DEFAULT_ONBOARDING_FUNNEL_STAGES.map((s) => [s.label, s.description]),
    );
    expect(copy).toEqual({
      Invited: "Invited to the intake form. Nothing sent back yet.",
      "Profile incomplete": "Missing NPI, CAQH ID, demographics, or a license.",
      Submitted: "Information is complete but not yet verified.",
      "Verified, awaiting assignment":
        "Verified, but the group or location assignment is incomplete.",
      "Ready for credentialing":
        "Verified and assigned to a group and one of its locations. No case yet.",
      Credentialing: "Has at least one credentialing case, in any status.",
    });
    expect(copy.Submitted).not.toMatch(/sent|transmit|submitted to|filed|payer/i);
    const text = Object.entries(copy).flat().join(" ");
    expect(text).not.toMatch(/Awaiting verification|Ready to credential\b/);
    expect(text).not.toMatch(/approved|denied|withdrawn|underway/i);
  });

  it("hides intake-gated stages until the intake tables can be read", () => {
    expect(
      visibleOnboardingFunnelStages(DEFAULT_ONBOARDING_FUNNEL_STAGES, false).map((s) => s.key),
    ).toEqual([
      "profile_incomplete",
      "submitted",
      "verified_awaiting_assignment",
      "ready_for_credentialing",
      "credentialing",
    ]);
    expect(
      visibleOnboardingFunnelStages(DEFAULT_ONBOARDING_FUNNEL_STAGES, true).map((s) => s.key),
    ).toEqual(DEFAULT_ONBOARDING_FUNNEL_STAGES.map((s) => s.key));
    expect(rowsOf(input()).some((r) => r.stage === "invited")).toBe(false);
  });

  it("lists gaps only for the stages whose gate has them", () => {
    expect(
      visibleOnboardingFunnelStages(DEFAULT_ONBOARDING_FUNNEL_STAGES, true)
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
    expect(visibleOnboardingFunnelStages(config.stages, false)[1]).toMatchObject({
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
      { key: "credentialing", label: "Credentialing", description: "d", gate: "any" },
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

  it("still places every provider exactly once under a configuration with no catch-all", () => {
    const stages: OnboardingFunnelStageConfig[] = [
      { key: "ready_for_credentialing", label: "Ready", description: "d", gate: "ready" },
    ];
    const rows = buildOnboardingFunnelRows(input(), TODAY, { stages, rules: DEFAULT });
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.stage === "ready_for_credentialing")).toBe(true);
    expect(rows.find((r) => r.providerId === "missing")?.gaps).toEqual([]);
  });
});

describe("validateOnboardingFunnelConfig", () => {
  const stage = (
    key: string,
    gate: OnboardingFunnelGate,
    label = key,
  ): OnboardingFunnelStageConfig => ({ key, label, description: `${label} providers`, gate });
  const valid = (stages: OnboardingFunnelStageConfig[], rules = DEFAULT) =>
    validateOnboardingFunnelConfig({ stages, rules });

  it("passes the default configuration, with either assignment rule", () => {
    expect(validateOnboardingFunnelConfig(DEFAULT_ONBOARDING_FUNNEL_CONFIG)).toEqual([]);
    expect(
      valid([...DEFAULT_ONBOARDING_FUNNEL_STAGES], {
        ...DEFAULT,
        assignmentRequiredForReady: false,
      }),
    ).toEqual([]);
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

  it("rejects a missing or misplaced catch-all", () => {
    expect(valid([stage("a", "incomplete"), stage("b", "ready")])).toContain(
      'The last stage must take everyone not placed earlier (gate "any").',
    );
    expect(valid([stage("a", "any"), stage("b", "any")])).toContain(
      'Stage 1: only the last stage can take everyone ("any").',
    );
    expect(valid([])).toEqual(["Add at least one stage."]);
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
});

describe("resolveOnboardingFunnelConfig", () => {
  const custom: OnboardingFunnelStageConfig[] = [
    { key: "not_ready", label: "Not ready", description: "d", gate: "not_ready" },
    { key: "ready_for_credentialing", label: "Ready", description: "d", gate: "ready" },
    { key: "credentialing", label: "Credentialing", description: "d", gate: "any" },
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
  });

  it("returns copies, so the default cannot be changed through them", () => {
    const config = resolveOnboardingFunnelConfig();
    expect(config.stages[0]).not.toBe(DEFAULT_ONBOARDING_FUNNEL_STAGES[0]);
    expect(config.rules).not.toBe(DEFAULT_ONBOARDING_FUNNEL_RULES);
  });
});
