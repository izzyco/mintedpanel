// NPI Registry policy — MINT-110. Business policy is configuration, never a
// constant: every value here is a decided default (Sowmya, Oct 31, 2026) that
// a platform override and then an organization override may change, field by
// field (an organization's value wins in either direction; A31). Overrides are
// not stored yet: their storage and the Mission Control screen are MINT-128,
// so today every caller resolves to the defaults (useNpiRegistryPolicy).
//
// Every registry check is advisory (Sowmya's standing rule, Oct 31): a save
// always goes through, at once, and the check finishes in the background. A
// check's answer becomes an advisory — listed on the form's review step, or
// kept for Mission Control only — and is handed to the advisory-capture seam
// (src/services/advisoryCapture.ts). The registry never marks an NPI verified
// unless it really matched.
//
// Not configurable, by design, and so not in this object: who may use the
// registry (writers only; billing never), tenant isolation, the NPI check digit
// and the 10-digit rule (facts about the number, which stay hard), and a
// registry that can't answer (an outage, a rate limit, a refused query): that
// NPI is saved as not checked.
//
// Pure and leaf-level: this module imports nothing at runtime.
import type { Validation } from "@/lib/npiRegistry";

/** The registry's answers about an NPI. */
export const NPI_REGISTRY_OUTCOMES = [
  "organizationNumber",
  "notFound",
  "nameMismatch",
  "inactive",
] as const;
export type NpiRegistryOutcome = (typeof NPI_REGISTRY_OUTCOMES)[number];

/** Where the entered data differs from a registry record that was found. */
export const NPI_REGISTRY_FIELD_CHECKS = [
  "credentialsDiffer",
  "taxonomyDiffers",
  "licenseDiffers",
] as const;
export type NpiRegistryFieldCheck = (typeof NPI_REGISTRY_FIELD_CHECKS)[number];

/** Every noncritical registry check; each yields an advisory, never a block. */
export const NPI_REGISTRY_CHECKS = [
  ...NPI_REGISTRY_OUTCOMES,
  ...NPI_REGISTRY_FIELD_CHECKS,
] as const;
export type NpiRegistryCheck = NpiRegistryOutcome | NpiRegistryFieldCheck;

export const NPI_ADVISORY_DISPLAYS = ["review_step", "backend_only"] as const;
/** "review_step": listed on the form's review step (and the note under the
 * NPI field), where staff fix or confirm it in one click. "backend_only":
 * kept for Mission Control and not shown on the form. Either way the save
 * goes through and the advisory is handed to the capture seam. */
export type NpiAdvisoryDisplay = (typeof NPI_ADVISORY_DISPLAYS)[number];

export const NPI_FILL_ON_PICK = ["blank_fields", "npi_only"] as const;
/** What picking a search match fills: the NPI plus every blank field the
 * registry supplies, or the NPI alone. */
export type NpiFillOnPick = (typeof NPI_FILL_ON_PICK)[number];

export const NPI_IMPORT_VERIFY_SCOPES = ["new_providers", "all_rows"] as const;
/** Which provider-import rows are checked against the registry (PR 2). */
export type NpiImportVerifyScope = (typeof NPI_IMPORT_VERIFY_SCOPES)[number];

export interface NpiRegistryPolicy {
  /** Where each check's advisory shows:
   * - organizationNumber: an organization (NPI-2) number in a provider's NPI;
   * - notFound: the registry has no record of the NPI;
   * - nameMismatch: the typed name differs from the registry's;
   * - inactive: the registry lists the NPI as inactive;
   * - credentialsDiffer / taxonomyDiffers / licenseDiffers: a value staff
   *   entered differs from the record the registry found. */
  display: Record<NpiRegistryCheck, NpiAdvisoryDisplay>;
  fillOnPick: NpiFillOnPick;
  importVerifyScope: NpiImportVerifyScope;
}

/** A platform or organization override: any field left null or out inherits. */
export interface NpiRegistryPolicyOverride {
  display?: Partial<Record<NpiRegistryCheck, NpiAdvisoryDisplay | null>> | null;
  fillOnPick?: NpiFillOnPick | null;
  importVerifyScope?: NpiImportVerifyScope | null;
}

/** Sowmya's answers, Oct 31, 2026: every check is shown on the review step
 * (A30, A30b), a pick fills the blank fields (D71), and import verification
 * checks new providers only (D72). */
export const DEFAULT_NPI_REGISTRY_POLICY: NpiRegistryPolicy = Object.freeze({
  display: Object.freeze({
    organizationNumber: "review_step",
    notFound: "review_step",
    nameMismatch: "review_step",
    inactive: "review_step",
    credentialsDiffer: "review_step",
    taxonomyDiffers: "review_step",
    licenseDiffers: "review_step",
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
  const display = {} as Record<NpiRegistryCheck, NpiAdvisoryDisplay>;
  for (const check of NPI_REGISTRY_CHECKS) {
    display[check] = firstSet(
      DEFAULT_NPI_REGISTRY_POLICY.display[check],
      ...layers.map((layer) => layer?.display?.[check]),
    );
  }
  return {
    display,
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

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["display", "fillOnPick", "importVerifyScope"]);

/** An override as stored or submitted: a full policy, a partial one, or
 * nothing (inherit everything). Unknown settings and unknown values are
 * rejected, never ignored, so a typo cannot silently fall back to a default. */
export function validateNpiRegistryPolicy(input: unknown): Validation<NpiRegistryPolicyOverride> {
  if (input === null || input === undefined) return { ok: true, value: {} };
  if (!isPlainObject(input)) return { ok: false, error: "NPI Registry policy must be an object" };
  for (const key of Object.keys(input)) {
    if (key === "severity") {
      return {
        ok: false,
        error:
          '"severity" is gone: a registry check never blocks a save. Use "display" ("review_step" or "backend_only")',
      };
    }
    if (!TOP_LEVEL_KEYS.has(key)) {
      return { ok: false, error: `Unknown NPI Registry policy setting "${key}"` };
    }
  }
  const value: NpiRegistryPolicyOverride = {};
  const rawDisplay = input.display;
  if (rawDisplay !== null && rawDisplay !== undefined) {
    if (!isPlainObject(rawDisplay)) return { ok: false, error: "display must be an object" };
    const display: Partial<Record<NpiRegistryCheck, NpiAdvisoryDisplay | null>> = {};
    for (const [check, raw] of Object.entries(rawDisplay)) {
      if (!(NPI_REGISTRY_CHECKS as readonly string[]).includes(check)) {
        return { ok: false, error: `Unknown NPI Registry check "${check}"` };
      }
      const checked = oneOf(NPI_ADVISORY_DISPLAYS, raw, `display.${check}`);
      if (!checked.ok) return checked;
      display[check as NpiRegistryCheck] = checked.value;
    }
    value.display = display;
  }
  const fillOnPick = oneOf(NPI_FILL_ON_PICK, input.fillOnPick, "fillOnPick");
  if (!fillOnPick.ok) return fillOnPick;
  if (fillOnPick.value !== null) value.fillOnPick = fillOnPick.value;
  const scope = oneOf(NPI_IMPORT_VERIFY_SCOPES, input.importVerifyScope, "importVerifyScope");
  if (!scope.ok) return scope;
  if (scope.value !== null) value.importVerifyScope = scope.value;
  return { ok: true, value };
}
