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
// A registry license for a state with no row on the form is added as a new
// row (A37): unverified, the registry's state and number, no expiration date
// (NPPES has none; the provider supplies it later, and a blank one never
// blocks a save). A license that can't be added that way — a second number in
// a state that has a row, or a state whose only row is verified or failed — is
// offered, and staff add it with one click. A row a pick added, a row added
// from an offer, and a number a pick wrote carry an NpiRowOrigin, so the next
// pick takes them back while untouched. A license row whose verification is
// recorded is never given a registry number.
// Registry data with no field on the form is listed read-only and never
// saved. At "npi_only" nothing but the NPI is set, and everything else is
// listed.
//
// Gender and Phone are never filled by a pick (A36). The registry's sex (when
// it maps to one of the form's Gender options) and its primary practice
// location's US phone are offered as candidates, one "Use" each, when they
// differ from what the field holds; nothing is preselected. A value staff
// used is the pick's, like a field it filled (the form records it in the
// trace): the next pick takes it back while untouched, unless that match
// lists the same value.
//
// The form adapters (providerFormShared.ts for Add Provider, rosterNpi.ts for
// the roster form) describe their fields with NpiFillForm, keep the last
// pick's NpiPickTrace and the touched flags, and apply the plan; this module
// decides.
import { fmtDate } from "@/lib/format";
import { providerGenderLabel } from "@/lib/providerGender";
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
  /** An added row that filled the form's untouched empty row: taking it back
   * leaves that empty row, as before the add. */
  replacedEmpty?: boolean;
  /** When the registry data was pulled (ISO timestamp): the value says "From
   * NPI Registry, <date>" until confirmed (A35). */
  pulledAt?: string;
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
   * licenses the form has no row for are listed, never added or offered. */
  licenseRowSaveable: boolean;
  /** A36: the form's Gender value and the values its Gender options offer,
   * and its Phone. Left out, nothing is offered for that field. */
  gender?: { value: string; options: readonly string[] };
  phone?: string;
  /** Staff edited Gender / Phone since using a candidate (or at all). */
  genderTouched?: boolean;
  phoneTouched?: boolean;
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
  /** A36: a registry candidate staff used for Gender or Phone (set by the
   * form, npiPickWithCandidate; a pick never writes these itself). */
  gender?: NpiPickWrite | null;
  phone?: NpiPickWrite | null;
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

/** A36: a registry value staff may put into a field a pick never fills. */
export interface NpiFieldCandidate {
  field: "gender" | "phone";
  /** The form's label for the field. */
  label: string;
  /** What goes into the field: a Gender option's value, or the phone. */
  value: string;
  /** What the registry lists, in its own terms: "sex: Female". */
  registryText: string;
  /** The field holds it (derived from the form: npiCandidatesOnForm). */
  inUse: boolean;
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
  /** Licenses the previous pick put on the form that this match does not
   * list and that stay: rows added from its offers that staff then edited,
   * and numbers it filled into rows staff have since verified or failed.
   * Theirs to remove if they don't apply. */
  staleRows: string[];
  /** Rows this pick added, "WY WY-0099": a state with no row (A37). */
  addedRows: string[];
  /** Licenses the pick could not add, for staff to add. */
  licenseOffers: NpiLicenseOffer[];
  /** Several taxonomies and none flagged primary (A35): a pick list for the
   * one-value taxonomy field, nothing preselected — never the first. */
  taxonomyChoices: { code: string; description: string | null }[];
  /** Registry values for Gender and Phone, for staff to use (A36). */
  candidates: NpiFieldCandidate[];
  /** Registry data no field on the form holds. Shown, never saved. */
  details: NpiRegistryDetail[];
}

export interface NpiFillPlan {
  npi: string;
  /** The value to set, or null to leave the field as it is. */
  credentials: string | null;
  taxonomyCode: string | null;
  /** A36: a candidate used from the last pick, taken back (a pick only offers
   * Gender and Phone, never sets a new value). */
  gender: string | null;
  phone: string | null;
  /** Rows whose number or origin changes; every other row is untouched. ""
   * clears a number the previous pick wrote. */
  licenseRows: { rowIndex: number; number: string; origin: NpiRowOrigin | null }[];
  /** Rows to remove: untouched rows added from the previous pick's offers
   * that this match does not list. Apply after licenseRows. */
  removeRows: number[];
  /** Rows to return to the form's empty row: like removeRows, for an added
   * row that had filled the form's untouched empty row. */
  resetRows: number[];
  /** Licenses to add as rows (A37), after the other row changes: each the
   * way staff add an offer (the untouched empty row, else a new row). */
  addLicenses: { state: string; number: string }[];
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
  /** When the registry data was pulled (ISO timestamp), for "From NPI
   * Registry, <date>" (A35). */
  pulledAt: string;
}

export const NPI_FILL_FIELD = {
  npi: "NPI",
  credentials: "Credentials",
  taxonomyCode: "Taxonomy code",
  gender: "Gender",
  phone: "Phone",
} as const;

// The Gender option each registry sex maps to directly (A36). NPPES records
// sex; the form asks gender, so nothing else is offered.
const SEX_GENDER = { F: "female", M: "male" } as const;
const SEX_WORD = { F: "Female", M: "Male" } as const;

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

/** "303-555-0199": a ten-digit US phone as the provider records hold it, or
 * null for anything else (letters, an extension, a country code). */
export function usPhoneCandidate(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!/^[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (!/^\d{10}$/.test(digits)) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function phoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/** The Gender value the registry's sex maps to ("female", "male"), or null
 * (A36: NPPES records sex, F or M; nothing else is offered). */
export function npiRegistryGender(record: NpiRegistryRecord): string | null {
  const sex = record.sex;
  return sex === "F" || sex === "M" ? SEX_GENDER[sex] : null;
}

/** The primary practice location's phone as "303-555-0199" (never the mailing
 * address's), US only, or null (A36). */
export function npiRegistryPhone(record: NpiRegistryRecord): string | null {
  const practice = record.practiceAddress;
  const us = !practice?.countryCode || practice.countryCode === "US";
  return us ? usPhoneCandidate(practice?.phone) : null;
}

// The registry's values for Gender and Phone (A36), whatever the form holds:
// the sex when it maps to one of the form's Gender options, and the primary
// practice location's phone (never the mailing address's), US only.
function registryCandidates(record: NpiRegistryRecord, form: NpiFillForm): NpiFieldCandidate[] {
  const candidates: NpiFieldCandidate[] = [];
  const sex = record.sex;
  const gender = npiRegistryGender(record);
  if (form.gender && gender && (sex === "F" || sex === "M")) {
    if (form.gender.options.includes(gender)) {
      candidates.push({
        field: "gender",
        label: NPI_FILL_FIELD.gender,
        value: gender,
        registryText: `sex: ${SEX_WORD[sex]}`,
        inUse: false,
      });
    }
  }
  const phone = npiRegistryPhone(record);
  if (form.phone !== undefined && phone) {
    candidates.push({
      field: "phone",
      label: NPI_FILL_FIELD.phone,
      value: phone,
      registryText: `practice phone: ${phone}`,
      inUse: false,
    });
  }
  return candidates;
}

function sameFieldValue(field: NpiFieldCandidate["field"], left: string, right: string): boolean {
  return field === "phone" ? phoneDigits(left) === phoneDigits(right) : left === right;
}

function nameLine(name: NpiRegistryName): string {
  const full = [name.firstName, name.middleName, name.lastName].filter(Boolean).join(" ");
  return name.type ? `${full} (${name.type})` : full;
}

/** Each state license the registry names, the primary taxonomy's first, once
 * per state and number. */
export function npiRegistryLicenses(
  record: NpiRegistryRecord,
): { state: string; number: string }[] {
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
 * adds a row only for a state with none, never fills a row whose verification
 * is recorded, and never leaves the form unsaveable: a taxonomy outside the
 * form's list is listed instead. At "npi_only" only the NPI is set. */
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
  const addLicenses: NpiFillPlan["addLicenses"] = [];
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
    const pickNumber = untouched && row.origin?.kind === "number";
    // A number the last pick wrote on a row staff have since verified or
    // failed is not taken back — the verification is about that number — but
    // it is the last pick's: listed, and this match's license offered.
    const lockedPickNumber = pickNumber && row.numberLocked;
    return {
      state: stateKey(row.state),
      // A number the last pick wrote, untouched, is blank again.
      number: pickNumber && !row.numberLocked ? "" : row.number,
      // An untouched row added from the last pick's offer goes, unless this
      // match lists the same license.
      removable: untouched && row.origin?.kind === "added",
      replacedEmpty: untouched && row.origin?.kind === "added" && row.origin.replacedEmpty === true,
      // The last pick's license that stays: listed if this match drops it.
      stale: (row.origin?.kind === "added" && row.origin.touched) || lockedPickNumber,
      lockedPickNumber,
      // A reverted number has no origin until this pick fills it again; an
      // edited (or since verified) row is staff's from now on.
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
  // No primary among several taxonomies (A35): the field takes one value, so
  // staff pick one; nothing is prefilled, and never the first. The choices
  // are the codes the picker offers — even when only one of them is, since
  // the registry still named several and none as primary.
  const taxonomyChoices: NpiFillSummary["taxonomyChoices"] = [];
  const registryCodes = new Set(
    (record.taxonomies ?? []).map((entry) => normalizeTaxonomyCode(entry.code)),
  );
  if (!primary && fillBlanks && registryCodes.size > 1) {
    for (const entry of record.taxonomies ?? []) {
      const code = normalizeTaxonomyCode(entry.code);
      if (!isKnownTaxonomyCode(code)) continue;
      if (taxonomyChoices.some((choice) => choice.code === code)) continue;
      taxonomyChoices.push({ code, description: entry.description });
    }
  }
  const taxonomyChanged =
    normalizeTaxonomyCode(taxonomy) !== normalizeTaxonomyCode(form.taxonomyCode);
  if (taxonomyChanged) (trace.taxonomyCode ? filled : cleared).push(NPI_FILL_FIELD.taxonomyCode);

  const notAdded: string[] = [];
  const licenses = npiRegistryLicenses(record);
  // First, the licenses already on the form: an added row this match also
  // lists stays. Marked before anything is filled or added, so what a pick
  // adds never depends on the order the registry lists its licenses in.
  const held = new Set<number>();
  if (fillBlanks) {
    licenses.forEach((license, index) => {
      const holding = rows.findIndex(
        (row) => row.state === license.state && sameLicense(row, license),
      );
      if (holding < 0) return;
      rows[holding].removable = false;
      rows[holding].stale = false;
      held.add(index);
    });
  }
  for (const [index, license] of licenses.entries()) {
    const line = `${license.state} ${license.number}`;
    if (!fillBlanks) {
      notAdded.push(line);
      continue;
    }
    if (held.has(index)) continue;
    const inState = rows.flatMap((row, i) => (row.state === license.state ? [i] : []));
    const blankRow = inState.find(
      (i) => !rows[i].removable && !rows[i].numberLocked && isBlankField(rows[i].number),
    );
    if (blankRow !== undefined) {
      rows[blankRow].number = license.number;
      rows[blankRow].origin = { kind: "number", touched: false };
      rows[blankRow].filledHere = true;
      continue;
    }
    // A37: no row of that state stays on the form (an untouched row of the
    // last pick's goes) and this pick added none: add one.
    const stateHasRow =
      inState.some((i) => !rows[i].removable) ||
      addLicenses.some((added) => added.state === license.state);
    if (!stateHasRow && STATE_SET.has(license.state) && form.licenseRowSaveable) {
      addLicenses.push({ state: license.state, number: license.number });
      continue;
    }
    // A number staff entered in that state is kept and named; a row of a
    // pick's is not staff's.
    const staffNumber = inState.some(
      (i) =>
        !rows[i].removable &&
        !rows[i].filledHere &&
        !rows[i].lockedPickNumber &&
        rows[i].origin?.kind !== "added" &&
        !isBlankField(rows[i].number),
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
  const resetRows: number[] = [];
  rows.forEach((row, rowIndex) => {
    const before = form.licenses[rowIndex];
    const label = before.state.trim().toUpperCase();
    if (row.removable) {
      (row.replacedEmpty ? resetRows : removeRows).push(rowIndex);
      cleared.push(licenseRowFieldLabel(label));
      return;
    }
    if (row.stale) staleRows.push(`${label} ${before.number}`.trim());
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
  for (const code of taxonomyChoices.map((choice) => choice.code)) listedCodes.add(code);
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

  // 4. Gender and Phone (A36), offered under blank_fields like license offers
  // and taxonomy choices, when they differ from the field. A candidate used
  // from the last pick, untouched since, is the last pick's: kept, and still
  // marked, when this match lists the same value; else taken back to what
  // the field held before.
  const offered = fillBlanks ? registryCandidates(record, form) : [];
  const candidates: NpiFieldCandidate[] = [];
  const takenBack: { gender: string | null; phone: string | null } = { gender: null, phone: null };
  for (const field of ["gender", "phone"] as const) {
    const current = field === "gender" ? form.gender?.value : form.phone;
    if (current === undefined) continue;
    const touched = field === "gender" ? form.genderTouched : form.phoneTouched;
    const candidate = offered.find((item) => item.field === field);
    const write = lastPick?.[field];
    let value = current;
    if (write && !touched && current === write.written) {
      if (candidate && sameFieldValue(field, candidate.value, write.written)) {
        trace[field] = write;
      } else {
        value = write.previous;
        takenBack[field] = value;
        cleared.push(NPI_FILL_FIELD[field]);
      }
    }
    if (candidate && !sameFieldValue(field, candidate.value, value)) candidates.push(candidate);
  }

  return {
    npi: record.npi,
    credentials: credentials !== form.credentials ? credentials : null,
    taxonomyCode: taxonomyChanged ? taxonomy : null,
    gender: takenBack.gender,
    phone: takenBack.phone,
    licenseRows,
    removeRows,
    resetRows,
    addLicenses,
    trace,
    summary: {
      filled,
      cleared,
      kept,
      staleRows,
      addedRows: addLicenses.map((added) => `${added.state} ${added.number}`),
      licenseOffers: offers,
      taxonomyChoices,
      candidates,
      details,
    },
  };
}

/** A plan's license-row changes applied to a form's rows: numbers and origins
 * set, removed rows dropped, reset rows returned to `empty()`. `set` writes
 * one row of the form's shape. */
export function applyNpiLicenseRows<Row>(
  rows: Row[],
  plan: Pick<NpiFillPlan, "licenseRows" | "removeRows" | "resetRows">,
  set: (row: Row, number: string, origin: NpiRowOrigin | null) => Row,
  empty: () => Row,
): Row[] {
  return rows.flatMap((row, index) => {
    if (plan.removeRows.includes(index)) return [];
    if (plan.resetRows.includes(index)) return [empty()];
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

/** The candidates with `inUse` worked out from what the fields hold now, so a
 * used one reads "On the form" and comes back if staff change the field. */
export function npiCandidatesOnForm(
  summary: NpiFillSummary,
  form: { gender: string; phone: string },
): NpiFillSummary {
  return {
    ...summary,
    candidates: summary.candidates.map((candidate) => ({
      ...candidate,
      inUse:
        candidate.field === "gender"
          ? form.gender === candidate.value
          : phoneDigits(form.phone) === phoneDigits(candidate.value),
    })),
  };
}

/** The pick after staff use one of its candidates (A36): the trace keeps what
 * the field held, so the value is marked as the registry's until staff edit
 * it, and the next pick takes it back unless that match lists it too. */
export function npiPickWithCandidate(
  pick: NpiPickState,
  candidate: Pick<NpiFieldCandidate, "field" | "value">,
  previous: string,
): NpiPickState {
  return {
    ...pick,
    trace: { ...pick.trace, [candidate.field]: { written: candidate.value, previous } },
  };
}

/** "Filled from the NPI Registry: NPI, Credentials." */
export function npiFillFilledText(summary: NpiFillSummary): string {
  return summary.filled.length > 0
    ? `Filled from the NPI Registry: ${summary.filled.join(", ")}.`
    : "Nothing blank to fill from the NPI Registry.";
}

/** "Added a license row from the NPI Registry: WY WY-0099, with no
 * expiration date." (A37) */
export function npiFillAddedText(summary: NpiFillSummary): string | null {
  const rows = summary.addedRows;
  if (rows.length === 0) return null;
  return rows.length === 1
    ? `Added a license row from the NPI Registry: ${rows[0]}, with no expiration date.`
    : `Added license rows from the NPI Registry: ${rows.join(", ")}, with no expiration dates.`;
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

/** "From the previous pick — remove if it doesn't apply: CO PT-1111." */
export function npiFillStaleText(summary: NpiFillSummary): string | null {
  return summary.staleRows.length > 0
    ? `From the previous pick — remove if it doesn't apply: ${summary.staleRows.join(", ")}.`
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

/** "The registry also lists sex: Female and practice phone: 303-555-0199." */
export function npiFillCandidatesText(summary: NpiFillSummary): string | null {
  if (summary.candidates.length === 0) return null;
  return `The registry also lists ${summary.candidates.map((c) => c.registryText).join(" and ")}.`;
}

/** What the polite live region says after a pick. */
export function npiFillAnnouncement(summary: NpiFillSummary): string {
  const offers = summary.licenseOffers.length > 0;
  const candidates = summary.candidates.length > 0;
  const more =
    summary.taxonomyChoices.length > 0
      ? "The registry lists several taxonomies and none as primary; choose one below."
      : offers && candidates
        ? "Add or use them below if they apply."
        : offers
          ? "Add them below if they apply."
          : candidates
            ? "Use them below if they apply."
            : summary.details.length > 0
              ? "More registry details are listed below."
              : null;
  return [
    npiFillFilledText(summary),
    npiFillAddedText(summary),
    npiFillClearedText(summary),
    npiFillKeptText(summary),
    npiFillStaleText(summary),
    npiFillOffersText(summary),
    npiFillCandidatesText(summary),
    more,
  ]
    .filter(Boolean)
    .join(" ");
}

/** "From NPI Registry, Oct 31, 2026": what a value a pick filled says until
 * the review step's submit confirms it (A35). */
export function npiRegistrySourceLabel(pulledAt: string): string {
  return `From NPI Registry, ${fmtDate(pulledAt)}`;
}

/** The values that still hold what a pick filled or added, untouched by
 * staff: registry-sourced until the review step's submit confirms them (A35).
 * A value staff typed, chose or edited is theirs. `lines` is what the review
 * step lists, one line per pull date: "From NPI Registry, Oct 31, 2026:
 * Credentials DPT; CO license PT-4471". A license row carries its own pull
 * date (an offer added from an earlier pick keeps that pick's). */
export function npiRegistrySourcedFields(
  pick: NpiPickState | null,
  form: {
    credentials: string;
    credentialsTouched: boolean;
    taxonomyCode: string;
    taxonomyTouched: boolean;
    licenses: { state: string; number: string; origin: NpiRowOrigin | null | undefined }[];
    /** A36: a used candidate (in the pick's trace) is the registry's while
     * the field holds it and staff have not edited the field since. */
    gender?: { value: string; touched: boolean };
    phone?: { value: string; touched: boolean };
  },
): {
  credentials: boolean;
  taxonomyCode: boolean;
  gender: boolean;
  phone: boolean;
  /** The license rows that still hold what a pick added or filled. */
  licenses: { state: string; number: string }[];
  lines: { label: string; values: string[] }[];
} {
  const holds = (write: NpiPickWrite | null | undefined, value: string, touched: boolean) =>
    Boolean(write) && !touched && value === write?.written;
  const credentials = holds(pick?.trace.credentials, form.credentials, form.credentialsTouched);
  const taxonomyCode = holds(pick?.trace.taxonomyCode, form.taxonomyCode, form.taxonomyTouched);
  const gender = Boolean(
    form.gender && holds(pick?.trace.gender, form.gender.value, form.gender.touched),
  );
  const phone = Boolean(
    form.phone && holds(pick?.trace.phone, form.phone.value, form.phone.touched),
  );
  const lines: { label: string; values: string[] }[] = [];
  const put = (pulledAt: string, value: string) => {
    const label = npiRegistrySourceLabel(pulledAt);
    const line = lines.find((item) => item.label === label);
    if (line) line.values.push(value);
    else lines.push({ label, values: [value] });
  };
  if (pick && credentials) put(pick.pulledAt, `Credentials ${form.credentials}`);
  if (pick && gender) put(pick.pulledAt, `Gender ${providerGenderLabel(form.gender?.value)}`);
  if (pick && phone) put(pick.pulledAt, `Phone ${form.phone?.value}`);
  if (pick && taxonomyCode) put(pick.pulledAt, `Taxonomy code ${form.taxonomyCode}`);
  const licenses: { state: string; number: string }[] = [];
  for (const row of form.licenses) {
    const origin = row.origin;
    if (!origin || origin.touched || !origin.pulledAt || !row.number.trim()) continue;
    put(origin.pulledAt, `${row.state} license ${row.number}`);
    licenses.push({ state: row.state, number: row.number });
  }
  return { credentials, taxonomyCode, gender, phone, licenses, lines };
}
