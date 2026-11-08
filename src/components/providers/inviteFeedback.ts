// What staff see after an invite or resend: the toast for the email's outcome
// and the error line. Shared by the Invite dialog and the Onboarding card.
import { toast } from "sonner";
import type { InviteDelivery } from "@/services/providerInvites";

// The server's error string, except the off switch, which gets plain words.
export function inviteErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  if (err.message === "intake_paused")
    return "Provider invites are paused right now. Try again later.";
  return err.message;
}

export function notifyDelivery(delivery: InviteDelivery, sentMessage: string) {
  if (delivery === "sent") toast.success(sentMessage);
  else if (delivery === "sandbox")
    toast.warning("Invite saved. Email is in sandbox mode, so nothing was delivered.");
  else toast.warning("Invite saved, but the email didn't send. Resend it in 10 minutes.");
}
