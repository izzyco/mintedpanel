// Shared vocabulary for the "Work in portal" launch surfaces
// (PortalLaunchControls + the legacy and Exact Work V2 buttons): the two
// presentations, the feedback a handoff receipt maps to, and the toast an
// inline launch reports through.
import { toast } from "sonner";

export type PortalLaunchPresentation = "panel" | "inline";

export const MANUAL_RECOVERY_TEXT = "Manual recovery: open the extension and use case search.";
export const OPEN_WITHOUT_EXTENSION = "Open without extension";

export type PortalLaunchFeedback =
  | { tone: "pending"; text: string }
  | { tone: "success"; text: string }
  | { tone: "failure"; text: string; recovery: boolean };

/** Inline launches report through toasts, one per button instance (`toastId`)
 * so a pending toast is replaced by its result rather than stacking. */
export function announceInlineLaunch(
  feedback: PortalLaunchFeedback,
  toastId: string,
  onOpenTask?: () => void,
) {
  if (feedback.tone === "pending") {
    toast.loading(feedback.text, { id: toastId });
    return;
  }
  if (feedback.tone === "success") {
    toast.success(feedback.text, { id: toastId });
    return;
  }
  toast.error(feedback.text, {
    id: toastId,
    description: feedback.recovery ? MANUAL_RECOVERY_TEXT : undefined,
    action: onOpenTask ? { label: "Open task", onClick: onOpenTask } : undefined,
  });
}
