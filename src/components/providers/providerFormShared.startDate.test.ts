// MINT-116 — the wizard's Employment step blocks a blank Start date only when
// no ProviderIntakeRules value fills one in for the selected facilities.
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_INTAKE_RULES } from "@/lib/providerIntakeRules";
import { emptyProviderFormState, validateAll, validateEmployment } from "./providerFormShared";

const form = (over: Partial<typeof emptyProviderFormState>) => ({
  ...emptyProviderFormState,
  firstName: "Synthetic",
  lastName: "Provider",
  ...over,
});
const BOTH_NONE = {
  providerStartDateDefault: "none",
  assignmentStartDateDefault: "none",
} as const;

describe("validateEmployment", () => {
  it("never blocks a blank Start date under the default rules", () => {
    const blank = form({ facilityIds: ["f1"], startDate: "" });
    expect(validateEmployment(blank)).toEqual({});
    expect(validateEmployment(blank, DEFAULT_PROVIDER_INTAKE_RULES)).toEqual({});
    expect(validateAll(blank)).toEqual({});
  });

  it('requires it under "none" for both while a facility is selected, and submit sees it', () => {
    const blank = form({ facilityIds: ["f1"], startDate: "" });
    const error = {
      startDate: "Required while a facility is selected: facility assignments need a start date.",
    };
    expect(validateEmployment(blank, BOTH_NONE)).toEqual(error);
    expect(validateAll(blank, BOTH_NONE)).toEqual(error);
    expect(validateEmployment(form({ facilityIds: [], startDate: "" }), BOTH_NONE)).toEqual({});
    expect(
      validateEmployment(form({ facilityIds: ["f1"], startDate: "2026-11-15" }), BOTH_NONE),
    ).toEqual({});
  });
});
