// A contact saved with no office phone (MINT-91 U8) is recorded in the
// bypassed-checks store (MINT-134) as contact.phone_missing: record table
// parties, the party's id, source panel, no context. The save never waits on
// it and never fails because of it: recordAdvisory (src/services/advisories.ts)
// resolves, never rejects, and turns any failure into one safe log line. The
// front end stays quiet.
//
// Where it is recorded:
//   Add person    createParty (src/services/parties.ts), after the insert.
//   Edit person   updateParty, only when this save blanked a stored phone. An
//                 unrelated edit of a contact that already had none records
//                 nothing.
//   Create org    useCreateOrganization, once the new org is the active org:
//                 create_organization returns only the org id, so the org's
//                 default organization contact (and sales rep, when one was
//                 sent) is read back here.
// Where it isn't:
//   Capture link  the recipient is anonymous, and record_workflow_advisory
//                 accepts only authenticated and service_role callers.
//                 Recording would take a private insert path inside
//                 submit_capture, and redefining submit_capture breaks
//                 scripts/security/verify-capture-boundary.mjs.
//   /contact      an inbound lead has no org, so there is nothing to record
//                 it against.
import { supabase } from "@/integrations/supabase/externalClient";
import { requireActiveOrg } from "@/lib/audit";
import {
  ADVISORY_LOCAL_REFUSAL,
  ADVISORY_RECORD_FAILED,
  reportAdvisoryFailure,
  type CheckKey,
} from "@/lib/advisoryChecks";
import { recordAdvisory } from "@/services/advisories";
import type { ContactInput, PartyRoleKey } from "@/types";

export const CONTACT_PHONE_MISSING = "contact.phone_missing" satisfies CheckKey;

/** Blank, whitespace included: every save path stores such a phone as NULL. */
export function isPhoneBlank(phone: string | null | undefined): boolean {
  return !phone?.trim();
}

/** Record one saved contact with no office phone. Fire and forget: it
 *  resolves, never rejects. */
export function recordContactPhoneMissing(partyId: string): Promise<void> {
  return recordAdvisory(CONTACT_PHONE_MISSING, { table: "parties", id: partyId });
}

/** The contacts create_organization saves, besides the owner (who has no
 *  phone field at all). */
export interface NewOrgContacts {
  customer: ContactInput;
  salesRep?: ContactInput;
}

/** After create_organization: record each contact it saved with no office
 *  phone. The RPC returns only the org id, so the party is found by its
 *  default role in the new org. Call it once the new org is the active org
 *  (recordAdvisory records against the active org). Never throws. */
export async function recordNewOrgContactsPhoneMissing(
  orgId: string,
  contacts: NewOrgContacts,
): Promise<void> {
  try {
    const roles: PartyRoleKey[] = [];
    if (isPhoneBlank(contacts.customer.phoneOffice)) roles.push("customer_escalation_contact");
    if (contacts.salesRep && isPhoneBlank(contacts.salesRep.phoneOffice)) roles.push("sales_rep");
    if (roles.length === 0) return;
    if (requireActiveOrg() !== orgId) {
      reportAdvisoryFailure(ADVISORY_RECORD_FAILED, CONTACT_PHONE_MISSING, ADVISORY_LOCAL_REFUSAL);
      return;
    }
    const { data, error } = await supabase
      .from("party_role_assignments")
      .select("party_id")
      .eq("org_id", orgId)
      .eq("scope_type", "org")
      .eq("is_default", true)
      .in("role_key", roles);
    if (error) {
      reportAdvisoryFailure(ADVISORY_RECORD_FAILED, CONTACT_PHONE_MISSING, error);
      return;
    }
    const partyIds = [...new Set((data ?? []).map((row) => row.party_id))];
    await Promise.all(partyIds.map((partyId) => recordContactPhoneMissing(partyId)));
  } catch (error) {
    reportAdvisoryFailure(ADVISORY_RECORD_FAILED, CONTACT_PHONE_MISSING, error);
  }
}
