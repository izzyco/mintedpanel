// Which provider intake screen shows, as one reducer (canvas Stage 1, boards
// 3 through 5c). The live /intake route and the /dev preview both drive it;
// only where the events come from differs. Pure: every time arrives on the event.

// Mirrors the server's code rules (20261025120000_provider_intake_invites.sql):
// five wrong tries kill a code, and three codes per ten minutes per invite.
export const CODE_MAX_WRONG = 5;
export const CODE_MAX_SENDS = 3;
export const CODE_WINDOW_MS = 10 * 60 * 1000;

export type LockedField = "npi" | "dateOfBirth" | "ssn";
export type HelpReason = { kind: "help" } | { kind: "fix"; field: LockedField };
type Resume = "consent" | "form" | "documents";

export type IntakeScreen =
  | { kind: "identify" }
  | { kind: "code" }
  | { kind: "too_many_tries"; until: number }
  | { kind: "signed_out"; reason: "signed_out" | "timed_out" }
  | { kind: "consent" }
  | { kind: "form" }
  | { kind: "documents" }
  | { kind: "help"; reason: HelpReason; from: Resume }
  | { kind: "submitted"; again: boolean };

export interface IntakeFlowState {
  screen: IntakeScreen;
  codesSentAt: number[];
  wrongTries: number;
  // Where signing in lands: the furthest screen she reached this visit.
  resumeAt: Resume;
  submitted: boolean;
}

export type IntakeEvent =
  | { type: "code_requested"; at: number }
  | { type: "code_wrong"; at: number }
  | { type: "signed_in" }
  | { type: "session_ended" }
  | { type: "signed_out" }
  | { type: "start_over" }
  | { type: "consent_signed" }
  | { type: "continued" }
  | { type: "went_back" }
  | { type: "help_requested"; reason: HelpReason }
  | { type: "help_closed" }
  | { type: "submitted" };

export function initialIntakeFlow(): IntakeFlowState {
  return {
    screen: { kind: "identify" },
    codesSentAt: [],
    wrongTries: 0,
    resumeAt: "consent",
    submitted: false,
  };
}

function recentSends(state: IntakeFlowState, now: number): number[] {
  return state.codesSentAt.filter((at) => now - at < CODE_WINDOW_MS);
}

/** When the next code may be sent: now, or when the oldest of three recent sends ages out. */
function nextCodeAt(state: IntakeFlowState, now: number): number {
  const recent = recentSends(state, now);
  return recent.length < CODE_MAX_SENDS ? now : Math.min(...recent) + CODE_WINDOW_MS;
}

export function canRequestCode(state: IntakeFlowState, now: number): boolean {
  return nextCodeAt(state, now) <= now;
}

const SIGNED_IN: IntakeScreen["kind"][] = ["consent", "form", "documents", "help", "submitted"];

function landing(state: IntakeFlowState): IntakeScreen {
  return state.submitted ? { kind: "submitted", again: true } : { kind: state.resumeAt };
}

export function intakeFlow(state: IntakeFlowState, event: IntakeEvent): IntakeFlowState {
  const { screen } = state;
  const go = (next: IntakeScreen, patch: Partial<IntakeFlowState> = {}): IntakeFlowState => ({
    ...state,
    ...patch,
    screen: next,
  });

  switch (event.type) {
    case "code_requested": {
      if (!["identify", "code", "too_many_tries"].includes(screen.kind)) return state;
      if (!canRequestCode(state, event.at)) {
        return go({ kind: "too_many_tries", until: nextCodeAt(state, event.at) });
      }
      return go(
        { kind: "code" },
        { codesSentAt: [...recentSends(state, event.at), event.at], wrongTries: 0 },
      );
    }
    case "code_wrong": {
      if (screen.kind !== "code") return state;
      const wrongTries = state.wrongTries + 1;
      if (wrongTries < CODE_MAX_WRONG) return go(screen, { wrongTries });
      return go({ kind: "too_many_tries", until: nextCodeAt(state, event.at) }, { wrongTries });
    }
    case "signed_in":
      if (SIGNED_IN.includes(screen.kind)) return state;
      return go(landing(state), { wrongTries: 0 });
    case "session_ended":
      return SIGNED_IN.includes(screen.kind)
        ? go({ kind: "signed_out", reason: "timed_out" })
        : state;
    case "signed_out":
      return SIGNED_IN.includes(screen.kind)
        ? go({ kind: "signed_out", reason: "signed_out" })
        : state;
    case "start_over":
      return screen.kind === "signed_out" || screen.kind === "too_many_tries"
        ? go({ kind: "identify" })
        : state;
    case "consent_signed":
      return screen.kind === "consent" ? go({ kind: "form" }, { resumeAt: "form" }) : state;
    case "continued":
      return screen.kind === "form" ? go({ kind: "documents" }, { resumeAt: "documents" }) : state;
    case "went_back":
      return screen.kind === "documents" ? go({ kind: "form" }, { resumeAt: "form" }) : state;
    case "help_requested":
      return screen.kind === "consent" || screen.kind === "form" || screen.kind === "documents"
        ? go({ kind: "help", reason: event.reason, from: screen.kind })
        : state;
    case "help_closed":
      return screen.kind === "help" ? go({ kind: screen.from }) : state;
    case "submitted":
      return screen.kind === "documents"
        ? go({ kind: "submitted", again: false }, { submitted: true })
        : state;
  }
}
