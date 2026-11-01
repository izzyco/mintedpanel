// Mission Control › organization detail › Profile (M3): name, slug (fixed),
// plan tier, owner contact, created date. Edit is inline, one Save, through
// update_organization_profile (platform-admin caller; the RPC resolves the
// caller and writes one admin_audit_log row). Refused while offboarded, so the
// button is replaced by a note pointing at Reopen.
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SameNameNotice } from "@/components/mission-control/SameNameNotice";
import { useUpdateOrganizationProfile } from "@/hooks/usePlatformOrganizations";
import { isValidEmail } from "@/lib/contactValidation";
import { fmtDate } from "@/lib/format";
import { PLAN_TIERS, planTierLabel } from "@/lib/orgProfile";
import type { PlatformOrgListRow, PlatformOrgSummary } from "@/types";

const CARD = "rounded-md border border-[var(--mp-border)] bg-[var(--mp-card)] p-4";
const TITLE = "text-[11px] font-semibold uppercase tracking-[.06em] text-muted-foreground";
const FIELD_ERROR = "mt-1 text-[12px] text-[var(--mp-danger-ink)]";
const NO_TIER = "__none__";

interface Draft {
  name: string;
  ownerName: string;
  ownerEmail: string;
  planTier: string | null;
}

export function OrgProfileCard({
  org,
  owner,
  writable,
}: {
  org: PlatformOrgListRow;
  owner: PlatformOrgSummary["owner"] | undefined;
  writable: boolean;
}) {
  const update = useUpdateOrganizationProfile(org.id);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setError(null);
    setDraft({
      name: org.name,
      ownerName: owner?.name ?? "",
      ownerEmail: owner?.email ?? "",
      planTier: org.planTier,
    });
  }

  function save() {
    if (!draft) return;
    if (!draft.name.trim()) return setError("Organization name is required");
    if (!draft.ownerName.trim()) return setError("Owner name is required");
    if (!isValidEmail(draft.ownerEmail)) return setError("Enter a valid owner email address");
    update.mutate(draft, {
      onSuccess: () => {
        toast.success("Profile saved");
        setDraft(null);
      },
      onError: (e) => setError(e instanceof Error ? e.message : "Couldn't save the profile"),
    });
  }

  if (draft) {
    return (
      <section className={CARD} aria-label="Profile">
        <h3 className={TITLE}>Profile</h3>
        <form
          noValidate
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div>
            <Label htmlFor="mc-profile-name" className="text-[12px]">
              Organization name
            </Label>
            <Input
              id="mc-profile-name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className="h-9"
            />
            <SameNameNotice name={draft.name} excludeId={org.id} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="mc-profile-owner-name" className="text-[12px]">
                Owner name
              </Label>
              <Input
                id="mc-profile-owner-name"
                value={draft.ownerName}
                onChange={(event) => setDraft({ ...draft, ownerName: event.target.value })}
                className="h-9"
              />
            </div>
            <div>
              <Label htmlFor="mc-profile-owner-email" className="text-[12px]">
                Owner email
              </Label>
              <Input
                id="mc-profile-owner-email"
                type="email"
                value={draft.ownerEmail}
                onChange={(event) => setDraft({ ...draft, ownerEmail: event.target.value })}
                className="h-9"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="mc-profile-plan-tier" className="text-[12px]">
              Plan tier
            </Label>
            <Select
              value={draft.planTier ?? NO_TIER}
              onValueChange={(value) =>
                setDraft({ ...draft, planTier: value === NO_TIER ? null : value })
              }
            >
              <SelectTrigger id="mc-profile-plan-tier" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TIER}>None</SelectItem>
                {PLAN_TIERS.map((tier) => (
                  <SelectItem key={tier.value} value={tier.value}>
                    {tier.label}
                  </SelectItem>
                ))}
                {draft.planTier && !PLAN_TIERS.some((tier) => tier.value === draft.planTier) ? (
                  <SelectItem value={draft.planTier}>{draft.planTier}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>
          {error ? (
            <div role="alert" className={FIELD_ERROR}>
              {error}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </section>
    );
  }

  const rows: Array<{ label: string; value: string }> = [
    { label: "Name", value: org.name },
    { label: "Slug", value: org.slug },
    { label: "Plan tier", value: planTierLabel(org.planTier) ?? "None" },
    {
      label: "Owner",
      value: owner ? [owner.name, owner.email].filter(Boolean).join(" · ") : "None on file",
    },
    { label: "Created", value: fmtDate(org.createdAt) },
  ];

  return (
    <section className={CARD} aria-label="Profile">
      <div className="flex items-center justify-between gap-2">
        <h3 className={TITLE}>Profile</h3>
        {writable ? (
          <Button variant="outline" size="sm" onClick={startEdit}>
            Edit
          </Button>
        ) : null}
      </div>
      <dl className="mt-3 space-y-2 text-[13px]">
        {rows.map((row) => (
          <div key={row.label} className="flex gap-3">
            <dt className="w-24 shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className={row.label === "Slug" ? "font-mono text-[12.5px]" : ""}>{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[12px] text-muted-foreground">
        {writable
          ? "The escalation contact and sales rep are added on the organization's own page."
          : "Offboarded: reopen the organization to edit its profile."}
      </p>
    </section>
  );
}
