import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADVISORY_LOCAL_REFUSAL,
  ADVISORY_RECHECKS,
  ADVISORY_RECORD_FAILED,
  ADVISORY_RECORD_TABLES,
  ADVISORY_RESOLVE_FAILED,
  BOUNDARY_PROTECTS,
  CHECKS,
  CHECK_DOMAINS,
  CHECK_KEY_PATTERN,
  CONTEXT_DIGIT_RUN_PATTERN,
  CONTEXT_KEYS,
  CONTEXT_MAX_COUNT_CAPACITY,
  CONTEXT_MAX_KEYS,
  CONTEXT_TOKEN_PATTERN,
  DIGEST_STEP_PROBLEMS,
  IMPORT_ADVISORY_COLUMNS,
  NONCRITICAL_PROTECTS,
  advisoryRpcFields,
  checkDefinition,
  countCapacity,
  isAdvisoryContextValid,
  isBoundaryProtection,
  isCheckKey,
  pickDeclared,
  ROSTER_OVERRIDE_FIELDS,
  ROSTER_OVERRIDE_RULES,
  reportAdvisoryFailure,
  severityFor,
  type CheckDefinition,
  type ContextKeyKind,
} from "./advisoryChecks";
import {
  FACILITY_TEMPLATE_HEADERS,
  GROUP_TEMPLATE_HEADERS,
  PROVIDER_TEMPLATE_HEADERS,
} from "./importSections";

const DEFINITIONS: [string, CheckDefinition][] = Object.entries(CHECKS);
const UUID_A = "13400000-0000-4000-a000-0000000a0001";
const UUID_B = "13400000-0000-4000-a000-0000000a0008";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("check registry contract", () => {
  it("seeds the inventory's section 4 keys, plus the registry additions", () => {
    expect(Object.keys(CHECKS).sort()).toEqual(
      [
        "assignment.start_date_missing",
        "config.override_ignored",
        "contact.phone_missing",
        "digest.org_failed",
        "digest.recipient_no_email",
        "digest.rules_fallback",
        "digest.send_time_fallback",
        "digest.step_unusable",
        "digest.unassigned_follow_ups",
        "generation.no_sop",
        "generation.required_attribute_missing",
        "generation.sop_tie",
        "import.group_npi_unusable",
        "import.npi_missing",
        "import.npi_unusable",
        "import.phone_dropped",
        "notification.cc_member_lapsed",
        "notification.schedule_invalid",
        "notification.sms_disabled",
        "notification.template_unavailable",
        "npi.missing",
        "npi.stored_check_digit_invalid",
        "npi_registry.credentials_differ",
        "npi_registry.inactive",
        "npi_registry.license_differs",
        "npi_registry.name_mismatch",
        "npi_registry.not_found",
        "npi_registry.organization_number",
        "npi_registry.taxonomy_differs",
        "npi_registry.unchecked",
        "roster_export.override",
        "task.completed_out_of_order",
        "task.step_out_of_order",
        "touch.other_without_context",
      ].sort(),
    );
  });

  it.each(DEFINITIONS)("%s: key, domain and pattern agree", (mapKey, def) => {
    expect(def.key).toBe(mapKey);
    expect(def.key).toMatch(CHECK_KEY_PATTERN);
    expect(def.key.split(".")[0]).toBe(def.domain);
    expect(CHECK_DOMAINS).toContain(def.domain);
    expect(isCheckKey(mapKey)).toBe(true);
    expect(checkDefinition(mapKey)).toBe(def);
  });

  it.each(DEFINITIONS)("%s: critical exactly when it protects a boundary", (_key, def) => {
    expect([...BOUNDARY_PROTECTS, ...NONCRITICAL_PROTECTS]).toContain(def.protects);
    expect(def.critical).toBe(isBoundaryProtection(def.protects));
    expect(severityFor(def)).toBe(def.critical ? "block" : "advisory");
  });

  it("records the design's block outcomes at severity block", () => {
    for (const key of [
      "notification.sms_disabled",
      "notification.template_unavailable",
      "digest.recipient_no_email",
      "digest.org_failed",
    ] as const) {
      expect(severityFor(CHECKS[key])).toBe("block");
    }
    const blocks = DEFINITIONS.filter(([, def]) => def.critical).map(([key]) => key);
    expect(blocks.sort()).toEqual(
      [
        "digest.org_failed",
        "digest.recipient_no_email",
        "notification.sms_disabled",
        "notification.template_unavailable",
      ].sort(),
    );
  });

  // Review of #568: step_order 123456 + earlier_open_count 7893 rebuilt an NPI.
  // Every check's count keys together hold fewer than 10,000,000 values, so
  // no check can carry a 7-digit number or longer, even split across counts.
  it.each(DEFINITIONS)("%s: its counts together can't rebuild a long number", (_key, def) => {
    expect(countCapacity(def.contextKeys)).toBeLessThan(CONTEXT_MAX_COUNT_CAPACITY);
  });

  it.each(DEFINITIONS)("%s: declares known context keys and record tables", (_key, def) => {
    expect(def.contextKeys.length).toBeLessThanOrEqual(CONTEXT_MAX_KEYS);
    expect(new Set(def.contextKeys).size).toBe(def.contextKeys.length);
    for (const key of def.contextKeys) expect(Object.keys(CONTEXT_KEYS)).toContain(key);
    expect(new Set(def.recordTables).size).toBe(def.recordTables.length);
    for (const table of def.recordTables) expect(ADVISORY_RECORD_TABLES).toContain(table);
    if (def.recheck) expect(ADVISORY_RECHECKS).toContain(def.recheck);
  });

  it.each(DEFINITIONS)("%s: help is plain why-it-matters prose", (_key, def) => {
    expect(def.help.length).toBeGreaterThan(40);
    expect(def.help.length).toBeLessThanOrEqual(240);
    expect(def.help).toMatch(/^[A-Z].*\.$/);
    // No identifiers, code or placeholders: words a coordinator reads.
    expect(def.help).not.toMatch(/[_`{}<>]|TODO|TBD/);
  });

  // #568's Question 1, answered Nov 1: the org for org-level checks, the
  // sequence for a sequence's, the membership for a digest recipient.
  it("gives every check a record table, as Question 1 decided", () => {
    expect(DEFINITIONS.filter(([, def]) => def.recordTables.length === 0)).toEqual([]);
    const tablesOf = (key: keyof typeof CHECKS) => [...CHECKS[key].recordTables];
    for (const key of [
      "config.override_ignored",
      "digest.org_failed",
      "digest.rules_fallback",
      "digest.send_time_fallback",
      "digest.step_unusable",
      "digest.unassigned_follow_ups",
    ] as const) {
      expect(tablesOf(key), key).toEqual(["organizations"]);
    }
    expect(tablesOf("notification.cc_member_lapsed")).toEqual(["notification_sequences"]);
    expect(tablesOf("notification.schedule_invalid")).toEqual(["notification_sequences"]);
    expect(tablesOf("digest.recipient_no_email")).toEqual(["memberships"]);
    expect(tablesOf("contact.phone_missing")).toEqual(["parties"]);
    // The registry's three difference checks read like the other registry
    // answers: on the provider, with the NPI save context.
    for (const key of [
      "npi_registry.credentials_differ",
      "npi_registry.taxonomy_differs",
      "npi_registry.license_differs",
    ] as const) {
      const def: CheckDefinition = CHECKS[key];
      expect(def).toMatchObject({
        domain: "npi_registry",
        protects: "completeness",
        critical: false,
      });
      expect(def.recordTables).toEqual(["providers"]);
      expect(def.contextKeys).toEqual(CHECKS["npi_registry.not_found"].contextKeys);
    }
  });
});

describe("context key vocabulary", () => {
  const entries = Object.entries(CONTEXT_KEYS) as [string, ContextKeyKind][];

  // The registry additions took the declared set past one context's 16 keys.
  // What binds is each check's own list, which pickDeclared never exceeds.
  it("declares no check with more keys than one context may hold", () => {
    expect(entries.length).toBeGreaterThan(CONTEXT_MAX_KEYS);
    expect(Math.max(...DEFINITIONS.map(([, def]) => def.contextKeys.length))).toBeLessThanOrEqual(
      CONTEXT_MAX_KEYS,
    );
  });

  it.each(entries)("%s: name and kind agree", (key, def) => {
    expect(key).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
    expect(key).not.toMatch(CONTEXT_DIGIT_RUN_PATTERN);
    expect(def.kind === "ids").toBe(key.endsWith("_ids"));
    expect(def.kind === "id").toBe(key.endsWith("_id"));
  });

  // Review of #568: an open token let "n1_2_3_4_5_6_7_8_9_3" through.
  it.each(entries)("%s: a token key has a closed vocabulary and a count a bound", (_key, def) => {
    if (def.kind === "token" || def.kind === "tokens") {
      expect(Array.isArray(def.values)).toBe(true);
      expect(def.values.length).toBeGreaterThan(0);
      expect(new Set(def.values).size).toBe(def.values.length);
      for (const value of def.values) {
        expect(value).toMatch(CONTEXT_TOKEN_PATTERN);
        expect(value).not.toMatch(CONTEXT_DIGIT_RUN_PATTERN);
      }
    }
    if (def.kind === "count") {
      expect(Number.isInteger(def.max)).toBe(true);
      expect(def.max).toBeGreaterThan(0);
      // Alone, no count can hold a 7-digit number.
      expect(def.max + 1).toBeLessThan(CONTEXT_MAX_COUNT_CAPACITY);
    }
  });

  it("names only real import template columns", () => {
    const headers = new Set<string>([
      ...GROUP_TEMPLATE_HEADERS,
      ...FACILITY_TEMPLATE_HEADERS,
      ...PROVIDER_TEMPLATE_HEADERS,
    ]);
    for (const column of IMPORT_ADVISORY_COLUMNS) expect(headers.has(column)).toBe(true);
  });
});

// The packet's context cases, verbatim: the SQL validator and this one must
// accept and refuse exactly the same contexts.
function packetContextCases(): { label: string; valid: boolean; json: string }[] {
  const packet = readFileSync(
    join(process.cwd(), "supabase/tests/mint134-workflow-advisories.sql"),
    "utf8",
  );
  const begin = packet.indexOf("-- context-cases:begin");
  const end = packet.indexOf("-- context-cases:end");
  if (begin < 0 || end < begin) throw new Error("context-cases markers not found in the packet");
  const block = packet.slice(begin, end);
  const cases: { label: string; valid: boolean; json: string }[] = [];
  for (const match of block.matchAll(/\('([a-z0-9_]+)', (true|false), '((?:[^']|'')*)'\)/g)) {
    cases.push({ label: match[1], valid: match[2] === "true", json: match[3].replace(/''/g, "'") });
  }
  return cases;
}

describe("context validator mirrors the SQL packet", () => {
  const cases = packetContextCases();

  it("reads every case from the packet", () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(cases.some((c) => c.valid)).toBe(true);
    expect(cases.some((c) => !c.valid)).toBe(true);
    expect(new Set(cases.map((c) => c.label)).size).toBe(cases.length);
  });

  it.each(cases.map((c) => [c.label, c] as const))("%s", (_label, c) => {
    expect(isAdvisoryContextValid(JSON.parse(c.json))).toBe(c.valid);
  });

  it("refuses what JSON can't carry", () => {
    expect(isAdvisoryContextValid(undefined)).toBe(false);
    expect(isAdvisoryContextValid({ line: Number.NaN })).toBe(false);
    expect(isAdvisoryContextValid({ line: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isAdvisoryContextValid({ line: undefined })).toBe(false);
    expect(isAdvisoryContextValid(new Date())).toBe(false);
    expect(isAdvisoryContextValid(new Map())).toBe(false);
  });
});

describe("pickDeclared, the second wall", () => {
  it("keeps declared keys whose values fit their kind", () => {
    expect(
      pickDeclared(CHECKS["npi_registry.not_found"], {
        import_run_id: UUID_B,
        line: 12,
        surface: "import",
      }),
    ).toEqual({ import_run_id: UUID_B, line: 12, surface: "import" });
  });

  it("refuses an undeclared key or an off-vocabulary value, in code and in SQL", () => {
    expect(isAdvisoryContextValid({ name: "smith" })).toBe(false);
    expect(isAdvisoryContextValid({ surface: "smith" })).toBe(false);
    expect(
      pickDeclared(CHECKS["npi_registry.not_found"], { name: "smith", surface: "smith" }),
    ).toEqual({});
  });

  // The review of #568's inputs, every one of which used to pass.
  it("refuses the review's encoded PII", () => {
    for (const context of [
      { problem: "n1_2_3_4_5_6_7_8_9_3" },
      { problem: "a1b2c3d4e5f6g7h8i9j3" },
      { a1_2_3_4_5_6_7_8_9_3: true },
      { jane_smith: true },
      { problem: "jane_at_example_dot_com" },
      { surface: "jane_at_example_dot_com" },
      { step_order: 123456, earlier_open_count: 7893 },
      { rule: "jane_smith", field: "n1_2_3_4_5_6_7_8_9_3" },
      { rule_code: "jane_smith", field_key: "n1_2_3_4_5_6_7_8_9_3" },
      { problem: "jane_smith" },
    ]) {
      expect(isAdvisoryContextValid(context)).toBe(false);
    }
    expect(
      pickDeclared(CHECKS["roster_export.override"], {
        rule: "jane_smith",
        field: "n1_2_3_4_5_6_7_8_9_3",
        rule_code: "jane_smith",
        field_key: "n1_2_3_4_5_6_7_8_9_3",
      }),
    ).toEqual({});
    expect(
      pickDeclared(CHECKS["task.step_out_of_order"], {
        step_order: 123456,
        earlier_open_count: 7893,
      }),
    ).toEqual({});
  });

  it("refuses counts that together could carry a 7-digit number", () => {
    expect(isAdvisoryContextValid({ line: 99_999, count: 99 })).toBe(false);
    expect(isAdvisoryContextValid({ step_order: 99, earlier_open_count: 99 })).toBe(true);
  });

  it("keeps a set: sorted, with repeats dropped, so its order carries nothing", () => {
    expect(
      pickDeclared(CHECKS["generation.required_attribute_missing"], {
        attributes: ["dob", "dob", "caqh_id"],
      }),
    ).toEqual({ attributes: ["caqh_id", "dob"] });
    expect(pickDeclared(CHECKS["generation.sop_tie"], { template_ids: [UUID_B, UUID_A] })).toEqual({
      template_ids: [UUID_A, UUID_B],
    });
    expect(isAdvisoryContextValid({ attributes: ["dob", "dob"] })).toBe(false);
    expect(isAdvisoryContextValid({ attributes: ["dob", "caqh_id"] })).toBe(false);
    expect(isAdvisoryContextValid({ attributes: ["caqh_id", "dob"] })).toBe(true);
    expect(isAdvisoryContextValid({ template_ids: [UUID_B, UUID_A] })).toBe(false);
  });

  it("drops undeclared keys, nulls, wrong kinds and closed-vocabulary misses", () => {
    expect(
      pickDeclared(CHECKS["import.phone_dropped"], {
        import_run_id: "run_twelve",
        line: -1,
        column: "home_phone_number",
        phone: "+15555550133",
        npi: "1234567893",
      }),
    ).toEqual({});
    expect(
      pickDeclared(CHECKS["import.phone_dropped"], {
        import_run_id: null,
        line: undefined,
        column: "billing_phone",
      }),
    ).toEqual({ column: "billing_phone" });
    expect(
      pickDeclared(CHECKS["generation.required_attribute_missing"], {
        attributes: ["caqh_id", "favorite_color"],
      }),
    ).toEqual({});
    expect(
      pickDeclared(CHECKS["assignment.start_date_missing"], {
        facility_ids: Array.from(
          { length: 21 },
          (_, i) => `13400000-0000-4000-a000-0000000a${i.toString(16).padStart(4, "0")}`,
        ),
      }),
    ).toEqual({});
  });

  it("copies arrays, so a caller's later mutation can't change what is sent", () => {
    const ids = [UUID_A];
    const picked = pickDeclared(CHECKS["assignment.start_date_missing"], { facility_ids: ids });
    ids.push("not-a-uuid");
    expect(picked).toEqual({ facility_ids: [UUID_A] });
  });

  it("ignores a context that isn't a plain object", () => {
    const def = CHECKS["npi.missing"];
    expect(pickDeclared(def, null)).toEqual({});
    expect(pickDeclared(def, ["surface"])).toEqual({});
    expect(pickDeclared(def, "surface")).toEqual({});
  });

  it.each(DEFINITIONS)("%s: whatever it picks passes the SQL rules", (_key, def) => {
    const everything: Record<string, unknown> = {
      attributes: ["caqh_id", "dob"],
      case_type: "enrollment",
      column: "npi_type2",
      count: 3,
      earlier_open_count: 1,
      facility_ids: [UUID_A],
      field_key: "provider_npi",
      import_run_id: UUID_B,
      layer: "org",
      line: 12,
      payer_id: UUID_A,
      problem: "no_step",
      recipient_id: UUID_A,
      removed_count: 1,
      rule_code: "provider_npi_invalid",
      sequence_id: UUID_B,
      step_order: 2,
      step_position: 2,
      surface: "record_edit",
      template_ids: [UUID_A, UUID_B],
      // Never declared anywhere:
      provider_name: "jane",
      dob: "1961-04-12",
      rule: "jane_smith",
      reason: "payer confirmed by phone",
    };
    const picked = pickDeclared(def, everything);
    expect(Object.keys(picked).sort()).toEqual([...def.contextKeys].sort());
    expect(isAdvisoryContextValid(picked)).toBe(true);
  });
});

describe("advisoryRpcFields", () => {
  it("builds the shared RPC fields with the registry's severity", () => {
    expect(
      advisoryRpcFields(
        CHECKS["notification.sms_disabled"],
        { table: "providers", id: UUID_A },
        { step_position: 2, note: "free text" },
      ),
    ).toEqual({
      p_check_key: "notification.sms_disabled",
      p_severity: "block",
      p_record_table: "providers",
      p_record_id: UUID_A,
      p_context: { step_position: 2 },
    });
  });

  it("refuses a record the check doesn't declare, or an id that isn't a UUID", () => {
    const def = CHECKS["npi.missing"];
    expect(advisoryRpcFields(def, { table: "tasks", id: UUID_A }, {})).toBeNull();
    expect(advisoryRpcFields(def, { table: "organizations", id: UUID_A }, {})).toBeNull();
    expect(advisoryRpcFields(def, { table: "providers", id: "1234567893" }, {})).toBeNull();
    expect(advisoryRpcFields(def, { table: "providers", id: UUID_A.toUpperCase() }, {})).toBeNull();
    expect(advisoryRpcFields(def, null, {})).toBeNull();
  });

  it("refuses every record table a check doesn't declare", () => {
    for (const table of ADVISORY_RECORD_TABLES) {
      const fields = advisoryRpcFields(CHECKS["digest.org_failed"], { table, id: UUID_A }, {});
      if (table === "organizations") expect(fields?.p_record_table).toBe("organizations");
      else expect(fields, table).toBeNull();
    }
  });
});

describe("reportAdvisoryFailure", () => {
  it("logs one line: the event, the registered key and the SQLSTATE", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportAdvisoryFailure(ADVISORY_RECORD_FAILED, "npi_registry.not_found", {
      code: "42501",
      message: "workflow_advisory_not_a_member for Jane Smith",
      details: "Failing row contains (Jane, 1961-04-12)",
      hint: "NPI 1234567893",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(1);
    const line = String(warn.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({
      event: "advisory_record_failed",
      check_key: "npi_registry.not_found",
      sqlstate: "42501",
    });
    expect(line).not.toMatch(/Jane|1961|1234567893|Failing/);
  });

  it("never echoes an unregistered key or an odd code", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportAdvisoryFailure(ADVISORY_RESOLVE_FAILED, "jane.smith", { code: "1961-04-12" });
    reportAdvisoryFailure(ADVISORY_RECORD_FAILED, "npi.missing", new Error("Jane Smith"));
    reportAdvisoryFailure(ADVISORY_RECORD_FAILED, "npi.missing", { code: "PGRST202" });
    reportAdvisoryFailure(ADVISORY_RECORD_FAILED, "npi.missing", ADVISORY_LOCAL_REFUSAL);
    expect(warn.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
      { event: "advisory_resolve_failed", check_key: "unknown", sqlstate: "unknown" },
      { event: "advisory_record_failed", check_key: "npi.missing", sqlstate: "unknown" },
      { event: "advisory_record_failed", check_key: "npi.missing", sqlstate: "PGRST202" },
      { event: "advisory_record_failed", check_key: "npi.missing", sqlstate: "22023" },
    ]);
  });

  it("survives a console that throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("console unavailable");
    });
    expect(() =>
      reportAdvisoryFailure(ADVISORY_RECORD_FAILED, "npi.missing", { code: "42501" }),
    ).not.toThrow();
  });
});
