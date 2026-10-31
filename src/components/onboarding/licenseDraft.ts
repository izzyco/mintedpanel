// License editor draft model (E1.3). Non-component module so the editor
// file exports only components (react-refresh rule).
import type { PsvStatus } from "@/lib/licensePsv";
import type { NpiFillLicense } from "@/lib/npiRegistryFill";
import type { LicenseInput } from "@/services/providers";

export interface LicenseDraft {
  /** Existing row id (edit); absent for new rows. */
  id?: string;
  state: string;
  licenseNumber: string;
  licenseType: string;
  issueDate: string;
  expirationDate: string;
  verifiedStatus: PsvStatus;
  verificationSourceUrl: string;
  /** Stored values (edit) — for the verified-on display + reset warnings. */
  storedExpirationDate?: string | null;
  storedVerifiedAt?: string | null;
}

export const EMPTY_LICENSE_DRAFT: LicenseDraft = {
  state: "",
  licenseNumber: "",
  licenseType: "full",
  issueDate: "",
  expirationDate: "",
  verifiedStatus: "unverified",
  verificationSourceUrl: "",
};

export function licenseDraftToValues(draft: LicenseDraft): Omit<LicenseInput, "id"> {
  return {
    state: draft.state,
    licenseNumber: draft.licenseNumber.trim() || null,
    licenseType: draft.licenseType.trim() || null,
    issueDate: draft.issueDate.trim() || null,
    expirationDate: draft.expirationDate.trim() || null,
    verifiedStatus: draft.verifiedStatus,
    verificationSourceUrl: draft.verificationSourceUrl.trim() || null,
  };
}

// Compare the original displayed draft, so defaults such as null -> "full"
// never turn an untouched existing row into an update.
export function licenseDraftsEqual(left: LicenseDraft, right: LicenseDraft): boolean {
  return JSON.stringify(licenseDraftToValues(left)) === JSON.stringify(licenseDraftToValues(right));
}

/** A row nobody has touched: no saved row behind it and nothing but the
 * editor's defaults (type Full, Unverified). */
export function isBlankLicenseDraft(draft: LicenseDraft): boolean {
  return (
    !draft.id &&
    [
      draft.state,
      draft.licenseNumber,
      draft.issueDate,
      draft.expirationDate,
      draft.verificationSourceUrl,
    ].every((value) => value.trim() === "") &&
    draft.licenseType === EMPTY_LICENSE_DRAFT.licenseType &&
    draft.verifiedStatus === EMPTY_LICENSE_DRAFT.verifiedStatus
  );
}

/** MINT-110: the licenses an NPI Registry pick places — into the blank row
 * named, or a new row with the editor's defaults. Other rows are untouched. */
export function placeRegistryLicenses(
  drafts: LicenseDraft[],
  licenses: NpiFillLicense[],
): LicenseDraft[] {
  const next = [...drafts];
  for (const license of licenses) {
    const filled = { state: license.state, licenseNumber: license.number };
    if (license.rowIndex === null) next.push({ ...EMPTY_LICENSE_DRAFT, ...filled });
    else next[license.rowIndex] = { ...next[license.rowIndex], ...filled };
  }
  return next;
}
