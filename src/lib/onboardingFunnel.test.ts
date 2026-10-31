import { describe, expect, it } from "vitest";
import { CASE_STATUSES, type CaseStatus } from "@/lib/caseStatus";
import {
  buildOnboardingFunnelRows,
  DEFAULT_ONBOARDING_FUNNEL_RULES,
  ONBOARDING_FUNNEL_STAGES,
  onboardingFunnelStageCounts,
  onboardingFunnelStates,
  resolveOnboardingFunnelRules,
  STATELESS_LOCATION_GAP,
  visibleOnboardingFunnelStages,
  type OnboardingFunnelInput,
  type OnboardingFunnelLocationInput,
  type OnboardingFunnelProviderFacts,
  type OnboardingFunnelRules,
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

function rowsOf(data: OnboardingFunnelInput, rules: OnboardingFunnelRules = DEFAULT) {
  return buildOnboardingFunnelRows(data, TODAY, rules);
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
    const counts = onboardingFunnelStageCounts(rows);
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
    expect(onboardingFunnelStageCounts(rows)).toMatchObject({
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
    });
    expect(resolveOnboardingFunnelRules()).toEqual(DEFAULT_ONBOARDING_FUNNEL_RULES);
    expect(resolveOnboardingFunnelRules(null, null)).toEqual(DEFAULT_ONBOARDING_FUNNEL_RULES);
    expect(Object.isFrozen(DEFAULT_ONBOARDING_FUNNEL_RULES)).toBe(true);
  });

  it("takes the organization's value, else the platform's, else the default, field by field", () => {
    const platform = {
      caseStatusesNotCountedAsCredentialing: ["not_pursuing"] as CaseStatus[],
      statelessLocationHolds: false,
      futureMembershipCounts: false,
    };
    expect(resolveOnboardingFunnelRules(platform)).toEqual(platform);
    expect(resolveOnboardingFunnelRules(platform, { futureMembershipCounts: true })).toEqual({
      caseStatusesNotCountedAsCredentialing: ["not_pursuing"],
      statelessLocationHolds: false,
      futureMembershipCounts: true,
    });
    expect(
      resolveOnboardingFunnelRules(
        { statelessLocationHolds: false },
        { futureMembershipCounts: false },
      ),
    ).toEqual({
      caseStatusesNotCountedAsCredentialing: [],
      statelessLocationHolds: false,
      futureMembershipCounts: false,
    });
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
    ).toEqual({ ...platform, futureMembershipCounts: true });
    expect(
      resolveOnboardingFunnelRules(platform, {
        caseStatusesNotCountedAsCredentialing: [],
        futureMembershipCounts: false,
      }),
    ).toEqual({
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

describe("provider onboarding funnel stages", () => {
  it("runs Invited, Profile incomplete, Submitted, Verified awaiting assignment, Ready, Credentialing", () => {
    expect(ONBOARDING_FUNNEL_STAGES.map((s) => [s.key, s.title])).toEqual([
      ["invited", "Invited"],
      ["profile_incomplete", "Profile incomplete"],
      ["submitted", "Submitted"],
      ["verified_awaiting_assignment", "Verified, awaiting assignment"],
      ["ready_for_credentialing", "Ready for credentialing"],
      ["credentialing", "Credentialing"],
    ]);
  });

  it("hides Invited until the intake tables can be read, and places nobody there today", () => {
    expect(visibleOnboardingFunnelStages(false).map((s) => s.key)).toEqual([
      "profile_incomplete",
      "submitted",
      "verified_awaiting_assignment",
      "ready_for_credentialing",
      "credentialing",
    ]);
    expect(visibleOnboardingFunnelStages(true).map((s) => s.key)).toEqual(
      ONBOARDING_FUNNEL_STAGES.map((s) => s.key),
    );
    expect(rowsOf(input()).some((r) => r.stage === "invited")).toBe(false);
  });

  it("describes each stage in the PM's words, with no case-status breakdown", () => {
    const copy = Object.fromEntries(ONBOARDING_FUNNEL_STAGES.map((s) => [s.title, s.description]));
    expect(copy).toEqual({
      Invited: "Invited to the intake form. Nothing submitted yet.",
      "Profile incomplete": "Missing NPI, CAQH ID, demographics, or a license.",
      Submitted: "Information is in, but not yet verified.",
      "Verified, awaiting assignment":
        "Verified, but the group or location assignment is incomplete.",
      "Ready for credentialing":
        "Verified and assigned to a group and one of its locations. No case yet.",
      Credentialing: "Has at least one credentialing case, in any status.",
    });
    const text = Object.entries(copy).flat().join(" ");
    expect(text).not.toMatch(/Awaiting verification|Ready to credential\b/);
    expect(text).not.toMatch(/approved|denied|withdrawn|underway/i);
  });

  it("lists gaps only for the stages that have them", () => {
    expect(ONBOARDING_FUNNEL_STAGES.filter((s) => s.listsGaps).map((s) => s.key)).toEqual([
      "profile_incomplete",
      "submitted",
      "verified_awaiting_assignment",
    ]);
  });
});
