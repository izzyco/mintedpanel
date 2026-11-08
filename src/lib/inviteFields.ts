// The invite form's values and its ready rule, shared by the staff dialog and
// the practice's New hires dialog (board 1).
import { NPI_CHECK_DIGIT_MESSAGE, NPI_FORMAT_MESSAGE, isValidNpi } from "@/lib/providerIdentity";

export const NO_GROUP = "__none__";

export interface InviteFieldValues {
  firstName: string;
  lastName: string;
  email: string;
  groupId: string;
  npi: string;
  startDate: string;
}

export const EMPTY_INVITE: InviteFieldValues = {
  firstName: "",
  lastName: "",
  email: "",
  groupId: NO_GROUP,
  npi: "",
  startDate: "",
};

export function inviteNpiProblem(npi: string): string | null {
  if (npi === "") return null;
  if (!/^\d{10}$/.test(npi)) return NPI_FORMAT_MESSAGE;
  if (!isValidNpi(npi)) return NPI_CHECK_DIGIT_MESSAGE;
  return null;
}

export function inviteFieldsReady(v: InviteFieldValues): boolean {
  return (
    Boolean(v.firstName.trim() && v.lastName.trim() && v.email.trim() && v.groupId !== NO_GROUP) &&
    inviteNpiProblem(v.npi) === null
  );
}
