import { describe, expect, it } from "vitest";
import {
  addLicense,
  fieldId,
  formatBytes,
  npiProblem,
  isoToUsDate,
  missingDocuments,
  missingFields,
  parseUsDate,
  provenance,
  removeLicense,
  setField,
  ssnProblem,
  typeDate,
  typeSsn,
  type FieldPath,
} from "./intakeForm";
import { canContinue, documentSlots, sectionProgress } from "./providerOnboarding";
import { initialDraft, reviewDraft } from "@/services/providerOnboardingFixtures";
import type { IntakeDraft } from "@/types/providerOnboarding";

const TODAY = "2026-11-02";
const EMAIL = "anita.rao@example.test";

function apply(draft: IntakeDraft, steps: [FieldPath, string | null][]): IntakeDraft {
  return steps.reduce((d, [path, value]) => setField(d, path, value, TODAY), draft);
}

const EVERY_FIELD: [FieldPath, string][] = [
  [["identity", "npi"], "1234567893"],
  [["identity", "taxonomyCode"], "225100000X"],
  [["identity", "dateOfBirth"], "1990-04-01"],
  [["identity", "caqhId"], "12345678"],
  [["identity", "ssn"], "6789"],
  [["contact", "mobile"], "7045550123"],
  [["address", "street"], "18 Elm St"],
  [["address", "city"], "Charlotte"],
  [["address", "state"], "NC"],
  [["address", "zip"], "28203"],
  [["licenses", 0, "number"], "PT-48213"],
  [["licenses", 0, "expiresOn"], "2027-12-31"],
];

function withLogins(draft: IntakeDraft): IntakeDraft {
  return { ...draft, logins: { caqhOnFile: true, pecosOnFile: true } };
}

// The error summary and the progress chips must never tell her different things.
function expectAgreement(draft: IntakeDraft) {
  const progress = sectionProgress(draft);
  const missing = missingFields(draft);
  for (const section of ["identity", "contact", "licenses", "logins"] as const) {
    const listed = missing.filter((m) => m.key.split(".")[0] === section).length;
    expect(listed, section).toBe(progress[section].total - progress[section].done);
  }
  expect(missing.length === 0).toBe(canContinue(draft));
}

describe("npiProblem", () => {
  it("catches a short NPI and a typo while she is still on the field", () => {
    expect(npiProblem("123456789")).toBe("An NPI has 10 digits.");
    expect(npiProblem("1234567890")).toBe("This NPI isn't valid. Check each digit for a typo.");
  });

  it("says nothing about a valid NPI or an empty field", () => {
    expect(npiProblem("1234567893")).toBeNull();
    expect(npiProblem("")).toBeNull();
  });
});

describe("setField", () => {
  it("records what she typed as hers, dated today", () => {
    const next = setField(initialDraft(EMAIL), ["contact", "mobile"], "7045550123", TODAY);
    expect(next.contact.mobile).toEqual({
      value: "7045550123",
      source: { label: "You entered this", asOf: TODAY },
    });
  });

  it("leaves the draft it was given untouched", () => {
    const draft = initialDraft(EMAIL);
    setField(draft, ["identity", "caqhId"], "12345678", TODAY);
    expect(draft.identity.caqhId).toEqual({ value: null, source: null });
  });

  it("empties a cleared field, so it no longer counts", () => {
    const draft = initialDraft(EMAIL);
    expect(sectionProgress(draft).identity.done).toBe(2);
    const cleared = setField(draft, ["identity", "firstName"], "", TODAY);
    expect(cleared.identity.firstName).toEqual({ value: null, source: null });
    expect(sectionProgress(cleared).identity.done).toBe(1);
  });

  it("refuses to change a locked field", () => {
    const draft = reviewDraft("priya.shah@example.test");
    for (const key of ["npi", "dateOfBirth", "ssn"] as const) {
      const next = setField(draft, ["identity", key], "1234567893", TODAY);
      expect(next.identity[key]).toEqual(draft.identity[key]);
    }
  });

  it("still changes an unlocked field on a draft that has locked ones", () => {
    const draft = reviewDraft("priya.shah@example.test");
    const next = setField(draft, ["identity", "caqhId"], "87654321", TODAY);
    expect(next.identity.caqhId.value).toBe("87654321");
  });

  it("sets a home address part and a license field", () => {
    const next = apply(initialDraft(EMAIL), [
      [["address", "zip"], "28203"],
      [["licenses", 0, "number"], "PT-1"],
    ]);
    expect(next.contact.homeAddress.zip.value).toBe("28203");
    expect(next.licenses[0].number.value).toBe("PT-1");
  });

  it("confirms the state a license row was prefilled with once she fills that row", () => {
    const draft = initialDraft(EMAIL);
    expect(draft.licenses[0].state).toEqual({ value: "NC", source: null });
    const next = apply(draft, [
      [["licenses", 0, "number"], "PT-1"],
      [["licenses", 0, "expiresOn"], "2027-12-31"],
    ]);
    expect(next.licenses[0].state.value).toBe("NC");
    expect(sectionProgress(next).licenses).toEqual({ done: 1, total: 1 });
  });
});

describe("addLicense and removeLicense", () => {
  it("adds an empty row that must be filled before she can continue", () => {
    const filled = withLogins(apply(initialDraft(EMAIL), EVERY_FIELD));
    expect(canContinue(filled)).toBe(true);
    const added = addLicense(filled);
    expect(added.licenses).toHaveLength(2);
    expect(sectionProgress(added).licenses).toEqual({ done: 1, total: 2 });
    expect(canContinue(added)).toBe(false);
  });

  it("removes the row and the license copy it asked for", () => {
    const two = apply(addLicense(initialDraft(EMAIL)), [[["licenses", 1, "state"], "SC"]]);
    expect(documentSlots(two, {}).map((s) => s.key)).toContain("license:SC");
    const one = removeLicense(two, 1);
    expect(one.licenses).toHaveLength(1);
    expect(documentSlots(one, {}).map((s) => s.key)).not.toContain("license:SC");
  });
});

describe("missingFields", () => {
  it("lists what a first visit still needs, in the order the form shows it", () => {
    expect(missingFields(initialDraft(EMAIL)).map((m) => m.label)).toEqual([
      "NPI",
      "Specialty",
      "Date of birth",
      "CAQH ID",
      "Social Security number",
      "Mobile phone",
      "Home address",
      "NC license",
      "CAQH ProView login",
      "PECOS login",
    ]);
  });

  it("matches board 5a-2 for a re-invited provider: mobile phone and PECOS login", () => {
    const missing = missingFields(reviewDraft("priya.shah@example.test"));
    expect(missing.map((m) => [m.label, m.message, m.ids])).toEqual([
      ["Mobile phone", "Add your mobile number.", [fieldId("contact", "mobile")]],
      [
        "PECOS login",
        "Add your PECOS user ID and password.",
        [fieldId("logins", "pecos", "username"), fieldId("logins", "pecos", "password")],
      ],
    ]);
  });

  it("names only the home address parts still empty, linking to the first", () => {
    const draft = apply(initialDraft(EMAIL), [
      [["address", "street"], "18 Elm St"],
      [["address", "state"], "NC"],
    ]);
    const address = missingFields(draft).find((m) => m.label === "Home address");
    expect(address?.message).toBe("Add your city and ZIP code.");
    expect(address?.ids).toEqual([fieldId("address", "city"), fieldId("address", "zip")]);
  });

  it("does not ask her to add a license state that already shows", () => {
    const license = missingFields(initialDraft(EMAIL)).find((m) => m.label === "NC license");
    expect(license?.message).toBe("Add the license number and expiration date.");
    expect(license?.ids[0]).toBe(fieldId("licenses", 0, "number"));
  });

  it("names a license with no state by its position", () => {
    const draft = addLicense(withLogins(apply(initialDraft(EMAIL), EVERY_FIELD)));
    expect(missingFields(draft).map((m) => [m.label, m.message])).toEqual([
      ["License 2", "Add the state, license number and expiration date."],
    ]);
  });

  it("points at Add a state when every license row is gone", () => {
    const none = removeLicense(withLogins(apply(initialDraft(EMAIL), EVERY_FIELD)), 0);
    expect(missingFields(none).map((m) => [m.label, m.ids])).toEqual([
      ["State license", [fieldId("licenses", "add")]],
    ]);
  });

  it("is empty exactly when she can continue", () => {
    expect(missingFields(withLogins(apply(initialDraft(EMAIL), EVERY_FIELD)))).toEqual([]);
  });

  it("agrees with the progress chips at every point while she fills the form", () => {
    let draft = initialDraft(EMAIL);
    expectAgreement(draft);
    for (const step of EVERY_FIELD) {
      draft = apply(draft, [step]);
      expectAgreement(draft);
    }
    draft = { ...draft, logins: { caqhOnFile: true, pecosOnFile: false } };
    expectAgreement(draft);
    draft = withLogins(draft);
    expectAgreement(draft);
    for (const [path] of EVERY_FIELD) expectAgreement(apply(draft, [[path, null]]));
    expectAgreement(addLicense(draft));
    expectAgreement(removeLicense(draft, 0));
    expectAgreement(reviewDraft("priya.shah@example.test"));
  });
});

describe("typed dates", () => {
  it("adds the slashes as she types digits, since a phone number pad has no slash", () => {
    expect(typeDate("0")).toBe("0");
    expect(typeDate("072")).toBe("07/2");
    expect(typeDate("0721")).toBe("07/21");
    expect(typeDate("072119")).toBe("07/21/19");
    expect(typeDate("0721198855")).toBe("07/21/1988");
    expect(typeDate("07/21/1988")).toBe("07/21/1988");
  });

  it("reads a whole, real date as ISO and anything else as nothing", () => {
    expect(parseUsDate("07/21/1988")).toBe("1988-07-21");
    expect(parseUsDate("02/29/2024")).toBe("2024-02-29");
    expect(parseUsDate("02/29/2026")).toBeNull();
    expect(parseUsDate("13/01/2020")).toBeNull();
    expect(parseUsDate("04/31/2020")).toBeNull();
    expect(parseUsDate("07/21/19")).toBeNull();
    expect(parseUsDate("")).toBeNull();
  });

  it("shows a stored date the way she types it", () => {
    expect(isoToUsDate("2027-12-31")).toBe("12/31/2027");
    expect(isoToUsDate(null)).toBe("");
  });
});

describe("provenance", () => {
  it("says where a value came from, and when", () => {
    expect(provenance({ label: "You entered this", asOf: TODAY }, TODAY)).toBe(
      "You entered this · today",
    );
    expect(provenance({ label: "On file", asOf: "2026-03-14" }, TODAY)).toBe(
      "On file · Mar 14, 2026",
    );
    expect(provenance({ label: "From your invitation", asOf: null }, TODAY)).toBe(
      "From your invitation",
    );
    expect(provenance(null, TODAY)).toBeNull();
  });
});

describe("missingDocuments", () => {
  const file = { name: "a.pdf", sizeBytes: 1000, expiresOn: null };

  it("asks for the CV and each license copy", () => {
    const slots = documentSlots(initialDraft(EMAIL), {});
    expect(missingDocuments(slots).map((m) => [m.label, m.message])).toEqual([
      ["CV", "Upload your CV."],
      ["NC license copy", "Upload your NC license copy."],
    ]);
  });

  it("asks for the policy date only once a liability policy is uploaded", () => {
    const required = { cv: file, "license:NC": file };
    const draft = initialDraft(EMAIL);
    expect(missingDocuments(documentSlots(draft, required))).toEqual([]);
    const withCoi = documentSlots(draft, { ...required, coi: file });
    expect(missingDocuments(withCoi).map((m) => [m.label, m.message])).toEqual([
      ["Policy expiration date", "Add the date this policy expires."],
    ]);
    const dated = documentSlots(draft, { ...required, coi: { ...file, expiresOn: "2027-01-01" } });
    expect(missingDocuments(dated)).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("shows KB under a megabyte and MB with one decimal above", () => {
    expect(formatBytes(184 * 1024)).toBe("184 KB");
    expect(formatBytes(300)).toBe("1 KB");
    expect(formatBytes(2.1 * 1024 * 1024)).toBe("2.1 MB");
  });
});

describe("typeSsn", () => {
  it("adds the dashes as she types", () => {
    expect(typeSsn("123")).toBe("123");
    expect(typeSsn("1234")).toBe("123-4");
    expect(typeSsn("12345")).toBe("123-45");
    expect(typeSsn("123456789")).toBe("123-45-6789");
  });

  it("keeps digits only and stops at nine", () => {
    expect(typeSsn("123-45-67890")).toBe("123-45-6789");
    expect(typeSsn("1231231231")).toBe("123-12-3123");
    expect(typeSsn("12a3 4")).toBe("123-4");
  });
});

describe("ssnProblem", () => {
  it("says nothing for an empty field or nine digits", () => {
    expect(ssnProblem("")).toBeNull();
    expect(ssnProblem("123-45-6789")).toBeNull();
  });

  it("says how many digits she has entered", () => {
    expect(ssnProblem("123-45-678")).toBe("An SSN has 9 digits. You've entered 8.");
    expect(ssnProblem("1")).toBe("An SSN has 9 digits. You've entered 1.");
  });

  it("catches nine digits the SSA never issues", () => {
    const invalid = "This isn't a valid Social Security number. Check each digit for a typo.";
    expect(ssnProblem("000-12-3456")).toBe(invalid);
    expect(ssnProblem("078-05-1120")).toBe(invalid);
  });
});
