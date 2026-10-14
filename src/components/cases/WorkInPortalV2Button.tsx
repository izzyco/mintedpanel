import { useEffect, useId, useRef, useState } from "react";
import { PortalLaunchControls } from "@/components/cases/PortalLaunchControls";
import {
  announceInlineLaunch,
  type PortalLaunchFeedback,
  type PortalLaunchPresentation,
} from "@/components/cases/portalLaunchFeedback";
import { useActiveOrgId, useAuthStore } from "@/lib/auth-store";
import {
  beginWorkPortalLaunch,
  createPortalLaunchGuard,
  type WorkPortalLaunchStart,
} from "@/lib/portalLaunch";
import type { ExtensionHandoffResult } from "@/lib/extensionHandoff";
import type { WorkContextLaunchTuple } from "@/lib/workContext";

type WorkReceiptState =
  | { status: "idle" }
  | { status: "pending"; contextKey: string }
  | (ExtensionHandoffResult & { contextKey: string });

/** Receipt → what the coordinator sees. The exact-work path has no legacy
 * case-search fallback, so its failures carry their own guidance and no
 * manual-recovery line. */
function receiptFeedback(receipt: WorkReceiptState): PortalLaunchFeedback | null {
  if (receipt.status === "idle") return null;
  if (receipt.status === "pending") {
    return { tone: "pending", text: "Waiting for exact work-tab validation…" };
  }
  if (receipt.status === "ready") {
    return {
      tone: "success",
      text: "The extension validated this step and opened its exact work tab.",
    };
  }
  const failure = (text: string): PortalLaunchFeedback => ({
    tone: "failure",
    text,
    recovery: false,
  });
  if (receipt.status === "update_required")
    return failure("Update the extension before starting this exact work step.");
  if (receipt.status === "timeout")
    return failure("No exact work-tab acknowledgement arrived. Refresh this step before retrying.");
  if (receipt.status === "rejected")
    return failure(
      "The extension did not accept this work context. Refresh and review the step configuration.",
    );
  if (receipt.status === "invalid")
    return failure(
      "The exact work context or acknowledgement was invalid; no work tab was confirmed.",
    );
  if (receipt.status === "unavailable")
    return failure("The versioned extension handoff is unavailable in this browser.");
  return failure("The extension handoff failed before it could confirm the exact work tab.");
}

/** MINT-56 exact-tab launch. This path never opens a Panel-owned tab and has
 * no legacy SET_ACTIVE_CASE fallback. */
export function WorkInPortalV2Button({
  tuple,
  portalUrl,
  portalName,
  disabled = false,
  disabledReason,
  presentation = "panel",
  onOpenTask,
}: {
  tuple: WorkContextLaunchTuple;
  portalUrl: string;
  portalName: string;
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
  const [receipt, setReceipt] = useState<WorkReceiptState>({ status: "idle" });
  const contextKey = JSON.stringify([
    authUserId,
    authSessionExpiresAt,
    activeOrgId,
    tuple,
    portalUrl,
  ]);
  const currentContextKey = useRef(contextKey);
  const previousContextKey = useRef(contextKey);
  currentContextKey.current = contextKey;
  const visibleReceipt =
    receipt.status === "idle" || receipt.contextKey === contextKey
      ? receipt
      : ({ status: "idle" } as const);

  useEffect(() => () => guardRef.current.invalidate(), []);
  useEffect(() => {
    if (previousContextKey.current === contextKey) return;
    previousContextKey.current = contextKey;
    guardRef.current.invalidate();
    setReceipt({ status: "idle" });
  }, [contextKey]);

  const activeOrgMatches = Boolean(authUserId && activeOrgId === tuple.orgId);
  const launchDisabled = disabled || !activeOrgMatches;
  const launchDisabledReason =
    disabledReason ??
    (!authUserId || !activeOrgId
      ? "Sign in before sending this work step to the extension."
      : !activeOrgMatches
        ? "Open this work step in the active organization before sending it."
        : undefined);

  const launch = () => {
    if (launchDisabled || !globalThis.crypto?.randomUUID) return;
    const launchContextKey = contextKey;
    const generation = guardRef.current.begin();
    setReceipt({ status: "pending", contextKey: launchContextKey });
    if (presentation === "inline") {
      announceInlineLaunch(
        receiptFeedback({ status: "pending", contextKey: launchContextKey })!,
        toastId,
        onOpenTask,
      );
    }
    const started: WorkPortalLaunchStart = beginWorkPortalLaunch({
      ...tuple,
      launchReceiptId: globalThis.crypto.randomUUID(),
      portalUrl,
    });
    void started.receipt.then((result) => {
      if (!guardRef.current.isCurrent(generation) || currentContextKey.current !== launchContextKey)
        return;
      if (presentation === "inline") {
        const feedback = receiptFeedback({ ...result, contextKey: launchContextKey });
        if (feedback) announceInlineLaunch(feedback, toastId, onOpenTask);
      }
      setReceipt({ ...result, contextKey: launchContextKey });
    });
  };

  return (
    <PortalLaunchControls
      presentation={presentation}
      portalName={portalName}
      portalUrl={portalUrl}
      helperText={`Sends this step to the Minted extension, which opens the ${portalName} portal.`}
      onLaunch={launch}
      disabled={launchDisabled || !globalThis.crypto?.randomUUID}
      disabledReason={launchDisabledReason}
      title={`Send this exact step to ${portalName}`}
      feedback={receiptFeedback(visibleReceipt)}
      onOpenTask={onOpenTask}
    />
  );
}
