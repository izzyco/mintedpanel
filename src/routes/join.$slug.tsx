// /join/<slug> (Mission Control M3): the invite-gated join link. A signed-in
// user with a pending invite for that organization joins it through the
// existing pending_invites + claim_invites() path (the membership reload runs
// claim_invites() first) and lands in its workspace. Anyone else sees that the
// link needs an invitation and whom to ask, with a way on: never a 404, never
// a dead end. The slug rule is the only naming rule: a DNS label, unique,
// fixed once created.
import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/lib/auth-store";
import { isValidSlug } from "@/lib/orgProfile";
import { findMyOrganizationBySlug } from "@/services/joinOrganization";

export const Route = createFileRoute("/join/$slug")({
  component: JoinPage,
});

type JoinState = "checking" | "needs-invite" | "error";

function JoinPage() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const email = useAuthStore((s) => s.user?.email ?? null);
  const signOut = useAuthStore((s) => s.signOut);
  const [state, setState] = useState<JoinState>("checking");
  const [attempt, setAttempt] = useState(0);
  const normalized = slug.trim().toLowerCase();

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setState("checking");
      if (!isValidSlug(normalized)) {
        setState("needs-invite");
        return;
      }
      try {
        // Reloading memberships runs claim_invites() first, so a pending invite
        // for this organization becomes a membership here.
        await useAuthStore.getState().loadMemberships();
        const joined = await findMyOrganizationBySlug(normalized);
        if (cancelled) return;
        if (!joined) {
          setState("needs-invite");
          return;
        }
        // Leave this page before switching organization: the switch remounts
        // the routed subtree, which would otherwise run this check twice.
        await navigate({ to: "/cases", replace: true });
        useAuthStore.getState().setActiveOrg(joined.orgId);
        toast.success(`You're in ${joined.orgName}`);
      } catch {
        if (!cancelled) setState("error");
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [normalized, attempt, navigate]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="w-full max-w-md rounded-md border border-[var(--mp-border)] bg-[var(--mp-card)] p-6 text-center">
        {state === "checking" ? (
          <p className="text-[13px] text-muted-foreground" aria-busy="true">
            Checking your invitation…
          </p>
        ) : null}
        {state === "error" ? (
          <>
            <h1 className="text-[16px] font-semibold text-foreground">
              The invitation check didn't finish
            </h1>
            <p className="mt-2 text-[13px] text-muted-foreground">
              Something went wrong while checking. Try again.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </div>
          </>
        ) : null}
        {state === "needs-invite" ? (
          <>
            <h1 className="text-[16px] font-semibold text-foreground">
              This link needs an invitation
            </h1>
            <p className="mt-2 text-[13px] text-muted-foreground">
              {email ? (
                <>
                  There is no invitation for <span className="font-medium">{email}</span> to join
                  this organization.
                </>
              ) : (
                "There is no invitation for this account to join this organization."
              )}{" "}
              Ask the organization's administrator or your Minted contact to invite you, then open
              this link again.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button asChild size="sm">
                <Link to="/">Go to my workspace</Link>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void signOut().then(() => navigate({ to: "/login", replace: true }));
                }}
              >
                Use a different account
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
