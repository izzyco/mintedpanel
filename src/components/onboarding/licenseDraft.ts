// License editor draft model (E1.3). Non-component module so the editor
// file exports only components (react-refresh rule).
import type { PsvStatus } from "@/lib/licensePsv";
import { npiOfferTarget, type NpiRowOrigin } from "@/lib/npiRegistryFill";
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
  /** MINT-110: set when the row (or its number) came from the NPI Registry;
   * never saved (licenseDraftToValues names its fields). */
  npiOrigin?: NpiRowOrigin | null;
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

/** MINT-110: a registry license added as a row — by a pick, for a state with
 * no row (A37), or by staff from a pick's offer. It fills the untouched empty
 * row when there is one, or a new row with the editor's defaults (Unverified),
 * marked as added from the pick (so the next pick can take it back while it
 * is untouched); dates stay blank (NPPES has no expiration date). When a row already holds that license nothing is added —
 * a second row would break uq_state_licenses_provider_state_number — and
 * `existing` names it. */
export function addRegistryLicenseDraft(
  drafts: LicenseDraft[],
  offer: { state: string; number: string },
  pulledAt: string,
): { licenses: LicenseDraft[]; existing: number | null } {
  const target = npiOfferTarget(
    drafts,
    offer,
    (draft) => ({ state: draft.state, number: draft.licenseNumber }),
    isBlankLicenseDraft,
  );
  if ("existing" in target) return { licenses: drafts, existing: target.existing };
  const filled = { state: offer.state, licenseNumber: offer.number };
  if ("append" in target) {
    const added: LicenseDraft = {
      ...EMPTY_LICENSE_DRAFT,
      ...filled,
      npiOrigin: { kind: "added", touched: false, pulledAt },
    };
    return { licenses: [...drafts, added], existing: null };
  }
  // Filling the empty row: taking it back later leaves the empty row again.
  const origin: NpiRowOrigin = { kind: "added", touched: false, replacedEmpty: true, pulledAt };
  return {
    licenses: drafts.map((draft, index) =>
      index === target.fill ? { ...draft, ...filled, npiOrigin: origin } : draft,
    ),
    existing: null,
  };
}
