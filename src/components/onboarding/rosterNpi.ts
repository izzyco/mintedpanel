// The roster form's Type 1 NPI rule and its NPI Registry pick (MINT-7,
// MINT-110). Non-component module so the form file exports only components
// (react-refresh rule).
import type { LicenseDraft } from "@/components/onboarding/licenseDraft";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import { planNpiRegistryFill, type NpiFillSummary, type NpiPickTrace } from "@/lib/npiRegistryFill";
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
 * what the last pick wrote. A saved row's number is filled only when it is
 * blank, and the save still goes through the form. No row is added. */
export function applyRosterNpiPick(
  fields: RosterNpiFields,
  licenses: LicenseDraft[],
  record: NpiRegistryRecord,
  fillOnPick: NpiFillOnPick,
  lastPick: NpiPickTrace | null,
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
      taxonomyCode: fields.taxonomyCode,
      // The roster form has no preset taxonomy: blank is "".
      taxonomyUntouched: false,
      licenses: licenses.map((draft) => ({ state: draft.state, number: draft.licenseNumber })),
      // A row needs only its state to save; the expiration date is optional.
      licenseRowSaveable: true,
    },
    fillOnPick,
    lastPick,
  );
  const patch: Partial<RosterNpiFields> = { npi: plan.npi };
  if (plan.credentials !== null) patch.credentials = plan.credentials;
  if (plan.taxonomyCode !== null) patch.taxonomyCode = plan.taxonomyCode;
  return {
    patch,
    licenses: licenses.map((draft, index) => {
      const change = plan.licenseNumbers.find((item) => item.rowIndex === index);
      return change ? { ...draft, licenseNumber: change.number } : draft;
    }),
    trace: plan.trace,
    summary: plan.summary,
  };
}
