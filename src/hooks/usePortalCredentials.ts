// Staff reveal of a provider's portal login. A plain callback with its own
// pending flag, never a useMutation or useQuery, since either cache would keep
// the login (and the reason) in memory for minutes after the dialog closes.
import { useCallback, useState } from "react";
import type { IntakePortal } from "@/lib/intakeAnswers";
import { revealPortalCredential } from "@/services/portalCredentials";

export function useRevealPortalCredential(providerId: string) {
  const [pending, setPending] = useState(false);
  const reveal = useCallback(
    async (portal: IntakePortal, justification: string) => {
      setPending(true);
      try {
        return await revealPortalCredential(providerId, portal, justification);
      } finally {
        setPending(false);
      }
    },
    [providerId],
  );
  return { reveal, pending };
}
