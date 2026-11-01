// MINT-110 (A30, A30b) — the NPI Registry part of a review step: what the
// check found ("Checking…" while it runs), every advisory with its fix, and
// never "Found" unless the registry's record really matched. Pure; synthetic
// data.
import { describe, expect, it } from "vitest";
import type { NpiLookupState, NpiRegistryRecord } from "@/lib/npiRegistry";
import {
  DEFAULT_NPI_REGISTRY_POLICY,
  resolveNpiRegistryPolicy,
  type NpiRegistryPolicy,
} from "@/lib/npiRegistryPolicy";
import {
  buildNpiRegistryReview,
  shownAdvisories,
  type NpiReviewInput,
} from "@/lib/npiRegistryReview";

const NPI = "1902833742";
const jane: NpiRegistryRecord = {
  npi: NPI,
  enumerationType: "NPI-1",
  firstName: "JANE",
  middleName: null,
  lastName: "DOE",
  organizationName: null,
  credential: "DPT",
  primaryTaxonomy: { code: "2251X0800X", description: "Physical Therapist, Orthopedic" },
  practiceCity: "BOULDER",
  practiceState: "CO",
  status: "active",
  enumerationDate: null,
  otherNames: [],
  taxonomies: [
    {
      code: "2251X0800X",
      description: "Physical Therapist, Orthopedic",
      primary: true,
      license: "PT-4471",
      licenseState: "CO",
    },
    { code: "225100000X", description: null, primary: false, license: "WY-1", licenseState: "WY" },
    { code: "225100000X", description: null, primary: false, license: "WY-2", licenseState: "WY" },
  ],
};

const input = (
  state: NpiLookupState,
  over: Partial<NpiReviewInput> = {},
  policy: NpiRegistryPolicy = DEFAULT_NPI_REGISTRY_POLICY,
): NpiReviewInput => ({
  npi: NPI,
  verify: true,
  state,
  typed: { firstName: "Jane", lastName: "Doe" },
  entered: { credentials: "DPT", taxonomyCode: "2251X0800X", licenses: [] },
  policy,
  confirmed: new Set(),
  ...over,
});
const found = (record: NpiRegistryRecord | null = jane): NpiLookupState => ({
  status: "done",
  record,
});

describe("buildNpiRegistryReview — the check's line", () => {
  it("says nothing when this save checks no NPI", () => {
    for (const over of [{ verify: false }, { npi: "" }]) {
      expect(buildNpiRegistryReview(input(found(null), over))).toEqual({
        line: null,
        checking: false,
        advisories: [],
      });
    }
    expect(buildNpiRegistryReview(input({ status: "idle" })).line).toBeNull();
  });

  it('says "Checking the NPI Registry…" while the check runs, and nothing else', () => {
    expect(buildNpiRegistryReview(input({ status: "loading" }))).toEqual({
      line: { tone: "neutral", title: "Checking the NPI Registry…", detail: null },
      checking: true,
      advisories: [],
    });
  });

  it("says Found only for a found, active, individual NPI whose name matches", () => {
    const review = buildNpiRegistryReview(input(found()));
    expect(review.line).toMatchObject({ tone: "ok", title: "Found in the NPI Registry" });
    expect(review.advisories).toEqual([]);
    const notOk: NpiLookupState[] = [
      found(null),
      found({ ...jane, status: "inactive" }),
      found({ ...jane, enumerationType: "NPI-2", organizationName: "X LLC" }),
      { status: "error", message: "NPI Registry is unavailable" },
      { status: "loading" },
    ];
    for (const state of notOk) {
      expect(buildNpiRegistryReview(input(state)).line?.tone).not.toBe("ok");
    }
    const otherName = buildNpiRegistryReview(
      input(found(), { typed: { firstName: "Mary", lastName: "Roe" } }),
    );
    expect(otherName.line?.tone).toBe("warn");
  });
});

describe("buildNpiRegistryReview — advisories about the NPI", () => {
  it.each([
    ["not found", found(null), "npi_registry.not_found", "npi"],
    ["inactive", found({ ...jane, status: "inactive" }), "npi_registry.inactive", "npi"],
    [
      "an organization's",
      found({ ...jane, enumerationType: "NPI-2", organizationName: "X LLC" }),
      "npi_registry.organization_number",
      "npi",
    ],
  ] as const)(
    "lists an NPI the registry has %s, with a fix that goes to the NPI",
    (_, state, check, field) => {
      const review = buildNpiRegistryReview(input(state));
      expect(review.advisories).toHaveLength(1);
      expect(review.advisories[0]).toMatchObject({
        id: check,
        check,
        record: { table: "providers", id: null, field },
        display: "review_step",
        fix: { field },
        registryValue: null,
        context: { confirmed: false },
      });
      expect(review.line?.tone).toBe("warn");
    },
  );

  it("lists a name mismatch with a fix that goes to the name", () => {
    const review = buildNpiRegistryReview(
      input(found(), { typed: { firstName: "Mary", lastName: "Roe" } }),
    );
    expect(review.advisories).toMatchObject([
      {
        check: "npi_registry.name_mismatch",
        record: { field: "firstName" },
        fix: { field: "firstName" },
      },
    ]);
  });

  it("lists a check that could not run as not checked, with Check again", () => {
    const review = buildNpiRegistryReview(
      input({ status: "error", message: "NPI Registry is unavailable" }),
    );
    expect(review.line).toEqual({
      tone: "warn",
      title: "Not checked: NPI Registry is unavailable",
      detail: null,
    });
    expect(review.advisories).toMatchObject([
      {
        check: "npi_registry.not_checked",
        policyCheck: null,
        fix: "retry",
        display: "review_step",
      },
    ]);
  });

  it("keeps a backend-only answer off the step, but still hands it over", () => {
    const policy = resolveNpiRegistryPolicy(null, { display: { notFound: "backend_only" } });
    const review = buildNpiRegistryReview(input(found(null), {}, policy));
    expect(review.line).toBeNull();
    expect(review.advisories).toMatchObject([
      { check: "npi_registry.not_found", display: "backend_only" },
    ]);
    expect(shownAdvisories(review)).toEqual([]);
  });

  it("marks what staff confirmed", () => {
    const review = buildNpiRegistryReview(
      input(found(null), { confirmed: new Set(["npi_registry.not_found"]) }),
    );
    expect(review.advisories[0].context).toEqual({ confirmed: true });
  });
});

describe("buildNpiRegistryReview — what staff entered against the record found", () => {
  it("lists credentials that differ, with the registry's value to choose", () => {
    const review = buildNpiRegistryReview(
      input(found(), { entered: { credentials: "PT", taxonomyCode: "", licenses: [] } }),
    );
    expect(review.line?.tone).toBe("ok");
    expect(review.advisories).toMatchObject([
      {
        check: "npi_registry.credentials_differ",
        title: "Credentials PT — the registry has DPT",
        fix: { field: "credentials" },
        registryValue: "DPT",
      },
    ]);
  });

  it("ignores case, spaces and punctuation, and a blank field", () => {
    for (const credentials of ["dpt", "D.P.T.", " DPT ", ""]) {
      expect(
        buildNpiRegistryReview(
          input(found(), { entered: { credentials, taxonomyCode: "", licenses: [] } }),
        ).advisories,
      ).toEqual([]);
    }
  });

  it("lists a taxonomy that differs; the registry's code is a choice only when the list offers it", () => {
    const review = buildNpiRegistryReview(
      input(found(), { entered: { credentials: "", taxonomyCode: "225100000X", licenses: [] } }),
    );
    expect(review.advisories).toMatchObject([
      {
        check: "npi_registry.taxonomy_differs",
        record: { field: "taxonomyCode" },
        registryValue: "2251X0800X",
      },
    ]);
    const unlisted = buildNpiRegistryReview(
      input(found({ ...jane, primaryTaxonomy: { code: "999999999X", description: null } }), {
        entered: { credentials: "", taxonomyCode: "225100000X", licenses: [] },
      }),
    );
    expect(unlisted.advisories[0].registryValue).toBeNull();
  });

  it("lists each license row whose number differs from the registry's in that state", () => {
    const review = buildNpiRegistryReview(
      input(found(), {
        entered: {
          credentials: "",
          taxonomyCode: "",
          licenses: [
            { state: "CO", number: "PT-1" },
            { state: "co", number: "pt 4471" },
            { state: "WY", number: "WY-9" },
            { state: "UT", number: "UT-1" },
            { state: "CO", number: "" },
          ],
        },
      }),
    );
    expect(review.advisories.map((advisory) => advisory.id)).toEqual([
      "npi_registry.license_differs:0",
      "npi_registry.license_differs:2",
    ]);
    expect(review.advisories[0]).toMatchObject({
      record: { field: "licenses.0.number" },
      fix: { field: "licenseNumber", row: 0 },
      registryValue: "PT-4471",
    });
    // Several numbers in that state are a choice for the license editor,
    // not a one-click swap.
    expect(review.advisories[1]).toMatchObject({
      title: "WY license WY-9 — the registry has WY-1, WY-2",
      registryValue: null,
    });
  });

  it("never puts a value in why-it-matters (that sentence is what the capture keeps)", () => {
    const review = buildNpiRegistryReview(
      input(found(), {
        entered: {
          credentials: "PT",
          taxonomyCode: "225100000X",
          licenses: [{ state: "CO", number: "PT-1" }],
        },
      }),
    );
    expect(review.advisories).toHaveLength(3);
    for (const advisory of review.advisories) {
      for (const value of [
        "PT-1",
        "PT-4471",
        "DPT",
        "225100000X",
        "2251X0800X",
        NPI,
        "JANE",
        "CO",
      ]) {
        expect(advisory.whyItMatters).not.toContain(value);
      }
    }
  });
});
