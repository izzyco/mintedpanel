// The invite form's values and its ready rule, shared by the staff dialog and
// the practice's New hires dialog (board 1).
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

export function inviteFieldsReady(v: InviteFieldValues): boolean {
  return Boolean(
    v.firstName.trim() && v.lastName.trim() && v.email.trim() && v.groupId !== NO_GROUP,
  );
}
