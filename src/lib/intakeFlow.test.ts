import { describe, expect, it } from "vitest";
import {
  CODE_WINDOW_MS,
  canRequestCode,
  initialIntakeFlow,
  intakeFlow,
  type IntakeEvent,
  type IntakeFlowState,
} from "./intakeFlow";

const T0 = Date.parse("2026-11-02T15:00:00Z");

function run(events: IntakeEvent[], from: IntakeFlowState = initialIntakeFlow()) {
  return events.reduce(intakeFlow, from);
}

const signIn: IntakeEvent[] = [{ type: "code_requested", at: T0 }, { type: "signed_in" }];

describe("intakeFlow gateway", () => {
  it("sends a code from identify and lands on the code screen", () => {
    expect(run([{ type: "code_requested", at: T0 }]).screen).toEqual({ kind: "code" });
  });

  it("locks the code after five wrong tries and lets her ask for a new one right away", () => {
    const wrong = Array.from({ length: 5 }, () => ({ type: "code_wrong", at: T0 }) as const);
    const state = run([{ type: "code_requested", at: T0 }, ...wrong]);
    expect(state.screen).toEqual({ kind: "too_many_tries", until: T0 });
    expect(run([{ type: "code_requested", at: T0 + 1 }], state).screen).toEqual({ kind: "code" });
  });

  it("stays on the code screen after four wrong tries", () => {
    const wrong = Array.from({ length: 4 }, () => ({ type: "code_wrong", at: T0 }) as const);
    expect(run([{ type: "code_requested", at: T0 }, ...wrong]).screen).toEqual({ kind: "code" });
  });

  it("pauses a fourth code inside ten minutes until the first one ages out", () => {
    const sends = [0, 1000, 2000].map((d) => ({ type: "code_requested", at: T0 + d }) as const);
    const state = run([...sends, { type: "code_requested", at: T0 + 3000 }]);
    expect(state.screen).toEqual({ kind: "too_many_tries", until: T0 + CODE_WINDOW_MS });
    expect(canRequestCode(state, T0 + CODE_WINDOW_MS - 1)).toBe(false);
    expect(canRequestCode(state, T0 + CODE_WINDOW_MS)).toBe(true);
  });
});

describe("intakeFlow after sign-in", () => {
  it("asks for consent first, then goes to the form", () => {
    expect(run(signIn).screen).toEqual({ kind: "consent" });
    expect(run([...signIn, { type: "consent_signed" }]).screen).toEqual({ kind: "form" });
  });

  it("resumes where she left off after signing out and back in", () => {
    const state = run([
      ...signIn,
      { type: "consent_signed" },
      { type: "continued" },
      { type: "signed_out" },
    ]);
    expect(state.screen).toEqual({ kind: "signed_out", reason: "signed_out" });
    const back = run([{ type: "start_over" }, ...signIn], state);
    expect(back.screen).toEqual({ kind: "documents" });
  });

  it("treats a lost session as a timeout only while she is signed in", () => {
    const onForm = run([...signIn, { type: "consent_signed" }, { type: "session_ended" }]);
    expect(onForm.screen).toEqual({ kind: "signed_out", reason: "timed_out" });
    expect(run([{ type: "session_ended" }]).screen).toEqual({ kind: "identify" });
  });

  it("returns from a help request to the screen she asked from", () => {
    const fix = { kind: "fix", field: "npi" } as const;
    const help = run([
      ...signIn,
      { type: "consent_signed" },
      { type: "help_requested", reason: fix },
    ]);
    expect(help.screen).toEqual({ kind: "help", reason: fix, from: "form" });
    expect(run([{ type: "help_closed" }], help).screen).toEqual({ kind: "form" });
  });

  it("shows the thank-you page after Submit, and again when she signs back in", () => {
    const done = run([
      ...signIn,
      { type: "consent_signed" },
      { type: "continued" },
      { type: "submitted" },
    ]);
    expect(done.screen).toEqual({ kind: "submitted", again: false });
    const again = run([{ type: "signed_out" }, { type: "start_over" }, ...signIn], done);
    expect(again.screen).toEqual({ kind: "submitted", again: true });
  });

  it("ignores events that don't apply to the current screen", () => {
    expect(run([{ type: "continued" }, { type: "submitted" }]).screen).toEqual({
      kind: "identify",
    });
  });
});
