// The staff Add Provider wizard's (/providers/new) start-date rules: what a
// blank Start date saves. Not the provider self-serve intake
// (/intake/$token), which has rules of its own.
//
// Two dates come out of one field. The provider's own `start_date` fills the
// `provider.startDate` payer-form token, so by default a blank one stays null
// and is never guessed. Each facility assignment takes the provider's start
// date, and by default a blank one becomes the coordinator's local today,
// because `provider_facility_assignments.start_date` cannot be null on a new
// row (the E1.4 CHECK). Sowmya, Oct 30 (D31).
//
// Both are business policy, so they are configuration (ProviderIntakeRules),
// never constants: they resolve from the decided default, then a platform
// override, then an organization override, field by field
// (resolveProviderIntakeRules), and validateProviderIntakeRules is the check
// an override must pass before it goes live. Nothing stores an override yet;
// the Mission Control setting is MINT-116. The hint, the Review rows and the
// save all read the same resolved rules, so what the wizard says is what it
// saves. Pure; "today" is passed in.
import { fmtDate } from "@/lib/format";

// ---------------------------------------------------------------------------
// Rules

export type ProviderStartDateDefault = "none" | "today";
export type AssignmentStartDateDefault = "today" | "none";

/** Each field names its default. */
export interface ProviderIntakeRules {
  /** A blank Start date on the provider. "none" (default): it stays null.
   * "today": it is saved as the coordinator's local today. */
  providerStartDateDefault: ProviderStartDateDefault;
  /** A facility assignment when the provider has no start date. "today"
   * (default): it starts on the coordinator's local today. "none": nothing
   * is filled in, so Start date is required while a facility is selected. */
  assignmentStartDateDefault: AssignmentStartDateDefault;
}

/** The platform default: the decided rules. */
export const DEFAULT_PROVIDER_INTAKE_RULES: Readonly<ProviderIntakeRules> = Object.freeze({
  providerStartDateDefault: "none",
  assignmentStartDateDefault: "today",
});

/** A platform or organization override. A null or missing field inherits. */
export type ProviderIntakeRulesOverride = {
  readonly [K in keyof ProviderIntakeRules]?: ProviderIntakeRules[K] | null;
};

const RULE_VALUES: { [K in keyof ProviderIntakeRules]: readonly ProviderIntakeRules[K][] } = {
  providerStartDateDefault: ["none", "today"],
  assignmentStartDateDefault: ["today", "none"],
};

const RULE_KEYS = Object.keys(RULE_VALUES) as Array<keyof ProviderIntakeRules>;

const isRuleValue = (key: keyof ProviderIntakeRules, value: unknown): boolean =>
  (RULE_VALUES[key] as readonly unknown[]).includes(value);

/** Field by field: the organization's value, else the platform's, else the
 * default. A stored value of the wrong shape is skipped like a missing one. */
export function resolveProviderIntakeRules(
  platform?: ProviderIntakeRulesOverride | null,
  organization?: ProviderIntakeRulesOverride | null,
): ProviderIntakeRules {
  const pick = <K extends keyof ProviderIntakeRules>(key: K): ProviderIntakeRules[K] => {
    for (const override of [organization, platform]) {
      const value: unknown = override?.[key];
      if (value != null && isRuleValue(key, value)) return value as ProviderIntakeRules[K];
    }
    return DEFAULT_PROVIDER_INTAKE_RULES[key];
  };
  return {
    providerStartDateDefault: pick("providerStartDateDefault"),
    assignmentStartDateDefault: pick("assignmentStartDateDefault"),
  };
}

const RULE_ERRORS: { [K in keyof ProviderIntakeRules]: string } = {
  providerStartDateDefault:
    'A blank provider start date must stay blank ("none") or be today ("today").',
  assignmentStartDateDefault:
    'A blank facility assignment start date must be today ("today") or be left for the coordinator to enter ("none").',
};

/** Plain-language problems with an override; empty when it can go live. */
export function validateProviderIntakeRules(override: unknown): string[] {
  if (override == null) return [];
  if (typeof override !== "object" || Array.isArray(override))
    return ["The Add Provider rules must be a set of named rules."];
  const errors: string[] = [];
  const given = override as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!(RULE_KEYS as string[]).includes(key))
      errors.push(`"${key}" is not an Add Provider rule.`);
  }
  for (const key of RULE_KEYS) {
    const value = given[key];
    if (value != null && !isRuleValue(key, value)) errors.push(RULE_ERRORS[key]);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// What a save writes

export interface IntakeStartDates {
  /** The provider's `start_date`; null when left blank under "none". */
  providerStartDate: string | null;
  /** What each facility assignment starts on: the provider's start date when
   * there is one; null only under "none" with nothing entered. */
  assignmentStartDate: string | null;
}

/** The two dates a save writes, from the Start date field as entered. */
export function intakeStartDates(
  rules: ProviderIntakeRules,
  enteredStartDate: string,
  today: string,
): IntakeStartDates {
  const entered = enteredStartDate.trim() || null;
  const providerStartDate = entered ?? (rules.providerStartDateDefault === "today" ? today : null);
  const assignmentStartDate =
    providerStartDate ?? (rules.assignmentStartDateDefault === "today" ? today : null);
  return { providerStartDate, assignmentStartDate };
}

export interface IntakeStartDateField {
  startDate: string;
  facilityCount: number;
  today: string;
}

/** The hint under a blank Start date: which date a blank saves, before the
 * coordinator saves it. None once a date is entered. */
export function intakeStartDateHint(
  rules: ProviderIntakeRules,
  field: IntakeStartDateField,
): string | undefined {
  if (field.startDate.trim()) return undefined;
  const day = fmtDate(field.today);
  if (rules.providerStartDateDefault === "today")
    return field.facilityCount > 0
      ? `If left blank, the start date and facility assignments are today (${day}).`
      : `If left blank, the start date is today (${day}).`;
  if (field.facilityCount === 0) return undefined;
  return rules.assignmentStartDateDefault === "today"
    ? `If left blank, facility assignments start today (${day}).`
    : "Facility assignments need a start date.";
}

/** The Start date field's error: only under "none" for both, when a
 * facility is selected and nothing is entered. */
export function intakeStartDateError(
  rules: ProviderIntakeRules,
  field: Omit<IntakeStartDateField, "today">,
): string | undefined {
  const nothingFillsIt =
    !field.startDate.trim() &&
    rules.providerStartDateDefault === "none" &&
    rules.assignmentStartDateDefault === "none";
  return field.facilityCount > 0 && nothingFillsIt
    ? "Required while a facility is selected: facility assignments need a start date."
    : undefined;
}
