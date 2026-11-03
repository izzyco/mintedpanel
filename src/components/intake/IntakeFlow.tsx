// The provider intake from "Confirm it's you" to "Thank you" (canvas Stage 1).
// The live /intake route and the /dev preview both render this; they differ
// only in the gateway they pass. Answers and file names live in this
// component's memory and are never sent anywhere in this build.
import { useEffect, useReducer, useState, type ReactNode } from "react";
import {
  ConsentStep,
  CodeStep,
  IdentifyStep,
  IntakeShell,
  SignedOut,
  TooManyTries,
} from "@/components/intake/IntakeScreens";
import { FormStep, ReviewNote } from "@/components/intake/IntakeForm";
import { isReview } from "@/lib/intakeForm";
import { DocumentsStep, type IntakeFiles } from "@/components/intake/IntakeDocuments";
import { HelpSent, ThankYou } from "@/components/intake/IntakeDone";
import { Button } from "@/components/ui/button";
import {
  CODE_MAX_WRONG,
  canRequestCode,
  initialIntakeFlow,
  intakeFlow,
  type HelpReason,
} from "@/lib/intakeFlow";
import type { IntakeDraft } from "@/types/providerOnboarding";

export interface IntakeGateway {
  practiceName: string;
  email: string;
  requestCode: () => Promise<void>;
  /** "wrong" for any wrong, expired or used code. Throws on a server or network failure. */
  checkCode: (code: string) => Promise<"ok" | "wrong">;
  signOut: () => Promise<void>;
}

export function IntakeFlow({
  gateway,
  session,
  startingDraft,
  onRetryProfile,
  notice,
}: {
  gateway: IntakeGateway;
  /** "live" when a session cookie answers; "none" when it definitely doesn't; null while unknown. */
  session: "live" | "none" | null;
  /** The draft the form opens with, built once she is signed in. */
  startingDraft: IntakeDraft | null;
  /** Set when her details failed to load after sign-in; offers a retry instead of a spinner. */
  onRetryProfile?: () => void;
  notice?: ReactNode;
}) {
  const [flow, dispatch] = useReducer(intakeFlow, undefined, initialIntakeFlow);
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [files, setFiles] = useState<IntakeFiles>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { screen } = flow;

  useEffect(() => {
    if (session === "live") dispatch({ type: "signed_in" });
    if (session === "none") dispatch({ type: "session_ended" });
  }, [session]);

  useEffect(() => {
    if (screen.kind !== "too_many_tries") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [screen.kind]);

  async function sendCode(): Promise<boolean> {
    setError(null);
    const at = Date.now();
    if (!canRequestCode(flow, at)) {
      setNow(at);
      dispatch({ type: "code_requested", at });
      return false;
    }
    setBusy(true);
    try {
      await gateway.requestCode();
      dispatch({ type: "code_requested", at });
      return true;
    } catch {
      setError("We couldn't send a code just now. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function checkCode(code: string) {
    setError(null);
    setBusy(true);
    try {
      if ((await gateway.checkCode(code)) === "ok") {
        dispatch({ type: "signed_in" });
        return;
      }
      // The Too many tries screen reads `now` on its first frame, so set it with the event.
      const at = Date.now();
      const left = CODE_MAX_WRONG - flow.wrongTries - 1;
      setError(
        `That code didn't work. Use the newest code we sent, or send a new one. ${left} ${left === 1 ? "try" : "tries"} left.`,
      );
      setNow(at);
      dispatch({ type: "code_wrong", at });
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    dispatch({ type: "signed_out" });
    await gateway.signOut().catch(() => undefined);
  }

  const help = (reason: HelpReason) => dispatch({ type: "help_requested", reason });
  const shell = (
    children: ReactNode,
    signedIn = false,
    extra: { aside?: ReactNode; onBack?: () => void } = {},
  ) => (
    <IntakeShell
      practiceName={gateway.practiceName}
      signedInAs={signedIn ? gateway.email : undefined}
      onSignOut={signedIn ? () => void signOut() : undefined}
      aside={extra.aside}
      onBack={extra.onBack}
    >
      {children}
    </IntakeShell>
  );

  switch (screen.kind) {
    case "identify":
      return shell(
        <IdentifyStep
          email={gateway.email}
          sending={busy}
          error={error}
          onSend={() => void sendCode()}
        />,
      );
    case "code":
      return shell(
        <CodeStep
          email={gateway.email}
          checking={busy}
          error={error}
          onSubmit={checkCode}
          onResend={sendCode}
        />,
      );
    case "too_many_tries":
      return shell(<TooManyTries until={screen.until} now={now} onSend={() => void sendCode()} />);
    case "signed_out":
      return shell(
        <SignedOut
          reason={screen.reason}
          email={gateway.email}
          onContinue={() => {
            dispatch({ type: "start_over" });
            if (screen.reason === "timed_out") void sendCode();
          }}
        />,
      );
    case "consent":
      return shell(
        <ConsentStep
          practiceName={gateway.practiceName}
          onSign={() => dispatch({ type: "consent_signed" })}
          onHelp={() => help({ kind: "help" })}
        />,
        true,
        { aside: notice },
      );
    // Nothing reaches the practice or an inbox in this build, so these two
    // carry the not-saving notice too.
    case "help":
      return shell(
        <HelpSent
          practiceName={gateway.practiceName}
          reason={screen.reason}
          onBack={() => dispatch({ type: "help_closed" })}
        />,
        true,
        { aside: notice },
      );
    case "submitted":
      return shell(
        <ThankYou practiceName={gateway.practiceName} email={gateway.email} again={screen.again} />,
        false,
        { aside: notice },
      );
  }

  const current = draft ?? startingDraft;
  if (!current) {
    return shell(
      onRetryProfile ? (
        <>
          <p className="text-[14px]">We couldn't open your form just now.</p>
          <Button className="h-11 w-full" onClick={onRetryProfile}>
            Try again
          </Button>
        </>
      ) : (
        <div className="text-[13px] text-muted-foreground">Loading…</div>
      ),
      true,
    );
  }
  const finishLater = () => void signOut();
  if (screen.kind === "form") {
    return shell(
      <FormStep
        practiceName={gateway.practiceName}
        draft={current}
        onChange={setDraft}
        onContinue={() => dispatch({ type: "continued" })}
        onFinishLater={finishLater}
        onHelp={help}
      />,
      true,
      {
        aside: (
          <>
            {notice}
            {isReview(current) ? <ReviewNote practiceName={gateway.practiceName} /> : null}
          </>
        ),
      },
    );
  }
  return shell(
    <DocumentsStep
      practiceName={gateway.practiceName}
      draft={current}
      files={files}
      onFilesChange={setFiles}
      onFinishLater={finishLater}
      onSubmit={() => dispatch({ type: "submitted" })}
      onHelp={help}
    />,
    true,
    { aside: notice, onBack: () => dispatch({ type: "went_back" }) },
  );
}
