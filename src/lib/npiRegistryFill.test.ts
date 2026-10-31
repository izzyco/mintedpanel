// MINT-110 — what picking an NPI Registry match fills: every blank field (an
// untouched default and the previous pick's untouched data count as blank),
// never a value of staff's, a license number only into a row of that state,
// and no license row added — other states are offered. Synthetic data.
import { describe, expect, it } from "vitest";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import {
  formatRegistryAddress,
  markNpiLicenseOfferAdded,
  npiFillAnnouncement,
  planNpiRegistryFill,
  type NpiFillForm,
  type NpiPickTrace,
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

// The other Jane Doe: a different person staff may pick first by mistake.
const denver = record({
  npi: "1234567893",
  middleName: null,
  credential: "PT",
  primaryTaxonomy: { code: "225100000X", description: "Physical Therapist" },
  practiceCity: "DENVER",
  suffix: null,
  taxonomies: [
    {
      code: "225100000X",
      description: "Physical Therapist",
      primary: true,
      license: "PT-1111",
      licenseState: "CO",
    },
  ],
  practiceAddress: null,
  mailingAddress: null,
  identifiers: [],
  otherNames: [],
});

const blankForm = (over: Partial<NpiFillForm> = {}): NpiFillForm => ({
  npi: "",
  credentials: "",
  taxonomyCode: "",
  taxonomyUntouched: false,
  licenses: [],
  licenseRowSaveable: true,
  ...over,
});

// The form after a plan is applied, for a second pick.
function applied(form: NpiFillForm, plan: ReturnType<typeof planNpiRegistryFill>): NpiFillForm {
  return {
    ...form,
    npi: plan.npi,
    credentials: plan.credentials ?? form.credentials,
    taxonomyCode: plan.taxonomyCode ?? form.taxonomyCode,
    licenses: form.licenses.map((row, index) => {
      const change = plan.licenseNumbers.find((item) => item.rowIndex === index);
      return change ? { ...row, number: change.number } : row;
    }),
  };
}

describe("planNpiRegistryFill — blank fields", () => {
  it("fills credentials, the taxonomy and a blank number in a row of that state", () => {
    const plan = planNpiRegistryFill(
      record(),
      blankForm({ licenses: [{ state: "CO", number: "" }] }),
    );
    expect(plan).toMatchObject({
      npi: "1902833742",
      credentials: "DPT",
      taxonomyCode: "2251X0800X",
      licenseNumbers: [{ rowIndex: 0, number: "PT-4471" }],
    });
    expect(plan.summary.filled).toEqual([
      "NPI",
      "Credentials",
      "Taxonomy code",
      "CO license number",
    ]);
    expect(plan.summary.kept).toEqual([]);
    expect(plan.summary.cleared).toEqual([]);
    expect(plan.trace).toEqual({
      credentials: { written: "DPT", previous: "" },
      taxonomyCode: { written: "2251X0800X", previous: "" },
      licenseNumbers: [{ state: "CO", number: "PT-4471" }],
    });
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
    expect(plan.licenseNumbers).toEqual([]);
    expect(plan.summary).toEqual({
      filled: ["NPI", "Credentials", "Taxonomy code"],
      cleared: [],
      kept: [],
      licenseOffers: [],
      details: [],
    });
  });
});

describe("planNpiRegistryFill — an untouched default is blank", () => {
  it("replaces a preset taxonomy nobody chose", () => {
    const plan = planNpiRegistryFill(
      record(),
      blankForm({ taxonomyCode: "225100000X", taxonomyUntouched: true }),
    );
    expect(plan.taxonomyCode).toBe("2251X0800X");
    expect(plan.summary.filled).toContain("Taxonomy code");
    expect(plan.summary.kept).toEqual([]);
    expect(plan.trace.taxonomyCode).toEqual({ written: "2251X0800X", previous: "225100000X" });
  });

  it("keeps the preset when the registry's code is not in the list, and lists the code", () => {
    const plan = planNpiRegistryFill(
      record({
        primaryTaxonomy: { code: "207Q00000X", description: "Family Medicine" },
        taxonomies: [],
      }),
      blankForm({ taxonomyCode: "225100000X", taxonomyUntouched: true }),
    );
    expect(plan.taxonomyCode).toBeNull();
    expect(plan.summary.filled).not.toContain("Taxonomy code");
    expect(plan.summary.kept).toEqual([]);
    expect(plan.summary.details).toContainEqual({
      label: "Other taxonomies",
      lines: ["207Q00000X (Family Medicine) — primary, not in the Taxonomy code list"],
    });
  });

  it("keeps a taxonomy staff chose, even the preset's code", () => {
    const plan = planNpiRegistryFill(
      record(),
      blankForm({ taxonomyCode: "225100000X", taxonomyUntouched: false }),
    );
    expect(plan.taxonomyCode).toBeNull();
    expect(plan.summary.kept).toContainEqual({
      field: "Taxonomy code",
      registryValue: "2251X0800X (Physical Therapist, Orthopedic)",
    });
    const same = planNpiRegistryFill(record(), blankForm({ taxonomyCode: "2251x0800x" }));
    expect(same.summary.kept).toEqual([]);
  });
});

describe("planNpiRegistryFill — never overwrite staff's values", () => {
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
  it("never adds a row: a state the form has no row for is offered", () => {
    const plan = planNpiRegistryFill(
      record(),
      blankForm({ licenses: [{ state: "", number: "" }] }),
    );
    expect(plan.licenseNumbers).toEqual([]);
    expect(plan.summary.filled).toEqual(["NPI", "Credentials", "Taxonomy code"]);
    expect(plan.summary.licenseOffers).toEqual([
      { state: "CO", number: "PT-4471", added: false },
      { state: "WY", number: "WY-0099", added: false },
    ]);
  });

  it("fills a blank number in a row of that state, whatever its case or spacing", () => {
    const plan = planNpiRegistryFill(
      record(),
      blankForm({
        licenses: [
          { state: "WY", number: "" },
          { state: "co", number: "  " },
        ],
      }),
    );
    expect(plan.licenseNumbers).toEqual([
      { rowIndex: 0, number: "WY-0099" },
      { rowIndex: 1, number: "PT-4471" },
    ]);
    expect(plan.summary.filled).toEqual([
      "NPI",
      "Credentials",
      "Taxonomy code",
      "WY license number",
      "CO license number",
    ]);
    expect(plan.summary.kept).toEqual([]);
    expect(plan.summary.licenseOffers).toEqual([]);
  });

  it("never changes a number with a value; a different one is kept and named", () => {
    const plan = planNpiRegistryFill(
      record(),
      blankForm({ licenses: [{ state: "CO", number: "CO-1" }] }),
    );
    expect(plan.licenseNumbers).toEqual([]);
    expect(plan.summary.kept).toEqual([{ field: "CO license", registryValue: "PT-4471" }]);
  });

  it("says nothing about a row that already holds the registry's number", () => {
    const plan = planNpiRegistryFill(
      record(),
      blankForm({ licenses: [{ state: "co", number: "pt 4471" }] }),
    );
    expect(plan.summary.kept).toEqual([]);
    expect(plan.summary.filled).not.toContain("CO license number");
  });

  it("offers a second license in a state whose only row this pick just filled", () => {
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
      blankForm({ licenses: [{ state: "CO", number: "" }] }),
    );
    expect(plan.licenseNumbers).toEqual([{ rowIndex: 0, number: "A-1" }]);
    expect(plan.summary.licenseOffers).toEqual([{ state: "CO", number: "B-2", added: false }]);
    // A state the form's picker does not offer is listed, not offered.
    expect(plan.summary.details).toContainEqual({ label: "Licenses not added", lines: ["ZZ C-3"] });
  });

  it("lists, never offers, when the form could not save a row with only a state and number", () => {
    const plan = planNpiRegistryFill(record(), blankForm({ licenseRowSaveable: false }));
    expect(plan.summary.licenseOffers).toEqual([]);
    expect(plan.summary.details).toContainEqual({
      label: "Licenses not added",
      lines: ["CO PT-4471", "WY WY-0099"],
    });
  });

  it("marks an offer added once staff add it", () => {
    const plan = planNpiRegistryFill(record(), blankForm());
    const pick = { seq: 1, npi: plan.npi, trace: plan.trace, summary: plan.summary };
    const next = markNpiLicenseOfferAdded(pick, { state: "WY", number: "WY-0099" });
    expect(next.summary.licenseOffers).toEqual([
      { state: "CO", number: "PT-4471", added: false },
      { state: "WY", number: "WY-0099", added: true },
    ]);
    expect(pick.summary.licenseOffers[1].added).toBe(false);
  });
});

describe("planNpiRegistryFill — a second pick replaces the first pick's data", () => {
  const start = blankForm({
    taxonomyCode: "225100000X",
    taxonomyUntouched: true,
    licenses: [{ state: "CO", number: "" }],
  });

  it("pick A, then pick B: nothing of A is left and nothing is reported as kept", () => {
    const first = planNpiRegistryFill(denver, start);
    const afterFirst = applied(start, first);
    expect(afterFirst).toMatchObject({
      credentials: "PT",
      taxonomyCode: "225100000X",
      licenses: [{ state: "CO", number: "PT-1111" }],
    });

    const second = planNpiRegistryFill(record(), afterFirst, "blank_fields", first.trace);
    const afterSecond = applied(afterFirst, second);
    expect(afterSecond).toMatchObject({
      npi: "1902833742",
      credentials: "DPT",
      taxonomyCode: "2251X0800X",
      licenses: [{ state: "CO", number: "PT-4471" }],
    });
    expect(second.summary.kept).toEqual([]);
    expect(second.summary.filled).toEqual([
      "NPI",
      "Credentials",
      "Taxonomy code",
      "CO license number",
    ]);
    expect(second.trace.credentials).toEqual({ written: "DPT", previous: "" });
  });

  it("clears what A filled when B has nothing for it, back to what it held before A", () => {
    const first = planNpiRegistryFill(denver, start);
    const afterFirst = applied(start, first);
    const bare = record({ credential: null, taxonomies: [], primaryTaxonomy: null });
    const second = planNpiRegistryFill(bare, afterFirst, "blank_fields", first.trace);
    const afterSecond = applied(afterFirst, second);
    expect(afterSecond).toMatchObject({
      credentials: "",
      taxonomyCode: "225100000X",
      licenses: [{ state: "CO", number: "" }],
    });
    expect(second.summary.cleared).toEqual(["Credentials", "CO license number"]);
    expect(second.trace).toEqual({ credentials: null, taxonomyCode: null, licenseNumbers: [] });
  });

  it("keeps anything staff changed after A", () => {
    const first = planNpiRegistryFill(denver, start);
    const edited: NpiFillForm = {
      ...applied(start, first),
      credentials: "PT, CSCS",
      // Staff chose the taxonomy after the pick.
      taxonomyCode: "225200000X",
      taxonomyUntouched: false,
      licenses: [{ state: "CO", number: "PT-1111-B" }],
    };
    const second = planNpiRegistryFill(record(), edited, "blank_fields", first.trace);
    expect(second.credentials).toBeNull();
    expect(second.taxonomyCode).toBeNull();
    expect(second.licenseNumbers).toEqual([]);
    expect(second.summary.kept).toEqual([
      { field: "Credentials", registryValue: "DPT" },
      { field: "Taxonomy code", registryValue: "2251X0800X (Physical Therapist, Orthopedic)" },
      { field: "CO license", registryValue: "PT-4471" },
    ]);
  });

  it("re-picking the same match changes nothing and keeps owning its data", () => {
    const first = planNpiRegistryFill(denver, start);
    const afterFirst = applied(start, first);
    const again = planNpiRegistryFill(denver, afterFirst, "blank_fields", first.trace);
    expect(again).toMatchObject({ credentials: null, taxonomyCode: null, licenseNumbers: [] });
    expect(again.summary.filled).toEqual([]);
    expect(again.summary.kept).toEqual([]);
    expect(again.trace).toEqual(first.trace);
  });

  it("leaves a row of another state alone, even one holding the old number", () => {
    const trace: NpiPickTrace = {
      credentials: null,
      taxonomyCode: null,
      licenseNumbers: [{ state: "CO", number: "PT-1111" }],
    };
    const plan = planNpiRegistryFill(
      record({ taxonomies: [] }),
      blankForm({ licenses: [{ state: "WY", number: "PT-1111" }] }),
      "blank_fields",
      trace,
    );
    expect(plan.licenseNumbers).toEqual([]);
    expect(plan.summary.cleared).toEqual([]);
  });
});

describe("planNpiRegistryFill — registry data with no form field", () => {
  it("lists it read-only, in a stable order, never the taxonomy the form holds", () => {
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
    // A staff-chosen 225100000X is the form's: not listed again.
    const held = planNpiRegistryFill(record(), blankForm({ taxonomyCode: "225100000X" }));
    expect(held.summary.details.map((detail) => detail.label)).not.toContain("Other taxonomies");
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

describe("planNpiRegistryFill — npi_only", () => {
  it("sets the NPI alone and lists what blank_fields would have filled", () => {
    const plan = planNpiRegistryFill(
      record(),
      blankForm({ licenses: [{ state: "CO", number: "" }] }),
      "npi_only",
    );
    expect(plan).toMatchObject({
      npi: "1902833742",
      credentials: null,
      taxonomyCode: null,
      licenseNumbers: [],
    });
    expect(plan.summary.filled).toEqual(["NPI"]);
    expect(plan.summary.kept).toEqual([]);
    expect(plan.summary.licenseOffers).toEqual([]);
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
      licenses: [{ state: "CO", number: "X" }],
    });
    const plan = planNpiRegistryFill(record(), typed, "npi_only");
    expect(plan.summary.kept).toEqual([]);
    expect(plan.licenseNumbers).toEqual([]);
  });

  it("defaults to blank_fields", () => {
    expect(planNpiRegistryFill(record(), blankForm())).toEqual(
      planNpiRegistryFill(record(), blankForm(), "blank_fields"),
    );
  });
});

describe("npiFillAnnouncement", () => {
  it("says what was filled, cleared and kept, and that licenses can be added", () => {
    const plan = planNpiRegistryFill(
      record(),
      blankForm({ credentials: "PT", licenses: [{ state: "CO", number: "" }] }),
    );
    expect(npiFillAnnouncement(plan.summary)).toBe(
      "Filled from the NPI Registry: NPI, Taxonomy code, CO license number. " +
        "Kept yours: Credentials — registry has DPT. " +
        "The registry lists 1 license for a state with no license row. " +
        "Add them below if they apply.",
    );
  });

  it("says so when there was nothing blank to fill", () => {
    expect(
      npiFillAnnouncement({ filled: [], cleared: [], kept: [], licenseOffers: [], details: [] }),
    ).toBe("Nothing blank to fill from the NPI Registry.");
  });
});
