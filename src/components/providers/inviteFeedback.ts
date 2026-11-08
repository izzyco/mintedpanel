// What staff see after an invite or resend: the toast for the email's outcome
// and the error line. Shared by the Invite dialog and the Onboarding card.
import { toast } from "sonner";
import { isIntakePaused } from "@/lib/intakeFlow";
import { RESEND_COOLDOWN_MS } from "@/lib/providerOnboarding";
import type { InviteDelivery } from "@/services/providerInvites";

const COOLDOWN_MINUTES = RESEND_COOLDOWN_MS / 60_000;

// The server's error string, except the off switch, which gets plain words.
export function inviteErrorMessage(err: unknown, fallback: string): string {
  if (isIntakePaused(err)) return "Provider invites are paused right now. Try again later.";
  return err instanceof Error ? err.message : fallback;
}

// A Cancel refused because she submitted after the card loaded gets plain
// words instead of the server's code. The card refetches on that error, so
// the stale Cancel button goes with it.
export function cancelErrorMessage(err: unknown, firstName: string): string {
  if (err instanceof Error && err.message === "already_submitted")
    return `${firstName} has already submitted, so the invitation can't be cancelled.`;
  return inviteErrorMessage(err, "The invitation couldn't be cancelled. Try again.");
}

export function notifyDelivery(delivery: InviteDelivery, sentMessage: string) {
  if (delivery === "sent") toast.success(sentMessage);
  else if (delivery === "sandbox")
    toast.warning("Invite saved. Email is in sandbox mode, so nothing was delivered.");
  else
    toast.warning(
      `Invite saved, but the email didn't send. Resend it in ${COOLDOWN_MINUTES} minutes.`,
    );
}
