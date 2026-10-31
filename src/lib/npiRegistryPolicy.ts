// NPI Registry policy — MINT-110. Business policy is configuration, never a
// constant: every value here is a decided default (Sowmya, Oct 31, 2026) that
// a platform override and then an organization override may change, field by
// field. Overrides are not stored yet: their storage and the Mission Control
// screen are a sibling of MINT-125, so today every caller resolves to the
// defaults (useNpiRegistryPolicy).
//
// Not configurable, by design, and so not in this object: who may use the
// registry (writers only; billing never), tenant isolation, the NPI check digit
// and the 10-digit rule, and a registry that can't answer (an outage, a rate
// limit, a refused query). A failed check is a fact — we could not check — so
// it is always a note and never refuses a save.
//
// Pure and leaf-level: this module imports nothing at runtime.
import type { Validation } from "@/lib/npiRegistry";

export const NPI_CHECK_SEVERITIES = ["warn", "block"] as const;
/** "warn" notes the answer and still saves; "block" refuses the save. */
export type NpiCheckSeverity = (typeof NPI_CHECK_SEVERITIES)[number];

/** The registry answers a policy can act on. */
export const NPI_REGISTRY_OUTCOMES = [
  "organizationNumber",
  "notFound",
  "nameMismatch",
  "inactive",
] as const;
export type NpiRegistryOutcome = (typeof NPI_REGISTRY_OUTCOMES)[number];

export const NPI_FILL_ON_PICK = ["blank_fields", "npi_only"] as const;
/** What picking a search match fills: the NPI plus every blank field the
 * registry supplies, or the NPI alone. */
export type NpiFillOnPick = (typeof NPI_FILL_ON_PICK)[number];

export const NPI_IMPORT_VERIFY_SCOPES = ["new_providers", "all_rows"] as const;
/** Which provider-import rows are checked against the registry (PR 2). */
export type NpiImportVerifyScope = (typeof NPI_IMPORT_VERIFY_SCOPES)[number];

export interface NpiRegistryPolicy {
  /** What each registry answer does to a provider form's save:
   * - organizationNumber: an organization (NPI-2) number in a provider's NPI;
   * - notFound: the registry has no record of the NPI;
   * - nameMismatch: the typed name differs from the registry's;
   * - inactive: the registry lists the NPI as inactive. */
  severity: Record<NpiRegistryOutcome, NpiCheckSeverity>;
  fillOnPick: NpiFillOnPick;
  importVerifyScope: NpiImportVerifyScope;
}

/** A platform or organization override: any field left null or out inherits. */
export interface NpiRegistryPolicyOverride {
  severity?: Partial<Record<NpiRegistryOutcome, NpiCheckSeverity | null>> | null;
  fillOnPick?: NpiFillOnPick | null;
  importVerifyScope?: NpiImportVerifyScope | null;
}

/** Sowmya's answers, Oct 31, 2026: every registry answer warns (an
 * organization number included), a pick fills the blank fields, and import
 * verification checks new providers only (no backfill). */
export const DEFAULT_NPI_REGISTRY_POLICY: NpiRegistryPolicy = Object.freeze({
  severity: Object.freeze({
    organizationNumber: "warn",
    notFound: "warn",
    nameMismatch: "warn",
    inactive: "warn",
  }),
  fillOnPick: "blank_fields",
  importVerifyScope: "new_providers",
}) as NpiRegistryPolicy;

function firstSet<T>(fallback: T, ...overrides: (T | null | undefined)[]): T {
  let value = fallback;
  for (const override of overrides)
    if (override !== null && override !== undefined) value = override;
  return value;
}

/** The policy in force: the defaults, then the platform override, then the
 * organization's, field by field. Pass overrides that validated. */
export function resolveNpiRegistryPolicy(
  platformOverride?: NpiRegistryPolicyOverride | null,
  orgOverride?: NpiRegistryPolicyOverride | null,
): NpiRegistryPolicy {
  const layers = [platformOverride, orgOverride];
  const severity = {} as Record<NpiRegistryOutcome, NpiCheckSeverity>;
  for (const outcome of NPI_REGISTRY_OUTCOMES) {
    severity[outcome] = firstSet(
      DEFAULT_NPI_REGISTRY_POLICY.severity[outcome],
      ...layers.map((layer) => layer?.severity?.[outcome]),
    );
  }
  return {
    severity,
    fillOnPick: firstSet(
      DEFAULT_NPI_REGISTRY_POLICY.fillOnPick,
      ...layers.map((layer) => layer?.fillOnPick),
    ),
    importVerifyScope: firstSet(
      DEFAULT_NPI_REGISTRY_POLICY.importVerifyScope,
      ...layers.map((layer) => layer?.importVerifyScope),
    ),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
  name: string,
): Validation<T | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return { ok: true, value: value as T };
  }
  return { ok: false, error: `${name} must be ${allowed.map((v) => `"${v}"`).join(" or ")}` };
}

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "severity",
  "fillOnPick",
  "importVerifyScope",
]);

/** An override as stored or submitted: a full policy, a partial one, or
 * nothing (inherit everything). Unknown settings and unknown values are
 * rejected, never ignored, so a typo cannot silently fall back to a default. */
export function validateNpiRegistryPolicy(input: unknown): Validation<NpiRegistryPolicyOverride> {
  if (input === null || input === undefined) return { ok: true, value: {} };
  if (!isPlainObject(input)) return { ok: false, error: "NPI Registry policy must be an object" };
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      return { ok: false, error: `Unknown NPI Registry policy setting "${key}"` };
    }
  }
  const value: NpiRegistryPolicyOverride = {};
  const rawSeverity = input.severity;
  if (rawSeverity !== null && rawSeverity !== undefined) {
    if (!isPlainObject(rawSeverity)) return { ok: false, error: "severity must be an object" };
    const severity: Partial<Record<NpiRegistryOutcome, NpiCheckSeverity | null>> = {};
    for (const [outcome, raw] of Object.entries(rawSeverity)) {
      if (!(NPI_REGISTRY_OUTCOMES as readonly string[]).includes(outcome)) {
        return { ok: false, error: `Unknown NPI Registry outcome "${outcome}"` };
      }
      const checked = oneOf(NPI_CHECK_SEVERITIES, raw, `severity.${outcome}`);
      if (!checked.ok) return checked;
      severity[outcome as NpiRegistryOutcome] = checked.value;
    }
    value.severity = severity;
  }
  const fillOnPick = oneOf(NPI_FILL_ON_PICK, input.fillOnPick, "fillOnPick");
  if (!fillOnPick.ok) return fillOnPick;
  if (fillOnPick.value !== null) value.fillOnPick = fillOnPick.value;
  const scope = oneOf(NPI_IMPORT_VERIFY_SCOPES, input.importVerifyScope, "importVerifyScope");
  if (!scope.ok) return scope;
  if (scope.value !== null) value.importVerifyScope = scope.value;
  return { ok: true, value };
}
