import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmtDate } from "@/lib/format";
import { canResend, deriveStage, deriveWaitingOn, isBeforeSubmit } from "@/lib/providerOnboarding";
import { cn } from "@/lib/utils";
import type { OnboardingHire, OnboardingStage } from "@/types/providerOnboarding";
import { WAITING_ON_INK, WAITING_ON_RING, waitingOnLine } from "./hireCopy";

export type HireCommand = "resend" | "mark_contacted" | "fix_email" | "cancel" | "start_date";

const STEPS: { stage: OnboardingStage; label: string }[] = [
  { stage: "invited", label: "Invited" },
  { stage: "started", label: "Started" },
  { stage: "submitted", label: "Submitted" },
  { stage: "ready", label: "Ready for credentialing" },
  { stage: "in_credentialing", label: "In credentialing" },
];

// Disabled, but its text keeps full contrast: the dashed border says "not now".
export const SENT_LOOK =
  "border-dashed border-[var(--mp-border-dashed)] text-muted-foreground disabled:opacity-100";

export function ResendButton({
  hire,
  now,
  onResend,
  className,
}: {
  hire: OnboardingHire;
  now: Date;
  onResend: () => void;
  className?: string;
}) {
  if (canResend(hire.events, now)) {
    return (
      <Button variant="outline" className={className} onClick={onResend}>
        Resend
      </Button>
    );
  }
  return (
    <Button variant="outline" disabled className={cn(SENT_LOOK, className)}>
      Sent · resend in 10 min
    </Button>
  );
}

function Tracker({ hire }: { hire: OnboardingHire }) {
  const current = STEPS.findIndex((s) => s.stage === deriveStage(hire.events));
  const ring = WAITING_ON_RING[deriveWaitingOn(hire.events)];
  return (
    <div className="relative grid grid-cols-5 items-center">
      <div
        aria-hidden="true"
        className="absolute inset-x-[10%] top-1/2 border-t-2 border-[var(--mp-border)]"
      />
      <div
        aria-hidden="true"
        className="absolute left-[10%] top-1/2 border-t-2 border-primary"
        style={{ width: `${current * 20}%` }}
      />
      {STEPS.map((step, i) => (
        <div key={step.stage} className="flex justify-center">
          <span
            aria-hidden="true"
            className={cn(
              "relative z-[1] size-[14px] rounded-full",
              i < current && "bg-primary",
              i === current && cn("border-[3px] bg-card", ring),
              i > current && "border-2 border-[var(--mp-border)] bg-card",
            )}
          />
        </div>
      ))}
      <span className="sr-only">Stage: {STEPS[current].label}</span>
    </div>
  );
}

function HireLine({ hire, onAddStartDate }: { hire: OnboardingHire; onAddStartDate: () => void }) {
  const states = hire.states.join(", ");
  return (
    <div className="text-[11px] text-muted-foreground">
      {hire.startDate ? (
        `starts ${fmtDate(hire.startDate)}`
      ) : (
        <button
          type="button"
          className="cursor-pointer text-primary underline underline-offset-2"
          onClick={onAddStartDate}
        >
          add start date
        </button>
      )}
      {states ? ` · ${states}` : null}
    </div>
  );
}

const COLUMNS = "grid grid-cols-[170px_minmax(360px,1fr)_210px_300px] gap-4 px-4";

export function HireTable({
  hires,
  now,
  onCommand,
}: {
  hires: OnboardingHire[];
  now: Date;
  onCommand: (command: HireCommand, hire: OnboardingHire) => void;
}) {
  // `relative` makes this box the sr-only cells' containing block, so it clips
  // them; otherwise they widen the page at phone width.
  return (
    <div className="relative overflow-x-auto rounded-md border bg-card">
      <div role="table" aria-label="Every new hire" className="min-w-[1100px]">
        <div role="rowgroup">
          <div
            role="row"
            className={cn(
              COLUMNS,
              "border-b border-[var(--mp-border-subtle)] py-2 text-[11px] text-muted-foreground",
            )}
          >
            <div role="columnheader" className="uppercase tracking-[0.04em]">
              Hire
            </div>
            <div role="columnheader" className="grid grid-cols-5 gap-1 text-center leading-tight">
              {STEPS.map((s) => (
                <span key={s.stage}>{s.label}</span>
              ))}
            </div>
            <div role="columnheader" className="uppercase tracking-[0.04em]">
              Waiting on
            </div>
            <div role="columnheader">
              <span className="sr-only">Actions</span>
            </div>
          </div>
        </div>
        <div role="rowgroup">
          {hires.length === 0 ? (
            <div role="row" className="px-4 py-6 text-[13px] text-muted-foreground">
              <div role="cell">No new hires in this state.</div>
            </div>
          ) : null}
          {hires.map((hire) => {
            const line = waitingOnLine(hire);
            const who = deriveWaitingOn(hire.events);
            return (
              <div
                key={hire.providerId}
                role="row"
                className={cn(
                  COLUMNS,
                  "items-center border-b border-[var(--mp-border-faint)] py-3.5 last:border-b-0",
                )}
              >
                <div role="cell" className="flex flex-col gap-0.5">
                  <div className="text-[13px] font-semibold">{hire.displayName}</div>
                  <HireLine hire={hire} onAddStartDate={() => onCommand("start_date", hire)} />
                </div>
                <div role="cell">
                  <Tracker hire={hire} />
                </div>
                <div role="cell" className="text-[12px]">
                  <span className={cn("font-semibold", WAITING_ON_INK[who])}>{line.who}</span>
                  {` · ${line.detail}`}
                </div>
                <div role="cell" className="flex justify-end gap-1.5 whitespace-nowrap">
                  {isBeforeSubmit(deriveStage(hire.events)) ? (
                    <RowActions hire={hire} now={now} onCommand={onCommand} />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RowActions({
  hire,
  now,
  onCommand,
}: {
  hire: OnboardingHire;
  now: Date;
  onCommand: (command: HireCommand, hire: OnboardingHire) => void;
}) {
  const small = "h-7 px-2.5 text-[12px] font-normal";
  return (
    <>
      <ResendButton
        hire={hire}
        now={now}
        className={small}
        onResend={() => onCommand("resend", hire)}
      />
      <Button variant="outline" className={small} onClick={() => onCommand("mark_contacted", hire)}>
        Mark contacted
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="size-7 p-0"
            aria-label={`More for ${hire.displayName}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[220px]">
          <DropdownMenuItem onSelect={() => onCommand("fix_email", hire)}>
            Fix email and resend…
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-[var(--mp-danger-ink)] focus:text-[var(--mp-danger-ink)]"
            onSelect={() => onCommand("cancel", hire)}
          >
            Cancel invitation…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
