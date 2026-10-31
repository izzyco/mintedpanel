// Provider Onboarding funnel (Oct 20 review, RC-06; stage names from the PM,
// Oct 30, and her answers of Oct 31). The funnel is the provider's state, not
// case status. Pure; "today" and the configuration are passed in.
//
// Two layers, kept apart:
//
// 1. Dimensions: each computed on its own for every provider.
//    complete        every required field is present: NPI, CAQH ID, date of
//                    birth, SSN last 4, and a license (any license with a
//                    valid state code, and one for each state they are
//                    assigned to work in).
//    verified        the record is not pending verification, CAQH is attested
//                    within the last 120 days (a future date never counts),
//                    and every license judged is board-verified with an
//                    expiration date not yet passed. Licenses are judged for
//                    the valid states of the provider's active locations;
//                    with none, every license on file is.
//    assigned        a current group membership, an active non-reference
//                    location, by default a location under one of their
//                    current groups (facilities.group_id), and by default a
//                    valid state on every active location. A location under
//                    another group is still a place they are assigned to
//                    work, so its state still counts for the license checks.
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
//    in a stage under the rules in force (validateOnboardingFunnelConfig),
//    so every counted provider sits in exactly one. A stage whose gate
//    cannot match under the rules in force is hidden, like Invited while
//    intake data cannot be read. The default list is the PM's: Invited,
//    Profile incomplete, Submitted (the information is complete and not yet
//    verified; it says nothing about anything being sent anywhere),
//    Verified awaiting assignment, Ready for credentialing, Credentialing
//    (never split by status, which belongs on the case board).
//
// Business policy is configuration, never a constant
// (resolveOnboardingFunnelConfig). Minted's platform layer sets the stage
// list: its count, order, gates and copy. An organization's layer may give
// those stages its own labels and descriptions, keyed by stage key, and
// nothing else about them (Platform Settings row 26). The rules
// (OnboardingFunnelRules) resolve field by field, organization over platform
// over default; Minted sets an organization's rules at onboarding and org
// admins only read them (PM, S10). Nothing stores either layer yet; the
// Mission Control setting is MINT-125. A list or an organization's copy that
// fails validation never goes live: the default list, or Minted's copy, is
// used instead, and the default list is valid under every rule.
//
// A group membership counts while its group is active and until its end
// date passes; by default its start date is ignored, because credentialing
// happens before a provider starts. Billing Readiness
// (src/lib/billingReadiness.ts) and the contract SOP assignments
// (src/services/contractSopAssignments.ts) do require a start date on or
// before today, because they ask who is working now.
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
  /** Case statuses that do NOT count as Credentialing. Default empty: every
   * case counts, whatever its status. The cases stay on record as facts. */
  caseStatusesNotCountedAsCredentialing: readonly CaseStatus[];
  /** True (default): an active location with no valid state keeps the
   * provider from being assigned. False: it counts like any other location. */
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Field by field: the organization's value, else the platform's, else the
 * default. A stored value of the wrong shape is skipped like a missing one. */
export function resolveOnboardingFunnelRules(
  platform?: OnboardingFunnelRulesOverride | null,
  organization?: OnboardingFunnelRulesOverride | null,
): OnboardingFunnelRules {
  const pick = <K extends keyof OnboardingFunnelRules>(key: K): OnboardingFunnelRules[K] => {
    for (const override of [organization, platform]) {
      const value: unknown = isRecord(override) ? override[key] : undefined;
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
    description: "Invited to the intake form, has not sent it back, and has no counted case.",
    needsIntakeData: true,
    listsGaps: false,
    matches: (d) =>
      !d.hasCountedCase && d.intake !== null && d.intake.invited && !d.intake.intakeSubmitted,
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
    description: "Complete but not verified, and no counted case. Lists assignment gaps too.",
    needsIntakeData: false,
    listsGaps: true,
    matches: (d) => !d.hasCountedCase && d.complete && !d.verified,
    gaps: (d, rules) => [...d.verificationGaps, ...assignmentHolds(d, rules)],
  },
  {
    key: "verified_unassigned",
    description:
      "Complete and verified, but not assigned while Ready requires it, and no counted case.",
    needsIntakeData: false,
    listsGaps: true,
    matches: (d, rules) => !d.hasCountedCase && d.complete && d.verified && !assignmentOk(d, rules),
    gaps: (d) => d.assignmentGaps,
  },
  {
    key: "not_ready",
    description: "Anything short of Ready, and no counted case. Lists every gap.",
    needsIntakeData: false,
    listsGaps: true,
    matches: (d, rules) => !d.hasCountedCase && !readyNow(d, rules),
    gaps: (d, rules) => [
      ...d.completenessGaps,
      ...d.verificationGaps,
      ...assignmentHolds(d, rules),
    ],
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
          for (const intake of intakes)
            samples.push({
              complete,
              completenessGaps: [],
              verified,
              verificationGaps: [],
              assigned,
              assignmentGaps: [],
              hasCase: hasCountedCase,
              caseCount: hasCountedCase ? 1 : 0,
              caseStatuses: [],
              hasCountedCase,
              intake,
            });
  return samples;
}

const SAMPLES = sampleDimensions();

function gateCanMatch(gate: OnboardingFunnelGate, rules: OnboardingFunnelRules): boolean {
  const definition = GATES.get(gate);
  return definition !== undefined && SAMPLES.some((d) => definition.matches(d, rules));
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
}

export const DEFAULT_ONBOARDING_FUNNEL_CONFIG: Readonly<OnboardingFunnelConfig> = Object.freeze({
  stages: DEFAULT_ONBOARDING_FUNNEL_STAGES,
  rules: DEFAULT_ONBOARDING_FUNNEL_RULES,
});

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
// Validation: what a configuration must pass before it goes live (MINT-125)

export const MAX_ONBOARDING_FUNNEL_STAGES = 6;
const STAGE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LABEL = 60;
const MAX_DESCRIPTION = 200;

function describeSample(d: OnboardingFunnelDimensions): string {
  const state = [
    d.complete ? "complete" : "incomplete",
    d.verified ? "verified" : "not verified",
    d.assigned ? "assigned" : "not assigned",
  ].join(", ");
  return `A provider who is ${state}, ${d.hasCountedCase ? "with a case" : "with no case"},`;
}

/** Plain-language problems with a configuration; empty when it can go live.
 * Coverage is checked under the configuration's own rules. */
export function validateOnboardingFunnelConfig(config: OnboardingFunnelConfig): string[] {
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
    if (!RULE_CHECKS[key](rules[key]))
      errors.push(
        key === "caseStatusesNotCountedAsCredentialing"
          ? "Case statuses that do not count must be known case statuses."
          : `The rule "${key}" must be on or off.`,
      );
  }
  if (errors.length > 0) return errors;

  // Coverage under the rules in force: every combination of dimensions must
  // land in a stage, and a stage whose gate can match must be the first
  // match for someone. A stage whose gate cannot match under these rules is
  // hidden, not an error.
  const stages = list as OnboardingFunnelStageConfig[];
  const effective = rules as unknown as OnboardingFunnelRules;
  const first = new Set<number>();
  let uncovered: OnboardingFunnelDimensions | null = null;
  for (const d of SAMPLES) {
    const index = stages.findIndex((stage) => GATES.get(stage.gate)?.matches(d, effective));
    if (index < 0) uncovered ??= d;
    else first.add(index);
  }
  if (uncovered)
    errors.push(
      `${describeSample(uncovered)} would fit no stage. Add a stage for them, or end with an "everyone else" stage ("any").`,
    );
  stages.forEach((stage, i) => {
    if (!first.has(i) && gateCanMatch(stage.gate, effective))
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

/** The configuration the funnel actually runs, from a resolved one (Minted's
 * list with the organization's copy already applied): rules field by field
 * (a bad value falls back to the default), and the stage list only if it
 * validates under those rules, else the default list, which is valid under
 * every rule. A broken configuration therefore never drops a provider. The
 * resolver never lets an organization's copy break a valid list, so this
 * fallback never discards Minted's list because of an organization. */
export function effectiveOnboardingFunnelConfig(
  config: OnboardingFunnelConfig | null | undefined,
): OnboardingFunnelConfig {
  const rules = resolveOnboardingFunnelRules(null, isRecord(config) ? config.rules : null);
  const stages =
    isRecord(config) &&
    validateOnboardingFunnelConfig({ stages: config.stages, rules }).length === 0
      ? config.stages
      : DEFAULT_ONBOARDING_FUNNEL_STAGES;
  return { stages: stages.map(copyStage), rules };
}

const STAGE_TEXT_FIELDS = new Set(["label", "description"]);

/** Plain-language problems with an organization's layer, checked against
 * the stage list it relabels; empty when it can go live. */
export function validateOnboardingFunnelOrganizationOverride(
  organization: OnboardingFunnelOrganizationOverride | null | undefined,
  stages: ReadonlyArray<OnboardingFunnelStageConfig> = DEFAULT_ONBOARDING_FUNNEL_STAGES,
): string[] {
  if (organization == null) return [];
  if (!isRecord(organization)) return ["An organization's funnel settings must be an object."];
  const errors: string[] = [];
  if (organization.stages != null)
    errors.push(
      "An organization cannot change the stage list: Minted sets the stages, their order and their gates. Change labels and descriptions instead.",
    );

  const text: unknown = organization.stageText;
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
      if (entry.label != null) {
        const label = typeof entry.label === "string" ? entry.label.trim() : "";
        if (!label) errors.push(`"${key}": the label cannot be empty.`);
        else if (label.length > MAX_LABEL)
          errors.push(`"${key}": keep the label to ${MAX_LABEL} characters.`);
        else labels.set(key, label);
      }
      if (entry.description != null) {
        const description = typeof entry.description === "string" ? entry.description.trim() : "";
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

  const rules: unknown = organization.rules;
  if (rules != null && !isRecord(rules)) errors.push("The organization's rules must be an object.");
  else if (isRecord(rules)) {
    for (const [key, value] of Object.entries(rules)) {
      if (!(key in RULE_CHECKS)) errors.push(`"${key}" is not a funnel rule.`);
      else if (value != null && !RULE_CHECKS[key as keyof OnboardingFunnelRules](value))
        errors.push(
          key === "caseStatusesNotCountedAsCredentialing"
            ? "Case statuses that do not count must be known case statuses."
            : `The rule "${key}" must be on or off.`,
        );
    }
  }
  return errors;
}

/** Minted's stage list (the platform's, if it validates under the resolved
 * rules, else the default), with the organization's labels and descriptions
 * applied when its layer validates; rules field by field, organization over
 * platform over default. An organization never changes a stage's count,
 * order or gate. */
export function resolveOnboardingFunnelConfig(
  platform?: OnboardingFunnelPlatformOverride | null,
  organization?: OnboardingFunnelOrganizationOverride | null,
): OnboardingFunnelConfig {
  // Stored values may be any shape; the rules resolver and the validators
  // all check, so a bad one is skipped rather than run.
  const rules = resolveOnboardingFunnelRules(platform?.rules, organization?.rules);
  const list = platform?.stages;
  const stages = (
    list != null && validateOnboardingFunnelConfig({ stages: list, rules }).length === 0
      ? list
      : DEFAULT_ONBOARDING_FUNNEL_STAGES
  ).map(copyStage);
  // An organization's copy goes live whole or not at all.
  const text = organization?.stageText;
  if (text && validateOnboardingFunnelOrganizationOverride(organization, stages).length === 0) {
    for (const stage of stages) {
      const own = text[stage.key];
      if (own?.label != null) stage.label = own.label.trim();
      if (own?.description != null) stage.description = own.description.trim();
    }
  }
  return { stages, rules };
}

/** The stages the report shows, in order: intake-gated stages need the
 * intake tables, and a stage whose gate cannot match under the rules in
 * force is hidden. */
export function visibleOnboardingFunnelStages(
  config: OnboardingFunnelConfig,
  intakeReadable: boolean,
): OnboardingFunnelStageInfo[] {
  const { stages, rules } = effectiveOnboardingFunnelConfig(config);
  return stages
    .filter((stage) => gateCanMatch(stage.gate, rules))
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

function placeIn(
  d: OnboardingFunnelDimensions,
  stages: ReadonlyArray<OnboardingFunnelStageConfig>,
  rules: OnboardingFunnelRules,
): { stage: OnboardingFunnelStageKey; gaps: string[] } {
  for (const stage of stages) {
    const gate = GATES.get(stage.gate);
    if (gate?.matches(d, rules)) return { stage: stage.key, gaps: gate.gaps(d, rules) };
  }
  // Unreachable: the stages in use always passed validation, which proves
  // every combination lands somewhere.
  return { stage: stages[stages.length - 1].key, gaps: [] };
}

/** Where a provider with these dimensions sits under a configuration (the
 * configuration the funnel would actually run). */
export function placeOnboardingFunnelStage(
  d: OnboardingFunnelDimensions,
  config: OnboardingFunnelConfig,
): { stage: OnboardingFunnelStageKey; gaps: string[] } {
  const effective = effectiveOnboardingFunnelConfig(config);
  return placeIn(d, effective.stages, effective.rules);
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

export interface OnboardingFunnelRow {
  providerId: string;
  name: string;
  npi: string | null;
  stage: OnboardingFunnelStageKey;
  /** What keeps the provider in their stage, for stages whose gate lists gaps. */
  gaps: string[];
  /** Every state the provider touches: work, license, or any case on file. */
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

/** One reason per location, naming why it is not in a current group. */
function locationGroupGaps(
  locations: readonly OnboardingFunnelLocationInput[],
  lapsed: ReadonlyMap<string, string>,
): string[] {
  const sorted = [...locations].sort(
    (a, b) =>
      a.locationName.localeCompare(b.locationName) || a.locationId.localeCompare(b.locationId),
  );
  return [
    ...new Set(
      sorted.map((l) =>
        l.groupId === null
          ? `Location ${l.locationName} has no group`
          : (lapsed.get(l.groupId) ??
            `Location ${l.locationName} is under ${l.groupName ?? "another group"}, not the provider's group`),
      ),
    ),
  ];
}

function assignmentGaps(
  memberships: readonly OnboardingFunnelMembershipInput[],
  locations: readonly OnboardingFunnelLocationInput[],
  today: string,
  rules: OnboardingFunnelRules,
): string[] {
  const current = new Set<string>();
  const lapsed = new Map<string, string>();
  for (const m of memberships) {
    if (!m.groupId) continue;
    const reason = lapsedMembershipReason(m, today, rules);
    if (reason === null) current.add(m.groupId);
    else lapsed.set(m.groupId, reason);
  }
  const gaps: string[] = [];
  if (current.size === 0) {
    // Name the membership that does not count, when there is one.
    if (lapsed.size > 0) {
      gaps.push(...[...new Set(lapsed.values())].sort());
      if (locations.length === 0) gaps.push("Needs a location");
    } else gaps.push(locations.length === 0 ? "Needs a group and a location" : "Needs a group");
  } else if (locations.length === 0) gaps.push("Needs a location");
  else if (
    rules.locationMustBeInProviderGroup &&
    !locations.some((l) => l.groupId !== null && current.has(l.groupId))
  )
    gaps.push(...locationGroupGaps(locations, lapsed));
  if (rules.statelessLocationHolds && locations.some((l) => code(l.state) === null))
    gaps.push(STATELESS_LOCATION_GAP);
  return gaps;
}

export function buildOnboardingFunnelRows(
  input: OnboardingFunnelInput,
  today: string,
  config: OnboardingFunnelConfig,
): OnboardingFunnelRow[] {
  // A configuration that fails validation (an empty or malformed list, a
  // gap in coverage) is never run: the default list is.
  const { rules, stages } = effectiveOnboardingFunnelConfig(config);
  const notCounted = new Set<string>(rules.caseStatusesNotCountedAsCredentialing);
  const licensesBy = groupByProvider(input.licenses);
  const locationsBy = groupByProvider(input.locations);
  const casesBy = groupByProvider(input.cases);
  const membershipsBy = groupByProvider(input.groupMemberships);
  // Intake is a fact or nothing: unread tables give null, never a guess.
  const intakeBy = input.intakeReadable ? groupByProvider(input.intake ?? []) : null;

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

      // verified. Judge the licenses for the valid states they work in;
      // with no valid working state, every license on file. A stateless
      // location is an assignment gap of its own. While another location
      // has a valid state, no license is judged for the stateless one: the
      // state it will have is unknown (an open question for the PM).
      const judged = workStates.length > 0 ? workStates : [...licenseStates];
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
      const holds = assignmentGaps(membershipsBy.get(p.providerId) ?? [], locations, today, rules);

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
      return {
        providerId: p.providerId,
        name: p.name,
        npi: p.npi,
        ...placeIn(dimensions, stages, rules),
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

/** Every state any provider touches (work, license, or case), A→Z. */
export function onboardingFunnelStates(rows: readonly OnboardingFunnelRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.states))].sort();
}
