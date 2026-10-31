// MINT-7 — Add Provider's NPI rule: blank stays saveable (incomplete
// onboarding); an entered NPI needs the shape AND the CMS check digit.
// MINT-110 — what a picked NPI Registry match fills on this form.
import { describe, expect, it } from "vitest";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import { NPI_CHECK_DIGIT_MESSAGE, stripNpiSeparators } from "@/lib/providerIdentity";
import {
  applyNpiRegistryPick,
  emptyProviderFormState,
  isBlankLicenseRow,
  validateAll,
  validateCredentials,
  type ProviderFormState,
} from "./providerFormShared";

const base = { ...emptyProviderFormState, firstName: "Taylor", lastName: "Provider" };

describe("Add Provider NPI validation", () => {
  it("keeps a blank NPI saveable", () => {
    expect(validateAll(base)).toEqual({});
  });

  it("rejects a format-valid NPI with a wrong check digit inline", () => {
    expect(validateCredentials({ ...base, npi: "1234567890" }).npi).toBe(NPI_CHECK_DIGIT_MESSAGE);
    expect(validateAll({ ...base, npi: "1234567890" }).npi).toBe(NPI_CHECK_DIGIT_MESSAGE);
  });

  it("keeps the shape message for a malformed NPI and accepts a valid one", () => {
    expect(validateCredentials({ ...base, npi: "0234567893" }).npi).toBe(
      "NPI must be 10 digits and start with 1",
    );
    expect(validateCredentials({ ...base, npi: "1234567893" }).npi).toBeUndefined();
  });
});

// MINT-110 (Sowmya, Oct 31): the NPI input takes the ten digits only. The
// input strips separators as staff type (stripNpiSeparators); a pasted label
// or dots stay in and fail.
describe("Add Provider NPI paste", () => {
  const typed = (value: string) => ({ ...base, npi: stripNpiSeparators(value) });

  it("rejects a pasted label and a dotted NPI", () => {
    for (const value of ["NPI: 1234567893", "123.456.7893"]) {
      expect(validateCredentials(typed(value)).npi).toBe("NPI must be 10 digits and start with 1");
    }
  });

  it("accepts a dashed NPI", () => {
    expect(typed("123-456-7893").npi).toBe("1234567893");
    expect(validateCredentials(typed("123-456-7893")).npi).toBeUndefined();
  });
});

const boulderJane: NpiRegistryRecord = {
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
  otherNames: [],
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
};

describe("Add Provider NPI Registry pick", () => {
  it("fills blank credentials and the blank license row, and keeps the default taxonomy", () => {
    const { form, summary } = applyNpiRegistryPick(base, boulderJane);
    expect(form).toMatchObject({
      npi: "1902833742",
      credentials: "DPT",
      taxonomyCode: "225100000X",
      licenses: [
        { state: "CO", number: "PT-4471", type: "", issueDate: "", expirationDate: "" },
        { state: "WY", number: "WY-0099", type: "", issueDate: "", expirationDate: "" },
      ],
    });
    expect(summary.filled).toEqual(["NPI", "Credentials", "CO license", "WY license"]);
    expect(summary.kept).toEqual([
      {
        field: "Taxonomy code",
        registryValue: "2251X0800X (Physical Therapist, Orthopedic)",
      },
    ]);
  });

  it("never replaces what staff typed, and a valid form stays valid", () => {
    const typedForm: ProviderFormState = {
      ...base,
      credentials: "PT",
      licenses: [{ state: "CO", number: "", type: "full", issueDate: "", expirationDate: "" }],
    };
    expect(validateAll(typedForm)).toEqual({});
    const { form, summary } = applyNpiRegistryPick(typedForm, boulderJane);
    expect(form.credentials).toBe("PT");
    expect(form.licenses[0]).toEqual(typedForm.licenses[0]);
    expect(form.licenses).toHaveLength(2);
    expect(summary.kept.map((item) => item.field)).toEqual([
      "Credentials",
      "Taxonomy code",
      "CO license",
    ]);
    expect(validateAll(form)).toEqual({});
  });

  it("fills a taxonomy only when staff cleared it", () => {
    const { form } = applyNpiRegistryPick({ ...base, taxonomyCode: "" }, boulderJane);
    expect(form.taxonomyCode).toBe("2251X0800X");
    expect(validateAll(form)).toEqual({});
  });

  it("treats a row with only a license type chosen as data", () => {
    expect(
      isBlankLicenseRow({ state: "", number: "", type: "", issueDate: "", expirationDate: "" }),
    ).toBe(true);
    expect(
      isBlankLicenseRow({
        state: "",
        number: "",
        type: "compact",
        issueDate: "",
        expirationDate: "",
      }),
    ).toBe(false);
  });
});

describe("Add Provider under the NPI Registry policy", () => {
  const BLOCK = "Your organization saves only NPIs the NPI Registry lists.";

  it("refuses a blocked NPI with the policy's reason, after the check digit", () => {
    const valid = { ...base, npi: "1234567893" };
    expect(validateCredentials(valid, null).npi).toBeUndefined();
    expect(validateCredentials(valid, BLOCK).npi).toBe(BLOCK);
    expect(validateAll(valid, BLOCK).npi).toBe(BLOCK);
    expect(validateCredentials({ ...base, npi: "1234567890" }, BLOCK).npi).toBe(
      NPI_CHECK_DIGIT_MESSAGE,
    );
    // A blank NPI stays saveable: there is nothing to check.
    expect(validateAll(base, BLOCK)).toEqual({});
  });

  it("fills only the NPI when the policy says npi_only", () => {
    const { form, summary } = applyNpiRegistryPick(base, boulderJane, "npi_only");
    expect(form).toEqual({ ...base, npi: "1902833742" });
    expect(summary.filled).toEqual(["NPI"]);
    expect(summary.kept).toEqual([]);
    expect(summary.details.slice(0, 3)).toEqual([
      { label: "Credentials", lines: ["DPT"] },
      { label: "Primary taxonomy", lines: ["2251X0800X (Physical Therapist, Orthopedic)"] },
      { label: "Licenses", lines: ["CO PT-4471", "WY WY-0099"] },
    ]);
  });
});
