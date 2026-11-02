// Provider onboarding slice 1: a staff writer invites a provider (canvas board
// 1's modal). The server creates the onboarding provider and emails the link;
// a duplicate comes back as the existing provider with a Resend offer.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { InviteFields } from "@/components/providers/InviteFields";
import { EMPTY_INVITE, inviteFieldsReady } from "@/lib/inviteFields";
import { useProviderGroups } from "@/hooks/useLookups";
import { useCreateProviderInvite, useResendProviderInvite } from "@/hooks/useProviderInvites";
import type { InviteDelivery } from "@/services/providerInvites";

function notifyDelivery(delivery: InviteDelivery, sentMessage: string) {
  if (delivery === "sent") toast.success(sentMessage);
  else if (delivery === "sandbox")
    toast.warning("Invite saved. Email is in sandbox mode, so nothing was delivered.");
  else toast.warning("Invite saved, but the email didn't send. Resend it in 10 minutes.");
}

export function InviteProviderDialog({ onClose }: { onClose: () => void }) {
  const groups = useProviderGroups();
  const invite = useCreateProviderInvite();
  const resend = useResendProviderInvite();
  const [values, setValues] = useState(EMPTY_INVITE);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = inviteFieldsReady(values);

  async function onSend() {
    setError(null);
    const { firstName, lastName, email, groupId, npi, startDate } = values;
    try {
      const result = await invite.mutateAsync({
        firstName,
        lastName,
        email,
        groupId,
        npi: npi.trim() || undefined,
        startDate: startDate || undefined,
      });
      if (result.outcome === "already_exists") {
        setExistingId(result.providerId);
        return;
      }
      notifyDelivery(result.delivery, `Invite sent to ${email.trim()}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The invite couldn't be sent.");
    }
  }

  async function onResend() {
    if (!existingId) return;
    setError(null);
    try {
      const { delivery, email: sentTo } = await resend.mutateAsync(existingId);
      notifyDelivery(delivery, `Invite sent to ${sentTo}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The invite couldn't be resent.");
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a provider</DialogTitle>
          <DialogDescription>
            They get an email from the practice and verify with a code sent to that address.
          </DialogDescription>
        </DialogHeader>

        {existingId ? (
          <div className="space-y-2 text-[13px]">
            <p>A provider with this email or NPI is already in this organization.</p>
            <p className="text-muted-foreground">
              The invite goes to the email on their record and replaces any earlier link. To check
              or correct their details first, open their{" "}
              <Link
                to="/providers/$id"
                params={{ id: existingId }}
                className="underline"
                onClick={onClose}
              >
                provider record
              </Link>{" "}
              instead.
            </p>
          </div>
        ) : (
          <InviteFields
            values={values}
            onChange={setValues}
            groups={(groups.data ?? [])
              .filter((g) => g.isActive)
              .map((g) => ({ id: g.id, name: g.name }))}
          />
        )}

        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {existingId ? (
            <Button onClick={onResend} disabled={resend.isPending}>
              {resend.isPending ? "Sending…" : "Send them an invite"}
            </Button>
          ) : (
            <Button onClick={onSend} disabled={!ready || invite.isPending}>
              {invite.isPending ? "Sending…" : "Send invite"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
