// /organizations: an admin-panel shortcut into Mission Control (M3 redirect stub).
// A platform admin lands on /mission-control/organizations; anyone else sees the generic not-found view
// at this URL (PlatformAdminRedirect). The redirect also runs in beforeLoad on
// client navigation once the store knows the caller is a platform admin.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { PlatformAdminRedirect } from "@/components/mission-control/PlatformAdminRedirect";
import { useAuthStore } from "@/lib/auth-store";

export const Route = createFileRoute("/organizations")({
  beforeLoad: () => {
    if (useAuthStore.getState().isPlatformAdmin === true) {
      throw redirect({ to: "/mission-control/organizations", replace: true });
    }
  },
  component: () => <PlatformAdminRedirect to="/mission-control/organizations" />,
});
