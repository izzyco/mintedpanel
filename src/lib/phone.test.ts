import { describe, expect, it } from "vitest";
import {
  DEFAULT_PHONE_VALIDATION_RULES,
  US_PHONE_MESSAGE,
  isValidUsPhone,
  resolvePhoneValidationRules,
  usPhoneError,
  validatePhoneValidationRules,
  type PhoneValidationRules,
} from "./phone";

describe("isValidUsPhone (MINT-91)", () => {
  it("accepts 10 digits with or without the usual separators", () => {
    for (const value of [
      "2525550100",
      "252-555-0100",
      "252.555.0100",
      "(252) 555-0100",
      "252 555 0100",
      "  252-555-0100  ",
    ]) {
      expect(isValidUsPhone(value), value).toBe(true);
    }
  });

  it("accepts 11 digits only when the first is 1", () => {
    expect(isValidUsPhone("12525550100")).toBe(true);
    expect(isValidUsPhone("1-252-555-0100")).toBe(true);
    expect(isValidUsPhone("1 (252) 555-0100")).toBe(true);
    expect(isValidUsPhone("22525550100")).toBe(false);
  });

  it("treats a leading + as a country code: only +1 then 10 digits passes", () => {
    expect(isValidUsPhone("+65 6123 4567")).toBe(false);
    expect(isValidUsPhone("+82 2 123 4567")).toBe(false);
    expect(isValidUsPhone("+2525550100")).toBe(false);
    expect(isValidUsPhone("+44 20 7946 0958")).toBe(false);
    expect(isValidUsPhone("+1 252 555 0100 x12")).toBe(true);
  });

  it("accepts a leading +1, and a leading + only once", () => {
    expect(isValidUsPhone("+1 252 555 0100")).toBe(true);
    expect(isValidUsPhone("+1 (252) 555-0100")).toBe(true);
    expect(isValidUsPhone("+12525550100")).toBe(true);
    expect(isValidUsPhone("++12525550100")).toBe(false);
    expect(isValidUsPhone("+1")).toBe(false);
    expect(isValidUsPhone("252-555-0100+")).toBe(false);
  });

  it("accepts a trailing extension in each listed form", () => {
    for (const value of [
      "252-555-0100 x123",
      "252-555-0100x123",
      "252-555-0100 X 7",
      "252-555-0100 ext 123",
      "252-555-0100 ext. 123",
      "252-555-0100 Ext.123",
      "252-555-0100 #123",
      "+1 (252) 555-0100 ext. 45",
    ]) {
      expect(isValidUsPhone(value), value).toBe(true);
    }
  });

  it("rejects an extension marker with no digits, or one that is not at the end", () => {
    expect(isValidUsPhone("252-555-0100 x")).toBe(false);
    expect(isValidUsPhone("252-555-0100 ext")).toBe(false);
    expect(isValidUsPhone("252-555-0100 #")).toBe(false);
    expect(isValidUsPhone("252 x123 555-0100")).toBe(false);
  });

  it("rejects letters anywhere else", () => {
    expect(isValidUsPhone("abc-def-ghij")).toBe(false);
    expect(isValidUsPhone("1-800-FLOWERS")).toBe(false);
    expect(isValidUsPhone("252-555-010O")).toBe(false);
    expect(isValidUsPhone("252-555-0100 extension 12")).toBe(false);
    expect(isValidUsPhone("call 252-555-0100")).toBe(false);
  });

  it("rejects too few or too many digits", () => {
    expect(isValidUsPhone("")).toBe(false);
    expect(isValidUsPhone("555-0100")).toBe(false);
    expect(isValidUsPhone("252-555-010")).toBe(false);
    expect(isValidUsPhone("252-555-01000")).toBe(false);
    expect(isValidUsPhone("1-252-555-01000")).toBe(false);
  });

  it("stays linear on a long run of spaces", () => {
    // 100k spaces: the old quadratic pattern took seconds here, linear takes
    // milliseconds, so the 1s ceiling leaves slow CI runners plenty of room.
    const started = performance.now();
    expect(isValidUsPhone(`1${" ".repeat(100_000)}a`)).toBe(false);
    expect(isValidUsPhone(`x${" ".repeat(100_000)}a`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("rejects separators outside the listed set", () => {
    expect(isValidUsPhone("252/555/0100")).toBe(false);
    expect(isValidUsPhone("252_555_0100")).toBe(false);
  });
});

describe("usPhoneError — blank and existing-data rules", () => {
  it("lets blank through; each form keeps its own required rule", () => {
    expect(usPhoneError("")).toBeNull();
    expect(usPhoneError("   ")).toBeNull();
    expect(usPhoneError("", "abc-def-ghij")).toBeNull();
  });

  it("checks an entered phone on create", () => {
    expect(usPhoneError("abc-def-ghij")).toBe(US_PHONE_MESSAGE);
    expect(usPhoneError("252-555-0100")).toBeNull();
  });

  it("never re-checks an untouched stored phone, even an invalid one", () => {
    expect(usPhoneError("abc-def-ghij", "abc-def-ghij")).toBeNull();
    expect(usPhoneError(" 555-0100 ", "555-0100")).toBeNull();
  });

  it("checks a changed phone on edit, including one filled where none was stored", () => {
    expect(usPhoneError("abc-def-ghij", "252-555-0100")).toBe(US_PHONE_MESSAGE);
    expect(usPhoneError("abc-def-ghij", null)).toBe(US_PHONE_MESSAGE);
    expect(usPhoneError("555-0101", "555-0100")).toBe(US_PHONE_MESSAGE);
    expect(usPhoneError("252-555-0199", "abc-def-ghij")).toBeNull();
  });
});

const RECHECK: PhoneValidationRules = {
  ...DEFAULT_PHONE_VALIDATION_RULES,
  recheckStoredOnEdit: true,
};

describe("usPhoneError under recheckStoredOnEdit (MINT-129 alternative)", () => {
  it("checks an untouched stored phone on every edit save", () => {
    expect(usPhoneError("abc-def-ghij", "abc-def-ghij", RECHECK)).toBe(US_PHONE_MESSAGE);
    expect(usPhoneError("252-555-0100", "252-555-0100", RECHECK)).toBeNull();
  });

  it("still lets blank through and still checks a create", () => {
    expect(usPhoneError("", "abc-def-ghij", RECHECK)).toBeNull();
    expect(usPhoneError("abc-def-ghij", undefined, RECHECK)).toBe(US_PHONE_MESSAGE);
  });
});

describe("PhoneValidationRules (MINT-91 Addendum 8, Mission Control MINT-129)", () => {
  it("defaults to Sowmya's Oct 31 answers: no re-check (A4), create without the phone (A5)", () => {
    expect(DEFAULT_PHONE_VALIDATION_RULES).toEqual({
      recheckStoredOnEdit: false,
      importInvalidPhone: "create_without_phone",
    });
    expect(Object.isFrozen(DEFAULT_PHONE_VALIDATION_RULES)).toBe(true);
    expect(resolvePhoneValidationRules()).toEqual(DEFAULT_PHONE_VALIDATION_RULES);
  });

  it("resolves field by field: organization over platform over default", () => {
    expect(
      resolvePhoneValidationRules(
        { recheckStoredOnEdit: true, importInvalidPhone: "block_row" },
        { importInvalidPhone: "create_without_phone" },
      ),
    ).toEqual({ recheckStoredOnEdit: true, importInvalidPhone: "create_without_phone" });
    expect(resolvePhoneValidationRules(null, { importInvalidPhone: "block_row" })).toEqual({
      recheckStoredOnEdit: false,
      importInvalidPhone: "block_row",
    });
  });

  it("inherits through null and skips a value of the wrong shape", () => {
    expect(
      resolvePhoneValidationRules(
        { recheckStoredOnEdit: true },
        { recheckStoredOnEdit: null, importInvalidPhone: null },
      ),
    ).toEqual({ recheckStoredOnEdit: true, importInvalidPhone: "create_without_phone" });
    const wrongShape = { recheckStoredOnEdit: "yes", importInvalidPhone: "skip" } as unknown as {
      recheckStoredOnEdit: boolean;
    };
    expect(resolvePhoneValidationRules(wrongShape)).toEqual(DEFAULT_PHONE_VALIDATION_RULES);
  });

  it("never reads a format setting: phones stay US only (A3)", () => {
    const withFormat = { allowE164: true, recheckStoredOnEdit: true } as unknown as {
      recheckStoredOnEdit: boolean;
    };
    const resolved = resolvePhoneValidationRules(withFormat);
    expect(Object.keys(resolved).sort()).toEqual(["importInvalidPhone", "recheckStoredOnEdit"]);
    expect(isValidUsPhone("+65 6123 4567")).toBe(false);
  });

  it("validates an override in plain language", () => {
    expect(validatePhoneValidationRules(undefined)).toEqual([]);
    expect(validatePhoneValidationRules({})).toEqual([]);
    expect(
      validatePhoneValidationRules({ recheckStoredOnEdit: true, importInvalidPhone: "block_row" }),
    ).toEqual([]);
    expect(validatePhoneValidationRules({ recheckStoredOnEdit: null })).toEqual([]);
    expect(validatePhoneValidationRules(["block_row"])).toEqual([
      "Phone validation rules must be a set of named settings.",
    ]);
    expect(validatePhoneValidationRules({ recheckStoredOnEdit: "on" })).toEqual([
      '"Re-check stored phones on edit" must be on or off.',
    ]);
    expect(validatePhoneValidationRules({ importInvalidPhone: "skip_phone" })[0]).toMatch(
      /^"Import row with an invalid phone" must be "create_without_phone"/,
    );
    expect(validatePhoneValidationRules({ maxRows: 5 })).toEqual([
      '"maxRows" is not a phone validation setting.',
    ]);
  });

  it("explains that the format can't be configured, for any key naming it", () => {
    for (const key of ["allowE164", "phoneFormat", "allow_international", "countryCodes"]) {
      expect(validatePhoneValidationRules({ [key]: true }), key).toEqual([
        `"${key}" can't be configured: phone numbers are US only (10 digits, or 1 then 10, with an optional extension), decided Oct 31, 2026.`,
      ]);
    }
    expect(validatePhoneValidationRules({ reformatted: true })).toEqual([
      '"reformatted" is not a phone validation setting.',
    ]);
  });
});
