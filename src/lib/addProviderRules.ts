// The staff Add Provider wizard's (/providers/new) start-date rules: what a
// blank Start date saves.
//
// Two dates come out of one field.
//
// - The provider's own `start_date` fills the `provider.startDate` payer-form
//   token, so a blank one stays null and is never guessed. That is factual
//   accuracy, not policy, so it is fixed: no setting can default it
//   (Sowmya, Oct 30, D31).
// - Each facility assignment starts on the provider's start date. A blank one
//   needs a value, because `provider_facility_assignments.start_date` cannot
//   be null on a new row (the E1.4 CHECK). What fills it is business policy,
//   so it is configuration (AddProviderRules): by default the coordinator's
//   local today, or nothing, in which case Start date is required while a
//   facility is selected.
//
// The rule resolves from the decided default, then a platform override, then
// an organization override (resolveAddProviderRules), and
// validateAddProviderRules is the check an override must pass before it goes
// live. Nothing stores an override yet; the Mission Control setting is
// MINT-116. The hint, the Review rows and the save all take their dates from
// addProviderStartDates, so what the wizard says is what it saves. Pure;
// "today" is passed in.
import { fmtDate } from "@/lib/format";

// ---------------------------------------------------------------------------
// Rules

export type AssignmentStartDateDefault = "today" | "none";

/** Each field names its default. */
export interface AddProviderRules {
  /** A facility assignment when the provider has no start date. "today"
   * (default): it starts on the coordinator's local today. "none": nothing
   * is filled in, so Start date is required while a facility is selected. */
  assignmentStartDateDefault: AssignmentStartDateDefault;
}

/** The platform default: the decided rule. */
export const DEFAULT_ADD_PROVIDER_RULES: Readonly<AddProviderRules> = Object.freeze({
  assignmentStartDateDefault: "today",
});

/** A platform or organization override. A null or missing field inherits. */
export type AddProviderRulesOverride = {
  readonly [K in keyof AddProviderRules]?: AddProviderRules[K] | null;
};

const ASSIGNMENT_START_DATE_DEFAULTS: readonly AssignmentStartDateDefault[] = ["today", "none"];

const isAssignmentStartDateDefault = (value: unknown): value is AssignmentStartDateDefault =>
  ASSIGNMENT_START_DATE_DEFAULTS.includes(value as AssignmentStartDateDefault);

/** Field by field: the organization's value, else the platform's, else the
 * default. A stored value of the wrong shape is skipped like a missing one. */
export function resolveAddProviderRules(
  platform?: AddProviderRulesOverride | null,
  organization?: AddProviderRulesOverride | null,
): AddProviderRules {
  for (const override of [organization, platform]) {
    const value: unknown = override?.assignmentStartDateDefault;
    if (value != null && isAssignmentStartDateDefault(value))
      return { assignmentStartDateDefault: value };
  }
  return { assignmentStartDateDefault: DEFAULT_ADD_PROVIDER_RULES.assignmentStartDateDefault };
}

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
        "A blank provider start date can't be given a default: it fills payer forms, so it is never guessed.",
      );
    else if (key !== "assignmentStartDateDefault")
      errors.push(`"${key}" is not an Add Provider rule.`);
  }
  const value = given.assignmentStartDateDefault;
  if (value != null && !isAssignmentStartDateDefault(value))
    errors.push(
      'A blank facility assignment start date must be today ("today") or be left for the coordinator to enter ("none").',
    );
  return errors;
}

// ---------------------------------------------------------------------------
// What a save writes

export interface AddProviderStartDates {
  /** The provider's `start_date`: the date entered, else null. Never guessed. */
  providerStartDate: string | null;
  /** What every facility assignment starts on: the date entered, else the
   * rule's fill; null only under "none" with nothing entered. */
  assignmentStartDate: string | null;
}

/** The two dates a save writes, from the Start date field as entered. */
export function addProviderStartDates(
  rules: AddProviderRules,
  enteredStartDate: string,
  today: string,
): AddProviderStartDates {
  const providerStartDate = enteredStartDate.trim() || null;
  const assignmentStartDate =
    providerStartDate ?? (rules.assignmentStartDateDefault === "today" ? today : null);
  return { providerStartDate, assignmentStartDate };
}

export interface AddProviderStartDateField {
  startDate: string;
  facilityCount: number;
}

/** The Start date field's error: only under "none", when a facility is
 * selected and nothing is entered. */
export function addProviderStartDateError(
  rules: AddProviderRules,
  field: AddProviderStartDateField,
): string | undefined {
  return field.facilityCount > 0 &&
    !field.startDate.trim() &&
    rules.assignmentStartDateDefault === "none"
    ? "Required while a facility is selected: facility assignments need a start date."
    : undefined;
}

/** The hint under a blank Start date: what a blank saves, before the
 * coordinator saves it. None once a date is entered, with no facility
 * selected, or while an error is shown in its place. */
export function addProviderStartDateHint(
  rules: AddProviderRules,
  field: AddProviderStartDateField & { today: string; error?: string },
): string | undefined {
  if (field.error || field.startDate.trim() || field.facilityCount === 0) return undefined;
  return rules.assignmentStartDateDefault === "today"
    ? `If left blank, facility assignments start today (${fmtDate(field.today)}).`
    : "Facility assignments need a start date.";
}
