// The lifecycle stage's "generation allowed" behaviour, shown in the
// generation UI as a labelled reason (Mission Control M3). Not a block: the
// grid works as before. An offboarded organization gets the shell's
// offboarded banner instead, because there every write is refused.
import { useActiveLifecycleStage } from "@/lib/permissions";

export function GenerationStageNotice() {
  const stage = useActiveLifecycleStage();
  if (!stage || stage.generationAllowed || !stage.writable) return null;
  return (
    <p
      role="note"
      className="rounded-md border border-[var(--mp-border)] px-4 py-2.5 text-[12.5px] text-muted-foreground"
    >
      This organization is in {stage.displayName}. Case generation normally starts once it is
      Active; you can still preview and create cases.
    </p>
  );
}
