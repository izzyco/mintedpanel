// Provider intake (docs/provider-onboarding/slice-1-invite-to-form.md, canvas
// Stage 1). Public and chromeless (listed in __root.tsx). The link token is the
// door; the emailed code is the key. The session that follows is an HttpOnly
// cookie, so nothing here stores a token. Her consent and answers are saved
// through /api/intake/* and read back when she signs in; her SSN and logins go
// to the vaults, and her documents to a holding area until Submit puts them
// and her answers on her record. A help request reaches her practice.
import { createFileRoute } from "@tanstack/react-router";
import { IntakeFlow } from "@/components/intake/IntakeFlow";
import {
  IntakePaused,
  IntakeShell,
  InvalidLink,
  TryAgain,
} from "@/components/intake/IntakeScreens";
import { useIntakeGateway, useIntakeLink } from "@/hooks/useIntake";
import { isIntakePaused } from "@/lib/intakeFlow";

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
  const { gateway, paused } = useIntakeGateway(token, link.data);

  if (paused || (link.isError && isIntakePaused(link.error))) return <IntakePaused />;
  if (link.isLoading) {
    return (
      <IntakeShell practiceName={null}>
        <div className="text-[13px] text-muted-foreground">Loading…</div>
      </IntakeShell>
    );
  }
  if (link.isError) return <TryAgain onRetry={() => void link.refetch()} />;
  if (!gateway) return <InvalidLink />;

  return <IntakeFlow gateway={gateway} />;
}
