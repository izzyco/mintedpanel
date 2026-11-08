// The provider intake from "Confirm it's you" to "Thank you" (canvas Stage 1).
// The live /intake route and the /dev preview both render this; they differ
// only in the gateway they pass. Her consent and answers are saved through
// the gateway and read back when she signs in; her SSN and logins go to the
// vaults as she leaves each field, and each document uploads to a holding
// area as she picks it. Submit puts her answers and documents on her record,
// and a help request reaches her practice.
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import {
  ConsentStep,
  CodeStep,
  IdentifyStep,
  IntakeShell,
  SignedOut,
  TooManyTries,
} from "@/components/intake/IntakeScreens";
import { FormStep, ReviewNote } from "@/components/intake/IntakeForm";
import { isReview, setField, withLoginOnFile } from "@/lib/intakeForm";
import { DocumentsStep } from "@/components/intake/IntakeDocuments";
import { HelpNotSent, HelpSent, ThankYou } from "@/components/intake/IntakeDone";
import { useDraftAutosave, type SaveStatus } from "@/components/intake/useDraftAutosave";
import { Button } from "@/components/ui/button";
import { localTodayIso } from "@/hooks/useEnrollmentReadiness";
import {
  answersFromDraft,
  draftFromState,
  resumeFrom,
  type IntakeAnswers,
  type IntakePortal,
  type IntakeState,
  type IntakeUpload,
  type RemoveDocumentResult,
  type RequestHelpResult,
  type SaveDraftResult,
  type SaveLoginResult,
  type SaveSsnResult,
  type SetDocumentExpiryResult,
  type SignConsentResult,
  type SubmitIntakeResult,
  type UploadDocumentResult,
} from "@/lib/intakeAnswers";
import {
  CODE_MAX_WRONG,
  canRequestCode,
  initialIntakeFlow,
  intakeFlow,
  type DraftStep,
  type HelpReason,
} from "@/lib/intakeFlow";
import { slotUploads } from "@/lib/intakeUploads";
import { canContinue } from "@/lib/providerOnboarding";
import type { DocumentSlot, IntakeDraft } from "@/types/providerOnboarding";

export interface IntakeGateway {
  practiceName: string;
  email: string;
  requestCode: () => Promise<void>;
  /** "wrong" for any wrong, expired or used code. Throws on a server or network failure. */
  checkCode: (code: string) => Promise<"ok" | "wrong">;
  signOut: () => Promise<void>;
  /** Null when no session is live for this link. Throws on a server or network failure. */
  loadState: () => Promise<IntakeState | null>;
  /** Throws on a server or network failure. */
  saveDraft: (answers: IntakeAnswers, step: DraftStep, version: number) => Promise<SaveDraftResult>;
  /** Throws on a server or network failure. */
  signConsent: (typedName: string) => Promise<SignConsentResult>;
  /** The full SSN, straight from its input to the vault. Throws on a server or network failure. */
  saveSsn: (full: string) => Promise<SaveSsnResult>;
  /** Throws on a server or network failure. */
  saveLogin: (portal: IntakePortal, username: string, password: string) => Promise<SaveLoginResult>;
  /** The file goes from her device to the holding area. Throws on a server or network failure. */
  uploadDocument: (
    slot: Pick<DocumentSlot, "key" | "kind">,
    file: File,
    expiresOn?: string | null,
  ) => Promise<UploadDocumentResult>;
  /** Throws on a server or network failure. */
  removeDocument: (uploadId: string) => Promise<RemoveDocumentResult>;
  /** Throws on a server or network failure. */
  setDocumentExpiry: (
    uploadId: string,
    expiresOn: string | null,
  ) => Promise<SetDocumentExpiryResult>;
  /** With the draft version the page last saved. Throws on a server or network failure. */
  submit: (version: number) => Promise<SubmitIntakeResult>;
  /** Throws on a server or network failure. */
  requestHelp: (reason: HelpReason) => Promise<RequestHelpResult>;
}

const SUBMIT_FAILED = "We couldn't send your form just now. Please try again.";
const SUBMIT_RELOADED =
  "Your form was changed in another window, so we've loaded the latest answers. Check them, then submit again.";

function npiInUse(practiceName: string): string {
  return `This NPI is on another provider's record at ${practiceName}. Check it for a typo under Your details. If it's right, use I need help and ${practiceName} will sort it out.`;
}

const SAVE_STATUS: Record<SaveStatus, string | null> = {
  idle: null,
  saving: "Saving…",
  saved: "Saved",
  failed:
    "We couldn't save your latest changes. They're still on this page, and we'll try again when you make another change.",
  reloaded: "Your form was changed in another window, so we've loaded the latest answers.",
};

function SaveStatusLine({ status }: { status: SaveStatus }) {
  const warn = status === "failed" || status === "reloaded";
  return (
    <p
      role="status"
      className={
        warn
          ? "text-[13px] leading-[1.45] text-[var(--mp-danger-ink)]"
          : "text-[12px] text-[#4B5563]"
      }
    >
      {SAVE_STATUS[status]}
    </p>
  );
}

export function IntakeFlow({ gateway }: { gateway: IntakeGateway }) {
  const [flow, dispatch] = useReducer(intakeFlow, undefined, initialIntakeFlow);
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  // The draft as of the last change, ahead of the render: a save that
  // returns mid-keystroke updates the same draft the keystroke does.
  const latest = useRef<IntakeDraft | null>(null);
  // SSN, login and document saves still in flight. Continue and Finish later
  // wait for them, so a login saved by clicking Continue counts and signing
  // out doesn't cut off an upload.
  const pendingSaves = useRef(new Set<Promise<unknown>>());
  // A COI date saves on each complete date she types; one at a time, so the
  // last one typed is the one kept.
  const expirySaves = useRef<Promise<unknown>>(Promise.resolve());
  // A reload replaces the whole draft; a new run remounts the form so no
  // field keeps text from before it.
  const [formRun, setFormRun] = useState(0);
  const [uploads, dispatchUpload] = useReducer(slotUploads, {});
  const uploadAttempts = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Submit found a form answer missing: the form opens showing what.
  const [formMissing, setFormMissing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const gatewayRef = useRef(gateway);
  gatewayRef.current = gateway;
  const { screen } = flow;

  const autosave = useDraftAutosave({
    save: (answers, step, version) => gatewayRef.current.saveDraft(answers, step, version),
    reload: async () => {
      const state = await gatewayRef.current.loadState();
      if (state) open(state);
      else dispatch({ type: "session_ended" });
    },
    signedOut: () => dispatch({ type: "session_ended" }),
    closed: () => dispatch({ type: "closed" }),
  });

  // Shows her saved state and makes it the autosave's starting point.
  const { reset } = autosave;
  const open = useCallback(
    (state: IntakeState) => {
      const opened = draftFromState(state);
      const resume = resumeFrom(state);
      latest.current = opened;
      setDraft(opened);
      dispatchUpload({ type: "opened", uploads: state.uploads });
      setFormRun((run) => run + 1);
      reset({ answers: answersFromDraft(opened), step: resume.step }, state.draft?.version ?? 0);
      return resume;
    },
    [reset],
  );

  // Opening the link with a session that is still live goes straight back in.
  useEffect(() => {
    let current = true;
    gatewayRef.current
      .loadState()
      .then((state) => {
        if (current && state) dispatch({ type: "resumed", resume: open(state) });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [open]);

  useEffect(() => {
    if (screen.kind !== "too_many_tries") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [screen.kind]);

  async function openForm() {
    setBusy(true);
    try {
      const state = await gateway.loadState();
      if (state) dispatch({ type: "resumed", resume: open(state) });
      else dispatch({ type: "session_ended" });
    } catch {
      dispatch({ type: "open_failed" });
    } finally {
      setBusy(false);
    }
  }

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
    let right = false;
    try {
      right = (await gateway.checkCode(code)) === "ok";
      if (!right) {
        // The Too many tries screen reads `now` on its first frame, so set it with the event.
        const at = Date.now();
        const left = CODE_MAX_WRONG - flow.wrongTries - 1;
        setError(
          `That code didn't work. Use the newest code we sent, or send a new one. ${left} ${left === 1 ? "try" : "tries"} left.`,
        );
        setNow(at);
        dispatch({ type: "code_wrong", at });
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
    if (right) {
      dispatch({ type: "signed_in" });
      await openForm();
    }
  }

  async function signConsent(typedName: string) {
    setError(null);
    setBusy(true);
    try {
      const result = await gateway.signConsent(typedName);
      if (result === "signed") dispatch({ type: "consent_signed" });
      else dispatch({ type: result === "closed" ? "closed" : "session_ended" });
    } catch {
      setError("We couldn't save your signature just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function track<T>(save: Promise<T>): Promise<T> {
    pendingSaves.current.add(save);
    const done = () => pendingSaves.current.delete(save);
    save.then(done, done);
    return save;
  }
  const savesSettled = () => Promise.allSettled([...pendingSaves.current]);

  function apply(update: (draft: IntakeDraft) => IntakeDraft): IntakeDraft | null {
    if (!latest.current) return null;
    latest.current = update(latest.current);
    setDraft(latest.current);
    return latest.current;
  }

  function saveSsn(full: string): Promise<SaveSsnResult> {
    return track(
      gateway.saveSsn(full).then((result) => {
        if (result.kind === "stored") {
          apply((d) => setField(d, ["identity", "ssn"], result.ssnLast4, localTodayIso()));
        } else if (result.kind !== "locked") {
          dispatch({ type: result.kind === "closed" ? "closed" : "session_ended" });
        }
        return result;
      }),
    );
  }

  function saveLogin(portal: IntakePortal, username: string, password: string) {
    return track(
      gateway.saveLogin(portal, username, password).then((result) => {
        if (result === "stored") apply((d) => withLoginOnFile(d, portal));
        else dispatch({ type: result === "closed" ? "closed" : "session_ended" });
        return result;
      }),
    );
  }

  function uploadDocument(slot: DocumentSlot, file: File) {
    uploadAttempts.current += 1;
    const attempt = uploadAttempts.current;
    const slotKey = slot.key;
    dispatchUpload({ type: "started", slotKey, attempt, file });
    void track(
      gateway.uploadDocument(slot, file).then(
        (result) => {
          if (result.kind === "uploaded") {
            dispatchUpload({ type: "uploaded", slotKey, attempt, upload: result.upload });
            return;
          }
          dispatchUpload({ type: "failed", slotKey, attempt });
          dispatch({ type: result.kind === "closed" ? "closed" : "session_ended" });
        },
        () => dispatchUpload({ type: "failed", slotKey, attempt }),
      ),
    );
  }

  async function removeDocument(slot: DocumentSlot, upload: IntakeUpload): Promise<boolean> {
    try {
      const result = await track(gateway.removeDocument(upload.id));
      if (result === "removed") dispatchUpload({ type: "removed", slotKey: slot.key });
      else dispatch({ type: result === "closed" ? "closed" : "session_ended" });
      return true;
    } catch {
      return false;
    }
  }

  async function setDocumentExpiry(
    slot: DocumentSlot,
    upload: IntakeUpload,
    expiresOn: string | null,
  ): Promise<boolean> {
    if (upload.expiresOn === expiresOn) return true;
    dispatchUpload({ type: "dated", slotKey: slot.key, expiresOn });
    const save = expirySaves.current.then(() => gateway.setDocumentExpiry(upload.id, expiresOn));
    expirySaves.current = save.catch(() => undefined);
    try {
      const result = await track(save);
      if (result !== "saved") dispatch({ type: result === "closed" ? "closed" : "session_ended" });
      return true;
    } catch {
      // Editing the date passes through an incomplete one, which differs from
      // what the page holds, so the next complete date she types saves again.
      return false;
    }
  }

  // Leaving waits for her latest answers, SSN, logins and files to be saved.
  // If her answers can't be, she stays, and the status line says so.
  async function signOut() {
    await savesSettled();
    if (!(await autosave.flush())) return;
    dispatch({ type: "signed_out" });
    await gateway.signOut().catch(() => undefined);
  }

  async function goTo(step: DraftStep) {
    if (!(await autosave.flush(step))) return;
    setSubmitError(null);
    dispatch({ type: step === "documents" ? "continued" : "went_back" });
  }

  function edit(update: (draft: IntakeDraft) => IntakeDraft) {
    const next = apply(update);
    if (next) autosave.change({ answers: answersFromDraft(next), step: "form" });
  }

  async function continueToDocuments(): Promise<boolean> {
    await savesSettled();
    if (!latest.current || !canContinue(latest.current)) return false;
    setFormMissing(false);
    await goTo("documents");
    return true;
  }

  // Her state from the server, after Submit found the page out of date.
  async function reopen(): Promise<boolean> {
    const state = await gateway.loadState();
    if (!state) dispatch({ type: "session_ended" });
    else open(state);
    return state !== null;
  }

  // False when the server found something missing on this screen, so it
  // shows what. A missing form answer opens the form instead.
  async function submit(): Promise<boolean> {
    setSubmitError(null);
    setSubmitting(true);
    try {
      await savesSettled();
      if (!(await autosave.flush("documents"))) return true;
      const result = await gateway.submit(autosave.savedVersion());
      switch (result.kind) {
        case "submitted":
          dispatch({ type: "submitted" });
          return true;
        case "incomplete":
          if (!(await reopen())) return true;
          if (result.missing.some((key) => !key.startsWith("documents."))) {
            setFormMissing(true);
            await goTo("form");
            return true;
          }
          return false;
        case "conflict":
          if (await reopen()) setSubmitError(SUBMIT_RELOADED);
          return true;
        case "npi_in_use":
          setSubmitError(npiInUse(gateway.practiceName));
          return true;
        case "closed":
          dispatch({ type: "closed" });
          return true;
        case "signed_out":
          dispatch({ type: "session_ended" });
          return true;
      }
    } catch {
      setSubmitError(SUBMIT_FAILED);
      return true;
    } finally {
      setSubmitting(false);
    }
  }

  // The help screen says it was sent only once the server has it.
  async function help(reason: HelpReason) {
    dispatch({ type: "help_requested", reason });
    try {
      const result = await gateway.requestHelp(reason);
      if (result === "sent") dispatch({ type: "help_sent" });
      else dispatch({ type: result === "closed" ? "closed" : "session_ended" });
    } catch {
      dispatch({ type: "help_failed" });
    }
  }
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
    case "opening":
      return shell(<div className="text-[13px] text-muted-foreground">Loading…</div>, true);
    case "open_failed":
      return shell(
        <>
          <p className="text-[14px]">We couldn't open your form just now.</p>
          <Button className="h-11 w-full" disabled={busy} onClick={() => void openForm()}>
            Try again
          </Button>
        </>,
        true,
      );
    case "consent":
      return shell(
        <ConsentStep
          practiceName={gateway.practiceName}
          signing={busy}
          error={error}
          onSign={(typedName) => void signConsent(typedName)}
          onHelp={() => void help({ kind: "help" })}
        />,
        true,
      );
    case "help": {
      const back = () => dispatch({ type: "help_closed" });
      return shell(
        screen.status === "sent" ? (
          <HelpSent practiceName={gateway.practiceName} reason={screen.reason} onBack={back} />
        ) : screen.status === "failed" ? (
          <HelpNotSent onRetry={() => void help(screen.reason)} onBack={back} />
        ) : (
          <p role="status" className="text-[13px] text-muted-foreground">
            Sending your request…
          </p>
        ),
        true,
      );
    }
    case "submitted":
      return shell(
        <ThankYou practiceName={gateway.practiceName} email={gateway.email} again={screen.again} />,
      );
  }

  // Every form screen opens with a draft: `open` sets it before `resumed` lands.
  if (!draft) return shell(<div className="text-[13px] text-muted-foreground">Loading…</div>, true);
  const status = <SaveStatusLine status={autosave.status} />;
  if (screen.kind === "form") {
    return shell(
      <FormStep
        key={formRun}
        practiceName={gateway.practiceName}
        draft={draft}
        status={status}
        onChange={edit}
        onContinue={continueToDocuments}
        onFinishLater={() => void signOut()}
        onHelp={(reason) => void help(reason)}
        onSaveSsn={saveSsn}
        onSaveLogin={saveLogin}
        showMissing={formMissing}
      />,
      true,
      {
        aside: isReview(draft) ? <ReviewNote practiceName={gateway.practiceName} /> : undefined,
      },
    );
  }
  return shell(
    <DocumentsStep
      practiceName={gateway.practiceName}
      draft={draft}
      uploads={uploads}
      status={status}
      onUpload={uploadDocument}
      onRemove={removeDocument}
      onExpires={setDocumentExpiry}
      onFinishLater={() => void signOut()}
      onSubmit={submit}
      submitting={submitting}
      submitError={submitError}
      onHelp={(reason) => void help(reason)}
    />,
    true,
    { onBack: () => void goTo("form") },
  );
}
