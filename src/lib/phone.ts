// US phone rule (MINT-91): the ONE entry-time check behind every phone input
// and the import create paths. Pure and I/O-free. Blank-value policy stays with
// each caller — most phone fields are optional; the contact forms require one.
// Roster export keeps its own digit-count check: it runs over stored rows,
// which this rule never re-validates.
//
// The format is fixed, not a setting: US numbers only, with no organization
// override (Sowmya, Oct 31, 2026, MINT-91 Addendum 8 A3). What a platform or
// organization may configure is PhoneValidationRules at the bottom of this
// file (Mission Control MINT-129).

// An optional trailing extension: x123, ext 123, ext. 123, #123. No leading
// \s*: the space before it is a separator, and a leading \s* goes quadratic
// on a long run of spaces.
const EXTENSION_RE = /(?:x|ext\.?|#)\s*\d+$/i;
// The separators a typed number may carry; anything else left over fails.
const SEPARATORS_RE = /[\s().-]/g;

export const US_PHONE_MESSAGE = "Enter a 10-digit US phone number";

/** 10 digits, or 11 starting with 1, once spaces and `( ) - .` are removed,
 * with an optional trailing extension. A leading `+` is a country code, so it
 * must be +1 then 10 digits. Any other letter fails. */
export function isValidUsPhone(value: string): boolean {
  const number = value.trim().replace(EXTENSION_RE, "");
  const digits = number.replace(/^\+/, "").replace(SEPARATORS_RE, "");
  return (number.startsWith("+") ? /^1\d{10}$/ : /^1?\d{10}$/).test(digits);
}

// ---------------------------------------------------------------------------
// Phone validation rules (Mission Control MINT-129)
//
// Business policy is configuration: each field below holds Sowmya's decision
// of Oct 31, 2026 (MINT-91 Addendum 8) as its default. A stored phone the user
// didn't touch is never re-checked (A4); a NEW import row with an invalid phone
// takes a valid phone from the same record's other rows in the file, else is
// created without the phone, and is warned about, not blocked (A5). A platform
// override, then an organization override, may change a field
// (resolvePhoneValidationRules). Nothing stores an override yet, so every
// caller resolves to the defaults (usePhoneValidationRules); the setting
// itself is MINT-129.
//
// Every alternative is STRICTER than its default. The US-only format is not a
// setting (A3): the resolver reads only the fields below, and
// validatePhoneValidationRules rejects anything that names the format.

/** What an import does with a NEW provider, group or facility whose phone
 * fails isValidUsPhone and no row of the same record in the file has a valid
 * one (a valid one is always used first). A row that matches an existing
 * record never writes its phone, so it is never affected. */
export const IMPORT_INVALID_PHONE_RULES = ["create_without_phone", "block_row"] as const;
export type ImportInvalidPhoneRule = (typeof IMPORT_INVALID_PHONE_RULES)[number];

export interface PhoneValidationRules {
  /** False (default): an edit checks a phone only when it is entered or
   * changed, so a stored phone that predates the check never blocks an
   * unrelated save. True: every edit save checks the stored phone too. Create
   * flows check every entered phone either way, and the onboarding progress
   * check never re-checks one. */
  recheckStoredOnEdit: boolean;
  /** Applies only when the record's phone isn't a US number and no row of the
   * same record in the file has a valid one; a valid one is used first under
   * either value. "create_without_phone" (default): the record is created with
   * that phone left blank, and a warning naming the column shows on the row in
   * the import review and in the run's report. "block_row": none of the
   * record's rows is committed. */
  importInvalidPhone: ImportInvalidPhoneRule;
}

/** The platform default: the PM's decisions of Oct 31, 2026. */
export const DEFAULT_PHONE_VALIDATION_RULES: Readonly<PhoneValidationRules> = Object.freeze({
  recheckStoredOnEdit: false,
  importInvalidPhone: "create_without_phone",
});

/** A platform or organization override. A null or missing field inherits. */
export type PhoneValidationRulesOverride = {
  readonly [K in keyof PhoneValidationRules]?: PhoneValidationRules[K] | null;
};

const PHONE_RULE_CHECKS: {
  [K in keyof PhoneValidationRules]: (value: unknown) => boolean;
} = {
  recheckStoredOnEdit: (value) => typeof value === "boolean",
  importInvalidPhone: (value) => (IMPORT_INVALID_PHONE_RULES as readonly unknown[]).includes(value),
};

/** Field by field: the organization's value, else the platform's, else the
 * default. A value of the wrong shape is skipped like a missing one, and a
 * field this object does not define is never read. */
export function resolvePhoneValidationRules(
  platform?: PhoneValidationRulesOverride | null,
  organization?: PhoneValidationRulesOverride | null,
): PhoneValidationRules {
  const pick = <K extends keyof PhoneValidationRules>(key: K): PhoneValidationRules[K] => {
    for (const override of [organization, platform]) {
      const value: unknown = override?.[key];
      if (value != null && PHONE_RULE_CHECKS[key](value)) return value as PhoneValidationRules[K];
    }
    return DEFAULT_PHONE_VALIDATION_RULES[key];
  };
  return {
    recheckStoredOnEdit: pick("recheckStoredOnEdit"),
    importInvalidPhone: pick("importInvalidPhone"),
  };
}

// A setting whose name points at the fixed format gets the reason it can't
// exist, not just "unknown". Matched on whole words of the key ("phoneFormat",
// "allow_international", "allowE164"), so "reformatted" is not "format".
const FIXED_FORMAT_WORDS_RE =
  /(?:^| )(?:formats?|international|e164|country|countries|country ?codes?|regions?|locales?)(?= |$)/;

function namesFixedFormat(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(" ");
  return FIXED_FORMAT_WORDS_RE.test(words);
}

/** Plain-language problems with an override; empty when it can go live. A
 * null or missing field inherits and is fine. */
export function validatePhoneValidationRules(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  if (typeof input !== "object" || Array.isArray(input)) {
    return ["Phone validation rules must be a set of named settings."];
  }
  const errors: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === "recheckStoredOnEdit") {
      if (value != null && !PHONE_RULE_CHECKS.recheckStoredOnEdit(value)) {
        errors.push('"Re-check stored phones on edit" must be on or off.');
      }
    } else if (key === "importInvalidPhone") {
      if (value != null && !PHONE_RULE_CHECKS.importInvalidPhone(value)) {
        errors.push(
          '"Import row with an invalid phone" must be "create_without_phone" (create the record without the phone and warn) or "block_row".',
        );
      }
    } else if (namesFixedFormat(key)) {
      errors.push(
        `"${key}" can't be configured: phone numbers are US only (10 digits, or 1 then 10, with an optional extension), decided Oct 31, 2026.`,
      );
    } else {
      errors.push(`"${key}" is not a phone validation setting.`);
    }
  }
  return errors;
}

/** A form's phone check: blank passes (each form keeps its own required rule)
 * and a create checks every entered phone. On an edit, a value equal to the
 * stored one is checked only under recheckStoredOnEdit, so by default a legacy
 * phone never blocks an unrelated save. Create flows omit `stored`. Returns
 * the error copy or null. */
export function usPhoneError(
  value: string,
  stored?: string | null,
  rules: PhoneValidationRules = DEFAULT_PHONE_VALIDATION_RULES,
): string | null {
  const next = value.trim();
  if (!next) return null;
  const unchanged = stored !== undefined && next === (stored ?? "").trim();
  if (unchanged && !rules.recheckStoredOnEdit) return null;
  return isValidUsPhone(next) ? null : US_PHONE_MESSAGE;
}
