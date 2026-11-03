// Mission Control › Organizations › one organization (M3). The layout route
// (mission-control.tsx) owns the guard, breadcrumb and section navigation.
import { createFileRoute } from "@tanstack/react-router";
import { OrganizationDetail } from "@/components/mission-control/OrganizationDetail";

export const Route = createFileRoute("/mission-control/organizations/$orgId")({
  component: OrganizationDetailPage,
});

function OrganizationDetailPage() {
  const { orgId } = Route.useParams();
  return <OrganizationDetail key={orgId} orgId={orgId} />;
}
