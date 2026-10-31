// MINT-7 / MINT-110 — the roster form's NPI rule: the ten digits only (a
// pasted label or dots fail, separators are stripped), an unchanged stored NPI
// is left alone, and the NPI Registry policy's refusal comes last.
import { describe, expect, it } from "vitest";
import { NPI_CHECK_DIGIT_MESSAGE } from "@/lib/providerIdentity";
import { rosterNpiError } from "./rosterNpi";

const BLOCK = "Your organization saves only NPIs the NPI Registry lists.";

describe("rosterNpiError", () => {
  it("requires an NPI", () => {
    expect(rosterNpiError("  ", true, null)).toBe("Type 1 NPI is required");
  });

  it("rejects a pasted label, dots and letters, and accepts dashes and spaces", () => {
    for (const npi of ["NPI: 1234567893", "123.456.7893", "12a4567893"]) {
      expect(rosterNpiError(npi, true, null)).toBe("NPI must be 10 digits");
    }
    for (const npi of ["123-456-7893", "123 456 7893", "1234567893"]) {
      expect(rosterNpiError(npi, true, null)).toBeNull();
    }
    expect(rosterNpiError("1234567890", true, null)).toBe(NPI_CHECK_DIGIT_MESSAGE);
  });

  it("refuses a valid NPI the registry policy blocks, after the check digit", () => {
    expect(rosterNpiError("123-456-7893", true, BLOCK)).toBe(BLOCK);
    expect(rosterNpiError("1234567890", true, BLOCK)).toBe(NPI_CHECK_DIGIT_MESSAGE);
  });

  it("leaves an unchanged stored NPI alone", () => {
    expect(rosterNpiError("legacy-npi", false, null)).toBeNull();
  });
});
