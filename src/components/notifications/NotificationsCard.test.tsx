// MINT-107 component tests. The repo has no DOM test environment (no jsdom or
// testing-library), so like every other component test here these render to
// static markup with mocked hooks. The editor and the cc list hold no state
// of their own, so "edit and save" is driven by calling their real handlers
// from the rendered element tree; the full click-through runs in
// e2e/notification-sequences.spec.ts.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  starterDraft,
  stepsFromDefault,
  validateDraft,
  type CcMemberOption,
  type NotificationSequenceConfig,
  type NotificationSequenceDefaultConfig,
  type SequenceDraft,
  type StepDraft,
} from "@/lib/notificationSequences";

/** Minted's seeded defaults (migration 20261101110100). */
const INTAKE_DEFAULT: NotificationSequenceDefaultConfig = {
  purpose: "intake_reminder",
  stopConditions: ["submitted", "paused", "withdrawn", "provider_replied"],
  targetDaysToReady: 14,
  bounceEscalationStep: 1,
  digestCcAllowed: null,
  createdAt: "",
  updatedAt: "",
  steps: [1, 2, 3].map((offsetDays, i) => ({
    id: `d${i + 1}`,
    purpose: "intake_reminder" as const,
    position: i + 1,
    offsetDays,
    channel: "email" as const,
    templateKey: ["intake_reminder_first", "intake_reminder_second", "intake_reminder_final"][i],
    createdAt: "",
    updatedAt: "",
  })),
};
// G2: the digest default is its audience and its one step, no schedule.
const DIGEST_DEFAULT: NotificationSequenceDefaultConfig = {
  purpose: "followup_digest",
  stopConditions: null,
  targetDaysToReady: null,
  bounceEscalationStep: null,
  digestCcAllowed: false,
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

const state = vi.hoisted(() => ({
  isAdmin: true,
  sequences: {} as Record<string, unknown>,
  defaults: {} as Record<string, unknown>,
  unavailable: false,
  isLoading: false,
  isError: false,
  members: [] as unknown[],
  membersLoaded: true,
  mutate: vi.fn(),
}));

vi.mock("@/lib/permissions", () => ({ useIsAdmin: () => state.isAdmin }));
vi.mock("@/hooks/useNotificationSequences", () => ({
  useNotificationSequences: () => ({
    data:
      state.isLoading || state.isError
        ? undefined
        : state.unavailable
          ? { status: "unavailable" }
          : { status: "available", sequences: state.sequences, defaults: state.defaults },
    isLoading: state.isLoading,
    isError: state.isError,
  }),
  useSaveNotificationSequence: () => ({ mutate: state.mutate, isPending: false }),
}));
vi.mock("@/hooks/useOrgSettings", () => ({
  useMemberships: () => ({
    data: state.membersLoaded ? state.members : undefined,
    isSuccess: state.membersLoaded,
  }),
}));

import { NotificationCcRecipients } from "./NotificationCcRecipients";
import {
  NotificationSequenceEditor,
  type NotificationSequenceEditorProps,
} from "./NotificationSequenceEditor";
import { NotificationsCard } from "./NotificationsCard";

const ORG = "66666666-6666-4666-8666-666666666666";
const JANE = "11111111-1111-4111-8111-111111111111";
const NOT_SET_UP = "Not set up. Minted sets up the follow-up digest for your organization.";

/** A digest schedule Minted set up for the org: all five together (A10, G2). */
const MINTED_SET_UP = {
  digestFrequency: "daily" as const,
  digestWeekday: 1,
  sendHour: 8,
  sendTimeZone: "America/Chicago",
  secondSendHour: 14,
};

/** An org's saved intake row with steps of its own on days 2, 4 and 7: the
 *  org's schedule, not Minted's default (days 1, 2 and 3). */
function intakeConfig(over: Partial<NotificationSequenceConfig> = {}): NotificationSequenceConfig {
  return {
    id: "seq-intake",
    orgId: ORG,
    purpose: "intake_reminder",
    enabled: true,
    stopConditions: ["submitted", "withdrawn"],
    targetDaysToReady: 14,
    bounceEscalationStep: null,
    digestFrequency: null,
    sendHour: null,
    sendTimeZone: null,
    secondSendHour: null,
    digestWeekday: null,
    digestCcAllowed: null,
    revision: 2,
    createdAt: "2026-10-30T00:00:00Z",
    updatedAt: "2026-10-30T00:00:00Z",
    updatedBy: JANE,
    steps: [2, 4, 7].map((offsetDays, i) => ({
      id: `step-${i + 1}`,
      sequenceId: "seq-intake",
      orgId: ORG,
      position: i + 1,
      offsetDays,
      channel: "email" as const,
      templateKey: ["intake_reminder_first", "intake_reminder_second", "intake_reminder_final"][i],
      ccRecipients: [],
      createdAt: "",
      updatedAt: "",
    })),
    ...over,
  };
}

type AnyElement = ReactElement<Record<string, unknown>>;

function findAll(node: ReactNode, match: (el: AnyElement) => boolean): AnyElement[] {
  const found: AnyElement[] = [];
  const visit = (n: ReactNode) => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as AnyElement;
    if (match(el)) found.push(el);
    visit(el.props.children as ReactNode);
  };
  visit(node);
  return found;
}

function byLabel(node: ReactNode, label: string): AnyElement {
  const [el] = findAll(node, (e) => e.props["aria-label"] === label);
  if (!el) throw new Error(`No element labelled "${label}"`);
  return el;
}

function byText(node: ReactNode, text: string): AnyElement {
  const [el] = findAll(node, (e) => e.props.children === text);
  if (!el) throw new Error(`No element with text "${text}"`);
  return el;
}

const MEMBERS: ReadonlyMap<string, CcMemberOption> = new Map([
  [JANE, { userId: JANE, name: "Jane Doe" }],
]);

type EditorOverrides = Partial<
  Omit<NotificationSequenceEditorProps, "onChange" | "onSave" | "onCancel">
>;

/** An intake draft with its own steps (Minted's, customized) and settings. */
function ownIntake(): SequenceDraft & { steps: StepDraft[] } {
  return {
    stopConditions: ["submitted", "paused", "withdrawn", "provider_replied"],
    targetDaysToReady: 14,
    bounceEscalationStep: null,
    steps: stepsFromDefault(INTAKE_DEFAULT),
  };
}

function editorProps(over: EditorOverrides = {}) {
  const draft = over.draft ?? ownIntake();
  return {
    purpose: "intake_reminder" as const,
    draft,
    issues: validateDraft("intake_reminder", draft),
    platformDefault: INTAKE_DEFAULT,
    members: MEMBERS,
    isNew: false,
    dirty: false,
    saving: false,
    ...over,
    onChange: vi.fn<(draft: SequenceDraft) => void>(),
    onSave: vi.fn<() => void>(),
    onCancel: vi.fn<() => void>(),
  };
}

beforeEach(() => {
  state.isAdmin = true;
  state.sequences = {};
  state.defaults = { intake_reminder: INTAKE_DEFAULT, followup_digest: DIGEST_DEFAULT };
  state.unavailable = false;
  state.isLoading = false;
  state.isError = false;
  state.membersLoaded = true;
  state.members = [
    {
      id: "m-1",
      orgId: ORG,
      userId: JANE,
      role: "specialist",
      createdAt: "",
      fullName: "Jane Doe",
      email: "jane@example.test",
    },
  ];
  state.mutate = vi.fn();
});

describe("NotificationsCard: admin", () => {
  it("offers intake Set up from Minted's default, says the digest is Minted's to set up, and writes nothing", () => {
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html).toContain("Notifications");
    expect(html).toContain("Provider intake reminders");
    expect(html).toContain("Follow-up digest");
    // G2: only intake has a Set up; the digest exists once Minted sets it up.
    expect(html.match(/>Set up</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Set up provider intake reminders"');
    expect(html).not.toContain("Set up follow-up digest");
    expect(html).toContain(
      "Set up starts you with Minted&#x27;s default: 3 emails, on day 1, day 2 and day 3 after the invite, cc&#x27;ing no one. Minted switches it on at kickoff. You can change any of it before you save.",
    );
    expect(html).toContain(NOT_SET_UP);
    expect(html).not.toContain("one email a day");
    // Two pills and the digest's line.
    expect(html.match(/Not set up/g)).toHaveLength(3);
    expect(html).not.toContain("<input");
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("opens a saved sequence straight into the editor, with Save waiting for a change", () => {
    state.sequences = { intake_reminder: intakeConfig() };
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html).toContain('aria-label="Step 1 days after invite"');
    expect(html).toContain('value="2"');
    expect(html).toContain('value="7"');
    // A9: on/off is Minted's, shown read-only.
    expect(html).toContain("On. Minted switched these on for your organization.");
    expect(html).toContain("Target days from invite to ready");
    expect(html).toContain('value="14"');
    expect(html).toContain("Minted&#x27;s default is 14 days. Clear the box to use it.");
    expect(html).toContain("Stop reminders when");
    // A13: compression is gone; A9: no on/off switch for an org admin.
    expect(html).not.toContain("Near a start date");
    expect(html).not.toContain('role="switch"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    expect(html).toContain("Discard changes");
    expect(html).toContain(">On<");
    // The digest has no row yet: not set up, and nothing for the admin to start.
    expect(html).not.toContain(">Set up<");
    expect(html).toContain(NOT_SET_UP);
  });

  it("shows a clear empty cc state, with the bounce warning on intake step 1 only", () => {
    state.sequences = { intake_reminder: intakeConfig() };
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html.match(/No one is cc&#x27;d on this step\./g)).toHaveLength(3);
    expect(html.match(/If step 1 bounces, the people cc&#x27;d here are told\./g)).toHaveLength(1);
    expect(html.match(/Add a member or a role to copy them on this step\./g)).toHaveLength(2);
    expect(html).toContain('aria-label="Add someone to cc on step 1"');
  });

  it("lists cc'd members and roles in order with keyboard move and remove buttons", () => {
    const config = intakeConfig();
    config.steps[0].ccRecipients = [
      { kind: "user", userId: JANE },
      { kind: "role", role: "admin" },
    ];
    state.sequences = { intake_reminder: config };
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html.indexOf("Jane Doe")).toBeLessThan(html.indexOf("All admins"));
    expect(html).toContain('aria-label="Move Jane Doe down on step 1"');
    expect(html).toContain('aria-label="Remove All admins from step 1"');
    expect(html).toMatch(/<button[^>]*aria-label="Move Jane Doe up on step 1"[^>]*disabled=""/);
  });

  it("names the SMS limits when a step is a text", () => {
    const config = intakeConfig();
    config.steps[1].channel = "sms";
    state.sequences = { intake_reminder: config };
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html).toContain("Text messages aren&#x27;t switched on yet, so SMS steps are skipped");
  });

  it("says when the settings could not load", () => {
    state.isError = true;
    expect(renderToStaticMarkup(<NotificationsCard />)).toContain(
      "We couldn&#x27;t load this organization&#x27;s notification settings.",
    );
  });
});

describe("NotificationsCard: other members", () => {
  beforeEach(() => {
    state.isAdmin = false;
  });

  it("shows a read-only summary with no inputs, buttons or Set up", () => {
    const config = intakeConfig();
    config.steps[2].ccRecipients = [
      { kind: "user", userId: JANE },
      { kind: "role", role: "admin" },
    ];
    state.sequences = { intake_reminder: config };
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html).toContain("Step 1 · day 2 after the invite · Email · First reminder");
    expect(html).toContain("Cc: no one");
    expect(html).toContain("Cc: Jane Doe, then All admins");
    expect(html).toContain("14 days from invite to ready<");
    expect(html).toContain("the provider submits the intake form; the provider withdraws<");
    expect(html).not.toContain("Near a start date");
    expect(html).toContain("Only admins can change notifications.");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Set up");
  });

  it("says a purpose is not set up rather than offering to set it up", () => {
    const html = renderToStaticMarkup(<NotificationsCard />);
    // Intake is an admin's to set up; the digest is Minted's (G2).
    expect(html.match(/Not set up\. An admin can set this up\./g)).toHaveLength(1);
    expect(html).toContain(NOT_SET_UP);
    expect(html).not.toContain("<button");
  });

  it("marks what follows Minted's default, and shows the digest's send time with no cc", () => {
    state.sequences = {
      intake_reminder: intakeConfig({ steps: [], stopConditions: null, targetDaysToReady: null }),
      followup_digest: {
        ...intakeConfig({ steps: [], stopConditions: null, targetDaysToReady: null }),
        ...MINTED_SET_UP,
        id: "seq-digest",
        purpose: "followup_digest",
      },
    };
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html).toContain("Minted&#x27;s default steps");
    expect(html).toContain("Step 3 · day 3 after the invite · Email · Final reminder");
    expect(html).toContain("14 days from invite to ready (Minted&#x27;s default)");
    expect(html).toContain(
      "the provider submits the intake form; onboarding is paused; the provider withdraws; the provider replies (Minted&#x27;s default)",
    );
    expect(html).toContain("Step 1 · once a day · Email · Follow-up digest");
    expect(html).toContain("Sent once a day, around 8 am Central time. Minted sets this.");
    expect(html).toContain("Goes to each coordinator only. No one is cc&#x27;d.");
    // Intake's three steps carry a cc line; the digest's step does not.
    expect(html.match(/Cc: /g)).toHaveLength(3);
  });

  it("says a digest with no schedule is not set up, its pill included (G2)", () => {
    state.sequences = {
      followup_digest: {
        ...intakeConfig({ steps: [], stopConditions: null, targetDaysToReady: null }),
        id: "seq-digest",
        purpose: "followup_digest",
      },
    };
    const summary = renderToStaticMarkup(<NotificationsCard />);
    expect(summary).toContain(NOT_SET_UP);
    expect(summary).toContain("Step 1 · Email · Follow-up digest");
    expect(summary).not.toContain("Sent ");
    expect(summary).not.toContain("once a day");
    expect(summary).not.toContain(">On<");
    state.isAdmin = true;
    const editor = renderToStaticMarkup(<NotificationsCard />);
    expect(editor).toContain(NOT_SET_UP);
    expect(editor).not.toContain("Sent ");
    expect(editor).not.toContain(">On<");
  });

  it("keeps on/off out of a digest that is switched on but has no schedule, until Minted sets one", () => {
    state.isAdmin = true;
    const digestRow = {
      ...intakeConfig({ steps: [], stopConditions: null, targetDaysToReady: null }),
      id: "seq-digest",
      purpose: "followup_digest" as const,
      enabled: true,
    };
    state.sequences = { followup_digest: digestRow };
    const unscheduled = renderToStaticMarkup(<NotificationsCard />);
    expect(unscheduled).toContain(NOT_SET_UP);
    expect(unscheduled).toContain(">Not set up<");
    expect(unscheduled).not.toContain("Minted switched these on");
    expect(unscheduled).not.toContain("Minted switches notifications on");
    state.sequences = { followup_digest: { ...digestRow, ...MINTED_SET_UP } };
    const scheduled = renderToStaticMarkup(<NotificationsCard />);
    expect(scheduled).toContain("On. Minted switched these on for your organization.");
    expect(scheduled).toContain(">On<");
    expect(scheduled).not.toContain(NOT_SET_UP);
    // Intake has no schedule, so its on/off line always shows.
    state.sequences = { intake_reminder: intakeConfig() };
    expect(renderToStaticMarkup(<NotificationsCard />)).toContain(
      "On. Minted switched these on for your organization.",
    );
  });

  it("never shows a stored zone it cannot use: the digest reads as not set up", () => {
    const digestRow = {
      ...intakeConfig({ steps: [], stopConditions: null, targetDaysToReady: null }),
      ...MINTED_SET_UP,
      purpose: "followup_digest",
      sendHour: 6,
      sendTimeZone: "Gone/Zone",
      secondSendHour: 15,
    };
    state.sequences = { followup_digest: digestRow };
    // G2: there is no default schedule to stand in for it.
    const summary = renderToStaticMarkup(<NotificationsCard />);
    expect(summary).toContain(NOT_SET_UP);
    expect(summary).not.toContain("Gone/Zone");
    state.isAdmin = true;
    const editor = renderToStaticMarkup(<NotificationsCard />);
    expect(editor).toContain(NOT_SET_UP);
    expect(editor).not.toContain("Gone/Zone");
  });

  it("shows the schedule Minted set for this org", () => {
    state.sequences = {
      followup_digest: {
        ...intakeConfig({ steps: [], stopConditions: null, targetDaysToReady: null }),
        ...MINTED_SET_UP,
        purpose: "followup_digest",
        sendHour: 6,
        sendTimeZone: "America/New_York",
        secondSendHour: 15,
      },
    };
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html).toContain("Sent once a day, around 6 am Eastern time. Minted sets this.");
    expect(html).not.toContain(NOT_SET_UP);
    expect(html).toContain(">On<");
  });
});

describe("NotificationSequenceEditor: an admin edits and saves", () => {
  it("routes an offset edit through onChange, then saves the edited draft", () => {
    const props = editorProps();
    const tree = NotificationSequenceEditor(props);
    const offset = byLabel(tree, "Step 3 days after invite");
    (offset.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "5" },
    });
    const edited = props.onChange.mock.calls[0][0] as SequenceDraft;
    expect(edited.steps?.map((s) => s.offsetDays)).toEqual([1, 2, 5]);

    // Re-render with the edit, as the section does: Save is now enabled.
    const saveProps = editorProps({ draft: edited, dirty: true });
    const saveTree = NotificationSequenceEditor(saveProps);
    const save = byText(saveTree, "Save");
    expect(save.props.disabled).toBe(false);
    (save.props.onClick as () => void)();
    expect(saveProps.onSave).toHaveBeenCalledTimes(1);
  });

  it("blocks Save while the draft is invalid and says why", () => {
    const draft = ownIntake();
    draft.steps = draft.steps.map((s, i) => (i === 1 ? { ...s, offsetDays: 1 } : s));
    const props = editorProps({ draft, dirty: true });
    const html = renderToStaticMarkup(<NotificationSequenceEditor {...props} />);
    expect(html).toContain("Step 2 must go out after step 1 (later than day 1).");
    expect(html).toContain("Fix the messages above to save.");
    expect(byText(NotificationSequenceEditor(props), "Save").props.disabled).toBe(true);
  });

  it("reorders steps from the keyboard buttons, keeping the schedule", () => {
    const props = editorProps();
    const tree = NotificationSequenceEditor(props);
    expect(byLabel(tree, "Move step 1 up").props.disabled).toBe(true);
    (byLabel(tree, "Move step 3 up").props.onClick as () => void)();
    const moved = props.onChange.mock.calls[0][0] as SequenceDraft;
    expect(moved.steps?.map((s) => s.offsetDays)).toEqual([1, 2, 3]);
    expect(moved.steps?.[1].templateKey).toBe("intake_reminder_final");
  });

  it("shows the digest as one read-only step: no cc, no inputs, Minted's send time", () => {
    const draft = starterDraft();
    const html = renderToStaticMarkup(
      <NotificationSequenceEditor
        {...editorProps({
          purpose: "followup_digest",
          draft,
          issues: validateDraft("followup_digest", draft),
          platformDefault: DIGEST_DEFAULT,
          saved: {
            ...intakeConfig({ steps: [], stopConditions: null, targetDaysToReady: null }),
            ...MINTED_SET_UP,
            purpose: "followup_digest",
          },
        })}
      />,
    );
    expect(html).toContain("Step 1 · once a day · Email · Follow-up digest");
    expect(html).toContain("Goes to each coordinator only. No one is cc&#x27;d.");
    expect(html).toContain("Sent once a day, around 8 am Central time. Minted sets this.");
    expect(html).not.toContain("Add someone to cc");
    expect(html).not.toContain("People cc&#x27;d on a step");
    expect(html).not.toContain("Customize steps");
    expect(html).not.toContain("days after invite");
    expect(html).not.toContain("Target days from invite to ready");
    expect(html).not.toContain("+ Add step");
    expect(html).not.toContain('aria-label="Move step 1 up"');
    expect(html).not.toContain('type="number"');
    // No control besides Save and Cancel: how often (Addendum 10), when and
    // on/off (A9) are Minted's.
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain("How often");
    expect(html).not.toContain('role="switch"');
  });
});

describe("NotificationSequenceEditor: Minted's default and going back to it (answer 3)", () => {
  it("lets a digest row with steps of its own go back to Minted's step", () => {
    const own: SequenceDraft = { ...starterDraft(), steps: stepsFromDefault(DIGEST_DEFAULT) };
    const props = editorProps({
      purpose: "followup_digest",
      draft: own,
      issues: validateDraft("followup_digest", own),
      platformDefault: DIGEST_DEFAULT,
    });
    const tree = NotificationSequenceEditor(props);
    expect(findAll(tree, (e) => e.props.children === "Customize steps")).toHaveLength(0);
    (byText(tree, "Use Minted's default steps").props.onClick as () => void)();
    expect((props.onChange.mock.calls[0][0] as SequenceDraft).steps).toBeNull();
    // On Minted's step there is nothing to reset.
    const inherited = renderToStaticMarkup(
      <NotificationSequenceEditor
        {...editorProps({
          purpose: "followup_digest",
          draft: starterDraft(),
          issues: [],
          platformDefault: DIGEST_DEFAULT,
        })}
      />,
    );
    expect(inherited).not.toContain("Use Minted&#x27;s default steps");
  });

  it("shows Minted's default steps and settings when the org has none of its own", () => {
    const html = renderToStaticMarkup(
      <NotificationSequenceEditor {...editorProps({ draft: starterDraft(), isNew: true })} />,
    );
    expect(html).toContain("Minted&#x27;s default steps");
    expect(html).toContain("Step 2 · day 2 after the invite · Email · Second reminder");
    expect(html).toContain(
      "Minted&#x27;s default steps cc no one, so a bounce on step 1 reaches no one.",
    );
    expect(html).toContain("Customize steps");
    expect(html).not.toContain('aria-label="Step 1 days after invite"');
    expect(html).not.toContain("Add someone to cc");
    expect(html).toContain('placeholder="14"');
    expect(html).toContain("Using Minted&#x27;s default, 14 days. Enter a number to change it.");
    expect(html).toContain("Using Minted&#x27;s default.");
    // The default's stop conditions show ticked.
    expect(html.match(/role="checkbox"[^>]*aria-checked="true"/g)).toHaveLength(4);
  });

  it("customizes from Minted's steps, and goes back to them", () => {
    const props = editorProps({ draft: starterDraft(), isNew: true });
    (byText(NotificationSequenceEditor(props), "Customize steps").props.onClick as () => void)();
    const customized = props.onChange.mock.calls[0][0] as SequenceDraft;
    expect(customized.steps?.map((s) => [s.offsetDays, s.ccRecipients])).toEqual([
      [1, []],
      [2, []],
      [3, []],
    ]);

    const ownProps = editorProps({ draft: customized, dirty: true });
    (
      byText(NotificationSequenceEditor(ownProps), "Use Minted's default steps").props
        .onClick as () => void
    )();
    expect((ownProps.onChange.mock.calls[0][0] as SequenceDraft).steps).toBeNull();
  });

  it("overrides the target by typing and goes back by clearing it", () => {
    const props = editorProps({ draft: starterDraft() });
    const target = findAll(
      NotificationSequenceEditor(props),
      (e) => e.props.id === "notifications-intake_reminder-target",
    )[0];
    const change = target.props.onChange as (e: { target: { value: string } }) => void;
    change({ target: { value: "21" } });
    change({ target: { value: "" } });
    expect(props.onChange.mock.calls.map((c) => (c[0] as SequenceDraft).targetDaysToReady)).toEqual(
      [21, null],
    );
  });

  it("overrides the stop conditions from the default set, and goes back to it", () => {
    const props = editorProps({ draft: starterDraft() });
    const [submitted] = findAll(
      NotificationSequenceEditor(props),
      (e) => e.props.id === "notifications-intake_reminder-stop-submitted",
    );
    (submitted.props.onCheckedChange as (v: boolean) => void)(false);
    const overridden = props.onChange.mock.calls[0][0] as SequenceDraft;
    expect(overridden.stopConditions).toEqual(["paused", "withdrawn", "provider_replied"]);

    const backProps = editorProps({ draft: overridden, dirty: true });
    (
      byLabel(NotificationSequenceEditor(backProps), "Use Minted's default stop conditions").props
        .onClick as () => void
    )();
    expect((backProps.onChange.mock.calls[0][0] as SequenceDraft).stopConditions).toBeNull();
  });
});

describe("NotificationCcRecipients: filling an empty cc list", () => {
  it("adds a role, then a member, in the order picked", () => {
    const onChange = vi.fn();
    const step: StepDraft = ownIntake().steps[0];
    const pick = (current: StepDraft, value: string) => {
      const tree = NotificationCcRecipients({
        step: current,
        stepNumber: 1,
        members: MEMBERS,
        bounceNote: true,
        onChange,
      });
      const [select] = findAll(tree, (e) => typeof e.props.onValueChange === "function");
      (select.props.onValueChange as (v: string) => void)(value);
      return onChange.mock.calls.at(-1)?.[0] as StepDraft;
    };
    const withRole = pick(step, "role:admin");
    const withBoth = pick(withRole, `user:${JANE}`);
    expect(withBoth.ccRecipients).toEqual([
      { kind: "role", role: "admin" },
      { kind: "user", userId: JANE },
    ]);
    const html = renderToStaticMarkup(
      <NotificationCcRecipients
        step={withBoth}
        stepNumber={1}
        members={MEMBERS}
        bounceNote
        onChange={onChange}
      />,
    );
    expect(html).not.toContain("No one is cc&#x27;d");
    expect(html).toContain("1.</span>");
  });
});

describe("NotificationsCard: before the migration is applied", () => {
  it("says the settings are not switched on yet, with no Set up and no error box", () => {
    state.unavailable = true;
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html).toContain(
      "Notification settings will appear here once they&#x27;re switched on for your organization.",
    );
    expect(html).not.toContain("Set up");
    expect(html).not.toContain("couldn&#x27;t load");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Provider intake reminders");
  });

  it("keeps the red box for a real load failure", () => {
    state.isError = true;
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html).toContain("We couldn&#x27;t load this organization&#x27;s notification settings.");
    expect(html).not.toContain("switched on for your organization");
  });
});

describe("NotificationsCard: cc'd users while the member list loads", () => {
  const STRANGER = "99999999-9999-4999-8999-999999999999";
  function withStrangerCc() {
    const config = intakeConfig();
    config.steps[0].ccRecipients = [{ kind: "user", userId: STRANGER }];
    state.sequences = { intake_reminder: config };
  }

  it("shows a neutral Member and no membership error until members have loaded", () => {
    withStrangerCc();
    state.membersLoaded = false;
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html).not.toContain("Former member");
    expect(html).toContain('aria-label="Remove Member from step 1"');
    expect(html).not.toContain("no longer a member");
  });

  it("names a former member and blocks Save once members have loaded", () => {
    withStrangerCc();
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html).toContain("Former member");
    expect(html).toContain(
      "Step 1 cc&#x27;s someone who is no longer a member. Remove them to save.",
    );
  });

  it("does the same in the read-only summary", () => {
    withStrangerCc();
    state.isAdmin = false;
    state.membersLoaded = false;
    expect(renderToStaticMarkup(<NotificationsCard />)).toContain("Cc: Member");
    state.membersLoaded = true;
    expect(renderToStaticMarkup(<NotificationsCard />)).toContain("Cc: Former member");
  });
});

describe("NotificationSequenceEditor: concurrent edits and keyboard moves", () => {
  it("keeps the draft and says so when another admin saved", () => {
    const html = renderToStaticMarkup(
      <NotificationSequenceEditor {...editorProps({ staleNotice: true, dirty: true })} />,
    );
    expect(html).toContain(
      "Someone else saved changes. Reload to see them; your edits aren&#x27;t saved.",
    );
    expect(html).toContain('role="status"');
    expect(renderToStaticMarkup(<NotificationSequenceEditor {...editorProps()} />)).not.toContain(
      "Someone else saved changes",
    );
  });

  it("moves focus to the destination slot's arrow and announces the move", () => {
    const focused: string[] = [];
    vi.stubGlobal("window", { requestAnimationFrame: (cb: () => void) => cb() });
    vi.stubGlobal("document", {
      getElementById: (id: string) => ({ focus: () => focused.push(id) }),
    });
    try {
      const props = { ...editorProps(), onAnnounce: vi.fn<(message: string) => void>() };
      const tree = NotificationSequenceEditor(props);
      (byLabel(tree, "Move step 3 up").props.onClick as () => void)();
      expect(focused).toEqual(["notifications-intake_reminder-step-2-move-up"]);
      expect(props.onAnnounce).toHaveBeenLastCalledWith("Moved to step 2");

      // At the top the up arrow is disabled, so focus lands on down.
      (byLabel(tree, "Move step 2 up").props.onClick as () => void)();
      expect(focused.at(-1)).toBe("notifications-intake_reminder-step-1-move-down");
      expect(props.onAnnounce).toHaveBeenLastCalledWith("Moved to step 1");

      // At the bottom the down arrow is disabled, so focus lands on up.
      (byLabel(tree, "Move step 2 down").props.onClick as () => void)();
      expect(focused.at(-1)).toBe("notifications-intake_reminder-step-3-move-up");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders the announcement in a polite live region and ids on every arrow", () => {
    const html = renderToStaticMarkup(
      <NotificationSequenceEditor {...editorProps({ announcement: "Moved to step 2" })} />,
    );
    expect(html).toMatch(/<p aria-live="polite" class="sr-only">Moved to step 2<\/p>/);
    expect(html).toContain('id="notifications-intake_reminder-step-2-move-up"');
    expect(html).toContain('id="notifications-intake_reminder-step-2-move-down"');
  });
});

describe("Policy settings in the card (bounce escalation step, digest audience)", () => {
  it("puts the bounce note on the escalating step the org chose", () => {
    const html = renderToStaticMarkup(
      <NotificationSequenceEditor
        {...editorProps({ draft: { ...ownIntake(), bounceEscalationStep: 2 } })}
      />,
    );
    expect(html.match(/If step 2 bounces, the people cc&#x27;d here are told\./g)).toHaveLength(1);
    expect(html).not.toContain("If step 1 bounces");
    expect(html.match(/Add a member or a role to copy them on this step\./g)).toHaveLength(2);
  });

  it("says escalation is off, without a cc bounce note, when the step is 0", () => {
    const own = renderToStaticMarkup(
      <NotificationSequenceEditor
        {...editorProps({ draft: { ...ownIntake(), bounceEscalationStep: 0 } })}
      />,
    );
    expect(own).not.toContain("bounces, the people");
    expect(own.match(/Add a member or a role to copy them on this step\./g)).toHaveLength(3);
    expect(own.match(/Bounce escalation is off, so a bounce reaches no one\./g)).toHaveLength(1);
    const inherited = renderToStaticMarkup(
      <NotificationSequenceEditor
        {...editorProps({
          draft: starterDraft(),
          isNew: true,
          platformDefault: { ...INTAKE_DEFAULT, bounceEscalationStep: 0 },
        })}
      />,
    );
    expect(inherited).toContain(
      "Minted&#x27;s default steps cc no one. Customize the steps to cc a member or a role.",
    );
    expect(inherited).toContain("Bounce escalation is off, so a bounce reaches no one.");
  });

  it("says a step past the last one reaches no one, without blocking Save", () => {
    const draft = { ...ownIntake(), bounceEscalationStep: 5 };
    const props = editorProps({ draft, dirty: true });
    const html = renderToStaticMarkup(<NotificationSequenceEditor {...props} />);
    expect(html).toContain("Step 5 doesn&#x27;t exist, so a bounce reaches no one.");
    expect(html).not.toContain("bounces, the people");
    expect(props.issues).toEqual([]);
    expect(byText(NotificationSequenceEditor(props), "Save").props.disabled).toBe(false);
    // The default steps (three) say so too.
    const inherited = renderToStaticMarkup(
      <NotificationSequenceEditor
        {...editorProps({
          draft: { ...starterDraft(), bounceEscalationStep: 4 },
          isNew: true,
        })}
      />,
    );
    expect(inherited).toContain("Step 4 doesn&#x27;t exist, so a bounce reaches no one.");
    // At the default (step 1 of 3) there is no such note.
    const normal = renderToStaticMarkup(<NotificationSequenceEditor {...editorProps()} />);
    expect(normal).not.toContain("reaches no one.</p><p");
    expect(normal).not.toContain("doesn&#x27;t exist");
    expect(normal).not.toContain("Bounce escalation is off");
  });

  it("names Minted's step on the default steps when the org has none of its own", () => {
    const html = renderToStaticMarkup(
      <NotificationSequenceEditor
        {...editorProps({
          draft: starterDraft(),
          isNew: true,
          platformDefault: { ...INTAKE_DEFAULT, bounceEscalationStep: 2 },
        })}
      />,
    );
    expect(html).toContain(
      "Minted&#x27;s default steps cc no one, so a bounce on step 2 reaches no one.",
    );
  });

  it("reads the org's saved step for the bounce note", () => {
    state.sequences = { intake_reminder: intakeConfig({ bounceEscalationStep: 3 }) };
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html).toContain("If step 3 bounces");
    expect(html).not.toContain("If step 1 bounces");
  });

  it("shows a digest cc line, and no coordinators-only note, only once Minted allows it", () => {
    state.isAdmin = false;
    const digestRow = {
      ...intakeConfig({ steps: [], stopConditions: null, targetDaysToReady: null }),
      id: "seq-digest",
      purpose: "followup_digest" as const,
    };
    state.sequences = { followup_digest: digestRow };
    const off = renderToStaticMarkup(<NotificationsCard />);
    expect(off).toContain("Goes to each coordinator only. No one is cc&#x27;d.");
    expect(off).not.toContain("Cc: ");
    state.defaults = {
      intake_reminder: INTAKE_DEFAULT,
      followup_digest: { ...DIGEST_DEFAULT, digestCcAllowed: true },
    };
    const allowed = renderToStaticMarkup(<NotificationsCard />);
    expect(allowed).not.toContain("Goes to each coordinator only");
    expect(allowed.match(/Cc: /g)).toHaveLength(1);
  });

  it("is not stuck on a digest cc list stored while the setting was on", () => {
    state.isAdmin = true;
    const stale = {
      ...intakeConfig({ stopConditions: null, targetDaysToReady: null }),
      id: "seq-digest",
      purpose: "followup_digest" as const,
      digestCcAllowed: null,
      steps: [
        {
          ...intakeConfig().steps[0],
          sequenceId: "seq-digest",
          offsetDays: 0,
          templateKey: "followup_digest_daily",
          ccRecipients: [{ kind: "role" as const, role: "admin" as const }],
        },
      ],
    };
    state.sequences = { followup_digest: stale };
    const html = renderToStaticMarkup(<NotificationsCard />);
    expect(html).not.toContain("so it has no cc list");
    expect(html).not.toContain("Fix the messages above to save.");
    expect(html).toContain("Goes to each coordinator only. No one is cc&#x27;d.");
  });

  it("follows the org's own digest cc override, which Minted sets, over the default", () => {
    state.isAdmin = false;
    const digestRow = (digestCcAllowed: boolean | null) => ({
      ...intakeConfig({ steps: [], stopConditions: null, targetDaysToReady: null }),
      id: "seq-digest",
      purpose: "followup_digest" as const,
      digestCcAllowed,
    });
    state.sequences = { followup_digest: digestRow(true) };
    const on = renderToStaticMarkup(<NotificationsCard />);
    expect(on).not.toContain("Goes to each coordinator only");
    expect(on.match(/Cc: /g)).toHaveLength(1);
    state.defaults = {
      intake_reminder: INTAKE_DEFAULT,
      followup_digest: { ...DIGEST_DEFAULT, digestCcAllowed: true },
    };
    state.sequences = { followup_digest: digestRow(false) };
    const off = renderToStaticMarkup(<NotificationsCard />);
    expect(off).toContain("Goes to each coordinator only. No one is cc&#x27;d.");
    expect(off).not.toContain("Cc: ");
  });
});

describe("Addendum 8 in the card (Answered Oct 31)", () => {
  it("shows how often the digest goes out read-only, as Minted set it (Addendum 10)", () => {
    const digestRow = (digestFrequency: NotificationSequenceConfig["digestFrequency"]) => ({
      ...intakeConfig({ steps: [], stopConditions: null, targetDaysToReady: null }),
      ...MINTED_SET_UP,
      id: "seq-digest",
      purpose: "followup_digest" as const,
      digestFrequency,
    });
    const weekly = renderToStaticMarkup(
      <NotificationSequenceEditor
        {...editorProps({
          purpose: "followup_digest",
          draft: starterDraft(),
          issues: [],
          platformDefault: DIGEST_DEFAULT,
          saved: digestRow("weekly"),
        })}
      />,
    );
    expect(weekly).toContain(
      "Sent once a week, on Mondays around 8 am Central time. Minted sets this.",
    );
    expect(weekly).toContain("Step 1 · once a week · Email · Follow-up digest");
    expect(weekly).not.toContain('role="combobox"');
    // An admin's card and a member's summary say the same, with no control.
    state.sequences = { followup_digest: digestRow("twice_daily") };
    const admin = renderToStaticMarkup(<NotificationsCard />);
    expect(admin).toContain(
      "Sent twice a day, around 8 am and 2 pm Central time. Minted sets this.",
    );
    expect(admin).toContain("Step 1 · twice a day · Email · Follow-up digest");
    expect(admin).not.toContain("How often");
    state.isAdmin = false;
    const member = renderToStaticMarkup(<NotificationsCard />);
    expect(member).toContain(
      "Sent twice a day, around 8 am and 2 pm Central time. Minted sets this.",
    );
  });

  it("shows on/off read-only: off until Minted switches it on (A9)", () => {
    const off = renderToStaticMarkup(<NotificationSequenceEditor {...editorProps()} />);
    expect(off).toContain("Off. Minted switches notifications on at kickoff.");
    expect(off).not.toContain('role="switch"');
  });

  it("refuses an empty stop list and blocks Save (A11)", () => {
    const draft = { ...ownIntake(), stopConditions: [] };
    const props = editorProps({ draft, dirty: true });
    const html = renderToStaticMarkup(<NotificationSequenceEditor {...props} />);
    expect(html).toContain("Choose at least one stop condition, or use Minted&#x27;s default.");
    expect(byText(NotificationSequenceEditor(props), "Save").props.disabled).toBe(true);
  });
});
