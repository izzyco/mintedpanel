// The one layout every "Work in portal" launch renders through, for both the
// legacy SET_ACTIVE_CASE path (WorkInPortalButton) and the Exact Work V2 path
// (WorkInPortalV2Button). The launch logic stays in those two components; this
// file only decides what the coordinator sees.
//
// - "panel" (the task drawer's portal box): Work in portal is the filled
//   primary, a one-line explanation sits under it, the no-extension fallback
//   is a quiet text link, and recovery guidance appears only after a handoff
//   actually fails.
// - "inline" (the current step on the case page's task list): the button
//   alone. A blocked launch opens the task drawer, where the reason and the
//   location picker live, so the button never dead-ends. Results arrive as
//   toasts; a failure toast offers "Open task".
import { CheckCircle2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MANUAL_RECOVERY_TEXT,
  OPEN_WITHOUT_EXTENSION,
  type PortalLaunchFeedback,
  type PortalLaunchPresentation,
} from "@/components/cases/portalLaunchFeedback";

export function PortalLaunchControls({
  presentation,
  portalName,
  portalUrl,
  helperText,
  onLaunch,
  disabled,
  disabledReason,
  title,
  note,
  feedback,
  onOpenTask,
}: {
  presentation: PortalLaunchPresentation;
  portalName: string;
  portalUrl: string | null;
  helperText: string;
  /** Absent when no launch is possible at all (the exact-work context is not
   * ready); the panel then shows a disabled button and the inline variant
   * opens the drawer. */
  onLaunch?: () => void;
  disabled: boolean;
  disabledReason?: string;
  title?: string;
  /** Panel-only secondary line, e.g. the portal-tab request outcome. */
  note?: string | null;
  feedback?: PortalLaunchFeedback | null;
  onOpenTask?: () => void;
}) {
  const blocked = disabled || !onLaunch;

  if (presentation === "inline") {
    if (blocked && !onOpenTask) return null;
    return (
      <Button
        type="button"
        size="sm"
        className="h-6 px-2 text-[12px] shadow-none"
        title={blocked ? (disabledReason ?? "Open the task to see what is needed") : title}
        onClick={(event) => {
          event.stopPropagation();
          if (blocked) onOpenTask?.();
          else onLaunch?.();
        }}
      >
        Work in portal
        <ExternalLink className="ml-1.5 h-3 w-3" aria-hidden />
      </Button>
    );
  }

  return (
    <div className="basis-full space-y-1.5">
      <Button
        type="button"
        size="sm"
        className="h-8 px-3 text-[12px] shadow-none"
        onClick={onLaunch}
        disabled={blocked}
        title={disabledReason ?? title}
      >
        Work in portal
        <ExternalLink className="ml-1.5 h-3 w-3" aria-hidden />
      </Button>
      {disabledReason ? (
        <p className="text-[11px] text-muted-foreground">{disabledReason}</p>
      ) : (
        <p className="text-[11px] text-muted-foreground">{helperText}</p>
      )}
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
      {feedback?.tone === "pending" ? (
        <p role="status" aria-live="polite" className="text-[11px] text-muted-foreground">
          {feedback.text}
        </p>
      ) : feedback?.tone === "success" ? (
        <p
          role="status"
          aria-live="polite"
          className="flex items-start gap-1.5 text-[11px] text-[#1B4D3E]"
        >
          <CheckCircle2 className="mt-px h-3 w-3 flex-none" aria-hidden />
          {feedback.text}
        </p>
      ) : feedback?.tone === "failure" ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900"
        >
          <p className="font-medium">{feedback.text}</p>
          {feedback.recovery ? <p>{MANUAL_RECOVERY_TEXT}</p> : null}
        </div>
      ) : null}
      {portalUrl ? (
        <a
          href={portalUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-[#1B4D3E] underline-offset-2 hover:underline"
          title={`Open ${portalName} in a new tab without the extension`}
        >
          {OPEN_WITHOUT_EXTENSION}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      ) : null}
    </div>
  );
}
