import { useEffect, useId, useRef, useState } from "react";
import { PortalLaunchControls } from "@/components/cases/PortalLaunchControls";
import {
  OPEN_WITHOUT_EXTENSION,
  announceInlineLaunch,
  type PortalLaunchFeedback,
  type PortalLaunchPresentation,
} from "@/components/cases/portalLaunchFeedback";
import { useActiveOrgId, useAuthStore } from "@/lib/auth-store";
import type { ExtensionHandoffResult } from "@/lib/extensionHandoff";
import type { CasePortalTarget } from "@/lib/casePortals";
import {
  beginPortalLaunch,
  createPortalLaunchContextKey,
  createPortalLaunchGuard,
} from "@/lib/portalLaunch";

type PortalStatus = "idle" | "requested" | "failed";
type ReceiptStatus = { status: "idle" } | { status: "pending" } | ExtensionHandoffResult;
interface LaunchUiState {
  contextKey: string;
  portalStatus: PortalStatus;
  receipt: ReceiptStatus;
}

/** Receipt → what the coordinator sees. Failure lines name what went wrong;
 * the manual-recovery instruction rides alongside them (never up front). */
function receiptFeedback(receipt: ReceiptStatus): PortalLaunchFeedback | null {
  if (receipt.status === "idle") return null;
  if (receipt.status === "pending") {
    return { tone: "pending", text: "Waiting for the extension receipt…" };
  }
  if (receipt.status === "received") {
    return {
      tone: "success",
      text: "Extension received the case. Sign-in and access are checked there.",
    };
  }
  if (receipt.status === "ready") {
    return { tone: "success", text: "Extension opened a validated work tab for this step." };
  }
  const failure = (text: string): PortalLaunchFeedback => ({
    tone: "failure",
    text,
    recovery: true,
  });
  if (receipt.status === "update_required") {
    return failure("Update the extension before starting this exact work step.");
  }
  if (receipt.status === "rejected") return failure("Extension rejected the handoff.");
  if (receipt.status === "timeout") return failure("Extension receipt timed out.");
  if (receipt.status === "failed") return failure("Extension handoff failed.");
  if (receipt.status === "unavailable" && receipt.reason === "missing_configuration") {
    return failure("Extension handoff is not configured for this web environment.");
  }
  if (receipt.status === "unavailable" && receipt.reason === "invalid_configuration") {
    return failure("This web environment has an invalid extension handoff configuration.");
  }
  if (receipt.status === "unavailable" && receipt.reason === "messaging_unavailable") {
    return failure("Extension messaging is unavailable in this browser.");
  }
  if (receipt.status === "invalid" && receipt.reason === "invalid_context") {
    return failure("The case context is invalid, so it was not sent to the extension.");
  }
  return failure("Extension returned an unreadable receipt.");
}

export function WorkInPortalButton({
  caseId,
  providerId,
  orgId,
  target,
  facilityId,
  disabled = false,
  disabledReason,
  presentation = "panel",
  onOpenTask,
}: {
  caseId: string;
  providerId: string;
  orgId: string;
  target: CasePortalTarget;
  facilityId?: string;
  disabled?: boolean;
  disabledReason?: string;
  presentation?: PortalLaunchPresentation;
  /** Opens the task drawer — the inline variant's way out when a launch is
   * blocked or fails. */
  onOpenTask?: () => void;
}) {
  const toastId = `portal-launch-${useId()}`;
  const activeOrgId = useActiveOrgId();
  const authUserId = useAuthStore((state) => state.session?.user.id ?? null);
  const authSessionExpiresAt = useAuthStore((state) => state.session?.expires_at ?? null);
  const guardRef = useRef(createPortalLaunchGuard());
  const [launchState, setLaunchState] = useState<LaunchUiState | null>(null);
  const contextKey = createPortalLaunchContextKey({
    authUserId,
    authSessionExpiresAt,
    activeOrgId,
    orgId,
    caseId,
    providerId,
    portalKey: target.portalKey,
    portalUrl: target.url,
    facilityId,
  });
  const activeContextKeyRef = useRef(contextKey);
  const previousContextKeyRef = useRef(contextKey);
  activeContextKeyRef.current = contextKey;

  // State is tagged with the click's exact auth/org/case context. A React
  // render can observe an account or session change before passive effects
  // run, so stale receipt text must be excluded during render itself.
  const visibleLaunchState = launchState?.contextKey === contextKey ? launchState : null;
  const portalStatus = visibleLaunchState?.portalStatus ?? "idle";
  const receipt = visibleLaunchState?.receipt ?? { status: "idle" as const };

  useEffect(() => {
    const guard = guardRef.current;
    return () => guard.invalidate();
  }, []);

  useEffect(() => {
    if (previousContextKeyRef.current === contextKey) return;
    previousContextKeyRef.current = contextKey;
    guardRef.current.invalidate();
    setLaunchState(null);
  }, [contextKey]);

  const activeOrgMatches = authUserId !== null && activeOrgId === orgId;
  const launchDisabled = disabled || !activeOrgMatches;
  const launchDisabledReason =
    disabledReason ??
    (!authUserId || !activeOrgId
      ? "Sign in before sending case context to the extension."
      : !activeOrgMatches
        ? "Open this case in the active organization before sending it."
        : undefined);

  const launch = () => {
    if (launchDisabled) return;

    const snapshot = {
      caseId,
      providerId,
      orgId,
      portalUrl: target.url,
      portalKey: target.portalKey,
      facilityId,
    };
    const launchContextKey = contextKey;
    const generation = guardRef.current.begin();
    setLaunchState({
      contextKey: launchContextKey,
      portalStatus: "idle",
      receipt: { status: "pending" },
    });

    // Both calls happen inside this original click. beginPortalLaunch starts
    // messaging, then requests one portal tab before any receipt await.
    const started = beginPortalLaunch(snapshot);
    if (presentation === "inline") {
      if (started.portalStatus === "failed") {
        announceInlineLaunch(
          {
            tone: "failure",
            text: `Portal tab could not be requested. Use ${OPEN_WITHOUT_EXTENSION} in the task.`,
            recovery: false,
          },
          toastId,
          onOpenTask,
        );
      } else {
        announceInlineLaunch(receiptFeedback({ status: "pending" })!, toastId, onOpenTask);
      }
    }
    setLaunchState((current) =>
      current?.contextKey === launchContextKey
        ? { ...current, portalStatus: started.portalStatus }
        : current,
    );
    void started.receipt.then((result) => {
      if (
        !guardRef.current.isCurrent(generation) ||
        activeContextKeyRef.current !== launchContextKey
      )
        return;
      if (presentation === "inline" && started.portalStatus !== "failed") {
        const feedback = receiptFeedback(result);
        if (feedback) announceInlineLaunch(feedback, toastId, onOpenTask);
      }
      setLaunchState((current) =>
        current?.contextKey === launchContextKey ? { ...current, receipt: result } : current,
      );
    });
  };

  return (
    <PortalLaunchControls
      presentation={presentation}
      portalName={target.name}
      portalUrl={target.url}
      helperText={`Sends this case to the Minted extension and opens the ${target.name} portal.`}
      onLaunch={launch}
      disabled={launchDisabled}
      disabledReason={launchDisabledReason}
      title={`Send this case to ${target.name} workbench`}
      note={
        portalStatus === "requested"
          ? `Portal tab requested. If the browser blocked it, use ${OPEN_WITHOUT_EXTENSION}.`
          : portalStatus === "failed"
            ? `Portal tab could not be requested. Use ${OPEN_WITHOUT_EXTENSION}.`
            : null
      }
      feedback={receiptFeedback(receipt)}
      onOpenTask={onOpenTask}
    />
  );
}
