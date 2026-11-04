// Mission Control page chrome, rendered once by the layout route above every
// section: a route-derived breadcrumb (Mission Control › section) and the page
// header. The section navigation lives in Mission Control's own sidebar rail
// (src/components/layout/Sidebar.tsx, 2026-11-02 Option B), which lists the
// closed set in src/lib/missionControl.ts; the horizontal strip that used to
// sit here retired with it.
//
// A router Link marks itself current (aria-current="page") whenever its path
// is a PREFIX of the location, so on Home the root crumb is plain text:
// exactly one element is ever the current page.
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MISSION_CONTROL_PATH, missionControlSection } from "@/lib/missionControl";

export function MissionControlHeader() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = missionControlSection(pathname);
  const onHome = current.to === MISSION_CONTROL_PATH;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-[12.5px]">
        {onHome ? (
          <span className="text-muted-foreground">Mission Control</span>
        ) : (
          <Link
            to="/mission-control"
            activeOptions={{ exact: true }}
            className="text-muted-foreground hover:text-foreground"
          >
            Mission Control
          </Link>
        )}
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span aria-current="page" className="font-medium text-foreground">
          {current.label}
        </span>
      </nav>
      <PageHeader title={current.title} description={current.description} />
    </div>
  );
}
