// NPI Registry batch check — MINT-110 PR 2. The pure half shared by
// POST /api/npi-registry/verify-batch and the import review screen: the wire
// shapes, the request validation and the per-user budget. No I/O.
//
// Only NPIs travel. The name match runs in the browser through the same
// compareNpiRegistryName / npiVerificationView the provider forms use, so the
// import notes and the form notes are the same words from the same code.
import {
  validateNpiRegistryLookup,
  type NpiRegistryRecord,
  type Validation,
} from "@/lib/npiRegistry";

/** The most NPIs one request checks. */
export const NPI_REGISTRY_BATCH_MAX = 10;

/** The batch budget: NPIs a minute per user, a fixed window, separate from
 * the interactive 30 a minute so a coordinator typing an NPI into a form keeps
 * working while an import is being checked. Every NPI in a request counts,
 * cache hit or not (the same rule as /lookup). A platform constant (A38).
 *
 * Why 60 a minute: NPPES publishes no rate limit, and every organization's
 * lookups leave from the same server addresses, so one large import must never
 * get the registry to throttle everyone else. A 100-row file takes about a
 * minute. In memory per server instance, best effort (TECH-DEBT TD-55/TD-56). */
export const NPI_REGISTRY_BATCH_PER_MINUTE = 60;

export const NPI_REGISTRY_BATCH_RATE_LIMIT_MESSAGE =
  "Too many NPI Registry checks — wait a few seconds and try again";
export const NPI_REGISTRY_BATCH_SIZE_MESSAGE = `Send 1 to ${NPI_REGISTRY_BATCH_MAX} NPIs to check`;

/** checked: `record` is the registry's answer (null = not in the registry).
 * unavailable: not checked — the registry failed for this NPI or one before
 * it in the same request. */
export type NpiRegistryBatchItemStatus = "checked" | "unavailable";

export interface NpiRegistryBatchItemResult {
  npi: string;
  status: NpiRegistryBatchItemStatus;
  record: NpiRegistryRecord | null;
}

/** One entry per distinct NPI sent, in the order sent. */
export interface NpiRegistryBatchResult {
  results: NpiRegistryBatchItemResult[];
}

/** A registry record cut down to what an import row's check needs: the name
 * parts and former names (the name match), the type and status (organization
 * and inactive numbers), and the credential, primary taxonomy and practice
 * city and state (the note's summary line). Addresses, phones, other
 * taxonomies, identifiers and the enumeration date are not sent: the import
 * review shows none of them. */
export function trimNpiRecordForImport(record: NpiRegistryRecord): NpiRegistryRecord {
  return {
    npi: record.npi,
    enumerationType: record.enumerationType,
    firstName: record.firstName,
    middleName: record.middleName,
    lastName: record.lastName,
    suffix: record.suffix ?? null,
    organizationName: record.organizationName,
    credential: record.credential,
    primaryTaxonomy: record.primaryTaxonomy,
    practiceCity: record.practiceCity,
    practiceState: record.practiceState,
    status: record.status,
    enumerationDate: null,
    otherNames: record.otherNames.map((name) => ({
      firstName: name.firstName,
      middleName: name.middleName ?? null,
      lastName: name.lastName,
    })),
  };
}

/** `{ npis: string[] }`: 1 to NPI_REGISTRY_BATCH_MAX NPIs, each passing the
 * same check as /lookup (dashes and spaces stripped, then the CMS check digit).
 * The value is the distinct stripped NPIs in order; a repeat is checked once. */
export function validateNpiRegistryBatch(input: unknown): Validation<string[]> {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const raw = (body as Record<string, unknown>).npis;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > NPI_REGISTRY_BATCH_MAX) {
    return { ok: false, error: NPI_REGISTRY_BATCH_SIZE_MESSAGE };
  }
  const npis: string[] = [];
  for (const [index, value] of raw.entries()) {
    const one = validateNpiRegistryLookup({ npi: value });
    if (!one.ok) return { ok: false, error: `NPI ${index + 1} of ${raw.length}: ${one.error}` };
    if (!npis.includes(one.value)) npis.push(one.value);
  }
  return { ok: true, value: npis };
}
