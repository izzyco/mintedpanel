// The registry additions' closed vocabularies stay in step with what they
// describe: roster_export.override's rule_code and field_key with the roster
// validator's overrideable rules and the seeded payer templates, and
// digest.step_unusable's problem with #563's codes. Each list is sorted in byte
// order with no repeats, and each value is a plain token.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHECKS,
  CONTEXT_DIGIT_RUN_PATTERN,
  CONTEXT_TOKEN_PATTERN,
  DIGEST_STEP_PROBLEMS,
  ROSTER_OVERRIDE_FIELDS,
  ROSTER_OVERRIDE_RULES,
  isAdvisoryContextValid,
  pickDeclared,
} from "./advisoryChecks";
import { evaluateRosterSource } from "./rosterValidation";
import type { RosterMapping, RosterTemplate } from "@/types";

/** A validator field key as its token: "provider.npi" is "provider_npi". */
const token = (fieldKey: string) => fieldKey.replace(/\./g, "_");

// One row that breaks every overrideable rule at once: a blank required
// value, an NPI that fails its check digit, a short phone, an unreadable
// date, a location with no street, city or state and a five-digit ZIP, and
// no license.
const template: RosterTemplate = {
  id: "template-1",
  slug: "m134-every-rule",
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

describe("closed vocabularies of the registry additions", () => {
  it.each([
    ["rule_code", ROSTER_OVERRIDE_RULES],
    ["field_key", ROSTER_OVERRIDE_FIELDS],
    ["problem", DIGEST_STEP_PROBLEMS],
  ] as const)("%s is sorted in byte order, with no repeats, of plain tokens", (_key, list) => {
    expect(list.every((value, index) => index === 0 || list[index - 1] < value)).toBe(true);
    for (const value of list) {
      expect(value).toMatch(CONTEXT_TOKEN_PATTERN);
      expect(value).not.toMatch(CONTEXT_DIGIT_RUN_PATTERN);
    }
  });

  it("rule_code names exactly the rules the validator lets a coordinator override", () => {
    const rules = [...new Set(overrideableIssues().map((issue) => issue.ruleCode))].sort();
    expect(rules).toEqual([...ROSTER_OVERRIDE_RULES]);
  });

  it('field_key holds every field an overrideable issue names, its "." written "_"', () => {
    for (const issue of overrideableIssues()) {
      expect(ROSTER_OVERRIDE_FIELDS, issue.fieldKey).toContain(token(issue.fieldKey));
    }
  });

  it("field_key is the seeded templates' columns and the row checks' source fields, nothing else", () => {
    const columns = seededColumnKeys();
    expect(columns.length).toBeGreaterThan(10);
    const sourceFields = overrideableIssues()
      .map((issue) => issue.fieldKey)
      .filter((key) => key.includes("."))
      .map(token);
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

  it("roster_export.override carries the rule, the field and the row count, and nothing typed", () => {
    const def = CHECKS["roster_export.override"];
    expect([...def.contextKeys].sort()).toEqual(["count", "field_key", "rule_code"]);
    const context = { rule_code: "provider_npi_invalid", field_key: "provider_npi", count: 120 };
    expect(pickDeclared(def, context)).toEqual(context);
    expect(isAdvisoryContextValid(context)).toBe(true);
    expect(
      pickDeclared(def, {
        rule_code: "ZIP_PLUS_4_REQUIRED",
        field_key: "provider.npi",
        reason: "payer confirmed by phone",
        count: 3,
      }),
    ).toEqual({ count: 3 });
  });

  it("digest.step_unusable carries the problem code and the sequence", () => {
    const def = CHECKS["digest.step_unusable"];
    expect([...def.contextKeys].sort()).toEqual(["problem", "sequence_id"]);
    const sequence = "13400000-0000-4000-a000-0000000a0013";
    expect(pickDeclared(def, { problem: "several_steps", sequence_id: sequence })).toEqual({
      problem: "several_steps",
      sequence_id: sequence,
    });
    expect(pickDeclared(def, { problem: "the template was deleted" })).toEqual({});
  });
});

// The registry additions packet's context cases, verbatim: the SQL validator
// and this one accept and refuse exactly the same contexts.
function packetContextCases(): { label: string; valid: boolean; json: string }[] {
  const packet = readFileSync(
    join(process.cwd(), "supabase/tests/mint134-registry-additions.sql"),
    "utf8",
  );
  const begin = packet.indexOf("-- context-cases:begin");
  const end = packet.indexOf("-- context-cases:end");
  if (begin < 0 || end < begin) throw new Error("context-cases markers not found in the packet");
  return [
    ...packet.slice(begin, end).matchAll(/\('([a-z0-9_]+)', (true|false), '((?:[^']|'')*)'\)/g),
  ].map((m) => ({ label: m[1], valid: m[2] === "true", json: m[3].replace(/''/g, "'") }));
}

describe("the additions' context cases mirror the SQL packet", () => {
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
