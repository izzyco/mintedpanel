// MINT-129 — the configurable identity validation rules: their decided
// defaults, the stricter alternative, and the resolver's precedence.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDENTITY_VALIDATION_RULES,
  identityFieldChanged,
  identityFieldNeedsCheck,
  isValidNpi,
  resolveIdentityValidationRules,
  type IdentityValidationRules,
} from "./providerIdentity";
// Aliased so it reads as the plain function it is outside a component.
import { useIdentityValidationRules as identityRulesInForce } from "@/hooks/useIdentityValidationRules";

const RECHECK: IdentityValidationRules = { recheckStoredOnEdit: true };
const EVERY_RULE_SET: IdentityValidationRules[] = [DEFAULT_IDENTITY_VALIDATION_RULES, RECHECK];
const digits = (v: string) => v.replace(/\D/g, "");

describe("DEFAULT_IDENTITY_VALIDATION_RULES", () => {
  it("holds the decision of Oct 30: no re-check of stored identities", () => {
    expect(DEFAULT_IDENTITY_VALIDATION_RULES).toEqual({ recheckStoredOnEdit: false });
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
      resolveIdentityValidationRules({ recheckStoredOnEdit: true }, { recheckStoredOnEdit: null }),
    ).toEqual(RECHECK);
  });

  it("skips a value of the wrong shape like a missing one", () => {
    const platform = { recheckStoredOnEdit: true } as const;
    const bad = { recheckStoredOnEdit: "yes" } as unknown as IdentityValidationRules;
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
    expect(Object.keys(resolved)).toEqual(["recheckStoredOnEdit"]);
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
