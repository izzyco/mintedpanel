// Every Stage 1 onboarding screen on sample data (r1-ui-spec decision 18).
// The practice side has no login yet, so it lives only here. The provider side
// runs the same IntakeFlow as the live /intake link, with a fake gateway, so
// states the live link can't show on demand (a re-invited provider, a dead
// link, a timeout, an edit from another window) can be reviewed. The fake
// keeps what she saves in memory, under the live routes' rules, and like the
// vaults it keeps an SSN only as its last 4 and a login only as on file. A
// file is kept as its name and size, never its contents; nothing is sent.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { IntakeFlow } from "@/components/intake/IntakeFlow";
import { InvalidLink, TryAgain } from "@/components/intake/IntakeScreens";
import { NewHiresPreview } from "@/components/providerOnboarding/NewHiresPreview";
import { Button } from "@/components/ui/button";
import { CONSENT } from "@/lib/intakeConsent";
import {
  intakeSubmission,
  parseIntakeAnswers,
  type IntakeGateway,
  type IntakeState,
} from "@/lib/intakeAnswers";
import { safeFileName } from "@/lib/documents";
import { PRACTICE, newHireState, reviewState } from "@/services/providerOnboardingFixtures";

const enabled = import.meta.env.DEV || import.meta.env.VITE_DEV_PROVIDER_ONBOARDING === "1";

export const Route = createFileRoute("/dev/provider-onboarding")({
  beforeLoad: () => {
    if (!enabled) throw notFound();
  },
  component: ProviderOnboardingPreview,
});

const PREVIEW_CODE = "123456";

const SCENARIOS = {
  new_hire: { label: "New hire", email: "anita.rao@example.test", state: newHireState },
  review: {
    label: "Existing provider review",
    email: "priya.shah@example.test",
    state: reviewState,
  },
  dead_link: { label: "Dead link", email: "", state: null },
  server_error: { label: "Server error", email: "", state: null },
} as const;
type Scenario = keyof typeof SCENARIOS;

function ProviderOnboardingPreview() {
  const [side, setSide] = useState<"practice" | "provider">("provider");
  const [scenario, setScenario] = useState<Scenario>("new_hire");
  const [run, setRun] = useState(0);

  return (
    <div className="min-h-dvh bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 text-[13px]">
        <span className="font-semibold">Onboarding preview</span>
        <Button
          size="sm"
          variant={side === "practice" ? "default" : "outline"}
          onClick={() => setSide("practice")}
        >
          Practice
        </Button>
        <Button
          size="sm"
          variant={side === "provider" ? "default" : "outline"}
          onClick={() => setSide("provider")}
        >
          Provider
        </Button>
        {side === "provider" ? (
          <>
            <label htmlFor="preview-scenario" className="ml-2 text-muted-foreground">
              Scenario
            </label>
            <select
              id="preview-scenario"
              value={scenario}
              onChange={(e) => {
                setScenario(e.target.value as Scenario);
                setRun((r) => r + 1);
              }}
              className="h-8 rounded border px-2"
            >
              {Object.entries(SCENARIOS).map(([key, s]) => (
                <option key={key} value={key}>
                  {s.label}
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" onClick={() => setRun((r) => r + 1)}>
              Restart
            </Button>
            <span className="text-muted-foreground">Code: {PREVIEW_CODE}</span>
          </>
        ) : null}
      </div>
      {side === "practice" ? (
        <NewHiresPreview />
      ) : scenario === "dead_link" ? (
        <InvalidLink />
      ) : scenario === "server_error" ? (
        <TryAgain onRetry={() => setScenario("new_hire")} />
      ) : (
        <ProviderRun key={`${scenario}-${run}`} scenario={scenario} />
      )}
    </div>
  );
}

function savedVersion(state: IntakeState): number {
  return state.draft?.version ?? 0;
}

function ProviderRun({ scenario }: { scenario: "new_hire" | "review" }) {
  const { email, state } = SCENARIOS[scenario];
  // The fake server: her journey's state and whether her session is live. The
  // gateway reads `live` here; the state copy re-renders the buttons below.
  const server = useRef<{ state: IntakeState; live: boolean }>({
    state: state(email),
    live: false,
  });
  const [live, setLive] = useState(false);
  const signedIn = useCallback((on: boolean) => {
    server.current.live = on;
    setLive(on);
  }, []);
  const gateway = useMemo(
    (): IntakeGateway => ({
      practiceName: PRACTICE.name,
      email,
      requestCode: () => new Promise((resolve) => setTimeout(resolve, 300)),
      checkCode: async (code) => {
        if (code !== PREVIEW_CODE) return "wrong";
        signedIn(true);
        return "ok";
      },
      signOut: async () => signedIn(false),
      loadState: async () => (server.current.live ? structuredClone(server.current.state) : null),
      saveDraft: async (answers, step, version) => {
        if (!server.current.live) return { kind: "session_ended" };
        if (version !== savedVersion(server.current.state)) return { kind: "conflict" };
        const draft = { answers, step, version: version + 1, updatedAt: new Date().toISOString() };
        server.current.state = { ...server.current.state, draft };
        return { kind: "saved", version: draft.version };
      },
      signConsent: async () => {
        if (!server.current.live) return { kind: "session_ended" };
        server.current.state = {
          ...server.current.state,
          consent: { signed: true, textVersion: CONSENT.version },
        };
        return { kind: "signed" };
      },
      saveSsn: async (full) => {
        if (!server.current.live) return { kind: "session_ended" };
        if (server.current.state.lockedFields.includes("ssn")) return { kind: "locked" };
        const ssnLast4 = full.replace(/\D/g, "").slice(-4);
        server.current.state = { ...server.current.state, ssnLast4 };
        return { kind: "stored", ssnLast4 };
      },
      saveLogin: async (portal) => {
        if (!server.current.live) return { kind: "session_ended" };
        const current = server.current.state;
        server.current.state = {
          ...current,
          loginsOnFile: { ...current.loginsOnFile, [portal]: true },
        };
        return { kind: "stored" };
      },
      uploadDocument: async (slot, file) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (!server.current.live) return { kind: "session_ended" };
        const upload = {
          id: crypto.randomUUID(),
          slotKey: slot.key,
          kind: slot.kind,
          fileName: safeFileName(file.name),
          sizeBytes: file.size,
          expiresOn: null,
        };
        const current = server.current.state;
        server.current.state = {
          ...current,
          uploads: [...current.uploads.filter((u) => u.slotKey !== slot.key), upload],
        };
        return { kind: "uploaded", upload };
      },
      removeDocument: async (uploadId) => {
        if (!server.current.live) return { kind: "session_ended" };
        const current = server.current.state;
        server.current.state = {
          ...current,
          uploads: current.uploads.filter((u) => u.id !== uploadId),
        };
        return { kind: "removed" };
      },
      setDocumentExpiry: async (uploadId, expiresOn) => {
        if (!server.current.live) return { kind: "session_ended" };
        const current = server.current.state;
        server.current.state = {
          ...current,
          uploads: current.uploads.map((u) => (u.id === uploadId ? { ...u, expiresOn } : u)),
        };
        return { kind: "saved" };
      },
      submit: async (version) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!server.current.live) return { kind: "session_ended" };
        const current = server.current.state;
        if (current.submitted) return { kind: "submitted" };
        if (version !== savedVersion(current)) return { kind: "conflict" };
        const { missing } = intakeSubmission(current);
        if (missing.length > 0) return { kind: "incomplete", missing };
        server.current.state = { ...current, submitted: true };
        return { kind: "submitted" };
      },
      requestHelp: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return server.current.live ? { kind: "sent" } : { kind: "session_ended" };
      },
    }),
    [email, signedIn],
  );
  // Another window saves a new mobile number first: her next save conflicts
  // and the form reloads.
  const editElsewhere = () => {
    const current = server.current.state;
    const answers = parseIntakeAnswers({
      licenses: current.record.licenses.map((l) => ({ state: l.state })),
      ...current.draft?.answers,
      mobile: "7045550188",
    });
    if (!answers) return;
    server.current.state = {
      ...current,
      draft: {
        answers,
        step: current.draft?.step ?? "form",
        version: savedVersion(current) + 1,
        updatedAt: new Date().toISOString(),
      },
    };
  };
  return (
    <>
      <div className="flex justify-end gap-2 px-4 pt-2">
        <Button size="sm" variant="ghost" disabled={!live} onClick={editElsewhere}>
          Edit in another window
        </Button>
        <Button size="sm" variant="ghost" disabled={!live} onClick={() => signedIn(false)}>
          End the session
        </Button>
      </div>
      <IntakeFlow gateway={gateway} />
    </>
  );
}
