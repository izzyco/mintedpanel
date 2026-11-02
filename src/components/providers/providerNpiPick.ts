// Add Provider's NPI Registry pick — MINT-110. Non-component module next to
// providerFormShared.ts (kept apart from the stepper's validation so the
// two change independently). What a pick fills is decided in
// src/lib/npiRegistryFill.ts; this applies it to ProviderFormState.
import {
  applyNpiLicenseRows,
  isBlankField,
  npiOfferTarget,
  planNpiRegistryFill,
  type NpiFillSummary,
  type NpiPickTrace,
  type NpiRowOrigin,
} from "@/lib/npiRegistryFill";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import type { NpiFillOnPick } from "@/lib/npiRegistryPolicy";
import { PROVIDER_GENDER_OPTIONS } from "@/lib/providerGender";
import {
  emptyLicenseRow,
  type LicenseRow,
  type ProviderFormState,
} from "@/components/providers/providerFormShared";

/** A license row nobody has touched: every field still empty. */
export function isUntouchedLicenseRow(row: LicenseRow): boolean {
  return [row.state, row.number, row.type, row.issueDate, row.expirationDate].every(isBlankField);
}

/** What Add Provider remembers beside its form state about NPI Registry
 * picks. Not in ProviderFormState: that maps one to one onto import columns
 * (importSections.ts). */
export interface ProviderNpiPickContext {
  /** Staff edited the field since the last pick wrote it (or at all), from
   * user input only. A taxonomy staff never chose is the preset, a default
   * nobody chose. */
  touched: { credentials: boolean; taxonomyCode: boolean; gender?: boolean; phone?: boolean };
  /** What the last pick wrote, or null before the first pick. */
  lastPick: NpiPickTrace | null;
  /** The preset taxonomy the form applied for its group (A32). While the
   * field still holds it untouched, it is a default nobody chose. */
  taxonomyPreset: string;
  /** When this pick's registry data was pulled (ISO timestamp). */
  pulledAt: string;
}

/** MINT-110: a picked NPI Registry match applied to the Add Provider form.
 * The NPI is set; at "blank_fields" credentials, the taxonomy and the number
 * of a license row whose state matches fill when blank. Blank includes the
 * untouched preset taxonomy and whatever the last pick wrote or added that
 * staff left alone; an untouched row the last pick added, or staff added
 * from its offer, goes. A license for a state with no row is added the way
 * staff add an offer (A37); one that can't be comes back as an offer. */
export function applyNpiRegistryPick(
  form: ProviderFormState,
  record: NpiRegistryRecord,
  fillOnPick: NpiFillOnPick,
  context: ProviderNpiPickContext,
): { form: ProviderFormState; summary: NpiFillSummary; trace: NpiPickTrace } {
  const plan = planNpiRegistryFill(
    record,
    {
      npi: form.npi,
      credentials: form.credentials,
      credentialsTouched: context.touched.credentials,
      taxonomyCode: form.taxonomyCode,
      taxonomyTouched: context.touched.taxonomyCode,
      taxonomyPreset: context.taxonomyPreset,
      licenses: form.licenses.map((row) => ({
        state: row.state,
        number: row.number,
        origin: row.npiOrigin ?? null,
        // Add Provider records no license verification.
        numberLocked: false,
      })),
      // Add Provider saves a license row with any subset of its fields.
      licenseRowSaveable: true,
      gender: {
        value: form.gender,
        options: PROVIDER_GENDER_OPTIONS.map((option) => option.value),
      },
      phone: form.phone,
      genderTouched: context.touched.gender,
      phoneTouched: context.touched.phone,
    },
    fillOnPick,
    context.lastPick,
  );
  const licenses = plan.addLicenses.reduce(
    (rows, license) => addNpiLicenseOffer(rows, license, context.pulledAt).licenses,
    applyNpiLicenseRows(
      form.licenses,
      plan,
      (row, number, origin) => ({
        ...row,
        number,
        npiOrigin: origin ? { ...origin, pulledAt: origin.pulledAt ?? context.pulledAt } : null,
      }),
      emptyLicenseRow,
    ),
  );
  return {
    form: {
      ...form,
      npi: plan.npi,
      credentials: plan.credentials ?? form.credentials,
      taxonomyCode: plan.taxonomyCode ?? form.taxonomyCode,
      // A36: a Gender or Phone used from the last pick, taken back.
      gender: plan.gender ?? form.gender,
      phone: plan.phone ?? form.phone,
      licenses,
    },
    summary: plan.summary,
    trace: plan.trace,
  };
}

/** A registry license added as a row — by a pick, for a state with no row
 * (A37), or by staff from a pick's offer: it fills the untouched empty row
 * when there is one, or a new row, marked as added from the pick (so the next
 * pick can take it back while it is untouched). Type and dates stay blank
 * (NPPES has no expiration date). When a row already holds that license
 * nothing is added, and `existing` names it. */
export function addNpiLicenseOffer(
  licenses: LicenseRow[],
  offer: { state: string; number: string },
  pulledAt: string,
): { licenses: LicenseRow[]; existing: number | null } {
  const target = npiOfferTarget(licenses, offer, (row) => row, isUntouchedLicenseRow);
  if ("existing" in target) return { licenses, existing: target.existing };
  const filled = { state: offer.state, number: offer.number };
  if ("append" in target) {
    const added: LicenseRow = {
      ...emptyLicenseRow(),
      ...filled,
      npiOrigin: { kind: "added", touched: false, pulledAt },
    };
    return { licenses: [...licenses, added], existing: null };
  }
  // Filling the empty row: taking it back later leaves the empty row again.
  const origin: NpiRowOrigin = { kind: "added", touched: false, replacedEmpty: true, pulledAt };
  return {
    licenses: licenses.map((row, index) =>
      index === target.fill ? { ...row, ...filled, npiOrigin: origin } : row,
    ),
    existing: null,
  };
}
