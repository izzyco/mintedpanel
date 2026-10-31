// MINT-110 — what picking an NPI Registry match fills: blank fields only, a
// form default counts as a value, saved license rows are never altered, and
// everything else the registry lists is shown, never saved. Synthetic data.
import { describe, expect, it } from "vitest";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import {
  formatRegistryAddress,
  npiFillAnnouncement,
  planNpiRegistryFill,
  type NpiFillForm,
} from "@/lib/npiRegistryFill";

const record = (over: Partial<NpiRegistryRecord> = {}): NpiRegistryRecord => ({
  npi: "1902833742",
  enumerationType: "NPI-1",
  firstName: "JANE",
  middleName: "M",
  lastName: "DOE",
  organizationName: null,
  credential: "DPT",
  primaryTaxonomy: { code: "2251X0800X", description: "Physical Therapist, Orthopedic" },
  practiceCity: "BOULDER",
  practiceState: "CO",
  status: "active",
  enumerationDate: "2015-03-02",
  otherNames: [{ firstName: "JANE", lastName: "SMITH", middleName: null, type: "Former Name" }],
  suffix: "JR",
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
  practiceAddress: {
    line1: "200 CLINIC WAY",
    line2: "SUITE 4",
    city: "BOULDER",
    state: "CO",
    postalCode: "803021234",
    countryCode: "US",
    phone: "303-555-0199",
  },
  mailingAddress: {
    line1: "PO BOX 12",
    line2: null,
    city: "BOULDER",
    state: "CO",
    postalCode: "80306",
    countryCode: "US",
    phone: null,
  },
  otherPracticeAddresses: [],
  identifiers: [{ identifier: "CO-MCD-77", type: "MEDICAID", state: "CO", issuer: null }],
  ...over,
});

const blankForm = (over: Partial<NpiFillForm> = {}): NpiFillForm => ({
  npi: "",
  credentials: "",
  taxonomyCode: "",
  licenses: [{ state: "", number: "", blank: true }],
  licenseRowSaveable: true,
  ...over,
});

describe("planNpiRegistryFill — blank fields", () => {
  it("fills every blank field the registry supplies, the first license into the blank row", () => {
    const plan = planNpiRegistryFill(record(), blankForm());
    expect(plan).toMatchObject({
      npi: "1902833742",
      credentials: "DPT",
      taxonomyCode: "2251X0800X",
      licenses: [
        { state: "CO", number: "PT-4471", rowIndex: 0 },
        { state: "WY", number: "WY-0099", rowIndex: null },
      ],
    });
    expect(plan.summary.filled).toEqual([
      "NPI",
      "Credentials",
      "Taxonomy code",
      "CO license",
      "WY license",
    ]);
    expect(plan.summary.kept).toEqual([]);
  });

  it("treats whitespace as blank", () => {
    const plan = planNpiRegistryFill(record(), blankForm({ credentials: "  ", taxonomyCode: " " }));
    expect(plan.credentials).toBe("DPT");
    expect(plan.taxonomyCode).toBe("2251X0800X");
  });

  it("does not list the NPI when the form already holds it, separators and all", () => {
    const plan = planNpiRegistryFill(record(), blankForm({ npi: "190-283-3742" }));
    expect(plan.summary.filled[0]).toBe("Credentials");
  });

  it("works on a record with none of the fill fields", () => {
    const bare = record({
      suffix: undefined,
      taxonomies: undefined,
      practiceAddress: undefined,
      mailingAddress: undefined,
      otherPracticeAddresses: undefined,
      identifiers: undefined,
      middleName: null,
      otherNames: [],
    });
    const plan = planNpiRegistryFill(bare, blankForm());
    expect(plan.licenses).toEqual([]);
    expect(plan.summary).toEqual({
      filled: ["NPI", "Credentials", "Taxonomy code"],
      kept: [],
      details: [],
    });
  });
});

describe("planNpiRegistryFill — never overwrite", () => {
  it("keeps typed credentials and says what the registry has", () => {
    const plan = planNpiRegistryFill(record(), blankForm({ credentials: "PT" }));
    expect(plan.credentials).toBeNull();
    expect(plan.summary.kept).toContainEqual({ field: "Credentials", registryValue: "DPT" });
  });

  it("says nothing when typed credentials match apart from case and punctuation", () => {
    const plan = planNpiRegistryFill(
      record({ credential: "P.T., D.P.T." }),
      blankForm({ credentials: "pt, dpt" }),
    );
    expect(plan.credentials).toBeNull();
    expect(plan.summary.kept).toEqual([]);
  });

  it("counts a form's default taxonomy as filled", () => {
    const plan = planNpiRegistryFill(record(), blankForm({ taxonomyCode: "225100000X" }));
    expect(plan.taxonomyCode).toBeNull();
    expect(plan.summary.filled).not.toContain("Taxonomy code");
    expect(plan.summary.kept).toContainEqual({
      field: "Taxonomy code",
      registryValue: "2251X0800X (Physical Therapist, Orthopedic)",
    });
    const same = planNpiRegistryFill(record(), blankForm({ taxonomyCode: "2251x0800x" }));
    expect(same.summary.kept).toEqual([]);
  });

  it("never fills a taxonomy the form's list does not offer; it is listed instead", () => {
    const plan = planNpiRegistryFill(
      record({
        primaryTaxonomy: { code: "207Q00000X", description: "Family Medicine" },
        taxonomies: [],
      }),
      blankForm(),
    );
    expect(plan.taxonomyCode).toBeNull();
    expect(plan.summary.details).toContainEqual({
      label: "Other taxonomies",
      lines: ["207Q00000X (Family Medicine) — primary, not in the Taxonomy code list"],
    });
  });
});

describe("planNpiRegistryFill — license rows", () => {
  it("adds a row for a state the form does not have when no blank row is left", () => {
    const plan = planNpiRegistryFill(record(), blankForm({ licenses: [] }));
    expect(plan.licenses).toEqual([
      { state: "CO", number: "PT-4471", rowIndex: null },
      { state: "WY", number: "WY-0099", rowIndex: null },
    ]);
  });

  it("never alters a row with data in that state, even one missing its number", () => {
    const plan = planNpiRegistryFill(
      record(),
      blankForm({ licenses: [{ state: "CO", number: "", blank: false }] }),
    );
    expect(plan.licenses).toEqual([{ state: "WY", number: "WY-0099", rowIndex: null }]);
    expect(plan.summary.kept).toEqual([{ field: "CO license", registryValue: "PT-4471" }]);
  });

  it("says nothing about a row that already holds the registry's number", () => {
    const plan = planNpiRegistryFill(
      record(),
      blankForm({ licenses: [{ state: "co", number: "pt 4471", blank: false }] }),
    );
    expect(plan.summary.kept).toEqual([]);
    expect(plan.summary.filled).not.toContain("CO license");
  });

  it("fills only blank rows; a row with data but no state is left alone", () => {
    const plan = planNpiRegistryFill(
      record(),
      blankForm({
        licenses: [
          { state: "", number: "TYPED-1", blank: false },
          { state: "", number: "", blank: true },
        ],
      }),
    );
    expect(plan.licenses).toEqual([
      { state: "CO", number: "PT-4471", rowIndex: 1 },
      { state: "WY", number: "WY-0099", rowIndex: null },
    ]);
  });

  it("adds nothing when the form could not save a row with only a state and number", () => {
    const plan = planNpiRegistryFill(record(), blankForm({ licenseRowSaveable: false }));
    expect(plan.licenses).toEqual([]);
    expect(plan.summary.filled).not.toContain("CO license");
    expect(plan.summary.details).toContainEqual({
      label: "Licenses not added",
      lines: ["CO PT-4471", "WY WY-0099"],
    });
  });

  it("lists a second license in a state it filled, and a state outside the list", () => {
    const plan = planNpiRegistryFill(
      record({
        taxonomies: [
          {
            code: "225100000X",
            description: null,
            primary: true,
            license: "A-1",
            licenseState: "CO",
          },
          {
            code: "225X00000X",
            description: null,
            primary: false,
            license: "B-2",
            licenseState: "CO",
          },
          {
            code: "225X00000X",
            description: null,
            primary: false,
            license: "C-3",
            licenseState: "ZZ",
          },
          {
            code: "225X00000X",
            description: null,
            primary: false,
            license: null,
            licenseState: "WY",
          },
        ],
      }),
      blankForm(),
    );
    expect(plan.licenses).toEqual([{ state: "CO", number: "A-1", rowIndex: 0 }]);
    expect(plan.summary.details).toContainEqual({
      label: "Licenses not added",
      lines: ["CO B-2", "ZZ C-3"],
    });
  });
});

describe("planNpiRegistryFill — registry data with no form field", () => {
  it("lists it read-only, in a stable order", () => {
    const plan = planNpiRegistryFill(record(), blankForm());
    expect(plan.summary.details).toEqual([
      { label: "Middle name", lines: ["M"] },
      { label: "Suffix", lines: ["JR"] },
      { label: "Other taxonomies", lines: ["225100000X (Physical Therapist)"] },
      {
        label: "Practice address",
        lines: ["200 CLINIC WAY, SUITE 4, BOULDER, CO 80302-1234 · 303-555-0199"],
      },
      { label: "Mailing address", lines: ["PO BOX 12, BOULDER, CO 80306"] },
      { label: "Other names", lines: ["JANE SMITH (Former Name)"] },
      { label: "Other identifiers", lines: ["MEDICAID CO-MCD-77 (CO)"] },
    ]);
  });

  it("names a foreign country and skips empty address parts", () => {
    expect(
      formatRegistryAddress({
        line1: "1 RUE X",
        line2: null,
        city: "PARIS",
        state: null,
        postalCode: "75001",
        countryCode: "FR",
        phone: null,
      }),
    ).toBe("1 RUE X, PARIS, 75001, FR");
  });
});

describe("npiFillAnnouncement", () => {
  it("says what was filled, what was kept, and that more is listed", () => {
    const plan = planNpiRegistryFill(record(), blankForm({ taxonomyCode: "225100000X" }));
    expect(npiFillAnnouncement(plan.summary)).toBe(
      "Filled from the NPI Registry: NPI, Credentials, CO license, WY license. " +
        "Kept yours: Taxonomy code — registry has 2251X0800X (Physical Therapist, Orthopedic). " +
        "More registry details are listed below.",
    );
  });

  it("says so when there was nothing blank to fill", () => {
    expect(npiFillAnnouncement({ filled: [], kept: [], details: [] })).toBe(
      "Nothing blank to fill from the NPI Registry.",
    );
  });
});

describe("planNpiRegistryFill — npi_only", () => {
  it("sets the NPI alone and lists what blank_fields would have filled", () => {
    const plan = planNpiRegistryFill(record(), blankForm(), "npi_only");
    expect(plan).toMatchObject({ npi: "1902833742", credentials: null, taxonomyCode: null });
    expect(plan.licenses).toEqual([]);
    expect(plan.summary.filled).toEqual(["NPI"]);
    expect(plan.summary.kept).toEqual([]);
    expect(plan.summary.details.map((detail) => detail.label)).toEqual([
      "Credentials",
      "Primary taxonomy",
      "Licenses",
      "Middle name",
      "Suffix",
      "Other taxonomies",
      "Practice address",
      "Mailing address",
      "Other names",
      "Other identifiers",
    ]);
    expect(plan.summary.details[2]).toEqual({
      label: "Licenses",
      lines: ["CO PT-4471", "WY WY-0099"],
    });
  });

  it("is the same whatever the form already holds", () => {
    const typed = blankForm({
      credentials: "PT",
      taxonomyCode: "225100000X",
      licenses: [{ state: "CO", number: "X", blank: false }],
    });
    const plan = planNpiRegistryFill(record(), typed, "npi_only");
    expect(plan.summary.kept).toEqual([]);
    expect(plan.licenses).toEqual([]);
  });

  it("defaults to blank_fields", () => {
    expect(planNpiRegistryFill(record(), blankForm())).toEqual(
      planNpiRegistryFill(record(), blankForm(), "blank_fields"),
    );
  });
});
