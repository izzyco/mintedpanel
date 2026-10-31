// MINT-7 — Add Provider's NPI rule: blank stays saveable (incomplete
// onboarding); an entered NPI needs ten digits AND the CMS check digit.
// MINT-110 — what a picked NPI Registry match fills on this form, and the
// NPI Registry policy's refusal at every step that validates the NPI.
import { describe, expect, it } from "vitest";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import {
  NPI_CHECK_DIGIT_MESSAGE,
  NPI_FORMAT_MESSAGE,
  stripNpiSeparators,
} from "@/lib/providerIdentity";
import {
  addNpiLicenseOffer,
  applyNpiRegistryPick,
  emptyLicenseRow,
  emptyProviderFormState,
  isBlankLicenseRow,
  validateAll,
  validateCredentials,
  validateProviderStep,
  type ProviderFormState,
} from "./providerFormShared";

const base = { ...emptyProviderFormState, firstName: "Taylor", lastName: "Provider" };
const ADDED = { kind: "added" as const, touched: false };
const BLOCK = "Your organization saves only NPIs the NPI Registry lists.";

describe("Add Provider NPI validation", () => {
  it("keeps a blank NPI saveable", () => {
    expect(validateAll(base, null)).toEqual({});
  });

  it("rejects a format-valid NPI with a wrong check digit inline", () => {
    expect(validateCredentials({ ...base, npi: "1234567890" }, null).npi).toBe(
      NPI_CHECK_DIGIT_MESSAGE,
    );
    expect(validateAll({ ...base, npi: "1234567890" }, null).npi).toBe(NPI_CHECK_DIGIT_MESSAGE);
  });

  it("takes ten digits with the check digit, whatever the first digit, like the roster form", () => {
    expect(NPI_FORMAT_MESSAGE).toBe("NPI must be 10 digits");
    expect(validateCredentials({ ...base, npi: "123456789" }, null).npi).toBe(NPI_FORMAT_MESSAGE);
    expect(validateCredentials({ ...base, npi: "1234567893" }, null).npi).toBeUndefined();
    // No leading-1 rule: a check-digit-valid NPI starting with 2 is accepted,
    // and the registry, not the form, says whether it is an individual's.
    expect(validateCredentials({ ...base, npi: "2234567891" }, null).npi).toBeUndefined();
    expect(validateCredentials({ ...base, npi: "0234567893" }, null).npi).toBe(
      NPI_CHECK_DIGIT_MESSAGE,
    );
  });
});

// MINT-110 (Sowmya, Oct 31): the NPI input takes the ten digits only. The
// input strips separators as staff type (stripNpiSeparators); a pasted label
// or dots stay in and fail.
describe("Add Provider NPI paste", () => {
  const typed = (value: string) => ({ ...base, npi: stripNpiSeparators(value) });

  it("rejects a pasted label and a dotted NPI", () => {
    for (const value of ["NPI: 1234567893", "123.456.7893"]) {
      expect(validateCredentials(typed(value), null).npi).toBe("NPI must be 10 digits");
    }
  });

  it("accepts a dashed NPI", () => {
    expect(typed("123-456-7893").npi).toBe("1234567893");
    expect(validateCredentials(typed("123-456-7893"), null).npi).toBeUndefined();
  });
});

describe("Add Provider under the NPI Registry policy", () => {
  const valid = { ...base, npi: "1234567893" };

  it("refuses a blocked NPI at Next on the Credentials step and at Create", () => {
    expect(validateProviderStep(2, valid, null)).toEqual({});
    expect(validateProviderStep(2, valid, BLOCK)).toEqual({ npi: BLOCK });
    expect(validateAll(valid, null)).toEqual({});
    expect(validateAll(valid, BLOCK)).toEqual({ npi: BLOCK });
    // The other steps do not validate the NPI.
    expect(validateProviderStep(1, valid, BLOCK)).toEqual({});
    expect(validateProviderStep(3, valid, BLOCK)).toEqual({});
  });

  it("puts the shape and check digit before the policy, and never refuses a blank NPI", () => {
    expect(validateCredentials({ ...base, npi: "1234567890" }, BLOCK).npi).toBe(
      NPI_CHECK_DIGIT_MESSAGE,
    );
    expect(validateAll(base, BLOCK)).toEqual({});
  });
});

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
const FRESH = { touched: { credentials: false, taxonomyCode: false }, lastPick: null };

describe("Add Provider NPI Registry pick", () => {
  it("fills blank credentials, the untouched preset taxonomy and a blank CO number", () => {
    const { form, summary } = applyNpiRegistryPick(withCoRow, boulderJane, "blank_fields", FRESH);
    expect(form).toMatchObject({
      npi: "1902833742",
      credentials: "DPT",
      taxonomyCode: "2251X0800X",
      licenses: [{ state: "CO", number: "PT-4471", type: "", issueDate: "", expirationDate: "" }],
    });
    expect(summary.filled).toEqual(["NPI", "Credentials", "Taxonomy code", "CO license number"]);
    expect(summary.kept).toEqual([]);
    // WY has no row: offered, never added.
    expect(form.licenses).toHaveLength(1);
    expect(summary.licenseOffers).toEqual([{ state: "WY", number: "WY-0099", added: false }]);
    expect(validateAll(form, null)).toEqual({});
  });

  it("keeps a taxonomy staff chose, and typed credentials", () => {
    const typedForm: ProviderFormState = { ...withCoRow, credentials: "PT" };
    const { form, summary } = applyNpiRegistryPick(typedForm, boulderJane, "blank_fields", {
      touched: { credentials: true, taxonomyCode: true },
      lastPick: null,
    });
    expect(form.credentials).toBe("PT");
    expect(form.taxonomyCode).toBe("225100000X");
    expect(summary.kept.map((item) => item.field)).toEqual(["Credentials", "Taxonomy code"]);
    expect(validateAll(form, null)).toEqual({});
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
      licenses: [{ state: "CO", number: "PT-4471" }],
    });
    expect(second.summary.kept).toEqual([]);
  });

  it("pick A, add A's offered license, pick B: the added row goes (the re-review's repro)", () => {
    const first = applyNpiRegistryPick(base, denverJane, "blank_fields", FRESH);
    expect(first.summary.licenseOffers).toEqual([{ state: "CO", number: "PT-1111", added: false }]);
    const added = addNpiLicenseOffer(first.form.licenses, first.summary.licenseOffers[0]);
    const afterAdd = { ...first.form, licenses: added.licenses };
    // It filled the form's empty starting row.
    expect(afterAdd.licenses).toEqual([
      {
        ...emptyLicenseRow(),
        state: "CO",
        number: "PT-1111",
        npiOrigin: { ...ADDED, replacedEmpty: true },
      },
    ]);
    const context = { ...FRESH, lastPick: first.trace };

    // B has a CO license: A's row goes — back to the empty starting row, as
    // before the add — and B's is offered.
    const second = applyNpiRegistryPick(afterAdd, boulderJane, "blank_fields", context);
    expect(second.form.licenses).toEqual([emptyLicenseRow()]);
    expect(second.summary.cleared).toContain("CO license row");
    expect(second.summary.licenseOffers).toContainEqual({
      state: "CO",
      number: "PT-4471",
      added: false,
    });

    // B has no CO license: A's row still goes.
    const wyOnly = { ...boulderJane, taxonomies: boulderJane.taxonomies?.slice(1) };
    const third = applyNpiRegistryPick(afterAdd, wyOnly, "blank_fields", context);
    expect(third.form.licenses).toEqual([emptyLicenseRow()]);
    expect(third.summary.cleared).toContain("CO license row");
  });

  it("keeps a row staff edited after adding it, and says it came from the previous pick", () => {
    const first = applyNpiRegistryPick(base, denverJane, "blank_fields", FRESH);
    const added = addNpiLicenseOffer(first.form.licenses, first.summary.licenseOffers[0]);
    const edited = {
      ...first.form,
      licenses: added.licenses.map((row) => ({
        ...row,
        expirationDate: "2027-01-31",
        npiOrigin: { kind: "added" as const, touched: true },
      })),
    };
    const second = applyNpiRegistryPick(edited, boulderJane, "blank_fields", {
      ...FRESH,
      lastPick: first.trace,
    });
    expect(second.form.licenses).toHaveLength(1);
    expect(second.form.licenses[0]).toMatchObject({ number: "PT-1111", npiOrigin: null });
    expect(second.summary.staleRows).toEqual(["CO PT-1111"]);
  });

  it("keeps credentials staff retyped, even when they equal what the pick wrote", () => {
    const first = applyNpiRegistryPick(withCoRow, denverJane, "blank_fields", FRESH);
    const second = applyNpiRegistryPick(first.form, boulderJane, "blank_fields", {
      touched: { credentials: true, taxonomyCode: false },
      lastPick: first.trace,
    });
    expect(second.form.credentials).toBe("PT");
    expect(second.summary.kept).toContainEqual({ field: "Credentials", registryValue: "DPT" });
  });

  it("fills a blank number in a CO row that has a state only (the first review's second repro)", () => {
    const { form, summary } = applyNpiRegistryPick(withCoRow, boulderJane, "blank_fields", FRESH);
    expect(form.licenses.map((row) => `${row.state}/${row.number}`)).toEqual(["CO/PT-4471"]);
    expect(summary.kept).toEqual([]);
    expect(summary.filled).toContain("CO license number");
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
    expect(addNpiLicenseOffer(empty, { state: "WY", number: "WY-0099" })).toEqual({
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
    expect(addNpiLicenseOffer(typed, { state: "WY", number: "WY-0099" }).licenses).toEqual([
      typed[0],
      { ...emptyLicenseRow(), state: "WY", number: "WY-0099", npiOrigin: ADDED },
    ]);
  });

  it("adds nothing when a row already holds that license, and names the row", () => {
    const rows = [emptyLicenseRow(), { ...emptyLicenseRow(), state: "CO", number: "PT-1111" }];
    const next = addNpiLicenseOffer(rows, { state: "co", number: "pt 1111" });
    expect(next).toEqual({ licenses: rows, existing: 1 });
  });

  it("treats a row with only a license type chosen as data", () => {
    expect(isBlankLicenseRow(emptyLicenseRow())).toBe(true);
    expect(isBlankLicenseRow({ ...emptyLicenseRow(), type: "compact" })).toBe(false);
  });
});
