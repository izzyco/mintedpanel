// Mission Control › Organizations › New organization (M3). One form, one
// click: name, slug (prefilled from the name, editable until created, fixed
// afterwards), owner name and email, optional plan tier. A new organization
// starts in the prospect stage; the operator lands on its detail page.
// Stock shadcn Dialog + inputs styled by tokens (logged in DESIGN-DEBT.md).
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { usePlatformOrgCreateForm } from "@/hooks/usePlatformOrgCreateForm";
import { PLAN_TIERS, joinPath } from "@/lib/orgProfile";

const FIELD_ERROR = "mt-1 text-[12px] text-[var(--mp-danger-ink)]";
const NO_TIER = "__none__";

export function CreateOrganizationDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const form = usePlatformOrgCreateForm({
    onCreated: (orgId) => {
      toast.success("Organization created");
      onClose();
      void navigate({ to: "/mission-control/organizations/$orgId", params: { orgId } });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>New organization</DialogTitle>
          <DialogDescription>
            It starts as a prospect. Contacts and the sales rep can be added on its page later.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            form.submit();
          }}
        >
          <div>
            <Label htmlFor="mc-org-name" className="text-[12px]">
              Organization name
            </Label>
            <Input
              id="mc-org-name"
              autoFocus
              value={form.name}
              onChange={(event) => form.setName(event.target.value)}
              aria-invalid={form.errors.name ? true : undefined}
              className="h-9"
            />
            {form.errors.name ? <div className={FIELD_ERROR}>{form.errors.name}</div> : null}
            <SameNameNotice name={form.name} creating />
          </div>

          <div>
            <Label htmlFor="mc-org-slug" className="text-[12px]">
              Slug
            </Label>
            <Input
              id="mc-org-slug"
              value={form.slug}
              onChange={(event) => form.setSlug(event.target.value)}
              aria-invalid={form.errors.slug ? true : undefined}
              aria-describedby="mc-org-slug-help"
              autoCapitalize="none"
              spellCheck={false}
              className="h-9 font-mono text-[13px]"
            />
            {form.errors.slug ? (
              <div className={FIELD_ERROR}>{form.errors.slug}</div>
            ) : (
              <div id="mc-org-slug-help" className="mt-1 text-[12px] text-muted-foreground">
                Join link {joinPath(form.slug || "…")}. Fixed once the organization is created.
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="mc-org-owner-name" className="text-[12px]">
                Owner name
              </Label>
              <Input
                id="mc-org-owner-name"
                value={form.ownerName}
                onChange={(event) => form.setOwnerName(event.target.value)}
                aria-invalid={form.errors.ownerName ? true : undefined}
                className="h-9"
              />
              {form.errors.ownerName ? (
                <div className={FIELD_ERROR}>{form.errors.ownerName}</div>
              ) : null}
            </div>
            <div>
              <Label htmlFor="mc-org-owner-email" className="text-[12px]">
                Owner email
              </Label>
              <Input
                id="mc-org-owner-email"
                type="email"
                value={form.ownerEmail}
                onChange={(event) => form.setOwnerEmail(event.target.value)}
                aria-invalid={form.errors.ownerEmail ? true : undefined}
                className="h-9"
              />
              {form.errors.ownerEmail ? (
                <div className={FIELD_ERROR}>{form.errors.ownerEmail}</div>
              ) : null}
              {form.emailWarning ? (
                <div className="mt-1 text-[12px] text-[var(--mp-warn-ink)]">
                  Did you mean{" "}
                  <button
                    type="button"
                    onClick={form.applyEmailSuggestion}
                    className="font-medium underline underline-offset-2"
                  >
                    {form.emailWarning}
                  </button>
                  ?
                </div>
              ) : null}
            </div>
          </div>

          <div>
            <Label htmlFor="mc-org-plan-tier" className="text-[12px]">
              Plan tier (optional)
            </Label>
            <Select
              value={form.planTier ?? NO_TIER}
              onValueChange={(value) => form.setPlanTier(value === NO_TIER ? null : value)}
            >
              <SelectTrigger id="mc-org-plan-tier" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TIER}>None</SelectItem>
                {PLAN_TIERS.map((tier) => (
                  <SelectItem key={tier.value} value={tier.value}>
                    {tier.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.errors.form ? (
            <div role="alert" className={FIELD_ERROR}>
              {form.errors.form}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.isPending}>
              {form.isPending ? "Creating…" : "Create organization"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
