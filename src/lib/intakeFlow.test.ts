import { describe, expect, it } from "vitest";
import {
  CODE_WINDOW_MS,
  LOCKED_FIELD_COLUMN,
  canRequestCode,
  initialIntakeFlow,
  intakeFlow,
  isLockedField,
  lockedFieldOfColumn,
  type IntakeEvent,
  type IntakeFlowState,
  type IntakeResume,
} from "./intakeFlow";

const T0 = Date.parse("2026-11-02T15:00:00Z");

function run(events: IntakeEvent[], from: IntakeFlowState = initialIntakeFlow()) {
  return events.reduce(intakeFlow, from);
}

const fresh: IntakeResume = { consented: false, step: "form", submitted: false };
const signIn = (resume: IntakeResume = fresh): IntakeEvent[] => [
  { type: "code_requested", at: T0 },
  { type: "signed_in" },
  { type: "resumed", resume },
];

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
  it("waits for her saved state after a right code, then asks for consent first", () => {
    const opening = run([{ type: "code_requested", at: T0 }, { type: "signed_in" }]);
    expect(opening.screen).toEqual({ kind: "opening" });
    expect(run(signIn()).screen).toEqual({ kind: "consent" });
    expect(run([...signIn(), { type: "consent_signed" }]).screen).toEqual({ kind: "form" });
  });

  it("lands where her saved state says: the saved step once consented, or done", () => {
    const consented = { ...fresh, consented: true };
    expect(run(signIn(consented)).screen).toEqual({ kind: "form" });
    expect(run(signIn({ ...consented, step: "documents" })).screen).toEqual({
      kind: "documents",
    });
    expect(run(signIn({ ...consented, submitted: true })).screen).toEqual({
      kind: "submitted",
      again: true,
    });
  });

  it("resumes straight from the link when her session is still live", () => {
    const state = run([{ type: "resumed", resume: { ...fresh, consented: true } }]);
    expect(state.screen).toEqual({ kind: "form" });
  });

  it("offers a retry when her state fails to load, and lands once it does", () => {
    const failed = run([
      { type: "code_requested", at: T0 },
      { type: "signed_in" },
      { type: "open_failed" },
    ]);
    expect(failed.screen).toEqual({ kind: "open_failed" });
    expect(run([{ type: "resumed", resume: fresh }], failed).screen).toEqual({ kind: "consent" });
  });

  it("keeps her on her screen when her state is read again while she works", () => {
    const onDocuments = run([...signIn(), { type: "consent_signed" }, { type: "continued" }]);
    const reread = run([{ type: "resumed", resume: { ...fresh, consented: true } }], onDocuments);
    expect(reread.screen).toEqual({ kind: "documents" });
  });

  it("shows the already-sent page when the journey closes under her", () => {
    const onForm = run([...signIn(), { type: "consent_signed" }, { type: "closed" }]);
    expect(onForm.screen).toEqual({ kind: "submitted", again: true });
    expect(run([{ type: "closed" }]).screen).toEqual({ kind: "identify" });
  });

  it("treats a lost session as a timeout only while she is signed in", () => {
    const onForm = run([...signIn(), { type: "consent_signed" }, { type: "session_ended" }]);
    expect(onForm.screen).toEqual({ kind: "signed_out", reason: "timed_out" });
    expect(run([{ type: "session_ended" }]).screen).toEqual({ kind: "identify" });
  });

  it("signs out to the signed-out screen, and signing back in waits for her state again", () => {
    const out = run([...signIn(), { type: "consent_signed" }, { type: "signed_out" }]);
    expect(out.screen).toEqual({ kind: "signed_out", reason: "signed_out" });
    expect(run([{ type: "resumed", resume: fresh }], out).screen).toEqual(out.screen);
    const back = run([{ type: "start_over" }, { type: "code_requested", at: T0 + 1 }], out);
    expect(run([{ type: "signed_in" }], back).screen).toEqual({ kind: "opening" });
  });

  it("returns from a help request to the screen she asked from", () => {
    const fix = { kind: "fix", field: "npi" } as const;
    const help = run([
      ...signIn(),
      { type: "consent_signed" },
      { type: "help_requested", reason: fix },
    ]);
    expect(help.screen).toEqual({ kind: "help", reason: fix, from: "form", status: "sending" });
    expect(run([{ type: "help_closed" }], help).screen).toEqual({ kind: "form" });
  });

  it("says a help request was sent only once the server has it, and a failed one can be retried", () => {
    const asked = run([...signIn(), { type: "help_requested", reason: { kind: "help" } }]);
    expect(asked.screen).toMatchObject({ kind: "help", from: "consent", status: "sending" });
    expect(run([{ type: "help_sent" }], asked).screen).toMatchObject({ status: "sent" });

    const failed = run([{ type: "help_failed" }], asked);
    expect(failed.screen).toMatchObject({ status: "failed" });
    // Only a request on its way takes an answer.
    expect(run([{ type: "help_sent" }], failed).screen).toMatchObject({ status: "failed" });
    const retried = run([{ type: "help_requested", reason: { kind: "help" } }], failed);
    expect(retried.screen).toEqual({
      kind: "help",
      reason: { kind: "help" },
      from: "consent",
      status: "sending",
    });
    const sent = run([{ type: "help_sent" }], retried);
    expect(run([{ type: "help_requested", reason: { kind: "help" } }], sent).screen).toEqual(
      sent.screen,
    );
  });

  it("shows the thank-you page after Submit", () => {
    const done = run([
      ...signIn(),
      { type: "consent_signed" },
      { type: "continued" },
      { type: "submitted" },
    ]);
    expect(done.screen).toEqual({ kind: "submitted", again: false });
  });

  it("ignores events that don't apply to the current screen", () => {
    expect(run([{ type: "continued" }, { type: "submitted" }]).screen).toEqual({
      kind: "identify",
    });
    expect(run([{ type: "open_failed" }]).screen).toEqual({ kind: "identify" });
  });
});

describe("locked field names", () => {
  it("reads each stored column back as its field, and accepts no other spelling", () => {
    for (const field of ["npi", "dateOfBirth", "ssn"] as const) {
      expect(lockedFieldOfColumn(LOCKED_FIELD_COLUMN[field])).toBe(field);
    }
    expect(lockedFieldOfColumn("date_of_birth")).toBe("dateOfBirth");
    expect(lockedFieldOfColumn("dateOfBirth")).toBeNull();
    expect(isLockedField("dateOfBirth")).toBe(true);
    expect(isLockedField("date_of_birth")).toBe(false);
  });
});
