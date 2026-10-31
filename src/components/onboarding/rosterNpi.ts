// The roster form's Type 1 NPI rule and its NPI Registry pick (MINT-7,
// MINT-110). Non-component module so the form file exports only components
// (react-refresh rule).
import type { LicenseDraft } from "@/components/onboarding/licenseDraft";
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

/** Why the roster form refuses the NPI, or null. Required; separators are
 * stripped and nothing else, so a pasted label or dots fail. An unchanged
 * stored NPI is not re-validated, so legacy data never blocks an unrelated
 * edit. `registryBlock` is the NPI Registry policy's refusal
 * (useNpiRegistrySaveBlock), checked after the check digit. */
export function rosterNpiError(
  npi: string,
  changed: boolean,
  registryBlock: string | null,
): string | null {
  if (!npi.trim()) return "Type 1 NPI is required";
  if (!changed) return null;
  const digits = stripNpiSeparators(npi);
  if (!/^\d{10}$/.test(digits)) return NPI_FORMAT_MESSAGE;
  if (!isValidNpi(digits)) return NPI_CHECK_DIGIT_MESSAGE;
  return registryBlock;
}

/** The roster form's fields a pick can set. */
export interface RosterNpiFields {
  npi: string;
  credentials: string;
  taxonomyCode: string;
}

/** A picked NPI Registry match applied to the roster form: the NPI is set
 * and, at "blank_fields", credentials, the taxonomy and the number of a
 * license row whose state matches fill when blank — or when they still hold
 * what the last pick wrote and staff have not touched them. An untouched row
 * added from the last pick's offer goes unless this match lists it. A saved
 * row's blank number is filled only while its verification is Unverified
 * (a verified or failed row is skipped and its license offered instead), and
 * the save still goes through the form. No row is added. */
export function applyRosterNpiPick(
  fields: RosterNpiFields,
  licenses: LicenseDraft[],
  record: NpiRegistryRecord,
  fillOnPick: NpiFillOnPick,
  context: {
    /** Staff edited the field since the last pick wrote it (or at all). */
    touched: { credentials: boolean; taxonomyCode: boolean };
    lastPick: NpiPickTrace | null;
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
    },
    fillOnPick,
    context.lastPick,
  );
  const patch: Partial<RosterNpiFields> = { npi: plan.npi };
  if (plan.credentials !== null) patch.credentials = plan.credentials;
  if (plan.taxonomyCode !== null) patch.taxonomyCode = plan.taxonomyCode;
  return {
    patch,
    licenses: applyNpiLicenseRows(licenses, plan, (draft, number, origin) => ({
      ...draft,
      licenseNumber: number,
      npiOrigin: origin,
    })),
    trace: plan.trace,
    summary: plan.summary,
  };
}
