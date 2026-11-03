import { describe, expect, it } from "vitest";
import {
  hireStates,
  hiresInState,
  needsYou,
  newHiresReducer,
  openHelpRequest,
  waitingCounts,
  type InviteInput,
  type NewHiresState,
} from "./newHires";
import { canResend, classifyInvite, deriveStage } from "./providerOnboarding";
import { HIRES, KNOWN_PEOPLE, PRACTICE } from "@/services/providerOnboardingFixtures";

const NOW = "2026-10-19T14:15:00Z";
const CHARLOTTE = PRACTICE.groups[0];
const CONCORD = PRACTICE.groups[1];

function start(): NewHiresState {
  return structuredClone({ hires: HIRES, people: KNOWN_PEOPLE });
}

function hire(state: NewHiresState, providerId: string) {
  const found = state.hires.find((h) => h.providerId === providerId);
  if (!found) throw new Error(`no hire ${providerId}`);
  return found;
}

function input(overrides: Partial<InviteInput>): InviteInput {
  return {
    firstName: "Nora",
    lastName: "Quinn",
    email: "nora.quinn@example.test",
    npi: "",
    groupName: CHARLOTTE,
    startDate: null,
    ...overrides,
  };
}

function plusMinutes(iso: string, minutes: number): Date {
  return new Date(Date.parse(iso) + minutes * 60 * 1000);
}

describe("resend", () => {
  it("holds Resend off for 10 minutes and opens it again at exactly 10", () => {
    const state = newHiresReducer(start(), {
      type: "resend",
      providerId: "fx-marcus-bell",
      at: NOW,
    });
    const events = hire(state, "fx-marcus-bell").events;
    expect(events.at(-1)).toEqual({ type: "invitation_resent", at: NOW });
    expect(canResend(events, plusMinutes(NOW, 9.99))).toBe(false);
    expect(canResend(events, plusMinutes(NOW, 10))).toBe(true);
  });

  it("does nothing inside the cooldown or once she has submitted", () => {
    const once = newHiresReducer(start(), {
      type: "resend",
      providerId: "fx-marcus-bell",
      at: NOW,
    });
    expect(hire(once, "fx-marcus-bell").events.at(-1)?.type).toBe("invitation_resent");
    const twice = newHiresReducer(once, {
      type: "resend",
      providerId: "fx-marcus-bell",
      at: plusMinutes(NOW, 5).toISOString(),
    });
    expect(hire(twice, "fx-marcus-bell").events).toEqual(hire(once, "fx-marcus-bell").events);

    const lena = newHiresReducer(start(), { type: "resend", providerId: "fx-lena-ortiz", at: NOW });
    expect(hire(lena, "fx-lena-ortiz").events).toEqual(hire(start(), "fx-lena-ortiz").events);
  });
});

describe("mark contacted", () => {
  it("clears Needs you, and a later help request brings it back", () => {
    expect(needsYou(start().hires).map((h) => h.providerId)).toEqual(["fx-jisoo-kim"]);

    const contacted = newHiresReducer(start(), {
      type: "mark_contacted",
      providerId: "fx-jisoo-kim",
      at: NOW,
    });
    expect(needsYou(contacted.hires)).toEqual([]);
    expect(waitingCounts(contacted.hires).practice).toBe(0);

    const askedAgain: NewHiresState = {
      ...contacted,
      hires: contacted.hires.map((h) =>
        h.providerId === "fx-jisoo-kim"
          ? { ...h, events: [...h.events, { type: "help_requested", at: "2026-10-19T15:00:00Z" }] }
          : h,
      ),
    };
    expect(needsYou(askedAgain.hires).map((h) => h.providerId)).toEqual(["fx-jisoo-kim"]);
  });

  it("names the open help request, and none once she is contacted", () => {
    expect(openHelpRequest(hire(start(), "fx-jisoo-kim").events)).toEqual({
      type: "help_requested",
      at: "2026-10-15T09:10:00Z",
    });
    const contacted = newHiresReducer(start(), {
      type: "mark_contacted",
      providerId: "fx-jisoo-kim",
      at: NOW,
    });
    expect(openHelpRequest(hire(contacted, "fx-jisoo-kim").events)).toBeNull();
  });
});

describe("fix email", () => {
  it("changes the address, resends, and matches her under the new address", () => {
    const state = newHiresReducer(start(), {
      type: "fix_email",
      providerId: "fx-anita-rao",
      email: "anita.rao@example.org",
      at: NOW,
    });
    const anita = hire(state, "fx-anita-rao");
    expect(anita.invitedEmail).toBe("anita.rao@example.org");
    expect(anita.events.at(-1)).toEqual({ type: "invitation_resent", at: NOW });
    expect(
      classifyInvite(
        { email: "anita.rao@example.org", npi: "", groupName: CHARLOTTE },
        state.people,
      ).kind,
    ).toBe("already_onboarding");
    expect(
      classifyInvite(
        { email: "anita.rao@example.test", npi: "", groupName: CHARLOTTE },
        state.people,
      ).kind,
    ).toBe("new");
  });
});

describe("set start date", () => {
  it("records the date the practice adds", () => {
    const state = newHiresReducer(start(), {
      type: "set_start_date",
      providerId: "fx-jisoo-kim",
      startDate: "2026-11-24",
    });
    expect(hire(state, "fx-jisoo-kim").startDate).toBe("2026-11-24");
  });
});

describe("cancel", () => {
  it("removes the row and the counts with it", () => {
    const state = newHiresReducer(start(), { type: "cancel", providerId: "fx-anita-rao" });
    expect(state.hires.map((h) => h.providerId)).not.toContain("fx-anita-rao");
    expect(state.hires).toHaveLength(HIRES.length - 1);
    expect(waitingCounts(state.hires).provider).toBe(1);
  });

  it("removes the record too, so inviting the same person again is a new invite", () => {
    const state = newHiresReducer(start(), { type: "cancel", providerId: "fx-anita-rao" });
    expect(state.people.map((p) => p.email)).not.toContain("anita.rao@example.test");
    expect(
      classifyInvite(
        { email: "anita.rao@example.test", npi: "", groupName: CHARLOTTE },
        state.people,
      ).kind,
    ).toBe("new");
  });

  it("does not cancel someone who has already submitted", () => {
    const state = newHiresReducer(start(), { type: "cancel", providerId: "fx-lena-ortiz" });
    expect(state.hires).toHaveLength(HIRES.length);
  });
});

describe("invite", () => {
  it("adds a new person as Invited, and a second invite finds her onboarding", () => {
    const state = newHiresReducer(start(), {
      type: "invite",
      providerId: "new-1",
      at: NOW,
      input: input({ startDate: "2026-11-17" }),
    });
    const nora = hire(state, "new-1");
    expect(nora).toMatchObject({
      displayName: "Nora Quinn",
      invitedEmail: "nora.quinn@example.test",
      groupName: CHARLOTTE,
      startDate: "2026-11-17",
      events: [{ type: "invited", at: NOW }],
    });
    expect(deriveStage(nora.events)).toBe("invited");
    expect(classifyInvite({ ...input({}), npi: "" }, state.people).kind).toBe("already_onboarding");
  });

  it("resends to someone already onboarding instead of adding a row", () => {
    const state = newHiresReducer(start(), {
      type: "invite",
      providerId: "unused",
      at: NOW,
      input: input({ email: "marcus.bell@example.test" }),
    });
    expect(state.hires).toHaveLength(HIRES.length);
    expect(hire(state, "fx-marcus-bell").events.at(-1)).toEqual({
      type: "invitation_resent",
      at: NOW,
    });
  });

  it("sends an active provider the form as a new Invited row", () => {
    const state = newHiresReducer(start(), {
      type: "invite",
      providerId: "re-priya",
      at: NOW,
      input: input({ email: "priya.shah@example.test" }),
    });
    expect(hire(state, "re-priya")).toMatchObject({
      displayName: "Priya Shah, PT",
      invitedEmail: "priya.shah@example.test",
      events: [{ type: "invited", at: NOW }],
    });
    expect(
      classifyInvite({ ...input({ email: "priya.shah@example.test" }) }, state.people).kind,
    ).toBe("already_onboarding");
  });

  it("adds the group to someone on file in another group, with no row and no email", () => {
    const state = newHiresReducer(start(), {
      type: "invite",
      providerId: "unused",
      at: NOW,
      input: input({ email: "dev.patel@example.test", groupName: CHARLOTTE }),
    });
    expect(state.hires).toEqual(start().hires);
    const dev = state.people.find((p) => p.email === "dev.patel@example.test");
    expect(dev?.groupNames).toEqual([CONCORD, CHARLOTTE]);
  });

  it("changes nothing for someone who already submitted, or for a conflict", () => {
    const submitted = newHiresReducer(start(), {
      type: "invite",
      providerId: "unused",
      at: NOW,
      input: input({ email: "lena.ortiz@example.test" }),
    });
    expect(submitted).toEqual(start());

    const conflict = newHiresReducer(start(), {
      type: "invite",
      providerId: "unused",
      at: NOW,
      input: input({ email: "marcus.bell@example.test", npi: "1730195835" }),
    });
    expect(conflict).toEqual(start());
  });
});

describe("headline counts", () => {
  it("match the sample: 1 waiting on you, 2 with the clinician, 2 with Minted", () => {
    expect(waitingCounts(start().hires)).toEqual({ practice: 1, provider: 2, minted: 2 });
  });

  it("sum to the rows shown, for every state filter", () => {
    const state = newHiresReducer(start(), {
      type: "invite",
      providerId: "new-1",
      at: NOW,
      input: input({}),
    });
    for (const filter of [null, ...hireStates(state.hires)]) {
      const rows = hiresInState(state.hires, filter);
      const counts = waitingCounts(rows);
      expect(counts.practice + counts.provider + counts.minted).toBe(rows.length);
    }
  });

  it("narrow to the chosen state", () => {
    expect(hireStates(start().hires)).toEqual(["NC", "SC"]);
    const sc = hiresInState(start().hires, "SC");
    expect(sc.map((h) => h.providerId)).toEqual(["fx-owen-park"]);
    expect(waitingCounts(sc)).toEqual({ practice: 0, provider: 0, minted: 1 });
    expect(needsYou(sc)).toEqual([]);
  });
});
