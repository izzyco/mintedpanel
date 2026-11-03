// Mission Control › Organizations (M3). The layout route (mission-control.tsx)
// owns the guard, breadcrumb and section navigation.
import { createFileRoute } from "@tanstack/react-router";
import { OrganizationsList } from "@/components/mission-control/OrganizationsList";

export const Route = createFileRoute("/mission-control/organizations/")({
  component: OrganizationsList,
});
