// Case generation only in a stage that allows it (Sowmya, Nov 2 2026: a hard
// stop until the organization is active). When the active organization's
// lifecycle stage disallows generation, the generation page shows the reason
// and whom to ask instead of the grid, so there is no way through; the
// database refuses the generation path as well
// (block_generation_when_not_allowed on case_generation_runs). The stage's
// generation_allowed behaviour is configuration (lifecycle_stages).
import type { ReactNode } from "react";
import { useLifecycleStages } from "@/hooks/useLifecycleStages";
import { useActiveMembership } from "@/lib/auth-store";
import { generationBlockedReason } from "@/lib/lifecycle";
import { useActiveLifecycleStage } from "@/lib/permissions";

export function GenerationStageGate({ children }: { children: ReactNode }) {
  const membership = useActiveMembership();
  const stage = useActiveLifecycleStage();
  const stages = useLifecycleStages();
  const reason =
    stage && membership ? generationBlockedReason(stage, membership.orgName, stages) : null;
  if (!reason) return <>{children}</>;
  return (
    <div
      role="alert"
      className="rounded-md border border-[var(--mp-border)] bg-[var(--mp-card)] px-4 py-6 text-center"
    >
      <p className="text-[14px] font-semibold text-foreground">{reason.title}</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{reason.detail}</p>
    </div>
  );
}
