// MINT-7 — Add Provider's NPI rule: blank stays saveable (incomplete
// onboarding); an entered NPI needs ten digits AND the CMS check digit. Those
// are the only hard NPI rules: no NPI Registry answer refuses a step or the
// save (MINT-110, A30). The pick itself is tested in providerNpiPick.test.ts.
import { describe, expect, it } from "vitest";
import {
  NPI_CHECK_DIGIT_MESSAGE,
  NPI_FORMAT_MESSAGE,
  stripNpiSeparators,
} from "@/lib/providerIdentity";
import { emptyProviderFormState, validateAll, validateCredentials } from "./providerFormShared";

const base = { ...emptyProviderFormState, firstName: "Taylor", lastName: "Provider" };

describe("Add Provider NPI validation", () => {
  it("keeps a blank NPI saveable", () => {
    expect(validateAll(base)).toEqual({});
  });

  it("rejects a format-valid NPI with a wrong check digit inline", () => {
    expect(validateCredentials({ ...base, npi: "1234567890" }).npi).toBe(NPI_CHECK_DIGIT_MESSAGE);
    expect(validateAll({ ...base, npi: "1234567890" }).npi).toBe(NPI_CHECK_DIGIT_MESSAGE);
  });

  it("takes ten digits with the check digit, whatever the first digit, like the roster form", () => {
    expect(NPI_FORMAT_MESSAGE).toBe("NPI must be 10 digits");
    expect(validateCredentials({ ...base, npi: "123456789" }).npi).toBe(NPI_FORMAT_MESSAGE);
    expect(validateCredentials({ ...base, npi: "1234567893" }).npi).toBeUndefined();
    // No leading-1 rule: a check-digit-valid NPI starting with 2 is accepted,
    // and the registry, not the form, says whether it is an individual's.
    expect(validateCredentials({ ...base, npi: "2234567891" }).npi).toBeUndefined();
    expect(validateCredentials({ ...base, npi: "0234567893" }).npi).toBe(NPI_CHECK_DIGIT_MESSAGE);
  });
});

// MINT-110 (Sowmya, Oct 31): the NPI input takes the ten digits only. The
// input strips separators as staff type (stripNpiSeparators); a pasted label
// or dots stay in and fail.
describe("Add Provider NPI paste", () => {
  const typed = (value: string) => ({ ...base, npi: stripNpiSeparators(value) });

  it("rejects a pasted label and a dotted NPI", () => {
    for (const value of ["NPI: 1234567893", "123.456.7893"]) {
      expect(validateCredentials(typed(value)).npi).toBe("NPI must be 10 digits");
    }
  });

  it("accepts a dashed NPI", () => {
    expect(typed("123-456-7893").npi).toBe("1234567893");
    expect(validateCredentials(typed("123-456-7893")).npi).toBeUndefined();
  });
});

describe("Add Provider and the NPI Registry", () => {
  it("validates the NPI's shape and check digit only: no registry answer refuses it (A30)", () => {
    // Before A30 these took the policy's refusal as a second argument.
    expect(validateCredentials.length).toBe(1);
    expect(validateAll.length).toBe(1);
    expect(validateAll({ ...base, npi: "1234567893" })).toEqual({});
  });
});
