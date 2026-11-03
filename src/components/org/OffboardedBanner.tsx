// The offboarded write freeze, mirrored in the UI (Mission Control M3): when
// the active organization's lifecycle stage is not writable, every page says
// so once, above its content. useCanWrite() is false there, so add and edit
// affordances are already hidden; the database refuses the writes anyway
// (org_offboarded). Reads keep working, and the way back is named.
import { useActiveMembership } from "@/lib/auth-store";
import { useActiveLifecycleStage } from "@/lib/permissions";

export function OffboardedBanner() {
  const membership = useActiveMembership();
  const stage = useActiveLifecycleStage();
  if (!membership || !stage || stage.writable) return null;
  return (
    <div
      role="status"
      className="mb-4 rounded-md border border-[var(--mp-border)] bg-[var(--mp-neutral-tint)] px-4 py-2.5 text-[12.5px] text-[var(--mp-neutral-ink)]"
    >
      <span className="font-medium">{membership.orgName} is offboarded.</span> You can still read
      everything; changes are turned off. To make changes again, ask Minted to reopen it.
    </div>
  );
}
