// The start-date rules for adding a provider: the staff Add Provider wizard
// (/providers/new) and the roster form's create mode.
//
// Two dates come out of one field.
//
// - The provider's own `start_date` fills the `provider.startDate` payer-form
//   token. Whether the field OPENS filled with today is configuration
//   (providerStartDatePrefill): a prefilled date is shown, and staff can
//   change or clear it. Saving writes exactly what the field shows. A blank
//   field is never filled in at save: a silently guessed date would be a
//   false fact on payer forms, so that is fixed, not a setting (Sowmya, D31,
//   and her S2 answer of Oct 31: Platform Settings row 11).
// - Each facility assignment starts on the provider's start date. What a
//   blank one gets is configuration (assignmentStartDateDefault): by default
//   the coordinator's local today, or nothing, and the assignments are then
//   saved without a start date ("Start date needed"). The CSV import follows
//   the same rule (blankAssignmentStartDate).
//
// The rules resolve from the decided default, then a platform override, then
// an organization override, field by field (resolveAddProviderRules), and
// validateAddProviderRules is the check an override must pass before it goes
// live. Nothing stores an override yet; the Mission Control setting is
// MINT-116. The hint, the Review rows and the save all take their dates from
// addProviderStartDates, so what the wizard says is what it saves. Pure;
// "today" is passed in.
import { fmtDate } from "@/lib/format";

// ---------------------------------------------------------------------------
// Rules

export type ProviderStartDatePrefill = "none" | "today";
export type AssignmentStartDateDefault = "today" | "none";

/** Each field names its default. */
export interface AddProviderRules {
  /** What the Start date field opens with when adding a provider. "none"
   * (default): blank. "today": the coordinator's local today, shown and
   * editable; it is saved only if it is still in the field. */
  providerStartDatePrefill: ProviderStartDatePrefill;
  /** A facility assignment when no start date is given. "today" (default):
   * it starts on the coordinator's local today. "none": it is saved without
   * a start date. */
  assignmentStartDateDefault: AssignmentStartDateDefault;
}

/** The platform default: the decided rules. */
export const DEFAULT_ADD_PROVIDER_RULES: Readonly<AddProviderRules> = Object.freeze({
  providerStartDatePrefill: "none",
  assignmentStartDateDefault: "today",
});

/** A platform or organization override. A null or missing field inherits. */
export type AddProviderRulesOverride = {
  readonly [K in keyof AddProviderRules]?: AddProviderRules[K] | null;
};

const RULE_VALUES: { [K in keyof AddProviderRules]: readonly AddProviderRules[K][] } = {
  providerStartDatePrefill: ["none", "today"],
  assignmentStartDateDefault: ["today", "none"],
};

const RULE_KEYS = Object.keys(RULE_VALUES) as Array<keyof AddProviderRules>;

const isRuleValue = (key: keyof AddProviderRules, value: unknown): boolean =>
  (RULE_VALUES[key] as readonly unknown[]).includes(value);

/** Field by field: the organization's value, else the platform's, else the
 * default. A stored value of the wrong shape is skipped like a missing one. */
export function resolveAddProviderRules(
  platform?: AddProviderRulesOverride | null,
  organization?: AddProviderRulesOverride | null,
): AddProviderRules {
  const pick = <K extends keyof AddProviderRules>(key: K): AddProviderRules[K] => {
    for (const override of [organization, platform]) {
      const value: unknown = override?.[key];
      if (value != null && isRuleValue(key, value)) return value as AddProviderRules[K];
    }
    return DEFAULT_ADD_PROVIDER_RULES[key];
  };
  return {
    providerStartDatePrefill: pick("providerStartDatePrefill"),
    assignmentStartDateDefault: pick("assignmentStartDateDefault"),
  };
}

const RULE_ERRORS: { [K in keyof AddProviderRules]: string } = {
  providerStartDatePrefill:
    'The Start date field must open blank ("none") or filled with today ("today").',
  assignmentStartDateDefault:
    'A blank facility assignment start date must be today ("today") or stay blank ("none").',
};

/** Plain-language problems with an override; empty when it can go live. */
export function validateAddProviderRules(override: unknown): string[] {
  if (override == null) return [];
  if (typeof override !== "object" || Array.isArray(override))
    return ["The Add Provider rules must be a set of named rules."];
  const errors: string[] = [];
  const given = override as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (key === "providerStartDateDefault")
      errors.push(
        "A blank provider start date is never filled in at save: it fills payer forms. To open the field with today's date, set the Start date prefill instead.",
      );
    else if (!(RULE_KEYS as string[]).includes(key))
      errors.push(`"${key}" is not an Add Provider rule.`);
  }
  for (const key of RULE_KEYS) {
    const value = given[key];
    if (value != null && !isRuleValue(key, value)) errors.push(RULE_ERRORS[key]);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The field and what a save writes

/** What the Start date field opens with when adding a provider. */
export function addProviderStartDatePrefill(rules: AddProviderRules, today: string): string {
  return rules.providerStartDatePrefill === "today" ? today : "";
}

export interface AddProviderStartDates {
  /** The provider's `start_date`: what the field shows, else null. A blank
   * is never filled in. */
  providerStartDate: string | null;
  /** What every facility assignment starts on: the field's date, else the
   * rule's (blankAssignmentStartDate), which is null under "none". */
  assignmentStartDate: string | null;
}

/** A facility assignment's start date when none is given: `today` by
 * default, null under "none". Add Provider and the CSV import share it. */
export function blankAssignmentStartDate(rules: AddProviderRules, today: string): string | null {
  return rules.assignmentStartDateDefault === "today" ? today : null;
}

/** The two dates a save writes, from the Start date field as it stands. */
export function addProviderStartDates(
  rules: AddProviderRules,
  fieldStartDate: string,
  today: string,
): AddProviderStartDates {
  const providerStartDate = fieldStartDate.trim() || null;
  return {
    providerStartDate,
    assignmentStartDate: providerStartDate ?? blankAssignmentStartDate(rules, today),
  };
}

export interface AddProviderStartDateField {
  startDate: string;
  facilityCount: number;
  today: string;
}

/** The hint under Start date. A prefilled today says so while it is still in
 * the field; a blank field says what the assignments get. None otherwise. */
export function addProviderStartDateHint(
  rules: AddProviderRules,
  field: AddProviderStartDateField,
): string | undefined {
  const value = field.startDate.trim();
  if (value)
    return rules.providerStartDatePrefill === "today" && value === field.today
      ? "Prefilled with today; change or clear it."
      : undefined;
  if (field.facilityCount === 0) return undefined;
  const start = blankAssignmentStartDate(rules, field.today);
  return start
    ? `If left blank, facility assignments start today (${fmtDate(start)}).`
    : "If left blank, facility assignments are saved without a start date.";
}
