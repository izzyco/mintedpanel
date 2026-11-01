// MINT-7 / MINT-110 — the roster form's NPI rule: the ten digits and the
// check digit only (a pasted label or dots fail, separators are stripped), an
// unchanged stored NPI is left alone, and no NPI Registry answer ever refuses
// a save (A30). And the roster form's NPI Registry pick.
import { describe, expect, it } from "vitest";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import { NPI_CHECK_DIGIT_MESSAGE } from "@/lib/providerIdentity";
import { EMPTY_LICENSE_DRAFT, addRegistryLicenseDraft, type LicenseDraft } from "./licenseDraft";
import { applyRosterNpiPick, rosterNpiError } from "./rosterNpi";

describe("rosterNpiError", () => {
  it("requires an NPI", () => {
    expect(rosterNpiError("  ", true)).toBe("Type 1 NPI is required");
  });

  it("rejects a pasted label, dots and letters, and accepts dashes and spaces", () => {
    for (const npi of ["NPI: 1234567893", "123.456.7893", "12a4567893"]) {
      expect(rosterNpiError(npi, true)).toBe("NPI must be 10 digits");
    }
    for (const npi of ["123-456-7893", "123 456 7893", "1234567893"]) {
      expect(rosterNpiError(npi, true)).toBeNull();
    }
    expect(rosterNpiError("1234567890", true)).toBe(NPI_CHECK_DIGIT_MESSAGE);
  });

  it("takes no registry answer: the format and check digit are the only hard rules", () => {
    // Before A30 a third argument carried the policy's refusal.
    expect(rosterNpiError.length).toBe(2);
  });

  it("leaves an unchanged stored NPI alone", () => {
    expect(rosterNpiError("legacy-npi", false)).toBeNull();
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
  const PULLED = "2026-10-31T15:00:00.000Z";
  const FRESH = {
    touched: { credentials: false, taxonomyCode: false },
    lastPick: null,
    pulledAt: PULLED,
  };

  it("fills blanks, including a saved unverified row's blank number, and adds a row for a state with none", () => {
    const next = applyRosterNpiPick(fields, [savedCo], boulder, "blank_fields", FRESH);
    expect(next.patch).toEqual({
      npi: "1902833742",
      credentials: "DPT",
      taxonomyCode: "2251X0800X",
    });
    expect(next.licenses).toEqual([
      {
        ...savedCo,
        licenseNumber: "PT-4471",
        npiOrigin: { kind: "number", touched: false, pulledAt: PULLED },
      },
      // A37: unverified, no expiration date, marked as the registry's.
      {
        ...EMPTY_LICENSE_DRAFT,
        state: "WY",
        licenseNumber: "WY-0099",
        npiOrigin: { kind: "added", touched: false, pulledAt: PULLED },
      },
    ]);
    expect(next.licenses[1]).toMatchObject({ verifiedStatus: "unverified", expirationDate: "" });
    expect(next.summary.addedRows).toEqual(["WY WY-0099"]);
    expect(next.summary.licenseOffers).toEqual([]);
  });

  it("never gives a verified row a registry number; the license is offered instead", () => {
    const verified = { ...savedCo, verifiedStatus: "verified" as const };
    const next = applyRosterNpiPick(fields, [verified], boulder, "blank_fields", FRESH);
    expect(next.licenses[0]).toEqual(verified);
    expect(next.summary.licenseOffers).toContainEqual({
      state: "CO",
      number: "PT-4471",
      added: false,
    });
    const failed = { ...savedCo, verifiedStatus: "failed" as const };
    expect(
      applyRosterNpiPick(fields, [failed], boulder, "blank_fields", FRESH).licenses[0],
    ).toEqual(failed);
  });

  it("replaces the first pick's untouched data on a second pick, and keeps what staff touched", () => {
    const first = applyRosterNpiPick(fields, [savedCo], denver, "blank_fields", FRESH);
    const afterFirst = { ...fields, ...first.patch };
    // Staff chose the taxonomy after the first pick: theirs now.
    const edited = { ...afterFirst, taxonomyCode: "225200000X" };
    const second = applyRosterNpiPick(edited, first.licenses, boulder, "blank_fields", {
      touched: { credentials: false, taxonomyCode: true },
      lastPick: first.trace,
      pulledAt: PULLED,
    });
    expect(second.patch).toEqual({ npi: "1902833742", credentials: "DPT" });
    expect(second.licenses[0].licenseNumber).toBe("PT-4471");
    expect(second.summary.kept).toEqual([
      { field: "Taxonomy code", registryValue: "2251X0800X (Physical Therapist, Orthopedic)" },
    ]);
  });

  it("takes back a saved row's number the first pick filled when the second has none there", () => {
    const first = applyRosterNpiPick(fields, [savedCo], denver, "blank_fields", FRESH);
    const wyOnly = { ...boulder, taxonomies: boulder.taxonomies?.slice(1) };
    const second = applyRosterNpiPick(
      { ...fields, ...first.patch },
      first.licenses,
      wyOnly,
      "blank_fields",
      { ...FRESH, lastPick: first.trace },
    );
    expect(second.licenses[0]).toEqual({ ...savedCo, npiOrigin: null });
    expect(second.summary.cleared).toContain("CO license number");
  });

  it("keeps a number the first pick filled once staff mark the row Failed, and offers B's", () => {
    const first = applyRosterNpiPick(fields, [savedCo], denver, "blank_fields", FRESH);
    expect(first.licenses[0]).toMatchObject({ licenseNumber: "PT-1111" });
    // Staff mark the license Failed in the editor (a status change, not the
    // number): the row's verification is now recorded.
    const failed = [{ ...first.licenses[0], verifiedStatus: "failed" as const }];
    const second = applyRosterNpiPick(
      { ...fields, ...first.patch },
      failed,
      boulder,
      "blank_fields",
      {
        ...FRESH,
        lastPick: first.trace,
      },
    );
    expect(second.licenses[0]).toEqual({
      ...savedCo,
      licenseNumber: "PT-1111",
      verifiedStatus: "failed",
      npiOrigin: null,
    });
    expect(second.summary.staleRows).toEqual(["CO PT-1111"]);
    expect(second.summary.licenseOffers).toContainEqual({
      state: "CO",
      number: "PT-4471",
      added: false,
    });
  });

  it("roster create: pick A adds its CO row into the empty row, pick B — only B's rows are left", () => {
    const start = [{ ...EMPTY_LICENSE_DRAFT }];
    const first = applyRosterNpiPick(fields, start, denver, "blank_fields", FRESH);
    expect(first.summary.licenseOffers).toEqual([]);
    expect(first.licenses).toEqual([
      {
        ...EMPTY_LICENSE_DRAFT,
        state: "CO",
        licenseNumber: "PT-1111",
        npiOrigin: { kind: "added", touched: false, replacedEmpty: true, pulledAt: PULLED },
      },
    ]);
    const second = applyRosterNpiPick(
      { ...fields, ...first.patch },
      first.licenses,
      boulder,
      "blank_fields",
      { ...FRESH, lastPick: first.trace },
    );
    expect(second.licenses.map((draft) => `${draft.state}/${draft.licenseNumber}`)).toEqual([
      "CO/PT-4471",
      "WY/WY-0099",
    ]);
    expect(second.summary.cleared).toContain("CO license row");
    // With no licenses, B leaves the empty row as it was before A.
    const third = applyRosterNpiPick(
      { ...fields, ...first.patch },
      first.licenses,
      { ...boulder, taxonomies: [] },
      "blank_fields",
      { ...FRESH, lastPick: first.trace },
    );
    expect(third.licenses).toEqual([EMPTY_LICENSE_DRAFT]);
  });

  it("never fills Gender or Phone; offers the sex that maps to one of its options (A36)", () => {
    const next = applyRosterNpiPick(
      { ...fields, gender: "__none__", phone: "" },
      [savedCo],
      jane({ sex: "M" }),
      "blank_fields",
      FRESH,
    );
    expect(next.patch).not.toHaveProperty("gender");
    expect(next.patch).not.toHaveProperty("phone");
    expect(next.summary.candidates).toEqual([
      expect.objectContaining({ field: "gender", value: "male", registryText: "sex: Male" }),
    ]);
  });

  it("sets only the NPI under npi_only", () => {
    const next = applyRosterNpiPick(fields, [savedCo], boulder, "npi_only", FRESH);
    expect(next.patch).toEqual({ npi: "1902833742" });
    expect(next.licenses).toEqual([savedCo]);
  });
});
