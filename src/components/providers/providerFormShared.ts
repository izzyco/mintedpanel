// Shared constants, types, and validation for the Add Provider stepper.
// Record edit uses a separate inline Identity path (EditProviderForm retired).
import { NPI_CHECK_DIGIT_MESSAGE, isValidNpi } from "@/lib/providerIdentity";
import { isKnownTaxonomyCode } from "@/lib/providerTaxonomy";
import { isBlankField, planNpiRegistryFill, type NpiFillSummary } from "@/lib/npiRegistryFill";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import { DEFAULT_NPI_REGISTRY_POLICY, type NpiFillOnPick } from "@/lib/npiRegistryPolicy";

// Re-export the single mastered state list (src/lib/usStates.ts) rather than
// keep a second copy in sync — the provider forms import US_STATES from here.
export { US_STATES } from "@/lib/usStates";

export const SSN_LAST4_RE = /^\d{4}$/;
export const NPI_RE = /^1\d{9}$/;
export const CAQH_RE = /^\d{8}$/;
export const EMAIL_RE = /^\S+@\S+\.\S+$/;

export interface LicenseRow {
  state: string;
  number: string;
  type: "full" | "compact" | "";
  issueDate: string;
  expirationDate: string;
}

export interface ProviderFormState {
  firstName: string;
  lastName: string;
  credentials: string;
  gender: string;
  dateOfBirth: string;
  ssnLast4: string;
  email: string;
  phone: string;
  npi: string;
  caqhId: string;
  isNewGrad: boolean;
  caqhLastAttestedDate: string;
  taxonomyCode: string;
  licenses: LicenseRow[];
  groupId: string;
  facilityIds: string[];
  specialty: string;
  startDate: string;
  degree: string;
  schoolName: string;
  graduationDate: string;
}

export const emptyProviderFormState: ProviderFormState = {
  firstName: "",
  lastName: "",
  credentials: "",
  gender: "",
  dateOfBirth: "",
  ssnLast4: "",
  email: "",
  phone: "",
  npi: "",
  caqhId: "",
  isNewGrad: false,
  caqhLastAttestedDate: "",
  taxonomyCode: "225100000X",
  licenses: [{ state: "", number: "", type: "", issueDate: "", expirationDate: "" }],
  groupId: "",
  facilityIds: [],
  specialty: "",
  startDate: "",
  degree: "",
  schoolName: "",
  graduationDate: "",
};

export type ProviderFormErrors = Partial<Record<string, string>>;

export type UpdateProviderField = <K extends keyof ProviderFormState>(
  key: K,
  value: ProviderFormState[K],
) => void;

export function emptyLicenseRow(): LicenseRow {
  return { state: "", number: "", type: "", issueDate: "", expirationDate: "" };
}

export function validateNames(f: ProviderFormState): ProviderFormErrors {
  const e: ProviderFormErrors = {};
  if (!f.firstName.trim()) e.firstName = "Required";
  if (!f.lastName.trim()) e.lastName = "Required";
  return e;
}

export function validatePersonal(f: ProviderFormState): ProviderFormErrors {
  const e: ProviderFormErrors = { ...validateNames(f) };
  if (f.ssnLast4 && !SSN_LAST4_RE.test(f.ssnLast4)) e.ssnLast4 = "Enter exactly 4 digits";
  if (f.email && !EMAIL_RE.test(f.email)) e.email = "Invalid email";
  return e;
}

/** `registryBlock` is why the NPI Registry policy refuses this NPI
 * (useNpiRegistrySaveBlock), or null; the check digit is checked first. */
export function validateCredentials(
  f: ProviderFormState,
  registryBlock: string | null = null,
): ProviderFormErrors {
  const e: ProviderFormErrors = {};
  // Blank stays allowed (incomplete onboarding); an entered NPI must pass the
  // shape AND the CMS check digit (MINT-7).
  if (f.npi && !NPI_RE.test(f.npi)) e.npi = "NPI must be 10 digits and start with 1";
  else if (f.npi && !isValidNpi(f.npi)) e.npi = NPI_CHECK_DIGIT_MESSAGE;
  else if (f.npi && registryBlock) e.npi = registryBlock;
  if (!f.isNewGrad && f.caqhId && !CAQH_RE.test(f.caqhId)) e.caqhId = "CAQH must be 8 digits";
  // Soft gate: value must be one of the picker options (PT/PTA + dietitian).
  // Blank stays allowed; the Credentials step defaults to Physical Therapist.
  if (f.taxonomyCode && !isKnownTaxonomyCode(f.taxonomyCode))
    e.taxonomyCode = "Select a taxonomy from the list";
  return e;
}

export function validateAll(
  f: ProviderFormState,
  registryBlock: string | null = null,
): ProviderFormErrors {
  return { ...validatePersonal(f), ...validateCredentials(f, registryBlock) };
}

/** A license row nobody has touched: every field still empty. */
export function isBlankLicenseRow(row: LicenseRow): boolean {
  return [row.state, row.number, row.type, row.issueDate, row.expirationDate].every(isBlankField);
}

/** MINT-110: a picked NPI Registry match applied to the Add Provider form.
 * The NPI is set; at "blank_fields" credentials, taxonomy and licenses fill
 * only when blank, and the default Physical Therapist taxonomy counts as a
 * value. */
export function applyNpiRegistryPick(
  form: ProviderFormState,
  record: NpiRegistryRecord,
  fillOnPick: NpiFillOnPick = DEFAULT_NPI_REGISTRY_POLICY.fillOnPick,
): { form: ProviderFormState; summary: NpiFillSummary } {
  const plan = planNpiRegistryFill(
    record,
    {
      npi: form.npi,
      credentials: form.credentials,
      taxonomyCode: form.taxonomyCode,
      licenses: form.licenses.map((row) => ({
        state: row.state,
        number: row.number,
        blank: isBlankLicenseRow(row),
      })),
      // Add Provider saves a license row with any subset of its fields.
      licenseRowSaveable: true,
    },
    fillOnPick,
  );
  const licenses = [...form.licenses];
  for (const license of plan.licenses) {
    const filled = { state: license.state, number: license.number };
    if (license.rowIndex === null) licenses.push({ ...emptyLicenseRow(), ...filled });
    else licenses[license.rowIndex] = { ...licenses[license.rowIndex], ...filled };
  }
  return {
    form: {
      ...form,
      npi: plan.npi,
      credentials: plan.credentials ?? form.credentials,
      taxonomyCode: plan.taxonomyCode ?? form.taxonomyCode,
      licenses,
    },
    summary: plan.summary,
  };
}
