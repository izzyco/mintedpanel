// MINT-110 — what a picked NPI Registry match fills on Add Provider, what a
// license staff add from a pick looks like, and how the filled values carry
// their pull date ("From NPI Registry, <date>" until confirmed, A35).
import { describe, expect, it } from "vitest";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import {
  emptyLicenseRow,
  emptyProviderFormState,
  validateAll,
  type ProviderFormState,
} from "./providerFormShared";
import { addNpiLicenseOffer, applyNpiRegistryPick, isUntouchedLicenseRow } from "./providerNpiPick";
import { npiPickWithCandidate } from "@/lib/npiRegistryFill";

const base = { ...emptyProviderFormState, firstName: "Taylor", lastName: "Provider" };
const PULLED = "2026-10-31T15:00:00.000Z";
const ADDED = { kind: "added" as const, touched: false, pulledAt: PULLED };

const record = (over: Partial<NpiRegistryRecord>): NpiRegistryRecord => ({
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
  ...over,
});

// The reviewer's pair: two Jane Does; staff pick Denver first by mistake.
const denverJane = record({
  taxonomies: [
    {
      code: "225100000X",
      description: null,
      primary: true,
      license: "PT-1111",
      licenseState: "CO",
    },
  ],
});
const boulderJane = record({
  npi: "1902833742",
  middleName: "M",
  credential: "DPT",
  practiceCity: "BOULDER",
  primaryTaxonomy: { code: "2251X0800X", description: "Physical Therapist, Orthopedic" },
  taxonomies: [
    {
      code: "2251X0800X",
      description: "Physical Therapist, Orthopedic",
      primary: true,
      license: "PT-4471",
      licenseState: "CO",
    },
    {
      code: "225100000X",
      description: "Physical Therapist",
      primary: false,
      license: "WY-0099",
      licenseState: "WY",
    },
  ],
});

const withCoRow: ProviderFormState = {
  ...base,
  licenses: [{ ...emptyLicenseRow(), state: "CO" }],
};
const FRESH = {
  touched: { credentials: false, taxonomyCode: false },
  lastPick: null,
  taxonomyPreset: "225100000X",
  pulledAt: PULLED,
};

describe("Add Provider NPI Registry pick", () => {
  it("fills blank credentials, the untouched preset taxonomy and a blank CO number", () => {
    const { form, summary } = applyNpiRegistryPick(withCoRow, boulderJane, "blank_fields", FRESH);
    expect(form).toMatchObject({
      npi: "1902833742",
      credentials: "DPT",
      taxonomyCode: "2251X0800X",
      licenses: [
        { state: "CO", number: "PT-4471", type: "", issueDate: "", expirationDate: "" },
        { state: "WY", number: "WY-0099" },
      ],
    });
    // The filled number says where it came from, and when (A35).
    expect(form.licenses[0].npiOrigin).toEqual({
      kind: "number",
      touched: false,
      pulledAt: PULLED,
    });
    expect(summary.filled).toEqual(["NPI", "Credentials", "Taxonomy code", "CO license number"]);
    expect(summary.kept).toEqual([]);
    // A37: WY has no row, so the pick adds one: no type, no dates, marked as
    // the registry's.
    expect(form.licenses[1]).toEqual({
      ...emptyLicenseRow(),
      state: "WY",
      number: "WY-0099",
      npiOrigin: ADDED,
    });
    expect(summary.addedRows).toEqual(["WY WY-0099"]);
    expect(summary.licenseOffers).toEqual([]);
    // A blank expiration date never blocks the save.
    expect(validateAll(form)).toEqual({});
  });

  it("keeps a taxonomy staff chose, and typed credentials", () => {
    const typedForm: ProviderFormState = { ...withCoRow, credentials: "PT" };
    const { form, summary } = applyNpiRegistryPick(typedForm, boulderJane, "blank_fields", {
      ...FRESH,
      touched: { credentials: true, taxonomyCode: true },
    });
    expect(form.credentials).toBe("PT");
    expect(form.taxonomyCode).toBe("225100000X");
    expect(summary.kept.map((item) => item.field)).toEqual(["Credentials", "Taxonomy code"]);
    expect(validateAll(form)).toEqual({});
  });

  it("fills a taxonomy staff cleared", () => {
    const { form } = applyNpiRegistryPick(
      { ...base, taxonomyCode: "" },
      boulderJane,
      "blank_fields",
      FRESH,
    );
    expect(form.taxonomyCode).toBe("2251X0800X");
  });

  it("pick A, then pick B, leaves nothing of A (the first review's repro)", () => {
    const first = applyNpiRegistryPick(withCoRow, denverJane, "blank_fields", FRESH);
    expect(first.form).toMatchObject({
      credentials: "PT",
      licenses: [{ state: "CO", number: "PT-1111" }],
    });
    const second = applyNpiRegistryPick(first.form, boulderJane, "blank_fields", {
      ...FRESH,
      lastPick: first.trace,
    });
    expect(second.form).toMatchObject({
      npi: "1902833742",
      credentials: "DPT",
      taxonomyCode: "2251X0800X",
      licenses: [
        { state: "CO", number: "PT-4471" },
        { state: "WY", number: "WY-0099" },
      ],
    });
    expect(second.summary.kept).toEqual([]);
  });

  it("pick A adds A's CO row, pick B: only B's rows are left (A37, the re-review's repro)", () => {
    const first = applyNpiRegistryPick(base, denverJane, "blank_fields", FRESH);
    // No CO row: the pick adds it, into the form's empty starting row.
    expect(first.summary.addedRows).toEqual(["CO PT-1111"]);
    expect(first.summary.licenseOffers).toEqual([]);
    expect(first.form.licenses).toEqual([
      {
        ...emptyLicenseRow(),
        state: "CO",
        number: "PT-1111",
        npiOrigin: { ...ADDED, replacedEmpty: true },
      },
    ]);
    const context = { ...FRESH, lastPick: first.trace };

    // B has a CO and a WY license: A's untouched row goes and B's are added,
    // the first into the empty starting row again.
    const second = applyNpiRegistryPick(first.form, boulderJane, "blank_fields", context);
    expect(second.form.licenses).toEqual([
      {
        ...emptyLicenseRow(),
        state: "CO",
        number: "PT-4471",
        npiOrigin: { ...ADDED, replacedEmpty: true },
      },
      { ...emptyLicenseRow(), state: "WY", number: "WY-0099", npiOrigin: ADDED },
    ]);
    expect(second.summary.cleared).toContain("CO license row");
    expect(second.summary.addedRows).toEqual(["CO PT-4471", "WY WY-0099"]);

    // B has no CO license: A's row still goes, back to the empty row.
    const noLicenses = { ...boulderJane, taxonomies: [] };
    const third = applyNpiRegistryPick(first.form, noLicenses, "blank_fields", context);
    expect(third.form.licenses).toEqual([emptyLicenseRow()]);
    expect(third.summary.cleared).toContain("CO license row");
  });

  it("offers, never adds, a second number in a state that has a row", () => {
    const twoInCo = record({
      taxonomies: [
        {
          code: "225100000X",
          description: null,
          primary: true,
          license: "A-1",
          licenseState: "CO",
        },
        {
          code: "225100000X",
          description: null,
          primary: false,
          license: "B-2",
          licenseState: "CO",
        },
      ],
    });
    const { form, summary } = applyNpiRegistryPick(base, twoInCo, "blank_fields", FRESH);
    expect(form.licenses.map((row) => `${row.state}/${row.number}`)).toEqual(["CO/A-1"]);
    expect(summary.licenseOffers).toEqual([{ state: "CO", number: "B-2", added: false }]);
  });

  it("keeps a row staff edited after a pick added it, and says it came from the previous pick", () => {
    const first = applyNpiRegistryPick(base, denverJane, "blank_fields", FRESH);
    const edited = {
      ...first.form,
      licenses: first.form.licenses.map((row) => ({
        ...row,
        expirationDate: "2027-01-31",
        npiOrigin: { kind: "added" as const, touched: true },
      })),
    };
    const second = applyNpiRegistryPick(edited, boulderJane, "blank_fields", {
      ...FRESH,
      lastPick: first.trace,
    });
    // The edited row is staff's: kept, and B's CO number is named beside it;
    // B's WY license is added.
    expect(second.form.licenses.map((row) => `${row.state}/${row.number}`)).toEqual([
      "CO/PT-1111",
      "WY/WY-0099",
    ]);
    expect(second.form.licenses[0]).toMatchObject({ number: "PT-1111", npiOrigin: null });
    expect(second.summary.staleRows).toEqual(["CO PT-1111"]);
    expect(second.summary.kept).toContainEqual({ field: "CO license", registryValue: "PT-4471" });
  });

  it("keeps credentials staff retyped, even when they equal what the pick wrote", () => {
    const first = applyNpiRegistryPick(withCoRow, denverJane, "blank_fields", FRESH);
    const second = applyNpiRegistryPick(first.form, boulderJane, "blank_fields", {
      ...FRESH,
      touched: { credentials: true, taxonomyCode: false },
      lastPick: first.trace,
    });
    expect(second.form.credentials).toBe("PT");
    expect(second.summary.kept).toContainEqual({ field: "Credentials", registryValue: "DPT" });
  });

  it("fills a blank number in a CO row that has a state only (the first review's second repro)", () => {
    const { form, summary } = applyNpiRegistryPick(withCoRow, boulderJane, "blank_fields", FRESH);
    expect(form.licenses.map((row) => `${row.state}/${row.number}`)).toEqual([
      "CO/PT-4471",
      "WY/WY-0099",
    ]);
    expect(summary.kept).toEqual([]);
    expect(summary.filled).toContain("CO license number");
  });

  it("never fills Gender or Phone; offers the registry's sex and practice phone (A36)", () => {
    const withPractice = record({
      sex: "F",
      practiceAddress: {
        line1: "200 CLINIC WAY",
        line2: null,
        city: "DENVER",
        state: "CO",
        postalCode: "80202",
        countryCode: "US",
        phone: "303-555-0199",
      },
    });
    const { form, summary } = applyNpiRegistryPick(base, withPractice, "blank_fields", FRESH);
    expect(form.gender).toBe("");
    expect(form.phone).toBe("");
    expect(summary.candidates.map(({ field, value }) => ({ field, value }))).toEqual([
      { field: "gender", value: "female" },
      { field: "phone", value: "303-555-0199" },
    ]);
    // A typed phone stays; the registry's is only offered.
    const typed = applyNpiRegistryPick(
      { ...base, gender: "female", phone: "252-555-0142" },
      withPractice,
      "blank_fields",
      FRESH,
    );
    expect(typed.form).toMatchObject({ gender: "female", phone: "252-555-0142" });
    expect(typed.summary.candidates.map((candidate) => candidate.field)).toEqual(["phone"]);
  });

  it("pick A, use A's sex and phone, pick B who lists neither: both go back (review P2)", () => {
    const wrongJane = record({
      sex: "F",
      practiceAddress: {
        line1: "1 MAIN ST",
        line2: null,
        city: "DENVER",
        state: "CO",
        postalCode: "80202",
        countryCode: "US",
        phone: "303-555-0199",
      },
    });
    const first = applyNpiRegistryPick(base, wrongJane, "blank_fields", FRESH);
    const pickA = {
      seq: 1,
      npi: wrongJane.npi,
      trace: first.trace,
      summary: first.summary,
      pulledAt: PULLED,
    };
    // Staff use both candidates (what the form's Use buttons do).
    const used = npiPickWithCandidate(
      npiPickWithCandidate(pickA, { field: "gender", value: "female" }, ""),
      { field: "phone", value: "303-555-0199" },
      "",
    );
    const afterUse = { ...first.form, gender: "female", phone: "303-555-0199" };
    const second = applyNpiRegistryPick(afterUse, boulderJane, "blank_fields", {
      ...FRESH,
      touched: { credentials: false, taxonomyCode: false, gender: false, phone: false },
      lastPick: used.trace,
    });
    expect(second.form).toMatchObject({ gender: "", phone: "" });
    expect(second.summary.cleared).toEqual(expect.arrayContaining(["Gender", "Phone"]));
  });

  it("sets only the NPI under npi_only", () => {
    const { form, summary } = applyNpiRegistryPick(withCoRow, boulderJane, "npi_only", FRESH);
    expect(form).toEqual({ ...withCoRow, npi: "1902833742" });
    expect(summary.filled).toEqual(["NPI"]);
    expect(summary.kept).toEqual([]);
    expect(summary.details.slice(0, 3)).toEqual([
      { label: "Credentials", lines: ["DPT"] },
      { label: "Primary taxonomy", lines: ["2251X0800X (Physical Therapist, Orthopedic)"] },
      { label: "Licenses", lines: ["CO PT-4471", "WY WY-0099"] },
    ]);
  });
});

describe("Add Provider licenses staff add from a pick", () => {
  it("fills the untouched empty row, else adds one; never touches a row with data", () => {
    const empty = [emptyLicenseRow()];
    expect(addNpiLicenseOffer(empty, { state: "WY", number: "WY-0099" }, PULLED)).toEqual({
      licenses: [
        {
          ...emptyLicenseRow(),
          state: "WY",
          number: "WY-0099",
          npiOrigin: { ...ADDED, replacedEmpty: true },
        },
      ],
      existing: null,
    });
    const typed = [{ ...emptyLicenseRow(), type: "compact" as const }];
    expect(addNpiLicenseOffer(typed, { state: "WY", number: "WY-0099" }, PULLED).licenses).toEqual([
      typed[0],
      { ...emptyLicenseRow(), state: "WY", number: "WY-0099", npiOrigin: ADDED },
    ]);
  });

  it("adds nothing when a row already holds that license, and names the row", () => {
    const rows = [emptyLicenseRow(), { ...emptyLicenseRow(), state: "CO", number: "PT-1111" }];
    const next = addNpiLicenseOffer(rows, { state: "co", number: "pt 1111" }, PULLED);
    expect(next).toEqual({ licenses: rows, existing: 1 });
  });

  it("treats a row with only a license type chosen as data", () => {
    expect(isUntouchedLicenseRow(emptyLicenseRow())).toBe(true);
    expect(isUntouchedLicenseRow({ ...emptyLicenseRow(), type: "compact" })).toBe(false);
  });
});

describe("Add Provider's preset taxonomy and a pick (A32)", () => {
  it("replaces the group's untouched preset, whatever the preset is", () => {
    const ot = { ...withCoRow, taxonomyCode: "225X00000X" };
    const { form } = applyNpiRegistryPick(ot, boulderJane, "blank_fields", {
      ...FRESH,
      taxonomyPreset: "225X00000X",
    });
    expect(form.taxonomyCode).toBe("2251X0800X");
  });

  it("keeps a taxonomy that is not the preset, even untouched (it came from somewhere else)", () => {
    const ot = { ...withCoRow, taxonomyCode: "225X00000X" };
    const { form, summary } = applyNpiRegistryPick(ot, boulderJane, "blank_fields", FRESH);
    expect(form.taxonomyCode).toBe("225X00000X");
    expect(summary.kept.map((item) => item.field)).toContain("Taxonomy code");
  });
});

describe("pull dates on rows (A35)", () => {
  it("a second pick's new number takes the second pull's date", () => {
    const first = applyNpiRegistryPick(withCoRow, denverJane, "blank_fields", FRESH);
    const later = "2026-11-01T09:00:00.000Z";
    const second = applyNpiRegistryPick(first.form, boulderJane, "blank_fields", {
      ...FRESH,
      lastPick: first.trace,
      pulledAt: later,
    });
    expect(second.form.licenses[0]).toMatchObject({
      number: "PT-4471",
      npiOrigin: { kind: "number", touched: false, pulledAt: later },
    });
  });
});
