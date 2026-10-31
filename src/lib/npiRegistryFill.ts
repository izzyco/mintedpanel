// What picking an NPI Registry match fills on a provider form — MINT-110. Pure.
//
// The pick sets the NPI. With the policy's fillOnPick at "blank_fields" (the
// default, src/lib/npiRegistryPolicy) the registry also fills every blank
// field it can: Credentials, the taxonomy code, and the number of a license
// row whose state matches. Blank means empty, a preset nobody chose (Add
// Provider's taxonomy), or what the previous pick wrote or added and staff
// have not touched since — so picking the wrong person and then the right one
// leaves nothing of the first behind. Staff touch a field by editing it (the
// forms set the touched flags from user input only), so a value staff typed
// or chose is theirs even when it equals what a pick wrote. A value staff
// typed, chose, or loaded from the record is never replaced; when it differs
// from the registry the summary says so ("Kept yours").
//
// A pick never adds a license row. A registry license the form has no row for
// is offered, and staff add it with one click: a row feeds the provider's
// state footprint and readiness, NPPES has no expiration date, and NPPES
// licenses are self-reported. A row added from an offer, and a number a pick
// wrote, carry an NpiRowOrigin so the next pick can take them back. A license
// row whose verification is recorded is never given a registry number.
// Registry data with no field on the form is listed read-only and never
// saved. At "npi_only" nothing but the NPI is set, and everything else is
// listed.
//
// The form adapters (providerFormShared.ts for Add Provider, rosterNpi.ts for
// the roster form) describe their fields with NpiFillForm, keep the last
// pick's NpiPickTrace and the touched flags, and apply the plan; this module
// decides.
import { stripNpiSeparators } from "@/lib/providerIdentity";
import { isKnownTaxonomyCode, normalizeTaxonomyCode } from "@/lib/providerTaxonomy";
import { US_STATES } from "@/lib/usStates";
import type { NpiRegistryAddress, NpiRegistryName, NpiRegistryRecord } from "@/lib/npiRegistry";
import type { NpiFillOnPick } from "@/lib/npiRegistryPolicy";

/** Where a license row's registry data came from. Set by a pick or by staff
 * adding an offered license; `touched` once staff edit the row (any field of
 * an added row; the number of a row a pick filled). */
export interface NpiRowOrigin {
  /** "added": staff added the row from a pick's offer. "number": a pick wrote
   * the number into a row that had none. */
  kind: "added" | "number";
  touched: boolean;
}

export interface NpiFillLicenseRow {
  state: string;
  number: string;
  origin: NpiRowOrigin | null;
  /** The row's verification is recorded (verified or failed): its number is
   * never filled, so a registry number never rides on a verification of no
   * number. */
  numberLocked: boolean;
}

/** The form's fields the registry can fill, as they stand. */
export interface NpiFillForm {
  npi: string;
  credentials: string;
  /** Staff edited Credentials since the last pick wrote it (or at all). */
  credentialsTouched: boolean;
  /** "" when no taxonomy is selected. */
  taxonomyCode: string;
  /** Staff chose the taxonomy. */
  taxonomyTouched: boolean;
  /** The form's own preset taxonomy, or null. Until staff choose one it is a
   * default nobody chose, and a pick may replace it. */
  taxonomyPreset: string | null;
  licenses: NpiFillLicenseRow[];
  /** Whether the form saves a license row that holds only a state and a
   * number. NPPES has no expiration date, so when a row needs more, registry
   * licenses the form has no row for are listed and never offered. */
  licenseRowSaveable: boolean;
}

/** One value a pick wrote, and what the field held before it. */
export interface NpiPickWrite {
  written: string;
  previous: string;
}

/** What a pick wrote into the form's fields, so the next pick can take it
 * back. License rows carry their own NpiRowOrigin. */
export interface NpiPickTrace {
  credentials: NpiPickWrite | null;
  taxonomyCode: NpiPickWrite | null;
}

/** A registry license the form has no row for. */
export interface NpiLicenseOffer {
  state: string;
  number: string;
  /** A row on the form holds it (derived from the rows: npiOffersOnForm). */
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
  /** What the previous pick filled or added that this one had nothing for:
   * each field went back to what it held before, and each untouched added
   * row was removed. */
  cleared: string[];
  /** Fields that held a different value of staff's and were kept. */
  kept: NpiFillKept[];
  /** Rows staff added from the previous pick's offers and then edited, which
   * this match does not list: theirs to remove if they don't apply. */
  staleRows: string[];
  /** Licenses the form has no row for, for staff to add. */
  licenseOffers: NpiLicenseOffer[];
  /** Registry data no field on the form holds. Shown, never saved. */
  details: NpiRegistryDetail[];
}

export interface NpiFillPlan {
  npi: string;
  /** The value to set, or null to leave the field as it is. */
  credentials: string | null;
  taxonomyCode: string | null;
  /** Rows whose number or origin changes; every other row is untouched. ""
   * clears a number the previous pick wrote. */
  licenseRows: { rowIndex: number; number: string; origin: NpiRowOrigin | null }[];
  /** Rows to remove: untouched rows added from the previous pick's offers
   * that this match does not list. Apply after licenseRows. */
  removeRows: number[];
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

/** "CO license row": a row staff added from an offer. */
export function licenseRowFieldLabel(state: string): string {
  return `${state} license row`;
}

/** The same state and license number, case, spaces and punctuation aside. */
export function sameLicense(
  row: { state: string; number: string },
  license: { state: string; number: string },
): boolean {
  return (
    stateKey(row.state) === stateKey(license.state) &&
    !isBlankField(row.number) &&
    looseKey(row.number) === looseKey(license.number)
  );
}

/** A row's origin after staff edit the given fields: an added row is touched
 * by any edit, a filled number only by editing the number. */
export function touchNpiRowOrigin(
  origin: NpiRowOrigin | null | undefined,
  edited: { number: boolean },
): NpiRowOrigin | null {
  if (!origin || origin.touched) return origin ?? null;
  if (origin.kind === "added" || edited.number) return { ...origin, touched: true };
  return origin;
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

/** What a pick of `record` does to a form holding `form`, given what the last
 * pick wrote (null before the first pick). Never replaces a value of staff's,
 * never adds a license row, never fills a row whose verification is recorded,
 * and never leaves the form unsaveable: a taxonomy outside the form's list is
 * listed instead. At "npi_only" only the NPI is set. */
export function planNpiRegistryFill(
  record: NpiRegistryRecord,
  form: NpiFillForm,
  fillOnPick: NpiFillOnPick,
  lastPick: NpiPickTrace | null,
): NpiFillPlan {
  const fillBlanks = fillOnPick === "blank_fields";
  const filled: string[] = [];
  const cleared: string[] = [];
  const kept: NpiFillKept[] = [];
  const staleRows: string[] = [];
  const offers: NpiLicenseOffer[] = [];
  const details: NpiRegistryDetail[] = [];
  const trace: NpiPickTrace = { credentials: null, taxonomyCode: null };

  if (stripNpiSeparators(form.npi) !== record.npi) filled.push(NPI_FILL_FIELD.npi);

  // 1. Take back what the last pick wrote, where staff have not touched it.
  const credentials0 =
    lastPick?.credentials &&
    !form.credentialsTouched &&
    form.credentials === lastPick.credentials.written
      ? lastPick.credentials.previous
      : form.credentials;
  const taxonomy0 =
    lastPick?.taxonomyCode &&
    !form.taxonomyTouched &&
    form.taxonomyCode === lastPick.taxonomyCode.written
      ? lastPick.taxonomyCode.previous
      : form.taxonomyCode;
  const rows = form.licenses.map((row) => {
    const untouched = row.origin !== null && !row.origin.touched;
    return {
      state: stateKey(row.state),
      // A number the last pick wrote, untouched, is blank again.
      number: untouched && row.origin?.kind === "number" ? "" : row.number,
      // An untouched row added from the last pick's offer goes, unless this
      // match lists the same license.
      removable: untouched && row.origin?.kind === "added",
      // An added row staff edited is theirs; listed if this match drops it.
      staleAdded: row.origin?.kind === "added" && row.origin.touched,
      // A reverted number has no origin until this pick fills it again; an
      // edited row is staff's from now on.
      origin: untouched && row.origin?.kind === "added" ? row.origin : null,
      numberLocked: row.numberLocked,
      filledHere: false,
    };
  });

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
    const presetNobodyChose =
      !form.taxonomyTouched &&
      form.taxonomyPreset !== null &&
      normalizeTaxonomyCode(taxonomy0) === normalizeTaxonomyCode(form.taxonomyPreset);
    const replaceable = isBlankField(taxonomy0) || presetNobodyChose;
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
        // Not in the picker: keep the preset (or the blank) and list it.
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
  for (const license of registryLicenses(record)) {
    const line = `${license.state} ${license.number}`;
    if (!fillBlanks) {
      notAdded.push(line);
      continue;
    }
    const inState = rows.flatMap((row, i) => (row.state === license.state ? [i] : []));
    const holding = inState.find((i) => sameLicense(rows[i], license));
    if (holding !== undefined) {
      // Already on the form; an added row this match also lists stays.
      rows[holding].removable = false;
      rows[holding].staleAdded = false;
      continue;
    }
    const blankRow = inState.find(
      (i) => !rows[i].removable && !rows[i].numberLocked && isBlankField(rows[i].number),
    );
    if (blankRow !== undefined) {
      rows[blankRow].number = license.number;
      rows[blankRow].origin = { kind: "number", touched: false };
      rows[blankRow].filledHere = true;
      continue;
    }
    // A number staff entered in that state is kept and named.
    const staffNumber = inState.some(
      (i) => !rows[i].removable && !rows[i].filledHere && !isBlankField(rows[i].number),
    );
    if (staffNumber) {
      kept.push({ field: licenseFieldLabel(license.state), registryValue: license.number });
      continue;
    }
    if (offers.some((offer) => sameLicense(offer, license))) continue;
    if (STATE_SET.has(license.state) && form.licenseRowSaveable) {
      offers.push({ state: license.state, number: license.number, added: false });
    } else {
      notAdded.push(line);
    }
  }

  const licenseRows: NpiFillPlan["licenseRows"] = [];
  const removeRows: number[] = [];
  rows.forEach((row, rowIndex) => {
    const before = form.licenses[rowIndex];
    const label = before.state.trim().toUpperCase();
    if (row.removable) {
      removeRows.push(rowIndex);
      cleared.push(licenseRowFieldLabel(label));
      return;
    }
    if (row.staleAdded) staleRows.push(`${label} ${before.number}`.trim());
    const originChanged =
      (row.origin?.kind ?? null) !== (before.origin?.kind ?? null) ||
      (row.origin?.touched ?? null) !== (before.origin?.touched ?? null);
    if (row.number !== before.number || originChanged) {
      licenseRows.push({ rowIndex, number: row.number, origin: row.origin });
    }
    if (row.number !== before.number) {
      (row.filledHere ? filled : cleared).push(licenseNumberFieldLabel(label));
    }
  });

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
    licenseRows,
    removeRows,
    trace,
    summary: { filled, cleared, kept, staleRows, licenseOffers: offers, details },
  };
}

/** A plan's license-row changes applied to a form's rows: numbers and origins
 * set, then the removed rows dropped. `set` writes one row of the form's
 * shape. */
export function applyNpiLicenseRows<Row>(
  rows: Row[],
  plan: Pick<NpiFillPlan, "licenseRows" | "removeRows">,
  set: (row: Row, number: string, origin: NpiRowOrigin | null) => Row,
): Row[] {
  return rows.flatMap((row, index) => {
    if (plan.removeRows.includes(index)) return [];
    const change = plan.licenseRows.find((item) => item.rowIndex === index);
    return [change ? set(row, change.number, change.origin) : row];
  });
}

/** Where staff adding an offered license puts it: null when a row already
 * holds that license (nothing is added — a second row would also break the
 * database's one-row-per-state-and-number rule), else the untouched empty row
 * to fill, or "new". */
export function npiOfferTarget<Row>(
  rows: Row[],
  offer: { state: string; number: string },
  view: (row: Row) => { state: string; number: string },
  isEmpty: (row: Row) => boolean,
): { existing: number } | { fill: number } | { append: true } {
  const existing = rows.findIndex((row) => sameLicense(view(row), offer));
  if (existing >= 0) return { existing };
  const empty = rows.findIndex(isEmpty);
  return empty >= 0 ? { fill: empty } : { append: true };
}

/** The offers with `added` worked out from the rows the form holds now, so an
 * offer staff added and then removed can be added again. */
export function npiOffersOnForm(
  summary: NpiFillSummary,
  rows: { state: string; number: string }[],
): NpiFillSummary {
  return {
    ...summary,
    licenseOffers: summary.licenseOffers.map((offer) => ({
      ...offer,
      added: rows.some((row) => sameLicense(row, offer)),
    })),
  };
}

/** "Filled from the NPI Registry: NPI, Credentials." */
export function npiFillFilledText(summary: NpiFillSummary): string {
  return summary.filled.length > 0
    ? `Filled from the NPI Registry: ${summary.filled.join(", ")}.`
    : "Nothing blank to fill from the NPI Registry.";
}

/** "Cleared from the previous pick: Credentials, CO license row." */
export function npiFillClearedText(summary: NpiFillSummary): string | null {
  return summary.cleared.length > 0
    ? `Cleared from the previous pick: ${summary.cleared.join(", ")}.`
    : null;
}

/** "Kept yours: Taxonomy code — registry has 225X00000X (Occupational Therapist)." */
export function npiFillKeptText(summary: NpiFillSummary): string | null {
  if (summary.kept.length === 0) return null;
  const items = summary.kept.map((item) => `${item.field} — registry has ${item.registryValue}`);
  return `Kept yours: ${items.join("; ")}.`;
}

/** "Added from the previous pick — remove if it doesn't apply: CO PT-1111." */
export function npiFillStaleText(summary: NpiFillSummary): string | null {
  return summary.staleRows.length > 0
    ? `Added from the previous pick — remove if it doesn't apply: ${summary.staleRows.join(", ")}.`
    : null;
}

/** "The registry lists 2 licenses that are not on the form." */
export function npiFillOffersText(summary: NpiFillSummary): string | null {
  const count = summary.licenseOffers.length;
  if (count === 0) return null;
  return count === 1
    ? "The registry lists 1 license that is not on the form."
    : `The registry lists ${count} licenses that are not on the form.`;
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
    npiFillStaleText(summary),
    npiFillOffersText(summary),
    more,
  ]
    .filter(Boolean)
    .join(" ");
}
