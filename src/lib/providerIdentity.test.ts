// MINT-7 / CRUD-01 — the shared provider identity rules: NPI check digit,
// strict ISO calendar dates, and the existing-data change rule.
import { describe, expect, it } from "vitest";
import {
  identityFieldChanged,
  isIsoDate,
  isValidNpi,
  npiCheckDigit,
  stripNpiSeparators,
} from "./providerIdentity";

describe("isValidNpi", () => {
  it("accepts a 10-digit NPI whose last digit is the CMS 80840 Luhn check digit", () => {
    expect(isValidNpi("1234567893")).toBe(true);
    expect(isValidNpi(" 1234567893 ")).toBe(true);
    expect(isValidNpi(1234567893)).toBe(true);
    expect(isValidNpi("1902833742")).toBe(true);
    expect(isValidNpi("1093817462")).toBe(true);
  });

  it("rejects a format-valid NPI with a wrong check digit", () => {
    for (const value of ["1234567890", "1234567894", "1093817465", "1111111111"]) {
      expect(isValidNpi(value)).toBe(false);
    }
  });

  it("rejects anything that is not exactly 10 digits", () => {
    for (const value of [
      "",
      "123456789",
      "12345678934",
      "123-456-7893",
      "abcdefghij",
      null,
      undefined,
    ]) {
      expect(isValidNpi(value)).toBe(false);
    }
  });

  it("computes the check digit from the first nine digits", () => {
    expect(npiCheckDigit("123456789")).toBe(3);
    expect(npiCheckDigit("109381746")).toBe(2);
    expect(npiCheckDigit("12345678")).toBeNull();
    for (let i = 0; i < 25; i += 1) {
      const first9 = String(100000000 + i * 7919);
      expect(isValidNpi(`${first9}${npiCheckDigit(first9)}`)).toBe(true);
    }
  });
});

describe("stripNpiSeparators (MINT-110)", () => {
  it("strips dashes and spaces so a typed NPI validates", () => {
    expect(stripNpiSeparators("123-456-7893")).toBe("1234567893");
    expect(stripNpiSeparators("123 456 7893")).toBe("1234567893");
    expect(stripNpiSeparators(" 123 - 456 - 7893 ")).toBe("1234567893");
    expect(isValidNpi(stripNpiSeparators("123-456-7893"))).toBe(true);
  });

  it("strips pasted Unicode dashes, the minus sign and non-breaking spaces", () => {
    expect(stripNpiSeparators("123\u2013456\u20147893")).toBe("1234567893");
    expect(stripNpiSeparators("123\u2212456\u00a07893")).toBe("1234567893");
  });

  it("strips the soft hyphen, the word joiner and the small hyphen-minus", () => {
    expect(stripNpiSeparators("123\u00ad456\u00ad7893")).toBe("1234567893");
    expect(stripNpiSeparators("123\u2060456\u20607893")).toBe("1234567893");
    expect(stripNpiSeparators("123\ufe63456\ufe637893")).toBe("1234567893");
  });

  it("strips invisible zero-width characters and the fullwidth hyphen", () => {
    expect(stripNpiSeparators("\ufeff123\u200b456\u200c789\u200d3")).toBe("1234567893");
    expect(stripNpiSeparators("123\uff0d456\uff0d7893")).toBe("1234567893");
    expect(isValidNpi(stripNpiSeparators("1234567893\u200b"))).toBe(true);
  });

  it("keeps other junk so the NPI rule still fails it", () => {
    for (const value of ["123.456.7893", "(123)4567893", "NPI 1234567893", "12345678x3"]) {
      expect(isValidNpi(stripNpiSeparators(value))).toBe(false);
    }
    expect(stripNpiSeparators("123.456.7893")).toBe("123.456.7893");
  });
});

describe("isIsoDate", () => {
  it("accepts strict YYYY-MM-DD real calendar dates", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-12-31")).toBe(true);
  });

  it("rejects malformed and impossible dates", () => {
    for (const value of [
      "2023-02-29",
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-1-5",
      "01/05/2026",
      "2026-01-05T00:00:00Z",
      " 2026-01-05",
      "",
      null,
    ]) {
      expect(isIsoDate(value)).toBe(false);
    }
  });
});

describe("identityFieldChanged", () => {
  it("always validates on create", () => {
    expect(identityFieldChanged("1234567890", undefined)).toBe(true);
  });

  it("skips an unchanged stored value and validates an edited or newly entered one", () => {
    const digits = (v: string) => v.replace(/\D/g, "");
    expect(identityFieldChanged("1234567890", "1234567890")).toBe(false);
    expect(identityFieldChanged("123-456-7890", "1234567890", digits)).toBe(false);
    expect(identityFieldChanged("1234567891", "1234567890")).toBe(true);
    expect(identityFieldChanged("1234567893", null)).toBe(true);
  });
});
