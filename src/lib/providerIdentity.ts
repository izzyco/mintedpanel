// Provider identity rules (MINT-7 / audit CRUD-01): the ONE implementation of
// the NPI check digit, the DEA checksum, and the strict ISO calendar-date
// check. Pure and I/O-free; the Add Provider form, the roster form, the
// provider record's inline edit, the import dedupe (new identities only), and
// roster export call these instead of re-declaring regexes. Blank-value policy
// stays with each caller (NPI is optional on Add Provider, required on the
// roster form and the provider import).
//
// The checks themselves are facts about the number and never configurable.
// What a platform or organization may configure, only ever stricter, is
// IdentityValidationRules at the bottom of this file (Mission Control
// MINT-129).

const NPI_DIGITS_RE = /^\d{10}$/;
// Second character: the registrant's last-name/business initial, or 9 (business
// and mid-level registrants). No first-letter allowlist.
const DEA_RE = /^[A-Z][A-Z9]\d{7}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const NPI_CHECK_DIGIT_MESSAGE = "NPI check digit is invalid — re-check the number";
export const DEA_FORMAT_MESSAGE = "DEA must be a letter, then a letter or 9, then 7 digits";
export const DEA_CHECK_DIGIT_MESSAGE = "DEA check digit is invalid — re-check the number";

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

export type DeaProblem = "format" | "check_digit";

/** Why a DEA number fails, or null when it passes: a letter, a letter or 9,
 * then 7 digits whose 7th equals the last digit of
 * (d1 + d3 + d5) + 2 × (d2 + d4 + d6). The second character is NOT matched to
 * the registrant's last name (decided Oct 30, 2026; see
 * IdentityValidationRules.deaLastNameLetter). */
export function deaProblem(value: unknown): DeaProblem | null {
  if (typeof value !== "string") return "format";
  const dea = value.trim();
  if (!DEA_RE.test(dea)) return "format";
  const d = dea.slice(2).split("").map(Number);
  const sum = d[0] + d[2] + d[4] + 2 * (d[1] + d[3] + d[5]);
  return sum % 10 === d[6] ? null : "check_digit";
}

export function isValidDea(value: unknown): boolean {
  return deaProblem(value) === null;
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
 * stored NPI or DEA that predates these checks never blocks an unrelated save.
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
// of Oct 30, 2026 as its default. A stored NPI or DEA is checked only when it
// is entered or changed; an import checks only a new identity and leaves
// existing rows alone (there is no database CHECK); the DEA's second character
// is not matched to the registrant's last name. A platform override, then an
// organization override, may change a field (resolveIdentityValidationRules).
// Nothing stores an override yet, so every caller resolves to the defaults
// (useIdentityValidationRules); the setting itself is MINT-129.
//
// Every alternative is STRICTER than its default. The NPI check digit, the
// 10-digit rule and the DEA format and checksum are facts about the number,
// not settings: the resolver reads only the fields below, and
// validateIdentityValidationRules rejects anything that names a check.

/** The values the DEA last-name-letter rule can take. Only "off" for now:
 * enforcing it (the second character must be the registrant's last-name
 * initial, or 9) needs a DEA field on a provider form, and no form takes one.
 * The import writes DEA numbers without checking them at all. */
export const DEA_LAST_NAME_LETTER_RULES = ["off"] as const;
export type DeaLastNameLetterRule = (typeof DEA_LAST_NAME_LETTER_RULES)[number];

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
  /** "off" (default): the DEA's second character is not matched to the
   * registrant's last name. */
  deaLastNameLetter: DeaLastNameLetterRule;
}

/** The platform default: the PM's decisions of Oct 30, 2026. */
export const DEFAULT_IDENTITY_VALIDATION_RULES: Readonly<IdentityValidationRules> = Object.freeze({
  recheckStoredOnEdit: false,
  deaLastNameLetter: "off",
});

/** A platform or organization override. A null or missing field inherits. */
export type IdentityValidationRulesOverride = {
  readonly [K in keyof IdentityValidationRules]?: IdentityValidationRules[K] | null;
};

const IDENTITY_RULE_CHECKS: {
  [K in keyof IdentityValidationRules]: (value: unknown) => boolean;
} = {
  recheckStoredOnEdit: (value) => typeof value === "boolean",
  deaLastNameLetter: (value) => (DEA_LAST_NAME_LETTER_RULES as readonly unknown[]).includes(value),
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
    deaLastNameLetter: pick("deaLastNameLetter"),
  };
}

// A setting whose name points at one of the fixed checks gets the reason it
// can't exist, not just "unknown". Matched on whole words of the key
// ("npiCheckDigit", "skip_checksum", "allowAnyNPI"), so "idea" is not "dea".
const FIXED_CHECK_WORDS_RE = /(?:^| )(?:npi|dea|luhn|checksums?|check ?digits?)(?= |$)/;

function namesFixedCheck(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(" ");
  return FIXED_CHECK_WORDS_RE.test(words);
}

/** Plain-language problems with an override; empty when it can go live. A
 * null or missing field inherits and is fine. */
export function validateIdentityValidationRules(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  if (typeof input !== "object" || Array.isArray(input)) {
    return ["Identity validation rules must be a set of named settings."];
  }
  const errors: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === "recheckStoredOnEdit") {
      if (value != null && !IDENTITY_RULE_CHECKS.recheckStoredOnEdit(value)) {
        errors.push('"Re-check stored NPIs on edit" must be on or off.');
      }
    } else if (key === "deaLastNameLetter") {
      if (value === "enforce") {
        errors.push(
          "The DEA last-name letter can't be enforced yet: no provider form takes a DEA number. Leave it off.",
        );
      } else if (value != null && !IDENTITY_RULE_CHECKS.deaLastNameLetter(value)) {
        errors.push('The DEA last-name letter rule must be "off".');
      }
    } else if (namesFixedCheck(key)) {
      errors.push(
        `"${key}" can't be configured: the NPI and DEA check digits are facts about the number, so no setting can turn them off or relax them. A setting can only make identity checks stricter.`,
      );
    } else {
      errors.push(`"${key}" is not an identity validation setting.`);
    }
  }
  return errors;
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
