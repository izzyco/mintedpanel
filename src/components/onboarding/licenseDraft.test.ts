// MINT-110 — the roster form's license rows under an NPI Registry pick: only
// an untouched row may be filled, and a new row takes the editor's defaults.
import { describe, expect, it } from "vitest";
import {
  EMPTY_LICENSE_DRAFT,
  isBlankLicenseDraft,
  placeRegistryLicenses,
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

describe("placeRegistryLicenses", () => {
  it("fills the named blank row and appends the rest with the editor's defaults", () => {
    const rows = [saved, { ...EMPTY_LICENSE_DRAFT }];
    const next = placeRegistryLicenses(rows, [
      { state: "CO", number: "PT-4471", rowIndex: 1 },
      { state: "WY", number: "WY-0099", rowIndex: null },
    ]);
    expect(next[0]).toBe(saved);
    expect(next[1]).toEqual({ ...EMPTY_LICENSE_DRAFT, state: "CO", licenseNumber: "PT-4471" });
    expect(next[2]).toEqual({ ...EMPTY_LICENSE_DRAFT, state: "WY", licenseNumber: "WY-0099" });
    expect(rows).toHaveLength(2);
  });
});
