// A lifecycle stage as a status pill (Mission Control only: customers never see
// lifecycle words, F0.0.2). The tone follows the stage's behaviours, so a
// configured stage gets a sensible tone without a code change: not writable
// (offboarded) is neutral, in motion is green, anything else blue.
import { StatusPill, type StatusColor } from "@/components/StatusPill";
import type { LifecycleStage } from "@/lib/lifecycle";

function lifecycleTone(stage: LifecycleStage): StatusColor {
  if (!stage.writable) return "neutral";
  if (stage.switcherGroup === "in_motion") return "green";
  return "blue";
}

export function LifecyclePill({ stage }: { stage: LifecycleStage }) {
  return <StatusPill status={lifecycleTone(stage)} label={stage.displayName} />;
}
