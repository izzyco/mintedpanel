// The staff Onboarding card's dialogs (board 6b): Cancel invitation, Admit &
// assign, Test login and Mark problem. Each mounts only while open.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useRevealPortalCredential } from "@/hooks/usePortalCredentials";
import { admitLocationCheck, type AdmitLocation } from "@/lib/onboardingCard";

const NOTE_MAX = 500;

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-[12px] text-[var(--mp-danger-ink)]">
      {message}
    </p>
  );
}

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export function CancelOnboardingDialog({
  firstName,
  createdRecord,
  onConfirm,
  onClose,
}: {
  firstName: string;
  createdRecord: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorText(err, "The invitation couldn't be cancelled. Try again."));
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel {firstName}'s invitation?</DialogTitle>
          <DialogDescription>
            The invitation link stops working right away. What {firstName} entered is removed: the
            answers, the uploaded files, and the SSN and logins saved during onboarding.
          </DialogDescription>
        </DialogHeader>
        <p className="text-[13px]">
          {createdRecord
            ? `This invitation created ${firstName}'s record, so the record is removed too, unless something else is already attached to it.`
            : `${firstName}'s record stays.`}
        </p>
        <ErrorLine message={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Keep invitation
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={pending}>
            {pending ? "Cancelling…" : "Cancel invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function locationLabel(l: AdmitLocation): string {
  const where = [l.city, l.state].filter(Boolean).join(", ");
  return where && where !== l.name ? `${l.name} · ${where}` : l.name;
}

export function AdmitDialog({
  firstName,
  locations,
  licenseStates,
  openChecks,
  onAdmit,
  onClose,
}: {
  firstName: string;
  locations: AdmitLocation[];
  licenseStates: string[];
  /** Labels of the checks not confirmed yet. Shown, never a block. */
  openChecks: string[];
  onAdmit: (location: AdmitLocation) => Promise<void>;
  onClose: () => void;
}) {
  const [pickedId, setPickedId] = useState<string | null>(
    locations.length === 1 ? locations[0].id : null,
  );
  const [assignAnyway, setAssignAnyway] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = admitLocationCheck(pickedId, locations, licenseStates);
  const picked = locations.find((l) => l.id === pickedId);
  const ready = check.kind === "ok" || (check.kind === "out_of_state" && assignAnyway);

  async function admit() {
    if (!picked || !ready) return;
    setPending(true);
    setError(null);
    try {
      await onAdmit(picked);
    } catch (err) {
      setError(errorText(err, `${firstName} couldn't be admitted. Try again.`));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Admit {firstName} and assign a location</DialogTitle>
          <DialogDescription>
            Admit confirms the record, assigns the location, and marks {firstName} ready for
            credentialing. The invitation link stops working.
          </DialogDescription>
        </DialogHeader>

        {locations.length === 0 ? (
          <p className="text-[13px] text-[var(--mp-danger-ink)]">
            None of {firstName}'s groups has an active location. Add one on the group first.
          </p>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="admit-location">Location</Label>
            <Select
              value={pickedId ?? undefined}
              onValueChange={(v) => {
                setPickedId(v);
                setAssignAnyway(false);
              }}
            >
              <SelectTrigger id="admit-location" className="h-9">
                <SelectValue placeholder="Pick a location" />
              </SelectTrigger>
              <SelectContent>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {locationLabel(l)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {check.kind === "out_of_state" ? (
          <div className="space-y-2 rounded-md border border-[var(--mp-warn)] p-3 text-[13px]">
            <p className="text-[var(--mp-warn-ink)]">
              {check.state
                ? `This location is in ${check.state}. `
                : "This location has no state on file. "}
              {check.licenseStates.length > 0
                ? `${firstName}'s licenses are in ${check.licenseStates.join(", ")}.`
                : `${firstName} has no license on the record.`}
            </p>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={assignAnyway}
                onCheckedChange={(v) => setAssignAnyway(v === true)}
                aria-label="Assign this location anyway"
              />
              <span>Assign this location anyway</span>
            </label>
          </div>
        ) : null}

        {openChecks.length > 0 ? (
          <p className="text-[12px] text-muted-foreground">
            Not confirmed yet: {openChecks.join(", ")}.
          </p>
        ) : null}

        <ErrorLine message={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={admit} disabled={!ready || pending}>
            {pending ? "Admitting…" : "Admit & assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Long enough to type the login into the portal; the values then leave memory.
const REVEAL_WINDOW_SECONDS = 60;

/** Board 6b's Test… (D13): an admin gives a reason, sees the login for a
 * minute, then records whether it worked. The login lives only in this
 * component's state, never in the query cache. */
export function TestLoginDialog({
  providerId,
  portal,
  portalName,
  onRecord,
  onClose,
}: {
  providerId: string;
  portal: "caqh" | "pecos";
  portalName: string;
  onRecord: (outcome: "confirmed" | "problem", note: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const reveal = useRevealPortalCredential(providerId);
  const [reason, setReason] = useState("");
  const [login, setLogin] = useState<{ username: string; password: string } | null>(null);
  const [revealedOnce, setRevealedOnce] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!login) return;
    const id = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [login]);
  useEffect(() => {
    if (login && secondsLeft === 0) setLogin(null);
  }, [login, secondsLeft]);

  async function onReveal() {
    setError(null);
    try {
      setLogin(await reveal.mutateAsync({ portal, justification: reason.trim() }));
      setRevealedOnce(true);
      setSecondsLeft(REVEAL_WINDOW_SECONDS);
    } catch (err) {
      setError(errorText(err, "The login couldn't be shown."));
    }
  }

  async function record(outcome: "confirmed" | "problem") {
    setPending(true);
    setError(null);
    try {
      await onRecord(outcome, note.trim() || null);
    } catch (err) {
      setError(errorText(err, "That couldn't be saved. Try again."));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Test the {portalName} login</DialogTitle>
          <DialogDescription>
            Showing the login is recorded in the audit log with your name, the time and your reason.
            It hides after a minute.
          </DialogDescription>
        </DialogHeader>

        {!revealedOnce ? (
          <div className="space-y-1.5">
            <Label htmlFor="login-reveal-reason">Reason</Label>
            <Textarea
              id="login-reveal-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={NOTE_MAX}
              autoFocus
            />
          </div>
        ) : (
          <div className="space-y-3">
            {login ? (
              <div className="space-y-1 rounded-md border p-3 text-[13px]" aria-live="polite">
                <div>
                  <span className="text-muted-foreground">Username </span>
                  <span className="font-mono">{login.username}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Password </span>
                  <span className="font-mono">{login.password}</span>
                </div>
                <p className="text-[12px] text-muted-foreground">Hiding in {secondsLeft}s</p>
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">The login is hidden again.</p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="login-test-note">Note (optional)</Label>
              <Textarea
                id="login-test-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={NOTE_MAX}
              />
            </div>
          </div>
        )}

        <ErrorLine message={error} />
        <DialogFooter>
          {!revealedOnce ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={onReveal} disabled={!reason.trim() || reveal.isPending}>
                {reveal.isPending ? "Showing…" : "Show login"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => record("problem")} disabled={pending}>
                It doesn't work
              </Button>
              <Button onClick={() => record("confirmed")} disabled={pending}>
                It works
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProblemNoteDialog({
  checkLabel,
  onSave,
  onClose,
}: {
  checkLabel: string;
  onSave: (note: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setPending(true);
    setError(null);
    try {
      await onSave(note.trim() || null);
    } catch (err) {
      setError(errorText(err, "That couldn't be saved. Try again."));
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark a problem</DialogTitle>
          <DialogDescription>{checkLabel}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="check-problem-note">What's wrong (optional)</Label>
          <Textarea
            id="check-problem-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={NOTE_MAX}
            autoFocus
          />
        </div>
        <ErrorLine message={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Mark problem"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
