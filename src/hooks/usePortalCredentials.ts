// Staff reveal of a provider's portal login. A mutation, never a query, so the
// login never enters the query cache (the useRevealSsn posture).
import { useMutation } from "@tanstack/react-query";
import type { IntakePortal } from "@/lib/intakeAnswers";
import { revealPortalCredential } from "@/services/portalCredentials";

export function useRevealPortalCredential(providerId: string) {
  return useMutation({
    mutationFn: (vars: { portal: IntakePortal; justification: string }) =>
      revealPortalCredential(providerId, vars.portal, vars.justification),
  });
}
