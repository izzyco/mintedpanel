// MINT-110 — what picking an NPI Registry match fills: every blank field (an
// untouched preset and the previous pick's untouched data — fields, numbers
// and rows added from its offers — count as blank), never a value staff
// touched, a license number only into an unverified row of that state, and no
// license row added — licenses not on the form are offered. Synthetic data.
import { describe, expect, it } from "vitest";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import {
  applyNpiLicenseRows,
  formatRegistryAddress,
  npiFillAnnouncement,
  npiOffersOnForm,
  npiRegistrySourceLabel,
  npiRegistrySourcedFields,
  planNpiRegistryFill,
  touchNpiRowOrigin,
  type NpiPickState,
  type NpiFillForm,
  type NpiFillLicenseRow,
  type NpiPickTrace,
  type NpiRowOrigin,
} from "@/lib/npiRegistryFill";
import type { NpiFillOnPick } from "@/lib/npiRegistryPolicy";

const record = (over: Partial<NpiRegistryRecord> = {}): NpiRegistryRecord => ({
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
  otherNames: [{ firstName: "JANE", lastName: "SMITH", middleName: null, type: "Former Name" }],
  suffix: "JR",
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
    line2: "SUITE 4",
    city: "BOULDER",
    state: "CO",
    postalCode: "803021234",
    countryCode: "US",
    phone: "303-555-0199",
  },
  mailingAddress: {
    line1: "PO BOX 12",
    line2: null,
    city: "BOULDER",
    state: "CO",
    postalCode: "80306",
    countryCode: "US",
    phone: null,
  },
  otherPracticeAddresses: [],
  identifiers: [{ identifier: "CO-MCD-77", type: "MEDICAID", state: "CO", issuer: null }],
  ...over,
});

// The other Jane Doe: a different person staff may pick first by mistake.
const denver = record({
  npi: "1234567893",
  middleName: null,
  credential: "PT",
  primaryTaxonomy: { code: "225100000X", description: "Physical Therapist" },
  practiceCity: "DENVER",
  suffix: null,
  taxonomies: [
    {
      code: "225100000X",
      description: "Physical Therapist",
      primary: true,
      license: "PT-1111",
      licenseState: "CO",
    },
  ],
  practiceAddress: null,
  mailingAddress: null,
  identifiers: [],
  otherNames: [],
});

const blankForm = (over: Partial<NpiFillForm> = {}): NpiFillForm => ({
  npi: "",
  credentials: "",
  credentialsTouched: false,
  taxonomyCode: "",
  taxonomyTouched: false,
  taxonomyPreset: null,
  licenses: [],
  licenseRowSaveable: true,
  ...over,
});

const row = (
  state: string,
  number = "",
  origin: NpiRowOrigin | null = null,
  numberLocked = false,
): NpiFillLicenseRow => ({ state, number, origin, numberLocked });

const ADDED: NpiRowOrigin = { kind: "added", touched: false };

// A pick with the defaults' fill mode and no earlier pick.
const plan = (
  rec: NpiRegistryRecord,
  form: NpiFillForm,
  fillOnPick: NpiFillOnPick = "blank_fields",
  lastPick: NpiPickTrace | null = null,
) => planNpiRegistryFill(rec, form, fillOnPick, lastPick);

// The form after a plan is applied, for a second pick.
function applied(form: NpiFillForm, next: ReturnType<typeof planNpiRegistryFill>): NpiFillForm {
  return {
    ...form,
    npi: next.npi,
    credentials: next.credentials ?? form.credentials,
    credentialsTouched: next.trace.credentials ? false : form.credentialsTouched,
    taxonomyCode: next.taxonomyCode ?? form.taxonomyCode,
    licenses: applyNpiLicenseRows(
      form.licenses,
      next,
      (r, number, origin) => ({ ...r, number, origin }),
      () => row(""),
    ),
  };
}

describe("planNpiRegistryFill — blank fields", () => {
  it("fills credentials, the taxonomy and a blank number in a row of that state", () => {
    const next = plan(record(), blankForm({ licenses: [row("CO")] }));
    expect(next).toMatchObject({
      npi: "1902833742",
      credentials: "DPT",
      taxonomyCode: "2251X0800X",
      licenseRows: [{ rowIndex: 0, number: "PT-4471", origin: { kind: "number", touched: false } }],
      removeRows: [],
    });
    expect(next.summary.filled).toEqual([
      "NPI",
      "Credentials",
      "Taxonomy code",
      "CO license number",
    ]);
    expect(next.summary.kept).toEqual([]);
    expect(next.summary.cleared).toEqual([]);
    expect(next.trace).toEqual({
      credentials: { written: "DPT", previous: "" },
      taxonomyCode: { written: "2251X0800X", previous: "" },
    });
  });

  it("treats whitespace as blank", () => {
    const next = plan(record(), blankForm({ credentials: "  ", taxonomyCode: " " }));
    expect(next.credentials).toBe("DPT");
    expect(next.taxonomyCode).toBe("2251X0800X");
  });

  it("does not list the NPI when the form already holds it, separators and all", () => {
    expect(plan(record(), blankForm({ npi: "190-283-3742" })).summary.filled[0]).toBe(
      "Credentials",
    );
  });

  it("works on a record with none of the fill fields", () => {
    const bare = record({
      suffix: undefined,
      taxonomies: undefined,
      practiceAddress: undefined,
      mailingAddress: undefined,
      otherPracticeAddresses: undefined,
      identifiers: undefined,
      middleName: null,
      otherNames: [],
    });
    const next = plan(bare, blankForm());
    expect(next.licenseRows).toEqual([]);
    expect(next.summary).toEqual({
      filled: ["NPI", "Credentials", "Taxonomy code"],
      cleared: [],
      kept: [],
      staleRows: [],
      licenseOffers: [],
      details: [],
      taxonomyChoices: [],
    });
  });
});

describe("planNpiRegistryFill — an untouched preset is blank", () => {
  const preset = { taxonomyCode: "225100000X", taxonomyPreset: "225100000X" };

  it("replaces a preset taxonomy nobody chose", () => {
    const next = plan(record(), blankForm(preset));
    expect(next.taxonomyCode).toBe("2251X0800X");
    expect(next.summary.filled).toContain("Taxonomy code");
    expect(next.summary.kept).toEqual([]);
    expect(next.trace.taxonomyCode).toEqual({ written: "2251X0800X", previous: "225100000X" });
  });

  it("keeps the preset when the registry's code is not in the list, and lists the code", () => {
    const next = plan(
      record({
        primaryTaxonomy: { code: "207Q00000X", description: "Family Medicine" },
        taxonomies: [],
      }),
      blankForm(preset),
    );
    expect(next.taxonomyCode).toBeNull();
    expect(next.summary.filled).not.toContain("Taxonomy code");
    expect(next.summary.kept).toEqual([]);
    expect(next.summary.details).toContainEqual({
      label: "Other taxonomies",
      lines: ["207Q00000X (Family Medicine) — primary, not in the Taxonomy code list"],
    });
  });

  it("keeps a taxonomy staff chose, even the preset's code", () => {
    const next = plan(record(), blankForm({ ...preset, taxonomyTouched: true }));
    expect(next.taxonomyCode).toBeNull();
    expect(next.summary.kept).toContainEqual({
      field: "Taxonomy code",
      registryValue: "2251X0800X (Physical Therapist, Orthopedic)",
    });
  });

  it("keeps a stored taxonomy on a form with no preset", () => {
    const next = plan(record(), blankForm({ taxonomyCode: "225100000X" }));
    expect(next.taxonomyCode).toBeNull();
    expect(next.summary.kept.map((item) => item.field)).toEqual(["Taxonomy code"]);
    expect(plan(record(), blankForm({ taxonomyCode: "2251x0800x" })).summary.kept).toEqual([]);
  });
});

describe("planNpiRegistryFill — never overwrite staff's values", () => {
  it("keeps typed credentials and says what the registry has", () => {
    const next = plan(record(), blankForm({ credentials: "PT", credentialsTouched: true }));
    expect(next.credentials).toBeNull();
    expect(next.summary.kept).toContainEqual({ field: "Credentials", registryValue: "DPT" });
  });

  it("says nothing when typed credentials match apart from case and punctuation", () => {
    const next = plan(
      record({ credential: "P.T., D.P.T." }),
      blankForm({ credentials: "pt, dpt", credentialsTouched: true }),
    );
    expect(next.credentials).toBeNull();
    expect(next.summary.kept).toEqual([]);
  });

  it("never fills a taxonomy the form's list does not offer; it is listed instead", () => {
    const next = plan(
      record({
        primaryTaxonomy: { code: "207Q00000X", description: "Family Medicine" },
        taxonomies: [],
      }),
      blankForm(),
    );
    expect(next.taxonomyCode).toBeNull();
    expect(next.summary.details).toContainEqual({
      label: "Other taxonomies",
      lines: ["207Q00000X (Family Medicine) — primary, not in the Taxonomy code list"],
    });
  });
});

describe("planNpiRegistryFill — license rows", () => {
  it("never adds a row: a license the form has no row for is offered", () => {
    const next = plan(record(), blankForm({ licenses: [row("")] }));
    expect(next.licenseRows).toEqual([]);
    expect(next.summary.filled).toEqual(["NPI", "Credentials", "Taxonomy code"]);
    expect(next.summary.licenseOffers).toEqual([
      { state: "CO", number: "PT-4471", added: false },
      { state: "WY", number: "WY-0099", added: false },
    ]);
  });

  it("fills a blank number in a row of that state, whatever its case or spacing", () => {
    const next = plan(record(), blankForm({ licenses: [row("WY"), row("co", "  ")] }));
    expect(next.licenseRows.map(({ rowIndex, number }) => ({ rowIndex, number }))).toEqual([
      { rowIndex: 0, number: "WY-0099" },
      { rowIndex: 1, number: "PT-4471" },
    ]);
    expect(next.summary.filled).toEqual([
      "NPI",
      "Credentials",
      "Taxonomy code",
      "WY license number",
      "CO license number",
    ]);
    expect(next.summary.kept).toEqual([]);
    expect(next.summary.licenseOffers).toEqual([]);
  });

  it("never changes a number with a value; a different one is kept and named", () => {
    const next = plan(record(), blankForm({ licenses: [row("CO", "CO-1")] }));
    expect(next.licenseRows).toEqual([]);
    expect(next.summary.kept).toEqual([{ field: "CO license", registryValue: "PT-4471" }]);
  });

  it("says nothing about a row that already holds the registry's number", () => {
    const next = plan(record(), blankForm({ licenses: [row("co", "pt 4471")] }));
    expect(next.summary.kept).toEqual([]);
    expect(next.summary.filled).not.toContain("CO license number");
  });

  it("never fills a row whose verification is recorded; the license is offered instead", () => {
    const next = plan(record(), blankForm({ licenses: [row("CO", "", null, true)] }));
    expect(next.licenseRows).toEqual([]);
    expect(next.summary.kept).toEqual([]);
    expect(next.summary.licenseOffers).toContainEqual({
      state: "CO",
      number: "PT-4471",
      added: false,
    });
  });

  it("offers a second license in a state whose only row this pick just filled", () => {
    const taxonomy = (license: string | null, licenseState: string, primary = false) => ({
      code: "225X00000X",
      description: null,
      primary,
      license,
      licenseState,
    });
    const next = plan(
      record({
        taxonomies: [
          taxonomy("A-1", "CO", true),
          taxonomy("B-2", "CO"),
          taxonomy("C-3", "ZZ"),
          taxonomy(null, "WY"),
        ],
      }),
      blankForm({ licenses: [row("CO")] }),
    );
    expect(next.licenseRows.map(({ number }) => number)).toEqual(["A-1"]);
    expect(next.summary.licenseOffers).toEqual([{ state: "CO", number: "B-2", added: false }]);
    // A state the form's picker does not offer is listed, not offered.
    expect(next.summary.details).toContainEqual({ label: "Licenses not added", lines: ["ZZ C-3"] });
  });

  it("lists, never offers, when the form could not save a row with only a state and number", () => {
    const next = plan(record(), blankForm({ licenseRowSaveable: false }));
    expect(next.summary.licenseOffers).toEqual([]);
    expect(next.summary.details).toContainEqual({
      label: "Licenses not added",
      lines: ["CO PT-4471", "WY WY-0099"],
    });
  });

  it("reads whether an offer is on the form from the rows, so a removed one comes back", () => {
    const { summary } = plan(record(), blankForm());
    const withRow = npiOffersOnForm(summary, [{ state: "wy", number: "wy 0099" }]);
    expect(withRow.licenseOffers).toEqual([
      { state: "CO", number: "PT-4471", added: false },
      { state: "WY", number: "WY-0099", added: true },
    ]);
    expect(npiOffersOnForm(summary, []).licenseOffers.every((offer) => !offer.added)).toBe(true);
  });

  it("marks an added row touched by any edit, and a filled number only by the number", () => {
    expect(touchNpiRowOrigin(ADDED, { number: false })).toEqual({ kind: "added", touched: true });
    const filled: NpiRowOrigin = { kind: "number", touched: false };
    expect(touchNpiRowOrigin(filled, { number: false })).toBe(filled);
    expect(touchNpiRowOrigin(filled, { number: true })).toEqual({ kind: "number", touched: true });
    expect(touchNpiRowOrigin(null, { number: true })).toBeNull();
  });
});

describe("planNpiRegistryFill — a second pick replaces the first pick's data", () => {
  const start = blankForm({
    taxonomyCode: "225100000X",
    taxonomyPreset: "225100000X",
    licenses: [row("CO")],
  });

  it("pick A, then pick B: nothing of A is left and nothing is reported as kept", () => {
    const first = plan(denver, start);
    const afterFirst = applied(start, first);
    expect(afterFirst).toMatchObject({
      credentials: "PT",
      taxonomyCode: "225100000X",
      licenses: [{ state: "CO", number: "PT-1111" }],
    });

    const second = plan(record(), afterFirst, "blank_fields", first.trace);
    expect(applied(afterFirst, second)).toMatchObject({
      npi: "1902833742",
      credentials: "DPT",
      taxonomyCode: "2251X0800X",
      licenses: [{ state: "CO", number: "PT-4471" }],
    });
    expect(second.summary.kept).toEqual([]);
    expect(second.summary.filled).toEqual([
      "NPI",
      "Credentials",
      "Taxonomy code",
      "CO license number",
    ]);
  });

  it("clears what A filled when B has nothing for it, back to what it held before A", () => {
    const first = plan(denver, start);
    const afterFirst = applied(start, first);
    const bare = record({ credential: null, taxonomies: [], primaryTaxonomy: null });
    const second = plan(bare, afterFirst, "blank_fields", first.trace);
    expect(applied(afterFirst, second)).toMatchObject({
      credentials: "",
      taxonomyCode: "225100000X",
      licenses: [{ state: "CO", number: "", origin: null }],
    });
    expect(second.summary.cleared).toEqual(["Credentials", "CO license number"]);
    expect(second.trace).toEqual({ credentials: null, taxonomyCode: null });
  });

  it("keeps everything staff touched after A, even values equal to A's", () => {
    const first = plan(denver, start);
    const afterFirst = applied(start, first);
    // Staff retyped A's credentials and A's number, and re-chose the taxonomy.
    const touched: NpiFillForm = {
      ...afterFirst,
      credentialsTouched: true,
      taxonomyTouched: true,
      licenses: afterFirst.licenses.map((r) => ({
        ...r,
        origin: touchNpiRowOrigin(r.origin, { number: true }),
      })),
    };
    const second = plan(record(), touched, "blank_fields", first.trace);
    expect(second.credentials).toBeNull();
    expect(second.taxonomyCode).toBeNull();
    expect(second.licenseRows).toEqual([{ rowIndex: 0, number: "PT-1111", origin: null }]);
    expect(second.summary.cleared).toEqual([]);
    expect(second.summary.kept).toEqual([
      { field: "Credentials", registryValue: "DPT" },
      { field: "Taxonomy code", registryValue: "2251X0800X (Physical Therapist, Orthopedic)" },
      { field: "CO license", registryValue: "PT-4471" },
    ]);
  });

  it("does not take back a taxonomy staff chose again after A, and does not report it cleared", () => {
    const ot = record({
      npi: "1234567893",
      primaryTaxonomy: { code: "225X00000X", description: "Occupational Therapist" },
      taxonomies: [],
    });
    const first = plan(ot, start);
    const afterFirst = applied(start, first);
    expect(afterFirst.taxonomyCode).toBe("225X00000X");
    // Staff chose another code and then 225X00000X again: same value, theirs.
    const second = plan(
      record(),
      { ...afterFirst, taxonomyTouched: true },
      "blank_fields",
      first.trace,
    );
    expect(second.taxonomyCode).toBeNull();
    expect(second.summary.cleared).not.toContain("Taxonomy code");
    expect(second.summary.kept).toContainEqual({
      field: "Taxonomy code",
      registryValue: "2251X0800X (Physical Therapist, Orthopedic)",
    });
  });

  it("re-picking the same match changes nothing and keeps owning its data", () => {
    const first = plan(denver, start);
    const afterFirst = applied(start, first);
    const again = plan(denver, afterFirst, "blank_fields", first.trace);
    expect(again).toMatchObject({ credentials: null, taxonomyCode: null, licenseRows: [] });
    expect(again.summary.filled).toEqual([]);
    expect(again.summary.kept).toEqual([]);
    expect(again.trace).toEqual(first.trace);
    expect(applied(afterFirst, again).licenses[0].origin).toEqual({
      kind: "number",
      touched: false,
    });
  });
});

describe("planNpiRegistryFill — rows added from the previous pick's offers", () => {
  // Pick A offered CO PT-1111 (no CO row on the form) and staff added it.
  const afterAdd = blankForm({
    npi: "1234567893",
    credentials: "PT",
    licenses: [row("CO", "PT-1111", ADDED)],
  });
  const lastPick: NpiPickTrace = {
    credentials: { written: "PT", previous: "" },
    taxonomyCode: null,
  };

  it("removes an untouched added row when B has a different license in that state", () => {
    const next = plan(record(), afterAdd, "blank_fields", lastPick);
    expect(next.removeRows).toEqual([0]);
    expect(applied(afterAdd, next).licenses).toEqual([]);
    expect(next.summary.cleared).toEqual(["CO license row"]);
    expect(next.summary.licenseOffers).toContainEqual({
      state: "CO",
      number: "PT-4471",
      added: false,
    });
    expect(next.summary.kept).toEqual([]);
  });

  it("removes it when B has no license in that state", () => {
    const next = plan(
      record({
        taxonomies: [
          {
            code: "225100000X",
            description: null,
            primary: true,
            license: "W-1",
            licenseState: "WY",
          },
        ],
      }),
      afterAdd,
      "blank_fields",
      lastPick,
    );
    expect(next.removeRows).toEqual([0]);
    expect(next.summary.cleared).toContain("CO license row");
  });

  it("keeps it when B lists the same license", () => {
    const next = plan(denver, afterAdd, "blank_fields", lastPick);
    expect(next.removeRows).toEqual([]);
    expect(applied(afterAdd, next).licenses).toEqual([row("CO", "PT-1111", ADDED)]);
    expect(next.summary.cleared).toEqual([]);
  });

  it("keeps a row staff edited after adding it, and lists it when B does not list it", () => {
    const edited = {
      ...afterAdd,
      licenses: [row("CO", "PT-1111", { kind: "added", touched: true })],
    };
    const next = plan(record(), edited, "blank_fields", lastPick);
    expect(next.removeRows).toEqual([]);
    expect(next.summary.staleRows).toEqual(["CO PT-1111"]);
    expect(npiFillAnnouncement(next.summary)).toContain(
      "From the previous pick — remove if it doesn't apply: CO PT-1111.",
    );
    // From now on the row is staff's.
    expect(applied(edited, next).licenses[0].origin).toBeNull();
  });
});

describe("planNpiRegistryFill — after staff verify or fail a row a pick filled", () => {
  it("keeps the number, lists it as the previous pick's, and offers the new match's license", () => {
    const start = blankForm({ licenses: [row("CO")] });
    const first = plan(denver, start);
    const afterFirst = applied(start, first);
    expect(afterFirst.licenses[0]).toEqual(
      row("CO", "PT-1111", { kind: "number", touched: false }),
    );
    // Staff mark the row Failed (or Verified): its verification is recorded.
    const failed: NpiFillForm = {
      ...afterFirst,
      licenses: [{ ...afterFirst.licenses[0], numberLocked: true }],
    };
    const second = plan(record(), failed, "blank_fields", first.trace);
    // Never a verified or failed row with no number.
    expect(applied(failed, second).licenses).toEqual([row("CO", "PT-1111", null, true)]);
    expect(second.summary.cleared).not.toContain("CO license number");
    expect(second.summary.staleRows).toEqual(["CO PT-1111"]);
    expect(second.summary.kept).toEqual([]);
    expect(second.summary.licenseOffers).toContainEqual({
      state: "CO",
      number: "PT-4471",
      added: false,
    });
  });

  it("says nothing more when the new match lists the same license", () => {
    const start = blankForm({ licenses: [row("CO")] });
    const first = plan(denver, start);
    const failed = {
      ...applied(start, first),
      licenses: [row("CO", "PT-1111", { kind: "number", touched: false }, true)],
    };
    const again = plan(denver, failed, "blank_fields", first.trace);
    expect(again.summary.staleRows).toEqual([]);
    expect(again.summary.licenseOffers).toEqual([]);
  });
});

describe("planNpiRegistryFill — an added row that filled the empty starting row", () => {
  it("comes back as that empty row when the next pick takes it back", () => {
    const afterAdd = blankForm({
      licenses: [row("CO", "PT-1111", { kind: "added", touched: false, replacedEmpty: true })],
    });
    const next = plan(record(), afterAdd, "blank_fields", null);
    expect(next.resetRows).toEqual([0]);
    expect(next.removeRows).toEqual([]);
    expect(applied(afterAdd, next).licenses).toEqual([row("")]);
    expect(next.summary.cleared).toEqual(["CO license row"]);
  });
});

describe("planNpiRegistryFill — registry data with no form field", () => {
  it("lists it read-only, in a stable order, never the taxonomy the form holds", () => {
    expect(plan(record(), blankForm()).summary.details).toEqual([
      { label: "Middle name", lines: ["M"] },
      { label: "Suffix", lines: ["JR"] },
      { label: "Other taxonomies", lines: ["225100000X (Physical Therapist)"] },
      {
        label: "Practice address",
        lines: ["200 CLINIC WAY, SUITE 4, BOULDER, CO 80302-1234 · 303-555-0199"],
      },
      { label: "Mailing address", lines: ["PO BOX 12, BOULDER, CO 80306"] },
      { label: "Other names", lines: ["JANE SMITH (Former Name)"] },
      { label: "Other identifiers", lines: ["MEDICAID CO-MCD-77 (CO)"] },
    ]);
    // A stored 225100000X is the form's: not listed again.
    const held = plan(record(), blankForm({ taxonomyCode: "225100000X" }));
    expect(held.summary.details.map((detail) => detail.label)).not.toContain("Other taxonomies");
  });

  it("names a foreign country and skips empty address parts", () => {
    expect(
      formatRegistryAddress({
        line1: "1 RUE X",
        line2: null,
        city: "PARIS",
        state: null,
        postalCode: "75001",
        countryCode: "FR",
        phone: null,
      }),
    ).toBe("1 RUE X, PARIS, 75001, FR");
  });
});

describe("planNpiRegistryFill — npi_only", () => {
  it("sets the NPI alone and lists what blank_fields would have filled", () => {
    const next = plan(record(), blankForm({ licenses: [row("CO")] }), "npi_only");
    expect(next).toMatchObject({
      npi: "1902833742",
      credentials: null,
      taxonomyCode: null,
      licenseRows: [],
    });
    expect(next.summary.filled).toEqual(["NPI"]);
    expect(next.summary.kept).toEqual([]);
    expect(next.summary.licenseOffers).toEqual([]);
    expect(next.summary.details.map((detail) => detail.label)).toEqual([
      "Credentials",
      "Primary taxonomy",
      "Licenses",
      "Middle name",
      "Suffix",
      "Other taxonomies",
      "Practice address",
      "Mailing address",
      "Other names",
      "Other identifiers",
    ]);
    expect(next.summary.details[2]).toEqual({
      label: "Licenses",
      lines: ["CO PT-4471", "WY WY-0099"],
    });
  });

  it("is the same whatever the form already holds", () => {
    const typed = blankForm({
      credentials: "PT",
      taxonomyCode: "225100000X",
      licenses: [row("CO", "X")],
    });
    const next = plan(record(), typed, "npi_only");
    expect(next.summary.kept).toEqual([]);
    expect(next.licenseRows).toEqual([]);
  });
});

describe("npiFillAnnouncement", () => {
  it("says what was filled, cleared and kept, and that licenses can be added", () => {
    const next = plan(
      record(),
      blankForm({ credentials: "PT", credentialsTouched: true, licenses: [row("CO")] }),
    );
    expect(npiFillAnnouncement(next.summary)).toBe(
      "Filled from the NPI Registry: NPI, Taxonomy code, CO license number. " +
        "Kept yours: Credentials — registry has DPT. " +
        "The registry lists 1 license that is not on the form. " +
        "Add them below if they apply.",
    );
  });

  it("says so when there was nothing blank to fill", () => {
    expect(
      npiFillAnnouncement({
        filled: [],
        cleared: [],
        kept: [],
        staleRows: [],
        licenseOffers: [],
        details: [],
        taxonomyChoices: [],
      }),
    ).toBe("Nothing blank to fill from the NPI Registry.");
  });
});

// A35: several candidates of one kind are a pick list with nothing
// preselected — never the first, never all.
describe("planNpiRegistryFill — several taxonomies and no primary", () => {
  const noPrimary = record({
    primaryTaxonomy: null,
    taxonomies: [
      {
        code: "225100000X",
        description: "Physical Therapist",
        primary: false,
        license: null,
        licenseState: null,
      },
      {
        code: "2251X0800X",
        description: "Physical Therapist, Orthopedic",
        primary: false,
        license: null,
        licenseState: null,
      },
      {
        code: "2251X0800X",
        description: "Physical Therapist, Orthopedic",
        primary: false,
        license: null,
        licenseState: null,
      },
    ],
  });

  it("offers each known code once to choose, and fills none of them", () => {
    const next = plan(noPrimary, blankForm());
    expect(next.taxonomyCode).toBeNull();
    expect(next.summary.filled).not.toContain("Taxonomy code");
    expect(next.summary.taxonomyChoices).toEqual([
      { code: "225100000X", description: "Physical Therapist" },
      { code: "2251X0800X", description: "Physical Therapist, Orthopedic" },
    ]);
    // Listed once, as choices, not again under "Other taxonomies".
    expect(next.summary.details.find((item) => item.label === "Other taxonomies")).toBeUndefined();
    expect(npiFillAnnouncement(next.summary)).toContain(
      "The registry lists several taxonomies and none as primary; choose one below.",
    );
  });

  it("leaves the untouched preset as it is: a default, not a registry pick", () => {
    const next = plan(
      noPrimary,
      blankForm({ taxonomyCode: "225100000X", taxonomyPreset: "225100000X" }),
    );
    expect(next.taxonomyCode).toBeNull();
    expect(next.summary.taxonomyChoices).toHaveLength(2);
  });

  it("offers no choice when there is one code, or a primary, or under npi_only", () => {
    const one = record({
      primaryTaxonomy: null,
      taxonomies: [
        {
          code: "225100000X",
          description: null,
          primary: false,
          license: null,
          licenseState: null,
        },
      ],
    });
    expect(plan(one, blankForm()).summary.taxonomyChoices).toEqual([]);
    expect(plan(record(), blankForm()).summary.taxonomyChoices).toEqual([]);
    expect(plan(noPrimary, blankForm(), "npi_only").summary.taxonomyChoices).toEqual([]);
  });

  it("offers the one code the list offers as a choice, not prefilled, when the registry names several", () => {
    const withUnknown = record({
      primaryTaxonomy: null,
      taxonomies: [
        {
          code: "225100000X",
          description: null,
          primary: false,
          license: null,
          licenseState: null,
        },
        {
          code: "999999999X",
          description: "Unlisted",
          primary: false,
          license: null,
          licenseState: null,
        },
      ],
    });
    const next = plan(withUnknown, blankForm());
    // Before: no choice at all (fewer than two known codes). Now the known
    // code is offered, and still nothing is filled (A35).
    expect(next.summary.taxonomyChoices).toEqual([{ code: "225100000X", description: null }]);
    expect(next.taxonomyCode).toBeNull();
    expect(next.summary.filled).not.toContain("Taxonomy code");
    expect(next.summary.details).toContainEqual({
      label: "Other taxonomies",
      lines: ["999999999X (Unlisted)"],
    });
  });
});

describe("registry-sourced values (A35)", () => {
  const pulledAt = "2026-10-31T15:00:00.000Z";
  const pick = (over: Partial<NpiPickState> = {}): NpiPickState => ({
    seq: 1,
    npi: "1902833742",
    trace: {
      credentials: { written: "DPT", previous: "" },
      taxonomyCode: { written: "2251X0800X", previous: "225100000X" },
    },
    summary: plan(record(), blankForm()).summary,
    pulledAt,
    ...over,
  });
  const form = {
    credentials: "DPT",
    credentialsTouched: false,
    taxonomyCode: "2251X0800X",
    taxonomyTouched: false,
    licenses: [
      {
        state: "CO",
        number: "PT-4471",
        origin: { kind: "number" as const, touched: false, pulledAt },
      },
      { state: "WY", number: "WY-1", origin: { kind: "added" as const, touched: true, pulledAt } },
      { state: "UT", number: "UT-9", origin: null },
    ],
  };

  it('labels a value "From NPI Registry, <pull date>"', () => {
    expect(npiRegistrySourceLabel(pulledAt)).toBe("From NPI Registry, Oct 31, 2026");
  });

  it("lists what still holds the pick's values, untouched, one line per pull date", () => {
    const sourced = npiRegistrySourcedFields(pick(), form);
    expect(sourced.credentials).toBe(true);
    expect(sourced.taxonomyCode).toBe(true);
    expect(sourced.lines).toEqual([
      {
        label: "From NPI Registry, Oct 31, 2026",
        values: ["Credentials DPT", "Taxonomy code 2251X0800X", "CO license PT-4471"],
      },
    ]);
  });

  it("drops a value staff touched, or one that no longer holds what the pick wrote", () => {
    const sourced = npiRegistrySourcedFields(pick(), {
      ...form,
      credentialsTouched: true,
      taxonomyCode: "225100000X",
    });
    expect(sourced.credentials).toBe(false);
    expect(sourced.taxonomyCode).toBe(false);
    expect(sourced.lines[0].values).toEqual(["CO license PT-4471"]);
  });

  it("keeps a row added from an earlier pull under that pull's date", () => {
    const earlier = "2026-10-30T15:00:00.000Z";
    const sourced = npiRegistrySourcedFields(pick(), {
      ...form,
      licenses: [
        {
          state: "WY",
          number: "WY-0099",
          origin: { kind: "added" as const, touched: false, pulledAt: earlier },
        },
      ],
    });
    expect(sourced.lines).toEqual([
      {
        label: "From NPI Registry, Oct 31, 2026",
        values: ["Credentials DPT", "Taxonomy code 2251X0800X"],
      },
      { label: "From NPI Registry, Oct 30, 2026", values: ["WY license WY-0099"] },
    ]);
  });

  it("says nothing before any pick", () => {
    expect(npiRegistrySourcedFields(null, { ...form, licenses: [] })).toEqual({
      credentials: false,
      taxonomyCode: false,
      lines: [],
    });
  });
});
