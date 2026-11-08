// Board 0: the practice's New hires page. Counts, Needs you and rows are all
// derived from the hires in the chosen state; nothing here is stored.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  hireStates,
  hiresInState,
  needsYou,
  waitingCounts,
  type NewHiresAction,
  type NewHiresState,
} from "@/lib/newHires";
import { US_STATE_NAMES } from "@/lib/usStates";
import { cn } from "@/lib/utils";
import type { OnboardingHire } from "@/types/providerOnboarding";
import { LEGEND, WAITING_ON_RING, firstName, needsYouLine } from "./hireCopy";
import { CancelInviteDialog, FixEmailDialog, StartDateDialog } from "./HireDialogs";
import { HireTable, type HireCommand } from "./HireTable";
import { ResendButton } from "./ResendButton";
import { PracticeInviteDialog } from "./PracticeInviteDialog";

const ALL_STATES = "all";

type OpenDialog =
  { kind: "invite" } | { kind: "fix_email" | "cancel" | "start_date"; providerId: string } | null;

function stateLabel(code: string): string {
  const name = (US_STATE_NAMES as Record<string, string | undefined>)[code];
  return name ? `${name} (${code})` : code;
}

export function NewHiresBoard({
  state,
  dispatch,
  now,
  practice,
  earlierInCredentialing,
  emailFails,
}: {
  state: NewHiresState;
  dispatch: (action: NewHiresAction) => void;
  now: Date;
  practice: { name: string; groups: string[] };
  earlierInCredentialing: number;
  emailFails: boolean;
}) {
  const [stateFilter, setStateFilter] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenDialog>(null);

  const rows = hiresInState(state.hires, stateFilter);
  const counts = waitingCounts(rows);
  const needs = needsYou(rows);
  const at = now.toISOString();
  const openHire =
    open && open.kind !== "invite"
      ? state.hires.find((h) => h.providerId === open.providerId)
      : undefined;
  const close = () => setOpen(null);

  function onCommand(command: HireCommand, hire: OnboardingHire) {
    if (command === "resend") {
      dispatch({ type: "resend", providerId: hire.providerId, at });
    } else if (command === "mark_contacted") {
      dispatch({ type: "mark_contacted", providerId: hire.providerId, at });
      toast.success(`Marked ${firstName(hire.displayName)} as contacted`);
    } else {
      setOpen({ kind: command, providerId: hire.providerId });
    }
  }

  return (
    <div className="flex min-w-0 flex-col bg-background text-[13px]">
      <header className="flex min-h-[52px] flex-wrap items-center gap-2.5 bg-[var(--mp-sidebar)] px-6 text-white">
        <ShieldCheck aria-hidden="true" className="size-5" />
        <span className="text-[14px] font-semibold">Minted Panel</span>
        <span className="ml-1.5 text-[12px] text-[var(--mp-border)]">{practice.name}</span>
      </header>

      <main className="mx-auto flex w-full min-w-0 max-w-[1200px] flex-col gap-[22px] px-6 pb-10 pt-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="text-[16px] font-semibold text-muted-foreground">New hires</h1>
            <p className="text-[26px] font-semibold leading-tight">
              provider credentialing onboarding dashboard
            </p>
            <p className="text-muted-foreground">
              <span className="font-semibold text-foreground">
                {counts.practice} waiting on you
              </span>
              {` · ${counts.provider} with the clinician · ${counts.minted} with Minted`}
            </p>
          </div>
          <Button onClick={() => setOpen({ kind: "invite" })}>
            <Plus aria-hidden="true" />
            Invite
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 rounded-md border bg-card px-3 py-2.5">
          <Label htmlFor="new-hires-state" className="text-[12px] text-muted-foreground">
            State
          </Label>
          <Select
            value={stateFilter ?? ALL_STATES}
            onValueChange={(v) => setStateFilter(v === ALL_STATES ? null : v)}
          >
            <SelectTrigger id="new-hires-state" className="h-8 w-[200px] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATES}>All states</SelectItem>
              {hireStates(state.hires).map((code) => (
                <SelectItem key={code} value={code}>
                  {stateLabel(code)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <section aria-labelledby="needs-you" className="flex flex-col gap-2">
          <h2 id="needs-you" className="flex items-center gap-2 text-[13px] font-semibold">
            <span aria-hidden="true" className="size-2 rounded-full bg-[var(--mp-danger)]" />
            Needs you
          </h2>
          {needs.length === 0 ? (
            <p className="text-muted-foreground">Nothing needs you right now.</p>
          ) : null}
          {needs.map((hire) => (
            <div
              key={hire.providerId}
              className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-l-[3px] border-l-[var(--mp-danger)] bg-card px-4 py-3.5"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="text-[14px] font-semibold">
                  {hire.displayName}
                  {hire.startDate ? null : (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="cursor-pointer text-[12px] font-normal text-primary underline underline-offset-2"
                        onClick={() => onCommand("start_date", hire)}
                      >
                        · add start date
                      </button>
                    </>
                  )}
                </div>
                <p>{needsYouLine(hire)}</p>
              </div>
              <div className="flex gap-2">
                <ResendButton
                  events={hire.events}
                  now={now}
                  className="h-8 px-3 text-[13px] font-normal"
                  onResend={() => onCommand("resend", hire)}
                />
                <Button
                  className="h-8 px-3 text-[13px]"
                  onClick={() => onCommand("mark_contacted", hire)}
                >
                  Mark contacted
                </Button>
              </div>
            </div>
          ))}
        </section>

        <section aria-labelledby="every-hire" className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="every-hire" className="text-[13px] font-semibold">
              Every new hire
            </h2>
            <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[11px] text-muted-foreground">
              {LEGEND.map((item) => (
                <span key={item.waitingOn} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-[9px] rounded-full border-2",
                      WAITING_ON_RING[item.waitingOn],
                    )}
                  />
                  {item.label}
                </span>
              ))}
            </div>
          </div>
          <HireTable hires={rows} now={now} onCommand={onCommand} />
        </section>

        <p className="border-t border-[var(--mp-border-subtle)] pt-3 text-[12px] text-muted-foreground">
          {earlierInCredentialing} earlier hires are in credentialing.{" "}
          <Link to="/reporting/enrollment-explorer" className="text-primary hover:underline">
            See their payer status →
          </Link>
        </p>
      </main>

      {open?.kind === "invite" ? (
        <PracticeInviteDialog
          state={state}
          practiceName={practice.name}
          groups={practice.groups}
          now={now}
          emailFails={emailFails}
          onInvite={(input) =>
            dispatch({ type: "invite", providerId: crypto.randomUUID(), input, at })
          }
          onClose={close}
        />
      ) : null}
      {open?.kind === "fix_email" && openHire ? (
        <FixEmailDialog
          hire={openHire}
          onClose={close}
          onSend={(email) => {
            dispatch({ type: "fix_email", providerId: openHire.providerId, email, at });
            toast.success(`Invitation sent to ${email}`);
            close();
          }}
        />
      ) : null}
      {open?.kind === "cancel" && openHire ? (
        <CancelInviteDialog
          hire={openHire}
          onClose={close}
          onConfirm={() => {
            dispatch({ type: "cancel", providerId: openHire.providerId });
            toast.success(`Canceled ${firstName(openHire.displayName)}'s invitation`);
            close();
          }}
        />
      ) : null}
      {open?.kind === "start_date" && openHire ? (
        <StartDateDialog
          hire={openHire}
          onClose={close}
          onSave={(startDate) => {
            dispatch({ type: "set_start_date", providerId: openHire.providerId, startDate });
            close();
          }}
        />
      ) : null}
    </div>
  );
}
