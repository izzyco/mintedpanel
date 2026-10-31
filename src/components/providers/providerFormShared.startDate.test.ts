// MINT-116 — the wizard's Employment step blocks a blank Start date only when
// AddProviderRules fills nothing in for the selected facilities.
import { describe, expect, it } from "vitest";
import { DEFAULT_ADD_PROVIDER_RULES } from "@/lib/addProviderRules";
import { emptyProviderFormState, validateAll, validateEmployment } from "./providerFormShared";

const form = (over: Partial<typeof emptyProviderFormState>) => ({
  ...emptyProviderFormState,
  firstName: "Synthetic",
  lastName: "Provider",
  ...over,
});
const NONE = { assignmentStartDateDefault: "none" } as const;

describe("validateEmployment", () => {
  it("never blocks a blank Start date under the default rules", () => {
    const blank = form({ facilityIds: ["f1"], startDate: "" });
    expect(validateEmployment(blank)).toEqual({});
    expect(validateEmployment(blank, DEFAULT_ADD_PROVIDER_RULES)).toEqual({});
    expect(validateAll(blank)).toEqual({});
  });

  it('requires it under "none" while a facility is selected, and submit sees it', () => {
    const blank = form({ facilityIds: ["f1"], startDate: "" });
    const error = {
      startDate: "Required while a facility is selected: facility assignments need a start date.",
    };
    expect(validateEmployment(blank, NONE)).toEqual(error);
    expect(validateAll(blank, NONE)).toEqual(error);
    expect(validateEmployment(form({ facilityIds: [], startDate: "" }), NONE)).toEqual({});
    expect(
      validateEmployment(form({ facilityIds: ["f1"], startDate: "2026-11-15" }), NONE),
    ).toEqual({});
  });
});
