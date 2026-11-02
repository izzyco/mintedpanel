// Board 1c: the row ⋯ menu's two dialogs, plus the "add start date" link's.
import { useState } from "react";
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
import type { OnboardingHire } from "@/types/providerOnboarding";
import { firstName } from "./hireCopy";

export const PRACTICE_DIALOG = "w-[calc(100%-32px)] max-w-[520px] gap-4 rounded-md sm:rounded-md";
export const PRACTICE_HEADER = "text-left";
export const PRACTICE_TITLE = "text-[15px] leading-snug";
export const PRACTICE_BODY = "text-[13px] leading-relaxed text-foreground";
export const PRACTICE_FOOTER = "flex-row flex-wrap justify-end gap-2 sm:space-x-0";

export function FixEmailDialog({
  hire,
  onSend,
  onClose,
}: {
  hire: OnboardingHire;
  onSend: (email: string) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(hire.invitedEmail);
  const changed = email.trim() !== "" && email.trim() !== hire.invitedEmail;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={PRACTICE_DIALOG}>
        <DialogHeader className={PRACTICE_HEADER}>
          <DialogTitle className={PRACTICE_TITLE}>
            Fix {firstName(hire.displayName)}'s email
          </DialogTitle>
          <DialogDescription className={PRACTICE_BODY}>
            We'll send the invitation to the new address. The old link stops working right away.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <div className="text-[12px] font-medium">Current</div>
          <div className="break-all text-[13px] text-muted-foreground">{hire.invitedEmail}</div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fix-email" className="text-[12px]">
            New email
          </Label>
          <Input
            id="fix-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <DialogFooter className={PRACTICE_FOOTER}>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!changed} onClick={() => onSend(email.trim())}>
            Send to new address
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CancelInviteDialog({
  hire,
  onConfirm,
  onClose,
}: {
  hire: OnboardingHire;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent role="alertdialog" className={PRACTICE_DIALOG}>
        <DialogHeader className={PRACTICE_HEADER}>
          <DialogTitle className={PRACTICE_TITLE}>
            Cancel {firstName(hire.displayName)}'s invitation?
          </DialogTitle>
          <DialogDescription className={PRACTICE_BODY}>
            The link stops working right away and no more reminders go out. Their record and
            anything they entered are removed. You can invite them again later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className={PRACTICE_FOOTER}>
          <Button variant="outline" onClick={onClose}>
            Keep invitation
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Cancel invitation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StartDateDialog({
  hire,
  onSave,
  onClose,
}: {
  hire: OnboardingHire;
  onSave: (startDate: string) => void;
  onClose: () => void;
}) {
  const [startDate, setStartDate] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={PRACTICE_DIALOG} aria-describedby={undefined}>
        <DialogHeader className={PRACTICE_HEADER}>
          <DialogTitle className={PRACTICE_TITLE}>
            Add {firstName(hire.displayName)}'s start date
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="hire-start" className="text-[12px]">
            Start date
          </Label>
          <Input
            id="hire-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <DialogFooter className={PRACTICE_FOOTER}>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!startDate} onClick={() => onSave(startDate)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
