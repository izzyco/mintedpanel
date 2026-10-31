// Provider Onboarding funnel (Oct 20 review, RC-06; stage names from the PM,
// Oct 30, and her answers of Oct 31). The funnel is the provider's state, not
// case status. Pure; "today" and the configuration are passed in.
//
// Two layers, kept apart:
//
// 1. Dimensions: facts about each provider, each computed on its own.
//    complete   every required field is present: NPI, CAQH ID, date of birth,
//               SSN last 4, and a license (any license with a valid state
//               code, and one for each state they are assigned to work in).
//    verified   the record is not pending verification, CAQH is attested
//               within the last 120 days (a future date never counts), and
//               every license judged is board-verified with an expiration
//               date not yet passed. Licenses are judged for the states of
//               the provider's active locations; with no location, every
//               license on file is. While a stateless location holds the
//               provider (below), it gets no fallback.
//    assigned   a current group membership, an active non-reference location,
//               by default a location under one of their current groups
//               (facilities.group_id), and by default a valid state on every
//               active location. A location under another group is still a
//               place they are assigned to work: its state still counts for
//               the license checks above.
//    hasCase    at least one case that counts as Credentialing, with the
//               status of every case on file.
//    intake     invited, and whether the intake form came back: a fact, read
//               only once the intake tables can be read (MINT-89). Until then
//               it is null and is never inferred.
//
// 2. Stages: configuration. An ordered list; each stage has a stable key, a
//    label, a description and a gate picked from a fixed menu of predicates
//    over the dimensions (ONBOARDING_FUNNEL_GATES). The first stage whose
//    gate matches wins, and the last stage is a catch-all, so every counted
//    provider sits in exactly one. The default list is the PM's:
//
//    Invited (hidden until intake data can be read), Profile incomplete,
//    Submitted (the information is complete and not yet verified; it says
//    nothing about anything being sent anywhere), Verified awaiting
//    assignment, Ready for credentialing, Credentialing (any case, in any
//    status by default; never split by status, which belongs on the case
//    board).
//
// Business policy is configuration, never a constant: the stage list and the
// rules (OnboardingFunnelRules) resolve from the platform default, then a
// platform override, then an organization override, field by field
// (resolveOnboardingFunnelConfig). validateOnboardingFunnelConfig is the
// check an override must pass before it goes live. Nothing stores an
// override yet; the Mission Control setting is MINT-125.
//
// A group membership counts until its end date passes; by default its start
// date is ignored, because credentialing happens before a provider starts.
// Billing Readiness (src/lib/billingReadiness.ts) and the contract SOP
// assignments (src/services/contractSopAssignments.ts) do require a start
// date on or before today, because they ask who is working now.
//
// Not the provider onboarding (intake) flow in src/lib/providerOnboarding.ts:
// this is the Reporting Center funnel over the provider records themselves.
// PHI rule: demographics arrive as presence booleans only.
import { isCaseStatus, type CaseStatus } from "@/lib/caseStatus";
import { isCaqhCurrent, CAQH_CURRENT_DAYS } from "@/lib/enrollmentReadiness";

// ---------------------------------------------------------------------------
// Rules

/** The funnel's policy rules. Each field names its default, so the
 * alternative is the obvious other value. */
export interface OnboardingFunnelRules {
  /** Case statuses that do NOT count as Credentialing. A case in one of them
   * is ignored, as if it did not exist. Default empty: every case counts,
   * whatever its status. */
  caseStatusesNotCountedAsCredentialing: readonly CaseStatus[];
  /** True (default): an active location with no valid state keeps the
   * provider from being assigned. False: it counts like any other location;
   * its license cannot be judged, so with no valid working state at all every
   * license on file is judged instead. */
  statelessLocationHolds: boolean;
  /** True (default): a group membership that starts after today already
   * counts as current. False: it counts from its start date. A membership
   * with no start date counts either way. */
  futureMembershipCounts: boolean;
  /** True (default): a location counts only when it is under one of the
   * provider's current groups. False: any active, non-reference location
   * counts. */
  locationMustBeInProviderGroup: boolean;
  /** True (default): Ready needs the provider assigned (group, location,
   * and the location checks above). False: a complete, verified provider is
   * Ready without an assignment. */
  assignmentRequiredForReady: boolean;
}

/** The platform default: the PM's decisions of Oct 30 and 31. */
export const DEFAULT_ONBOARDING_FUNNEL_RULES: Readonly<OnboardingFunnelRules> = Object.freeze({
  caseStatusesNotCountedAsCredentialing: Object.freeze<CaseStatus[]>([]),
  statelessLocationHolds: true,
  futureMembershipCounts: true,
  locationMustBeInProviderGroup: true,
  assignmentRequiredForReady: true,
});

/** A platform or organization override. A null or missing field inherits;
 * an empty list is a real value (every case counts), not an inherit. */
export type OnboardingFunnelRulesOverride = {
  readonly [K in keyof OnboardingFunnelRules]?: OnboardingFunnelRules[K] | null;
};

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const RULE_CHECKS: { [K in keyof OnboardingFunnelRules]: (value: unknown) => boolean } = {
  caseStatusesNotCountedAsCredentialing: (value) =>
    Array.isArray(value) && value.every((status) => isCaseStatus(status)),
  statelessLocationHolds: isBoolean,
  futureMembershipCounts: isBoolean,
  locationMustBeInProviderGroup: isBoolean,
  assignmentRequiredForReady: isBoolean,
};

const RULE_KEYS = Object.keys(RULE_CHECKS) as Array<keyof OnboardingFunnelRules>;

/** Field by field: the organization's value, else the platform's, else the
 * default. A stored value of the wrong shape is skipped like a missing one. */
export function resolveOnboardingFunnelRules(
  platform?: OnboardingFunnelRulesOverride | null,
  organization?: OnboardingFunnelRulesOverride | null,
): OnboardingFunnelRules {
  const pick = <K extends keyof OnboardingFunnelRules>(key: K): OnboardingFunnelRules[K] => {
    for (const override of [organization, platform]) {
      const value: unknown = override?.[key];
      if (value != null && RULE_CHECKS[key](value)) return value as OnboardingFunnelRules[K];
    }
    return DEFAULT_ONBOARDING_FUNNEL_RULES[key];
  };
  return {
    caseStatusesNotCountedAsCredentialing: [
      ...new Set(pick("caseStatusesNotCountedAsCredentialing")),
    ],
    statelessLocationHolds: pick("statelessLocationHolds"),
    futureMembershipCounts: pick("futureMembershipCounts"),
    locationMustBeInProviderGroup: pick("locationMustBeInProviderGroup"),
    assignmentRequiredForReady: pick("assignmentRequiredForReady"),
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
  assigned: boolean;
  assignmentGaps: string[];
  /** At least one case that counts as Credentialing under the rules. */
  hasCase: boolean;
  /** The status of every case on file, counted or not; null for a stored
   * value that is not a known status. */
  caseStatuses: Array<CaseStatus | null>;
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

const assignmentOk = (d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules) =>
  d.assigned || !rules.assignmentRequiredForReady;
const readyNow = (d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules) =>
  d.complete && d.verified && assignmentOk(d, rules);
const assignmentHolds = (d: OnboardingFunnelDimensions, rules: OnboardingFunnelRules) =>
  rules.assignmentRequiredForReady ? d.assignmentGaps : [];
const none = () => [];

const GATE_LIST: readonly GateDefinition[] = [
  {
    key: "invited_not_submitted",
    description: "Invited to the intake form, has not sent it back, and has no case.",
    needsIntakeData: true,
    listsGaps: false,
    matches: (d) =>
      !d.hasCase && d.intake !== null && d.intake.invited && !d.intake.intakeSubmitted,
    gaps: none,
  },
  {
    key: "incomplete",
    description: "A required field is missing, and no case.",
    needsIntakeData: false,
    listsGaps: true,
    matches: (d) => !d.hasCase && !d.complete,
    gaps: (d) => d.completenessGaps,
  },
  {
    key: "complete_unverified",
    description: "Complete but not verified, and no case. Lists assignment gaps too.",
    needsIntakeData: false,
    listsGaps: true,
    matches: (d) => !d.hasCase && d.complete && !d.verified,
    gaps: (d, rules) => [...d.verificationGaps, ...assignmentHolds(d, rules)],
  },
  {
    key: "verified_unassigned",
    description: "Complete and verified, but not assigned where Ready needs it, and no case.",
    needsIntakeData: false,
    listsGaps: true,
    matches: (d, rules) => !d.hasCase && d.complete && d.verified && !assignmentOk(d, rules),
    gaps: (d) => d.assignmentGaps,
  },
  {
    key: "not_ready",
    description: "Anything short of Ready, and no case. Lists every gap.",
    needsIntakeData: false,
    listsGaps: true,
    matches: (d, rules) => !d.hasCase && !readyNow(d, rules),
    gaps: (d, rules) => [
      ...d.completenessGaps,
      ...d.verificationGaps,
      ...assignmentHolds(d, rules),
    ],
  },
  {
    key: "ready",
    description: "Complete, verified, assigned where required, and no case.",
    needsIntakeData: false,
    listsGaps: false,
    matches: (d, rules) => !d.hasCase && readyNow(d, rules),
    gaps: none,
  },
  {
    key: "has_case",
    description: "Has a case that counts as Credentialing.",
    needsIntakeData: false,
    listsGaps: false,
    matches: (d) => d.hasCase,
    gaps: none,
  },
  {
    key: "any",
    description:
      "Everyone not placed by an earlier stage. The last stage uses it, and only the last.",
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
    description: "Verified, but the group or location assignment is incomplete.",
    gate: "verified_unassigned",
  },
  {
    key: "ready_for_credentialing",
    label: "Ready for credentialing",
    description: "Verified and assigned to a group and one of its locations. No case yet.",
    gate: "ready",
  },
  {
    key: "credentialing",
    label: "Credentialing",
    description: "Has at least one credentialing case, in any status.",
    gate: "any",
  },
];

/** The PM's stages (Oct 30 and 31), in funnel order. */
export const DEFAULT_ONBOARDING_FUNNEL_STAGES: ReadonlyArray<
  Readonly<OnboardingFunnelStageConfig>
> = Object.freeze(DEFAULT_STAGE_LIST.map((stage) => Object.freeze({ ...stage })));

export interface OnboardingFunnelConfig {
  stages: ReadonlyArray<Readonly<OnboardingFunnelStageConfig>>;
  rules: OnboardingFunnelRules;
}

export const DEFAULT_ONBOARDING_FUNNEL_CONFIG: Readonly<OnboardingFunnelConfig> = Object.freeze({
  stages: DEFAULT_ONBOARDING_FUNNEL_STAGES,
  rules: DEFAULT_ONBOARDING_FUNNEL_RULES,
});

/** A platform or organization override. A stage list replaces the whole list
 * (order is part of it); null or missing inherits. Rules resolve field by
 * field. */
export interface OnboardingFunnelConfigOverride {
  stages?: ReadonlyArray<OnboardingFunnelStageConfig> | null;
  rules?: OnboardingFunnelRulesOverride | null;
}

export interface OnboardingFunnelStageInfo extends OnboardingFunnelStageConfig {
  /** Hidden until the intake tables can be read. */
  needsIntakeData: boolean;
  /** Providers here are held by gaps the report lists ("What's needed"). */
  listsGaps: boolean;
}

/** The stages the report shows, in order. Intake-gated stages need the
 * intake tables. */
export function visibleOnboardingFunnelStages(
  stages: ReadonlyArray<OnboardingFunnelStageConfig>,
  intakeReadable: boolean,
): OnboardingFunnelStageInfo[] {
  return stages
    .map((stage) => {
      const gate = GATES.get(stage.gate);
      return {
        ...stage,
        needsIntakeData: gate?.needsIntakeData ?? false,
        listsGaps: gate?.listsGaps ?? false,
      };
    })
    .filter((stage) => intakeReadable || !stage.needsIntakeData);
}

// ---------------------------------------------------------------------------
// Validation: what an override must pass before it goes live (MINT-125)

const STAGE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LABEL = 60;
const MAX_DESCRIPTION = 200;

/** Every combination of dimension values and of the rule the gates read. */
function sampleDimensions(): Array<[OnboardingFunnelDimensions, boolean]> {
  const flags = [true, false];
  const intakes: Array<OnboardingFunnelIntakeFacts | null> = [
    null,
    { invited: false, intakeSubmitted: false },
    { invited: true, intakeSubmitted: false },
    { invited: true, intakeSubmitted: true },
  ];
  const samples: Array<[OnboardingFunnelDimensions, boolean]> = [];
  for (const complete of flags)
    for (const verified of flags)
      for (const assigned of flags)
        for (const hasCase of flags)
          for (const intake of intakes)
            for (const assignmentRequired of flags)
              samples.push([
                {
                  complete,
                  completenessGaps: [],
                  verified,
                  verificationGaps: [],
                  assigned,
                  assignmentGaps: [],
                  hasCase,
                  caseStatuses: [],
                  intake,
                },
                assignmentRequired,
              ]);
  return samples;
}

/** Plain-language problems with a configuration; empty when it can go live. */
export function validateOnboardingFunnelConfig(config: OnboardingFunnelConfig): string[] {
  const errors: string[] = [];
  const stages: ReadonlyArray<Partial<Record<keyof OnboardingFunnelStageConfig, unknown>>> =
    Array.isArray(config.stages) ? config.stages : [];
  if (stages.length === 0) errors.push("Add at least one stage.");

  const keys = new Set<string>();
  const labels = new Set<string>();
  stages.forEach((stage, i) => {
    const where = `Stage ${i + 1}`;
    const key = typeof stage.key === "string" ? stage.key : "";
    const label = typeof stage.label === "string" ? stage.label.trim() : "";
    const description = typeof stage.description === "string" ? stage.description.trim() : "";
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
    if (!GATES.has(stage.gate as OnboardingFunnelGate))
      errors.push(`${where}: "${String(stage.gate)}" is not a gate on the menu.`);
    else if (stage.gate === "any" && i !== stages.length - 1)
      errors.push(`${where}: only the last stage can take everyone ("any").`);
  });
  if (stages.length > 0 && stages[stages.length - 1].gate !== "any")
    errors.push('The last stage must take everyone not placed earlier (gate "any").');

  const rules: Record<string, unknown> = (config.rules ?? {}) as unknown as Record<string, unknown>;
  for (const key of RULE_KEYS) {
    if (!RULE_CHECKS[key](rules[key]))
      errors.push(
        key === "caseStatusesNotCountedAsCredentialing"
          ? "Case statuses that do not count must be known case statuses."
          : `The rule "${key}" must be on or off.`,
      );
  }
  if (errors.length > 0) return errors;

  // Reachability: a stage the stages before it always pre-empt, whatever the
  // provider and the assignment rule, would always be empty. The catch-all
  // is exempt.
  const typed = stages as ReadonlyArray<OnboardingFunnelStageConfig>;
  const reached = new Set<number>();
  for (const [d, assignmentRequiredForReady] of sampleDimensions()) {
    const sampleRules = { ...config.rules, assignmentRequiredForReady };
    reached.add(typed.findIndex((stage) => GATES.get(stage.gate)?.matches(d, sampleRules)));
  }
  typed.slice(0, -1).forEach((stage, i) => {
    if (!reached.has(i))
      errors.push(
        `"${stage.label.trim()}" can never be reached: the stages before it take everyone its gate would.`,
      );
  });
  return errors;
}

/** Rules field by field; a stage list is used only if it validates with
 * those rules, else the next level down: organization, platform, default. */
export function resolveOnboardingFunnelConfig(
  platform?: OnboardingFunnelConfigOverride | null,
  organization?: OnboardingFunnelConfigOverride | null,
): OnboardingFunnelConfig {
  const rules = resolveOnboardingFunnelRules(platform?.rules, organization?.rules);
  const stages =
    [organization?.stages, platform?.stages].find(
      (list): list is ReadonlyArray<OnboardingFunnelStageConfig> =>
        list != null && validateOnboardingFunnelConfig({ stages: list, rules }).length === 0,
    ) ?? DEFAULT_ONBOARDING_FUNNEL_STAGES;
  return { stages: stages.map((stage) => ({ ...stage })), rules };
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
}

/** A membership in an active group. */
export interface OnboardingFunnelMembershipInput {
  providerId: string | null;
  groupId: string | null;
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

export interface OnboardingFunnelRow {
  providerId: string;
  name: string;
  npi: string | null;
  stage: OnboardingFunnelStageKey;
  /** What keeps the provider in their stage, for stages whose gate lists gaps. */
  gaps: string[];
  states: string[];
  dimensions: OnboardingFunnelDimensions;
}

export const STATELESS_LOCATION_GAP = "Location has no valid state on record";

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

function isCurrentMembership(
  membership: OnboardingFunnelMembershipInput,
  today: string,
  rules: OnboardingFunnelRules,
): boolean {
  const start = day(membership.startDate);
  const end = day(membership.endDate);
  if (end !== null && end < today) return false;
  return rules.futureMembershipCounts || start === null || start <= today;
}

/** One reason per location, naming why it is not in the provider's group. */
function locationGroupGaps(locations: readonly OnboardingFunnelLocationInput[]): string[] {
  const sorted = [...locations].sort(
    (a, b) =>
      a.locationName.localeCompare(b.locationName) || a.locationId.localeCompare(b.locationId),
  );
  return [
    ...new Set(
      sorted.map((l) =>
        l.groupId === null
          ? `Location ${l.locationName} has no group`
          : `Location ${l.locationName} is under ${l.groupName ?? "another group"}, not the provider's group`,
      ),
    ),
  ];
}

function assignmentGaps(
  groups: ReadonlySet<string>,
  locations: readonly OnboardingFunnelLocationInput[],
  rules: OnboardingFunnelRules,
): string[] {
  const inGroup = (l: OnboardingFunnelLocationInput) =>
    !rules.locationMustBeInProviderGroup || (l.groupId !== null && groups.has(l.groupId));
  const gaps: string[] = [];
  if (groups.size === 0 && locations.length === 0) gaps.push("Needs a group and a location");
  else if (groups.size === 0) gaps.push("Needs a group");
  else if (locations.length === 0) gaps.push("Needs a location");
  else if (!locations.some(inGroup)) gaps.push(...locationGroupGaps(locations));
  if (rules.statelessLocationHolds && locations.some((l) => code(l.state) === null))
    gaps.push(STATELESS_LOCATION_GAP);
  return gaps;
}

export function buildOnboardingFunnelRows(
  input: OnboardingFunnelInput,
  today: string,
  config: OnboardingFunnelConfig,
): OnboardingFunnelRow[] {
  const { rules, stages } = config;
  const notCounted = new Set<string>(rules.caseStatusesNotCountedAsCredentialing);
  const licensesBy = groupByProvider(input.licenses);
  const locationsBy = groupByProvider(input.locations);
  const casesBy = groupByProvider(input.cases);
  const groupsBy = new Map<string, Set<string>>();
  for (const m of input.groupMemberships) {
    if (!m.providerId || !m.groupId || !isCurrentMembership(m, today, rules)) continue;
    groupsBy.set(m.providerId, (groupsBy.get(m.providerId) ?? new Set<string>()).add(m.groupId));
  }
  // Intake is a fact or nothing: unread tables give null, never a guess.
  const intakeBy = input.intakeReadable ? groupByProvider(input.intake ?? []) : null;
  // A stateless location gets no all-licenses fallback only while its hold
  // keeps the provider from Ready.
  const statelessHoldInForce = rules.statelessLocationHolds && rules.assignmentRequiredForReady;

  return input.providers
    .map((p): OnboardingFunnelRow => {
      const licenses = licensesBy.get(p.providerId) ?? [];
      const locations = locationsBy.get(p.providerId) ?? [];
      const allCases = casesBy.get(p.providerId) ?? [];
      // A case in a status that does not count is ignored entirely.
      const cases = allCases.filter((c) => c.status === null || !notCounted.has(c.status));
      const workStates = [...new Set(locations.map((row) => code(row.state)))].filter(
        (s): s is string => s !== null,
      );
      const states = [
        ...new Set(
          [
            ...workStates,
            ...licenses.map((l) => code(l.state)),
            ...cases.map((c) => code(c.state)),
          ].filter((s): s is string => s !== null),
        ),
      ].sort();

      // complete. A license only counts once its state code is valid: one
      // with a blank or unknown state can never be checked against a
      // working state.
      const stateLicenses = licenses.filter((l) => code(l.state) !== null);
      const licenseStates = new Set(stateLicenses.map((l) => code(l.state) as string));
      const completenessGaps = [
        ...(p.npi?.trim() ? [] : ["No NPI"]),
        ...(p.caqhIdPresent ? [] : ["No CAQH ID"]),
        ...(p.dobPresent ? [] : ["No date of birth"]),
        ...(p.ssnLast4Present ? [] : ["No SSN last 4"]),
        ...(stateLicenses.length === 0
          ? [licenses.length === 0 ? "No state license" : "License state is missing or invalid"]
          : []),
        ...(stateLicenses.length === 0
          ? []
          : workStates.filter((s) => !licenseStates.has(s)).map((s) => `No ${s} license`)),
      ];

      // verified. Judge the licenses for the states they work in; with no
      // location, every license on file.
      const judged =
        workStates.length > 0
          ? workStates
          : locations.length > 0 && statelessHoldInForce
            ? []
            : [...licenseStates];
      const verificationGaps: string[] = [];
      for (const state of judged) {
        const best = stateLicenses
          .filter((l) => code(l.state) === state)
          .sort(
            (a, b) =>
              Number(b.verifiedStatus === "verified") - Number(a.verifiedStatus === "verified") ||
              (b.expirationDate ?? "").localeCompare(a.expirationDate ?? ""),
          )[0];
        if (!best) continue;
        if (best.verifiedStatus !== "verified")
          verificationGaps.push(`${state} license not board-verified`);
        // As in the enrollment readiness matrix, a license with no expiration
        // date is not unexpired.
        if (!best.expirationDate) verificationGaps.push(`${state} license has no expiration date`);
        else if (best.expirationDate.slice(0, 10) < today)
          verificationGaps.push(`${state} license expired`);
      }
      const attested = day(p.caqhLastAttestedDate);
      if (!isCaqhCurrent(attested, today)) {
        verificationGaps.push(
          !attested
            ? "CAQH never attested"
            : attested > today
              ? "CAQH attestation date is in the future"
              : `CAQH attestation older than ${CAQH_CURRENT_DAYS} days`,
        );
      }
      if (p.pendingVerification) verificationGaps.push("Record pending verification");

      // assigned.
      const holds = assignmentGaps(groupsBy.get(p.providerId) ?? new Set(), locations, rules);

      // intake.
      const invites = intakeBy?.get(p.providerId) ?? [];

      const dimensions: OnboardingFunnelDimensions = {
        complete: completenessGaps.length === 0,
        completenessGaps,
        verified: verificationGaps.length === 0,
        verificationGaps,
        assigned: holds.length === 0,
        assignmentGaps: holds,
        hasCase: cases.length > 0,
        caseStatuses: allCases.map((c) => c.status),
        intake:
          intakeBy === null
            ? null
            : {
                invited: invites.length > 0,
                intakeSubmitted: invites.some((row) => row.intakeSubmitted),
              },
      };

      // First matching stage wins. A valid configuration ends in a
      // catch-all; should one ever not, the last stage still takes the
      // provider, so nobody is dropped.
      const stage =
        stages.find((s) => GATES.get(s.gate)?.matches(dimensions, rules)) ??
        stages[stages.length - 1];
      const gate = stage ? GATES.get(stage.gate) : undefined;
      return {
        providerId: p.providerId,
        name: p.name,
        npi: p.npi,
        stage: stage?.key ?? "",
        gaps: gate?.matches(dimensions, rules) ? gate.gaps(dimensions, rules) : [],
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
  for (const row of rows) counts[row.stage] = (counts[row.stage] ?? 0) + 1;
  return counts;
}

/** Every state any provider touches (work, license, or counted case), A→Z. */
export function onboardingFunnelStates(rows: readonly OnboardingFunnelRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.states))].sort();
}
