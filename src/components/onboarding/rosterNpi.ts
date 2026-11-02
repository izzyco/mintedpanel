// The roster form's Type 1 NPI rule and its NPI Registry pick (MINT-7,
// MINT-110). Non-component module so the form file exports only components
// (react-refresh rule).
import {
  EMPTY_LICENSE_DRAFT,
  addRegistryLicenseDraft,
  type LicenseDraft,
} from "@/components/onboarding/licenseDraft";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import {
  applyNpiLicenseRows,
  planNpiRegistryFill,
  type NpiFillSummary,
  type NpiPickTrace,
} from "@/lib/npiRegistryFill";
import type { NpiFillOnPick } from "@/lib/npiRegistryPolicy";
import {
  NPI_CHECK_DIGIT_MESSAGE,
  NPI_FORMAT_MESSAGE,
  isValidNpi,
  stripNpiSeparators,
} from "@/lib/providerIdentity";

/** Why the roster form refuses the NPI, or null. Optional (Addendum 11, B3):
 * a blank NPI saves, and nothing asks the registry about it. An entered one
 * has its separators stripped and nothing else, so a pasted label or dots
 * fail. `check` is whether this save checks the NPI (identityFieldNeedsCheck:
 * entered or changed, or every stored one under recheckStoredOnEdit), so
 * legacy data never blocks an unrelated edit. These are facts about the
 * number and stay hard; the NPI Registry check never refuses a save. */
export function rosterNpiError(npi: string, check: boolean): string | null {
  if (!npi.trim()) return null;
  if (!check) return null;
  const digits = stripNpiSeparators(npi);
  if (!/^\d{10}$/.test(digits)) return NPI_FORMAT_MESSAGE;
  if (!isValidNpi(digits)) return NPI_CHECK_DIGIT_MESSAGE;
  return null;
}

/** The roster form's fields a pick can set, and (A36) the Gender and Phone
 * it offers candidates for. */
export interface RosterNpiFields {
  npi: string;
  credentials: string;
  taxonomyCode: string;
  gender?: string;
  phone?: string;
}

/** The values of the roster form's Gender options (ProviderRosterForm). */
export const ROSTER_GENDER_VALUES = ["female", "male", "nonbinary"] as const;

/** A picked NPI Registry match applied to the roster form: the NPI is set
 * and, at "blank_fields", credentials, the taxonomy and the number of a
 * license row whose state matches fill when blank — or when they still hold
 * what the last pick wrote and staff have not touched them. An untouched row
 * the last pick added, or staff added from its offer, goes unless this match
 * lists it. A saved row's blank number is filled only while its verification
 * is Unverified (a verified or failed row is skipped and its license offered
 * instead). A license for a state with no row is added as an unverified row
 * with no expiration date, the way staff add an offer (A37). The save still
 * goes through the form. */
export function applyRosterNpiPick(
  fields: RosterNpiFields,
  licenses: LicenseDraft[],
  record: NpiRegistryRecord,
  fillOnPick: NpiFillOnPick,
  context: {
    /** Staff edited the field since the last pick wrote it (or at all). */
    touched: { credentials: boolean; taxonomyCode: boolean; gender?: boolean; phone?: boolean };
    lastPick: NpiPickTrace | null;
    /** When this pick's registry data was pulled (ISO timestamp). */
    pulledAt: string;
  },
): {
  patch: Partial<RosterNpiFields>;
  licenses: LicenseDraft[];
  trace: NpiPickTrace;
  summary: NpiFillSummary;
} {
  const plan = planNpiRegistryFill(
    record,
    {
      npi: fields.npi,
      credentials: fields.credentials,
      credentialsTouched: context.touched.credentials,
      taxonomyCode: fields.taxonomyCode,
      taxonomyTouched: context.touched.taxonomyCode,
      // The roster form has no preset taxonomy: blank is "".
      taxonomyPreset: null,
      licenses: licenses.map((draft) => ({
        state: draft.state,
        number: draft.licenseNumber,
        origin: draft.npiOrigin ?? null,
        numberLocked: draft.verifiedStatus !== "unverified",
      })),
      // A row needs only its state to save; the expiration date is optional.
      licenseRowSaveable: true,
      gender:
        fields.gender === undefined
          ? undefined
          : { value: fields.gender, options: ROSTER_GENDER_VALUES },
      phone: fields.phone,
      genderTouched: context.touched.gender,
      phoneTouched: context.touched.phone,
    },
    fillOnPick,
    context.lastPick,
  );
  const patch: Partial<RosterNpiFields> = { npi: plan.npi };
  if (plan.credentials !== null) patch.credentials = plan.credentials;
  if (plan.taxonomyCode !== null) patch.taxonomyCode = plan.taxonomyCode;
  // A36: a Gender or Phone used from the last pick, taken back.
  if (plan.gender !== null) patch.gender = plan.gender;
  if (plan.phone !== null) patch.phone = plan.phone;
  return {
    patch,
    licenses: plan.addLicenses.reduce(
      (drafts, license) => addRegistryLicenseDraft(drafts, license, context.pulledAt).licenses,
      applyNpiLicenseRows(
        licenses,
        plan,
        (draft, number, origin) => ({
          ...draft,
          licenseNumber: number,
          npiOrigin: origin ? { ...origin, pulledAt: origin.pulledAt ?? context.pulledAt } : null,
        }),
        () => ({ ...EMPTY_LICENSE_DRAFT }),
      ),
    ),
    trace: plan.trace,
    summary: plan.summary,
  };
}
