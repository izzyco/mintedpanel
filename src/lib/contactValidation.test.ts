import { describe, expect, it } from "vitest";
import {
  isValidEmail,
  commonEmailDomainTypo,
  contactErrors,
  leadErrors,
} from "./contactValidation";
import { EMPTY_CONTACT } from "./contacts";
import type { ContactInput } from "@/types";
import { DEFAULT_PHONE_VALIDATION_RULES, US_PHONE_MESSAGE } from "@/lib/phone";

// A fully-populated contact. Was the shared DEFAULT_SALES_REP fixture until org
// intake stopped auto-creating a placeholder sales rep and that constant was
// deleted; this is a local fixture with the same shape.
const FULL_CONTACT: ContactInput = {
  firstName: "Dana",
  lastName: "Reyes",
  title: "",
  email: "dana.reyes@example.test",
  phoneOffice: "704-555-0100",
  phoneExtension: "",
  phoneMobile: "",
  fax: "",
  addressLine1: "101 S Tryon St",
  addressLine2: "Suite 400",
  city: "Charlotte",
  state: "NC",
  postalCode: "28280",
  country: "US",
};

describe("isValidEmail", () => {
  it("accepts well-formed addresses", () => {
    expect(isValidEmail("johnb@outerbanks.example.test")).toBe(true);
    expect(isValidEmail("  owner.dillon@example.test  ")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false);
    expect(isValidEmail("two@@at.com")).toBe(false);
  });
});

describe("commonEmailDomainTypo", () => {
  it("suggests a correction for common domain typos", () => {
    expect(commonEmailDomainTypo("owner@gmial.com")).toBe("owner@gmail.com");
    expect(commonEmailDomainTypo("a.b@HOTMAL.COM")).toBe("a.b@hotmail.com");
  });

  it("returns null for good or unknown domains", () => {
    expect(commonEmailDomainTypo("owner@gmail.com")).toBeNull();
    expect(commonEmailDomainTypo("owner@outerbanks.example.test")).toBeNull();
    expect(commonEmailDomainTypo("no-at-sign")).toBeNull();
    expect(commonEmailDomainTypo("trailing@")).toBeNull();
  });
});

describe("contactErrors", () => {
  it("flags every required field on an empty contact (E0.2 FR-2), but not the phone (U8)", () => {
    const e = contactErrors(EMPTY_CONTACT);
    expect(Object.keys(e).sort()).toEqual(
      ["addressLine1", "city", "email", "firstName", "lastName", "postalCode", "state"].sort(),
    );
  });

  it("passes a fully-populated contact (line2/country optional)", () => {
    expect(contactErrors(FULL_CONTACT)).toEqual({});
  });

  it("flags a malformed email but accepts a valid one", () => {
    expect(contactErrors({ ...FULL_CONTACT, email: "nope" }).email).toBeTruthy();
    expect(contactErrors({ ...FULL_CONTACT, email: "a@b.co" }).email).toBeUndefined();
  });
});

describe("contactErrors — office phone format (MINT-91)", () => {
  it("rejects an entered phone with letters on create; a valid one passes", () => {
    expect(contactErrors({ ...FULL_CONTACT, phoneOffice: "abc-def-ghij" }).phoneOffice).toBe(
      US_PHONE_MESSAGE,
    );
    expect(contactErrors({ ...FULL_CONTACT, phoneOffice: "(704) 555-0100 ext. 12" })).toEqual({});
  });

  it("saves with the phone blank or whitespace, on create and on edit (U8)", () => {
    expect(contactErrors({ ...FULL_CONTACT, phoneOffice: "" })).toEqual({});
    expect(contactErrors({ ...FULL_CONTACT, phoneOffice: "  " })).toEqual({});
    // Clearing a stored phone on an edit saves too, under either rule value.
    const recheck = { ...DEFAULT_PHONE_VALIDATION_RULES, recheckStoredOnEdit: true };
    expect(contactErrors({ ...FULL_CONTACT, phoneOffice: "" }, "704-555-0100")).toEqual({});
    expect(contactErrors({ ...FULL_CONTACT, phoneOffice: "" }, "abc-def-ghij", recheck)).toEqual(
      {},
    );
  });

  it("still refuses a non-US or malformed number, on create and when changed on edit (A3)", () => {
    for (const phone of ["+44 20 7946 0958", "+65 6123 4567", "555-0100", "704-555-01000"]) {
      expect(contactErrors({ ...FULL_CONTACT, phoneOffice: phone }).phoneOffice).toBe(
        US_PHONE_MESSAGE,
      );
      expect(
        contactErrors({ ...FULL_CONTACT, phoneOffice: phone }, "704-555-0100").phoneOffice,
      ).toBe(US_PHONE_MESSAGE);
    }
  });

  it("on an edit, an untouched stored phone never blocks; a changed one is checked", () => {
    const legacy = { ...FULL_CONTACT, phoneOffice: "abc-def-ghij" };
    expect(contactErrors(legacy, "abc-def-ghij")).toEqual({});
    expect(contactErrors({ ...legacy, phoneOffice: "555-0100" }, "abc-def-ghij").phoneOffice).toBe(
      US_PHONE_MESSAGE,
    );
    expect(contactErrors({ ...legacy, phoneOffice: "704-555-0199" }, "abc-def-ghij")).toEqual({});
  });
});

describe("contactErrors — recheckStoredOnEdit (MINT-129 alternative)", () => {
  it("blocks the edit on an untouched invalid stored phone only when the rule is on", () => {
    const legacy = { ...FULL_CONTACT, phoneOffice: "abc-def-ghij" };
    const recheck = { ...DEFAULT_PHONE_VALIDATION_RULES, recheckStoredOnEdit: true };
    expect(contactErrors(legacy, "abc-def-ghij", DEFAULT_PHONE_VALIDATION_RULES)).toEqual({});
    expect(contactErrors(legacy, "abc-def-ghij", recheck).phoneOffice).toBe(US_PHONE_MESSAGE);
    expect(contactErrors(FULL_CONTACT, FULL_CONTACT.phoneOffice, recheck)).toEqual({});
  });
});

describe("leadErrors — the public /contact form", () => {
  const LEAD = {
    orgName: "Dillon Sports Medicine",
    contactName: "Coach Eric Taylor",
    contactEmail: "coach@dillon.example.test",
    contactPhone: "432-555-0118",
  };

  it("passes a complete lead", () => {
    expect(leadErrors(LEAD)).toEqual({});
  });

  it("requires the organization, your name and a valid email, but not the phone (U8)", () => {
    expect(
      Object.keys(
        leadErrors({ orgName: "", contactName: "", contactEmail: "", contactPhone: "" }),
      ).sort(),
    ).toEqual(["contactEmail", "contactName", "orgName"]);
    expect(leadErrors({ ...LEAD, contactEmail: "nope" }).contactEmail).toBe(
      "Enter a valid email address",
    );
    expect(leadErrors({ ...LEAD, contactPhone: "" })).toEqual({});
    expect(leadErrors({ ...LEAD, contactPhone: "   " })).toEqual({});
  });

  it("still refuses a non-US or malformed phone (A3)", () => {
    expect(leadErrors({ ...LEAD, contactPhone: "+44 20 7946 0958" }).contactPhone).toBe(
      US_PHONE_MESSAGE,
    );
    expect(leadErrors({ ...LEAD, contactPhone: "abc-def-ghij" }).contactPhone).toBe(
      US_PHONE_MESSAGE,
    );
  });
});
