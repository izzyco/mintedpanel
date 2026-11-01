// Provider Onboarding funnel (Oct 20 review, RC-06; stage names from the PM,
// Oct 30, and her answers of Oct 31, D61 to D76 and A17 to A29). The funnel
// is the provider's state, not case status. Pure; "today" and the
// configuration are passed in.
//
// Two layers, kept apart:
//
// 1. Dimensions: each computed on its own for every provider.
//    complete        every required profile field is present. The fields are
//                    a setting (A26); by default NPI, CAQH ID, date of birth,
//                    SSN last 4, and a license (any license with a valid
//                    state code, and one for each state they are assigned to
//                    work in).
//    verified        the record is not pending verification, CAQH is attested
//                    within the shared window (src/lib/caqhAttestation.ts,
//                    one setting with enrollment readiness, A26; a future
//                    date never counts), and every license judged is
//                    board-verified and unexpired (by default a license with
//                    no expiry is not current, A26). Licenses are judged for
//                    the valid states of the provider's active locations;
//                    with none, every license on file is.
//    assigned        the provider has an active, non-reference location that
//                    counts: by default one under a current group of theirs
//                    or under no group at all (in-home addresses, A22), whose
//                    assignment has started unless future-dated assignments
//                    count (they do by default, A27). A location under
//                    another group is still a place they are assigned to
//                    work, so its state still counts for the license checks,
//                    but it never makes them Ready (A21).
//    grouped         a current group membership: an active group, not ended,
//                    and started unless future-dated memberships count (they
//                    do by default, A27). Staff assign groups, so a missing
//                    group is a staff-side gap: listed under "awaiting
//                    assignment", never as the provider's reason (A23).
//    statesValid     a fact: every active location has a valid state. By
//                    default one with none holds the provider, a setting of
//                    its own, independent of the assignment requirement (A24).
//    cases           facts: how many cases are on file and their statuses.
//    hasCountedCase  policy: at least one case in a status that counts as
//                    Credentialing. Only this one is read by the stages.
//    intake          invited, and whether the intake form came back: a fact,
//                    read only once the intake tables can be read (MINT-89).
//                    Until then it is null and is never inferred.
//
// 2. Stages: configuration. An ordered list; each stage has a stable key, a
//    label, a description and a gate picked from a fixed menu of predicates
//    over the dimensions (ONBOARDING_FUNNEL_GATES). The first stage whose
//    gate matches wins. A list must place every combination of dimensions
//    in a stage under every value of the rules a gate reads
//    (validateOnboardingFunnelConfig), so every counted provider sits in
//    exactly one. A stage no provider could reach under the rules in force
//    is hidden, like Invited while intake data cannot be read. The default
//    list is the PM's: Invited, Profile incomplete, Submitted (the
//    information is complete and not yet verified; it says nothing about
//    anything being sent anywhere), Verified awaiting assignment, Ready for
//    credentialing, Credentialing (never split by status, which belongs on
//    the case board). By default a complete record moves past Invited and
//    the outstanding invite shows as a tag on the row (A28).
//
// Business policy is configuration, never a constant
// (resolveOnboardingFunnelConfig). Minted's platform layer sets the stage
// list: its count, order, gates and copy. An organization's layer may give
// those stages its own labels and descriptions, keyed by stage key, and
// nothing else about them (Platform Settings row 26). The rules
// (OnboardingFunnelRules) resolve field by field, organization over platform
// over default; Minted sets an organization's rules at onboarding and org
// admins only read them (PM, S10). Labels are free text: nothing checks
// their wording (A29). Nothing stores either layer yet; the Mission Control
// setting is MINT-125. Minted's list is validated under every value of the
// rules a gate reads, so no organization's rules can break it. An
// organization's layer goes live whole (copy and rules) or not at all. A
// list or layer that fails validation never goes live: the default list, or
// Minted's configuration, is used instead, and the default list is valid
// under every rule. explainOnboardingFunnelConfig says which layer was
// ignored and why, so Mission Control can flag it ("override ignored:
// invalid", A19).
//
// A group membership counts while its group is active and until its end
// date passes. Billing Readiness (src/lib/billingReadiness.ts) and the
// contract SOP assignments (src/services/contractSopAssignments.ts) require
// a start date on or before today, because they ask who is working now.
//
// Not the provider onboarding (intake) flow in src/lib/providerOnboarding.ts:
// this is the Reporting Center funnel over the provider records themselves.
// PHI rule: demographics arrive as presence booleans only.
import {
  DEFAULT_CAQH_ATTESTATION_WINDOW_DAYS,
  isValidCaqhAttestationWindowDays,
} from "@/lib/caqhAttestation";
import { isCaseStatus, type CaseStatus } from "@/lib/caseStatus";
import { isCaqhCurrent } from "@/lib/enrollmentReadiness";

// ---------------------------------------------------------------------------
// Rules

/** The profile fields a configuration can require for "complete" (A26), in
 * the order the report lists what is missing. */
export const ONBOARDING_FUNNEL_PROFILE_FIELDS = [
  "npi",
  "caqhId",
  "dateOfBirth",
  "ssnLast4",
  "stateLicense",
] as const;

export type OnboardingFunnelProfileField = (typeof ONBOARDING_FUNNEL_PROFILE_FIELDS)[number];

/** The funnel's policy rules. Each field names its default, so the
 * alternative is the obvious other value. */
export interface OnboardingFunnelRules {
  /** Case statuses that do NOT count as Credentialing. Default empty: every
   * case counts, whatever its status. The cases stay on record as facts. */
  caseStatusesNotCountedAsCredentialing: readonly CaseStatus[];
  /** The fields that make a profile complete (A26). Default: all five.
   * "stateLicense" is a license with a valid state code, and one for each
   * state the provider works in. */
  requiredProfileFields: readonly OnboardingFunnelProfileField[];
  /** True (default): a license with no expiration date is not current
   * (A26). False: it counts as unexpired. */
  licenseWithoutExpiryHolds: boolean;
  /** True (default): an active location with no valid state keeps the
   * provider from Ready. False: it counts like any other location.
   * Independent of assignmentRequiredForReady (A24). */
  statelessLocationHolds: boolean;
  /** True (default): Ready needs a current group and a location that counts.
   * False: a complete, verified provider is Ready without them. Independent
   * of statelessLocationHolds (A24). */
  assignmentRequiredForReady: boolean;
  /** True (default): a group membership that starts after today already
   * counts as current (A27). False: it counts from its start date. A
   * membership with no start date counts either way. */
  futureMembershipCounts: boolean;
  /** True (default): an assignment to a location that starts after today
   * already counts (A27). False: it counts from its start date. An
   * assignment with no start date counts either way. */
  futureLocationAssignmentCounts: boolean;
  /** True (default): a location counts only when it is under one of the
   * provider's current groups, or under none (see ungroupedLocationCounts).
   * False: any active, non-reference location counts. */
  locationMustBeInProviderGroup: boolean;
  /** True (default): a location under no group counts for any provider
   * (in-home addresses, A22). False: it never counts while a location must
   * be in the provider's group. */
  ungroupedLocationCounts: boolean;
  /** True (default): a complete record moves past Invited; the outstanding
   * invite shows as a tag (A28). False: an outstanding invite keeps the
   * provider in Invited whatever their record shows. */
  completeRecordMovesPastInvite: boolean;
}

/** The platform default: the PM's decisions of Oct 30 and 31. */
export const DEFAULT_ONBOARDING_FUNNEL_RULES: Readonly<OnboardingFunnelRules> = Object.freeze({
  caseStatusesNotCountedAsCredentialing: Object.freeze<CaseStatus[]>([]),
  requiredProfileFields: Object.freeze<OnboardingFunnelProfileField[]>([
    ...ONBOARDING_FUNNEL_PROFILE_FIELDS,
  ]),
  licenseWithoutExpiryHolds: true,
  statelessLocationHolds: true,
  assignmentRequiredForReady: true,
  futureMembershipCounts: true,
  futureLocationAssignmentCounts: true,
  locationMustBeInProviderGroup: true,
  ungroupedLocationCounts: true,
  completeRecordMovesPastInvite: true,
});

/** A platform or organization override. A null or missing field inherits;
 * an empty list is a real value, not an inherit. */
export type OnboardingFunnelRulesOverride = {
  readonly [K in keyof OnboardingFunnelRules]?: OnboardingFunnelRules[K] | null;
};

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const PROFILE_FIELDS: readonly string[] = ONBOARDING_FUNNEL_PROFILE_FIELDS;

const RULE_CHECKS: { [K in keyof OnboardingFunnelRules]: (value: unknown) => boolean } = {
  caseStatusesNotCountedAsCredentialing: (value) =>
    Array.isArray(value) && value.every((status) => isCaseStatus(status)),
  requiredProfileFields: (value) =>
    Array.isArray(value) && value.every((field) => PROFILE_FIELDS.includes(field)),
  licenseWithoutExpiryHolds: isBoolean,
  statelessLocationHolds: isBoolean,
  assignmentRequiredForReady: isBoolean,
  futureMembershipCounts: isBoolean,
  futureLocationAssignmentCounts: isBoolean,
  locationMustBeInProviderGroup: isBoolean,
  ungroupedLocationCounts: isBoolean,
  completeRecordMovesPastInvite: isBoolean,
};

const RULE_KEYS = Object.keys(RULE_CHECKS) as Array<keyof OnboardingFunnelRules>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Stored settings are untrusted: every lookup by a key that came from them,
// or into an object they came from, reads own properties only, so
// "__proto__", "constructor" or "toString" are never mistaken for a rule.
const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const isRuleKey = (key: string): key is keyof OnboardingFunnelRules =>
  Object.hasOwn(RULE_CHECKS, key);

const ruleValueError = (key: keyof OnboardingFunnelRules): string =>
  key === "caseStatusesNotCountedAsCredentialing"
    ? "Case statuses that do not count must be known case statuses."
    : key === "requiredProfileFields"
      ? `Required profile fields must come from: ${ONBOARDING_FUNNEL_PROFILE_FIELDS.join(", ")}.`
      : `The rule "${key}" must be on or off.`;

/** Problems with a rules override (any subset of the rules; null inherits). */
function ruleOverrideErrors(rules: unknown, owner: string): string[] {
  if (rules == null) return [];
  if (!isRecord(rules)) return [`${owner} rules must be an object.`];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(rules)) {
    if (!isRuleKey(key)) errors.push(`"${key}" is not a funnel rule.`);
    else if (value != null && !RULE_CHECKS[key](value)) errors.push(ruleValueError(key));
  }
  return errors;
}

/** Field by field: the organization's value, else the platform's, else the
 * default. A stored value of the wrong shape is skipped like a missing one. */
export function resolveOnboardingFunnelRules(
  platform?: OnboardingFunnelRulesOverride | null,
  organization?: OnboardingFunnelRulesOverride | null,
): OnboardingFunnelRules {
  const pick = <K extends keyof OnboardingFunnelRules>(key: K): OnboardingFunnelRules[K] => {
    for (const override of [organization, platform]) {
      const value: unknown = isRecord(override) ? own(override, key) : undefined;
      if (value != null && RULE_CHECKS[key](value)) return value as OnboardingFunnelRules[K];
    }
    return DEFAULT_ONBOARDING_FUNNEL_RULES[key];
  };
  const fields = new Set(pick("requiredProfileFields"));
  return {
    caseStatusesNotCountedAsCredentialing: [
      ...new Set(pick("caseStatusesNotCountedAsCredentialing")),
    ],
    // Menu order, so the report lists what is missing the same way however
    // the setting was stored.
    requiredProfileFields: ONBOARDING_FUNNEL_PROFILE_FIELDS.filter((field) => fields.has(field)),
    licenseWithoutExpiryHolds: pick("licenseWithoutExpiryHolds"),
    statelessLocationHolds: pick("statelessLocationHolds"),
    assignmentRequiredForReady: pick("assignmentRequiredForReady"),
    futureMembershipCounts: pick("futureMembershipCounts"),
    futureLocationAssignmentCounts: pick("futureLocationAssignmentCounts"),
    locationMustBeInProviderGroup: pick("locationMustBeInProviderGroup"),
    ungroupedLocationCounts: pick("ungroupedLocationCounts"),
    completeRecordMovesPastInvite: pick("completeRecordMovesPastInvite"),
  };
}

// ---------------------------------------------------------------------------
// Dimensions

export interface OnboardingFunnelIntakeFacts {
  invited: boolean;
  intakeSubmitted: boolean;
}

export interface OnboardingFunnelDimensions {
  complete: boolean;
  completenessGaps: string[];
  verified: boolean;
  verificationGaps: string[];
  /** Has an active, non-reference location that counts. */
  assigned: boolean;
  assignmentGaps: string[];
  /** Has a current group membership. A missing group is a staff-side gap
   * (A23): listed under awaiting assignment, never as the provider's reason. */
  grouped: boolean;
  groupGaps: string[];
  /** Fact: every active location has a valid state. */
  statesValid: boolean;
  stateGaps: string[];
  /** Fact: at least one case on file, in any status. */
  hasCase: boolean;
  /** Fact: how many cases are on file. */
  caseCount: number;
  /** Fact: every case's status; null for a stored value that is not known. */
  caseStatuses: Array<CaseStatus | null>;
  /** Policy: at least one case in a status that counts as Credentialing. */
  hasCountedCase: boolean;
  /** null while the intake tables cannot be read (MINT-89). Never inferred. */
  intake: OnboardingFunnelIntakeFacts | null;
}

// ---------------------------------------------------------------------------
// Gates: the fixed menu a stage picks from

export type OnboardingFunnelGate =
  | "invited_not_submitted"
  | "incomplete"
  | "complete_unverified"
  | "verified_unassigned"
  | "not_ready"
  | "ready"
  | "has_case"
  | "any";

interface GateDefinition {
  key: OnboardingFunnelGate;
  /** What the gate matches, for the configuration screen (MINT-125). */
  description: string;
  /** The gate reads intake facts; its stage is hidden until they can be read. */
  needsIntakeData: boolean;
  /** The gate lists what holds the provider ("What's needed"). */
  listsGaps: boolean;
  matches: (d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules) => boolean;
  gaps: (d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules) => string[];
}

const assignmentHeld = (d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules) =>
  rules.assignmentRequiredForReady && (!d.assigned || !d.grouped);
const stateHeld = (d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules) =>
  rules.statelessLocationHolds && !d.statesValid;
const placementOk = (d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules) =>
  !assignmentHeld(d, rules) && !stateHeld(d, rules);
const readyNow = (d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules) =>
  d.complete && d.verified && placementOk(d, rules);
/** The location gaps a list may show; never the group (A23). */
const locationHolds = (d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules) => [
  ...(rules.assignmentRequiredForReady ? d.assignmentGaps : []),
  ...(rules.statelessLocationHolds ? d.stateGaps : []),
];
/** Staff-side group gaps (A23): listed under awaiting assignment and in the
 * merged view, never in the provider's own stages. */
const groupHolds = (d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules) =>
  rules.assignmentRequiredForReady ? d.groupGaps : [];
const unique = (gaps: string[]) => [...new Set(gaps)];
const inviteOutstanding = (d: OnboardingFunnelDimensions) =>
  d.intake !== null && d.intake.invited && !d.intake.intakeSubmitted;
const none = () => [];

const GATE_LIST: readonly GateDefinition[] = [
  {
    key: "invited_not_submitted",
    description:
      "Invited, has not sent the intake form back, and no counted case. By default only while the record is incomplete.",
    needsIntakeData: true,
    listsGaps: false,
    matches: (d, rules) =>
      !d.hasCountedCase &&
      inviteOutstanding(d) &&
      (!rules.completeRecordMovesPastInvite || !d.complete),
    gaps: none,
  },
  {
    key: "incomplete",
    description: "A required field is missing, and no counted case.",
    needsIntakeData: false,
    listsGaps: true,
    matches: (d) => !d.hasCountedCase && !d.complete,
    gaps: (d) => d.completenessGaps,
  },
  {
    key: "complete_unverified",
    description:
      "Complete but not verified, and no counted case. Lists location gaps too, never a missing group.",
    needsIntakeData: false,
    listsGaps: true,
    matches: (d) => !d.hasCountedCase && d.complete && !d.verified,
    gaps: (d, rules) => unique([...d.verificationGaps, ...locationHolds(d, rules)]),
  },
  {
    key: "verified_unassigned",
    description:
      "Complete and verified, but a group, a location or a location's state is still missing where a rule needs it, and no counted case. Lists the staff-side group gap too.",
    needsIntakeData: false,
    listsGaps: true,
    matches: (d, rules) => !d.hasCountedCase && d.complete && d.verified && !placementOk(d, rules),
    gaps: (d, rules) => unique([...locationHolds(d, rules), ...groupHolds(d, rules)]),
  },
  {
    key: "not_ready",
    description: "Anything short of Ready, and no counted case. Lists every gap.",
    needsIntakeData: false,
    listsGaps: true,
    matches: (d, rules) => !d.hasCountedCase && !readyNow(d, rules),
    gaps: (d, rules) =>
      unique([
        ...d.completenessGaps,
        ...d.verificationGaps,
        ...locationHolds(d, rules),
        ...groupHolds(d, rules),
      ]),
  },
  {
    key: "ready",
    description: "Meets every requirement in force, and no counted case.",
    needsIntakeData: false,
    listsGaps: false,
    matches: (d, rules) => !d.hasCountedCase && readyNow(d, rules),
    gaps: none,
  },
  {
    key: "has_case",
    description: "Has a case in a status that counts as Credentialing.",
    needsIntakeData: false,
    listsGaps: false,
    matches: (d) => d.hasCountedCase,
    gaps: none,
  },
  {
    key: "any",
    description: 'Everyone not placed by an earlier stage ("everyone else"). Only the last stage.',
    needsIntakeData: false,
    listsGaps: false,
    matches: () => true,
    gaps: none,
  },
];

const GATES = new Map(GATE_LIST.map((gate) => [gate.key, gate]));

/** The gate menu, for the configuration screen (MINT-125). */
export const ONBOARDING_FUNNEL_GATES: ReadonlyArray<
  Pick<GateDefinition, "key" | "description" | "needsIntakeData" | "listsGaps">
> = GATE_LIST.map(({ key, description, needsIntakeData, listsGaps }) => ({
  key,
  description,
  needsIntakeData,
  listsGaps,
}));

/** Every combination of dimension values the gates read. Intake varies
 * fastest, unread first. */
function sampleDimensions(): OnboardingFunnelDimensions[] {
  const flags = [true, false];
  const intakes: Array<OnboardingFunnelIntakeFacts | null> = [
    null,
    { invited: false, intakeSubmitted: false },
    { invited: true, intakeSubmitted: false },
    { invited: true, intakeSubmitted: true },
  ];
  const samples: OnboardingFunnelDimensions[] = [];
  for (const hasCountedCase of flags)
    for (const complete of flags)
      for (const verified of flags)
        for (const assigned of flags)
          for (const grouped of flags)
            for (const statesValid of flags)
              for (const intake of intakes)
                samples.push({
                  complete,
                  completenessGaps: [],
                  verified,
                  verificationGaps: [],
                  assigned,
                  assignmentGaps: [],
                  grouped,
                  groupGaps: [],
                  statesValid,
                  stateGaps: [],
                  hasCase: hasCountedCase,
                  caseCount: hasCountedCase ? 1 : 0,
                  caseStatuses: [],
                  hasCountedCase,
                  intake,
                });
  return samples;
}

const SAMPLES = sampleDimensions();

/** Index of the first stage whose gate matches, or -1. */
function firstMatch(
  stages: ReadonlyArray<OnboardingFunnelStageConfig>,
  d: OnboardingFunnelDimensions,
  rules: OnboardingFunnelRules,
): number {
  return stages.findIndex((stage) => GATES.get(stage.gate)?.matches(d, rules) ?? false);
}

/** The stages some provider would land in under these rules. */
function reachableStages(
  stages: ReadonlyArray<OnboardingFunnelStageConfig>,
  rules: OnboardingFunnelRules,
): Set<number> {
  return new Set(SAMPLES.map((d) => firstMatch(stages, d, rules)).filter((i) => i >= 0));
}

/** The rules at every combination of values a gate reads: whether Ready
 * requires assignment, whether a location with no state holds (independent
 * settings, A24), and whether a complete record moves past Invited (A28). A
 * stage list must work under all of them, so no organization's rules can
 * break Minted's list. */
function gateRuleVariants(rules: OnboardingFunnelRules): OnboardingFunnelRules[] {
  const flags = [true, false];
  return flags.flatMap((assignmentRequiredForReady) =>
    flags.flatMap((statelessLocationHolds) =>
      flags.map((completeRecordMovesPastInvite) => ({
        ...rules,
        assignmentRequiredForReady,
        statelessLocationHolds,
        completeRecordMovesPastInvite,
      })),
    ),
  );
}

// ---------------------------------------------------------------------------
// Stages

/** A stage key is stable; the label and description are display copy. */
export type OnboardingFunnelStageKey = string;

export interface OnboardingFunnelStageConfig {
  key: OnboardingFunnelStageKey;
  label: string;
  description: string;
  gate: OnboardingFunnelGate;
}

const DEFAULT_STAGE_LIST: OnboardingFunnelStageConfig[] = [
  {
    key: "invited",
    label: "Invited",
    description: "Invited to the intake form. Nothing sent back yet.",
    gate: "invited_not_submitted",
  },
  {
    key: "profile_incomplete",
    label: "Profile incomplete",
    description: "Missing NPI, CAQH ID, demographics, or a license.",
    gate: "incomplete",
  },
  {
    key: "submitted",
    label: "Submitted",
    description: "Information is complete but not yet verified.",
    gate: "complete_unverified",
  },
  {
    key: "verified_awaiting_assignment",
    label: "Verified, awaiting assignment",
    description: "Verified; the group, the location, or a location's record still needs attention.",
    gate: "verified_unassigned",
  },
  {
    key: "ready_for_credentialing",
    label: "Ready for credentialing",
    description: "Meets every requirement for credentialing.",
    gate: "ready",
  },
  {
    key: "credentialing",
    label: "Credentialing",
    description: "Has at least one credentialing case.",
    gate: "has_case",
  },
];

/** The PM's stages (Oct 30 and 31), in funnel order. */
export const DEFAULT_ONBOARDING_FUNNEL_STAGES: ReadonlyArray<
  Readonly<OnboardingFunnelStageConfig>
> = Object.freeze(DEFAULT_STAGE_LIST.map((stage) => Object.freeze({ ...stage })));

export interface OnboardingFunnelConfig {
  stages: ReadonlyArray<Readonly<OnboardingFunnelStageConfig>>;
  rules: OnboardingFunnelRules;
  /** The shared CAQH attestation window, in days (src/lib/caqhAttestation.ts,
   * A26): one setting with enrollment readiness, resolved outside the
   * funnel's layers and passed in, never a number of the funnel's own. */
  caqhAttestationWindowDays: number;
}

export const DEFAULT_ONBOARDING_FUNNEL_CONFIG: Readonly<OnboardingFunnelConfig> = Object.freeze({
  stages: DEFAULT_ONBOARDING_FUNNEL_STAGES,
  rules: DEFAULT_ONBOARDING_FUNNEL_RULES,
  caqhAttestationWindowDays: DEFAULT_CAQH_ATTESTATION_WINDOW_DAYS,
});

/** A stage list and the rules it is checked under. */
export type OnboardingFunnelStagesAndRules = Pick<OnboardingFunnelConfig, "stages" | "rules">;

/** Minted's platform layer: a whole stage list (count, order, gates, copy)
 * and rules. null or missing inherits the default; rules resolve field by
 * field. */
export interface OnboardingFunnelPlatformOverride {
  stages?: ReadonlyArray<OnboardingFunnelStageConfig> | null;
  rules?: OnboardingFunnelRulesOverride | null;
}

/** One stage's copy for an organization. null or missing keeps Minted's. */
export interface OnboardingFunnelStageText {
  label?: string | null;
  description?: string | null;
}

/** An organization's layer (Platform Settings row 26; PM S10). It may give
 * each of Minted's stages its own label and description, keyed by stage
 * key; it can never add, remove, reorder or re-gate a stage. Its rules
 * resolve field by field over Minted's; Minted sets them at onboarding and
 * org admins only read them. */
export interface OnboardingFunnelOrganizationOverride {
  stageText?: Readonly<Record<OnboardingFunnelStageKey, OnboardingFunnelStageText>> | null;
  rules?: OnboardingFunnelRulesOverride | null;
}

export interface OnboardingFunnelStageInfo extends OnboardingFunnelStageConfig {
  /** Hidden until the intake tables can be read. */
  needsIntakeData: boolean;
  /** Providers here are held by gaps the report lists ("What's needed"). */
  listsGaps: boolean;
}

// ---------------------------------------------------------------------------
// Validation: what a configuration must pass before it goes live (MINT-125).
// Labels and descriptions are free text: only their presence, length and
// uniqueness are checked, never their wording (A29).

export const MAX_ONBOARDING_FUNNEL_STAGES = 6;
const STAGE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LABEL = 60;
const MAX_DESCRIPTION = 200;

function describeSample(d: OnboardingFunnelDimensions): string {
  const state = [
    d.complete ? "complete" : "incomplete",
    d.verified ? "verified" : "not verified",
    d.assigned ? "with a location that counts" : "without a location that counts",
    d.grouped ? "in a group" : "not in a group",
    d.statesValid ? "with every location's state on record" : "with a location missing its state",
    d.hasCountedCase ? "with a case" : "with no case",
  ];
  return `A provider who is ${state.join(", ")},`;
}

function describeVariant(rules: OnboardingFunnelRules): string {
  return [
    `Ready ${rules.assignmentRequiredForReady ? "requires" : "does not require"} assignment`,
    `a location with no state ${rules.statelessLocationHolds ? "holds" : "does not hold"}`,
    `a complete record ${rules.completeRecordMovesPastInvite ? "moves past" : "stays in"} Invited`,
  ].join("; ");
}

/** Plain-language problems with a stage list and its rules; empty when it
 * can go live. Coverage is checked under every value of the rules a gate
 * reads, so the list holds whatever an organization's rules say. */
export function validateOnboardingFunnelConfig(config: OnboardingFunnelStagesAndRules): string[] {
  const errors: string[] = [];
  const raw: unknown = isRecord(config) ? config.stages : undefined;
  if (!Array.isArray(raw)) errors.push("The stages must be a list.");
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  if (Array.isArray(raw) && list.length === 0) errors.push("Add at least one stage.");
  if (list.length > MAX_ONBOARDING_FUNNEL_STAGES)
    errors.push(`Use at most ${MAX_ONBOARDING_FUNNEL_STAGES} stages.`);

  const keys = new Set<string>();
  const labels = new Set<string>();
  list.forEach((entry, i) => {
    const where = `Stage ${i + 1}`;
    if (!isRecord(entry)) {
      errors.push(`${where} is not a stage.`);
      return;
    }
    const key = typeof entry.key === "string" ? entry.key : "";
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    if (!STAGE_KEY.test(key))
      errors.push(
        `${where}: the key must start with a lowercase letter and use only lowercase letters, digits and underscores.`,
      );
    else if (keys.has(key)) errors.push(`${where}: the key "${key}" is already used.`);
    keys.add(key);
    if (!label) errors.push(`${where}: add a label.`);
    else if (label.length > MAX_LABEL)
      errors.push(`${where}: keep the label to ${MAX_LABEL} characters.`);
    else if (labels.has(label.toLowerCase()))
      errors.push(`${where}: the label "${label}" is already used.`);
    labels.add(label.toLowerCase());
    if (!description) errors.push(`${where}: add a description.`);
    else if (description.length > MAX_DESCRIPTION)
      errors.push(`${where}: keep the description to ${MAX_DESCRIPTION} characters.`);
    if (typeof entry.gate !== "string" || !GATES.has(entry.gate as OnboardingFunnelGate))
      errors.push(`${where}: "${String(entry.gate)}" is not a gate on the menu.`);
    else if (entry.gate === "any" && i !== list.length - 1)
      errors.push(`${where}: only the last stage can take everyone else ("any").`);
  });

  const rules: Record<string, unknown> =
    isRecord(config) && isRecord(config.rules) ? config.rules : {};
  for (const key of RULE_KEYS) {
    if (!RULE_CHECKS[key](own(rules, key))) errors.push(ruleValueError(key));
  }
  for (const key of Object.keys(rules)) {
    if (!isRuleKey(key)) errors.push(`"${key}" is not a funnel rule.`);
  }
  if (errors.length > 0) return errors;

  // Coverage under every combination of the rules a gate reads: every
  // combination of dimensions must land in a stage, and each stage must be
  // someone's first match under at least one of them. A stage that is empty
  // under the rules in force is hidden, not an error.
  const stages = list as OnboardingFunnelStageConfig[];
  const reached = new Set<number>();
  const uncovered = new Map<string, string>();
  for (const variant of gateRuleVariants(rules as unknown as OnboardingFunnelRules)) {
    for (const d of SAMPLES) {
      const index = firstMatch(stages, d, variant);
      if (index >= 0) reached.add(index);
      else if (!uncovered.has(describeSample(d)))
        uncovered.set(describeSample(d), describeVariant(variant));
    }
  }
  // One message: the first provider who fits nowhere, and how many other
  // kinds of provider share the problem.
  const [first] = uncovered;
  if (first) {
    const others = uncovered.size - 1;
    errors.push(
      `${first[0]} would fit no stage when ${first[1]}${
        others > 0
          ? `, and ${others} other kind${others === 1 ? "" : "s"} of provider would too`
          : ""
      }. Add a stage for them, or end with an "everyone else" stage ("any").`,
    );
  }
  stages.forEach((stage, i) => {
    if (!reached.has(i))
      errors.push(
        `"${stage.label.trim()}" can never be reached: the stages before it take everyone its gate would.`,
      );
  });
  return errors;
}

const copyStage = (stage: OnboardingFunnelStageConfig): OnboardingFunnelStageConfig => ({
  key: stage.key,
  label: stage.label,
  description: stage.description,
  gate: stage.gate,
});

const caqhWindowOrDefault = (value: unknown): number =>
  isValidCaqhAttestationWindowDays(value) ? value : DEFAULT_CAQH_ATTESTATION_WINDOW_DAYS;

/** The configuration the funnel actually runs, from a resolved one (Minted's
 * list with the organization's copy already applied): rules field by field
 * (a bad value falls back to the default), the stage list only if it
 * validates under those rules, else the default list, which is valid under
 * every rule, and the shared CAQH window if it is a valid number of days. A
 * broken configuration therefore never drops a provider. The resolver never
 * lets an organization's copy break a valid list, so this fallback never
 * discards Minted's list because of an organization. */
export function effectiveOnboardingFunnelConfig(
  config: OnboardingFunnelConfig | null | undefined,
): OnboardingFunnelConfig {
  const rules = resolveOnboardingFunnelRules(null, isRecord(config) ? config.rules : null);
  const stages =
    isRecord(config) &&
    validateOnboardingFunnelConfig({ stages: config.stages, rules }).length === 0
      ? config.stages
      : DEFAULT_ONBOARDING_FUNNEL_STAGES;
  return {
    stages: stages.map(copyStage),
    rules,
    caqhAttestationWindowDays: caqhWindowOrDefault(
      isRecord(config) ? config.caqhAttestationWindowDays : null,
    ),
  };
}

/** Plain-language problems with Minted's platform layer; empty when it can
 * go live. Its rules may be any subset (the rest inherit the default); its
 * stage list, when given, must validate under those rules. */
export function validateOnboardingFunnelPlatformOverride(
  platform: OnboardingFunnelPlatformOverride | null | undefined,
): string[] {
  if (platform == null) return [];
  if (!isRecord(platform)) return ["Minted's funnel settings must be an object."];
  const rules = own(platform, "rules");
  const errors = ruleOverrideErrors(rules, "Minted's");
  const stages = own(platform, "stages");
  if (stages != null)
    errors.push(
      ...validateOnboardingFunnelConfig({
        stages: stages as ReadonlyArray<OnboardingFunnelStageConfig>,
        rules: resolveOnboardingFunnelRules(
          rules as OnboardingFunnelRulesOverride | null | undefined,
          null,
        ),
      }),
    );
  return errors;
}

const STAGE_TEXT_FIELDS = new Set(["label", "description"]);

/** Plain-language problems with an organization's layer; empty when it can
 * go live. `minted` is Minted's resolved configuration, the stage list and
 * rules the layer sits on (resolveOnboardingFunnelConfig(platform, null,
 * window)); the save path (MINT-125) must pass it. */
export function validateOnboardingFunnelOrganizationOverride(
  organization: OnboardingFunnelOrganizationOverride | null | undefined,
  minted: OnboardingFunnelStagesAndRules,
): string[] {
  const stages = minted.stages;
  if (organization == null) return [];
  if (!isRecord(organization)) return ["An organization's funnel settings must be an object."];
  const errors: string[] = [];
  if (own(organization, "stages") != null)
    errors.push(
      "An organization cannot change the stage list: Minted sets the stages, their order and their gates. Change labels and descriptions instead.",
    );

  const text: unknown = own(organization, "stageText");
  const labels = new Map(stages.map((stage) => [stage.key, stage.label.trim()]));
  if (text != null && !isRecord(text))
    errors.push("Stage labels and descriptions must be given per stage key.");
  else if (isRecord(text)) {
    for (const [key, entry] of Object.entries(text)) {
      if (!labels.has(key)) {
        errors.push(`"${key}" is not one of Minted's stages, so it cannot be relabelled.`);
        continue;
      }
      if (!isRecord(entry)) {
        errors.push(`"${key}": give a label, a description, or both.`);
        continue;
      }
      if (Object.keys(entry).some((field) => !STAGE_TEXT_FIELDS.has(field)))
        errors.push(`"${key}": only the label and the description can change.`);
      const ownLabel = own(entry, "label");
      const ownDescription = own(entry, "description");
      if (ownLabel != null) {
        const label = typeof ownLabel === "string" ? ownLabel.trim() : "";
        // No swapping: another stage's own label would name the wrong stage.
        // This is about which stage a label names, not its wording (A29).
        const taken = stages.find(
          (stage) => stage.key !== key && stage.label.trim().toLowerCase() === label.toLowerCase(),
        );
        if (!label) errors.push(`"${key}": the label cannot be empty.`);
        else if (label.length > MAX_LABEL)
          errors.push(`"${key}": keep the label to ${MAX_LABEL} characters.`);
        else if (taken) errors.push(`"${key}": "${label}" is Minted's label for "${taken.key}".`);
        else labels.set(key, label);
      }
      if (ownDescription != null) {
        const description = typeof ownDescription === "string" ? ownDescription.trim() : "";
        if (!description) errors.push(`"${key}": the description cannot be empty.`);
        else if (description.length > MAX_DESCRIPTION)
          errors.push(`"${key}": keep the description to ${MAX_DESCRIPTION} characters.`);
      }
    }
    const seen = new Set<string>();
    for (const label of labels.values()) {
      if (seen.has(label.toLowerCase())) errors.push(`The label "${label}" would be used twice.`);
      seen.add(label.toLowerCase());
    }
  }

  const rules = own(organization, "rules");
  errors.push(...ruleOverrideErrors(rules, "The organization's"));
  // Defence in depth: the rules this layer would put in force must still
  // work with Minted's list. (Minted's list is checked under every value a
  // gate reads, so this holds for a valid list.)
  if (errors.length === 0) {
    const merged = resolveOnboardingFunnelRules(
      minted.rules,
      rules as OnboardingFunnelRulesOverride | null | undefined,
    );
    for (const problem of validateOnboardingFunnelConfig({ stages, rules: merged }))
      errors.push(`With this organization's rules, Minted's stages fail: ${problem}`);
  }
  return errors;
}

/** A stored override that was not used, and why (A19). */
export interface OnboardingFunnelIgnoredOverride {
  layer: "platform" | "organization";
  /** "stages": Minted's stage list; the default list ran instead. "rules":
   * some of Minted's rules; each named one kept its default. "layer": the
   * whole layer; for an organization, Minted's configuration ran instead. */
  part: "stages" | "rules" | "layer";
  reasons: string[];
}

export interface OnboardingFunnelResolution {
  config: OnboardingFunnelConfig;
  /** What was ignored, so Mission Control can flag it ("override ignored:
   * invalid" on the org's Settings tab, A19). Empty when everything stored
   * was used. */
  ignored: OnboardingFunnelIgnoredOverride[];
}

/** resolveOnboardingFunnelConfig, plus which stored layer was ignored and
 * why (A19). */
export function explainOnboardingFunnelConfig(
  platform: OnboardingFunnelPlatformOverride | null | undefined,
  organization: OnboardingFunnelOrganizationOverride | null | undefined,
  caqhAttestationWindowDays: number,
): OnboardingFunnelResolution {
  const ignored: OnboardingFunnelIgnoredOverride[] = [];
  // Stored values may be any shape; the rules resolver and the validators
  // all check, so a bad one is skipped (and reported) rather than run.
  const platformLayer = isRecord(platform) ? platform : null;
  if (platform != null && !platformLayer)
    ignored.push({
      layer: "platform",
      part: "layer",
      reasons: ["Minted's funnel settings must be an object."],
    });
  const platformRuleOverride = platformLayer ? own(platformLayer, "rules") : null;
  const platformRuleErrors = ruleOverrideErrors(platformRuleOverride, "Minted's");
  if (platformRuleErrors.length > 0)
    ignored.push({ layer: "platform", part: "rules", reasons: platformRuleErrors });
  const platformRules = resolveOnboardingFunnelRules(
    platformRuleOverride as OnboardingFunnelRulesOverride | null | undefined,
    null,
  );
  const list = platformLayer ? own(platformLayer, "stages") : null;
  let stages: ReadonlyArray<OnboardingFunnelStageConfig> = DEFAULT_ONBOARDING_FUNNEL_STAGES;
  if (list != null) {
    const problems = validateOnboardingFunnelConfig({
      stages: list as ReadonlyArray<OnboardingFunnelStageConfig>,
      rules: platformRules,
    });
    if (problems.length > 0) ignored.push({ layer: "platform", part: "stages", reasons: problems });
    else stages = list as ReadonlyArray<OnboardingFunnelStageConfig>;
  }
  const minted: OnboardingFunnelConfig = {
    stages: stages.map(copyStage),
    rules: platformRules,
    caqhAttestationWindowDays: caqhWindowOrDefault(caqhAttestationWindowDays),
  };
  if (organization == null) return { config: minted, ignored };
  const problems = validateOnboardingFunnelOrganizationOverride(organization, minted);
  if (problems.length > 0) {
    ignored.push({ layer: "organization", part: "layer", reasons: problems });
    return { config: minted, ignored };
  }
  const text = organization.stageText ?? {};
  return {
    config: {
      ...minted,
      stages: minted.stages.map((stage) => {
        const copy = Object.hasOwn(text, stage.key) ? text[stage.key] : undefined;
        return {
          ...stage,
          label: copy?.label != null ? copy.label.trim() : stage.label,
          description: copy?.description != null ? copy.description.trim() : stage.description,
        };
      }),
      rules: resolveOnboardingFunnelRules(
        platformRuleOverride as OnboardingFunnelRulesOverride | null | undefined,
        organization.rules,
      ),
    },
    ignored,
  };
}

/** Minted's configuration (the platform's stage list, if it validates, else
 * the default, and the platform's rules field by field over the default),
 * with the organization's layer on top when that layer validates: its
 * labels, descriptions and rules go live together or not at all. An
 * organization never changes a stage's count, order or gate. The CAQH
 * window is the shared setting, resolved by resolveCaqhAttestationWindowDays
 * and passed in. */
export function resolveOnboardingFunnelConfig(
  platform: OnboardingFunnelPlatformOverride | null | undefined,
  organization: OnboardingFunnelOrganizationOverride | null | undefined,
  caqhAttestationWindowDays: number,
): OnboardingFunnelConfig {
  return explainOnboardingFunnelConfig(platform, organization, caqhAttestationWindowDays).config;
}

/** The stages the report shows, in order: intake-gated stages need the
 * intake tables, and a stage no provider could reach under the rules in
 * force is hidden (its gate cannot match, or the stages before it take
 * everyone it would). An organization's rules hiding a stage is intended. */
export function visibleOnboardingFunnelStages(
  config: OnboardingFunnelConfig,
  intakeReadable: boolean,
): OnboardingFunnelStageInfo[] {
  const { stages, rules } = effectiveOnboardingFunnelConfig(config);
  const reachable = reachableStages(stages, rules);
  return stages.flatMap((stage, i) => {
    const gate = GATES.get(stage.gate);
    const info = {
      ...stage,
      needsIntakeData: gate?.needsIntakeData ?? false,
      listsGaps: gate?.listsGaps ?? false,
    };
    return reachable.has(i) && (intakeReadable || !info.needsIntakeData) ? [info] : [];
  });
}

function placeIn(
  d: OnboardingFunnelDimensions,
  stages: ReadonlyArray<OnboardingFunnelStageConfig>,
  rules: OnboardingFunnelRules,
): { stage: OnboardingFunnelStageKey; gaps: string[]; gate: OnboardingFunnelGate } {
  for (const stage of stages) {
    const gate = GATES.get(stage.gate);
    if (gate?.matches(d, rules))
      return { stage: stage.key, gaps: gate.gaps(d, rules), gate: stage.gate };
  }
  // Unreachable: the stages in use always passed validation, which proves
  // every combination lands somewhere.
  const last = stages[stages.length - 1];
  return { stage: last.key, gaps: [], gate: last.gate };
}

/** Where providers with these dimensions sit under a configuration (the
 * configuration the funnel would actually run, resolved once). */
export function placeOnboardingFunnelStages(
  dimensions: readonly OnboardingFunnelDimensions[],
  config: OnboardingFunnelConfig,
): Array<{ stage: OnboardingFunnelStageKey; gaps: string[] }> {
  const effective = effectiveOnboardingFunnelConfig(config);
  return dimensions.map((d) => {
    const { stage, gaps } = placeIn(d, effective.stages, effective.rules);
    return { stage, gaps };
  });
}

/** Where one provider with these dimensions sits under a configuration. */
export function placeOnboardingFunnelStage(
  d: OnboardingFunnelDimensions,
  config: OnboardingFunnelConfig,
): { stage: OnboardingFunnelStageKey; gaps: string[] } {
  return placeOnboardingFunnelStages([d], config)[0];
}

// ---------------------------------------------------------------------------
// Input and rows

export interface OnboardingFunnelProviderFacts {
  providerId: string;
  name: string;
  npi: string | null;
  caqhIdPresent: boolean;
  caqhLastAttestedDate: string | null;
  dobPresent: boolean;
  ssnLast4Present: boolean;
  pendingVerification: boolean;
}

export interface OnboardingFunnelLicenseInput {
  providerId: string | null;
  state: string;
  verifiedStatus: string;
  expirationDate: string | null;
}

/** One assignment to an active, non-reference location. */
export interface OnboardingFunnelLocationInput {
  providerId: string | null;
  locationId: string;
  locationName: string;
  state: string | null;
  /** The group the location is under; null when it has none. */
  groupId: string | null;
  groupName: string | null;
  /** The assignment's start date (provider_facility_assignments.start_date). */
  assignmentStartDate: string | null;
}

/** A group membership, current or not. */
export interface OnboardingFunnelMembershipInput {
  providerId: string | null;
  groupId: string | null;
  groupName: string | null;
  /** null when the read cannot see the group: unknown, never "inactive". */
  groupActive: boolean | null;
  startDate: string | null;
  endDate: string | null;
}

export interface OnboardingFunnelCaseInput {
  providerId: string | null;
  state: string | null;
  /** null when the stored value is not a known status; such a case counts. */
  status: CaseStatus | null;
}

/** One intake invite (slice 2, MINT-89): the provider was invited, and
 * whether they sent the form back. Read only while intakeReadable. */
export interface OnboardingFunnelIntakeInput {
  providerId: string | null;
  intakeSubmitted: boolean;
}

export interface OnboardingFunnelInput {
  providers: readonly OnboardingFunnelProviderFacts[];
  licenses: readonly OnboardingFunnelLicenseInput[];
  locations: readonly OnboardingFunnelLocationInput[];
  groupMemberships: readonly OnboardingFunnelMembershipInput[];
  cases: readonly OnboardingFunnelCaseInput[];
  /** False while the intake tables cannot be read (MINT-89): the intake
   * dimension is null and intake-gated stages stay hidden. */
  intakeReadable: boolean;
  intake?: readonly OnboardingFunnelIntakeInput[];
}

/** What the service returns: the input plus the configuration resolved for
 * the org. */
export interface OnboardingFunnelRead extends OnboardingFunnelInput {
  config: OnboardingFunnelConfig;
}

/** The tag on a row whose provider has an outstanding invite but sits past
 * Invited (A28). */
export const INVITE_OUTSTANDING_TAG = "Invite outstanding";

export interface OnboardingFunnelRow {
  providerId: string;
  name: string;
  npi: string | null;
  stage: OnboardingFunnelStageKey;
  /** What keeps the provider in their stage, for stages whose gate lists gaps. */
  gaps: string[];
  /** Facts shown beside the name, such as an outstanding invite (A28). */
  tags: string[];
  /** Every state the provider touches: work, license, or any case on file. */
  states: string[];
  dimensions: OnboardingFunnelDimensions;
}

export const STATELESS_LOCATION_GAP = "Location has no valid state on record";
/** A23: staff assign groups, so this is a staff-side gap, never the
 * provider's reason. */
export const NO_GROUP_GAP = "No group assigned yet";

function code(value: string | null): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function day(value: string | null): string | null {
  return value === null ? null : value.slice(0, 10);
}

function groupByProvider<T extends { providerId: string | null }>(rows: readonly T[]) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.providerId) continue;
    map.set(row.providerId, [...(map.get(row.providerId) ?? []), row]);
  }
  return map;
}

/** Why a membership is not current, or null when it is. */
function lapsedMembershipReason(
  membership: OnboardingFunnelMembershipInput,
  today: string,
  rules: OnboardingFunnelRules,
): string | null {
  const name = membership.groupName ?? "the provider's group";
  const start = day(membership.startDate);
  const end = day(membership.endDate);
  // A group the read cannot see is unknown: it does not count, and the
  // reason claims nothing about it.
  if (membership.groupActive === null) return "Membership group not found";
  if (!membership.groupActive)
    return membership.groupName
      ? `Group ${membership.groupName} is inactive`
      : "The provider's group is inactive";
  if (end !== null && end < today) return `Membership in ${name} ended ${end}`;
  if (!rules.futureMembershipCounts && start !== null && start > today)
    return `Membership in ${name} starts ${start}`;
  return null;
}

/** Why a location does not count, or null when it does. */
function locationReason(
  location: OnboardingFunnelLocationInput,
  current: ReadonlySet<string>,
  lapsed: ReadonlyMap<string, string>,
  today: string,
  rules: OnboardingFunnelRules,
): string | null {
  const name = location.locationName;
  if (rules.locationMustBeInProviderGroup) {
    if (location.groupId === null) {
      if (!rules.ungroupedLocationCounts) return `Location ${name} has no group`;
    } else if (!current.has(location.groupId)) {
      return (
        lapsed.get(location.groupId) ??
        `Location ${name} is under ${location.groupName ?? "another group"}, not the provider's group`
      );
    }
  }
  const start = day(location.assignmentStartDate);
  if (!rules.futureLocationAssignmentCounts && start !== null && start > today)
    return `Assignment to ${name} starts ${start}`;
  return null;
}

interface Placement {
  assignmentGaps: string[];
  groupGaps: string[];
  stateGaps: string[];
}

function placementGaps(
  memberships: readonly OnboardingFunnelMembershipInput[],
  locations: readonly OnboardingFunnelLocationInput[],
  today: string,
  rules: OnboardingFunnelRules,
): Placement {
  const current = new Set<string>();
  const lapsed = new Map<string, string>();
  for (const m of memberships) {
    if (!m.groupId) continue;
    const reason = lapsedMembershipReason(m, today, rules);
    if (reason === null) current.add(m.groupId);
    else lapsed.set(m.groupId, reason);
  }

  // The group (A23, staff-side): named when a membership exists but does not
  // count, else the plain fact that none is assigned.
  const groupGaps =
    current.size > 0 ? [] : lapsed.size > 0 ? [...new Set(lapsed.values())].sort() : [NO_GROUP_GAP];

  // The location: per-location reasons, for a provider with or without a
  // group alike (A23). An ungrouped location can count for anyone (A22).
  let assignmentGaps: string[] = [];
  if (locations.length === 0) assignmentGaps = ["Needs a location"];
  else {
    const sorted = [...locations].sort(
      (a, b) =>
        a.locationName.localeCompare(b.locationName) || a.locationId.localeCompare(b.locationId),
    );
    const reasons = sorted.map((l) => locationReason(l, current, lapsed, today, rules));
    if (reasons.every((reason) => reason !== null))
      assignmentGaps = [...new Set(reasons as string[])];
  }

  const stateGaps = locations.some((l) => code(l.state) === null) ? [STATELESS_LOCATION_GAP] : [];
  return { assignmentGaps, groupGaps, stateGaps };
}

export function buildOnboardingFunnelRows(
  input: OnboardingFunnelInput,
  today: string,
  config: OnboardingFunnelConfig,
): OnboardingFunnelRow[] {
  // A configuration that fails validation (an empty or malformed list, a
  // gap in coverage) is never run: the default list is.
  const { rules, stages, caqhAttestationWindowDays } = effectiveOnboardingFunnelConfig(config);
  const required = new Set(rules.requiredProfileFields);
  const notCounted = new Set<string>(rules.caseStatusesNotCountedAsCredentialing);
  const licensesBy = groupByProvider(input.licenses);
  const locationsBy = groupByProvider(input.locations);
  const casesBy = groupByProvider(input.cases);
  const membershipsBy = groupByProvider(input.groupMemberships);
  // Intake is a fact or nothing: unread tables give null, never a guess.
  const intakeBy = input.intakeReadable ? groupByProvider(input.intake ?? []) : null;
  // A license with no expiry sorts last while it is not current, first
  // while it counts as never expiring.
  const expirySortKey = (date: string | null) =>
    date ?? (rules.licenseWithoutExpiryHolds ? "" : "9999-12-31");

  return input.providers
    .map((p): OnboardingFunnelRow => {
      const licenses = licensesBy.get(p.providerId) ?? [];
      const locations = locationsBy.get(p.providerId) ?? [];
      const cases = casesBy.get(p.providerId) ?? [];
      const workStates = [...new Set(locations.map((row) => code(row.state)))].filter(
        (s): s is string => s !== null,
      );
      // Facts: every case counts toward the states the provider touches.
      const states = [
        ...new Set(
          [
            ...workStates,
            ...licenses.map((l) => code(l.state)),
            ...cases.map((c) => code(c.state)),
          ].filter((s): s is string => s !== null),
        ),
      ].sort();

      // complete, over the required fields (A26). A license only counts once
      // its state code is valid: one with a blank or unknown state can never
      // be checked against a working state.
      const stateLicenses = licenses.filter((l) => code(l.state) !== null);
      const licenseStates = new Set(stateLicenses.map((l) => code(l.state) as string));
      const licenseGaps = [
        ...(stateLicenses.length === 0
          ? [licenses.length === 0 ? "No state license" : "License state is missing or invalid"]
          : []),
        ...(stateLicenses.length === 0
          ? []
          : workStates.filter((s) => !licenseStates.has(s)).map((s) => `No ${s} license`)),
      ];
      const completenessGaps = [
        ...(required.has("npi") && !p.npi?.trim() ? ["No NPI"] : []),
        ...(required.has("caqhId") && !p.caqhIdPresent ? ["No CAQH ID"] : []),
        ...(required.has("dateOfBirth") && !p.dobPresent ? ["No date of birth"] : []),
        ...(required.has("ssnLast4") && !p.ssnLast4Present ? ["No SSN last 4"] : []),
        ...(required.has("stateLicense") ? licenseGaps : []),
      ];

      // verified. Judge the licenses for the valid states they work in;
      // with no valid working state, every license on file. A stateless
      // location is a gap of its own. While another location has a valid
      // state, no license is judged for the stateless one: the state it will
      // have is unknown (an open question for the PM).
      const judged = workStates.length > 0 ? workStates : [...licenseStates];
      const verificationGaps: string[] = [];
      for (const state of judged) {
        const best = stateLicenses
          .filter((l) => code(l.state) === state)
          .sort(
            (a, b) =>
              Number(b.verifiedStatus === "verified") - Number(a.verifiedStatus === "verified") ||
              expirySortKey(b.expirationDate).localeCompare(expirySortKey(a.expirationDate)),
          )[0];
        if (!best) continue;
        if (best.verifiedStatus !== "verified")
          verificationGaps.push(`${state} license not board-verified`);
        if (!best.expirationDate) {
          if (rules.licenseWithoutExpiryHolds)
            verificationGaps.push(`${state} license has no expiration date`);
        } else if (best.expirationDate.slice(0, 10) < today)
          verificationGaps.push(`${state} license expired`);
      }
      // CAQH attestation is checked when a CAQH ID is required or on file:
      // a provider with neither has nothing to attest, so they are never
      // held by it.
      if (required.has("caqhId") || p.caqhIdPresent) {
        const attested = day(p.caqhLastAttestedDate);
        if (!isCaqhCurrent(attested, today, caqhAttestationWindowDays)) {
          verificationGaps.push(
            !attested
              ? "CAQH never attested"
              : attested > today
                ? "CAQH attestation date is in the future"
                : `CAQH attestation older than ${caqhAttestationWindowDays} days`,
          );
        }
      }
      if (p.pendingVerification) verificationGaps.push("Record pending verification");

      // assigned, grouped, statesValid.
      const placement = placementGaps(
        membershipsBy.get(p.providerId) ?? [],
        locations,
        today,
        rules,
      );

      // intake.
      const invites = intakeBy?.get(p.providerId) ?? [];

      const dimensions: OnboardingFunnelDimensions = {
        complete: completenessGaps.length === 0,
        completenessGaps,
        verified: verificationGaps.length === 0,
        verificationGaps,
        assigned: placement.assignmentGaps.length === 0,
        assignmentGaps: placement.assignmentGaps,
        grouped: placement.groupGaps.length === 0,
        groupGaps: placement.groupGaps,
        statesValid: placement.stateGaps.length === 0,
        stateGaps: placement.stateGaps,
        hasCase: cases.length > 0,
        caseCount: cases.length,
        caseStatuses: cases.map((c) => c.status),
        hasCountedCase: cases.some((c) => c.status === null || !notCounted.has(c.status)),
        intake:
          intakeBy === null
            ? null
            : {
                invited: invites.length > 0,
                intakeSubmitted: invites.some((row) => row.intakeSubmitted),
              },
      };
      const placed = placeIn(dimensions, stages, rules);
      return {
        providerId: p.providerId,
        name: p.name,
        npi: p.npi,
        stage: placed.stage,
        gaps: placed.gaps,
        // A28: an outstanding invite stays visible on a provider placed past
        // Invited.
        tags:
          inviteOutstanding(dimensions) && placed.gate !== "invited_not_submitted"
            ? [INVITE_OUTSTANDING_TAG]
            : [],
        states,
        dimensions,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.providerId.localeCompare(b.providerId));
}

/** Providers per stage key, every stage present. */
export function onboardingFunnelStageCounts(
  rows: readonly OnboardingFunnelRow[],
  stages: ReadonlyArray<Pick<OnboardingFunnelStageConfig, "key">>,
): Record<OnboardingFunnelStageKey, number> {
  const counts: Record<OnboardingFunnelStageKey, number> = Object.fromEntries(
    stages.map((stage) => [stage.key, 0]),
  );
  for (const row of rows)
    counts[row.stage] = (Object.hasOwn(counts, row.stage) ? counts[row.stage] : 0) + 1;
  return counts;
}

/** Every state any provider touches (work, license, or case), A→Z. */
export function onboardingFunnelStates(rows: readonly OnboardingFunnelRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.states))].sort();
}
