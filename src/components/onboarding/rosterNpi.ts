// The roster form's Type 1 NPI rule (MINT-7, MINT-110). Non-component module
// so the form file exports only components (react-refresh rule).
import { NPI_CHECK_DIGIT_MESSAGE, isValidNpi, stripNpiSeparators } from "@/lib/providerIdentity";

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
  if (!/^\d{10}$/.test(digits)) return "NPI must be 10 digits";
  if (!isValidNpi(digits)) return NPI_CHECK_DIGIT_MESSAGE;
  return registryBlock;
}
