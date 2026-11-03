// Boards 5x (after "I need help" or "Wrong? Tell us") and 5c (after Submit).
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HelpReason, LockedField } from "@/lib/intakeFlow";

const FIELD_NAMES: Record<LockedField, string> = {
  npi: "NPI",
  dateOfBirth: "date of birth",
  ssn: "SSN",
};

export function HelpSent({
  practiceName,
  reason,
  onBack,
}: {
  practiceName: string;
  reason: HelpReason;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <CircleCheck className="h-6 w-6 text-[#047857]" aria-hidden />
      <h1 className="text-[18px] leading-snug font-semibold">
        {reason.kind === "fix"
          ? `We've flagged your ${FIELD_NAMES[reason.field]} for a fix`
          : `We've let ${practiceName} know`}
      </h1>
      <p className="text-[13px] leading-normal text-muted-foreground">
        {reason.kind === "fix"
          ? `${practiceName}'s credentialing team will check it with you. Keep going with the rest of your form in the meantime.`
          : "Your practice administrator will reach out."}
      </p>
      <Button type="button" className="h-12 w-full text-[15px]" onClick={onBack}>
        Back to your form
      </Button>
    </div>
  );
}

export function ThankYou({
  practiceName,
  email,
  again,
}: {
  practiceName: string;
  email: string;
  again: boolean;
}) {
  if (again) {
    return (
      <div className="flex flex-col gap-3">
        <CircleCheck className="h-6 w-6 text-[#047857]" aria-hidden />
        <h1 className="text-[18px] leading-snug font-semibold">You've already sent your form</h1>
        <p className="text-[13px] leading-normal text-[#4B5563]">
          {practiceName} has it. If something has changed, contact {practiceName}.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3.5">
      <CircleCheck className="h-7 w-7 text-[#047857]" aria-hidden />
      <h1 className="text-[20px] leading-snug font-semibold">Thank you for submitting!</h1>
      <p className="text-[13px] leading-normal text-[#4B5563]">
        Please make sure you can receive our emails. Add us to your address book so you get any
        follow-ups or clarifications insurers request.
      </p>
      <div className="flex flex-col gap-1 rounded-md border border-[#E8E5E0] bg-[#FAFAF8] px-3.5 py-3">
        <p className="text-[11px] font-semibold tracking-[0.04em] text-[#4B5563] uppercase">
          Add this sender
        </p>
        <p className="text-[14px] font-medium">{practiceName} via Minted Panel</p>
      </div>
      <p className="text-[13px] leading-normal text-[#4B5563]">
        We've also emailed this to <span className="font-medium text-foreground">{email}</span>. You
        can close this page.
      </p>
    </div>
  );
}
