// A shared organization name, said plainly (Sowmya, Nov 1 2026: a duplicate
// name is allowed, with a notice). Shown as soon as a typed name matches
// another organization's normalized name, and on an organization's page while
// it shares its name, with a link to each other organization. Not a block,
// not a confirm, and nothing is recorded.
import { Link } from "@tanstack/react-router";
import { usePlatformOrgNames } from "@/hooks/usePlatformOrganizations";
import { sameNameOrganizations } from "@/lib/orgProfile";

export function SameNameNotice({
  name,
  excludeId,
  creating = false,
}: {
  name: string;
  excludeId?: string;
  creating?: boolean;
}) {
  const namesQ = usePlatformOrgNames();
  const matches = sameNameOrganizations(name, namesQ.data ?? [], excludeId);
  if (matches.length === 0) return null;
  return (
    <p role="note" className="mt-1 text-[12px] text-[var(--mp-warn-ink)]">
      {matches.length === 1
        ? "Another organization has this name: "
        : "Other organizations have this name: "}
      {matches.map((org, index) => (
        <span key={org.id}>
          {index > 0 ? ", " : null}
          <Link
            to="/mission-control/organizations/$orgId"
            params={{ orgId: org.id }}
            className="font-medium underline underline-offset-2"
          >
            {org.name}
          </Link>
        </span>
      ))}
      .{creating ? " You can still create this one." : null}
    </p>
  );
}
