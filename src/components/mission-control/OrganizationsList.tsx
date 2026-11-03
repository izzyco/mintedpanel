// Mission Control › Organizations (M3): every organization, read under RLS
// (the platform-admin SELECT policy on organizations). Search over name and
// slug, sort by name or created date, 25 to a page. Offboarded organizations
// (the stages not shown by default, with the legacy inactive) are left out
// until "Include offboarded" is ticked. Each row: name, slug, lifecycle stage,
// member count, created date. No PHI.
import { useDeferredValue, useState } from "react";
import { Link } from "@tanstack/react-router";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeletonRows } from "@/components/TableSkeletonRows";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CreateOrganizationDialog } from "@/components/mission-control/CreateOrganizationDialog";
import { LifecyclePill } from "@/components/mission-control/LifecyclePill";
import { useLifecycleStages } from "@/hooks/useLifecycleStages";
import { usePlatformOrgList } from "@/hooks/usePlatformOrganizations";
import { fmtDate } from "@/lib/format";
import { lifecycleStage } from "@/lib/lifecycle";
import type { PlatformOrgSort } from "@/types";

const PAGE_SIZE = 25;

const SORTS: Array<{ value: PlatformOrgSort; label: string }> = [
  { value: "name", label: "Name, A to Z" },
  { value: "-name", label: "Name, Z to A" },
  { value: "-created", label: "Newest first" },
  { value: "created", label: "Oldest first" },
];

const CARD = "rounded-md border border-[var(--mp-border)] bg-[var(--mp-card)]";
const HEAD =
  "px-3 text-left text-[11px] font-semibold uppercase tracking-[.06em] text-muted-foreground";

export function OrganizationsList() {
  const stages = useLifecycleStages();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<PlatformOrgSort>("name");
  const [page, setPage] = useState(1);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [creating, setCreating] = useState(false);

  // The list follows the typing without a request per keystroke blocking it.
  const deferredSearch = useDeferredValue(search);
  const listQ = usePlatformOrgList({
    search: deferredSearch,
    sort,
    page,
    pageSize: PAGE_SIZE,
    includeHidden,
  });
  const total = listQ.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows = listQ.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <Input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder="Search by name or slug"
          aria-label="Search organizations"
          className="h-9 sm:w-72"
        />
        <Select
          value={sort}
          onValueChange={(value) => {
            setSort(value as PlatformOrgSort);
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="Sort organizations" className="h-9 sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Checkbox
            id="mc-include-offboarded"
            checked={includeHidden}
            onCheckedChange={(checked) => {
              setIncludeHidden(checked === true);
              setPage(1);
            }}
          />
          <Label htmlFor="mc-include-offboarded" className="text-[13px] font-normal">
            Include offboarded
          </Label>
        </div>
        <div className="sm:ml-auto">
          <Button size="sm" className="h-9" onClick={() => setCreating(true)}>
            New organization
          </Button>
        </div>
      </div>

      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full min-w-[640px] text-[13px]">
          <thead>
            <tr className="h-10 border-b border-[var(--mp-border)]">
              <th className={HEAD}>Organization</th>
              <th className={HEAD}>Slug</th>
              <th className={HEAD}>Stage</th>
              <th className={`${HEAD} text-right`}>Members</th>
              <th className={HEAD}>Created</th>
            </tr>
          </thead>
          <tbody>
            {listQ.isPending ? <TableSkeletonRows rows={5} cols={5} /> : null}
            {rows.map((row) => (
              <tr key={row.id} className="h-10 border-b border-[var(--mp-border)] last:border-b-0">
                <td className="px-3 font-medium">
                  <Link
                    to="/mission-control/organizations/$orgId"
                    params={{ orgId: row.id }}
                    className="text-foreground hover:underline"
                  >
                    {row.name}
                  </Link>
                </td>
                <td className="px-3 font-mono text-[12.5px] text-muted-foreground">{row.slug}</td>
                <td className="px-3">
                  <LifecyclePill stage={lifecycleStage(row.lifecycleState, stages)} />
                </td>
                <td className="px-3 text-right tabular-nums">{row.memberCount}</td>
                <td className="px-3 text-muted-foreground">{fmtDate(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {listQ.isError ? (
          <div className="py-8">
            <EmptyState
              message="The organizations didn't load"
              action={
                <Button variant="outline" size="sm" onClick={() => void listQ.refetch()}>
                  Retry
                </Button>
              }
            />
          </div>
        ) : null}
        {listQ.isSuccess && rows.length === 0 ? (
          <div className="py-8">
            <EmptyState
              message={search.trim() ? "No organization matches that search" : "No organizations"}
              description={
                includeHidden
                  ? undefined
                  : "Offboarded organizations are hidden. Tick Include offboarded to see them."
              }
            />
          </div>
        ) : null}
      </div>

      {total > 0 ? (
        <div className="flex items-center justify-between gap-3 text-[12.5px] text-muted-foreground">
          <span>
            {total} {total === 1 ? "organization" : "organizations"}
          </span>
          {pages > 1 ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span>
                Page {page} of {pages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pages}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
              >
                Next
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {creating ? <CreateOrganizationDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
