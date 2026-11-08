// The five-step onboarding tracker, one component for the practice's New hires
// rows and the staff Onboarding card.
import { cn } from "@/lib/utils";
import type { OnboardingStage, WaitingOn } from "@/types/providerOnboarding";
import { STAGE_STEPS, WAITING_ON_RING } from "./hireCopy";

export function StageTracker({
  stage,
  waitingOn,
  showLabels = false,
}: {
  stage: OnboardingStage;
  waitingOn: WaitingOn;
  showLabels?: boolean;
}) {
  const current = STAGE_STEPS.findIndex((s) => s.stage === stage);
  return (
    <div>
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
        {STAGE_STEPS.map((step, i) => (
          <div key={step.stage} className="flex justify-center">
            <span
              aria-hidden="true"
              className={cn(
                "relative z-[1] size-[14px] rounded-full",
                i < current && "bg-primary",
                i === current && cn("border-[3px] bg-card", WAITING_ON_RING[waitingOn]),
                i > current && "border-2 border-[var(--mp-border)] bg-card",
              )}
            />
          </div>
        ))}
        <span className="sr-only">Stage: {STAGE_STEPS[current].label}</span>
      </div>
      {showLabels ? (
        <div
          aria-hidden="true"
          className="mt-1.5 grid grid-cols-5 gap-1 text-center text-[11px] leading-tight"
        >
          {STAGE_STEPS.map((step, i) => (
            <span
              key={step.stage}
              className={i === current ? "font-semibold text-foreground" : "text-muted-foreground"}
            >
              {step.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
