// Board 0 wording, derived from a hire's events so the row, the Needs you card
// and the dialogs can't drift apart.
import { fmtDate } from "@/lib/format";
import { openHelpRequest } from "@/lib/newHires";
import { deriveStage } from "@/lib/providerOnboarding";
import type { OnboardingHire, OnboardingStage, WaitingOn } from "@/types/providerOnboarding";

export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0];
}

// "Shelby Sports Rehab · Concord" reads as "Concord" inside the practice's own view.
export function shortGroupName(groupName: string, practiceName: string): string {
  const prefix = `${practiceName} · `;
  return groupName.startsWith(prefix) ? groupName.slice(prefix.length) : groupName;
}

// The five tracker steps, shared by board 0 and board 6b.
export const STAGE_STEPS: { stage: OnboardingStage; label: string }[] = [
  { stage: "invited", label: "Invited" },
  { stage: "started", label: "Started" },
  { stage: "submitted", label: "Submitted" },
  { stage: "ready", label: "Ready for credentialing" },
  { stage: "in_credentialing", label: "In credentialing" },
];

export const WAITING_ON_INK: Record<WaitingOn, string> = {
  practice: "text-[var(--mp-danger-ink)]",
  provider: "text-[var(--mp-warn-ink)]",
  minted: "text-[var(--mp-info-ink)]",
};

export const WAITING_ON_RING: Record<WaitingOn, string> = {
  practice: "border-[var(--mp-danger)]",
  provider: "border-[var(--mp-warn)]",
  minted: "border-[var(--mp-info)]",
};

export const LEGEND: { waitingOn: WaitingOn; label: string }[] = [
  { waitingOn: "provider", label: "with the clinician" },
  { waitingOn: "practice", label: "with you" },
  { waitingOn: "minted", label: "with Minted" },
];

export function waitingOnLine(hire: OnboardingHire): { who: string; detail: string } {
  const help = openHelpRequest(hire.events);
  const name = firstName(hire.displayName);
  if (help) {
    const on = fmtDate(help.at);
    return {
      who: "You",
      detail:
        help.type === "told_not_needed"
          ? `${name} was told this isn't needed (${on})`
          : `${name} asked for help ${on}`,
    };
  }
  switch (deriveStage(hire.events)) {
    case "invited":
      return { who: name, detail: "invited, hasn't signed in yet" };
    case "started":
      return {
        who: name,
        detail: hire.events.some((e) => e.type === "section_saved")
          ? "started, answers saved, not submitted"
          : "started, not submitted",
      };
    case "submitted":
      return { who: "Minted", detail: "submitted, awaiting review" };
    case "ready":
      return { who: "Minted", detail: "ready for credentialing, no payer applications yet" };
    case "in_credentialing":
      return { who: "Minted", detail: "in credentialing with payers" };
  }
}

export function needsYouLine(hire: OnboardingHire): string {
  const help = openHelpRequest(hire.events);
  const name = firstName(hire.displayName);
  if (help?.type === "told_not_needed") {
    return `${name} says they were told this isn't needed (${fmtDate(help.at)}). Give ${name} a call, or resend the invitation.`;
  }
  return `${name} asked for help on ${fmtDate(help?.at)} and hasn't finished the form. Give ${name} a call, or resend the invitation.`;
}
