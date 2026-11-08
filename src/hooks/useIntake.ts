// Provider intake hooks. Not org-scoped: the provider has no org context, and
// these keys never enter a persisted cache.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IntakeGateway } from "@/lib/intakeAnswers";
import { isIntakePaused } from "@/lib/intakeFlow";
import {
  openIntakeSession,
  readIntakeLink,
  readIntakeState,
  removeIntakeDocument,
  requestIntakeCode,
  requestIntakeHelp,
  saveIntakeDraft,
  saveIntakeLogin,
  saveIntakeSsn,
  setIntakeDocumentExpiry,
  signIntakeConsent,
  signOutIntake,
  submitIntake,
  uploadIntakeDocument,
  type IntakeLink,
} from "@/services/intake";

export function useIntakeLink(token: string) {
  return useQuery({
    queryKey: ["intake-link", token],
    queryFn: () => readIntakeLink(token),
    retry: false,
    staleTime: Infinity,
  });
}

// Every intake call bound to her link, as plain calls: a mutation or query
// cache would keep her answers, SSN, passwords and files after the call.
// Null until the link loads, and for a dead link.
export function useIntakeGateway(token: string, link: IntakeLink | null | undefined) {
  const [paused, setPaused] = useState(false);
  const gateway = useMemo((): IntakeGateway | null => {
    if (!link) return null;
    // Intake can be paused while she has the form open. Any call that comes
    // back paused swaps the whole flow for the paused notice.
    function pauseAware<A extends unknown[], R>(call: (...args: A) => Promise<R>) {
      return (...args: A) =>
        call(...args).catch((error: unknown) => {
          if (isIntakePaused(error)) setPaused(true);
          throw error;
        });
    }
    return {
      practiceName: link.practiceName,
      email: link.email,
      requestCode: pauseAware(() => requestIntakeCode(token)),
      checkCode: pauseAware(async (code) =>
        (await openIntakeSession(token, code)) ? "ok" : "wrong",
      ),
      signOut: signOutIntake,
      loadState: pauseAware(() => readIntakeState(token)),
      saveDraft: pauseAware((answers, step, version) =>
        saveIntakeDraft(token, answers, step, version),
      ),
      signConsent: pauseAware((typedName) => signIntakeConsent(token, typedName)),
      saveSsn: pauseAware((full) => saveIntakeSsn(token, full)),
      saveLogin: pauseAware((portal, username, password) =>
        saveIntakeLogin(token, portal, username, password),
      ),
      uploadDocument: pauseAware((slot, file) => uploadIntakeDocument(token, slot, file)),
      removeDocument: pauseAware((uploadId) => removeIntakeDocument(token, uploadId)),
      setDocumentExpiry: pauseAware((uploadId, expiresOn) =>
        setIntakeDocumentExpiry(token, uploadId, expiresOn),
      ),
      submit: pauseAware((version) => submitIntake(token, version)),
      requestHelp: pauseAware((reason) => requestIntakeHelp(token, reason)),
    };
  }, [token, link]);
  return { gateway, paused };
}
