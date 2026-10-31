// MINT-110 — the NPI Registry policy: Sowmya's answers as defaults, resolved
// field by field (platform, then organization), and validated strictly.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NPI_REGISTRY_POLICY,
  resolveNpiRegistryPolicy,
  validateNpiRegistryPolicy,
} from "@/lib/npiRegistryPolicy";

describe("DEFAULT_NPI_REGISTRY_POLICY", () => {
  it("warns on every registry answer, fills blank fields, and verifies new providers", () => {
    expect(DEFAULT_NPI_REGISTRY_POLICY).toEqual({
      severity: {
        organizationNumber: "warn",
        notFound: "warn",
        nameMismatch: "warn",
        inactive: "warn",
      },
      fillOnPick: "blank_fields",
      importVerifyScope: "new_providers",
    });
    expect(Object.isFrozen(DEFAULT_NPI_REGISTRY_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_NPI_REGISTRY_POLICY.severity)).toBe(true);
  });
});

describe("resolveNpiRegistryPolicy", () => {
  it("is the defaults with no overrides", () => {
    expect(resolveNpiRegistryPolicy()).toEqual(DEFAULT_NPI_REGISTRY_POLICY);
    expect(resolveNpiRegistryPolicy(null, null)).toEqual(DEFAULT_NPI_REGISTRY_POLICY);
  });

  it("layers the organization over the platform over the defaults, field by field", () => {
    const policy = resolveNpiRegistryPolicy(
      { severity: { notFound: "block", inactive: "block" }, fillOnPick: "npi_only" },
      { severity: { inactive: "warn", organizationNumber: "block" } },
    );
    expect(policy).toEqual({
      severity: {
        organizationNumber: "block",
        notFound: "block",
        nameMismatch: "warn",
        inactive: "warn",
      },
      fillOnPick: "npi_only",
      importVerifyScope: "new_providers",
    });
  });

  it("treats null and a missing field alike: both inherit", () => {
    const policy = resolveNpiRegistryPolicy(
      { importVerifyScope: "all_rows", severity: { notFound: "block" } },
      { importVerifyScope: null, severity: { notFound: null }, fillOnPick: undefined },
    );
    expect(policy.importVerifyScope).toBe("all_rows");
    expect(policy.severity.notFound).toBe("block");
    expect(policy.fillOnPick).toBe("blank_fields");
  });

  it("never changes the defaults", () => {
    resolveNpiRegistryPolicy({ severity: { notFound: "block" } });
    expect(DEFAULT_NPI_REGISTRY_POLICY.severity.notFound).toBe("warn");
  });
});

describe("validateNpiRegistryPolicy", () => {
  it("accepts nothing, a partial override, and a full policy", () => {
    expect(validateNpiRegistryPolicy(undefined)).toEqual({ ok: true, value: {} });
    expect(validateNpiRegistryPolicy(null)).toEqual({ ok: true, value: {} });
    expect(validateNpiRegistryPolicy({ severity: { notFound: "block" } })).toEqual({
      ok: true,
      value: { severity: { notFound: "block" } },
    });
    expect(validateNpiRegistryPolicy(DEFAULT_NPI_REGISTRY_POLICY)).toEqual({
      ok: true,
      value: DEFAULT_NPI_REGISTRY_POLICY,
    });
    expect(
      validateNpiRegistryPolicy({ severity: null, fillOnPick: null, importVerifyScope: null }),
    ).toEqual({ ok: true, value: {} });
  });

  it("rejects unknown settings, outcomes and values", () => {
    const cases: [unknown, string][] = [
      ["warn", "NPI Registry policy must be an object"],
      [[], "NPI Registry policy must be an object"],
      [{ fillOnpick: "npi_only" }, 'Unknown NPI Registry policy setting "fillOnpick"'],
      [{ severity: "block" }, "severity must be an object"],
      [{ severity: { outage: "block" } }, 'Unknown NPI Registry outcome "outage"'],
      [{ severity: { rateLimited: "block" } }, 'Unknown NPI Registry outcome "rateLimited"'],
      [{ severity: { notFound: "error" } }, 'severity.notFound must be "warn" or "block"'],
      [{ severity: { notFound: true } }, 'severity.notFound must be "warn" or "block"'],
      [{ fillOnPick: "all" }, 'fillOnPick must be "blank_fields" or "npi_only"'],
      [
        { importVerifyScope: "changed_rows" },
        'importVerifyScope must be "new_providers" or "all_rows"',
      ],
    ];
    for (const [input, error] of cases) {
      expect(validateNpiRegistryPolicy(input)).toEqual({ ok: false, error });
    }
  });
});
