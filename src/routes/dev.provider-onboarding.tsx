// Every Stage 1 onboarding screen on sample data (r1-ui-spec decision 18).
// The practice side has no login yet, so it lives only here. The provider side
// runs the same IntakeFlow as the live /intake link, with a fake gateway, so
// states the live link can't show on demand (a re-invited provider, a dead
// link, a timeout) can be reviewed. Nothing is sent or saved.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";
import { IntakeFlow, type IntakeGateway } from "@/components/intake/IntakeFlow";
import { InvalidLink, TryAgain } from "@/components/intake/IntakeScreens";
import { NewHiresPreview } from "@/components/providerOnboarding/NewHiresPreview";
import { Button } from "@/components/ui/button";
import { PRACTICE, initialDraft, reviewDraft } from "@/services/providerOnboardingFixtures";

const enabled = import.meta.env.DEV || import.meta.env.VITE_DEV_PROVIDER_ONBOARDING === "1";

export const Route = createFileRoute("/dev/provider-onboarding")({
  beforeLoad: () => {
    if (!enabled) throw notFound();
  },
  component: ProviderOnboardingPreview,
});

const PREVIEW_CODE = "123456";

const SCENARIOS = {
  new_hire: { label: "New hire", email: "anita.rao@example.test", draft: initialDraft },
  review: {
    label: "Existing provider review",
    email: "priya.shah@example.test",
    draft: reviewDraft,
  },
  dead_link: { label: "Dead link", email: "", draft: null },
  server_error: { label: "Server error", email: "", draft: null },
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

function ProviderRun({ scenario }: { scenario: "new_hire" | "review" }) {
  const { email, draft } = SCENARIOS[scenario];
  const [session, setSession] = useState<"live" | "none" | null>(null);
  const gateway: IntakeGateway = {
    practiceName: PRACTICE.name,
    email,
    requestCode: () => new Promise((resolve) => setTimeout(resolve, 300)),
    checkCode: async (code) => {
      if (code !== PREVIEW_CODE) return "wrong";
      setSession("live");
      return "ok";
    },
    signOut: async () => setSession(null),
  };
  return (
    <>
      <div className="flex justify-end px-4 pt-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={session !== "live"}
          onClick={() => setSession("none")}
        >
          End the session (timeout)
        </Button>
      </div>
      <IntakeFlow gateway={gateway} session={session} startingDraft={draft(email)} />
    </>
  );
}
