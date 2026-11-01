// Mission Control › Organizations › one organization (M3). Profile and
// lifecycle, counts from platform_org_summary() (groups with TIN last four and
// group NPI, providers by bucket, open cases by status, members, pending
// invites, last activity), the members list and pending invites (the M1
// platform-admin read policies). No provider rows: a platform admin opens an
// organization's data only through a membership, which "Grant myself admin
// membership" creates in one click (audited). "Copy join link" copies
// /join/<slug>. Lifecycle moves are one click each, no confirm dialog
// (offboarding is undone by Reopen).
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { StatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LifecyclePill } from "@/components/mission-control/LifecyclePill";
import { OrgProfileCard } from "@/components/mission-control/OrgProfileCard";
import { useLifecycleStages } from "@/hooks/useLifecycleStages";
import {
  useGrantSelfAdminMembership,
  usePlatformOrg,
  usePlatformOrgInvites,
  usePlatformOrgMembers,
  usePlatformOrgSummary,
  useSetOrgLifecycle,
} from "@/hooks/usePlatformOrganizations";
import { useAuthStore } from "@/lib/auth-store";
import { fmtDate, fmtDateTime } from "@/lib/format";
import {
  allowedNextStages,
  lifecycleActionLabel,
  lifecycleStage,
  type LifecycleStage,
} from "@/lib/lifecycle";
import { orgDetailTabs } from "@/lib/orgDetailTabs";
import { joinPath } from "@/lib/orgProfile";
import { ROLE_LABELS } from "@/lib/permissions";
import type { PlatformOrgListRow, PlatformOrgSummary } from "@/types";

const CARD = "rounded-md border border-[var(--mp-border)] bg-[var(--mp-card)] p-4";
const TITLE = "text-[11px] font-semibold uppercase tracking-[.06em] text-muted-foreground";
const HEAD =
  "px-3 text-left text-[11px] font-semibold uppercase tracking-[.06em] text-muted-foreground";

const CASE_STATUS_LABELS: Record<keyof PlatformOrgSummary["cases"]["byStatus"], string> = {
  not_started: "Not started",
  in_progress: "In progress",
  submitted: "Submitted",
  in_review: "In review",
  action_required: "Action required",
};

export function OrganizationDetail({ orgId }: { orgId: string }) {
  const stages = useLifecycleStages();
  const orgQ = usePlatformOrg(orgId);
  const summaryQ = usePlatformOrgSummary(orgId);

  if (orgQ.isPending) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading organization">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (orgQ.isError || !orgQ.data) {
    return (
      <div className={`${CARD} py-8`}>
        <EmptyState
          message={orgQ.isError ? "This organization didn't load" : "No organization with this id"}
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/mission-control/organizations">All organizations</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const org = orgQ.data;
  const stage = lifecycleStage(org.lifecycleState, stages);

  return (
    <div className="space-y-4">
      <OrgHeader org={org} stage={stage} />
      <Tabs defaultValue="overview">
        <TabsList>
          {orgDetailTabs().map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <OrgProfileCard org={org} owner={summaryQ.data?.owner} writable={stage.writable} />
            <LifecycleCard orgId={org.id} stage={stage} stages={stages} />
            <SummaryCards summaryQ={summaryQ} />
          </div>
        </TabsContent>
        <TabsContent value="members" className="mt-4">
          <MembersTable orgId={org.id} />
        </TabsContent>
        <TabsContent value="invites" className="mt-4">
          <InvitesTable orgId={org.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OrgHeader({ org, stage }: { org: PlatformOrgListRow; stage: LifecycleStage }) {
  const navigate = useNavigate();
  const membership = useAuthStore((s) => s.memberships.find((m) => m.orgId === org.id) ?? null);
  const setActiveOrg = useAuthStore((s) => s.setActiveOrg);
  const grant = useGrantSelfAdminMembership(org.id);

  async function copyJoinLink() {
    const link = `${window.location.origin}${joinPath(org.slug)}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Join link copied", { description: link });
    } catch {
      toast.message("Copy the join link", { description: link });
    }
  }

  function openWorkspace() {
    setActiveOrg(org.id);
    void navigate({ to: "/org-detail" });
  }

  return (
    <div className="space-y-3">
      <Link
        to="/mission-control/organizations"
        className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        All organizations
      </Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[18px] font-semibold tracking-tight text-foreground">{org.name}</h2>
            <LifecyclePill stage={stage} />
          </div>
          <p className="mt-1 font-mono text-[12.5px] text-muted-foreground">{joinPath(org.slug)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void copyJoinLink()}>
            Copy join link
          </Button>
          {membership?.role === "admin" ? (
            <Button size="sm" onClick={openWorkspace}>
              Open in workspace
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={grant.isPending}
              onClick={() =>
                grant.mutate(undefined, {
                  onSuccess: () => toast.success("You're an admin of this organization"),
                  onError: (e) =>
                    toast.error(e instanceof Error ? e.message : "Couldn't grant membership"),
                })
              }
            >
              {grant.isPending ? "Granting…" : "Grant myself admin membership"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function LifecycleCard({
  orgId,
  stage,
  stages,
}: {
  orgId: string;
  stage: LifecycleStage;
  stages: readonly LifecycleStage[];
}) {
  const move = useSetOrgLifecycle(orgId);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const next = allowedNextStages(stage.key, stages);

  return (
    <section className={CARD} aria-label="Lifecycle">
      <h3 className={TITLE}>Lifecycle</h3>
      <div className="mt-3 flex items-center gap-2 text-[13px]">
        <span className="text-muted-foreground">Stage</span>
        <LifecyclePill stage={stage} />
      </div>
      <ul className="mt-3 space-y-1 text-[12.5px] text-muted-foreground">
        <li>
          {stage.writable
            ? "Changes are on."
            : "Changes are off: every write is refused, reads still work."}
        </li>
        <li>
          {stage.generationAllowed
            ? "Case generation is in its normal stage."
            : "Case generation shows a note until the organization is Active."}
        </li>
      </ul>
      {next.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {next.map((target) => (
            <Button
              key={target.key}
              variant={target.writable ? "default" : "outline"}
              size="sm"
              disabled={move.isPending}
              onClick={() => {
                setPendingKey(target.key);
                move.mutate(target.key, {
                  onSuccess: () => toast.success(`Moved to ${target.displayName}`),
                  onError: (e) =>
                    toast.error(e instanceof Error ? e.message : "Couldn't change the stage"),
                  onSettled: () => setPendingKey(null),
                });
              }}
            >
              {move.isPending && pendingKey === target.key
                ? "Saving…"
                : lifecycleActionLabel(stage, target)}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SummaryCards({ summaryQ }: { summaryQ: ReturnType<typeof usePlatformOrgSummary> }) {
  if (summaryQ.isError) {
    return (
      <div className={`${CARD} py-6 lg:col-span-2`}>
        <EmptyState
          message="The counts didn't load"
          action={
            <Button variant="outline" size="sm" onClick={() => void summaryQ.refetch()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }
  const summary = summaryQ.data;
  if (!summary) {
    return (
      <div className="space-y-3 lg:col-span-2" aria-busy="true" aria-label="Loading counts">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const providerRows: Array<[string, number]> = [
    ["Onboarding", summary.providers.onboarding],
    ["Awaiting verification", summary.providers.pendingVerification],
    ["Active", summary.providers.active],
    ["In credentialing", summary.providers.inCredentialing],
    ["Terminated", summary.providers.terminated],
  ];

  return (
    <>
      <section className={`${CARD} lg:col-span-2`} aria-label="Groups">
        <h3 className={TITLE}>Groups</h3>
        {summary.groups.length === 0 ? (
          <p className="mt-3 text-[13px] text-muted-foreground">No groups yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-[13px]">
              <thead>
                <tr className="h-9 border-b border-[var(--mp-border)]">
                  <th className={HEAD}>Group</th>
                  <th className={HEAD}>TIN</th>
                  <th className={HEAD}>Group NPI</th>
                </tr>
              </thead>
              <tbody>
                {summary.groups.map((group) => (
                  <tr
                    key={group.id}
                    className="h-10 border-b border-[var(--mp-border)] last:border-b-0"
                  >
                    <td className="px-3">
                      {group.name}
                      {group.active ? null : (
                        <StatusPill status="neutral" label="Inactive" className="ml-2" />
                      )}
                    </td>
                    <td className="px-3 font-mono text-[12.5px]">
                      {group.tinLast4 ? `•••••${group.tinLast4}` : "None"}
                    </td>
                    <td className="px-3 font-mono text-[12.5px]">{group.npi ?? "None"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className={CARD} aria-label="Providers">
        <h3 className={TITLE}>Providers</h3>
        <p className="mt-2 text-[26px] font-bold leading-none tabular-nums">
          {summary.providers.total}
        </p>
        <dl className="mt-3 space-y-1 text-[12.5px]">
          {providerRows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className={CARD} aria-label="Open cases">
        <h3 className={TITLE}>Open cases</h3>
        <p className="mt-2 text-[26px] font-bold leading-none tabular-nums">{summary.cases.open}</p>
        <dl className="mt-3 space-y-1 text-[12.5px]">
          {(Object.keys(CASE_STATUS_LABELS) as Array<keyof typeof CASE_STATUS_LABELS>).map(
            (status) => (
              <div key={status} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{CASE_STATUS_LABELS[status]}</dt>
                <dd className="tabular-nums">{summary.cases.byStatus[status]}</dd>
              </div>
            ),
          )}
        </dl>
      </section>
      <section className={`${CARD} lg:col-span-2`} aria-label="Activity">
        <h3 className={TITLE}>Activity</h3>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Members</dt>
            <dd className="tabular-nums">{summary.members}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Pending invites</dt>
            <dd className="tabular-nums">{summary.pendingInvites}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last activity</dt>
            <dd>{summary.lastActivityAt ? fmtDateTime(summary.lastActivityAt) : "None yet"}</dd>
          </div>
        </dl>
      </section>
    </>
  );
}

function MembersTable({ orgId }: { orgId: string }) {
  const membersQ = usePlatformOrgMembers(orgId);
  return (
    <div className={`${CARD} overflow-x-auto p-0`}>
      <table className="w-full min-w-[520px] text-[13px]">
        <thead>
          <tr className="h-10 border-b border-[var(--mp-border)]">
            <th className={HEAD}>Name</th>
            <th className={HEAD}>Email</th>
            <th className={HEAD}>Role</th>
            <th className={HEAD}>Joined</th>
          </tr>
        </thead>
        <tbody>
          {(membersQ.data ?? []).map((member) => (
            <tr
              key={member.userId}
              className="h-10 border-b border-[var(--mp-border)] last:border-b-0"
            >
              <td className="px-3">{member.fullName ?? "No name on file"}</td>
              <td className="px-3 text-muted-foreground">{member.email ?? "None on file"}</td>
              <td className="px-3">{ROLE_LABELS[member.role]}</td>
              <td className="px-3 text-muted-foreground">{fmtDate(member.joinedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {membersQ.isSuccess && membersQ.data.length === 0 ? (
        <div className="py-8">
          <EmptyState message="No members yet" />
        </div>
      ) : null}
      {membersQ.isError ? (
        <div className="py-8">
          <EmptyState message="The members didn't load" />
        </div>
      ) : null}
    </div>
  );
}

function InvitesTable({ orgId }: { orgId: string }) {
  const invitesQ = usePlatformOrgInvites(orgId);
  return (
    <div className={`${CARD} overflow-x-auto p-0`}>
      <table className="w-full min-w-[520px] text-[13px]">
        <thead>
          <tr className="h-10 border-b border-[var(--mp-border)]">
            <th className={HEAD}>Email</th>
            <th className={HEAD}>Name</th>
            <th className={HEAD}>Role</th>
            <th className={HEAD}>Invited</th>
          </tr>
        </thead>
        <tbody>
          {(invitesQ.data ?? []).map((invite) => (
            <tr key={invite.id} className="h-10 border-b border-[var(--mp-border)] last:border-b-0">
              <td className="px-3">{invite.email}</td>
              <td className="px-3 text-muted-foreground">{invite.fullName ?? "None given"}</td>
              <td className="px-3">{ROLE_LABELS[invite.role]}</td>
              <td className="px-3 text-muted-foreground">{fmtDate(invite.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {invitesQ.isSuccess && invitesQ.data.length === 0 ? (
        <div className="py-8">
          <EmptyState message="No pending invites" />
        </div>
      ) : null}
      {invitesQ.isError ? (
        <div className="py-8">
          <EmptyState message="The invites didn't load" />
        </div>
      ) : null}
    </div>
  );
}
