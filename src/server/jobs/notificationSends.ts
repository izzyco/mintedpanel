// notification_sends (MINT-108): the per-recipient send record behind
// scheduled notification jobs, reached only through its two service-role
// RPCs (supabase/migrations/20261101100100_notification_sends.sql).
//
// There is no run ledger (MINT-106): every call runs the job. So a job that
// emails people claims each send first, keyed on (job, slot, org,
// recipient), and sends only what it claimed. The slot is what the send is
// once-only for: for the follow-up digest, the scheduled send (the org's
// local date, or `YYYY-MM-DD:2` for a twice-a-day second send). One row per
// key, so this claim alone keeps a recipient from getting a send twice.
//
// A send that may have been delivered (a network error or timeout, a
// SendGrid 5xx or 408, an unexplained error, a function that died mid-send)
// is left claimed and never resent: SendGrid has no idempotency key. Only a
// definite rejection (nothing was accepted) marks the row failed, and a later
// call may claim it again.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/** Mirrored by notification_sends_slot_check: a short key, never data. */
export const NOTIFICATION_SLOT_RE = /^[0-9A-Za-z:_-]{1,64}$/;

/** One recipient's send for one job, org and slot. */
export interface NotificationSendKey {
  job: string;
  orgId: string;
  slot: string;
  recipientUserId: string;
}

export interface NotificationSendLedger {
  /** True when this call now holds the send: a new key, or one whose last
   *  attempt was definitely rejected. False when it is already sent, or
   *  claimed by an attempt that may have delivered it: skip it. */
  claim(key: NotificationSendKey): Promise<boolean>;
  /** Records a claimed send `sent`, or `failed` (a definite rejection, so a
   *  later call may claim it again). False when the row is not claimed. */
  finish(key: NotificationSendKey, outcome: "sent" | "failed"): Promise<boolean>;
}

function keyArgs(key: NotificationSendKey) {
  return {
    p_job: key.job,
    p_slot: key.slot,
    p_org_id: key.orgId,
    p_recipient_user_id: key.recipientUserId,
  };
}

export function supabaseNotificationSendLedger(
  db: SupabaseClient<Database>,
): NotificationSendLedger {
  return {
    async claim(key) {
      const { data, error } = await db.rpc("claim_notification_send", keyArgs(key));
      if (error) throw error;
      return data === true;
    },
    async finish(key, outcome) {
      const { data, error } = await db.rpc("finish_notification_send", {
        ...keyArgs(key),
        p_outcome: outcome,
      });
      if (error) throw error;
      return data === true;
    },
  };
}
