// Provider identity rules (MINT-7 / audit CRUD-01): the ONE implementation of
// the NPI check digit and the strict ISO calendar-date check. Pure and
// I/O-free; the Add Provider form, the roster form, the provider record's
// inline edit, the import dedupe (new identities only), and roster export call
// these instead of re-declaring regexes. Blank-value policy stays with each
// caller (NPI is optional on Add Provider, required on the roster form and the
// provider import). The DEA checksum comes with its import call (MINT-137).
//
// The checks themselves are facts about the number and never configurable.
// What a platform or organization may configure, only ever stricter, is
// IdentityValidationRules at the bottom of this file (Mission Control
// MINT-129).

const NPI_DIGITS_RE = /^\d{10}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const NPI_CHECK_DIGIT_MESSAGE = "NPI check digit is invalid — re-check the number";

/** The NPI check digit for its first nine digits: Luhn over the CMS `80840`
 * card-issuer prefix. Null when `first9` is not exactly nine digits. */
export function npiCheckDigit(first9: string): number | null {
  if (!/^\d{9}$/.test(first9)) return null;
  const prefixed = `80840${first9}`;
  let sum = 0;
  // The check digit sits to the right, so the rightmost payload digit doubles.
  let double = true;
  for (let index = prefixed.length - 1; index >= 0; index -= 1) {
    let digit = Number(prefixed[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

/** Exactly 10 digits (surrounding whitespace ignored) whose last digit is the
 * CMS check digit. Dashes or spaces inside the number fail; strip them first. */
export function isValidNpi(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const digits = String(value).trim();
  if (!NPI_DIGITS_RE.test(digits)) return false;
  return npiCheckDigit(digits.slice(0, 9)) === Number(digits[9]);
}

/** Strict `YYYY-MM-DD` that names a real calendar date (no Feb 30, no month 13). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Whether an identity field was entered or changed. On an edit, a value
 * equal to the stored one (after `normalize`) is unchanged, so by default a
 * stored NPI that predates these checks never blocks an unrelated save.
 * Create flows pass `stored` as undefined. To decide whether to CHECK the
 * field, use identityFieldNeedsCheck, which also applies the configurable
 * recheckStoredOnEdit rule. */
export function identityFieldChanged(
  next: string,
  stored: string | null | undefined,
  normalize: (value: string) => string = (value) => value.trim(),
): boolean {
  if (stored === undefined) return true;
  return normalize(next) !== normalize(stored ?? "");
}

// ---------------------------------------------------------------------------
// Identity validation rules (Mission Control MINT-129)
//
// Business policy is configuration: each field below holds Sowmya's decision
// of Oct 30, 2026 as its default. A stored NPI is checked only when it is
// entered or changed; an import checks only a new identity and leaves existing
// rows alone (there is no database CHECK). A platform override, then an
// organization override, may change a field (resolveIdentityValidationRules).
// Nothing stores an override yet, so every caller resolves to the defaults
// (useIdentityValidationRules); the setting itself is MINT-129.
//
// Every alternative is STRICTER than its default. The NPI check digit and the
// 10-digit rule are facts about the number, not settings: the resolver reads
// only the fields below.
//
// Also decided Oct 30, 2026: a DEA number's second character is not matched to
// the registrant's last name. That is not a setting: no provider form takes a
// DEA number, and the import writes DEA numbers without checking them.

export interface IdentityValidationRules {
  /** False (default): the provider record's Provider Info edit and the roster
   * form check the NPI only when it is changed, and an import row that matches
   * an existing provider by NPI is not checked, so an NPI stored before the
   * check digit never blocks an unrelated save there. True: those two edits
   * check the stored NPI on every save, and the import blocks a matching row
   * whose stored NPI fails. No other write checks a provider's NPI under
   * either value: not the license dialogs, terminate, or
   * PATCH /api/providers/:id. */
  recheckStoredOnEdit: boolean;
}

/** The platform default: the PM's decisions of Oct 30, 2026. */
export const DEFAULT_IDENTITY_VALIDATION_RULES: Readonly<IdentityValidationRules> = Object.freeze({
  recheckStoredOnEdit: false,
});

/** A platform or organization override. A null or missing field inherits. */
export type IdentityValidationRulesOverride = {
  readonly [K in keyof IdentityValidationRules]?: IdentityValidationRules[K] | null;
};

const IDENTITY_RULE_CHECKS: {
  [K in keyof IdentityValidationRules]: (value: unknown) => boolean;
} = {
  recheckStoredOnEdit: (value) => typeof value === "boolean",
};

/** Field by field: the organization's value, else the platform's, else the
 * default. A value of the wrong shape is skipped like a missing one, and a
 * field this object does not define is never read. */
export function resolveIdentityValidationRules(
  platform?: IdentityValidationRulesOverride | null,
  organization?: IdentityValidationRulesOverride | null,
): IdentityValidationRules {
  const pick = <K extends keyof IdentityValidationRules>(key: K): IdentityValidationRules[K] => {
    for (const override of [organization, platform]) {
      const value: unknown = override?.[key];
      if (value != null && IDENTITY_RULE_CHECKS[key](value)) {
        return value as IdentityValidationRules[K];
      }
    }
    return DEFAULT_IDENTITY_VALIDATION_RULES[key];
  };
  return {
    recheckStoredOnEdit: pick("recheckStoredOnEdit"),
  };
}

/** Whether to check an identity field on this save: always on create, and on
 * an edit when it changed, or whatever it holds under recheckStoredOnEdit.
 * Blank-value policy stays with the caller. */
export function identityFieldNeedsCheck(
  next: string,
  stored: string | null | undefined,
  rules: IdentityValidationRules = DEFAULT_IDENTITY_VALIDATION_RULES,
  normalize?: (value: string) => string,
): boolean {
  return rules.recheckStoredOnEdit || identityFieldChanged(next, stored, normalize);
}
