// MINT-129 — the configurable identity validation rules: their decided
// defaults, the stricter alternative, the resolver's precedence, and the
// validator that keeps the check digit out of reach.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDENTITY_VALIDATION_RULES,
  identityFieldChanged,
  identityFieldNeedsCheck,
  isValidNpi,
  resolveIdentityValidationRules,
  validateIdentityValidationRules,
  type IdentityValidationRules,
} from "./providerIdentity";
// Aliased so it reads as the plain function it is outside a component.
import { useIdentityValidationRules as identityRulesInForce } from "@/hooks/useIdentityValidationRules";

const RECHECK: IdentityValidationRules = { recheckStoredOnEdit: true, deaLastNameLetter: "off" };
const EVERY_RULE_SET: IdentityValidationRules[] = [DEFAULT_IDENTITY_VALIDATION_RULES, RECHECK];
const digits = (v: string) => v.replace(/\D/g, "");

describe("DEFAULT_IDENTITY_VALIDATION_RULES", () => {
  it("holds the decisions of Oct 30: no re-check of stored identities, DEA letter off", () => {
    expect(DEFAULT_IDENTITY_VALIDATION_RULES).toEqual({
      recheckStoredOnEdit: false,
      deaLastNameLetter: "off",
    });
    expect(Object.isFrozen(DEFAULT_IDENTITY_VALIDATION_RULES)).toBe(true);
  });

  it("is what every consumer reads today, as one frozen object", () => {
    expect(identityRulesInForce()).toEqual(DEFAULT_IDENTITY_VALIDATION_RULES);
    expect(Object.isFrozen(identityRulesInForce())).toBe(true);
    expect(identityRulesInForce()).toBe(identityRulesInForce());
  });
});

describe("resolveIdentityValidationRules", () => {
  it("is the defaults when nothing is stored", () => {
    expect(resolveIdentityValidationRules()).toEqual(DEFAULT_IDENTITY_VALIDATION_RULES);
    expect(resolveIdentityValidationRules(null, null)).toEqual(DEFAULT_IDENTITY_VALIDATION_RULES);
    expect(resolveIdentityValidationRules({}, {})).toEqual(DEFAULT_IDENTITY_VALIDATION_RULES);
  });

  it("takes the organization's value, else the platform's, else the default", () => {
    expect(resolveIdentityValidationRules({ recheckStoredOnEdit: true })).toEqual(RECHECK);
    expect(resolveIdentityValidationRules(null, { recheckStoredOnEdit: true })).toEqual(RECHECK);
    expect(
      resolveIdentityValidationRules({ recheckStoredOnEdit: true }, { recheckStoredOnEdit: false }),
    ).toEqual(DEFAULT_IDENTITY_VALIDATION_RULES);
    expect(
      resolveIdentityValidationRules({ recheckStoredOnEdit: false }, { recheckStoredOnEdit: true }),
    ).toEqual(RECHECK);
  });

  it("inherits on null or undefined, but not on false", () => {
    expect(
      resolveIdentityValidationRules(
        { recheckStoredOnEdit: true, deaLastNameLetter: "off" },
        { recheckStoredOnEdit: null, deaLastNameLetter: undefined },
      ),
    ).toEqual(RECHECK);
  });

  it("skips a value of the wrong shape like a missing one", () => {
    const platform = { recheckStoredOnEdit: true } as const;
    const bad = {
      recheckStoredOnEdit: "yes",
      deaLastNameLetter: "enforce",
    } as unknown as IdentityValidationRules;
    expect(resolveIdentityValidationRules(platform, bad)).toEqual(RECHECK);
    expect(resolveIdentityValidationRules(bad)).toEqual(DEFAULT_IDENTITY_VALIDATION_RULES);
  });

  it("never reads a field it does not define, so no override can reach the check digit", () => {
    const loosening = {
      npiCheckDigit: false,
      skipChecksum: true,
      recheckStoredOnEdit: true,
    } as unknown as IdentityValidationRules;
    const resolved = resolveIdentityValidationRules(loosening, loosening);
    expect(resolved).toEqual(RECHECK);
    expect(Object.keys(resolved).sort()).toEqual(["deaLastNameLetter", "recheckStoredOnEdit"]);
  });
});

describe("validateIdentityValidationRules", () => {
  it("passes the defaults, the stricter alternative, an empty override and inherits", () => {
    expect(validateIdentityValidationRules(null)).toEqual([]);
    expect(validateIdentityValidationRules(undefined)).toEqual([]);
    expect(validateIdentityValidationRules({})).toEqual([]);
    expect(validateIdentityValidationRules(DEFAULT_IDENTITY_VALIDATION_RULES)).toEqual([]);
    expect(validateIdentityValidationRules(RECHECK)).toEqual([]);
    expect(
      validateIdentityValidationRules({ recheckStoredOnEdit: null, deaLastNameLetter: null }),
    ).toEqual([]);
  });

  it("rejects something that is not a set of settings", () => {
    for (const value of ["on", 1, true, []]) {
      expect(validateIdentityValidationRules(value)).toEqual([
        "Identity validation rules must be a set of named settings.",
      ]);
    }
  });

  it("rejects invalid values in plain language", () => {
    expect(
      validateIdentityValidationRules({ recheckStoredOnEdit: "yes", deaLastNameLetter: "maybe" }),
    ).toEqual([
      '"Re-check stored NPIs on edit" must be on or off.',
      'The DEA last-name letter rule must be "off".',
    ]);
  });

  it("refuses to enforce the DEA last-name letter while no form takes a DEA number", () => {
    expect(validateIdentityValidationRules({ deaLastNameLetter: "enforce" })).toEqual([
      "The DEA last-name letter can't be enforced yet: no provider form takes a DEA number. Leave it off.",
    ]);
  });

  it("rejects any setting that would loosen the NPI or DEA check digit", () => {
    for (const key of [
      "npiCheckDigit",
      "skipChecksum",
      "luhn",
      "deaCheckDigit",
      "allowAnyNpi",
      "allowAnyNPI",
      "npi_check_digit",
      "checkDigitOff",
    ]) {
      expect(validateIdentityValidationRules({ [key]: false })).toEqual([
        `"${key}" can't be configured: the NPI and DEA check digits are facts about the number, so no setting can turn them off or relax them. A setting can only make identity checks stricter.`,
      ]);
    }
  });

  it("rejects an unknown setting by name", () => {
    expect(validateIdentityValidationRules({ recheckStoredOnEdit: true, cadence: 3 })).toEqual([
      '"cadence" is not an identity validation setting.',
    ]);
  });

  it("matches a fixed check on whole words only, so a word that merely contains one is just unknown", () => {
    for (const key of ["idea", "ideaBoard", "deadline", "recheckDigits"]) {
      expect(validateIdentityValidationRules({ [key]: true })).toEqual([
        `"${key}" is not an identity validation setting.`,
      ]);
    }
  });
});

describe("identityFieldNeedsCheck", () => {
  it("by default checks exactly what identityFieldChanged reports", () => {
    const cases: Array<[string, string | null | undefined]> = [
      ["1234567890", undefined],
      ["1234567890", "1234567890"],
      ["1234567891", "1234567890"],
      ["1234567893", null],
      ["", null],
    ];
    for (const [next, stored] of cases) {
      expect(identityFieldNeedsCheck(next, stored)).toBe(identityFieldChanged(next, stored));
      expect(identityFieldNeedsCheck(next, stored, DEFAULT_IDENTITY_VALIDATION_RULES)).toBe(
        identityFieldChanged(next, stored),
      );
    }
    expect(identityFieldNeedsCheck("123-456-7890", "1234567890", undefined, digits)).toBe(false);
  });

  it("with recheckStoredOnEdit, checks an unchanged stored value too", () => {
    expect(identityFieldNeedsCheck("1234567890", "1234567890", RECHECK)).toBe(true);
    expect(identityFieldNeedsCheck("123-456-7890", "1234567890", RECHECK, digits)).toBe(true);
  });

  it("never checks less than the default, and always checks a new identity", () => {
    const cases: Array<[string, string | null | undefined]> = [
      ["1234567890", undefined],
      ["1234567890", "1234567890"],
      ["1234567891", "1234567890"],
      ["1234567893", null],
    ];
    for (const rules of EVERY_RULE_SET) {
      expect(identityFieldNeedsCheck("1234567890", undefined, rules)).toBe(true);
      for (const [next, stored] of cases) {
        if (identityFieldChanged(next, stored)) {
          expect(identityFieldNeedsCheck(next, stored, rules)).toBe(true);
        }
      }
    }
    // The check itself takes no rules: a wrong check digit is wrong under all of them.
    expect(isValidNpi("1234567890")).toBe(false);
  });
});
