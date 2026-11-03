// The admin-panel shortcuts /settings, /users and /organizations (Mission
// Control M3). A platform admin is sent into the Mission Control section; for
// anyone else the URL stays put and shows the generic not-found view, exactly
// what an unknown URL shows, so the shortcut never reveals that Mission
// Control exists. RequirePlatformAdmin holds a skeleton until the flag is
// known (it is empty during a hard-load beforeLoad).
import { Navigate } from "@tanstack/react-router";
import { RequirePlatformAdmin } from "@/components/mission-control/RequirePlatformAdmin";
import type { MissionControlSectionPath } from "@/lib/missionControl";

export function PlatformAdminRedirect({ to }: { to: MissionControlSectionPath }) {
  return (
    <RequirePlatformAdmin>
      <Navigate to={to} replace />
    </RequirePlatformAdmin>
  );
}
