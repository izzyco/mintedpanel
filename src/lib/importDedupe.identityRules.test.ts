// MINT-129 — the import under each identity validation rule. By default a row
// that matches an existing provider by NPI is never re-checked; under
// recheckStoredOnEdit it is. A new identity is checked under every rule.
import { describe, expect, it } from "vitest";
import {
  STORED_NPI_CHECK_DIGIT_REASON,
  dedupeImportRows,
  type DedupeInputs,
  type StagedImportRow,
} from "@/lib/importDedupe";
import {
  DEFAULT_IDENTITY_VALIDATION_RULES,
  NPI_CHECK_DIGIT_MESSAGE,
  type IdentityValidationRules,
} from "@/lib/providerIdentity";

const RECHECK: IdentityValidationRules = { recheckStoredOnEdit: true, deaLastNameLetter: "off" };

// 1093817465 fails the CMS check digit; 1234567893 and 1112223338 pass it.
const LEGACY = {
  id: "prov-legacy",
  firstName: "Lena",
  lastName: "Legacy",
  npi: "1093817465",
  specialty: "Physical Therapy",
};
const VALID = {
  id: "prov-valid",
  firstName: "Vera",
  lastName: "Valid",
  npi: "1234567893",
  specialty: "Physical Therapy",
};
const GROUP1 = { id: "grp-1", name: "Synthetic Group 1", tin: "123456789" };
const GROUP2 = { id: "grp-2", name: "Synthetic Group 2", tin: "987654321" };

function inputs(rows: StagedImportRow[], identityRules?: IdentityValidationRules): DedupeInputs {
  return {
    rows,
    providers: [LEGACY, VALID],
    groups: [GROUP1, GROUP2],
    facilities: [],
    groupAssignments: [
      { providerId: LEGACY.id, groupId: GROUP1.id },
      { providerId: VALID.id, groupId: GROUP1.id },
    ],
    facilityAssignments: [],
    licenses: [],
    ...(identityRules ? { identityRules } : {}),
  };
}

const rowFor = (
  line: number,
  provider: { firstName: string; lastName: string; npi: string },
): StagedImportRow => ({
  line,
  mapped: {
    provider_first_name: provider.firstName,
    provider_last_name: provider.lastName,
    npi: provider.npi,
    group_name: GROUP2.name,
    group_tin: GROUP2.tin,
  },
});

describe("dedupeImportRows — identity validation rules", () => {
  it("by default updates a provider whose stored NPI fails the check digit, with or without the rules passed", () => {
    for (const identityRules of [undefined, DEFAULT_IDENTITY_VALIDATION_RULES]) {
      const out = dedupeImportRows(inputs([rowFor(2, LEGACY)], identityRules));
      expect(out).toEqual([
        expect.objectContaining({
          kind: "update",
          providerId: LEGACY.id,
          addGroupIds: [GROUP2.id],
        }),
      ]);
    }
  });

  it("with recheckStoredOnEdit, blocks every row matching a stored NPI that fails the check digit", () => {
    const out = dedupeImportRows(inputs([rowFor(2, LEGACY), rowFor(3, LEGACY)], RECHECK));
    expect(out).toEqual([
      {
        kind: "blocked",
        line: 2,
        column: "npi",
        displayName: "Lena Legacy",
        reason: STORED_NPI_CHECK_DIGIT_REASON,
      },
      {
        kind: "blocked",
        line: 3,
        column: "npi",
        displayName: "Lena Legacy",
        reason: STORED_NPI_CHECK_DIGIT_REASON,
      },
    ]);
  });

  it("with recheckStoredOnEdit, still updates a provider whose stored NPI passes", () => {
    const out = dedupeImportRows(inputs([rowFor(2, VALID)], RECHECK));
    expect(out).toEqual([
      expect.objectContaining({ kind: "update", providerId: VALID.id, addGroupIds: [GROUP2.id] }),
    ]);
  });

  it("checks a new identity under every rule", () => {
    const newcomer = { firstName: "Nora", lastName: "Newton", npi: "1112223334" };
    for (const identityRules of [undefined, DEFAULT_IDENTITY_VALIDATION_RULES, RECHECK]) {
      const out = dedupeImportRows(inputs([rowFor(2, newcomer)], identityRules));
      expect(out).toEqual([
        expect.objectContaining({
          kind: "blocked",
          column: "npi",
          reason: NPI_CHECK_DIGIT_MESSAGE,
        }),
      ]);
      const valid = dedupeImportRows(
        inputs([rowFor(3, { ...newcomer, npi: "1112223338" })], identityRules),
      );
      expect(valid).toEqual([expect.objectContaining({ kind: "create" })]);
    }
  });
});
