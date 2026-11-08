import { describe, expect, it } from "vitest";
import { EMPTY_INVITE, inviteFieldsReady, inviteNpiProblem } from "@/lib/inviteFields";
import { NPI_CHECK_DIGIT_MESSAGE, NPI_FORMAT_MESSAGE } from "@/lib/providerIdentity";

const filled = {
  ...EMPTY_INVITE,
  firstName: "Sam",
  lastName: "Lee",
  email: "sam.lee@example.test",
  groupId: "11111111-1111-4111-8111-111111111111",
};

describe("inviteNpiProblem", () => {
  it("leaves an empty NPI alone because it is optional", () => {
    expect(inviteNpiProblem("")).toBeNull();
  });

  it("asks for 10 digits when the number is short", () => {
    expect(inviteNpiProblem("12345")).toBe(NPI_FORMAT_MESSAGE);
  });

  it("flags 10 digits with a wrong check digit", () => {
    expect(inviteNpiProblem("1234567890")).toBe(NPI_CHECK_DIGIT_MESSAGE);
  });

  it("accepts an NPI whose check digit matches", () => {
    expect(inviteNpiProblem("1234567893")).toBeNull();
  });
});

describe("inviteFieldsReady", () => {
  it("is not ready while the NPI is wrong", () => {
    expect(inviteFieldsReady({ ...filled, npi: "1234567890" })).toBe(false);
    expect(inviteFieldsReady({ ...filled, npi: "12345" })).toBe(false);
  });

  it("is ready with a good NPI or none", () => {
    expect(inviteFieldsReady({ ...filled, npi: "1234567893" })).toBe(true);
    expect(inviteFieldsReady({ ...filled, npi: "" })).toBe(true);
  });
});
