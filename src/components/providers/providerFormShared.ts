// Shared constants, types, and validation for the Add Provider stepper.
// Record edit uses a separate inline Identity path (EditProviderForm retired).
import { NPI_CHECK_DIGIT_MESSAGE, NPI_FORMAT_MESSAGE, isValidNpi } from "@/lib/providerIdentity";
import { isKnownTaxonomyCode } from "@/lib/providerTaxonomy";
import {
  isBlankField,
  planNpiRegistryFill,
  type NpiFillSummary,
  type NpiPickTrace,
} from "@/lib/npiRegistryFill";
import type { NpiRegistryRecord } from "@/lib/npiRegistry";
import { DEFAULT_NPI_REGISTRY_POLICY, type NpiFillOnPick } from "@/lib/npiRegistryPolicy";

// Re-export the single mastered state list (src/lib/usStates.ts) rather than
// keep a second copy in sync — the provider forms import US_STATES from here.
export { US_STATES } from "@/lib/usStates";

export const SSN_LAST4_RE = /^\d{4}$/;
/** The provider CSV import's NPI shape (importSections.ts). Add Provider
 * itself now takes any ten digits with the check digit (NPI_DIGITS_RE). */
export const NPI_RE = /^1\d{9}$/;
export const NPI_DIGITS_RE = /^\d{10}$/;
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
 * (useNpiRegistrySaveBlock), or null. Required, so no call site can forget
 * the policy; the shape and the check digit come first. */
export function validateCredentials(
  f: ProviderFormState,
  registryBlock: string | null,
): ProviderFormErrors {
  const e: ProviderFormErrors = {};
  // Blank stays allowed (incomplete onboarding); an entered NPI must be ten
  // digits with the CMS check digit (MINT-7), the same rule as the roster
  // form. No first-digit rule: the leading-1 check this replaced refused
  // valid NPIs, and the type of an NPI is the registry's to say.
  if (f.npi && !NPI_DIGITS_RE.test(f.npi)) e.npi = NPI_FORMAT_MESSAGE;
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
  registryBlock: string | null,
): ProviderFormErrors {
  return { ...validatePersonal(f), ...validateCredentials(f, registryBlock) };
}

/** The errors that stop the stepper leaving `step`. */
export function validateProviderStep(
  step: number,
  f: ProviderFormState,
  registryBlock: string | null,
): ProviderFormErrors {
  if (step === 1) return validatePersonal(f);
  if (step === 2) return validateCredentials(f, registryBlock);
  return {};
}

/** A license row nobody has touched: every field still empty. */
export function isBlankLicenseRow(row: LicenseRow): boolean {
  return [row.state, row.number, row.type, row.issueDate, row.expirationDate].every(isBlankField);
}

/** What Add Provider remembers beside its form state about NPI Registry
 * picks. Not in ProviderFormState: that maps one to one onto import columns
 * (importSections.ts). */
export interface ProviderNpiPickContext {
  /** Staff chose the taxonomy; until then the preset is a default nobody
   * chose, and a pick may replace it. */
  taxonomyTouched: boolean;
  /** What the last pick wrote, or null before the first pick. */
  lastPick: NpiPickTrace | null;
}

/** MINT-110: a picked NPI Registry match applied to the Add Provider form.
 * The NPI is set; at "blank_fields" credentials, the taxonomy and the number
 * of a license row whose state matches fill when blank. Blank includes the
 * untouched preset taxonomy and whatever the last pick wrote that staff left
 * alone. No license row is added: other states come back as offers. */
export function applyNpiRegistryPick(
  form: ProviderFormState,
  record: NpiRegistryRecord,
  fillOnPick: NpiFillOnPick = DEFAULT_NPI_REGISTRY_POLICY.fillOnPick,
  context: ProviderNpiPickContext = { taxonomyTouched: false, lastPick: null },
): { form: ProviderFormState; summary: NpiFillSummary; trace: NpiPickTrace } {
  const plan = planNpiRegistryFill(
    record,
    {
      npi: form.npi,
      credentials: form.credentials,
      taxonomyCode: form.taxonomyCode,
      taxonomyUntouched: !context.taxonomyTouched,
      licenses: form.licenses.map((row) => ({ state: row.state, number: row.number })),
      // Add Provider saves a license row with any subset of its fields.
      licenseRowSaveable: true,
    },
    fillOnPick,
    context.lastPick,
  );
  const licenses = form.licenses.map((row, index) => {
    const change = plan.licenseNumbers.find((item) => item.rowIndex === index);
    return change ? { ...row, number: change.number } : row;
  });
  return {
    form: {
      ...form,
      npi: plan.npi,
      credentials: plan.credentials ?? form.credentials,
      taxonomyCode: plan.taxonomyCode ?? form.taxonomyCode,
      licenses,
    },
    summary: plan.summary,
    trace: plan.trace,
  };
}

/** Staff added an offered registry license: it fills the untouched empty row
 * when there is one, or a new row. Type and dates stay blank (NPPES has no
 * expiration date). */
export function addNpiLicenseOffer(
  licenses: LicenseRow[],
  offer: { state: string; number: string },
): LicenseRow[] {
  const filled = { state: offer.state, number: offer.number };
  const emptyRow = licenses.findIndex(isBlankLicenseRow);
  if (emptyRow < 0) return [...licenses, { ...emptyLicenseRow(), ...filled }];
  return licenses.map((row, index) => (index === emptyRow ? { ...row, ...filled } : row));
}
