// MINT-110 — the roster form's license rows when staff add a license an NPI
// Registry pick offered: only an untouched row is filled, and a new row takes
// the editor's defaults.
import { describe, expect, it } from "vitest";
import {
  EMPTY_LICENSE_DRAFT,
  addRegistryLicenseDraft,
  isBlankLicenseDraft,
  type LicenseDraft,
} from "./licenseDraft";

const saved: LicenseDraft = {
  ...EMPTY_LICENSE_DRAFT,
  id: "lic-1",
  state: "",
  storedExpirationDate: null,
};

describe("isBlankLicenseDraft", () => {
  it("is true for the editor's empty row, whose type defaults to Full", () => {
    expect(isBlankLicenseDraft({ ...EMPTY_LICENSE_DRAFT })).toBe(true);
    expect(isBlankLicenseDraft({ ...EMPTY_LICENSE_DRAFT, licenseNumber: "  " })).toBe(true);
  });

  it("is false for a saved row and for any field staff changed", () => {
    expect(isBlankLicenseDraft(saved)).toBe(false);
    for (const patch of [
      { state: "CO" },
      { licenseNumber: "X" },
      { licenseType: "compact" },
      { issueDate: "2026-01-01" },
      { expirationDate: "2027-01-01" },
      { verifiedStatus: "verified" as const },
      { verificationSourceUrl: "https://board.example.test" },
    ]) {
      expect(isBlankLicenseDraft({ ...EMPTY_LICENSE_DRAFT, ...patch })).toBe(false);
    }
  });
});

describe("addRegistryLicenseDraft", () => {
  it("fills the untouched empty row, or adds one with the editor's defaults", () => {
    const rows = [saved, { ...EMPTY_LICENSE_DRAFT }];
    const next = addRegistryLicenseDraft(rows, { state: "WY", number: "WY-0099" });
    expect(next[0]).toBe(saved);
    expect(next[1]).toEqual({ ...EMPTY_LICENSE_DRAFT, state: "WY", licenseNumber: "WY-0099" });
    expect(next).toHaveLength(2);
    const again = addRegistryLicenseDraft(next, { state: "CO", number: "PT-4471" });
    expect(again[2]).toEqual({ ...EMPTY_LICENSE_DRAFT, state: "CO", licenseNumber: "PT-4471" });
    expect(rows).toHaveLength(2);
  });
});
