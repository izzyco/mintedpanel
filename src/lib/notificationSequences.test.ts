import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOUNCE_ESCALATION_OFF,
  COORDINATORS_ONLY_NOTE,
  DEFAULT_NOTIFICATION_POLICY_RULES,
  IANA_TIME_ZONE_PATTERN,
  LAST_RESORT_TIME_ZONE,
  NOTIFICATION_LIMITS,
  PURPOSE_RULES,
  addCcRecipient,
  addStep,
  bounceCcNote,
  bounceEscalationRecipients,
  bounceStepNote,
  buildSavePayload,
  ccRecipientLabel,
  defaultStepsCcNote,
  describeCcList,
  describeDigestSchedule,
  describeOffsets,
  describeSendTime,
  describeStep,
  draftBounceEscalationStep,
  draftFromSequence,
  draftsEqual,
  enabledStatusNote,
  isBounceEscalationStep,
  isDigestFrequency,
  isIanaTimeZone,
  moveCcRecipient,
  moveStep,
  parseCcRecipients,
  parseRecipientKey,
  reconcileWithServer,
  removeCcRecipient,
  removeStep,
  resolveNotificationPolicyRules,
  resolveNotificationSequence,
  resolveSendTime,
  saveErrorMessage,
  scheduleSequenceSends,
  starterDraft,
  stepMoveFocusTarget,
  stepsFromDefault,
  toggleStopCondition,
  updateStep,
  validateDraft,
  validateNotificationPolicyRules,
  validateSendTime,
  type NotificationSequenceConfig,
  type NotificationSequenceDefaultConfig,
  type SequenceDraft,
  type StepDraft,
} from "./notificationSequences";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const STRANGER = "99999999-9999-4999-8999-999999999999";
const ALL_STOPS = ["submitted", "paused", "withdrawn", "provider_replied"] as const;

/** Minted's seeded intake default (migration 20261031051500). */
const INTAKE_DEFAULT: NotificationSequenceDefaultConfig = {
  purpose: "intake_reminder",
  stopConditions: [...ALL_STOPS],
  targetDaysToReady: 14,
  bounceEscalationStep: 1,
  digestCcAllowed: null,
  digestFrequency: null,
  digestWeekday: null,
  sendHour: null,
  sendTimeZone: null,
  secondSendHour: null,
  createdAt: "",
  updatedAt: "",
  steps: [
    ["intake_reminder_final", 3, 3],
    ["intake_reminder_first", 1, 1],
    ["intake_reminder_second", 2, 2],
  ].map(([templateKey, offsetDays, position]) => ({
    id: `d${position}`,
    purpose: "intake_reminder" as const,
    position: position as number,
    offsetDays: offsetDays as number,
    channel: "email" as const,
    templateKey: templateKey as string,
    createdAt: "",
    updatedAt: "",
  })),
};

/** Minted's seeded digest default. */
const DIGEST_DEFAULT: NotificationSequenceDefaultConfig = {
  purpose: "followup_digest",
  stopConditions: null,
  targetDaysToReady: null,
  bounceEscalationStep: null,
  digestCcAllowed: false,
  digestFrequency: "daily",
  digestWeekday: 1,
  sendHour: 8,
  sendTimeZone: "America/Chicago",
  secondSendHour: 14,
  createdAt: "",
  updatedAt: "",
  steps: [
    {
      id: "dd1",
      purpose: "followup_digest",
      position: 1,
      offsetDays: 0,
      channel: "email",
      templateKey: "followup_digest_daily",
      createdAt: "",
      updatedAt: "",
    },
  ],
};

type OwnStepsDraft = SequenceDraft & { steps: StepDraft[] };

/** An intake draft with its own steps (Minted's, customized) and its own settings. */
function intake(): OwnStepsDraft {
  return {
    stopConditions: [...ALL_STOPS],
    targetDaysToReady: 14,
    bounceEscalationStep: null,
    digestFrequency: null,
    steps: stepsFromDefault(INTAKE_DEFAULT),
  };
}

/** A digest draft with its own single step. */
function digest(): OwnStepsDraft {
  return {
    stopConditions: null,
    targetDaysToReady: null,
    bounceEscalationStep: null,
    digestFrequency: null,
    steps: stepsFromDefault(DIGEST_DEFAULT),
  };
}

/** The steps of a draft that has its own. */
function own(draft: SequenceDraft): StepDraft[] {
  if (!draft.steps) throw new Error("expected the draft's own steps");
  return draft.steps;
}

function messages(issues: ReturnType<typeof validateDraft>): string[] {
  return issues.map((issue) => issue.message);
}

function orgRow(over: Partial<NotificationSequenceConfig> = {}): NotificationSequenceConfig {
  return {
    id: "seq-1",
    orgId: "org-1",
    purpose: "intake_reminder",
    enabled: true,
    stopConditions: null,
    targetDaysToReady: null,
    bounceEscalationStep: null,
    digestFrequency: null,
    sendHour: null,
    sendTimeZone: null,
    secondSendHour: null,
    digestWeekday: null,
    digestCcAllowed: null,
    revision: 1,
    createdAt: "",
    updatedAt: "",
    updatedBy: null,
    steps: [],
    ...over,
  };
}

function orgStep(
  position: number,
  offsetDays: number,
  over: Partial<NotificationSequenceConfig["steps"][number]> = {},
) {
  return {
    id: `s${position}`,
    sequenceId: "seq-1",
    orgId: "org-1",
    position,
    offsetDays,
    channel: "email" as const,
    templateKey: "intake_reminder_first",
    ccRecipients: [],
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("starter and Minted's default steps", () => {
  it("starts with every setting left to Minted's default, and no on/off (A9)", () => {
    expect(starterDraft()).toEqual({
      stopConditions: null,
      targetDaysToReady: null,
      bounceEscalationStep: null,
      digestFrequency: null,
      steps: null,
    });
    expect(validateDraft("intake_reminder", starterDraft())).toEqual([]);
    expect(validateDraft("followup_digest", starterDraft())).toEqual([]);
  });

  it("customizes from Minted's default steps in position order, cc'ing no one", () => {
    const steps = stepsFromDefault(INTAKE_DEFAULT);
    expect(steps.map((s) => [s.offsetDays, s.templateKey])).toEqual([
      [1, "intake_reminder_first"],
      [2, "intake_reminder_second"],
      [3, "intake_reminder_final"],
    ]);
    expect(steps.every((s) => s.channel === "email" && s.ccRecipients.length === 0)).toBe(true);
    expect(validateDraft("intake_reminder", intake())).toEqual([]);
    expect(validateDraft("followup_digest", digest())).toEqual([]);
  });

  it("returns a fresh copy each time, so editing one draft never edits the default", () => {
    const a = intake();
    a.steps[0].ccRecipients.push({ kind: "role", role: "admin" });
    expect(intake().steps[0].ccRecipients).toEqual([]);
    expect(stepsFromDefault(INTAKE_DEFAULT)[0].ccRecipients).toEqual([]);
  });
});

describe("validateDraft: offsets", () => {
  it("requires offsets to strictly increase with position", () => {
    const draft = updateStep(intake(), 1, { offsetDays: 1 });
    expect(messages(validateDraft("intake_reminder", draft))).toEqual([
      "Step 2 must go out after step 1 (later than day 1).",
    ]);
  });

  it("rejects a blank, fractional, too-early or too-late offset", () => {
    expect(
      messages(validateDraft("intake_reminder", updateStep(intake(), 0, { offsetDays: null }))),
    ).toEqual(["Enter a whole number of days for step 1."]);
    expect(
      messages(validateDraft("intake_reminder", updateStep(intake(), 0, { offsetDays: 1.5 }))),
    ).toEqual(["Enter a whole number of days for step 1."]);
    expect(
      messages(validateDraft("intake_reminder", updateStep(intake(), 0, { offsetDays: 0 }))),
    ).toEqual(["Step 1 must be between day 1 and day 90."]);
    expect(
      messages(validateDraft("intake_reminder", updateStep(intake(), 2, { offsetDays: 91 }))),
    ).toEqual(["Step 3 must be between day 1 and day 90."]);
  });

  it("fixes the digest offset at 0", () => {
    const draft = updateStep(digest(), 0, { offsetDays: 1 });
    expect(messages(validateDraft("followup_digest", draft))).toEqual([
      "The daily digest is sent on day 0.",
    ]);
  });
});

describe("validateDraft: steps", () => {
  it("allows the digest exactly one step, and own steps are never empty", () => {
    const two: SequenceDraft = { ...digest(), steps: [...digest().steps, digest().steps[0]] };
    expect(messages(validateDraft("followup_digest", two))).toContain(
      "The daily digest has exactly one step.",
    );
    const none: SequenceDraft = { ...digest(), steps: [] };
    expect(messages(validateDraft("followup_digest", none))).toEqual([
      "Add at least one step, or use Minted's default steps.",
    ]);
  });

  it("caps intake at 10 steps", () => {
    const steps: StepDraft[] = Array.from({ length: 11 }, (_, i) => ({
      offsetDays: i + 1,
      channel: "email",
      templateKey: "intake_reminder_first",
      ccRecipients: [],
    }));
    expect(messages(validateDraft("intake_reminder", { ...intake(), steps }))).toEqual([
      "A sequence can have at most 10 steps.",
    ]);
  });

  it("requires a message from this purpose's selectable catalog", () => {
    expect(
      messages(
        validateDraft(
          "intake_reminder",
          updateStep(intake(), 0, { templateKey: "followup_digest_daily" }),
        ),
      ),
    ).toEqual(["Choose a message for step 1."]);
    // The bounce notice is a system message, never a step's own.
    expect(
      messages(
        validateDraft(
          "intake_reminder",
          updateStep(intake(), 0, { templateKey: "intake_reminder_bounce_notice" }),
        ),
      ),
    ).toEqual(["Choose a message for step 1."]);
  });

  it("checks the channel exists and the message has a body for it", () => {
    expect(
      messages(validateDraft("intake_reminder", updateStep(intake(), 0, { channel: "sms" }))),
    ).toEqual([]);
    expect(
      messages(
        validateDraft(
          "intake_reminder",
          updateStep(intake(), 0, { channel: "fax" as unknown as StepDraft["channel"] }),
        ),
      ),
    ).toContain("Choose a channel for step 1.");
    expect(
      messages(validateDraft("followup_digest", updateStep(digest(), 0, { channel: "sms" }))),
    ).toEqual(['"Follow-up digest" has no text message version.']);
  });
});

describe("validateDraft: cc recipients", () => {
  const withCc = (ccRecipients: StepDraft["ccRecipients"]) =>
    updateStep(intake(), 0, { ccRecipients });

  it("accepts an ordered mix of members and roles", () => {
    const draft = withCc([
      { kind: "user", userId: USER_A },
      { kind: "role", role: "admin" },
    ]);
    expect(validateDraft("intake_reminder", draft, { memberUserIds: new Set([USER_A]) })).toEqual(
      [],
    );
  });

  it("rejects duplicates, unknown roles, bad ids, non-members and more than 20", () => {
    expect(
      messages(
        validateDraft(
          "intake_reminder",
          withCc([
            { kind: "role", role: "admin" },
            { kind: "role", role: "admin" },
          ]),
        ),
      ),
    ).toEqual(["Step 1 lists the same member or role twice."]);
    expect(
      messages(
        validateDraft(
          "intake_reminder",
          withCc([{ kind: "role", role: "owner" as unknown as "admin" }]),
        ),
      ),
    ).toEqual(["Step 1 names a role that does not exist."]);
    expect(
      messages(validateDraft("intake_reminder", withCc([{ kind: "user", userId: "nope" }]))),
    ).toEqual(["Step 1 names a member that does not exist."]);
    expect(
      messages(
        validateDraft("intake_reminder", withCc([{ kind: "user", userId: STRANGER }]), {
          memberUserIds: new Set([USER_A]),
        }),
      ),
    ).toEqual(["Step 1 cc's someone who is no longer a member. Remove them to save."]);
    const many = Array.from({ length: 21 }, (_, i) => ({
      kind: "user" as const,
      userId: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    }));
    expect(messages(validateDraft("intake_reminder", withCc(many)))).toEqual([
      "Step 1 can cc at most 20 members or roles.",
    ]);
  });

  it("refuses any cc on the digest, which goes to coordinators only (answer 2)", () => {
    const draft = updateStep(digest(), 0, { ccRecipients: [{ kind: "role", role: "admin" }] });
    expect(messages(validateDraft("followup_digest", draft))).toEqual([
      "The daily digest goes to coordinators only, so it has no cc list.",
    ]);
    expect(() => buildSavePayload("followup_digest", draft, null)).toThrow(/coordinators only/);
  });
});

describe("validateDraft: intake settings", () => {
  it("bounds an overridden target and validates overridden stop conditions", () => {
    expect(
      messages(validateDraft("intake_reminder", { ...intake(), targetDaysToReady: 0 })),
    ).toEqual(["Enter a target between 1 and 90 days, or leave it blank for Minted's default."]);
    expect(
      messages(validateDraft("intake_reminder", { ...intake(), targetDaysToReady: 2.5 })),
    ).toEqual(["Enter a target between 1 and 90 days, or leave it blank for Minted's default."]);
    expect(
      messages(
        validateDraft("intake_reminder", {
          ...intake(),
          stopConditions: ["submitted", "submitted"],
        }),
      ),
    ).toEqual(["Choose stop conditions from the list."]);
    expect(
      messages(
        validateDraft("intake_reminder", {
          ...intake(),
          stopConditions: ["bounced" as unknown as "submitted"],
        }),
      ),
    ).toEqual(["Choose stop conditions from the list."]);
    // Each condition is optional, "submitted" included (answer 1), but at
    // least one is required (A11).
    expect(messages(validateDraft("intake_reminder", { ...intake(), stopConditions: [] }))).toEqual(
      ["Choose at least one stop condition, or use Minted's default."],
    );
    expect(
      validateDraft("intake_reminder", { ...intake(), stopConditions: ["withdrawn"] }),
    ).toEqual([]);
    expect(
      validateDraft("intake_reminder", {
        ...intake(),
        stopConditions: ["paused", "withdrawn", "provider_replied"],
      }),
    ).toEqual([]);
  });

  it("accepts leaving the target and stop conditions to Minted's default", () => {
    expect(
      validateDraft("intake_reminder", {
        ...intake(),
        targetDaysToReady: null,
        stopConditions: null,
      }),
    ).toEqual([]);
  });

  it("refuses intake-only settings on the digest", () => {
    expect(
      messages(
        validateDraft("followup_digest", {
          ...digest(),
          stopConditions: [],
          targetDaysToReady: 14,
        }),
      ),
    ).toEqual(["The daily digest has no stop conditions.", "The daily digest has no target."]);
  });
});

describe("reorder", () => {
  it("moves a step's message and keeps the offsets in place", () => {
    const draft = updateStep(intake(), 2, {
      channel: "sms",
      ccRecipients: [{ kind: "role", role: "admin" }],
    });
    const moved = own(moveStep(draft, 2, -1));
    expect(moved.map((s) => s.offsetDays)).toEqual([1, 2, 3]);
    expect(moved.map((s) => s.templateKey)).toEqual([
      "intake_reminder_first",
      "intake_reminder_final",
      "intake_reminder_second",
    ]);
    expect(moved[1]).toMatchObject({
      channel: "sms",
      ccRecipients: [{ kind: "role", role: "admin" }],
    });
    expect(validateDraft("intake_reminder", { ...intake(), steps: moved })).toEqual([]);
  });

  it("is a no-op past either end, on inherited steps, and never mutates its input", () => {
    const draft = intake();
    const snapshot = JSON.stringify(draft);
    expect(moveStep(draft, 0, -1)).toBe(draft);
    expect(moveStep(draft, 2, 1)).toBe(draft);
    moveStep(draft, 0, 1);
    expect(JSON.stringify(draft)).toBe(snapshot);
    const inherited = starterDraft();
    expect(moveStep(inherited, 0, 1)).toBe(inherited);
    expect(updateStep(inherited, 0, { offsetDays: 3 })).toBe(inherited);
    expect(addStep("intake_reminder", inherited)).toBe(inherited);
  });

  it("orders cc recipients: add appends, duplicates are ignored, move swaps, remove drops", () => {
    let step = intake().steps[0];
    step = addCcRecipient(step, { kind: "user", userId: USER_A });
    step = addCcRecipient(step, { kind: "role", role: "specialist" });
    step = addCcRecipient(step, { kind: "user", userId: USER_A });
    expect(step.ccRecipients).toEqual([
      { kind: "user", userId: USER_A },
      { kind: "role", role: "specialist" },
    ]);
    step = moveCcRecipient(step, 1, -1);
    expect(step.ccRecipients[0]).toEqual({ kind: "role", role: "specialist" });
    expect(moveCcRecipient(step, 1, 1)).toBe(step);
    step = removeCcRecipient(step, 0);
    expect(step.ccRecipients).toEqual([{ kind: "user", userId: USER_A }]);
  });

  it("adds a step three days after the last with the next unused message, up to the cap", () => {
    const removed = removeStep(intake(), 2);
    const added = own(addStep("intake_reminder", removed));
    // The last kept step is on day 2.
    expect(added.at(-1)).toEqual({
      offsetDays: 5,
      channel: "email",
      templateKey: "intake_reminder_final",
      ccRecipients: [],
    });
    const single = digest();
    expect(addStep("followup_digest", single)).toBe(single);
  });

  it("keeps the last own step: going back to Minted's steps is the way to drop them", () => {
    const one: SequenceDraft = { ...intake(), steps: [intake().steps[0]] };
    expect(removeStep(one, 0)).toBe(one);
  });
});

describe("stop conditions over Minted's default", () => {
  it("starts an override from the default set when the draft inherits", () => {
    const off = toggleStopCondition(starterDraft(), INTAKE_DEFAULT, "submitted", false);
    expect(off.stopConditions).toEqual(["paused", "withdrawn", "provider_replied"]);
    const back = toggleStopCondition(off, INTAKE_DEFAULT, "submitted", true);
    expect(back.stopConditions).toEqual([...ALL_STOPS]);
    // Equal to the default is still the org's own choice until it goes back.
    expect(back.stopConditions).not.toBeNull();
  });
});

describe("payload building", () => {
  it("builds the RPC payload in snake_case, in position order, cc order kept", () => {
    const draft = updateStep(intake(), 2, {
      ccRecipients: [
        { kind: "user", userId: USER_B },
        { kind: "role", role: "admin" },
      ],
    });
    expect(
      buildSavePayload("intake_reminder", draft, 3, { memberUserIds: new Set([USER_B]) }),
    ).toEqual({
      stop_conditions: [...ALL_STOPS],
      target_days_to_ready: 14,
      expected_revision: 3,
      steps: [
        {
          offset_days: 1,
          channel: "email",
          template_key: "intake_reminder_first",
          cc_recipients: [],
        },
        {
          offset_days: 2,
          channel: "email",
          template_key: "intake_reminder_second",
          cc_recipients: [],
        },
        {
          offset_days: 3,
          channel: "email",
          template_key: "intake_reminder_final",
          cc_recipients: [
            { kind: "user", user_id: USER_B },
            { kind: "role", role: "admin" },
          ],
        },
      ],
    });
  });

  it("sends null for every setting left to Minted's default, steps included", () => {
    expect(buildSavePayload("intake_reminder", starterDraft(), 4)).toEqual({
      stop_conditions: null,
      target_days_to_ready: null,
      expected_revision: 4,
      steps: null,
    });
  });

  it("never carries a platform-managed setting, on/off included (A9)", () => {
    for (const payload of [
      buildSavePayload("intake_reminder", intake(), null),
      buildSavePayload("intake_reminder", starterDraft(), null),
      buildSavePayload("followup_digest", digest(), null),
    ]) {
      expect(Object.keys(payload).sort()).toEqual([
        "expected_revision",
        "steps",
        "stop_conditions",
        "target_days_to_ready",
      ]);
    }
  });

  it("orders stop conditions canonically and sends null revision for a new row", () => {
    const draft = {
      ...intake(),
      stopConditions: ["provider_replied" as const, "submitted" as const],
    };
    const payload = buildSavePayload("intake_reminder", draft, null);
    expect(payload.stop_conditions).toEqual(["submitted", "provider_replied"]);
    expect(payload.expected_revision).toBeNull();
    // An empty list is refused (A11), never sent.
    expect(() =>
      buildSavePayload("intake_reminder", { ...intake(), stopConditions: [] }, null),
    ).toThrow(/at least one stop condition/);
  });

  it("sends no intake settings and no cc for the digest", () => {
    expect(buildSavePayload("followup_digest", digest(), null)).toEqual({
      stop_conditions: null,
      target_days_to_ready: null,
      expected_revision: null,
      steps: [
        {
          offset_days: 0,
          channel: "email",
          template_key: "followup_digest_daily",
          cc_recipients: [],
        },
      ],
    });
    expect(buildSavePayload("followup_digest", starterDraft(), 2)).toEqual({
      stop_conditions: null,
      target_days_to_ready: null,
      expected_revision: 2,
      steps: null,
    });
  });

  it("refuses to build a payload from an invalid draft", () => {
    expect(() =>
      buildSavePayload("intake_reminder", updateStep(intake(), 1, { offsetDays: 1 }), null),
    ).toThrow(/Invalid notification sequence/);
  });
});

describe("round trip", () => {
  it("drafts a saved config in position order and parses cc jsonb defensively", () => {
    const config = orgRow({
      stopConditions: ["submitted"],
      targetDaysToReady: 10,
      sendHour: null,
      revision: 2,
      updatedBy: USER_A,
      steps: [
        orgStep(2, 5, {
          channel: "sms",
          templateKey: "intake_reminder_second",
          ccRecipients: [{ kind: "role", role: "billing" }],
        }),
        orgStep(1, 1),
      ],
    });
    const draft = draftFromSequence(config);
    expect(own(draft).map((s) => s.offsetDays)).toEqual([1, 5]);
    expect(draft.stopConditions).toEqual(["submitted"]);
    expect(draft.targetDaysToReady).toBe(10);
    // The platform-managed settings (on/off included) are not in the draft:
    // the card cannot send them. The bounce step and the digest frequency
    // are the org's own, so they are.
    expect(Object.keys(draft).sort()).toEqual([
      "bounceEscalationStep",
      "digestFrequency",
      "steps",
      "stopConditions",
      "targetDaysToReady",
    ]);
    expect(draftsEqual(draft, draftFromSequence(config))).toBe(true);
    expect(draftsEqual(draft, updateStep(draft, 0, { offsetDays: 2 }))).toBe(false);

    expect(
      parseCcRecipients([
        { kind: "user", user_id: USER_A },
        { kind: "role", role: "admin" },
        { kind: "role", role: "owner" },
        { kind: "team", id: 1 },
        "admin",
      ]),
    ).toEqual([
      { kind: "user", userId: USER_A },
      { kind: "role", role: "admin" },
    ]);
    expect(parseCcRecipients(null)).toEqual([]);
  });

  it("drafts an org row with no own steps or settings as inheriting them", () => {
    const draft = draftFromSequence(orgRow());
    expect(draft).toEqual(starterDraft());
    expect(draftsEqual(draftFromSequence(orgRow({ enabled: false })), starterDraft())).toBe(true);
  });

  it("parses the cc picker's encoded choices", () => {
    expect(parseRecipientKey("role:billing")).toEqual({ kind: "role", role: "billing" });
    expect(parseRecipientKey(`user:${USER_A}`)).toEqual({ kind: "user", userId: USER_A });
    expect(parseRecipientKey("role:owner")).toBeNull();
    expect(parseRecipientKey("user:not-a-uuid")).toBeNull();
    expect(parseRecipientKey("nonsense")).toBeNull();
  });
});

describe("resolveNotificationSequence (answer 3: org row over Minted's default)", () => {
  it("gives an org with no row Minted's default, switched off", () => {
    const effective = resolveNotificationSequence("intake_reminder", undefined, INTAKE_DEFAULT);
    expect(effective).toEqual({
      purpose: "intake_reminder",
      enabled: false,
      steps: [
        {
          position: 1,
          offsetDays: 1,
          channel: "email",
          templateKey: "intake_reminder_first",
          ccRecipients: [],
        },
        {
          position: 2,
          offsetDays: 2,
          channel: "email",
          templateKey: "intake_reminder_second",
          ccRecipients: [],
        },
        {
          position: 3,
          offsetDays: 3,
          channel: "email",
          templateKey: "intake_reminder_final",
          ccRecipients: [],
        },
      ],
      stopConditions: [...ALL_STOPS],
      targetDaysToReady: 14,
      bounceEscalationStep: 1,
      ccAllowed: true,
      digestFrequency: null,
      digestWeekday: null,
      sendHour: null,
      sendTimeZone: null,
      secondSendHour: null,
      inherited: {
        steps: true,
        stopConditions: true,
        targetDaysToReady: true,
        bounceEscalationStep: true,
        digestCcAllowed: false,
        digestFrequency: false,
        digestWeekday: false,
        sendTime: false,
      },
    });
  });

  it("never inherits enabled: a default cannot switch an org on", () => {
    // Even a default carrying a stray enabled flag (it has no such column).
    const loud = { ...INTAKE_DEFAULT, enabled: true } as NotificationSequenceDefaultConfig;
    expect(resolveNotificationSequence("intake_reminder", undefined, loud).enabled).toBe(false);
    expect(
      resolveNotificationSequence("intake_reminder", orgRow({ enabled: false }), loud).enabled,
    ).toBe(false);
    expect(resolveNotificationSequence("intake_reminder", orgRow(), INTAKE_DEFAULT).enabled).toBe(
      true,
    );
  });

  it("inherits field by field: only what the org set is its own", () => {
    const effective = resolveNotificationSequence(
      "intake_reminder",
      orgRow({ targetDaysToReady: 21 }),
      INTAKE_DEFAULT,
    );
    expect(effective.targetDaysToReady).toBe(21);
    expect(effective.inherited.targetDaysToReady).toBe(false);
    expect(effective.stopConditions).toEqual([...ALL_STOPS]);
    expect(effective.inherited.stopConditions).toBe(true);
    expect(effective.steps.map((s) => s.offsetDays)).toEqual([1, 2, 3]);
    expect(effective.inherited.steps).toBe(true);
  });

  it("treats an empty stop list as the org's own choice, not as unset", () => {
    const effective = resolveNotificationSequence(
      "intake_reminder",
      orgRow({ stopConditions: [] }),
      INTAKE_DEFAULT,
    );
    expect(effective.stopConditions).toEqual([]);
    expect(effective.inherited.stopConditions).toBe(false);
  });

  it("uses the org's own steps, cc lists and order, when it has any", () => {
    const effective = resolveNotificationSequence(
      "intake_reminder",
      orgRow({
        steps: [
          orgStep(2, 9, { templateKey: "intake_reminder_final" }),
          orgStep(1, 3, { ccRecipients: [{ kind: "user", userId: USER_A }] }),
        ],
      }),
      INTAKE_DEFAULT,
    );
    expect(effective.inherited.steps).toBe(false);
    expect(effective.steps.map((s) => [s.position, s.offsetDays, s.templateKey])).toEqual([
      [1, 3, "intake_reminder_first"],
      [2, 9, "intake_reminder_final"],
    ]);
    expect(effective.steps[0].ccRecipients).toEqual([{ kind: "user", userId: USER_A }]);
  });

  it("has no compression at all (A13, supersedes D56)", () => {
    const effective = resolveNotificationSequence("intake_reminder", orgRow(), INTAKE_DEFAULT);
    expect("compressTowardStartDate" in effective).toBe(false);
    expect(Object.keys(effective.inherited)).not.toContain("compressTowardStartDate");
  });

  it("gives the digest 8 am Central from Minted, an org's send time whole, and no cc (A10)", () => {
    const inherited = resolveNotificationSequence("followup_digest", undefined, DIGEST_DEFAULT);
    expect(inherited).toMatchObject({
      sendHour: 8,
      sendTimeZone: "America/Chicago",
      secondSendHour: 14,
      digestFrequency: "daily",
      digestWeekday: 1,
      stopConditions: [],
      targetDaysToReady: null,
      inherited: { sendTime: true, digestFrequency: true, stopConditions: false },
    });
    const own = resolveNotificationSequence(
      "followup_digest",
      orgRow({
        purpose: "followup_digest",
        sendHour: 6,
        sendTimeZone: "America/New_York",
        secondSendHour: 15,
      }),
      DIGEST_DEFAULT,
    );
    expect([own.sendHour, own.sendTimeZone, own.secondSendHour]).toEqual([
      6,
      "America/New_York",
      15,
    ]);
    expect(own.inherited.sendTime).toBe(false);
    // A layer that sets one without the others is not a send time: Minted's
    // whole group applies (no separate inheritance).
    for (const partial of [
      { sendTimeZone: "America/New_York" },
      { sendHour: 6 },
      { sendHour: 6, sendTimeZone: "America/New_York" },
    ]) {
      const effective = resolveNotificationSequence(
        "followup_digest",
        orgRow({ purpose: "followup_digest", ...partial }),
        DIGEST_DEFAULT,
      );
      expect([effective.sendHour, effective.sendTimeZone, effective.secondSendHour]).toEqual([
        8,
        "America/Chicago",
        14,
      ]);
      expect(effective.inherited.sendTime).toBe(true);
    }
    // A digest step is never passed on with a cc, whatever the row says.
    const leaky = resolveNotificationSequence(
      "followup_digest",
      orgRow({
        purpose: "followup_digest",
        steps: [
          orgStep(1, 0, {
            templateKey: "followup_digest_daily",
            ccRecipients: [{ kind: "role", role: "admin" }],
          }),
        ],
      }),
      DIGEST_DEFAULT,
    );
    expect(leaky.steps[0].ccRecipients).toEqual([]);
  });

  it("falls back to Minted's whole send time when the org's zone cannot be used", () => {
    for (const zone of ["Gone/Zone", "Mars/Olympus_Mons", "america/chicago", "CST", ""]) {
      const effective = resolveNotificationSequence(
        "followup_digest",
        orgRow({ purpose: "followup_digest", sendHour: 6, sendTimeZone: zone, secondSendHour: 9 }),
        DIGEST_DEFAULT,
      );
      expect([effective.sendHour, effective.sendTimeZone, effective.secondSendHour]).toEqual([
        8,
        "America/Chicago",
        14,
      ]);
      expect(effective.inherited.sendTime).toBe(true);
      expect(describeSendTime(effective.sendHour, effective.sendTimeZone)).toBe(
        "8 am Central time",
      );
    }
    // A second hour not after the first makes the org group unusable too.
    const backwards = resolveNotificationSequence(
      "followup_digest",
      orgRow({
        purpose: "followup_digest",
        sendHour: 15,
        sendTimeZone: "Europe/Paris",
        secondSendHour: 9,
      }),
      DIGEST_DEFAULT,
    );
    expect([backwards.sendHour, backwards.inherited.sendTime]).toEqual([8, true]);
  });

  it("falls back to the last-resort zone when Minted's default zone cannot be used either", () => {
    expect(LAST_RESORT_TIME_ZONE).toBe("America/Chicago");
    const broken = { ...DIGEST_DEFAULT, sendTimeZone: "Gone/Zone" };
    for (const org of [undefined, orgRow({ purpose: "followup_digest" })]) {
      const effective = resolveNotificationSequence("followup_digest", org, broken);
      expect([effective.sendHour, effective.sendTimeZone, effective.secondSendHour]).toEqual([
        8,
        LAST_RESORT_TIME_ZONE,
        14,
      ]);
      expect(effective.inherited.sendTime).toBe(true);
    }
    // A complete, usable org group still wins over a broken default.
    expect(
      resolveNotificationSequence(
        "followup_digest",
        orgRow({
          purpose: "followup_digest",
          sendHour: 7,
          sendTimeZone: "America/Denver",
          secondSendHour: 12,
        }),
        broken,
      ).sendTimeZone,
    ).toBe("America/Denver");
  });

  it("gives intake no send time", () => {
    const effective = resolveNotificationSequence(
      "intake_reminder",
      orgRow({ sendHour: 6, sendTimeZone: "America/New_York" }),
      INTAKE_DEFAULT,
    );
    expect([effective.sendHour, effective.sendTimeZone]).toEqual([null, null]);
  });

  it("refuses rows for another purpose", () => {
    expect(() => resolveNotificationSequence("followup_digest", undefined, INTAKE_DEFAULT)).toThrow(
      RangeError,
    );
    expect(() =>
      resolveNotificationSequence(
        "intake_reminder",
        orgRow({ purpose: "followup_digest" }),
        INTAKE_DEFAULT,
      ),
    ).toThrow(RangeError);
  });

  it("feeds the schedule: Minted's default steps go out on days 1, 2 and 3", () => {
    const effective = resolveNotificationSequence("intake_reminder", orgRow(), INTAKE_DEFAULT);
    const result = scheduleSequenceSends({
      offsets: effective.steps.map((s) => s.offsetDays),
      inviteDate: "2026-11-02",
      targetDaysToReady: effective.targetDaysToReady ?? 0,
    });
    expect(result.sends.map((s) => s.offsetDays)).toEqual([1, 2, 3]);
  });

  it("feeds the bounce rule: Minted's default steps escalate to no one", () => {
    const effective = resolveNotificationSequence("intake_reminder", undefined, INTAKE_DEFAULT);
    expect(bounceEscalationRecipients(effective, 1)).toEqual([]);
  });
});

describe("purpose rules", () => {
  it("gives the digest no cc list, no editable steps and a send time; intake the opposite", () => {
    expect(PURPOSE_RULES.followup_digest).toMatchObject({
      hasCcList: false,
      stepsEditable: false,
      hasSendTime: true,
      hasIntakeSettings: false,
    });
    expect(PURPOSE_RULES.intake_reminder).toMatchObject({
      hasCcList: true,
      stepsEditable: true,
      hasSendTime: false,
      hasIntakeSettings: true,
    });
  });
});

describe("send time (answer 5)", () => {
  it("reads 8 in America/Chicago as 8 am Central time", () => {
    expect(describeSendTime(8, "America/Chicago")).toBe("8 am Central time");
    expect(describeSendTime(0, "America/New_York")).toBe("12 am Eastern time");
    expect(describeSendTime(12, "America/Denver")).toBe("12 pm Mountain time");
    expect(describeSendTime(17, "America/Los_Angeles")).toBe("5 pm Pacific time");
  });

  it("names other zones from Intl, and never shows a zone it cannot use", () => {
    expect(describeSendTime(9, "Europe/Paris")).toMatch(/^9 am .*European time$/);
    for (const zone of ["Mars/Olympus_Mons", "Gone/Zone", "america/chicago", "CST", ""]) {
      expect(describeSendTime(9, zone)).toBeNull();
    }
  });

  it("says nothing when the hour or zone is missing or out of range", () => {
    expect(describeSendTime(null, "America/Chicago")).toBeNull();
    expect(describeSendTime(8, null)).toBeNull();
    expect(describeSendTime(24, "America/Chicago")).toBeNull();
    expect(describeSendTime(7.5, "America/Chicago")).toBeNull();
  });

  it("accepts IANA zone names only, with the database's pattern", () => {
    for (const zone of ["America/Chicago", "America/Argentina/Buenos_Aires", "Etc/UTC", "UTC"]) {
      expect(isIanaTimeZone(zone)).toBe(true);
    }
    for (const zone of ["CST", "EST5EDT", "+05:00", "america/chicago", "Mars/Olympus_Mons", ""]) {
      expect(isIanaTimeZone(zone)).toBe(false);
    }
    const migration = readFileSync(
      "supabase/migrations/20261031051500_notification_sequences.sql",
      "utf8",
    );
    expect(migration).toContain(`p_zone ~ '${IANA_TIME_ZONE_PATTERN.source.replace("\\/", "/")}'`);
  });
});

describe("read-only step lines", () => {
  it("describes intake steps by day and the digest as daily", () => {
    expect(
      describeStep("intake_reminder", {
        position: 1,
        offsetDays: 2,
        channel: "email",
        templateKey: "intake_reminder_first",
      }),
    ).toBe("Step 1 · day 2 after the invite · Email · First reminder");
    expect(
      describeStep("followup_digest", {
        position: 1,
        offsetDays: 0,
        channel: "email",
        templateKey: "followup_digest_daily",
      }),
    ).toBe("Step 1 · once a day · Email · Follow-up digest");
    const digestStep = {
      position: 1,
      offsetDays: 0,
      channel: "email" as const,
      templateKey: "followup_digest_daily",
    };
    expect(describeStep("followup_digest", digestStep, "weekly")).toBe(
      "Step 1 · once a week · Email · Follow-up digest",
    );
    expect(describeStep("followup_digest", digestStep, "twice_daily")).toBe(
      "Step 1 · twice a day · Email · Follow-up digest",
    );
  });
});

describe("bounce rule (decision 4)", () => {
  const steps = [
    { position: 1, ccRecipients: [{ kind: "user" as const, userId: USER_A }] },
    { position: 2, ccRecipients: [{ kind: "role" as const, role: "admin" as const }] },
  ];
  const intakeAt = (bounceEscalationStep: number | null) => ({
    purpose: "intake_reminder" as const,
    bounceEscalationStep,
    steps,
  });

  it("escalates a step-1 intake bounce to step 1's cc list, in order", () => {
    expect(bounceEscalationRecipients(intakeAt(1), 1)).toEqual([{ kind: "user", userId: USER_A }]);
  });

  it("does not escalate a later bounce, or any digest bounce", () => {
    expect(bounceEscalationRecipients(intakeAt(1), 2)).toEqual([]);
    expect(
      bounceEscalationRecipients({ purpose: "followup_digest", bounceEscalationStep: 1, steps }, 1),
    ).toEqual([]);
  });

  it("reaches no one when step 1 cc's no one", () => {
    expect(
      bounceEscalationRecipients({ ...intakeAt(1), steps: [{ position: 1, ccRecipients: [] }] }, 1),
    ).toEqual([]);
  });
});

describe("scheduleSequenceSends (no compression: A13)", () => {
  it("sends each step on its offset after the invite, and is ready by the target", () => {
    const result = scheduleSequenceSends({
      offsets: [2, 4, 7],
      inviteDate: "2026-11-02",
      targetDaysToReady: 14,
    });
    expect(result.sends.map((send) => send.sendOn)).toEqual([
      "2026-11-04",
      "2026-11-06",
      "2026-11-09",
    ]);
    expect(result.sends.map((send) => send.position)).toEqual([1, 2, 3]);
    expect(result.readyBy).toBe("2026-11-16");
    expect(Object.keys(result).sort()).toEqual(["readyBy", "sends"]);
  });

  it("refuses an invite-day step (A12), out-of-order offsets, a bad target or date", () => {
    const base = { offsets: [1, 2, 3], inviteDate: "2026-11-02", targetDaysToReady: 14 };
    expect(() => scheduleSequenceSends({ ...base, offsets: [0, 2] })).toThrow(/day 1 or later/);
    expect(() => scheduleSequenceSends({ ...base, offsets: [2, 2] })).toThrow(/strictly increase/);
    expect(() => scheduleSequenceSends({ ...base, targetDaysToReady: 0 })).toThrow(RangeError);
    expect(() => scheduleSequenceSends({ ...base, inviteDate: "2026-02-30" })).toThrow(RangeError);
  });
});

describe("copy helpers", () => {
  it("describes offsets for the card's summary line", () => {
    expect(describeOffsets([2, 4, 7])).toBe("day 2, day 4 and day 7");
    expect(describeOffsets([1, 2, 3])).toBe("day 1, day 2 and day 3");
    expect(describeOffsets([0])).toBe("day 0");
    expect(describeOffsets([])).toBe("");
  });

  it("maps the RPC's RAISE codes to plain messages", () => {
    expect(saveErrorMessage("notification_sequence_conflict")).toMatch(/Someone else saved/);
    expect(saveErrorMessage("x notification_sequence_not_authorized y")).toBe(
      "Only admins can change notifications.",
    );
    expect(saveErrorMessage("notification_digest_has_no_cc")).toBe(
      "The daily digest goes to coordinators only, so it can't cc anyone.",
    );
    expect(saveErrorMessage("notification_platform_setting: send_hour")).toBe(
      "Minted sets that setting, so it can't be changed here.",
    );
    expect(saveErrorMessage("something else")).toMatch(/Couldn't save/);
  });

  it("mirrors the database bounds, and keeps no copy of Minted's default values", () => {
    expect(NOTIFICATION_LIMITS).toEqual({
      maxOffsetDays: 90,
      maxSteps: 10,
      maxCcRecipients: 20,
      minTargetDays: 1,
      maxTargetDays: 90,
    });
  });
});

describe("concurrent editors (reconcileWithServer)", () => {
  const config = (revision: number, offsets: number[]): NotificationSequenceConfig =>
    orgRow({
      enabled: false,
      stopConditions: ["submitted"],
      targetDaysToReady: 14,
      revision,
      steps: offsets.map((offsetDays, i) => orgStep(i + 1, offsetDays)),
    });
  const v1 = config(1, [2, 4]);
  const v2 = config(2, [3, 6]);

  it("is in sync while the server has the revision the draft started from", () => {
    expect(
      reconcileWithServer({
        base: v1,
        saved: v1,
        draft: draftFromSequence(v1),
        ownSavedRevision: null,
      }),
    ).toBe("in_sync");
    expect(
      reconcileWithServer({
        base: undefined,
        saved: undefined,
        draft: null,
        ownSavedRevision: null,
      }),
    ).toBe("in_sync");
  });

  it("follows the server when nothing unsaved would be lost", () => {
    // An untouched draft.
    expect(
      reconcileWithServer({
        base: v1,
        saved: v2,
        draft: draftFromSequence(v1),
        ownSavedRevision: null,
      }),
    ).toBe("adopt_server");
    // No draft open (the Set up button).
    expect(
      reconcileWithServer({ base: undefined, saved: v2, draft: null, ownSavedRevision: null }),
    ).toBe("adopt_server");
    // The edits already equal what the server now has.
    expect(
      reconcileWithServer({
        base: v1,
        saved: v2,
        draft: draftFromSequence(v2),
        ownSavedRevision: null,
      }),
    ).toBe("adopt_server");
    // This editor's own save.
    const edited = updateStep(draftFromSequence(v1), 0, { offsetDays: 1 });
    expect(reconcileWithServer({ base: v1, saved: v2, draft: edited, ownSavedRevision: 2 })).toBe(
      "adopt_server",
    );
  });

  it("keeps unsaved edits when another admin saved, including over a starter", () => {
    const edited = updateStep(draftFromSequence(v1), 0, { offsetDays: 1 });
    expect(
      reconcileWithServer({ base: v1, saved: v2, draft: edited, ownSavedRevision: null }),
    ).toBe("keep_draft");
    expect(reconcileWithServer({ base: v1, saved: v2, draft: edited, ownSavedRevision: 1 })).toBe(
      "keep_draft",
    );
    expect(
      reconcileWithServer({
        base: undefined,
        saved: v2,
        draft: { ...starterDraft(), targetDaysToReady: 20 },
        ownSavedRevision: null,
      }),
    ).toBe("keep_draft");
  });
});

describe("step move focus", () => {
  it("keeps the same arrow so a second press continues the move", () => {
    expect(stepMoveFocusTarget(1, -1, 3)).toBe("up");
    expect(stepMoveFocusTarget(1, 1, 3)).toBe("down");
  });

  it("switches to the other arrow at the top or bottom, where the same one is disabled", () => {
    expect(stepMoveFocusTarget(0, -1, 3)).toBe("down");
    expect(stepMoveFocusTarget(2, 1, 3)).toBe("up");
  });
});

describe("cc labels while the member list loads", () => {
  const members = new Map([[USER_A, { userId: USER_A, name: "Jane Doe" }]]);

  it("says Former member only when the list has loaded", () => {
    expect(ccRecipientLabel({ kind: "user", userId: STRANGER }, members)).toBe("Former member");
    expect(ccRecipientLabel({ kind: "user", userId: STRANGER }, members, false)).toBe("Member");
    expect(ccRecipientLabel({ kind: "user", userId: USER_A }, members, false)).toBe("Jane Doe");
    expect(ccRecipientLabel({ kind: "role", role: "billing" }, members, false)).toBe(
      "All billing members",
    );
    expect(
      describeCcList(
        [
          { kind: "user", userId: STRANGER },
          { kind: "role", role: "admin" },
        ],
        members,
        false,
      ),
    ).toBe("Member, then All admins");
  });

  it("does not block a save on membership until the list has loaded", () => {
    const draft = updateStep(intake(), 0, {
      ccRecipients: [{ kind: "user", userId: STRANGER }],
    });
    expect(validateDraft("intake_reminder", draft)).toEqual([]);
    expect(
      validateDraft("intake_reminder", draft, { memberUserIds: new Set([USER_A]) }).map(
        (issue) => issue.field,
      ),
    ).toEqual(["ccRecipients"]);
  });
});

describe("conflict status", () => {
  it("treats SQLSTATE PT409 as the revision conflict whatever its text", () => {
    expect(saveErrorMessage("", "PT409")).toMatch(/Someone else saved/);
    expect(saveErrorMessage("anything", "PT409")).toMatch(/Someone else saved/);
    expect(saveErrorMessage("anything", "23514")).toMatch(/Couldn't save/);
  });
});

/* ------------- Policy settings (policy as configuration, MINT-113) ------------- */

const CC_A = [{ kind: "user" as const, userId: USER_A }];
const CC_ADMINS = [{ kind: "role" as const, role: "admin" as const }];

/** An intake org row with its own three steps, each cc'ing someone. */
function intakeWithCc(over: Partial<NotificationSequenceConfig> = {}) {
  return orgRow({
    steps: [
      orgStep(1, 2, { ccRecipients: CC_A }),
      orgStep(2, 4, { templateKey: "intake_reminder_second", ccRecipients: CC_ADMINS }),
      orgStep(3, 7, { templateKey: "intake_reminder_final", ccRecipients: [] }),
    ],
    ...over,
  });
}

/** A digest org row whose one step cc's all admins. */
function digestWithCc() {
  return orgRow({
    purpose: "followup_digest",
    steps: [orgStep(1, 0, { templateKey: "followup_digest_daily", ccRecipients: CC_ADMINS })],
  });
}

describe("notification policy rules: decided defaults", () => {
  it("are the Oct 30 bounce rule and D59's coordinators-only digest, frozen", () => {
    expect(DEFAULT_NOTIFICATION_POLICY_RULES).toEqual({
      bounceEscalationStep: 1,
      digestCcAllowed: false,
      digestFrequency: "daily",
      digestWeekday: 1,
    });
    expect(Object.isFrozen(DEFAULT_NOTIFICATION_POLICY_RULES)).toBe(true);
    expect(BOUNCE_ESCALATION_OFF).toBe(0);
  });

  it("match the seeded defaults in the migration", () => {
    const migration = readFileSync(
      "supabase/migrations/20261031051500_notification_sequences.sql",
      "utf8",
    );
    expect(migration).toMatch(
      /\(purpose, stop_conditions, target_days_to_ready, bounce_escalation_step\)[\s\S]*?14, 1\)/,
    );
    expect(migration).toMatch(
      /\(purpose, send_hour, send_time_zone, second_send_hour, digest_frequency, digest_weekday,\s+digest_cc_allowed\)\s+VALUES \('followup_digest', 8, 'America\/Chicago', 14, 'daily', 1, false\)/,
    );
  });

  it("accept a bounce step of 0 (off) to the most steps a sequence has, whole numbers only", () => {
    for (const ok of [0, 1, 2, NOTIFICATION_LIMITS.maxSteps]) {
      expect(isBounceEscalationStep(ok)).toBe(true);
    }
    for (const bad of [-1, NOTIFICATION_LIMITS.maxSteps + 1, 1.5, "1", null, undefined, true]) {
      expect(isBounceEscalationStep(bad)).toBe(false);
    }
  });
});

describe("resolveNotificationPolicyRules: org over platform over default, field by field", () => {
  it("gives the decided defaults with no layers", () => {
    expect(resolveNotificationPolicyRules()).toEqual(DEFAULT_NOTIFICATION_POLICY_RULES);
    expect(resolveNotificationPolicyRules(null, null)).toEqual(DEFAULT_NOTIFICATION_POLICY_RULES);
  });

  it("takes the platform over the default, and the org over the platform", () => {
    expect(
      resolveNotificationPolicyRules({ bounceEscalationStep: 2, digestCcAllowed: true }),
    ).toEqual({
      ...DEFAULT_NOTIFICATION_POLICY_RULES,
      bounceEscalationStep: 2,
      digestCcAllowed: true,
    });
    expect(
      resolveNotificationPolicyRules({ bounceEscalationStep: 2 }, { bounceEscalationStep: 3 }),
    ).toEqual({ ...DEFAULT_NOTIFICATION_POLICY_RULES, bounceEscalationStep: 3 });
    expect(
      resolveNotificationPolicyRules({ bounceEscalationStep: 2 }, { bounceEscalationStep: 0 }),
    ).toMatchObject({ bounceEscalationStep: BOUNCE_ESCALATION_OFF });
  });

  it("inherits on null or undefined, field by field", () => {
    expect(
      resolveNotificationPolicyRules(
        { bounceEscalationStep: 2, digestCcAllowed: null },
        { bounceEscalationStep: null },
      ),
    ).toEqual({ ...DEFAULT_NOTIFICATION_POLICY_RULES, bounceEscalationStep: 2 });
    expect(resolveNotificationPolicyRules({ bounceEscalationStep: undefined }, {})).toEqual(
      DEFAULT_NOTIFICATION_POLICY_RULES,
    );
  });

  it("skips a value of the wrong shape like a missing one", () => {
    const junk = { bounceEscalationStep: 11, digestCcAllowed: "yes" } as never;
    expect(resolveNotificationPolicyRules(junk)).toEqual(DEFAULT_NOTIFICATION_POLICY_RULES);
    expect(
      resolveNotificationPolicyRules({ bounceEscalationStep: 2 }, {
        bounceEscalationStep: 1.5,
      } as never),
    ).toMatchObject({ bounceEscalationStep: 2 });
  });

  it("takes an org's digest cc override (which only Minted writes) over the default (S7)", () => {
    expect(resolveNotificationPolicyRules(null, { digestCcAllowed: true })).toMatchObject({
      digestCcAllowed: true,
    });
    expect(
      resolveNotificationPolicyRules({ digestCcAllowed: true }, { digestCcAllowed: false }),
    ).toMatchObject({ digestCcAllowed: false });
    expect(
      resolveNotificationPolicyRules({ digestCcAllowed: true }, { digestCcAllowed: null }),
    ).toMatchObject({ digestCcAllowed: true });
  });
});

describe("validateNotificationPolicyRules", () => {
  it("passes valid layers, and null as inherit", () => {
    expect(
      validateNotificationPolicyRules({ bounceEscalationStep: 1, digestCcAllowed: false }),
    ).toEqual([]);
    expect(validateNotificationPolicyRules({ bounceEscalationStep: 0 })).toEqual([]);
    expect(
      validateNotificationPolicyRules({ bounceEscalationStep: null, digestCcAllowed: null }),
    ).toEqual([]);
    expect(validateNotificationPolicyRules({ bounceEscalationStep: 3 }, "org_admin")).toEqual([]);
  });

  it("names every invalid or unknown value in plain language", () => {
    expect(validateNotificationPolicyRules({ bounceEscalationStep: 11 })).toEqual([
      "The bounce escalation step must be a step from 1 to 10, or 0 for no escalation.",
    ]);
    expect(validateNotificationPolicyRules({ bounceEscalationStep: "1" })).toHaveLength(1);
    expect(validateNotificationPolicyRules({ digestCcAllowed: "yes" })).toEqual([
      "Whether the digest may cc anyone must be on or off.",
    ]);
    expect(validateNotificationPolicyRules({ ccEveryone: true })).toEqual([
      '"ccEveryone" is not a notification policy setting.',
    ]);
    expect(validateNotificationPolicyRules(null)).toEqual([
      "The notification policy settings must be a set of named values.",
    ]);
    expect(validateNotificationPolicyRules([1])).toHaveLength(1);
  });

  it("refuses digestCcAllowed from an org admin; Minted may set it as a default or org override", () => {
    expect(validateNotificationPolicyRules({ digestCcAllowed: true }, "org_admin")).toEqual([
      "Only Minted decides whether the digest may cc anyone.",
    ]);
    expect(validateNotificationPolicyRules({ digestCcAllowed: true }, "platform_admin")).toEqual(
      [],
    );
    expect(validateNotificationPolicyRules({ digestCcAllowed: false })).toEqual([]);
  });
});

describe("bounce escalation step (Oct 30 decision, now a setting)", () => {
  it("defaults to step 1 from Minted's default, marked inherited", () => {
    const effective = resolveNotificationSequence(
      "intake_reminder",
      intakeWithCc(),
      INTAKE_DEFAULT,
    );
    expect(effective.bounceEscalationStep).toBe(1);
    expect(effective.inherited.bounceEscalationStep).toBe(true);
    expect(bounceEscalationRecipients(effective, 1)).toEqual(CC_A);
    expect(bounceEscalationRecipients(effective, 2)).toEqual([]);
  });

  it("takes the org's own step: a step-2 bounce escalates to step 2's cc list only", () => {
    const effective = resolveNotificationSequence(
      "intake_reminder",
      intakeWithCc({ bounceEscalationStep: 2 }),
      INTAKE_DEFAULT,
    );
    expect([effective.bounceEscalationStep, effective.inherited.bounceEscalationStep]).toEqual([
      2,
      false,
    ]);
    expect(bounceEscalationRecipients(effective, 2)).toEqual(CC_ADMINS);
    expect(bounceEscalationRecipients(effective, 1)).toEqual([]);
    expect(bounceEscalationRecipients(effective, 3)).toEqual([]);
  });

  it("escalates nothing when switched off (0)", () => {
    const effective = resolveNotificationSequence(
      "intake_reminder",
      intakeWithCc({ bounceEscalationStep: BOUNCE_ESCALATION_OFF }),
      INTAKE_DEFAULT,
    );
    expect(effective.bounceEscalationStep).toBe(0);
    expect(effective.inherited.bounceEscalationStep).toBe(false);
    for (const position of [0, 1, 2, 3]) {
      expect(bounceEscalationRecipients(effective, position)).toEqual([]);
    }
  });

  it("follows a changed Minted default when the org has none of its own", () => {
    const effective = resolveNotificationSequence("intake_reminder", intakeWithCc(), {
      ...INTAKE_DEFAULT,
      bounceEscalationStep: 2,
    });
    expect(bounceEscalationRecipients(effective, 2)).toEqual(CC_ADMINS);
    expect(effective.inherited.bounceEscalationStep).toBe(true);
  });

  it("escalates to no one when the step does not exist in the sequence", () => {
    const effective = resolveNotificationSequence(
      "intake_reminder",
      orgRow({ bounceEscalationStep: 5, steps: [orgStep(1, 2, { ccRecipients: CC_A })] }),
      INTAKE_DEFAULT,
    );
    expect(effective.bounceEscalationStep).toBe(5);
    expect(bounceEscalationRecipients(effective, 5)).toEqual([]);
  });

  it("ignores a stored value of the wrong shape, and a default missing one, for the decided step 1", () => {
    const junk = resolveNotificationSequence(
      "intake_reminder",
      intakeWithCc({ bounceEscalationStep: 11 }),
      INTAKE_DEFAULT,
    );
    expect([junk.bounceEscalationStep, junk.inherited.bounceEscalationStep]).toEqual([1, true]);
    const bare = resolveNotificationSequence("intake_reminder", intakeWithCc(), {
      ...INTAKE_DEFAULT,
      bounceEscalationStep: null,
    });
    expect(bare.bounceEscalationStep).toBe(DEFAULT_NOTIFICATION_POLICY_RULES.bounceEscalationStep);
  });

  it("gives the digest no bounce rule at all", () => {
    const effective = resolveNotificationSequence(
      "followup_digest",
      orgRow({ purpose: "followup_digest", bounceEscalationStep: 1 }),
      DIGEST_DEFAULT,
    );
    expect(effective.bounceEscalationStep).toBeNull();
    expect(effective.inherited.bounceEscalationStep).toBe(false);
  });

  it("is what a draft would save: its own, else Minted's, else step 1", () => {
    expect(draftBounceEscalationStep(starterDraft(), INTAKE_DEFAULT)).toBe(1);
    expect(draftBounceEscalationStep(starterDraft(), { bounceEscalationStep: 3 })).toBe(3);
    expect(draftBounceEscalationStep({ bounceEscalationStep: 0 }, INTAKE_DEFAULT)).toBe(0);
    expect(draftBounceEscalationStep(starterDraft(), { bounceEscalationStep: null })).toBe(1);
  });

  it("round-trips through the draft and the payload, sent only when the org set it", () => {
    const draft = draftFromSequence(intakeWithCc({ bounceEscalationStep: 2 }));
    expect(draft.bounceEscalationStep).toBe(2);
    expect(buildSavePayload("intake_reminder", draft, 1)).toMatchObject({
      bounce_escalation_step: 2,
    });
    const off = { ...draft, bounceEscalationStep: BOUNCE_ESCALATION_OFF };
    expect(buildSavePayload("intake_reminder", off, 1)).toMatchObject({
      bounce_escalation_step: 0,
    });
    // Left to Minted's default, the key is not sent (the RPC reads it as null).
    const inheriting = buildSavePayload("intake_reminder", intake(), null);
    expect("bounce_escalation_step" in inheriting).toBe(false);
    // A changed step is an edit; the same step is not.
    expect(draftsEqual(draft, off)).toBe(false);
    expect(draftsEqual(draft, draftFromSequence(intakeWithCc({ bounceEscalationStep: 2 })))).toBe(
      true,
    );
  });

  it("validates the draft's step, and refuses one on the digest", () => {
    expect(
      messages(validateDraft("intake_reminder", { ...intake(), bounceEscalationStep: 11 })),
    ).toEqual([
      "Choose which step's bounce is escalated (step 1 to 10), turn it off, or use Minted's default.",
    ]);
    expect(validateDraft("intake_reminder", { ...intake(), bounceEscalationStep: 0 })).toEqual([]);
    expect(
      messages(validateDraft("followup_digest", { ...digest(), bounceEscalationStep: 1 })),
    ).toEqual(["The daily digest has no bounce rule."]);
    expect(() =>
      buildSavePayload("followup_digest", { ...digest(), bounceEscalationStep: 1 }, null),
    ).toThrow(/no bounce rule/);
  });

  it("builds the card's notes from the step, unchanged at the default", () => {
    expect(bounceCcNote(1)).toBe(
      "If step 1 bounces, the people cc'd here are told. Add a member or a role so a bounce reaches someone.",
    );
    expect(bounceCcNote(3)).toMatch(/^If step 3 bounces,/);
    expect(defaultStepsCcNote(1)).toBe(
      "Minted's default steps cc no one, so a bounce on step 1 reaches no one. Customize the steps to cc a member or a role.",
    );
    expect(defaultStepsCcNote(2)).toContain("a bounce on step 2 reaches no one");
    expect(defaultStepsCcNote(BOUNCE_ESCALATION_OFF)).toBe(
      "Minted's default steps cc no one. Customize the steps to cc a member or a role.",
    );
  });
});

describe("digest audience (D59, now Minted's setting digest_cc_allowed)", () => {
  it("strips a digest cc and says coordinators only by default", () => {
    const effective = resolveNotificationSequence(
      "followup_digest",
      digestWithCc(),
      DIGEST_DEFAULT,
    );
    expect(effective.ccAllowed).toBe(false);
    expect(effective.steps[0].ccRecipients).toEqual([]);
    expect(COORDINATORS_ONLY_NOTE).toBe("Goes to each coordinator only. No one is cc'd.");
  });

  it("passes the digest's cc list on once Minted allows it", () => {
    const allowed = { ...DIGEST_DEFAULT, digestCcAllowed: true };
    const effective = resolveNotificationSequence("followup_digest", digestWithCc(), allowed);
    expect(effective.ccAllowed).toBe(true);
    expect(effective.steps[0].ccRecipients).toEqual(CC_ADMINS);
  });

  it("treats a missing or malformed setting as the decided off", () => {
    for (const digestCcAllowed of [null, "true" as never]) {
      const effective = resolveNotificationSequence("followup_digest", digestWithCc(), {
        ...DIGEST_DEFAULT,
        digestCcAllowed,
      });
      expect([effective.ccAllowed, effective.steps[0].ccRecipients]).toEqual([false, []]);
    }
  });

  it("always lets intake steps cc, whatever the digest setting", () => {
    const effective = resolveNotificationSequence("intake_reminder", intakeWithCc(), {
      ...INTAKE_DEFAULT,
      digestCcAllowed: false,
    });
    expect(effective.ccAllowed).toBe(true);
    expect(effective.steps[0].ccRecipients).toEqual(CC_A);
  });

  it("validates and builds a digest cc only when the caller says Minted allows it", () => {
    const withCc = updateStep(digest(), 0, { ccRecipients: CC_ADMINS });
    expect(messages(validateDraft("followup_digest", withCc))).toEqual([
      "The daily digest goes to coordinators only, so it has no cc list.",
    ]);
    expect(validateDraft("followup_digest", withCc, { digestCcAllowed: false })).toHaveLength(1);
    expect(validateDraft("followup_digest", withCc, { digestCcAllowed: true })).toEqual([]);
    expect(
      buildSavePayload("followup_digest", withCc, null, { digestCcAllowed: true }).steps?.[0]
        .cc_recipients,
    ).toEqual([{ kind: "role", role: "admin" }]);
  });
});

describe("digest audience per org (S7: platform default, org override, platform admin)", () => {
  const digestRow = (digestCcAllowed: boolean | null) => ({
    ...digestWithCc(),
    digestCcAllowed,
  });

  it("follows the org's override over Minted's default, both ways", () => {
    const on = resolveNotificationSequence("followup_digest", digestRow(true), DIGEST_DEFAULT);
    expect([on.ccAllowed, on.inherited.digestCcAllowed]).toEqual([true, false]);
    expect(on.steps[0].ccRecipients).toEqual(CC_ADMINS);
    const off = resolveNotificationSequence("followup_digest", digestRow(false), {
      ...DIGEST_DEFAULT,
      digestCcAllowed: true,
    });
    expect([off.ccAllowed, off.inherited.digestCcAllowed]).toEqual([false, false]);
    expect(off.steps[0].ccRecipients).toEqual([]);
  });

  it("inherits Minted's default when the org has no override", () => {
    const inherits = resolveNotificationSequence(
      "followup_digest",
      digestRow(null),
      DIGEST_DEFAULT,
    );
    expect([inherits.ccAllowed, inherits.inherited.digestCcAllowed]).toEqual([false, true]);
    const noRow = resolveNotificationSequence("followup_digest", undefined, {
      ...DIGEST_DEFAULT,
      digestCcAllowed: true,
    });
    expect([noRow.ccAllowed, noRow.inherited.digestCcAllowed]).toEqual([true, true]);
  });

  it("is not in the draft or the payload: an org admin cannot send it", () => {
    const draft = draftFromSequence(digestRow(true));
    expect("digestCcAllowed" in draft).toBe(false);
    expect("digest_cc_allowed" in buildSavePayload("followup_digest", digest(), null)).toBe(false);
  });
});

describe("stale digest cc after the setting goes off (review)", () => {
  it("leaves a digest cc list the setting does not allow out of the draft", () => {
    expect(own(draftFromSequence(digestWithCc()))[0].ccRecipients).toEqual([]);
    expect(
      own(draftFromSequence(digestWithCc(), { digestCcAllowed: false }))[0].ccRecipients,
    ).toEqual([]);
    expect(
      own(draftFromSequence(digestWithCc(), { digestCcAllowed: true }))[0].ccRecipients,
    ).toEqual(CC_ADMINS);
    expect(
      own(draftFromSequence({ ...digestWithCc(), digestCcAllowed: true }))[0].ccRecipients,
    ).toEqual(CC_ADMINS);
    // Intake keeps its cc lists whatever the digest setting.
    expect(
      own(draftFromSequence(intakeWithCc(), { digestCcAllowed: false }))[0].ccRecipients,
    ).toEqual(CC_A);
  });

  it("so the draft validates, and the save clears the stale list", () => {
    const draft = { ...draftFromSequence(digestWithCc()), enabled: true };
    expect(validateDraft("followup_digest", draft)).toEqual([]);
    expect(buildSavePayload("followup_digest", draft, 1).steps?.[0].cc_recipients).toEqual([]);
  });

  it("reconciles with the same setting the draft was built with", () => {
    const base = { ...digestWithCc(), revision: 1 };
    const saved = { ...digestWithCc(), revision: 2 };
    expect(
      reconcileWithServer({
        base,
        saved,
        draft: draftFromSequence(base, { digestCcAllowed: false }),
        ownSavedRevision: null,
        digestCcAllowed: false,
      }),
    ).toBe("adopt_server");
  });

  it("notes a bounce step that reaches no one by construction", () => {
    expect(bounceStepNote(1, 3)).toBeNull();
    expect(bounceStepNote(3, 3)).toBeNull();
    expect(bounceStepNote(4, 3)).toBe("Step 4 doesn't exist, so a bounce reaches no one.");
    expect(bounceStepNote(0, 3)).toBe("Bounce escalation is off, so a bounce reaches no one.");
  });
});

describe("draftsEqual", () => {
  it("compares content, not key order, and reads a missing bounce step as unset", () => {
    const a = intake();
    const reordered: SequenceDraft = {
      steps: a.steps,
      bounceEscalationStep: null,
      targetDaysToReady: a.targetDaysToReady,
      stopConditions: a.stopConditions,
      digestFrequency: null,
    };
    expect(draftsEqual(a, reordered)).toBe(true);
    const legacy = { ...a } as Partial<SequenceDraft>;
    delete legacy.bounceEscalationStep;
    expect(draftsEqual(a, legacy as SequenceDraft)).toBe(true);
  });
});

describe("Minted's intake default: days 1, 2 and 3 (Sowmya, Oct 31)", () => {
  const offsets = stepsFromDefault(INTAKE_DEFAULT).map((s) => s.offsetDays as number);

  it("is what the migration seeds", () => {
    const migration = readFileSync(
      "supabase/migrations/20261031051500_notification_sequences.sql",
      "utf8",
    );
    expect(migration).toMatch(
      /\('intake_reminder', 1, 1, 'email', 'intake_reminder_first'\),\s+\('intake_reminder', 2, 2, 'email', 'intake_reminder_second'\),\s+\('intake_reminder', 3, 3, 'email', 'intake_reminder_final'\);/,
    );
    expect(migration).not.toMatch(/\('intake_reminder', 3, 7, 'email'/);
  });

  it("sends on days 1, 2 and 3 after the invite, by email, never on the invite day (A12)", () => {
    expect(offsets).toEqual([1, 2, 3]);
    expect(INTAKE_DEFAULT.steps.every((s) => s.channel === "email")).toBe(true);
    const result = scheduleSequenceSends({
      offsets,
      inviteDate: "2026-11-02",
      targetDaysToReady: 14,
    });
    expect(result.sends.map((s) => s.sendOn)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
    expect(result.readyBy).toBe("2026-11-16");
  });
});

/* ---------------- Addendum 8 (Answered Oct 31, A8 to A13) ---------------- */

describe("digest frequency (A8): daily, weekly or twice a day, per org", () => {
  const digestOrg = (over: Partial<NotificationSequenceConfig> = {}) =>
    orgRow({ purpose: "followup_digest", ...over });

  it("defaults to daily from Minted, and takes the org's own choice", () => {
    expect(
      resolveNotificationSequence("followup_digest", digestOrg(), DIGEST_DEFAULT),
    ).toMatchObject({ digestFrequency: "daily", inherited: { digestFrequency: true } });
    for (const digestFrequency of ["weekly", "twice_daily"] as const) {
      expect(
        resolveNotificationSequence(
          "followup_digest",
          digestOrg({ digestFrequency }),
          DIGEST_DEFAULT,
        ),
      ).toMatchObject({ digestFrequency, inherited: { digestFrequency: false } });
    }
    // A default row read without the column still gives the decided daily.
    expect(
      resolveNotificationSequence("followup_digest", digestOrg(), {
        ...DIGEST_DEFAULT,
        digestFrequency: null,
        digestWeekday: null,
      }),
    ).toMatchObject({ digestFrequency: "daily", digestWeekday: 1 });
    expect(isDigestFrequency("hourly")).toBe(false);
  });

  it("goes weekly on Monday by default, or on Minted's chosen day", () => {
    expect(
      resolveNotificationSequence("followup_digest", digestOrg(), DIGEST_DEFAULT).digestWeekday,
    ).toBe(1);
    expect(
      resolveNotificationSequence(
        "followup_digest",
        digestOrg({ digestWeekday: 5 }),
        DIGEST_DEFAULT,
      ).digestWeekday,
    ).toBe(5);
  });

  it("round-trips the frequency through the draft and the payload, sent only when set", () => {
    const draft = draftFromSequence(digestOrg({ digestFrequency: "weekly" }));
    expect(draft.digestFrequency).toBe("weekly");
    expect(buildSavePayload("followup_digest", draft, 1)).toMatchObject({
      digest_frequency: "weekly",
    });
    expect("digest_frequency" in buildSavePayload("followup_digest", digest(), null)).toBe(false);
  });

  it("refuses an unknown frequency, and any frequency on intake", () => {
    expect(
      messages(
        validateDraft("followup_digest", {
          ...digest(),
          digestFrequency: "hourly" as unknown as "daily",
        }),
      ),
    ).toEqual(["Choose daily, weekly or twice a day, or Minted's default."]);
    expect(
      messages(validateDraft("intake_reminder", { ...intake(), digestFrequency: "weekly" })),
    ).toEqual(["Intake reminders follow their steps, not a frequency."]);
  });

  it("lets an org admin choose the frequency but not the weekday", () => {
    expect(validateNotificationPolicyRules({ digestFrequency: "weekly" }, "org_admin")).toEqual([]);
    expect(validateNotificationPolicyRules({ digestWeekday: 3 }, "org_admin")).toEqual([
      "Only Minted sets the weekly digest's day.",
    ]);
    expect(validateNotificationPolicyRules({ digestWeekday: 8 })).toEqual([
      "The weekly digest's day must be Monday (1) to Sunday (7).",
    ]);
    expect(validateNotificationPolicyRules({ digestFrequency: "hourly" })).toEqual([
      "The digest goes out daily, weekly or twice a day.",
    ]);
  });

  it("describes each schedule from its settings", () => {
    const base = {
      digestWeekday: 1,
      sendHour: 8,
      sendTimeZone: "America/Chicago",
      secondSendHour: 14,
    };
    expect(describeDigestSchedule({ ...base, digestFrequency: "daily" })).toBe(
      "Sent around 8 am Central time. Minted sets this.",
    );
    expect(describeDigestSchedule({ ...base, digestFrequency: null })).toBe(
      "Sent around 8 am Central time. Minted sets this.",
    );
    expect(describeDigestSchedule({ ...base, digestFrequency: "weekly" })).toBe(
      "Sent on Mondays around 8 am Central time. Minted sets the day and time.",
    );
    expect(describeDigestSchedule({ ...base, digestFrequency: "weekly", digestWeekday: 5 })).toBe(
      "Sent on Fridays around 8 am Central time. Minted sets the day and time.",
    );
    expect(describeDigestSchedule({ ...base, digestFrequency: "twice_daily" })).toBe(
      "Sent around 8 am and 2 pm Central time. Minted sets these times.",
    );
    expect(
      describeDigestSchedule({ ...base, sendTimeZone: "Gone/Zone", digestFrequency: null }),
    ).toBeNull();
  });
});

describe("send time is one group per layer (A10)", () => {
  it("takes hour, zone and second hour from the same layer", () => {
    const fallback = { sendHour: 8, sendTimeZone: "America/Chicago", secondSendHour: 14 };
    expect(
      resolveSendTime({ sendHour: 6, sendTimeZone: "Europe/Paris", secondSendHour: 12 }, fallback),
    ).toEqual({ sendHour: 6, sendTimeZone: "Europe/Paris", secondSendHour: 12, inherited: false });
    for (const partial of [
      { sendHour: 6 },
      { sendTimeZone: "Europe/Paris" },
      { sendHour: 6, sendTimeZone: "Europe/Paris" },
      { sendHour: 6, sendTimeZone: "Europe/Paris", secondSendHour: 6 },
    ]) {
      expect(resolveSendTime(partial, fallback)).toEqual({ ...fallback, inherited: true });
    }
    expect(resolveSendTime(undefined, fallback)).toEqual({ ...fallback, inherited: true });
  });

  it("refuses a layer that sets one without the others, in plain language", () => {
    expect(validateSendTime({})).toEqual([]);
    expect(
      validateSendTime({ sendHour: 8, sendTimeZone: "America/Chicago", secondSendHour: 14 }),
    ).toEqual([]);
    expect(validateSendTime({ sendHour: 8 })).toEqual([
      "Set the send hour, the time zone and the second send hour together, or leave all three to Minted's default.",
    ]);
    expect(validateSendTime({ sendTimeZone: "America/Chicago" })).toHaveLength(1);
    expect(
      validateSendTime({ sendHour: 15, sendTimeZone: "America/Chicago", secondSendHour: 9 }),
    ).toEqual(["The second send hour must be later than the first."]);
    expect(validateSendTime({ sendHour: 24, sendTimeZone: "CST", secondSendHour: 25 })).toEqual([
      "The send hour must be a whole hour from 0 to 23.",
      "The time zone must be an IANA zone such as America/Chicago.",
      "The second send hour must be a whole hour from 0 to 23.",
    ]);
  });
});

describe("notifications stay off until Minted turns them on (A9)", () => {
  it("has no on/off in the draft or the payload, and says who switches it", () => {
    expect("enabled" in starterDraft()).toBe(false);
    expect("enabled" in buildSavePayload("intake_reminder", intake(), null)).toBe(false);
    expect(enabledStatusNote(false)).toBe("Off. Minted switches notifications on at kickoff.");
    expect(enabledStatusNote(true)).toBe("On. Minted switched these on for your organization.");
    // The org's row still decides on/off; a default never switches anyone on.
    expect(
      resolveNotificationSequence("intake_reminder", orgRow({ enabled: true }), INTAKE_DEFAULT)
        .enabled,
    ).toBe(true);
  });
});

describe("nothing goes out on the invite day (A12)", () => {
  it("refuses an intake step on day 0, from the card's validation", () => {
    expect(
      messages(validateDraft("intake_reminder", updateStep(intake(), 0, { offsetDays: 0 }))),
    ).toEqual(["Step 1 must be between day 1 and day 90."]);
    expect(PURPOSE_RULES.intake_reminder.minOffsetDays).toBe(1);
  });
});
