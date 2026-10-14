// Admin hard-delete confirm on case detail, opened from the case ⋯ menu
// (CaseActionsMenu). Controlled carve-out via the delete_case RPC — frees the
// 4-part key so generation can recreate the case.
import { useNavigate, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDeleteCase } from "@/hooks/useCases";
import type { CaseDetail } from "@/types";

export function DeleteCaseDialog({ c, onClose }: { c: CaseDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const router = useRouter();
  const deleteCaseM = useDeleteCase();

  const run = () => {
    deleteCaseM.mutate(c.id, {
      onSuccess: () => {
        onClose();
        toast.success("Case deleted");
        if (router.history.canGoBack()) {
          router.history.back();
        } else {
          void navigate({ to: "/cases" });
        }
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : "Could not delete this case."),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !deleteCaseM.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this case?</DialogTitle>
          <DialogDescription>
            Permanently delete this case and all related activity (tasks, touch log, notes, status
            history)? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {c.caseStatus === "approved" ? (
          <p role="alert" className="text-[13px] text-foreground">
            This case is Approved — the matching live enrollment fact will be expired so generation
            can recreate the case if the provider still qualifies.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleteCaseM.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={run} disabled={deleteCaseM.isPending}>
            {deleteCaseM.isPending ? "Deleting…" : "Delete permanently"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
