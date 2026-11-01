// MINT-110 — the NPI Registry policy: Sowmya's answers as defaults, resolved
// field by field (platform, then organization; an organization's value wins in
// either direction, A31), and validated strictly. Every check is advisory
// (A30): the policy says only where its advisory shows, never whether a save
// may go through.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NPI_REGISTRY_POLICY,
  NPI_REGISTRY_CHECKS,
  resolveNpiRegistryPolicy,
  validateNpiRegistryPolicy,
} from "@/lib/npiRegistryPolicy";

describe("DEFAULT_NPI_REGISTRY_POLICY", () => {
  it("shows every check on the review step, fills blank fields, and verifies new providers", () => {
    expect(DEFAULT_NPI_REGISTRY_POLICY).toEqual({
      display: {
        organizationNumber: "review_step",
        notFound: "review_step",
        nameMismatch: "review_step",
        inactive: "review_step",
        credentialsDiffer: "review_step",
        taxonomyDiffers: "review_step",
        licenseDiffers: "review_step",
      },
      fillOnPick: "blank_fields",
      importVerifyScope: "new_providers",
    });
    expect(Object.isFrozen(DEFAULT_NPI_REGISTRY_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_NPI_REGISTRY_POLICY.display)).toBe(true);
  });

  it("has no setting that blocks or delays a save (A30)", () => {
    expect(Object.keys(DEFAULT_NPI_REGISTRY_POLICY).sort()).toEqual([
      "display",
      "fillOnPick",
      "importVerifyScope",
    ]);
    for (const check of NPI_REGISTRY_CHECKS) {
      expect(["review_step", "backend_only"]).toContain(DEFAULT_NPI_REGISTRY_POLICY.display[check]);
    }
  });
});

describe("resolveNpiRegistryPolicy", () => {
  it("is the defaults with no overrides", () => {
    expect(resolveNpiRegistryPolicy()).toEqual(DEFAULT_NPI_REGISTRY_POLICY);
    expect(resolveNpiRegistryPolicy(null, null)).toEqual(DEFAULT_NPI_REGISTRY_POLICY);
  });

  it("layers the organization over the platform over the defaults, field by field", () => {
    const policy = resolveNpiRegistryPolicy(
      {
        display: { notFound: "backend_only", inactive: "backend_only" },
        fillOnPick: "npi_only",
      },
      { display: { inactive: "review_step", credentialsDiffer: "backend_only" } },
    );
    expect(policy).toEqual({
      display: {
        organizationNumber: "review_step",
        notFound: "backend_only",
        nameMismatch: "review_step",
        // The organization's value wins in either direction (A31).
        inactive: "review_step",
        credentialsDiffer: "backend_only",
        taxonomyDiffers: "review_step",
        licenseDiffers: "review_step",
      },
      fillOnPick: "npi_only",
      importVerifyScope: "new_providers",
    });
  });

  it("treats null and a missing field alike: both inherit", () => {
    const policy = resolveNpiRegistryPolicy(
      { importVerifyScope: "all_rows", display: { notFound: "backend_only" } },
      { importVerifyScope: null, display: { notFound: null }, fillOnPick: undefined },
    );
    expect(policy.importVerifyScope).toBe("all_rows");
    expect(policy.display.notFound).toBe("backend_only");
    expect(policy.fillOnPick).toBe("blank_fields");
  });

  it("never changes the defaults", () => {
    resolveNpiRegistryPolicy({ display: { notFound: "backend_only" } });
    expect(DEFAULT_NPI_REGISTRY_POLICY.display.notFound).toBe("review_step");
  });
});

describe("validateNpiRegistryPolicy", () => {
  it("accepts nothing, a partial override, and a full policy", () => {
    expect(validateNpiRegistryPolicy(undefined)).toEqual({ ok: true, value: {} });
    expect(validateNpiRegistryPolicy(null)).toEqual({ ok: true, value: {} });
    expect(validateNpiRegistryPolicy({ display: { licenseDiffers: "backend_only" } })).toEqual({
      ok: true,
      value: { display: { licenseDiffers: "backend_only" } },
    });
    expect(validateNpiRegistryPolicy(DEFAULT_NPI_REGISTRY_POLICY)).toEqual({
      ok: true,
      value: DEFAULT_NPI_REGISTRY_POLICY,
    });
    expect(
      validateNpiRegistryPolicy({ display: null, fillOnPick: null, importVerifyScope: null }),
    ).toEqual({ ok: true, value: {} });
  });

  it("rejects the old severity setting: a registry check never blocks a save (A30)", () => {
    for (const severity of [{ notFound: "block" }, { notFound: "warn" }, null]) {
      expect(validateNpiRegistryPolicy({ severity })).toEqual({
        ok: false,
        error:
          '"severity" is gone: a registry check never blocks a save. Use "display" ("review_step" or "backend_only")',
      });
    }
  });

  it("rejects unknown settings, checks and values", () => {
    const displayError = 'display.notFound must be "review_step" or "backend_only"';
    const cases: [unknown, string][] = [
      ["warn", "NPI Registry policy must be an object"],
      [[], "NPI Registry policy must be an object"],
      [{ fillOnpick: "npi_only" }, 'Unknown NPI Registry policy setting "fillOnpick"'],
      [{ display: "backend_only" }, "display must be an object"],
      [{ display: { outage: "backend_only" } }, 'Unknown NPI Registry check "outage"'],
      [{ display: { rateLimited: "review_step" } }, 'Unknown NPI Registry check "rateLimited"'],
      [{ display: { notFound: "block" } }, displayError],
      [{ display: { notFound: "warn" } }, displayError],
      [{ display: { notFound: true } }, displayError],
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
