// The field block of an invite (board 1), shared by the staff dialog and the
// practice's New hires dialog. Each caller owns sending and what comes back.
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { NO_GROUP, inviteNpiProblem, type InviteFieldValues } from "@/lib/inviteFields";

const LABEL = "text-[12px]";
const HINT = "text-[11px] text-muted-foreground";
const ERROR = "text-[11px] text-destructive";

export function InviteFields({
  values,
  onChange,
  groups,
}: {
  values: InviteFieldValues;
  onChange: (values: InviteFieldValues) => void;
  groups: { id: string; name: string }[];
}) {
  const set = (patch: Partial<InviteFieldValues>) => onChange({ ...values, ...patch });
  const [npiTouched, setNpiTouched] = useState(false);
  const npiError = npiTouched || values.npi.length === 10 ? inviteNpiProblem(values.npi) : null;

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="invite-first" className={LABEL}>
            First name
          </Label>
          <Input
            id="invite-first"
            value={values.firstName}
            onChange={(e) => set({ firstName: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-last" className={LABEL}>
            Last name
          </Label>
          <Input
            id="invite-last"
            value={values.lastName}
            onChange={(e) => set({ lastName: e.target.value })}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="invite-email" className={LABEL}>
          Email
        </Label>
        <Input
          id="invite-email"
          type="email"
          aria-describedby="invite-email-hint"
          value={values.email}
          onChange={(e) => set({ email: e.target.value })}
        />
        <p id="invite-email-hint" className={HINT}>
          A personal email works best. Sign-in codes go here.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="invite-group" className={LABEL}>
          Group
        </Label>
        <Select value={values.groupId} onValueChange={(groupId) => set({ groupId })}>
          <SelectTrigger id="invite-group" aria-describedby="invite-group-hint">
            <SelectValue placeholder="Choose a group" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_GROUP} disabled>
              Choose a group
            </SelectItem>
            {groups.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p id="invite-group-hint" className={HINT}>
          Minted assigns the location once the form is in.
        </p>
      </div>
      <details className="text-[12px]">
        <summary className="cursor-pointer font-medium text-primary">
          NPI and start date (optional)
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="invite-npi" className={LABEL}>
              NPI
            </Label>
            <Input
              id="invite-npi"
              inputMode="numeric"
              placeholder="10 digits"
              aria-describedby={npiError ? "invite-npi-error" : "invite-npi-hint"}
              aria-invalid={npiError !== null}
              value={values.npi}
              onChange={(e) => set({ npi: e.target.value.replace(/\D/g, "").slice(0, 10) })}
              onBlur={() => setNpiTouched(true)}
            />
            {npiError ? (
              <p id="invite-npi-error" className={ERROR}>
                {npiError}
              </p>
            ) : (
              <p id="invite-npi-hint" className={HINT}>
                Fills in the form. The provider can correct it before submitting.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-start" className={LABEL}>
              Start date
            </Label>
            <Input
              id="invite-start"
              type="date"
              value={values.startDate}
              onChange={(e) => set({ startDate: e.target.value })}
            />
          </div>
        </div>
      </details>
    </div>
  );
}
