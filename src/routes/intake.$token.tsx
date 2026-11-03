// Provider intake (docs/provider-onboarding/slice-1-invite-to-form.md, canvas
// Stage 1). Public and chromeless (listed in __root.tsx). The link token is the
// door; the emailed code is the key. The session that follows is an HttpOnly
// cookie, so nothing here stores a token. Answers are not saved in this build.
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { IntakeFlow, type IntakeGateway } from "@/components/intake/IntakeFlow";
import { IntakeShell, InvalidLink, TryAgain } from "@/components/intake/IntakeScreens";
import {
  useIntakeLink,
  useIntakeMe,
  useOpenIntakeSession,
  useRequestIntakeCode,
  useSignOutIntake,
} from "@/hooks/useIntake";
import { draftFromInvitation } from "@/lib/providerOnboarding";

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
  const qc = useQueryClient();
  const link = useIntakeLink(token);
  const me = useIntakeMe(token, link.data != null);
  const requestCode = useRequestIntakeCode();
  const openSession = useOpenIntakeSession();
  const signOut = useSignOutIntake();

  if (link.isLoading) {
    return (
      <IntakeShell practiceName={null}>
        <div className="text-[13px] text-muted-foreground">Loading…</div>
      </IntakeShell>
    );
  }
  if (link.isError) return <TryAgain onRetry={() => void link.refetch()} />;
  if (!link.data) return <InvalidLink />;

  const meKey = ["intake-me", token];
  const gateway: IntakeGateway = {
    practiceName: link.data.practiceName,
    email: link.data.email,
    requestCode: () => requestCode.mutateAsync(token),
    checkCode: async (code) => {
      if (!(await openSession.mutateAsync({ token, code }))) return "wrong";
      await qc.invalidateQueries({ queryKey: meKey });
      return "ok";
    },
    signOut: async () => {
      await signOut.mutateAsync();
      qc.setQueryData(meKey, null);
    },
  };

  return (
    <IntakeFlow
      gateway={gateway}
      session={me.isSuccess ? (me.data ? "live" : "none") : null}
      startingDraft={me.data ? draftFromInvitation(me.data) : null}
      onRetryProfile={me.isError ? () => void me.refetch() : undefined}
      notice={
        <p role="note" className="rounded-md bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          This form isn't connected yet. Your answers stay on this page only, nothing is sent to
          your practice, and they're gone if you close or reload it.
        </p>
      }
    />
  );
}
