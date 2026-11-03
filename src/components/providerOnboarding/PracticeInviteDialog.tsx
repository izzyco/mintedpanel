// Boards 1 and 1b: the practice's Invite dialog. The same field block as the
// staff dialog; the match against people already on file decides the outcome.
import { useState, type ReactNode } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InviteFields } from "@/components/providers/InviteFields";
import { EMPTY_INVITE, inviteFieldsReady, type InviteFieldValues } from "@/lib/inviteFields";
import { fmtDate } from "@/lib/format";
import { hireByEmail, type InviteInput, type NewHiresState } from "@/lib/newHires";
import { canResend, classifyInvite } from "@/lib/providerOnboarding";
import type { InviteMatch } from "@/types/providerOnboarding";
import { firstName, shortGroupName } from "./hireCopy";
import {
  PRACTICE_BODY,
  PRACTICE_DIALOG,
  PRACTICE_FOOTER,
  PRACTICE_HEADER,
  PRACTICE_TITLE,
} from "./HireDialogs";
import { SENT_LOOK } from "./HireTable";

type Step =
  | { kind: "form" }
  | { kind: "result"; match: InviteMatch; input: InviteInput; emailFailed: boolean };

function toInput(v: InviteFieldValues): InviteInput {
  return {
    firstName: v.firstName.trim(),
    lastName: v.lastName.trim(),
    email: v.email.trim(),
    npi: v.npi.trim(),
    groupName: v.groupId,
    startDate: v.startDate || null,
  };
}

function matchedOn(on: "email" | "npi"): string {
  return on === "email" ? "matched on email" : "matched on NPI";
}

export function PracticeInviteDialog({
  state,
  practiceName,
  groups,
  now,
  emailFails,
  onInvite,
  onClose,
}: {
  state: NewHiresState;
  practiceName: string;
  groups: string[];
  now: Date;
  emailFails: boolean;
  onInvite: (input: InviteInput) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState(EMPTY_INVITE);
  const [step, setStep] = useState<Step>({ kind: "form" });

  function send() {
    const input = toInput(values);
    const match = classifyInvite(input, state.people);
    // A new person is saved and emailed at once, and another group is added
    // with no email. Every other match asks first.
    if (match.kind === "new" || match.kind === "on_file_other_group") onInvite(input);
    setStep({ kind: "result", match, input, emailFailed: emailFails });
  }

  function confirm(input: InviteInput, email: string) {
    onInvite(input);
    if (emailFails) toast.warning(`Saved, but the email to ${email} didn't send. Resend it later.`);
    else toast.success(`Invitation sent to ${email}`);
    onClose();
  }

  const back = () => setStep({ kind: "form" });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={PRACTICE_DIALOG}>
        {step.kind === "form" ? (
          <>
            <DialogHeader className={PRACTICE_HEADER}>
              <DialogTitle className={PRACTICE_TITLE}>Invite a provider</DialogTitle>
              <DialogDescription className="text-[12px]">
                They get an email from you and sign in with a code sent to that address.
              </DialogDescription>
            </DialogHeader>
            <InviteFields
              values={values}
              onChange={setValues}
              groups={groups.map((g) => ({ id: g, name: g }))}
            />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <p className="max-w-[230px] text-[12px] leading-snug text-muted-foreground">
                Hiring several at once? Send Minted your spreadsheet and we'll upload it.
              </p>
              <div className="ml-auto flex gap-2">
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button disabled={!inviteFieldsReady(values)} onClick={send}>
                  Send invite
                </Button>
              </div>
            </div>
          </>
        ) : (
          <Outcome
            step={step}
            state={state}
            practiceName={practiceName}
            now={now}
            onBack={back}
            onConfirm={confirm}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Outcome({
  step,
  state,
  practiceName,
  now,
  onBack,
  onConfirm,
  onDone,
}: {
  step: Extract<Step, { kind: "result" }>;
  state: NewHiresState;
  practiceName: string;
  now: Date;
  onBack: () => void;
  onConfirm: (input: InviteInput, email: string) => void;
  onDone: () => void;
}) {
  const { match, input, emailFailed } = step;
  const done = <Button onClick={onDone}>Done</Button>;
  const back = (
    <Button variant="outline" onClick={onBack}>
      Back
    </Button>
  );

  switch (match.kind) {
    case "new":
      return emailFailed ? (
        <Result
          icon="warn"
          title={`${input.firstName} is on your list. The email didn't send.`}
          actions={done}
        >
          Try Resend on {input.firstName}'s row in a few minutes. If it fails again, check the
          address.
        </Result>
      ) : (
        <Result icon="ok" title="Invitation sent" actions={done}>
          {input.firstName} {input.lastName} gets an email from {practiceName} at{" "}
          <strong className="break-all">{input.email}</strong>. {input.firstName} shows under Every
          new hire as Invited.
        </Result>
      );
    case "active_on_file":
      return (
        <Result
          title={`${match.person.displayName} is already on file`}
          actions={
            <>
              {back}
              <Button onClick={() => onConfirm(input, match.person.email)}>Send the form</Button>
            </>
          }
        >
          {firstName(match.person.displayName)} is an active provider in {input.groupName} (
          {matchedOn(match.matchedOn)}). Send the form to review and update their details? Their
          SSN, NPI and date of birth stay as they are.
        </Result>
      );
    case "already_onboarding": {
      const name = firstName(match.person.displayName);
      const hire = hireByEmail(state.hires, match.person.email);
      const invitedAt = hire?.events.find((e) => e.type === "invited")?.at;
      const resendable = hire ? canResend(hire.events, now) : false;
      return (
        <Result
          title={`${name} is already onboarding`}
          actions={
            <>
              {back}
              {resendable ? (
                <Button onClick={() => onConfirm(input, match.person.email)}>
                  Resend invitation
                </Button>
              ) : (
                <Button variant="outline" disabled className={SENT_LOOK}>
                  Sent · resend in 10 min
                </Button>
              )}
            </>
          }
        >
          You invited {name} on {fmtDate(invitedAt)} and the form isn't submitted yet. Resend the
          invitation? The old link stops working and saved answers stay.
        </Result>
      );
    }
    case "already_submitted":
      return (
        <Result
          title={`${firstName(match.person.displayName)} already sent the form`}
          actions={done}
        >
          Minted is reviewing it. There's nothing to resend. If something has changed, tell Minted.
        </Result>
      );
    case "on_file_other_group": {
      const added = shortGroupName(input.groupName, practiceName);
      return (
        <Result
          icon="ok"
          title={`Added ${firstName(match.person.displayName)} to ${added}`}
          actions={done}
        >
          {`${firstName(match.person.displayName)} is already on file with ${match.person.groupNames.join(" and ")} (${matchedOn(match.matchedOn)}), so we added ${added} to that record. No email went out. Minted assigns the location.`}
        </Result>
      );
    }
    case "conflict":
      return (
        <Result title="This email and NPI belong to two different people" actions={back}>
          {input.email} is on file for {match.byEmail.displayName}, and NPI {input.npi} is on file
          for {match.byNpi.displayName}. Nothing was sent. Check with Minted which one is right
          before you send an invitation.
        </Result>
      );
  }
}

function Result({
  icon,
  title,
  actions,
  children,
}: {
  icon?: "ok" | "warn";
  title: string;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <DialogHeader className={PRACTICE_HEADER}>
        <DialogTitle className={`${PRACTICE_TITLE} flex items-center gap-2.5`}>
          {icon === "ok" ? (
            <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-[var(--mp-ok-ink)]" />
          ) : null}
          {icon === "warn" ? (
            <TriangleAlert
              aria-hidden="true"
              className="size-5 shrink-0 text-[var(--mp-warn-ink)]"
            />
          ) : null}
          {title}
        </DialogTitle>
        <DialogDescription className={PRACTICE_BODY}>{children}</DialogDescription>
      </DialogHeader>
      <DialogFooter className={PRACTICE_FOOTER}>{actions}</DialogFooter>
    </>
  );
}
