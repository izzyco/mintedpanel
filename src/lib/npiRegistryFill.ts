// What picking an NPI Registry match fills on a provider form — MINT-110. Pure.
//
// The pick sets the NPI. With the policy's fillOnPick at "blank_fields" (the
// default, src/lib/npiRegistryPolicy) the registry also fills every blank
// field it can: Credentials, the taxonomy code, and the number of a license
// row whose state matches. Blank means empty, a default nobody chose (Add
// Provider's preset taxonomy), or what the previous pick wrote and nobody has
// changed since — so picking the wrong person and then the right one leaves
// nothing of the first behind. A value staff typed, chose, or loaded from the
// record is never replaced; when it differs from the registry the summary
// says so ("Kept yours").
//
// A pick never adds a license row. A registry license for a state the form has
// no row for is offered, and staff add it with one click: a row feeds the
// provider's state footprint and readiness, NPPES has no expiration date, and
// NPPES licenses are self-reported. Registry data with no field on the form is
// listed read-only and never saved. At "npi_only" nothing but the NPI is set,
// and everything else is listed.
//
// The form adapters (providerFormShared.ts for Add Provider, rosterNpi.ts for
// the roster form) describe their fields with NpiFillForm, keep the last
// pick's NpiPickTrace, and apply the plan; this module decides.
import { stripNpiSeparators } from "@/lib/providerIdentity";
import { isKnownTaxonomyCode, normalizeTaxonomyCode } from "@/lib/providerTaxonomy";
import { US_STATES } from "@/lib/usStates";
import type { NpiRegistryAddress, NpiRegistryName, NpiRegistryRecord } from "@/lib/npiRegistry";
import { DEFAULT_NPI_REGISTRY_POLICY, type NpiFillOnPick } from "@/lib/npiRegistryPolicy";

export interface NpiFillLicenseRow {
  state: string;
  number: string;
}

/** The form's fields the registry can fill, as they stand. */
export interface NpiFillForm {
  npi: string;
  credentials: string;
  /** "" when no taxonomy is selected. */
  taxonomyCode: string;
  /** True while nobody has chosen the taxonomy: it holds the form's own
   * default, or what a pick wrote. Either way the registry may replace it. */
  taxonomyUntouched: boolean;
  licenses: NpiFillLicenseRow[];
  /** Whether the form saves a license row that holds only a state and a
   * number. NPPES has no expiration date, so when a row needs more, registry
   * licenses for other states are listed and never offered. */
  licenseRowSaveable: boolean;
}

/** One value a pick wrote, and what the field held before it. */
export interface NpiPickWrite {
  written: string;
  previous: string;
}

/** What a pick wrote, so the next pick can tell its data from staff's. */
export interface NpiPickTrace {
  credentials: NpiPickWrite | null;
  taxonomyCode: NpiPickWrite | null;
  /** License numbers written into rows of that state (the row was blank). */
  licenseNumbers: { state: string; number: string }[];
}

/** A registry license for a state the form has no row for. */
export interface NpiLicenseOffer {
  state: string;
  number: string;
  /** Staff added it from the summary. */
  added: boolean;
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
   * taxonomy and license numbers. */
  filled: string[];
  /** What the previous pick filled that this one had nothing for; each went
   * back to what it held before that pick. */
  cleared: string[];
  /** Fields that held a different value of staff's and were kept. */
  kept: NpiFillKept[];
  /** Licenses for states the form has no row for, for staff to add. */
  licenseOffers: NpiLicenseOffer[];
  /** Registry data no field on the form holds. Shown, never saved. */
  details: NpiRegistryDetail[];
}

export interface NpiFillPlan {
  npi: string;
  /** The value to set, or null to leave the field as it is. */
  credentials: string | null;
  taxonomyCode: string | null;
  /** License numbers to set, by row; "" clears a number the previous pick
   * wrote. Every other row is untouched. */
  licenseNumbers: { rowIndex: number; number: string }[];
  /** What this pick wrote; pass it to the next pick. */
  trace: NpiPickTrace;
  summary: NpiFillSummary;
}

/** What a form remembers about its last pick: the summary staff see, and the
 * trace the next pick needs. `seq` tells a new pick from a re-render. */
export interface NpiPickState {
  seq: number;
  npi: string;
  trace: NpiPickTrace;
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

function stateKey(value: string): string {
  return value.trim().toUpperCase();
}

/** "CO license": a license staff entered, in the "Kept yours" line. */
export function licenseFieldLabel(state: string): string {
  return `${state} license`;
}

/** "CO license number": the field a pick fills in a row of that state. */
export function licenseNumberFieldLabel(state: string): string {
  return `${state} license number`;
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
    const state = taxonomy.licenseState ? stateKey(taxonomy.licenseState) : "";
    const number = taxonomy.license?.trim();
    if (!state || !number) continue;
    const key = `${state}|${looseKey(number)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    licenses.push({ state, number });
  }
  return licenses;
}

// A field back to what it held before the last pick, when the pick's value is
// still there; anything staff changed since is theirs and stays.
function undoWrite(current: string, write: NpiPickWrite | null | undefined): string {
  return write && current === write.written ? write.previous : current;
}

/** What a pick of `record` does to a form holding `form`, given what the last
 * pick wrote. Never replaces a value of staff's, never adds a license row,
 * and never leaves the form unsaveable: a taxonomy outside the form's list is
 * listed instead. At "npi_only" only the NPI is set. */
export function planNpiRegistryFill(
  record: NpiRegistryRecord,
  form: NpiFillForm,
  fillOnPick: NpiFillOnPick = DEFAULT_NPI_REGISTRY_POLICY.fillOnPick,
  lastPick: NpiPickTrace | null = null,
): NpiFillPlan {
  const fillBlanks = fillOnPick === "blank_fields";
  const filled: string[] = [];
  const cleared: string[] = [];
  const kept: NpiFillKept[] = [];
  const offers: NpiLicenseOffer[] = [];
  const details: NpiRegistryDetail[] = [];
  const trace: NpiPickTrace = { credentials: null, taxonomyCode: null, licenseNumbers: [] };

  if (stripNpiSeparators(form.npi) !== record.npi) filled.push(NPI_FILL_FIELD.npi);

  // 1. Take back what the last pick wrote, where it is still untouched.
  const credentials0 = undoWrite(form.credentials, lastPick?.credentials);
  const taxonomy0 = undoWrite(form.taxonomyCode, lastPick?.taxonomyCode);
  const numbers = form.licenses.map((row) => row.number);
  for (const write of lastPick?.licenseNumbers ?? []) {
    const index = form.licenses.findIndex(
      (row, i) => stateKey(row.state) === write.state && numbers[i] === write.number,
    );
    if (index >= 0) numbers[index] = "";
  }

  // 2. Fill what is blank.
  let credentials = credentials0;
  if (record.credential) {
    if (!fillBlanks) {
      details.push({ label: NPI_FILL_FIELD.credentials, lines: [record.credential] });
    } else if (isBlankField(credentials0)) {
      credentials = record.credential;
      trace.credentials = { written: credentials, previous: credentials0 };
    } else if (looseKey(credentials0) !== looseKey(record.credential)) {
      kept.push({ field: NPI_FILL_FIELD.credentials, registryValue: record.credential });
    }
  }
  if (credentials !== form.credentials) {
    (trace.credentials ? filled : cleared).push(NPI_FILL_FIELD.credentials);
  }

  let taxonomy = taxonomy0;
  // The primary taxonomy is listed under "Other taxonomies" only when the
  // taxonomy field could not take it.
  let primaryListed = false;
  const primary = record.primaryTaxonomy;
  const primaryCode = primary ? normalizeTaxonomyCode(primary.code) : null;
  if (primary && primaryCode) {
    const replaceable = isBlankField(taxonomy0) || form.taxonomyUntouched;
    if (!fillBlanks) {
      details.push({
        label: "Primary taxonomy",
        lines: [taxonomyText(primaryCode, primary.description)],
      });
    } else if (replaceable) {
      if (isKnownTaxonomyCode(primaryCode)) {
        taxonomy = primaryCode;
        trace.taxonomyCode = { written: taxonomy, previous: taxonomy0 };
      } else {
        // Not in the picker: keep the default (or the blank) and list it.
        primaryListed = true;
      }
    } else if (normalizeTaxonomyCode(taxonomy0) !== primaryCode) {
      kept.push({
        field: NPI_FILL_FIELD.taxonomyCode,
        registryValue: taxonomyText(primaryCode, primary.description),
      });
    }
  }
  const taxonomyChanged =
    normalizeTaxonomyCode(taxonomy) !== normalizeTaxonomyCode(form.taxonomyCode);
  if (taxonomyChanged) (trace.taxonomyCode ? filled : cleared).push(NPI_FILL_FIELD.taxonomyCode);

  const notAdded: string[] = [];
  const pickRows = new Set<number>();
  for (const license of registryLicenses(record)) {
    const line = `${license.state} ${license.number}`;
    const rowsInState = form.licenses.flatMap((row, i) =>
      stateKey(row.state) === license.state ? [i] : [],
    );
    if (!fillBlanks) {
      notAdded.push(line);
      continue;
    }
    if (rowsInState.length > 0) {
      if (rowsInState.some((i) => looseKey(numbers[i]) === looseKey(license.number))) continue;
      const blankRow = rowsInState.find((i) => isBlankField(numbers[i]));
      if (blankRow !== undefined) {
        numbers[blankRow] = license.number;
        pickRows.add(blankRow);
        trace.licenseNumbers.push({ state: license.state, number: license.number });
        continue;
      }
      // A number staff entered is kept; a row this pick just filled leaves
      // the registry's second license in that state to an offer.
      if (rowsInState.some((i) => !pickRows.has(i))) {
        kept.push({ field: licenseFieldLabel(license.state), registryValue: license.number });
        continue;
      }
    }
    const offered = offers.some(
      (offer) =>
        offer.state === license.state && looseKey(offer.number) === looseKey(license.number),
    );
    if (offered) continue;
    if (STATE_SET.has(license.state) && form.licenseRowSaveable) {
      offers.push({ state: license.state, number: license.number, added: false });
    } else {
      notAdded.push(line);
    }
  }
  const licenseNumbers = numbers.flatMap((number, rowIndex) =>
    number !== form.licenses[rowIndex].number ? [{ rowIndex, number }] : [],
  );
  for (const { rowIndex } of licenseNumbers) {
    const label = licenseNumberFieldLabel(stateKey(form.licenses[rowIndex].state));
    (pickRows.has(rowIndex) ? filled : cleared).push(label);
  }

  // 3. What the registry lists that no field holds.
  if (!fillBlanks && notAdded.length > 0) details.push({ label: "Licenses", lines: notAdded });
  if (record.middleName) details.push({ label: "Middle name", lines: [record.middleName] });
  if (record.suffix) details.push({ label: "Suffix", lines: [record.suffix] });

  const taxonomyLines: string[] = [];
  // Never list the code the form holds, nor the primary when it is shown
  // elsewhere (filled, kept, or the npi_only "Primary taxonomy" line).
  const listedCodes = new Set<string>([normalizeTaxonomyCode(taxonomy)]);
  if (primary && primaryCode && primaryListed) {
    listedCodes.add(primaryCode);
    taxonomyLines.push(
      `${taxonomyText(primaryCode, primary.description)} — primary, not in the Taxonomy code list`,
    );
  } else if (primaryCode) {
    listedCodes.add(primaryCode);
  }
  for (const entry of record.taxonomies ?? []) {
    const code = normalizeTaxonomyCode(entry.code);
    if (listedCodes.has(code)) continue;
    listedCodes.add(code);
    taxonomyLines.push(taxonomyText(code, entry.description));
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
    credentials: credentials !== form.credentials ? credentials : null,
    taxonomyCode: taxonomyChanged ? taxonomy : null,
    licenseNumbers,
    trace,
    summary: { filled, cleared, kept, licenseOffers: offers, details },
  };
}

/** The pick state after staff add an offered license. */
export function markNpiLicenseOfferAdded(
  pick: NpiPickState,
  offer: Pick<NpiLicenseOffer, "state" | "number">,
): NpiPickState {
  return {
    ...pick,
    summary: {
      ...pick.summary,
      licenseOffers: pick.summary.licenseOffers.map((item) =>
        item.state === offer.state && item.number === offer.number
          ? { ...item, added: true }
          : item,
      ),
    },
  };
}

/** "Filled from the NPI Registry: NPI, Credentials." */
export function npiFillFilledText(summary: NpiFillSummary): string {
  return summary.filled.length > 0
    ? `Filled from the NPI Registry: ${summary.filled.join(", ")}.`
    : "Nothing blank to fill from the NPI Registry.";
}

/** "Cleared what the previous pick filled: Credentials." */
export function npiFillClearedText(summary: NpiFillSummary): string | null {
  return summary.cleared.length > 0
    ? `Cleared what the previous pick filled: ${summary.cleared.join(", ")}.`
    : null;
}

/** "Kept yours: Taxonomy code — registry has 225X00000X (Occupational Therapist)." */
export function npiFillKeptText(summary: NpiFillSummary): string | null {
  if (summary.kept.length === 0) return null;
  const items = summary.kept.map((item) => `${item.field} — registry has ${item.registryValue}`);
  return `Kept yours: ${items.join("; ")}.`;
}

/** "The registry lists 2 licenses for states with no license row." */
export function npiFillOffersText(summary: NpiFillSummary): string | null {
  const count = summary.licenseOffers.length;
  if (count === 0) return null;
  return count === 1
    ? "The registry lists 1 license for a state with no license row."
    : `The registry lists ${count} licenses for states with no license row.`;
}

/** What the polite live region says after a pick. */
export function npiFillAnnouncement(summary: NpiFillSummary): string {
  const more =
    summary.licenseOffers.length > 0
      ? "Add them below if they apply."
      : summary.details.length > 0
        ? "More registry details are listed below."
        : null;
  return [
    npiFillFilledText(summary),
    npiFillClearedText(summary),
    npiFillKeptText(summary),
    npiFillOffersText(summary),
    more,
  ]
    .filter(Boolean)
    .join(" ");
}
