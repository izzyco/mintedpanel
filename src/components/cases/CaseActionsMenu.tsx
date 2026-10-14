// The case header's ⋯ menu: rare, consequential case actions kept out of the
// page body so the tasks sit directly under the header. Change checklist
// template appears only when another matching SOP exists (no "unavailable"
// banner); Delete case is admin-only and always last. No items → no button.
import { useState } from "react";
import { MoreHorizontal, Repeat2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChangeCaseSopDialog } from "@/components/cases/ChangeCaseSopAction";
import { DeleteCaseDialog } from "@/components/cases/DeleteCaseAction";
import { useSops } from "@/hooks/useAdmin";
import { caseActionsMenuItems, changeCaseSopOptions } from "@/lib/changeCaseSop";
import type { CaseDetail } from "@/types";

export function CaseActionsMenu({
  c,
  canEdit,
  isAdmin,
}: {
  c: CaseDetail;
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const templatesQ = useSops();
  const [dialog, setDialog] = useState<"change_template" | "delete_case" | null>(null);
  const templates = templatesQ.data ?? [];
  const sop = changeCaseSopOptions(templates, c, canEdit);
  const items = caseActionsMenuItems({ changeTemplateEligible: sop.eligible, isAdmin });

  if (items.length === 0 && dialog === null) return null;

  return (
    <>
      {items.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 shadow-none"
              aria-label="More case actions"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {items.includes("change_template") ? (
              <DropdownMenuItem
                className="items-start gap-2"
                onSelect={() => setDialog("change_template")}
              >
                <Repeat2 className="mt-0.5 h-4 w-4" aria-hidden />
                <span>
                  <span className="block text-[13px]">Change checklist template</span>
                  <span className="block text-[11px] text-muted-foreground">
                    Only before any task is started
                  </span>
                </span>
              </DropdownMenuItem>
            ) : null}
            {items.length > 1 ? <DropdownMenuSeparator /> : null}
            {items.includes("delete_case") ? (
              <DropdownMenuItem
                className="gap-2 text-destructive focus:text-destructive"
                onSelect={() => setDialog("delete_case")}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                <span className="text-[13px]">Delete case…</span>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {dialog === "change_template" ? (
        <ChangeCaseSopDialog
          c={c}
          sop={sop}
          templates={templates}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "delete_case" ? <DeleteCaseDialog c={c} onClose={() => setDialog(null)} /> : null}
    </>
  );
}
