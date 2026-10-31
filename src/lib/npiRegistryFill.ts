// What picking an NPI Registry match fills on a provider form — MINT-110. Pure.
//
// The pick sets the NPI. With the policy's fillOnPick at "blank_fields" (the
// default, src/lib/npiRegistryPolicy) the registry also fills a blank field:
// a field holding anything (typed by staff, loaded from the record, or set by
// the form's own default, like Add Provider's Physical Therapist taxonomy) is
// kept, and when it differs from the registry the summary says so. Registry
// data with no field on the form is listed read-only and never saved. At
// "npi_only" nothing else is filled, and everything else is listed.
//
// The form adapters (providerFormShared.ts for Add Provider, licenseDraft.ts
// for the roster form) describe their fields with NpiFillForm and apply the
// plan; this module decides.
import { stripNpiSeparators } from "@/lib/providerIdentity";
import { isKnownTaxonomyCode, normalizeTaxonomyCode } from "@/lib/providerTaxonomy";
import { US_STATES } from "@/lib/usStates";
import type { NpiRegistryAddress, NpiRegistryName, NpiRegistryRecord } from "@/lib/npiRegistry";
import { DEFAULT_NPI_REGISTRY_POLICY, type NpiFillOnPick } from "@/lib/npiRegistryPolicy";

export interface NpiFillLicenseRow {
  state: string;
  number: string;
  /** The row holds nothing but the form's defaults, so a registry license
   * may fill it. A saved row is never blank. */
  blank: boolean;
}

/** The form's fields the registry can fill, as they stand. */
export interface NpiFillForm {
  npi: string;
  credentials: string;
  /** "" when no taxonomy is selected. */
  taxonomyCode: string;
  licenses: NpiFillLicenseRow[];
  /** Whether the form saves a license row that holds only a state and a
   * number. NPPES has no expiration date, so when a row needs more, registry
   * licenses are listed and never added. */
  licenseRowSaveable: boolean;
}

export interface NpiFillLicense {
  state: string;
  number: string;
  /** The blank row to fill, or null to add a row. */
  rowIndex: number | null;
}

export interface NpiFillKept {
  /** The form's label for the field. */
  field: string;
  registryValue: string;
}

export interface NpiRegistryDetail {
  label: string;
  lines: string[];
}

export interface NpiFillSummary {
  /** The form labels of what the pick filled: the NPI, then credentials,
   * taxonomy and licenses. */
  filled: string[];
  /** Fields that already held a different value and were kept. */
  kept: NpiFillKept[];
  /** Registry data no field on the form holds. Shown, never saved. */
  details: NpiRegistryDetail[];
}

export interface NpiFillPlan {
  npi: string;
  /** The value to set, or null to leave the field as it is. */
  credentials: string | null;
  taxonomyCode: string | null;
  licenses: NpiFillLicense[];
  summary: NpiFillSummary;
}

export const NPI_FILL_FIELD = {
  npi: "NPI",
  credentials: "Credentials",
  taxonomyCode: "Taxonomy code",
} as const;

const STATE_SET: ReadonlySet<string> = new Set(US_STATES);

/** Empty or only whitespace. */
export function isBlankField(value: string | null | undefined): boolean {
  return !value || value.trim() === "";
}

// Case, spaces and punctuation ignored: "P.T., D.P.T." is "PT, DPT", and
// "PT-4471" is "pt 4471".
function looseKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function licenseFieldLabel(state: string): string {
  return `${state} license`;
}

function taxonomyText(code: string, description: string | null): string {
  return description ? `${code} (${description})` : code;
}

/** "80202-1234" for a nine-digit ZIP, otherwise as stored. */
function postalCode(value: string): string {
  return /^\d{9}$/.test(value) ? `${value.slice(0, 5)}-${value.slice(5)}` : value;
}

/** "200 CLINIC WAY, SUITE 4, DENVER, CO 80202-1234 · 303-555-0199". */
export function formatRegistryAddress(address: NpiRegistryAddress): string {
  const stateZip = [address.state, address.postalCode ? postalCode(address.postalCode) : null]
    .filter(Boolean)
    .join(" ");
  const country = address.countryCode && address.countryCode !== "US" ? address.countryCode : null;
  const place = [address.line1, address.line2, address.city, stateZip || null, country]
    .filter(Boolean)
    .join(", ");
  return [place || null, address.phone].filter(Boolean).join(" · ");
}

function nameLine(name: NpiRegistryName): string {
  const full = [name.firstName, name.middleName, name.lastName].filter(Boolean).join(" ");
  return name.type ? `${full} (${name.type})` : full;
}

// Each state license the registry names, the primary taxonomy's first, once
// per state and number.
function registryLicenses(record: NpiRegistryRecord): { state: string; number: string }[] {
  const seen = new Set<string>();
  const licenses: { state: string; number: string }[] = [];
  for (const taxonomy of record.taxonomies ?? []) {
    const state = taxonomy.licenseState?.trim().toUpperCase();
    const number = taxonomy.license?.trim();
    if (!state || !number) continue;
    const key = `${state}|${looseKey(number)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    licenses.push({ state, number });
  }
  return licenses;
}

/** What a pick of `record` does to a form holding `form`. Never replaces a
 * field with a value, never alters a license row with data, and never leaves
 * the form unsaveable: a taxonomy outside the form's list and a license the
 * form could not save are listed instead. At "npi_only" only the NPI is set. */
export function planNpiRegistryFill(
  record: NpiRegistryRecord,
  form: NpiFillForm,
  fillOnPick: NpiFillOnPick = DEFAULT_NPI_REGISTRY_POLICY.fillOnPick,
): NpiFillPlan {
  const filled: string[] = [];
  const kept: NpiFillKept[] = [];
  const details: NpiRegistryDetail[] = [];
  const fillBlanks = fillOnPick === "blank_fields";

  if (stripNpiSeparators(form.npi) !== record.npi) filled.push(NPI_FILL_FIELD.npi);

  let credentials: string | null = null;
  if (record.credential) {
    if (!fillBlanks) {
      details.push({ label: NPI_FILL_FIELD.credentials, lines: [record.credential] });
    } else if (isBlankField(form.credentials)) {
      credentials = record.credential;
      filled.push(NPI_FILL_FIELD.credentials);
    } else if (looseKey(form.credentials) !== looseKey(record.credential)) {
      kept.push({ field: NPI_FILL_FIELD.credentials, registryValue: record.credential });
    }
  }

  let taxonomyCode: string | null = null;
  // The primary taxonomy is listed under "Other taxonomies" only when the
  // taxonomy field could not take it.
  let primaryListed = false;
  const primary = record.primaryTaxonomy;
  if (primary) {
    const code = normalizeTaxonomyCode(primary.code);
    if (!fillBlanks) {
      details.push({ label: "Primary taxonomy", lines: [taxonomyText(code, primary.description)] });
    } else if (isBlankField(form.taxonomyCode)) {
      if (isKnownTaxonomyCode(code)) {
        taxonomyCode = code;
        filled.push(NPI_FILL_FIELD.taxonomyCode);
      } else {
        primaryListed = true;
      }
    } else if (normalizeTaxonomyCode(form.taxonomyCode) !== code) {
      kept.push({
        field: NPI_FILL_FIELD.taxonomyCode,
        registryValue: taxonomyText(code, primary.description),
      });
    }
  }

  const licenses: NpiFillLicense[] = [];
  const notAdded: string[] = [];
  const usedBlankRows = new Set<number>();
  for (const license of registryLicenses(record)) {
    const line = `${license.state} ${license.number}`;
    if (!fillBlanks) {
      notAdded.push(line);
      continue;
    }
    const rowsInState = form.licenses.filter(
      (row) => !row.blank && row.state.trim().toUpperCase() === license.state,
    );
    if (rowsInState.length > 0) {
      // A row with data is never altered, even to add a missing number.
      const same = rowsInState.some((row) => looseKey(row.number) === looseKey(license.number));
      if (!same) {
        kept.push({ field: licenseFieldLabel(license.state), registryValue: license.number });
      }
      continue;
    }
    const stateTaken = licenses.some((placed) => placed.state === license.state);
    if (stateTaken || !STATE_SET.has(license.state) || !form.licenseRowSaveable) {
      notAdded.push(line);
      continue;
    }
    const blankIndex = form.licenses.findIndex((row, i) => row.blank && !usedBlankRows.has(i));
    if (blankIndex >= 0) usedBlankRows.add(blankIndex);
    licenses.push({
      state: license.state,
      number: license.number,
      rowIndex: blankIndex >= 0 ? blankIndex : null,
    });
    filled.push(licenseFieldLabel(license.state));
  }

  if (!fillBlanks && notAdded.length > 0) details.push({ label: "Licenses", lines: notAdded });
  if (record.middleName) details.push({ label: "Middle name", lines: [record.middleName] });
  if (record.suffix) details.push({ label: "Suffix", lines: [record.suffix] });

  const primaryCode = primary ? normalizeTaxonomyCode(primary.code) : null;
  const taxonomyLines: string[] = [];
  const listedCodes = new Set<string>();
  if (primary && primaryListed) {
    listedCodes.add(normalizeTaxonomyCode(primary.code));
    taxonomyLines.push(
      `${taxonomyText(normalizeTaxonomyCode(primary.code), primary.description)} — primary, not in the Taxonomy code list`,
    );
  }
  for (const taxonomy of record.taxonomies ?? []) {
    const code = normalizeTaxonomyCode(taxonomy.code);
    if (code === primaryCode || listedCodes.has(code)) continue;
    listedCodes.add(code);
    taxonomyLines.push(taxonomyText(code, taxonomy.description));
  }
  if (taxonomyLines.length > 0) details.push({ label: "Other taxonomies", lines: taxonomyLines });
  if (fillBlanks && notAdded.length > 0) {
    details.push({ label: "Licenses not added", lines: notAdded });
  }

  if (record.practiceAddress) {
    details.push({
      label: "Practice address",
      lines: [formatRegistryAddress(record.practiceAddress)],
    });
  }
  const otherLocations = (record.otherPracticeAddresses ?? []).map(formatRegistryAddress);
  if (otherLocations.length > 0) {
    details.push({ label: "Other practice locations", lines: otherLocations });
  }
  if (record.mailingAddress) {
    details.push({
      label: "Mailing address",
      lines: [formatRegistryAddress(record.mailingAddress)],
    });
  }
  if (record.otherNames.length > 0) {
    details.push({ label: "Other names", lines: record.otherNames.map(nameLine) });
  }
  const identifiers = (record.identifiers ?? []).map((id) => {
    const where = [id.state, id.issuer].filter(Boolean).join(", ");
    const what = `${id.type ?? "Identifier"} ${id.identifier}`;
    return where ? `${what} (${where})` : what;
  });
  if (identifiers.length > 0) details.push({ label: "Other identifiers", lines: identifiers });

  return {
    npi: record.npi,
    credentials,
    taxonomyCode,
    licenses,
    summary: { filled, kept, details },
  };
}

/** "Filled from the NPI Registry: NPI, Credentials." */
export function npiFillFilledText(summary: NpiFillSummary): string {
  return summary.filled.length > 0
    ? `Filled from the NPI Registry: ${summary.filled.join(", ")}.`
    : "Nothing blank to fill from the NPI Registry.";
}

/** "Kept yours: Taxonomy code — registry has 225X00000X (Occupational Therapist)." */
export function npiFillKeptText(summary: NpiFillSummary): string | null {
  if (summary.kept.length === 0) return null;
  const items = summary.kept.map((item) => `${item.field} — registry has ${item.registryValue}`);
  return `Kept yours: ${items.join("; ")}.`;
}

/** What the polite live region says after a pick. */
export function npiFillAnnouncement(summary: NpiFillSummary): string {
  return [
    npiFillFilledText(summary),
    npiFillKeptText(summary),
    summary.details.length > 0 ? "More registry details are listed below." : null,
  ]
    .filter(Boolean)
    .join(" ");
}
