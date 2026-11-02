// NPI Registry pulls — MINT-110 PR 3. The pure half of
// POST /api/npi-registry/pulls, shared by the route and the forms: the wire
// shapes, the request validation, what a save says it took from a pick, and
// the server's rule for what stays in a pull's `sourced`. No I/O.
//
// A pull is one row of public registry source data per save that used a
// registry answer (a pick, or the check of a new or changed NPI): the trimmed
// reply, kept apart from the provider's own columns, and the fields whose
// saved value came from it. The client never sends registry data, only which
// fields it saved from the pick; the server fetches the reply itself and keeps
// a field only when the saved value equals the reply's (keepNpiRegistrySourced),
// so the registry is never named as the source of a value it didn't give.
import { isValidNpi, stripNpiSeparators } from "@/lib/providerIdentity";
import { normalizeTaxonomyCode } from "@/lib/providerTaxonomy";
import { US_STATES } from "@/lib/usStates";
import type { NpiRegistryRecord, Validation } from "@/lib/npiRegistry";
import {
  npiRegistryGender,
  npiRegistryLicenses,
  npiRegistryPhone,
  sameLicense,
} from "@/lib/npiRegistryFill";

/** A license whose saved number came from the pull. */
export interface NpiRegistrySourcedLicense {
  /** Two-letter state. */
  state: string;
  number: string;
}

/** The fields whose saved value came from a pull. A key is present only for a
 * field the pull sourced. Gender is the form's value ("female", "male"); the
 * phone is "303-555-0199". */
export interface NpiRegistrySourced {
  credentials?: string;
  taxonomyCode?: string;
  gender?: string;
  phone?: string;
  licenses?: NpiRegistrySourcedLicense[];
}

/** POST /api/npi-registry/pulls. The org and the actor come from the guard. */
export interface NpiRegistryPullInput {
  providerId: string;
  /** Ten digits with a valid check digit; separators stripped. */
  npi: string;
  /** What the save took from the pick, as the form holds it. */
  sourced: NpiRegistrySourced;
  /** Add Provider's Review step submit: the save confirms the sourced values. */
  confirmed: boolean;
}

export interface NpiRegistryPull {
  id: string;
  /** When the registry answered (the server's pulledAt). */
  pulledAt: string;
  /** What the server kept of the save's `sourced`. */
  sourced: NpiRegistrySourced;
  confirmed: boolean;
}

export interface NpiRegistryPullResult {
  pull: NpiRegistryPull;
}

/** What the provider holds after the save, as the server reads it. */
export interface NpiRegistrySavedValues {
  credentials: string | null;
  taxonomyCode: string | null;
  gender: string | null;
  phone: string | null;
  licenses: { state: string; number: string | null }[];
}

/** License rows one request may name. */
export const NPI_REGISTRY_PULL_LICENSES_MAX = 20;
const VALUE_MAX = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_SET: ReadonlySet<string> = new Set(US_STATES);
const SOURCED_KEYS: ReadonlySet<string> = new Set([
  "credentials",
  "taxonomyCode",
  "gender",
  "phone",
  "licenses",
]);
export const NPI_REGISTRY_PULL_INVALID_MESSAGE =
  "Send the provider, its NPI, the fields the save took from the NPI Registry, and whether it was confirmed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= VALUE_MAX ? trimmed : null;
}

function readSourced(value: unknown): NpiRegistrySourced | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !SOURCED_KEYS.has(key))) return null;
  const sourced: NpiRegistrySourced = {};
  for (const key of ["credentials", "taxonomyCode", "gender", "phone"] as const) {
    if (value[key] === undefined) continue;
    const text = readValue(value[key]);
    if (text === null) return null;
    sourced[key] = text;
  }
  if (value.licenses !== undefined) {
    const rows = value.licenses;
    if (!Array.isArray(rows) || rows.length > NPI_REGISTRY_PULL_LICENSES_MAX) return null;
    const licenses: NpiRegistrySourcedLicense[] = [];
    for (const row of rows) {
      if (!isRecord(row)) return null;
      const state = readValue(row.state)?.toUpperCase() ?? "";
      const number = readValue(row.number);
      if (!STATE_SET.has(state) || number === null) return null;
      licenses.push({ state, number });
    }
    if (licenses.length > 0) sourced.licenses = licenses;
  }
  return sourced;
}

/** `{ providerId, npi, sourced, confirmed }`: a provider id, an NPI that passes
 * the CMS check digit (dashes and spaces stripped), `sourced` with only the
 * known keys, and `confirmed` true or false. */
export function validateNpiRegistryPull(input: unknown): Validation<NpiRegistryPullInput> {
  const invalid = { ok: false as const, error: NPI_REGISTRY_PULL_INVALID_MESSAGE };
  if (!isRecord(input)) return invalid;
  const providerId = typeof input.providerId === "string" ? input.providerId.trim() : "";
  const npi = typeof input.npi === "string" ? stripNpiSeparators(input.npi) : "";
  const sourced = readSourced(input.sourced);
  if (!UUID_RE.test(providerId) || !isValidNpi(npi) || sourced === null) return invalid;
  if (typeof input.confirmed !== "boolean") return invalid;
  return {
    ok: true,
    value: { providerId: providerId.toLowerCase(), npi, sourced, confirmed: input.confirmed },
  };
}

const digits = (value: string | null | undefined): string => (value ?? "").replace(/\D/g, "");

/** What stays in a pull's `sourced`: each field the save named whose saved
 * value equals both what it named and the registry's value for that field. A
 * reply with no record sources nothing. The kept values are the saved ones. */
export function keepNpiRegistrySourced(
  claimed: NpiRegistrySourced,
  saved: NpiRegistrySavedValues,
  record: NpiRegistryRecord | null,
): NpiRegistrySourced {
  if (!record) return {};
  const kept: NpiRegistrySourced = {};
  const credentials = saved.credentials?.trim() ?? "";
  if (
    claimed.credentials !== undefined &&
    credentials &&
    credentials === claimed.credentials.trim() &&
    credentials === record.credential?.trim()
  ) {
    kept.credentials = credentials;
  }
  const taxonomy = normalizeTaxonomyCode(saved.taxonomyCode ?? "");
  const registryCodes = new Set(
    [record.primaryTaxonomy?.code, ...(record.taxonomies ?? []).map((entry) => entry.code)]
      .filter((code): code is string => Boolean(code))
      .map(normalizeTaxonomyCode),
  );
  if (
    claimed.taxonomyCode !== undefined &&
    taxonomy &&
    taxonomy === normalizeTaxonomyCode(claimed.taxonomyCode) &&
    registryCodes.has(taxonomy)
  ) {
    kept.taxonomyCode = taxonomy;
  }
  const gender = saved.gender ?? "";
  if (claimed.gender !== undefined && gender && gender === claimed.gender) {
    if (gender === npiRegistryGender(record)) kept.gender = gender;
  }
  const phone = saved.phone?.trim() ?? "";
  if (
    claimed.phone !== undefined &&
    digits(phone) &&
    digits(phone) === digits(claimed.phone) &&
    digits(phone) === digits(npiRegistryPhone(record))
  ) {
    kept.phone = phone;
  }
  const registryLicenses = npiRegistryLicenses(record);
  const licenses: NpiRegistrySourcedLicense[] = [];
  for (const license of claimed.licenses ?? []) {
    const row = saved.licenses.find((item) =>
      sameLicense({ state: item.state, number: item.number ?? "" }, license),
    );
    if (!row?.number || !registryLicenses.some((item) => sameLicense(item, license))) continue;
    const keptRow = { state: row.state.trim().toUpperCase(), number: row.number.trim() };
    if (!licenses.some((item) => sameLicense(item, keptRow))) licenses.push(keptRow);
  }
  if (licenses.length > 0) kept.licenses = licenses;
  return kept;
}

/** What a save sends as `sourced`: the fields npiRegistrySourcedFields says
 * still hold what the pick wrote, with the values the form saves (trimmed). */
export function npiRegistryPullSourced(
  fields: {
    credentials: boolean;
    taxonomyCode: boolean;
    gender: boolean;
    phone: boolean;
    licenses: { state: string; number: string }[];
  },
  values: { credentials: string; taxonomyCode: string; gender: string; phone: string },
): NpiRegistrySourced {
  const sourced: NpiRegistrySourced = {};
  if (fields.credentials && values.credentials.trim()) {
    sourced.credentials = values.credentials.trim();
  }
  if (fields.taxonomyCode && values.taxonomyCode.trim()) {
    sourced.taxonomyCode = values.taxonomyCode.trim();
  }
  if (fields.gender && values.gender.trim()) sourced.gender = values.gender.trim();
  if (fields.phone && values.phone.trim()) sourced.phone = values.phone.trim();
  const licenses = fields.licenses
    .filter((row) => row.state.trim() && row.number.trim())
    .map((row) => ({ state: row.state.trim().toUpperCase(), number: row.number.trim() }));
  if (licenses.length > 0) sourced.licenses = licenses.slice(0, NPI_REGISTRY_PULL_LICENSES_MAX);
  return sourced;
}

/** The pull a provider form's save sends, or null when there is none: the
 * saved NPI must be a valid one, and the save must have used the registry —
 * a pick of that NPI, or the check of an NPI that is new or changed. A pick of
 * another NPI sources nothing. */
export function npiRegistryPullForSave(input: {
  providerId: string;
  /** The NPI the save stored (separators are stripped here). */
  npi: string;
  /** The NPI is new or changed, so the save checked it. */
  checked: boolean;
  /** The NPI of the form's last pick, or null when there was none. */
  pickedNpi: string | null;
  /** What the pick's values still hold (npiRegistryPullSourced). */
  sourced: NpiRegistrySourced;
  confirmed: boolean;
}): NpiRegistryPullInput | null {
  const npi = stripNpiSeparators(input.npi.trim());
  if (!isValidNpi(npi)) return null;
  const picked = input.pickedNpi !== null && input.pickedNpi === npi;
  if (!picked && !input.checked) return null;
  return {
    providerId: input.providerId,
    npi,
    sourced: picked ? input.sourced : {},
    confirmed: input.confirmed,
  };
}
