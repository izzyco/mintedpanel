// MINT-91 Addendum 8 (A5): a NEW import row whose phone fails takes the first
// valid phone among the record's other rows; with none, it is created without
// the phone and warned about (default), or blocked (the MINT-129 alternative).
// Run end to end through the real dedupe, then the rule, then the commit plan,
// so "never writes the bad phone, never drops a good one" is checked on the wire.
import { describe, expect, it } from "vitest";
import {
  buildCommitPlan,
  dedupeFacilityRows,
  dedupeGroupRows,
  dedupeImportRows,
  type CreateDisposition,
  type DedupeInputs,
  type ImportRowDisposition,
  type StagedImportRow,
} from "@/lib/importDedupe";
import {
  applyProviderImportPhoneRule,
  applySectionImportPhoneRule,
  importWarningEntries,
  phonesLeftBlank,
  withReportEntries,
} from "@/lib/importPhoneRule";
import { DEFAULT_PHONE_VALIDATION_RULES, type PhoneValidationRules } from "@/lib/phone";

const BLOCK: PhoneValidationRules = {
  ...DEFAULT_PHONE_VALIDATION_RULES,
  importInvalidPhone: "block_row",
};

// Check-digit-valid NPIs, so the rows stay on the phone path once the MINT-7
// NPI check digit binds new identities too.
const JANE = {
  id: "prov-jane",
  firstName: "Jane",
  lastName: "Shelby",
  npi: "1093817462",
  specialty: "Physical Therapy",
};
const NEW_NPI = "1112223338";
const GROUP1 = { id: "grp-1", name: "Shelby Group 1", tin: "123456789" };
const FAC1 = { id: "fac-1", name: "Shelby Clinic North" };

const row = (line: number, mapped: Record<string, string | null>): StagedImportRow => ({
  line,
  mapped,
});

function providerInputs(rows: StagedImportRow[]): DedupeInputs {
  return {
    rows,
    providers: [JANE],
    groups: [GROUP1],
    facilities: [FAC1],
    groupAssignments: [{ providerId: JANE.id, groupId: GROUP1.id }],
    facilityAssignments: [{ providerId: JANE.id, facilityId: FAC1.id }],
    licenses: [],
  };
}

const providerRow = (line: number, npi: string, phone: string | null): StagedImportRow =>
  row(line, {
    provider_first_name: npi === JANE.npi ? "Jane" : "Nora",
    provider_last_name: npi === JANE.npi ? "Shelby" : "Newton",
    npi,
    phone,
    group_name: GROUP1.name,
    group_tin: GROUP1.tin,
    facility_name: FAC1.name,
  });

const providers = (rows: StagedImportRow[], rules?: PhoneValidationRules) =>
  applyProviderImportPhoneRule(dedupeImportRows(providerInputs(rows)), rows, rules);

const creates = (out: ImportRowDisposition[]) =>
  out.filter((d): d is CreateDisposition => d.kind === "create");

const plannedPhone = (out: ImportRowDisposition[]) =>
  buildCommitPlan(out, {}).creates.map((c) => c.provider.phone);

describe("provider import — invalid first-row phone", () => {
  it("with no valid phone in its rows: created without it, warned (value on screen, not in the report)", () => {
    const out = providers([providerRow(2, NEW_NPI, "abc-def-ghij")]);
    expect(out.map((d) => d.kind)).toEqual(["create"]);
    expect(plannedPhone(out)).toEqual([null]);
    expect(creates(out)[0].warnings).toEqual([
      {
        line: 2,
        column: "phone",
        reason: "Warning: Phone isn't a US number, so it was left blank.",
        review: 'Phone "abc-def-ghij" isn\'t a US number, so it will be left blank.',
        leftBlank: true,
      },
    ]);
    expect(phonesLeftBlank(out)).toBe(1);
  });

  it("takes the first valid phone from a later row of the same provider (P2-1)", () => {
    const out = providers([
      providerRow(2, NEW_NPI, "abc-def-ghij"),
      providerRow(3, NEW_NPI, "910-555-0100"),
      providerRow(4, NEW_NPI, "910-555-0199"),
    ]);
    expect(out.map((d) => d.kind)).toEqual(["create"]);
    expect(plannedPhone(out)).toEqual(["910-555-0100"]);
    const [create] = creates(out);
    expect(create.warnings).toEqual([
      {
        line: 2,
        column: "phone",
        reason: "Warning: Phone isn't a US number, so row 3's phone was used.",
        review: "Phone \"abc-def-ghij\" isn't a US number, so row 3's phone is used.",
        leftBlank: false,
      },
    ]);
    expect(phonesLeftBlank(out)).toBe(0);
    // The fold note no longer claims the first row's phone is used.
    expect(create.notes.some((n) => /phone/.test(n) && /first row's values/.test(n))).toBe(false);
    expect(create.notes).toContain(
      `Row 4 lists a different phone for NPI ${NEW_NPI} — row 3's phone is used`,
    );
  });

  it("never writes a later row's bad phone: all invalid stays blank, a valid first row wins", () => {
    expect(
      plannedPhone(
        providers([providerRow(2, NEW_NPI, "abc-def-ghij"), providerRow(3, NEW_NPI, "555-01")]),
      ),
    ).toEqual([null]);
    const validFirst = providers([
      providerRow(2, NEW_NPI, "910-555-0100"),
      providerRow(3, NEW_NPI, "abc-def-ghij"),
    ]);
    expect(plannedPhone(validFirst)).toEqual(["910-555-0100"]);
    expect(creates(validFirst)[0].warnings).toBeUndefined();
    expect(creates(validFirst)[0].notes.join(" ")).toMatch(/phone.*first row's values are used/);
  });

  it("leaves a blank or valid phone, and an EXISTING provider's row, untouched", () => {
    for (const phone of [null, "+1 (910) 555-0100"]) {
      const out = providers([providerRow(2, NEW_NPI, phone)]);
      expect(creates(out)[0].provider.phone).toBe(phone);
      expect(creates(out)[0].warnings).toBeUndefined();
    }
    expect(providers([providerRow(2, JANE.npi, "abc-def-ghij")]).map((d) => d.kind)).toEqual([
      "skip",
    ]);
  });
});

describe("provider import — block_row (MINT-129 alternative)", () => {
  it("blocks every row of a provider with no valid phone, naming the column", () => {
    const out = providers(
      [
        providerRow(2, NEW_NPI, "abc-def-ghij"),
        providerRow(3, NEW_NPI, "555-01"),
        providerRow(4, JANE.npi, "abc-def-ghij"),
      ],
      BLOCK,
    );
    expect(out.map((d) => [d.kind, d.line])).toEqual([
      ["blocked", 2],
      ["blocked", 3],
      ["skip", 4],
    ]);
    expect(out[0]).toMatchObject({
      column: "phone",
      reason: "phone must be a 10-digit US phone number",
    });
    expect(out[1]).toMatchObject({
      column: "npi",
      reason: `Same provider (NPI ${NEW_NPI}) as row 2, which is blocked`,
    });
    expect(buildCommitPlan(out, {}).creates).toEqual([]);
  });

  it("creates the provider when a later row supplies a valid phone", () => {
    const out = providers(
      [providerRow(2, NEW_NPI, "abc-def-ghij"), providerRow(3, NEW_NPI, "910-555-0100")],
      BLOCK,
    );
    expect(plannedPhone(out)).toEqual(["910-555-0100"]);
  });
});

describe("group import — invalid phone", () => {
  const groupRow = (line: number, tin: string, phones: Record<string, string | null>) =>
    row(line, { name: `Group ${tin}`, tin, ...phones });
  const groups = (rows: StagedImportRow[], rules?: PhoneValidationRules) =>
    applySectionImportPhoneRule(dedupeGroupRows(rows, [GROUP1]), "provider_group", rows, rules);

  it("default: leaves each bad block phone blank; inherited copies share billing's one warning", () => {
    const result = groups([
      groupRow(2, "555001234", {
        billing_phone: "abc-def-ghij",
        corr_phone: "abc-def-ghij",
        cred_phone: "abc-def-ghij",
      }),
      groupRow(3, "555009999", { billing_phone: "919-555-0100", cred_phone: "555-01" }),
    ]);
    expect(result.blocked).toEqual([]);
    expect(result.creates[0].mapped).toMatchObject({
      billing_phone: null,
      corr_phone: null,
      cred_phone: null,
    });
    expect(result.creates[0].warnings?.map((w) => w.review)).toEqual([
      'Billing phone "abc-def-ghij" isn\'t a US number, so it will be left blank.',
    ]);
    expect(result.creates[1].mapped).toMatchObject({
      billing_phone: "919-555-0100",
      cred_phone: null,
    });
    expect(result.creates[1].warnings?.map((w) => w.reason)).toEqual([
      "Warning: Credentialing phone isn't a US number, so it was left blank.",
    ]);
    expect(phonesLeftBlank(result.creates)).toBe(2);
  });

  it("takes a valid phone from a later row with the same TIN (P2-1)", () => {
    const result = groups([
      groupRow(2, "555001234", { billing_phone: "abc-def-ghij", corr_phone: "abc-def-ghij" }),
      groupRow(3, "555001234", { billing_phone: "919-555-0100", corr_phone: "919-555-0100" }),
    ]);
    expect(result.creates.map((c) => c.line)).toEqual([2]);
    expect(result.creates[0].mapped).toMatchObject({
      billing_phone: "919-555-0100",
      corr_phone: "919-555-0100",
    });
    expect(result.creates[0].warnings?.map((w) => w.review)).toEqual([
      "Billing phone \"abc-def-ghij\" isn't a US number, so row 3's billing phone is used.",
    ]);
    expect(result.skips.map((s) => s.line)).toEqual([3]);
  });

  it("never touches an EXISTING group (matched by TIN)", () => {
    const result = groups([groupRow(2, GROUP1.tin, { billing_phone: "abc-def-ghij" })], BLOCK);
    expect(result.skips).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
  });

  it("block_row: blocks the record, and its repeat says which row is blocked (P3-4)", () => {
    const result = groups(
      [
        groupRow(2, "555001234", { corr_phone: "555-01" }),
        groupRow(3, "555001234", { billing_phone: "919-555-0100" }),
      ],
      BLOCK,
    );
    expect(result.creates).toEqual([]);
    expect(result.skips).toEqual([]);
    expect(result.blocked).toEqual([
      {
        line: 2,
        column: "corr_phone",
        displayName: "Group 555001234",
        reason: "corr_phone must be a 10-digit US phone number",
      },
      {
        line: 3,
        column: "group_tin",
        displayName: "Group 555001234",
        reason: "Duplicate TIN 555001234 in this file — row 2 is blocked",
      },
    ]);
  });
});

describe("facility import — invalid phone", () => {
  const facilities = [
    {
      id: "fac-river",
      name: "River Clinic",
      groupId: GROUP1.id,
      street: "10 River Rd",
      city: "Wilmington",
      state: "NC",
      zip: "28401",
    },
  ];
  const base = {
    facility_name: "River Clinic",
    group_tin: GROUP1.tin,
    street: "20 Ocean Ave",
    city: "Wilmington",
    state: "NC",
    zip: "28401",
  };
  const run = (rows: StagedImportRow[], rules?: PhoneValidationRules) =>
    applySectionImportPhoneRule(
      dedupeFacilityRows(rows, [GROUP1], facilities),
      "facility",
      rows,
      rules,
    );

  it("default: leaves each bad phone column blank with its own warning", () => {
    const result = run([
      row(2, { ...base, phone: "CALL-NOW", appointment_phone: "910-555-0100 ext. 4" }),
    ]);
    expect(result.creates[0].mapped).toMatchObject({
      phone: null,
      appointment_phone: "910-555-0100 ext. 4",
    });
    expect(result.creates[0].warnings?.map((w) => w.review)).toEqual([
      'Phone "CALL-NOW" isn\'t a US number, so it will be left blank.',
    ]);
  });

  it("takes a valid phone from a later row for the same facility (P2-1)", () => {
    const result = run([
      row(2, { ...base, phone: "CALL-NOW" }),
      row(3, { ...base, phone: "910-555-0123" }),
    ]);
    expect(result.creates[0].mapped.phone).toBe("910-555-0123");
    expect(result.creates[0].warnings?.[0]).toMatchObject({ leftBlank: false });
  });

  it("block_row: blocks the record and its repeat; an EXISTING facility is still skipped", () => {
    const result = run(
      [
        row(2, { ...base, appointment_phone: "555-01" }),
        row(3, { ...base }),
        row(4, { ...base, street: "10 River Rd", phone: "abc-def-ghij" }),
      ],
      BLOCK,
    );
    expect(result.creates).toEqual([]);
    expect(result.blocked.map((b) => [b.line, b.column, b.reason])).toEqual([
      [2, "appointment_phone", "appointment_phone must be a 10-digit US phone number"],
      [
        3,
        "facility_name",
        "Duplicate facility (same group, name and address) in this file — row 2 is blocked",
      ],
    ]);
    expect(result.skips.map((s) => s.line)).toEqual([4]);
  });
});

describe("run report entries", () => {
  it("keep the column and label-only reason, never the value, and never repeat", () => {
    const out = providers([providerRow(2, NEW_NPI, "abc-def-ghij")]);
    const entries = importWarningEntries(out);
    expect(entries).toEqual([
      {
        line: 2,
        column: "phone",
        reason: "Warning: Phone isn't a US number, so it was left blank.",
        severity: "warning",
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("abc-def-ghij");
    const scanError = { line: 5, column: "npi", reason: "npi is required" };
    const once = withReportEntries([scanError], entries);
    expect(once).toEqual([scanError, ...entries]);
    expect(withReportEntries(once, entries)).toEqual(once);
  });
});
