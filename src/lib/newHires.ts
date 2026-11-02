// The practice's New hires board (screen 0) as a pure reducer over hires and
// the people an invite can match. Every time arrives on the action; every
// count and the Needs you list are derived from the state on each read.
import type {
  KnownPerson,
  OnboardingEvent,
  OnboardingHire,
  WaitingOn,
} from "@/types/providerOnboarding";
import {
  canResend,
  classifyInvite,
  deriveStage,
  deriveWaitingOn,
  isBeforeSubmit,
  needsPractice,
} from "@/lib/providerOnboarding";

export interface NewHiresState {
  hires: OnboardingHire[];
  people: KnownPerson[];
}

export interface InviteInput {
  firstName: string;
  lastName: string;
  email: string;
  npi: string;
  groupName: string;
  startDate: string | null;
}

export type NewHiresAction =
  | { type: "invite"; providerId: string; input: InviteInput; at: string }
  | { type: "resend"; providerId: string; at: string }
  | { type: "mark_contacted"; providerId: string; at: string }
  | { type: "fix_email"; providerId: string; email: string; at: string }
  | { type: "set_start_date"; providerId: string; startDate: string }
  | { type: "cancel"; providerId: string };

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// A person on file links to her row by the address the invitation went to.
export function hireByEmail(hires: OnboardingHire[], email: string): OnboardingHire | undefined {
  return hires.find((h) => sameEmail(h.invitedEmail, email));
}

function updateHire(
  state: NewHiresState,
  providerId: string,
  update: (hire: OnboardingHire) => OnboardingHire,
): NewHiresState {
  return {
    ...state,
    hires: state.hires.map((h) => (h.providerId === providerId ? update(h) : h)),
  };
}

function updatePerson(
  state: NewHiresState,
  email: string,
  update: (person: KnownPerson) => KnownPerson,
): NewHiresState {
  return {
    ...state,
    people: state.people.map((p) => (sameEmail(p.email, email) ? update(p) : p)),
  };
}

function appendEvent(hire: OnboardingHire, event: OnboardingEvent): OnboardingHire {
  return { ...hire, events: [...hire.events, event] };
}

function invite(
  state: NewHiresState,
  action: Extract<NewHiresAction, { type: "invite" }>,
): NewHiresState {
  const { input, at, providerId } = action;
  const match = classifyInvite(input, state.people);
  const invited = (displayName: string, email: string): OnboardingHire => ({
    providerId,
    displayName,
    invitedEmail: email,
    groupName: input.groupName,
    locationName: null,
    source: "practice_invite",
    // Her states come from her license entries; nothing is known at invite.
    states: [],
    startDate: input.startDate,
    events: [{ type: "invited", at }],
  });

  switch (match.kind) {
    case "new": {
      const displayName = `${input.firstName.trim()} ${input.lastName.trim()}`;
      const email = input.email.trim();
      return {
        hires: [...state.hires, invited(displayName, email)],
        people: [
          ...state.people,
          {
            displayName,
            email,
            npi: input.npi.trim() || null,
            groupNames: [input.groupName],
            journey: "open",
          },
        ],
      };
    }
    case "active_on_file": {
      const { person } = match;
      const next = updatePerson(state, person.email, (p) => ({ ...p, journey: "open" }));
      return { ...next, hires: [...next.hires, invited(person.displayName, person.email)] };
    }
    case "already_onboarding": {
      const hire = hireByEmail(state.hires, match.person.email);
      return hire ? resend(state, hire.providerId, at) : state;
    }
    case "on_file_other_group":
      return updatePerson(state, match.person.email, (p) => ({
        ...p,
        groupNames: [...p.groupNames, input.groupName],
      }));
    case "already_submitted":
    case "conflict":
      return state;
  }
}

function resend(state: NewHiresState, providerId: string, at: string): NewHiresState {
  return updateHire(state, providerId, (h) =>
    canResend(h.events, new Date(at)) ? appendEvent(h, { type: "invitation_resent", at }) : h,
  );
}

export function newHiresReducer(state: NewHiresState, action: NewHiresAction): NewHiresState {
  switch (action.type) {
    case "invite":
      return invite(state, action);
    case "resend":
      return resend(state, action.providerId, action.at);
    case "mark_contacted":
      return updateHire(state, action.providerId, (h) =>
        appendEvent(h, { type: "practice_contacted", at: action.at }),
      );
    case "fix_email": {
      const hire = state.hires.find((h) => h.providerId === action.providerId);
      const email = action.email.trim();
      if (!hire || !email || !isBeforeSubmit(deriveStage(hire.events))) return state;
      const next = updatePerson(state, hire.invitedEmail, (p) => ({ ...p, email }));
      return updateHire(next, hire.providerId, (h) =>
        appendEvent({ ...h, invitedEmail: email }, { type: "invitation_resent", at: action.at }),
      );
    }
    case "set_start_date":
      return updateHire(state, action.providerId, (h) => ({ ...h, startDate: action.startDate }));
    case "cancel": {
      const hire = state.hires.find((h) => h.providerId === action.providerId);
      if (!hire || !isBeforeSubmit(deriveStage(hire.events))) return state;
      // Cancel removes the provider's record, not just the invitation.
      return {
        hires: state.hires.filter((h) => h.providerId !== hire.providerId),
        people: state.people.filter((p) => !sameEmail(p.email, hire.invitedEmail)),
      };
    }
  }
}

export function hiresInState(hires: OnboardingHire[], state: string | null): OnboardingHire[] {
  return state === null ? hires : hires.filter((h) => h.states.includes(state));
}

export function hireStates(hires: OnboardingHire[]): string[] {
  return [...new Set(hires.flatMap((h) => h.states))].sort();
}

export function waitingCounts(hires: OnboardingHire[]): Record<WaitingOn, number> {
  const counts: Record<WaitingOn, number> = { practice: 0, provider: 0, minted: 0 };
  for (const h of hires) counts[deriveWaitingOn(h.events)] += 1;
  return counts;
}

export function needsYou(hires: OnboardingHire[]): OnboardingHire[] {
  return hires.filter((h) => needsPractice(h.events));
}

// The help hatch that put her on Needs you: her latest "I need help" or
// "I was told I don't need to do this", while it is still open.
export function openHelpRequest(events: OnboardingEvent[]): OnboardingEvent | null {
  if (!needsPractice(events)) return null;
  const hatches = events.filter((e) => e.type === "help_requested" || e.type === "told_not_needed");
  return hatches.reduce<OnboardingEvent | null>(
    (latest, e) => (latest === null || Date.parse(e.at) > Date.parse(latest.at) ? e : latest),
    null,
  );
}
