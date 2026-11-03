// Six-item sidebar (redesign E6.1 F6.1.1 — the epic's authorized
// src/components/layout/* edit, superseding the E0.9/E4.2 IA v2 nav).
//
// Six primary items for every user, mirroring the four journeys, plus a
// seventh for platform admins only:
//   Workspace zone (cross-org): Cases (the merged F6.1.3 surface + open-case
//   count chip) · Payer Setup (→ /admin/payer-admin, visible to ALL roles per
//   the interim two-trusted-users posture; needs-attention chip = the drift
//   deck size until E6.5's derivation supersedes it) · Reporting Center ·
//   Mission Control (→ /mission-control, rendered ONLY when the auth store's
//   isPlatformAdmin is true; unspecced, logged in DESIGN-DEBT.md).
//   Org zone (below the org switcher tile): Org Detail · Groups · Providers.
// NO Admin section exists for any role — MSO Routing, Statuses, Data Import,
// and Settings are retired per their owning epics (F6.1.6 redirect table);
// Audit Log re-homes into the Reporting Center in E6.6.
//
// Branding (F6.1.1 AC): the layered-jack mark + wordmark keep their geometry;
// the mark renders through the rail ink token, white everywhere and rail-ink
// on the Mission Control rail only. The switcher menu keeps the E0.9 behavior
// (lifecycle group headings ONLY, never a per-org status label; search above
// 10 orgs; footer Add organization → /onboarding + View all organizations).
// User footer: its Settings item lands on /account, the user's own name/title
// page (2026-08-16). It pointed at Org Detail only while no personal settings
// page existed; /admin/settings itself remains a redirect stub.
//
// Rail colors read the --mp-sidebar-* tokens (styles.css): ink steps whose
// defaults are today's white alphas, so the forest rail is pixel-identical and
// the Mission Control surface swaps the palette by overriding tokens on <html>.
// Focus on the rail uses its own ring token — the app's soft green ring is
// invisible on forest. Renders in both the desktop rail and mobile drawer.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useAuthStore, useActiveMembership, type MembershipEntry } from "@/lib/auth-store";
import { useCases } from "@/hooks/useCases";
import { useStatusConfigs } from "@/hooks/useAdmin";
import { useFormDrift } from "@/hooks/useFormDrift";
import { ROLE_LABELS, usePlatformAdmin } from "@/lib/permissions";
import { useLifecycleStages } from "@/hooks/useLifecycleStages";
import { groupBySwitcherGroup, type LifecycleStage } from "@/lib/lifecycle";
// The approved white layered-jack mark (E1.0 F1.0.4 / TE-8), copied from
// docs/redesign/design-system/design-system-reference/assets/logo-white.png —
// pinned untouched by E6.1 F6.1.1 (the decision-mock gradient square is a
// placeholder, not a proposal). Never recolored, except the Mission Control
// rail, where the mark is rail-ink: the PNG is the mask (every opaque pixel in
// it is pure white, so its alpha is the whole shape) and the fill is the
// --mp-sidebar-ink token, so the geometry is the file's and the colour is the
// rail's. No effects.
import logoWhite from "@/assets/logo-white.png";
import {
  FolderKanban,
  CreditCard,
  BarChart3,
  Contact,
  Users,
  UserCog,
  ChevronDown,
  Check,
  Plus,
  ArrowRight,
  Search,
  Settings,
  LogOut,
  ShieldCheck,
} from "lucide-react";

type Icon = typeof FolderKanban;

// The mark as a CSS mask: the fill color is the rail ink token, the shape is
// the shipped PNG. `contain` + `center` reproduce the old object-contain fit.
const MARK_MASK_STYLE: React.CSSProperties = {
  maskImage: `url(${logoWhite})`,
  WebkitMaskImage: `url(${logoWhite})`,
  maskSize: "contain",
  WebkitMaskSize: "contain",
  maskRepeat: "no-repeat",
  WebkitMaskRepeat: "no-repeat",
  maskPosition: "center",
  WebkitMaskPosition: "center",
};

type NavLink = { to: string; label: string; icon: Icon };

// Switcher scale rules (reference readme NAVIGATION): ≤10 orgs plain grouped
// list; above 10 a search field + scroll; at 100+ recents only (the active org
// is the only tracked recent today) with "View all" exiting to the portfolio.
const SEARCH_ABOVE = 10;
const RECENTS_AT = 100;

function initialsOf(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}

// Nav focus uses the rail's own ring token (white-alpha on forest; F0.9.3,
// preserved by E6.1) — the global soft green ring is invisible on forest.
const navFocus =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--mp-sidebar-focus)]";

const navItemClass = (activeItem: boolean) =>
  `flex items-center gap-3 px-3 py-2 rounded-[var(--mp-radius-control)] text-[13px] transition-colors ${navFocus} ${
    activeItem
      ? "bg-mp-sidebar-ink/10 text-mp-sidebar-ink font-medium shadow-[inset_2px_0_0_var(--mp-sidebar-accent)]"
      : "text-mp-sidebar-ink-60 hover:text-mp-sidebar-ink hover:bg-mp-sidebar-ink/5"
  }`;

const sectionLabelClass =
  "px-3 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-mp-sidebar-ink-35";

// Open cases = case_status outside the terminal bucket (E6.0's unified field
// still riding the legacy mirror for status-config consumers); status-less
// cases count as open. Shares the /cases page cache keys — no polling.
function useOpenCaseCount(): number | null {
  const casesQ = useCases();
  const statusQ = useStatusConfigs("credentialing");
  return useMemo(() => {
    if (!casesQ.data) return null;
    const completeIds = new Set(
      (statusQ.data ?? []).filter((s) => s.actionBucket === "complete").map((s) => s.id),
    );
    return casesQ.data.filter(
      (c) => !c.credentialingStatusId || !completeIds.has(c.credentialingStatusId),
    ).length;
  }, [casesQ.data, statusQ.data]);
}

function CountChip({ count, label }: { count: number; label: string }) {
  return (
    <span
      aria-label={label}
      className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-mp-sidebar-ink/[0.14] px-[5px] text-[11px] font-semibold tabular-nums text-mp-sidebar-ink"
    >
      {count}
    </span>
  );
}

// Lifecycle-grouped switcher entries. Group headings only — never a per-org
// status label (E0.0 locked decision, same mechanism as the Portfolio). The
// groups come from the lifecycle stage objects (Mission Control M3), read
// through normalizeLifecycle(): In motion (active), Prospects (prospect,
// onboarding); an offboarded organization (and a legacy inactive one) is in
// no group and drops out of the switcher. The Portfolio still lists it.
function groupMemberships(
  memberships: MembershipEntry[],
  query: string,
  stages: readonly LifecycleStage[],
) {
  const q = query.trim().toLowerCase();
  const matches = (m: MembershipEntry) => !q || m.orgName.toLowerCase().includes(q);
  return groupBySwitcherGroup(memberships.filter(matches), (m) => m.lifecycleState, stages).map(
    (g) => ({ key: g.key, label: g.label, orgs: g.items }),
  );
}

interface SidebarProps {
  onNavigate?: () => void;
  onOpenSearch: () => void;
}

export function Sidebar({ onNavigate, onOpenSearch }: SidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const memberships = useAuthStore((s) => s.memberships);
  const activeOrgId = useAuthStore((s) => s.activeOrgId);
  const setActiveOrg = useAuthStore((s) => s.setActiveOrg);
  const signOut = useAuthStore((s) => s.signOut);
  const user = useAuthStore((s) => s.user);
  const fullName = useAuthStore((s) => s.fullName);
  const active = useActiveMembership();
  const isPlatformAdmin = usePlatformAdmin();
  const lifecycleStages = useLifecycleStages();
  const openCases = useOpenCaseCount();
  // E6.5 F6.5.4 — the chip is DRIFT-ONLY now: mappings the last real fill
  // couldn't find on the live page (the one repair signal), derived from two
  // org caches. The four-kind Fix-it deck count retired with the deck.
  const drift = useFormDrift();
  const needsAttention = drift.isLoading || drift.isError ? null : drift.totalCount;
  const [orgQuery, setOrgQuery] = useState("");
  // SSR and the first client render must agree. Mac updates the hint after mount.
  const [shortcut, setShortcut] = useState("Ctrl K");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setShortcut("⌘K");
  }, []);

  const isActive = (to: string) =>
    to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(to + "/");

  async function handleSignOut() {
    await signOut();
    navigate({ to: "/login", replace: true });
  }

  function renderNavItem(item: NavLink, trailing?: React.ReactNode) {
    const ItemIcon = item.icon;
    const activeItem = isActive(item.to);
    return (
      <Link
        key={item.to}
        to={item.to}
        aria-current={activeItem ? "page" : undefined}
        className={navItemClass(activeItem)}
        onClick={onNavigate}
      >
        <ItemIcon className="w-4 h-4 flex-none" />
        <span className="flex-1">{item.label}</span>
        {trailing}
      </Link>
    );
  }

  const showSearch = memberships.length > SEARCH_ABOVE;
  const recentsOnly = memberships.length >= RECENTS_AT && orgQuery.trim() === "";
  const visibleGroups = recentsOnly
    ? groupMemberships(
        memberships.filter((m) => m.orgId === activeOrgId),
        "",
        lifecycleStages,
      )
    : groupMemberships(memberships, orgQuery, lifecycleStages);

  return (
    <aside className="w-full md:w-[232px] flex-shrink-0 bg-mp-sidebar flex flex-col h-full">
      {/* Logo (F6.1.1 AC): the shipped PNG as a mask filled from the rail ink
          token — white on the forest rail, rail-ink on the Mission Control
          rail. Same geometry, no effects. */}
      <div className="px-5 pt-4 pb-2.5 flex items-center gap-2">
        <span
          role="img"
          aria-label="Minted Panel"
          className="inline-block h-6 w-6 flex-none bg-mp-sidebar-ink"
          style={MARK_MASK_STYLE}
        />
        <span className="text-[14px] font-semibold text-mp-sidebar-ink">Minted Panel</span>
      </div>

      {/* Cross-org provider lookup. A button, not a nav link — the six primary
          items stay exactly the Workspace and org-zone links. */}
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={onOpenSearch}
          aria-label="Find a provider"
          className={`flex h-9 w-full items-center gap-2 rounded-[var(--mp-radius-control)] border border-mp-sidebar-ink/10 bg-mp-sidebar-ink/[0.06] px-3 text-[13px] text-mp-sidebar-ink-70 hover:bg-mp-sidebar-ink/10 hover:text-mp-sidebar-ink ${navFocus}`}
        >
          <Search className="h-4 w-4 flex-none" />
          <span className="flex-1 text-left">Find a provider</span>
          <kbd className="text-[11px] text-mp-sidebar-ink-40">{shortcut}</kbd>
        </button>
      </div>

      {/* Workspace — the three cross-org journey entries (F6.1.1), plus
          Mission Control for platform admins */}
      <div className="px-3 pt-1.5">
        <div className={sectionLabelClass}>Workspace</div>
        <nav className="space-y-0.5" aria-label="Workspace">
          {renderNavItem(
            { to: "/cases", label: "Cases", icon: FolderKanban },
            openCases !== null ? (
              <CountChip count={openCases} label={`${openCases} open cases`} />
            ) : undefined,
          )}
          {/* Payer Setup renders for ALL roles for now (two trusted users;
              revisit at the third hire) — F6.1.1. */}
          {renderNavItem(
            { to: "/admin/payer-admin", label: "Payer Setup", icon: CreditCard },
            needsAttention !== null && needsAttention > 0 ? (
              <CountChip count={needsAttention} label={`${needsAttention} broken form mappings`} />
            ) : undefined,
          )}
          {renderNavItem({ to: "/reporting", label: "Reporting Center", icon: BarChart3 })}
          {isPlatformAdmin === true
            ? renderNavItem({ to: "/mission-control", label: "Mission Control", icon: ShieldCheck })
            : null}
        </nav>
      </div>

      {/* Generous break + divider before the org zone */}
      <div className="mx-3 mt-10 border-t border-mp-sidebar-ink/10" />

      {/* Org zone — the switcher tile IS the header; children are the three
          org-scoped journey entries (F6.1.1). */}
      <div className="flex-1 overflow-y-auto px-3 pt-6 pb-1">
        {active ? (
          <>
            <DropdownMenu onOpenChange={(open) => !open && setOrgQuery("")}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Active organization: ${active.orgName}. Switch organization`}
                  className={`w-full flex items-center gap-2.5 rounded-[var(--mp-radius-sm)] border border-mp-sidebar-ink/[0.08] bg-mp-sidebar-ink/[0.06] px-3 py-[9px] mb-1.5 text-left hover:bg-mp-sidebar-ink/10 transition-colors ${navFocus}`}
                >
                  <span className="flex-1 min-w-0 flex flex-col gap-px">
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-mp-sidebar-ink-40">
                      Organization
                    </span>
                    <span className="truncate text-[14px] font-semibold text-mp-sidebar-ink">
                      {active.orgName}
                    </span>
                  </span>
                  <ChevronDown className="w-4 h-4 flex-none text-mp-sidebar-ink-50" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64 p-0">
                {showSearch ? (
                  <div className="border-b border-[var(--mp-border-subtle)] p-2">
                    <div className="flex h-[30px] items-center gap-2 rounded-[var(--mp-radius-control)] bg-[var(--mp-muted)] px-[9px]">
                      <Search className="h-[13px] w-[13px] flex-none text-[var(--mp-ink-faint)]" />
                      <input
                        value={orgQuery}
                        onChange={(e) => setOrgQuery(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                        placeholder="Search organizations…"
                        aria-label="Search organizations"
                        className="w-full bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-[var(--mp-ink-faint)]"
                      />
                    </div>
                  </div>
                ) : null}
                <div className="max-h-[252px] overflow-y-auto py-1">
                  {recentsOnly ? (
                    <div className="px-3 pb-1 pt-2 text-[11px] text-muted-foreground">
                      Showing recent organizations — search to find others.
                    </div>
                  ) : null}
                  {visibleGroups.map((group, gi) => (
                    <div
                      key={group.key}
                      className={gi > 0 ? "mt-1 border-t border-[var(--mp-border-faint)]" : ""}
                    >
                      <div className="px-3 pb-[3px] pt-2 text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--mp-ink-faint)]">
                        {group.label}
                      </div>
                      {group.orgs.map((m) => (
                        <DropdownMenuItem
                          key={m.orgId}
                          onSelect={() => setActiveOrg(m.orgId)}
                          className="flex items-center justify-between gap-2 px-3 py-[7px] text-[13px]"
                        >
                          <span className={m.orgId === activeOrgId ? "font-medium" : ""}>
                            {m.orgName}
                          </span>
                          {m.orgId === activeOrgId ? (
                            <Check className="w-3.5 h-3.5 text-[var(--mp-brand-ink)]" />
                          ) : null}
                        </DropdownMenuItem>
                      ))}
                    </div>
                  ))}
                  {visibleGroups.length === 0 ? (
                    <div className="px-3 py-2 text-[12.5px] text-muted-foreground">
                      No organizations match.
                    </div>
                  ) : null}
                </div>
                <div className="border-t border-[var(--mp-border-subtle)]">
                  <DropdownMenuItem
                    onSelect={() => navigate({ to: "/onboarding" })}
                    className="gap-2 px-3 py-[9px] font-medium text-[var(--mp-brand-ink)]"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add organization
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => navigate({ to: "/reporting/portfolio" })}
                    className="gap-2 border-t border-[var(--mp-border-faint)] px-3 py-[9px] text-[12.5px] text-muted-foreground"
                  >
                    View all organizations
                    <ArrowRight className="w-[13px] h-[13px]" />
                  </DropdownMenuItem>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
            <nav className="space-y-0.5" aria-label={`${active.orgName} navigation`}>
              {/* Org Detail keeps the existing contact-card icon (epic
                  component constraint); Groups uses the stock user-cog. */}
              {renderNavItem({ to: "/org-detail", label: "Org Detail", icon: Contact })}
              {renderNavItem({ to: "/groups", label: "Groups", icon: UserCog })}
              {renderNavItem({ to: "/providers", label: "Providers", icon: Users })}
            </nav>
          </>
        ) : (
          // No org selected → dashed-border prompt tile (F0.9.3).
          <div className="rounded-[var(--mp-radius-sm)] border border-dashed border-mp-sidebar-ink/[0.22] px-3 py-3 text-[12px] leading-normal text-mp-sidebar-ink-50">
            Select an organization to see its details.
          </div>
        )}
      </div>

      {/* User footer (F6.1.1). Settings lands on /account — personal name and
          title; org-level management stays on Org Detail in the nav above. */}
      <div className="border-t border-mp-sidebar-ink/10 p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account menu"
              className={`w-full flex items-center gap-2.5 rounded-[var(--mp-radius-sm)] px-2 py-2 text-left bg-mp-sidebar-ink/5 hover:bg-mp-sidebar-ink/10 transition-colors ${navFocus}`}
            >
              <div className="w-7 h-7 rounded-full bg-mp-sidebar-ink/10 border border-mp-sidebar-ink/15 flex items-center justify-center text-[11px] font-medium text-mp-sidebar-ink flex-shrink-0">
                {initialsOf(fullName, user?.email ?? null)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="truncate text-[13px] font-medium text-mp-sidebar-ink">
                  {fullName ?? user?.email ?? "Signed in"}
                </div>
                <div className="truncate text-[11px] text-mp-sidebar-ink-50">
                  {active ? (ROLE_LABELS[active.role] ?? active.role) : ""}
                </div>
              </div>
              <ChevronDown className="w-4 h-4 text-mp-sidebar-ink-40" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-[230px]">
            <div className="px-3 py-2">
              <div className="text-[13px] font-medium text-foreground truncate">
                {fullName ?? user?.email ?? "Signed in"}
              </div>
              <div className="text-[12px] text-muted-foreground truncate">{user?.email}</div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                onNavigate?.();
                navigate({ to: "/account" });
              }}
              className="gap-2.5"
            >
              <Settings className="w-[15px] h-[15px] text-muted-foreground" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleSignOut} className="gap-2.5 text-destructive">
              <LogOut className="w-[15px] h-[15px]" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
