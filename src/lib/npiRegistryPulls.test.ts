// MINT-110 PR 3 — the pure half of POST /api/npi-registry/pulls: what the
// route accepts, what stays in a pull's `sourced`, and what each form sends.
import { describe, expect, it } from "vitest";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import {
  NPI_REGISTRY_PULL_LICENSES_MAX,
  keepNpiRegistrySourced,
  npiRegistryPullForSave,
  npiRegistryPullSourced,
  validateNpiRegistryPull,
  type NpiRegistrySavedValues,
} from "@/lib/npiRegistryPulls";

const PROVIDER_ID = "6f1c2a9e-1b2c-4d3e-8f40-0123456789ab";

const RECORD: NpiRegistryRecord = {
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
  sex: "F",
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
  practiceAddress: {
    line1: "200 CLINIC WAY",
    line2: null,
    city: "BOULDER",
    state: "CO",
    postalCode: "803021234",
    countryCode: "US",
    phone: "303.555.0199",
  },
};

const SAVED: NpiRegistrySavedValues = {
  credentials: "DPT",
  taxonomyCode: "2251X0800X",
  gender: "female",
  phone: "303-555-0199",
  licenses: [
    { state: "CO", number: "PT-4471" },
    { state: "WY", number: "WY-0099" },
    { state: "UT", number: "UT-9" },
  ],
};

const EVERYTHING = {
  credentials: "DPT",
  taxonomyCode: "2251X0800X",
  gender: "female",
  phone: "303-555-0199",
  licenses: [
    { state: "CO", number: "PT-4471" },
    { state: "WY", number: "WY-0099" },
  ],
};

describe("validateNpiRegistryPull", () => {
  it("accepts a provider, a check-digit-valid NPI, the sourced fields and confirmed", () => {
    expect(
      validateNpiRegistryPull({
        providerId: PROVIDER_ID.toUpperCase(),
        npi: "190-283-3742",
        sourced: { credentials: " DPT ", licenses: [{ state: "co", number: "PT-4471" }] },
        confirmed: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        providerId: PROVIDER_ID,
        npi: "1902833742",
        sourced: { credentials: "DPT", licenses: [{ state: "CO", number: "PT-4471" }] },
        confirmed: true,
      },
    });
    // No sourced fields is a pull of a check: nothing came from it.
    expect(
      validateNpiRegistryPull({ providerId: PROVIDER_ID, npi: "1902833742", confirmed: false }),
    ).toMatchObject({ ok: true, value: { sourced: {}, confirmed: false } });
  });

  it.each([
    ["no body", null],
    ["an array", []],
    [
      "a provider id that is not a UUID",
      { providerId: "pr-1", npi: "1902833742", confirmed: false },
    ],
    ["a failing check digit", { providerId: PROVIDER_ID, npi: "1902833743", confirmed: false }],
    ["an NPI with letters", { providerId: PROVIDER_ID, npi: "19028337a2", confirmed: false }],
    ["no confirmed", { providerId: PROVIDER_ID, npi: "1902833742" }],
    ["confirmed as text", { providerId: PROVIDER_ID, npi: "1902833742", confirmed: "true" }],
    [
      "registry data sent by the client",
      { providerId: PROVIDER_ID, npi: "1902833742", confirmed: false, sourced: { reply: {} } },
    ],
    [
      "a sourced value that is not text",
      {
        providerId: PROVIDER_ID,
        npi: "1902833742",
        confirmed: false,
        sourced: { phone: 3035550199 },
      },
    ],
    [
      "a blank sourced value",
      {
        providerId: PROVIDER_ID,
        npi: "1902833742",
        confirmed: false,
        sourced: { credentials: " " },
      },
    ],
    [
      "a license in no US state",
      {
        providerId: PROVIDER_ID,
        npi: "1902833742",
        confirmed: false,
        sourced: { licenses: [{ state: "ZZ", number: "1" }] },
      },
    ],
    [
      "too many licenses",
      {
        providerId: PROVIDER_ID,
        npi: "1902833742",
        confirmed: false,
        sourced: {
          licenses: Array.from({ length: NPI_REGISTRY_PULL_LICENSES_MAX + 1 }, (_, i) => ({
            state: "CO",
            number: `PT-${i}`,
          })),
        },
      },
    ],
  ])("refuses %s", (_label, body) => {
    expect(validateNpiRegistryPull(body)).toMatchObject({ ok: false });
  });
});

describe("keepNpiRegistrySourced", () => {
  it("keeps every field whose saved value equals the registry's", () => {
    expect(keepNpiRegistrySourced(EVERYTHING, SAVED, RECORD)).toEqual(EVERYTHING);
  });

  it("drops a field the save holds differently, or the registry doesn't list", () => {
    const kept = keepNpiRegistrySourced(
      { ...EVERYTHING, licenses: [...EVERYTHING.licenses, { state: "UT", number: "UT-9" }] },
      {
        ...SAVED,
        // Staff changed it after the pick: no longer the registry's.
        credentials: "PT",
        // The save stored another code.
        taxonomyCode: "225100000X",
        licenses: [
          { state: "CO", number: "PT-4471" },
          { state: "UT", number: "UT-9" },
        ],
      },
      RECORD,
    );
    // 225100000X is a registry taxonomy, but the save named 2251X0800X; UT is
    // on the provider, never the registry's; WY never saved.
    expect(kept).toEqual({
      gender: "female",
      phone: "303-555-0199",
      licenses: [{ state: "CO", number: "PT-4471" }],
    });
  });

  it("never names the registry for a value it didn't give", () => {
    const other = { ...RECORD, credential: "PT", sex: "M" as const, practiceAddress: null };
    expect(keepNpiRegistrySourced(EVERYTHING, SAVED, other)).toEqual({
      taxonomyCode: "2251X0800X",
      licenses: EVERYTHING.licenses,
    });
    // No record: nothing is sourced.
    expect(keepNpiRegistrySourced(EVERYTHING, SAVED, null)).toEqual({});
  });

  it("compares licenses and phones as the forms do, and keeps the saved spelling", () => {
    expect(
      keepNpiRegistrySourced(
        { phone: "(303) 555-0199", licenses: [{ state: "CO", number: "pt 4471" }] },
        { ...SAVED, phone: "303 555 0199", licenses: [{ state: "co", number: "PT-4471" }] },
        RECORD,
      ),
    ).toEqual({ phone: "303 555 0199", licenses: [{ state: "CO", number: "PT-4471" }] });
  });

  it("keeps only what the save named", () => {
    expect(keepNpiRegistrySourced({}, SAVED, RECORD)).toEqual({});
  });
});

describe("what a form sends", () => {
  it("names the fields that still hold the pick's values, trimmed", () => {
    expect(
      npiRegistryPullSourced(
        {
          credentials: true,
          taxonomyCode: false,
          gender: true,
          phone: false,
          licenses: [
            { state: "co", number: " PT-4471 " },
            { state: "", number: "X" },
          ],
        },
        { credentials: " DPT ", taxonomyCode: "2251X0800X", gender: "female", phone: "1" },
      ),
    ).toEqual({
      credentials: "DPT",
      gender: "female",
      licenses: [{ state: "CO", number: "PT-4471" }],
    });
  });

  it("sends a pull for a pick of the saved NPI or the check of a new one, else none", () => {
    const base = {
      providerId: PROVIDER_ID,
      npi: "190-283-3742",
      checked: false,
      pickedNpi: "1902833742",
      sourced: { credentials: "DPT" },
      confirmed: true,
    };
    expect(npiRegistryPullForSave(base)).toEqual({
      providerId: PROVIDER_ID,
      npi: "1902833742",
      sourced: { credentials: "DPT" },
      confirmed: true,
    });
    // Staff typed another NPI after the pick: checked, but nothing sourced.
    expect(npiRegistryPullForSave({ ...base, npi: "1234567893", checked: true })).toEqual({
      providerId: PROVIDER_ID,
      npi: "1234567893",
      sourced: {},
      confirmed: true,
    });
    // An unchanged NPI and no pick of it: the save used no registry answer.
    expect(npiRegistryPullForSave({ ...base, npi: "1234567893" })).toBeNull();
    // No NPI, or one that fails the check digit: nothing to pull.
    expect(npiRegistryPullForSave({ ...base, npi: "", checked: true })).toBeNull();
    expect(npiRegistryPullForSave({ ...base, npi: "1234567890", checked: true })).toBeNull();
  });
});
