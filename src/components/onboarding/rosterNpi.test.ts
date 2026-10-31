// MINT-7 / MINT-110 — the roster form's NPI rule: the ten digits only (a
// pasted label or dots fail, separators are stripped), an unchanged stored NPI
// is left alone, and the NPI Registry policy's refusal comes last. And the
// roster form's NPI Registry pick.
import { describe, expect, it } from "vitest";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import { NPI_CHECK_DIGIT_MESSAGE } from "@/lib/providerIdentity";
import { EMPTY_LICENSE_DRAFT, type LicenseDraft } from "./licenseDraft";
import { applyRosterNpiPick, rosterNpiError } from "./rosterNpi";

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

const jane = (over: Partial<NpiRegistryRecord>): NpiRegistryRecord => ({
  npi: "1234567893",
  enumerationType: "NPI-1",
  firstName: "JANE",
  middleName: null,
  lastName: "DOE",
  organizationName: null,
  credential: "PT",
  primaryTaxonomy: { code: "225100000X", description: "Physical Therapist" },
  practiceCity: "DENVER",
  practiceState: "CO",
  status: "active",
  enumerationDate: null,
  otherNames: [],
  taxonomies: [
    {
      code: "225100000X",
      description: null,
      primary: true,
      license: "PT-1111",
      licenseState: "CO",
    },
  ],
  ...over,
});
const denver = jane({});
const boulder = jane({
  npi: "1902833742",
  credential: "DPT",
  primaryTaxonomy: { code: "2251X0800X", description: "Physical Therapist, Orthopedic" },
  taxonomies: [
    {
      code: "2251X0800X",
      description: null,
      primary: true,
      license: "PT-4471",
      licenseState: "CO",
    },
    {
      code: "225100000X",
      description: null,
      primary: false,
      license: "WY-0099",
      licenseState: "WY",
    },
  ],
});

describe("applyRosterNpiPick", () => {
  const savedCo: LicenseDraft = {
    ...EMPTY_LICENSE_DRAFT,
    id: "lic-1",
    state: "CO",
    storedExpirationDate: null,
  };
  const fields = { npi: "", credentials: "", taxonomyCode: "" };

  it("fills blanks, including a saved row's blank number, and adds no row", () => {
    const next = applyRosterNpiPick(fields, [savedCo], boulder, "blank_fields", null);
    expect(next.patch).toEqual({
      npi: "1902833742",
      credentials: "DPT",
      taxonomyCode: "2251X0800X",
    });
    expect(next.licenses).toEqual([{ ...savedCo, licenseNumber: "PT-4471" }]);
    expect(next.summary.licenseOffers).toEqual([{ state: "WY", number: "WY-0099", added: false }]);
  });

  it("replaces the first pick's untouched data on a second pick, and keeps staff's", () => {
    const first = applyRosterNpiPick(fields, [savedCo], denver, "blank_fields", null);
    const afterFirst = { ...fields, ...first.patch };
    // Staff changed the taxonomy after the first pick: theirs now.
    const edited = { ...afterFirst, taxonomyCode: "225200000X" };
    const second = applyRosterNpiPick(edited, first.licenses, boulder, "blank_fields", first.trace);
    expect(second.patch).toEqual({ npi: "1902833742", credentials: "DPT" });
    expect(second.licenses[0].licenseNumber).toBe("PT-4471");
    expect(second.summary.kept).toEqual([
      { field: "Taxonomy code", registryValue: "2251X0800X (Physical Therapist, Orthopedic)" },
    ]);
  });

  it("sets only the NPI under npi_only", () => {
    const next = applyRosterNpiPick(fields, [savedCo], boulder, "npi_only", null);
    expect(next.patch).toEqual({ npi: "1902833742" });
    expect(next.licenses).toEqual([savedCo]);
  });
});
