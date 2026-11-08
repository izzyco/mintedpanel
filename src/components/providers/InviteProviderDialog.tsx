// Provider onboarding slice 1: a staff writer invites a provider (canvas board
// 1's modal). The server creates the onboarding provider and emails the link;
// a duplicate comes back as the existing provider with a Resend offer. A match
// outside the chosen group joins that group on the existing record, with no
// email.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
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
import { inviteErrorMessage, notifyDelivery } from "@/components/providers/inviteFeedback";
import type { ProviderInviteResult } from "@/services/providerInvites";

type Match = Extract<ProviderInviteResult, { outcome: "already_exists" | "added_group" }>;

export function InviteProviderDialog({ onClose }: { onClose: () => void }) {
  const groups = useProviderGroups();
  const invite = useCreateProviderInvite();
  const resend = useResendProviderInvite();
  const [values, setValues] = useState(EMPTY_INVITE);
  const [match, setMatch] = useState<Match | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = inviteFieldsReady(values);
  const groupOptions = (groups.data ?? [])
    .filter((g) => g.isActive)
    .map((g) => ({ id: g.id, name: g.name }));
  const groupName = groupOptions.find((g) => g.id === values.groupId)?.name ?? "the group";

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
      if (result.outcome !== "created") {
        setMatch(result);
        return;
      }
      notifyDelivery(result.delivery, `Invite sent to ${email.trim()}`);
      onClose();
    } catch (err) {
      setError(inviteErrorMessage(err, "The invite couldn't be sent."));
    }
  }

  async function onResend() {
    if (!match) return;
    setError(null);
    try {
      const { delivery, email: sentTo } = await resend.mutateAsync(match.providerId);
      notifyDelivery(delivery, `Invite sent to ${sentTo}`);
      onClose();
    } catch (err) {
      setError(inviteErrorMessage(err, "The invite couldn't be resent."));
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

        {match?.outcome === "added_group" ? (
          <div className="space-y-2 text-[13px]">
            <p>
              A provider with this email or NPI was already in this organization. Their record now
              includes {groupName}.
            </p>
            <p className="text-muted-foreground">
              No email was sent. To review their details, open their{" "}
              <Link
                to="/providers/$id"
                params={{ id: match.providerId }}
                className="underline"
                onClick={onClose}
              >
                provider record
              </Link>
              .
            </p>
          </div>
        ) : match ? (
          <div className="space-y-2 text-[13px]">
            <p>A provider with this email or NPI is already in this organization.</p>
            <p className="text-muted-foreground">
              The invite goes to the email on their record and replaces any earlier link. To check
              or correct their details first, open their{" "}
              <Link
                to="/providers/$id"
                params={{ id: match.providerId }}
                className="underline"
                onClick={onClose}
              >
                provider record
              </Link>{" "}
              instead.
            </p>
          </div>
        ) : (
          <InviteFields values={values} onChange={setValues} groups={groupOptions} />
        )}

        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {match?.outcome === "added_group" ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              {match ? (
                <Button onClick={onResend} disabled={resend.isPending}>
                  {resend.isPending ? "Sending…" : "Send them an invite"}
                </Button>
              ) : (
                <Button onClick={onSend} disabled={!ready || invite.isPending}>
                  {invite.isPending ? "Sending…" : "Send invite"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
