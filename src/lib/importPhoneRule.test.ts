// MINT-91 Addendum 8 (A5): a NEW import row whose phone fails is created
// without the phone and warned about (default), or blocked (the MINT-129
// alternative). Run end to end through the real dedupe, then the rule, then
// the commit plan, so "never writes the bad phone" is checked on the wire.
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
  applyProviderImportPhoneRule(dedupeImportRows(providerInputs(rows)), rules);

const creates = (out: ImportRowDisposition[]) =>
  out.filter((d): d is CreateDisposition => d.kind === "create");

const WARNING = "Warning: phone is not a 10-digit US phone number, so it is left blank";

describe("provider import — invalid phone, default: create without it and warn", () => {
  it("creates the NEW provider with the phone left blank and a warning naming the column", () => {
    const out = providers([providerRow(2, NEW_NPI, "abc-def-ghij")]);
    expect(out.map((d) => d.kind)).toEqual(["create"]);
    const [create] = creates(out);
    expect(create.provider.phone).toBeNull();
    expect(create.warnings).toEqual([{ line: 2, column: "phone", reason: WARNING }]);
    expect(buildCommitPlan(out, {}).creates[0].provider.phone).toBeNull();
    expect(buildCommitPlan(out, {}).blocked_entries).toEqual([]);
  });

  it("never writes the bad phone from a later row of the same provider", () => {
    const out = providers([
      providerRow(2, NEW_NPI, "abc-def-ghij"),
      providerRow(3, NEW_NPI, "abc-def-ghij"),
    ]);
    expect(out.map((d) => d.kind)).toEqual(["create"]);
    expect(creates(out)[0].lines).toEqual([2, 3]);
    expect(buildCommitPlan(out, {}).creates[0].provider.phone).toBeNull();

    // A valid first row wins; a later row's bad phone is never written either.
    const validFirst = providers([
      providerRow(2, NEW_NPI, "910-555-0100"),
      providerRow(3, NEW_NPI, "abc-def-ghij"),
    ]);
    expect(buildCommitPlan(validFirst, {}).creates[0].provider.phone).toBe("910-555-0100");
    expect(creates(validFirst)[0].warnings).toBeUndefined();
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

describe("provider import — invalid phone, block_row (MINT-129 alternative)", () => {
  it("blocks the row, and every later row of that provider, naming the column", () => {
    const out = providers(
      [
        providerRow(2, NEW_NPI, "abc-def-ghij"),
        providerRow(3, NEW_NPI, "910-555-0100"),
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
});

describe("group import — invalid phone", () => {
  const groupRow = (line: number, tin: string, phones: Record<string, string | null>) =>
    row(line, { name: `Group ${tin}`, tin, ...phones });

  it("default: leaves each bad block phone blank; inherited copies share billing's one warning", () => {
    const result = applySectionImportPhoneRule(
      dedupeGroupRows(
        [
          groupRow(2, "555001234", {
            billing_phone: "abc-def-ghij",
            corr_phone: "abc-def-ghij",
            cred_phone: "abc-def-ghij",
          }),
          groupRow(3, "555009999", { billing_phone: "919-555-0100", cred_phone: "555-01" }),
        ],
        [GROUP1],
      ),
      "provider_group",
    );
    expect(result.blocked).toEqual([]);
    expect(result.creates.map((c) => c.mapped.billing_phone)).toEqual([null, "919-555-0100"]);
    expect(result.creates[0].mapped).toMatchObject({ corr_phone: null, cred_phone: null });
    expect(result.creates[0].warnings?.map((w) => w.column)).toEqual(["billing_phone"]);
    expect(result.creates[1].mapped.cred_phone).toBeNull();
    expect(result.creates[1].warnings).toEqual([
      {
        line: 3,
        column: "cred_phone",
        reason: "Warning: cred_phone is not a 10-digit US phone number, so it is left blank",
      },
    ]);
  });

  it("default: a later row with the same TIN is skipped, so its phone is never written", () => {
    const result = applySectionImportPhoneRule(
      dedupeGroupRows(
        [
          groupRow(2, "555001234", { billing_phone: "abc-def-ghij" }),
          groupRow(3, "555001234", { billing_phone: "abc-def-ghij" }),
        ],
        [GROUP1],
      ),
      "provider_group",
    );
    expect(result.creates.map((c) => c.line)).toEqual([2]);
    expect(result.skips.map((s) => s.line)).toEqual([3]);
  });

  it("never touches an EXISTING group (matched by TIN)", () => {
    const result = applySectionImportPhoneRule(
      dedupeGroupRows([groupRow(2, GROUP1.tin, { billing_phone: "abc-def-ghij" })], [GROUP1]),
      "provider_group",
      BLOCK,
    );
    expect(result.skips).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
  });

  it("block_row: blocks on the first bad column; a repeat of its TIN creates nothing", () => {
    const result = applySectionImportPhoneRule(
      dedupeGroupRows(
        [
          groupRow(2, "555001234", { corr_phone: "555-01" }),
          groupRow(3, "555001234", { billing_phone: "919-555-0100" }),
        ],
        [GROUP1],
      ),
      "provider_group",
      BLOCK,
    );
    expect(result.creates).toEqual([]);
    expect(result.skips.map((s) => s.line)).toEqual([3]);
    expect(result.blocked).toEqual([
      {
        line: 2,
        column: "corr_phone",
        displayName: "Group 555001234",
        reason: "corr_phone must be a 10-digit US phone number",
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

  it("default: leaves each bad phone column blank with its own warning", () => {
    const result = applySectionImportPhoneRule(
      dedupeFacilityRows(
        [row(2, { ...base, phone: "CALL-NOW", appointment_phone: "910-555-0100 ext. 4" })],
        [GROUP1],
        facilities,
      ),
      "facility",
    );
    expect(result.creates[0].mapped).toMatchObject({
      phone: null,
      appointment_phone: "910-555-0100 ext. 4",
    });
    expect(result.creates[0].warnings?.map((w) => w.column)).toEqual(["phone"]);
  });

  it("block_row: blocks the row; an EXISTING facility is still skipped", () => {
    const result = applySectionImportPhoneRule(
      dedupeFacilityRows(
        [
          row(2, { ...base, appointment_phone: "555-01" }),
          row(3, { ...base, street: "10 River Rd", phone: "abc-def-ghij" }),
        ],
        [GROUP1],
        facilities,
      ),
      "facility",
      BLOCK,
    );
    expect(result.creates).toEqual([]);
    expect(result.blocked.map((b) => [b.line, b.column])).toEqual([[2, "appointment_phone"]]);
    expect(result.skips.map((s) => s.line)).toEqual([3]);
  });
});

describe("run report entries", () => {
  it("collects the creates' warnings and never appends one twice", () => {
    const out = providers([providerRow(2, NEW_NPI, "abc-def-ghij")]);
    const warnings = importWarningEntries(out);
    expect(warnings).toEqual([{ line: 2, column: "phone", reason: WARNING }]);
    const scanError = { line: 5, column: "npi", reason: "npi is required" };
    const once = withReportEntries([scanError], warnings);
    expect(once).toEqual([scanError, ...warnings]);
    expect(withReportEntries(once, warnings)).toEqual(once);
  });
});
