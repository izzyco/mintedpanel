// MINT-136: roster_export.override's rule and field vocabularies stay in step
// with what an override can actually carry: the validator's overrideable
// rules, the seeded payer templates' column keys and the row checks' source
// fields. The packet's roster context cases run through the TypeScript
// validator too, so the SQL and the code agree.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKS, isAdvisoryContextValid, pickDeclared } from "./advisoryChecks";
import { evaluateRosterSource } from "./rosterValidation";
import {
  ROSTER_OVERRIDE_FIELDS,
  ROSTER_OVERRIDE_RULES,
  rosterFieldToken,
  rosterOverrideContext,
} from "./rosterOverrideAdvisory";
import type { RosterMapping, RosterTemplate } from "@/types";

const OVERRIDE = CHECKS["roster_export.override"];

// One row that breaks every overrideable rule at once: a blank required
// value, an NPI that fails its check digit, a short phone, an unreadable
// date, a location with no street, city or state and a five-digit ZIP, and
// no license.
const template: RosterTemplate = {
  id: "template-1",
  slug: "mint136-every-rule",
  payerName: "Test payer",
  name: "Every overrideable rule",
  schemaVersion: 1,
  verified: true,
  verificationStatus: "verified",
  grains: ["provider_location"],
  columns: [
    { key: "first_name", header: "First Name", required: true, targetType: "text" },
    { key: "npi", header: "NPI", required: true, targetType: "npi" },
    { key: "phone", header: "Phone", required: true, targetType: "phone" },
    { key: "dob", header: "Date of Birth", required: false, targetType: "date" },
    { key: "address_1", header: "Address", required: false, targetType: "text" },
  ],
};

const mapping: RosterMapping = {
  id: "mapping-1",
  orgId: "org-1",
  templateId: template.id,
  name: "Every rule",
  grain: "provider_location",
  selectedProviderIds: ["provider-1"],
  selectedFacilityIds: ["facility-1"],
  selectedGroupIds: [],
  columnAssignments: [
    { columnKey: "first_name", sourceField: "provider.first_name", transform: null },
    { columnKey: "npi", sourceField: "provider.npi", transform: null },
    { columnKey: "phone", sourceField: "facility.phone", transform: null },
    { columnKey: "dob", sourceField: "provider.date_of_birth", transform: "date_mm_dd_yyyy" },
    { columnKey: "address_1", sourceField: "facility.street", transform: null },
  ],
  revision: 1,
  updatedAt: "2026-11-01T12:00:00Z",
};

const brokenRow = {
  rowKey: "provider-1:facility-1",
  provider: { first_name: "", last_name: "Lovelace", npi: "1234567890", date_of_birth: "soon" },
  facility: {
    id: "facility-1",
    name: "North Clinic",
    street: "",
    city: "",
    state: "",
    zip: "12345",
    phone: "555",
    is_active: true,
  },
  licenses: [],
};

function overrideableIssues() {
  return evaluateRosterSource({
    mapping,
    template,
    sourceRows: [brokenRow],
    inputFingerprint: "fingerprint-1",
    validationDate: "2026-11-01",
  }).validation.issues.filter((issue) => issue.severity === "hard_error" && issue.overrideable);
}

/** Every column key the seeded payer templates declare (WP 1.3's seed). */
function seededColumnKeys(): string[] {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20260925203025_wp13_roster_engine_tables.sql"),
    "utf8",
  );
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.roster_engine_seed_templates(");
  const end = sql.indexOf("ON CONFLICT (org_id, slug) DO NOTHING;", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return [...new Set([...sql.slice(start, end).matchAll(/"key":"([^"]+)"/g)].map((m) => m[1]))];
}

describe("roster override vocabularies", () => {
  it("are sorted in byte order with no repeats", () => {
    for (const list of [ROSTER_OVERRIDE_RULES, ROSTER_OVERRIDE_FIELDS] as const) {
      expect(list.every((value, index) => index === 0 || list[index - 1] < value)).toBe(true);
    }
  });

  it("name exactly the rules the validator lets a coordinator override", () => {
    const issues = overrideableIssues();
    const rules = [...new Set(issues.map((issue) => issue.ruleCode))].sort();
    expect(rules).toEqual([...ROSTER_OVERRIDE_RULES]);
  });

  it("hold every field an overrideable issue names, with its dot spelled as an underscore", () => {
    for (const issue of overrideableIssues()) {
      expect(ROSTER_OVERRIDE_FIELDS, issue.fieldKey).toContain(rosterFieldToken(issue.fieldKey));
    }
  });

  it("hold every seeded payer template column, and the row checks' source fields, nothing else", () => {
    const columns = seededColumnKeys();
    expect(columns.length).toBeGreaterThan(10);
    const sourceFields = overrideableIssues()
      .map((issue) => issue.fieldKey)
      .filter((key) => key.includes("."))
      .map(rosterFieldToken);
    expect(sourceFields.sort()).toEqual([
      "facility_city",
      "facility_state",
      "facility_street",
      "facility_zip",
      "license_license_number",
      "provider_npi",
    ]);
    expect([...new Set([...columns, ...sourceFields])].sort()).toEqual([...ROSTER_OVERRIDE_FIELDS]);
  });

  it("are roster_export.override's declared context, with the row count", () => {
    expect([...OVERRIDE.contextKeys].sort()).toEqual(["count", "field", "rule"]);
  });
});

describe("rosterOverrideContext", () => {
  it("records the rule, the field token and the row count", () => {
    const context = rosterOverrideContext("provider_npi_invalid", "provider.npi", 120);
    expect(context).toEqual({ rule: "provider_npi_invalid", field: "provider_npi", count: 120 });
    expect(pickDeclared(OVERRIDE, context)).toEqual(context);
    expect(isAdvisoryContextValid(pickDeclared(OVERRIDE, context))).toBe(true);
  });

  it("leaves out a rule or field outside the vocabulary rather than send it as text", () => {
    const context = rosterOverrideContext("ZIP_PLUS_4_REQUIRED", "practice_zip", 1);
    expect(context).toEqual({ rule: null, field: null, count: 1 });
    expect(pickDeclared(OVERRIDE, context)).toEqual({ count: 1 });
    expect(pickDeclared(OVERRIDE, rosterOverrideContext("npi_invalid", "npi", 10_000))).toEqual({
      rule: "npi_invalid",
      field: "npi",
    });
  });

  it("can never carry a value, a name or a typed reason", () => {
    expect(
      pickDeclared(OVERRIDE, {
        rule: "jane_smith",
        field: "12345-6789",
        reason: "payer confirmed by phone",
        count: 3,
      }),
    ).toEqual({ count: 3 });
  });
});

// The packet's roster context cases, verbatim.
function packetContextCases(): { label: string; valid: boolean; json: string }[] {
  const packet = readFileSync(
    join(process.cwd(), "supabase/tests/mint136-roster-export-anyway.sql"),
    "utf8",
  );
  const begin = packet.indexOf("-- context-cases:begin");
  const end = packet.indexOf("-- context-cases:end");
  if (begin < 0 || end < begin) throw new Error("context-cases markers not found in the packet");
  return [
    ...packet.slice(begin, end).matchAll(/\('([a-z0-9_]+)', (true|false), '((?:[^']|'')*)'\)/g),
  ].map((m) => ({ label: m[1], valid: m[2] === "true", json: m[3].replace(/''/g, "'") }));
}

describe("roster context cases mirror the SQL packet", () => {
  const cases = packetContextCases();

  it("reads every case from the packet", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.some((c) => c.valid)).toBe(true);
    expect(cases.some((c) => !c.valid)).toBe(true);
    expect(new Set(cases.map((c) => c.label)).size).toBe(cases.length);
  });

  it.each(cases.map((c) => [c.label, c] as const))("%s", (_label, c) => {
    expect(isAdvisoryContextValid(JSON.parse(c.json))).toBe(c.valid);
  });
});
