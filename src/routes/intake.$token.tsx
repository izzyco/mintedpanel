// Provider intake (docs/provider-onboarding/slice-1-invite-to-form.md, canvas
// Stage 1). Public and chromeless (listed in __root.tsx). The link token is the
// door; the emailed code is the key. The session that follows is an HttpOnly
// cookie, so nothing here stores a token. Her consent and answers are saved
// through /api/intake/* and read back when she signs in; her SSN and logins go
// to the vaults, and her documents to a holding area until Submit puts them
// and her answers on her record. A help request reaches her practice.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { IntakeFlow, type IntakeGateway } from "@/components/intake/IntakeFlow";
import {
  IntakePaused,
  IntakeShell,
  InvalidLink,
  TryAgain,
} from "@/components/intake/IntakeScreens";
import {
  useIntakeDocuments,
  useIntakeLink,
  useLoadIntakeState,
  useOpenIntakeSession,
  useRequestIntakeCode,
  useRequestIntakeHelp,
  useSaveIntakeDraft,
  useSaveIntakeSecrets,
  useSignIntakeConsent,
  useSignOutIntake,
  useSubmitIntake,
} from "@/hooks/useIntake";
import type { IntakeAnswers } from "@/lib/intakeAnswers";
import { isIntakePaused, type DraftStep, type HelpReason } from "@/lib/intakeFlow";

export const Route = createFileRoute("/intake/$token")({
  head: () => ({
    meta: [
      { title: "Secure intake — Minted Panel" },
      // Keep the link token out of Referer headers on any outbound request.
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: IntakePage,
});

function IntakePage() {
  const { token } = Route.useParams();
  const link = useIntakeLink(token);
  const loadState = useLoadIntakeState(token);
  const requestCode = useRequestIntakeCode();
  const openSession = useOpenIntakeSession();
  const saveDraft = useSaveIntakeDraft();
  const signConsent = useSignIntakeConsent();
  const secrets = useSaveIntakeSecrets(token);
  const documents = useIntakeDocuments(token);
  const submit = useSubmitIntake();
  const requestHelp = useRequestIntakeHelp();
  const signOut = useSignOutIntake();
  const [paused, setPaused] = useState(false);

  // Intake can be paused while she has the form open. Any call that comes
  // back paused swaps the whole flow for the paused notice.
  function pauseAware<A extends unknown[], R>(call: (...args: A) => Promise<R>) {
    return (...args: A) =>
      call(...args).catch((error: unknown) => {
        if (isIntakePaused(error)) setPaused(true);
        throw error;
      });
  }

  if (paused || (link.isError && isIntakePaused(link.error))) return <IntakePaused />;
  if (link.isLoading) {
    return (
      <IntakeShell practiceName={null}>
        <div className="text-[13px] text-muted-foreground">Loading…</div>
      </IntakeShell>
    );
  }
  if (link.isError) return <TryAgain onRetry={() => void link.refetch()} />;
  if (!link.data) return <InvalidLink />;

  const gateway: IntakeGateway = {
    practiceName: link.data.practiceName,
    email: link.data.email,
    requestCode: pauseAware(() => requestCode.mutateAsync(token)),
    checkCode: pauseAware(async (code: string) =>
      (await openSession.mutateAsync({ token, code })) ? "ok" : "wrong",
    ),
    signOut: () => signOut.mutateAsync(),
    loadState: pauseAware(loadState),
    saveDraft: pauseAware((answers: IntakeAnswers, step: DraftStep, version: number) =>
      saveDraft.mutateAsync({ token, answers, step, version }),
    ),
    signConsent: pauseAware((typedName: string) => signConsent.mutateAsync({ token, typedName })),
    saveSsn: pauseAware(secrets.saveSsn),
    saveLogin: pauseAware(secrets.saveLogin),
    uploadDocument: pauseAware(documents.uploadDocument),
    removeDocument: pauseAware(documents.removeDocument),
    setDocumentExpiry: pauseAware(documents.setDocumentExpiry),
    submit: pauseAware((version: number) => submit.mutateAsync({ token, version })),
    requestHelp: pauseAware((reason: HelpReason) => requestHelp.mutateAsync({ token, reason })),
  };

  return <IntakeFlow gateway={gateway} />;
}
