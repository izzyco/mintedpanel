// MINT-107 — organization notification sequences: the pure rules.
//
// A sequence is one organization's settings for one purpose: whether it is
// on, its ordered steps (offset in days, channel, template, ordered cc list),
// and, for intake reminders only, the stop conditions (at least one, A11) and
// the target days from invite to ready; for the digest, how often it goes
// out (daily, weekly or twice a day, A8) and when (the local hour and time
// zone, the weekly weekday, the twice-a-day second hour). Cadence is
// configuration, never a constant. Compression toward a start date was
// removed (A13, which supersedes D56).
//
// Two layers. Minted's platform default (one per purpose, no org, no cc,
// no on/off) and the org's own row, which overrides it field by field: a
// null setting uses the default, and an org with no steps of its own uses
// the default steps. `enabled` is never inherited, so a default can never
// switch an org on, and only Minted sets it (A9: off until Minted turns
// notifications on at kickoff). `resolveNotificationSequence` turns the two
// into the effective sequence; every consumer calls it rather than
// re-deriving it. The digest's schedule (how often, the weekly weekday, the
// hour, the zone and the twice-a-day second hour) is platform-managed and has
// no default (G2): it exists only on an org row, as one group (A10), once
// Minted sets the digest up for that org. Until then the effective sequence
// carries no schedule at all, and the digest is not due.
//
// Two policy decisions are settings too, not code (NotificationPolicyRules,
// resolved by resolveNotificationPolicyRules; Mission Control edits them,
// MINT-113):
//   * Which intake step's bounce escalates to that step's cc list
//     (bounce_escalation_step): step 1 (Oct 30), or 0 for none. Org-owned, like
//     the cc lists themselves: an org row overrides Minted's default.
//   * Whether the digest's step may carry a cc list (digest_cc_allowed): no,
//     coordinators only (D59, S7). Minted's default, which an org row may
//     override; platform-managed, so only Minted writes either.
//
// Nothing here sends anything. The consumers (the follow-up digest, and
// intake reminders once the intake back end lands) resolve the effective
// sequence and call `scheduleSequenceSends` and `bounceEscalationRecipients`
// below, so the rules they apply are pinned by tests now.
//
// Consumer contract for template keys: before rendering a step, the sender
// must look its `template_key` up in NOTIFICATION_TEMPLATES
// (src/lib/notificationTemplates.ts) and require the entry to exist, match the
// sequence's purpose, be `selectable`, and support the step's channel; a
// step that fails is skipped and recorded, never sent. The database checks
// only the key's format and its purpose prefix, so a row written directly
// can name a key the catalog does not have.
//
// The database enforces the same bounds (migration 20261101110100): offsets 0
// to 90, intake offsets from day 1 (A12), at most 10 steps, offsets strictly
// increasing, the digest at most one step and no cc unless Minted allows it,
// cc lists of at most 20 users or roles, at least one stop condition (A11),
// target 1 to 90 days, the digest's schedule as one group on an org row
// (frequency, weekly weekday, hour 0 to 23, an IANA zone, a later second
// hour; A10, G2), bounce escalation step 0 to 10. The one rule a later PR may
// relax without a migration, the digest offset fixed at 0, is enforced here
// and in the card only.
//
// All date math is date-only (YYYY-MM-DD, UTC) against passed-in dates. No
// clock read.
import type {
  AppRole,
  DigestFrequency,
  NotificationCcRecipient,
  NotificationChannel,
  NotificationPurpose,
  NotificationSequence,
  NotificationSequenceDefault,
  NotificationSequenceDefaultStep,
  NotificationSequenceStep,
  NotificationStopCondition,
} from "@/types";
import {
  getNotificationTemplate,
  purposeHasCcList,
  selectableTemplates,
  templateSupportsChannel,
} from "./notificationTemplates";

/* -------------------------------- Vocabulary ------------------------------- */

export const NOTIFICATION_PURPOSES: readonly NotificationPurpose[] = [
  "intake_reminder",
  "followup_digest",
];

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ["email", "sms"];

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  email: "Email",
  sms: "Text message (SMS)",
};

export const STOP_CONDITIONS: readonly NotificationStopCondition[] = [
  "submitted",
  "paused",
  "withdrawn",
  "provider_replied",
];

export const STOP_CONDITION_LABELS: Record<NotificationStopCondition, string> = {
  submitted: "The provider submits the intake form",
  paused: "Onboarding is paused",
  withdrawn: "The provider withdraws",
  provider_replied: "The provider replies",
};

/** The org roles a step may cc. Same set as memberships_role_check / user_role(). */
export const CC_ROLES: readonly AppRole[] = ["admin", "specialist", "billing"];

export const CC_ROLE_LABELS: Record<AppRole, string> = {
  admin: "All admins",
  specialist: "All specialists",
  billing: "All billing members",
};

/** An org member the cc picker can offer. */
export interface CcMemberOption {
  userId: string;
  name: string;
}

/**
 * How a cc recipient reads in the card. A user missing from a LOADED member
 * list reads as "Former member"; while the list is loading, or after it
 * failed, the card cannot tell, so the user reads as a neutral "Member".
 */
export function ccRecipientLabel(
  recipient: NotificationCcRecipient,
  members: ReadonlyMap<string, CcMemberOption>,
  membersLoaded = true,
): string {
  if (recipient.kind === "role") return CC_ROLE_LABELS[recipient.role];
  return members.get(recipient.userId)?.name ?? (membersLoaded ? "Former member" : "Member");
}

/** "Jane Doe, then All admins" for the read-only summary. */
export function describeCcList(
  recipients: readonly NotificationCcRecipient[],
  members: ReadonlyMap<string, CcMemberOption>,
  membersLoaded = true,
): string {
  if (recipients.length === 0) return "no one";
  return recipients.map((r) => ccRecipientLabel(r, members, membersLoaded)).join(", then ");
}

/**
 * Mirrors the CHECK constraints in migration 20261101110100. Default values
 * (14 days, the default steps, the send time) are not here: they are Minted's
 * platform default rows, read through the service.
 */
export const NOTIFICATION_LIMITS = {
  maxOffsetDays: 90,
  maxSteps: 10,
  maxCcRecipients: 20,
  minTargetDays: 1,
  maxTargetDays: 90,
} as const;

export interface PurposeRules {
  label: string;
  description: string;
  maxSteps: number;
  /** Earliest offset a step may use. */
  minOffsetDays: number;
  /** When set, every step uses this offset and the card shows no input. */
  fixedOffsetDays: number | null;
  /** Stop conditions, target days and the bounce escalation step. */
  hasIntakeSettings: boolean;
  /**
   * The card edits an ordered cc list on each step, and the purpose's
   * templates render a cc copy. False for the digest: whether its step may
   * carry a cc list at all is Minted's setting (digest_cc_allowed, off:
   * coordinators only), resolved as EffectiveNotificationSequence.ccAllowed.
   */
  hasCcList: boolean;
  /** Admins can replace Minted's default steps with their own on the card. */
  stepsEditable: boolean;
  /** A platform-managed schedule (how often, hour, zone), set per org with no default (G2). */
  hasSendTime: boolean;
}

export const PURPOSE_RULES: Record<NotificationPurpose, PurposeRules> = {
  intake_reminder: {
    label: "Provider intake reminders",
    description:
      "Reminders to a provider who has an onboarding invite but has not finished the intake form.",
    maxSteps: NOTIFICATION_LIMITS.maxSteps,
    // A12: nothing goes out on the invite day (the database refuses it too).
    minOffsetDays: 1,
    fixedOffsetDays: null,
    hasIntakeSettings: true,
    hasCcList: purposeHasCcList("intake_reminder"),
    stepsEditable: true,
    hasSendTime: false,
  },
  followup_digest: {
    label: "Follow-up digest",
    description:
      "An email to each coordinator listing their follow-ups that are overdue or due today.",
    // The digest is one message each time it goes out.
    maxSteps: 1,
    minOffsetDays: 0,
    // An offset has no meaning for the digest: when it goes out is its
    // schedule (A8, set by Minted per org, G2). 0 keeps the shared step
    // shape. Relaxing this needs no migration.
    fixedOffsetDays: 0,
    hasIntakeSettings: false,
    // Coordinators only (answer 2, D59): the card offers no digest cc list.
    // The rule itself is Minted's setting digest_cc_allowed (see
    // NotificationPolicyRules).
    hasCcList: purposeHasCcList("followup_digest"),
    // One email, one message, no cc.
    stepsEditable: false,
    // Minted sets how often and when it goes out, per org (answer 5,
    // Addendum 10); there is no default schedule (G2).
    hasSendTime: true,
  },
};

/** How the card names the platform layer. */
export const PLATFORM_DEFAULT_LABEL = "Minted's default";

/* ----------------------------- Policy settings ----------------------------- */

/**
 * Two decided policies kept as settings, not code. Minted's default rows
 * carry them (migration 20261101110100 seeds these same values) and an org's
 * own row may override either; Mission Control edits them (MINT-113). The
 * bounce step is org-owned (an org admin may set it); digest_cc_allowed is
 * platform-managed (only Minted writes it, on the default or as an org
 * override). The values below are the decided defaults, and what a reader
 * falls back to when a stored value is missing or of the wrong shape. The
 * digest's frequency and weekday are not here: they are part of its
 * schedule, which has no default (G2; digestScheduleOf).
 */
export interface NotificationPolicyRules {
  /**
   * Intake: the one step whose bounce is escalated, to that step's own cc
   * list, in its order, with the bounce notice. Default 1 (Oct 30: "a bounce
   * escalates on email 1", only to step 1's cc list).
   * BOUNCE_ESCALATION_OFF (0): no bounce escalates. A step number the
   * sequence does not have escalates to no one.
   */
  bounceEscalationStep: number;
  /**
   * Digest: whether its step may carry a cc list. Default false (D59, S7:
   * the digest goes to coordinators only; nobody cc'd receives anything).
   * Platform-managed: an org override exists, but only Minted sets it.
   * Turning it on lets an org keep a cc list on its digest step; nothing
   * renders or sends a cc copy of the digest yet (its template has no cc
   * copy, and the MINT-108 sender writes to coordinators only).
   */
  digestCcAllowed: boolean;
}

/** bounceEscalationStep: no bounce escalates. */
export const BOUNCE_ESCALATION_OFF = 0;

/** The decided defaults (Oct 30 and D59). */
export const DEFAULT_NOTIFICATION_POLICY_RULES: Readonly<NotificationPolicyRules> = Object.freeze({
  bounceEscalationStep: 1,
  digestCcAllowed: false,
});

export const DIGEST_FREQUENCIES: readonly DigestFrequency[] = ["daily", "weekly", "twice_daily"];

export function isDigestFrequency(value: unknown): value is DigestFrequency {
  return typeof value === "string" && (DIGEST_FREQUENCIES as readonly string[]).includes(value);
}

/** An ISO weekday, 1 (Monday) to 7 (Sunday). */
export function isIsoWeekday(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7;
}

/** A platform or organization layer. A null or missing field inherits. */
export type NotificationPolicyRulesOverride = {
  readonly [K in keyof NotificationPolicyRules]?: NotificationPolicyRules[K] | null;
};

/** 0 (no escalation) or a step position, 1 to the most steps a sequence has. */
export function isBounceEscalationStep(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= BOUNCE_ESCALATION_OFF &&
    value <= NOTIFICATION_LIMITS.maxSteps
  );
}

const POLICY_CHECKS: { [K in keyof NotificationPolicyRules]: (value: unknown) => boolean } = {
  bounceEscalationStep: isBounceEscalationStep,
  digestCcAllowed: (value) => typeof value === "boolean",
};

/**
 * Field by field: the organization's value, else the platform's (Minted's
 * default row), else DEFAULT_NOTIFICATION_POLICY_RULES. null or undefined
 * inherits; a value of the wrong shape is skipped like a missing one. Who may
 * write each layer is the database's rule (and validateNotificationPolicyRules'),
 * not this reader's.
 */
export function resolveNotificationPolicyRules(
  platform?: NotificationPolicyRulesOverride | null,
  organization?: NotificationPolicyRulesOverride | null,
): NotificationPolicyRules {
  const pick = <K extends keyof NotificationPolicyRules>(key: K): NotificationPolicyRules[K] => {
    for (const layer of [organization, platform]) {
      const value: unknown = layer?.[key];
      if (value != null && POLICY_CHECKS[key](value)) return value as NotificationPolicyRules[K];
    }
    return DEFAULT_NOTIFICATION_POLICY_RULES[key];
  };
  return {
    bounceEscalationStep: pick("bounceEscalationStep"),
    digestCcAllowed: pick("digestCcAllowed"),
  };
}

/**
 * Plain-language problems with one layer's policy settings; empty when it can
 * go live. null leaves a rule to the layer below. `writer` is who is saving:
 * an org admin may set the bounce step only; Minted (a platform admin) may
 * set every one, on the default or as an org override.
 */
export function validateNotificationPolicyRules(
  rules: unknown,
  writer: "platform_admin" | "org_admin" = "platform_admin",
): string[] {
  if (rules == null || typeof rules !== "object" || Array.isArray(rules)) {
    return ["The notification policy settings must be a set of named values."];
  }
  const record = rules as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(record)) {
    if (!(key in POLICY_CHECKS)) errors.push(`"${key}" is not a notification policy setting.`);
  }
  const step = record.bounceEscalationStep;
  if (step != null && !isBounceEscalationStep(step)) {
    errors.push(
      `The bounce escalation step must be a step from 1 to ${NOTIFICATION_LIMITS.maxSteps}, or 0 for no escalation.`,
    );
  }
  const cc = record.digestCcAllowed;
  if (cc != null && typeof cc !== "boolean") {
    errors.push("Whether the digest may cc anyone must be on or off.");
  }
  // Platform-managed: Minted sets it, on the default or as an org override.
  if (writer === "org_admin" && cc != null) {
    errors.push("Only Minted decides whether the digest may cc anyone.");
  }
  return errors;
}

/** Whether a purpose's steps may carry a cc list under these rules. */
export function purposeAllowsCc(
  purpose: NotificationPurpose,
  rules: Pick<NotificationPolicyRules, "digestCcAllowed">,
): boolean {
  return (
    PURPOSE_RULES[purpose].hasCcList || (purpose === "followup_digest" && rules.digestCcAllowed)
  );
}

/** The card's note on the escalating step's empty cc list. */
export function bounceCcNote(stepNumber: number): string {
  return `If step ${stepNumber} bounces, the people cc'd here are told. Add a member or a role so a bounce reaches someone.`;
}

/** The card's note under Minted's default intake steps, which cc no one. */
export function defaultStepsCcNote(bounceEscalationStep: number): string {
  const lead = `${PLATFORM_DEFAULT_LABEL} steps cc no one`;
  const fix = "Customize the steps to cc a member or a role.";
  return bounceEscalationStep === BOUNCE_ESCALATION_OFF
    ? `${lead}. ${fix}`
    : `${lead}, so a bounce on step ${bounceEscalationStep} reaches no one. ${fix}`;
}

/** The card's note on a purpose whose steps may not carry a cc list. */
export const COORDINATORS_ONLY_NOTE = "Goes to each coordinator only. No one is cc'd.";

/** The card's read-only on/off line (A9: only Minted switches notifications on or off). */
export function enabledStatusNote(enabled: boolean): string {
  return enabled
    ? "On. Minted switched these on for your organization."
    : "Off. Minted switches notifications on at kickoff.";
}

/**
 * A non-blocking note when the bounce escalation step reaches no one by
 * construction: escalation is off, or the step is past the sequence's last
 * step. Null when the step exists (its cc list may still be empty; the cc
 * editor says so).
 */
export function bounceStepNote(bounceEscalationStep: number, stepCount: number): string | null {
  if (bounceEscalationStep === BOUNCE_ESCALATION_OFF) {
    return "Bounce escalation is off, so a bounce reaches no one.";
  }
  if (bounceEscalationStep > stepCount) {
    return `Step ${bounceEscalationStep} doesn't exist, so a bounce reaches no one.`;
  }
  return null;
}

/* ---------------------------------- Drafts --------------------------------- */

/** One step while it is being edited. `offsetDays` is null while the input is blank. */
export interface StepDraft {
  offsetDays: number | null;
  channel: NotificationChannel;
  templateKey: string;
  ccRecipients: NotificationCcRecipient[];
}

/**
 * What an org admin edits: the org-owned settings only. A null field uses
 * Minted's default; `steps: null` uses Minted's default steps. The
 * platform-managed settings (on/off, the digest's frequency, send time and
 * weekday, digest cc) are not here at all: the card cannot set them.
 */
export interface SequenceDraft {
  /** Intake only. null: Minted's default. Otherwise at least one (A11). */
  stopConditions: NotificationStopCondition[] | null;
  /** Intake only. null: Minted's default (the input is blank). */
  targetDaysToReady: number | null;
  /**
   * Intake only: the step whose bounce escalates (NotificationPolicyRules);
   * 0 for none. null: Minted's default. The card has no control for it yet;
   * it carries a saved value through a save unchanged.
   */
  bounceEscalationStep: number | null;
  /** null: Minted's default steps. Otherwise the org's own, never empty. */
  steps: StepDraft[] | null;
}

/** A saved org sequence with its own ordered steps (none: it uses the default steps). */
export interface NotificationSequenceConfig extends NotificationSequence {
  steps: NotificationSequenceStep[];
}

/** Minted's platform default for one purpose with its ordered steps. */
export interface NotificationSequenceDefaultConfig extends NotificationSequenceDefault {
  steps: NotificationSequenceDefaultStep[];
}

/**
 * The starting point behind "Set up": every setting left to Minted's
 * default. Saving it never emails anyone: a new row is off until Minted
 * switches it on at kickoff (A9). Any setting can be changed before saving.
 */
export function starterDraft(): SequenceDraft {
  return {
    stopConditions: null,
    targetDaysToReady: null,
    bounceEscalationStep: null,
    steps: null,
  };
}

export interface DraftOptions {
  /**
   * The org's effective digest_cc_allowed. Default: the row's own override,
   * else the decided false. A digest cc list it does not allow (one stored
   * while the setting was on) is left out of the draft, so the card is never
   * stuck on it and the next save clears it.
   */
  digestCcAllowed?: boolean;
}

export function draftFromSequence(
  config: NotificationSequenceConfig,
  options: DraftOptions = {},
): SequenceDraft {
  const ccAllowed = purposeAllowsCc(config.purpose, {
    digestCcAllowed:
      options.digestCcAllowed ??
      config.digestCcAllowed ??
      DEFAULT_NOTIFICATION_POLICY_RULES.digestCcAllowed,
  });
  return {
    stopConditions: config.stopConditions ? [...config.stopConditions] : null,
    targetDaysToReady: config.targetDaysToReady,
    bounceEscalationStep: config.bounceEscalationStep ?? null,
    steps:
      config.steps.length === 0
        ? null
        : [...config.steps]
            .sort((a, b) => a.position - b.position)
            .map((step) => ({
              offsetDays: step.offsetDays,
              channel: step.channel,
              templateKey: step.templateKey,
              ccRecipients: ccAllowed ? step.ccRecipients.map((r) => ({ ...r })) : [],
            })),
  };
}

/** Minted's default steps as the org's own, to edit: "Customize steps". A default cc's no one. */
export function stepsFromDefault(platformDefault: NotificationSequenceDefaultConfig): StepDraft[] {
  return [...platformDefault.steps]
    .sort((a, b) => a.position - b.position)
    .map((step) => ({
      offsetDays: step.offsetDays,
      channel: step.channel,
      templateKey: step.templateKey,
      ccRecipients: [],
    }));
}

/** A draft in one key order, so equal drafts compare equal however they were built. */
function canonicalDraft(draft: SequenceDraft): string {
  return JSON.stringify({
    stopConditions: draft.stopConditions,
    targetDaysToReady: draft.targetDaysToReady,
    bounceEscalationStep: draft.bounceEscalationStep ?? null,
    steps:
      draft.steps?.map((step) => ({
        offsetDays: step.offsetDays,
        channel: step.channel,
        templateKey: step.templateKey,
        ccRecipients: step.ccRecipients,
      })) ?? null,
  });
}

export function draftsEqual(a: SequenceDraft, b: SequenceDraft): boolean {
  return canonicalDraft(a) === canonicalDraft(b);
}

/* ------------------------------ Draft editing ------------------------------ */

function swap<T>(items: readonly T[], index: number, other: number): T[] {
  const next = [...items];
  const held = next[index];
  next[index] = next[other];
  next[other] = held;
  return next;
}

/**
 * Move a step's MESSAGE up or down. Offsets belong to the slot, not the
 * message, because they must increase with position: moving step 3 up to
 * step 2 sends its template, channel and cc list on step 2's day. Out of
 * range is a no-op.
 */
export function moveStep(draft: SequenceDraft, index: number, direction: -1 | 1): SequenceDraft {
  if (!draft.steps) return draft;
  const other = index + direction;
  if (index < 0 || other < 0 || index >= draft.steps.length || other >= draft.steps.length) {
    return draft;
  }
  const steps = draft.steps.map((step) => ({ ...step }));
  const a = steps[index];
  const b = steps[other];
  steps[index] = { ...b, offsetDays: a.offsetDays };
  steps[other] = { ...a, offsetDays: b.offsetDays };
  return { ...draft, steps };
}

/** Append a step a few days after the last one, using the next unused message. */
export function addStep(purpose: NotificationPurpose, draft: SequenceDraft): SequenceDraft {
  const rules = PURPOSE_RULES[purpose];
  if (!draft.steps || draft.steps.length >= rules.maxSteps) return draft;
  const last = draft.steps.at(-1);
  const templates = selectableTemplates(purpose);
  const used = new Set(draft.steps.map((s) => s.templateKey));
  const template = templates.find((t) => !used.has(t.key)) ?? templates.at(-1);
  const offsetDays =
    rules.fixedOffsetDays ??
    Math.min(
      NOTIFICATION_LIMITS.maxOffsetDays,
      last?.offsetDays == null ? rules.minOffsetDays : last.offsetDays + 3,
    );
  return {
    ...draft,
    steps: [
      ...draft.steps,
      {
        offsetDays,
        channel: "email",
        templateKey: template?.key ?? "",
        ccRecipients: [],
      },
    ],
  };
}

/** Removes a step. The last one stays: use Minted's default steps instead. */
export function removeStep(draft: SequenceDraft, index: number): SequenceDraft {
  if (!draft.steps || draft.steps.length <= 1) return draft;
  if (index < 0 || index >= draft.steps.length) return draft;
  return { ...draft, steps: draft.steps.filter((_, i) => i !== index) };
}

export function updateStep(
  draft: SequenceDraft,
  index: number,
  patch: Partial<StepDraft>,
): SequenceDraft {
  if (!draft.steps || index < 0 || index >= draft.steps.length) return draft;
  return {
    ...draft,
    steps: draft.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
  };
}

/** Toggle one stop condition, starting from Minted's default when the draft inherits. */
export function toggleStopCondition(
  draft: SequenceDraft,
  platformDefault: NotificationSequenceDefaultConfig,
  condition: NotificationStopCondition,
  checked: boolean,
): SequenceDraft {
  const current = draft.stopConditions ?? platformDefault.stopConditions ?? [];
  return {
    ...draft,
    stopConditions: checked
      ? STOP_CONDITIONS.filter((c) => c === condition || current.includes(c))
      : current.filter((c) => c !== condition),
  };
}

export function recipientKey(recipient: NotificationCcRecipient): string {
  return recipient.kind === "user" ? `user:${recipient.userId}` : `role:${recipient.role}`;
}

/** Append a cc recipient; a duplicate is ignored. */
export function addCcRecipient(step: StepDraft, recipient: NotificationCcRecipient): StepDraft {
  const key = recipientKey(recipient);
  if (step.ccRecipients.some((r) => recipientKey(r) === key)) return step;
  return { ...step, ccRecipients: [...step.ccRecipients, recipient] };
}

export function removeCcRecipient(step: StepDraft, index: number): StepDraft {
  if (index < 0 || index >= step.ccRecipients.length) return step;
  return { ...step, ccRecipients: step.ccRecipients.filter((_, i) => i !== index) };
}

export function moveCcRecipient(step: StepDraft, index: number, direction: -1 | 1): StepDraft {
  const other = index + direction;
  if (index < 0 || other < 0 || index >= step.ccRecipients.length) return step;
  if (other >= step.ccRecipients.length) return step;
  return { ...step, ccRecipients: swap(step.ccRecipients, index, other) };
}

/** Encode a cc picker choice ("role:admin", "user:<uuid>") back to a recipient. */
export function parseRecipientKey(key: string): NotificationCcRecipient | null {
  const [kind, value] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "role" && (CC_ROLES as readonly string[]).includes(value)) {
    return { kind: "role", role: value as AppRole };
  }
  if (kind === "user" && UUID_PATTERN.test(value)) return { kind: "user", userId: value };
  return null;
}

/* -------------------------------- Validation ------------------------------- */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SequenceIssueField =
  | "steps"
  | "offsetDays"
  | "channel"
  | "templateKey"
  | "ccRecipients"
  | "stopConditions"
  | "targetDaysToReady"
  | "bounceEscalationStep";

export interface SequenceIssue {
  field: SequenceIssueField;
  /** The 0-based step index for step-level issues. */
  stepIndex: number | null;
  message: string;
}

export interface ValidateOptions {
  /** The org's member user ids; when given, a cc'd user outside it is an issue. */
  memberUserIds?: ReadonlySet<string>;
  /**
   * The org's effective digest_cc_allowed (NotificationPolicyRules: its
   * override, else Minted's default), when the caller has it. Default: the
   * decided value, false (coordinators only).
   */
  digestCcAllowed?: boolean;
}

function draftAllowsCc(purpose: NotificationPurpose, options: ValidateOptions): boolean {
  return purposeAllowsCc(purpose, {
    digestCcAllowed: options.digestCcAllowed ?? DEFAULT_NOTIFICATION_POLICY_RULES.digestCcAllowed,
  });
}

function isWholeNumber(value: number | null): value is number {
  return value != null && Number.isInteger(value);
}

/** Every reason this draft cannot be saved. Empty means it can. */
export function validateDraft(
  purpose: NotificationPurpose,
  draft: SequenceDraft,
  options: ValidateOptions = {},
): SequenceIssue[] {
  const rules = PURPOSE_RULES[purpose];
  const ccAllowed = draftAllowsCc(purpose, options);
  const issues: SequenceIssue[] = [];
  const add = (field: SequenceIssueField, stepIndex: number | null, message: string) =>
    issues.push({ field, stepIndex, message });

  // null: Minted's default steps, nothing to check here.
  const steps = draft.steps ?? [];
  if (draft.steps && draft.steps.length === 0) {
    add("steps", null, "Add at least one step, or use Minted's default steps.");
  }
  if (purpose === "followup_digest" && steps.length > 1) {
    add("steps", null, "The follow-up digest has exactly one step.");
  } else if (steps.length > rules.maxSteps) {
    add("steps", null, `A sequence can have at most ${rules.maxSteps} steps.`);
  }

  let previous: number | null = null;
  steps.forEach((step, index) => {
    const n = index + 1;
    const offset = step.offsetDays;
    if (!isWholeNumber(offset)) {
      add("offsetDays", index, `Enter a whole number of days for step ${n}.`);
    } else if (rules.fixedOffsetDays != null && offset !== rules.fixedOffsetDays) {
      add("offsetDays", index, `The follow-up digest is sent on day ${rules.fixedOffsetDays}.`);
    } else if (offset < rules.minOffsetDays || offset > NOTIFICATION_LIMITS.maxOffsetDays) {
      add(
        "offsetDays",
        index,
        `Step ${n} must be between day ${rules.minOffsetDays} and day ${NOTIFICATION_LIMITS.maxOffsetDays}.`,
      );
    } else if (previous != null && offset <= previous) {
      add(
        "offsetDays",
        index,
        `Step ${n} must go out after step ${index} (later than day ${previous}).`,
      );
    }
    if (isWholeNumber(offset)) previous = offset;

    if (!NOTIFICATION_CHANNELS.includes(step.channel)) {
      add("channel", index, `Choose a channel for step ${n}.`);
    }
    const template = getNotificationTemplate(step.templateKey);
    if (!template || template.purpose !== purpose || !template.selectable) {
      add("templateKey", index, `Choose a message for step ${n}.`);
    } else if (!templateSupportsChannel(step.templateKey, step.channel)) {
      add(
        "channel",
        index,
        `"${template.label}" has no ${step.channel === "sms" ? "text message" : "email"} version.`,
      );
    }

    if (!ccAllowed && step.ccRecipients.length > 0) {
      add(
        "ccRecipients",
        index,
        "The follow-up digest goes to coordinators only, so it has no cc list.",
      );
    }
    if (step.ccRecipients.length > NOTIFICATION_LIMITS.maxCcRecipients) {
      add(
        "ccRecipients",
        index,
        `Step ${n} can cc at most ${NOTIFICATION_LIMITS.maxCcRecipients} members or roles.`,
      );
    }
    const keys = step.ccRecipients.map(recipientKey);
    if (new Set(keys).size !== keys.length) {
      add("ccRecipients", index, `Step ${n} lists the same member or role twice.`);
    }
    for (const recipient of step.ccRecipients) {
      if (recipient.kind === "role" && !CC_ROLES.includes(recipient.role)) {
        add("ccRecipients", index, `Step ${n} names a role that does not exist.`);
      }
      if (recipient.kind === "user") {
        if (!UUID_PATTERN.test(recipient.userId)) {
          add("ccRecipients", index, `Step ${n} names a member that does not exist.`);
        } else if (options.memberUserIds && !options.memberUserIds.has(recipient.userId)) {
          add(
            "ccRecipients",
            index,
            `Step ${n} cc's someone who is no longer a member. Remove them to save.`,
          );
        }
      }
    }
  });

  if (rules.hasIntakeSettings) {
    // null on either: Minted's default.
    const conditions = draft.stopConditions;
    if (
      conditions &&
      (conditions.some((c) => !STOP_CONDITIONS.includes(c)) ||
        new Set(conditions).size !== conditions.length)
    ) {
      add("stopConditions", null, "Choose stop conditions from the list.");
    } else if (conditions && conditions.length === 0) {
      // A11: at least one is required.
      add("stopConditions", null, "Choose at least one stop condition, or use Minted's default.");
    }
    const target = draft.targetDaysToReady;
    if (
      target != null &&
      (!isWholeNumber(target) ||
        target < NOTIFICATION_LIMITS.minTargetDays ||
        target > NOTIFICATION_LIMITS.maxTargetDays)
    ) {
      add(
        "targetDaysToReady",
        null,
        `Enter a target between ${NOTIFICATION_LIMITS.minTargetDays} and ${NOTIFICATION_LIMITS.maxTargetDays} days, or leave it blank for Minted's default.`,
      );
    }
    const bounce = draft.bounceEscalationStep;
    if (bounce != null && !isBounceEscalationStep(bounce)) {
      add(
        "bounceEscalationStep",
        null,
        `Choose which step's bounce is escalated (step 1 to ${NOTIFICATION_LIMITS.maxSteps}), turn it off, or use Minted's default.`,
      );
    }
  } else {
    if (draft.stopConditions != null) {
      add("stopConditions", null, "The follow-up digest has no stop conditions.");
    }
    if (draft.targetDaysToReady != null) {
      add("targetDaysToReady", null, "The follow-up digest has no target.");
    }
    if (draft.bounceEscalationStep != null) {
      add("bounceEscalationStep", null, "The follow-up digest has no bounce rule.");
    }
  }

  return issues;
}

/* --------------------------------- Payload --------------------------------- */

export type CcRecipientPayload =
  { kind: "user"; user_id: string } | { kind: "role"; role: AppRole };

export interface SequenceStepPayload {
  offset_days: number;
  channel: NotificationChannel;
  template_key: string;
  cc_recipients: CcRecipientPayload[];
}

/**
 * The `p_payload` of save_notification_sequence(p_org_id, p_purpose, p_payload).
 * A null setting uses Minted's default. There is no key for on/off, the
 * digest's frequency, send time or weekday, or digest cc: the RPC refuses
 * them (notification_platform_setting).
 */
export interface SaveSequencePayload {
  /** Intake only; null for Minted's default and always null for the digest. */
  stop_conditions: NotificationStopCondition[] | null;
  /** Intake only; null for Minted's default and always null for the digest. */
  target_days_to_ready: number | null;
  /**
   * Intake only: the org's own bounce escalation step (0: none). Absent for
   * Minted's default and for the digest: the RPC reads a missing key as null,
   * like every other optional setting.
   */
  bounce_escalation_step?: number;
  /** The revision the editor loaded; null when no row existed yet. */
  expected_revision: number | null;
  /** null: Minted's default steps. */
  steps: SequenceStepPayload[] | null;
}

export function ccRecipientToPayload(recipient: NotificationCcRecipient): CcRecipientPayload {
  return recipient.kind === "user"
    ? { kind: "user", user_id: recipient.userId }
    : { kind: "role", role: recipient.role };
}

/**
 * Build the RPC payload from a draft. Throws on an invalid draft: the card
 * validates first, so a throw here is a programming error, not user input.
 * Intake-only settings are normalized away for the digest.
 */
export function buildSavePayload(
  purpose: NotificationPurpose,
  draft: SequenceDraft,
  expectedRevision: number | null,
  options: ValidateOptions = {},
): SaveSequencePayload {
  const issues = validateDraft(purpose, draft, options);
  if (issues.length > 0) {
    throw new Error(`Invalid notification sequence: ${issues[0].message}`);
  }
  const rules = PURPOSE_RULES[purpose];
  const ccAllowed = draftAllowsCc(purpose, options);
  const stops = draft.stopConditions;
  const bounce = rules.hasIntakeSettings ? draft.bounceEscalationStep : null;
  return {
    stop_conditions:
      rules.hasIntakeSettings && stops ? STOP_CONDITIONS.filter((c) => stops.includes(c)) : null,
    target_days_to_ready: rules.hasIntakeSettings ? draft.targetDaysToReady : null,
    ...(bounce != null ? { bounce_escalation_step: bounce } : {}),
    expected_revision: expectedRevision,
    steps:
      draft.steps?.map((step) => ({
        offset_days: step.offsetDays as number,
        channel: step.channel,
        template_key: step.templateKey,
        cc_recipients: ccAllowed ? step.ccRecipients.map(ccRecipientToPayload) : [],
      })) ?? null,
  };
}

/** Narrow a cc_recipients jsonb value from the database. Malformed entries are dropped. */
export function parseCcRecipients(value: unknown): NotificationCcRecipient[] {
  if (!Array.isArray(value)) return [];
  const out: NotificationCcRecipient[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.kind === "user" && typeof record.user_id === "string") {
      out.push({ kind: "user", userId: record.user_id });
    } else if (
      record.kind === "role" &&
      typeof record.role === "string" &&
      (CC_ROLES as readonly string[]).includes(record.role)
    ) {
      out.push({ kind: "role", role: record.role as AppRole });
    }
  }
  return out;
}

/* ------------------------------ Save failures ------------------------------ */

const SAVE_ERROR_MESSAGES: ReadonlyArray<[string, string]> = [
  [
    "notification_sequence_conflict",
    "Someone else saved these settings while you were editing. Reload the page to see their changes.",
  ],
  ["notification_sequence_not_authorized", "Only admins can change notifications."],
  [
    "notification_cc_user_not_member",
    "Someone cc'd on a step is no longer a member of this organization. Remove them and save again.",
  ],
  ["notification_digest_single_step", "The follow-up digest has exactly one step."],
  [
    "notification_digest_has_no_cc",
    "The follow-up digest goes to coordinators only, so it can't cc anyone.",
  ],
  ["notification_platform_setting", "Minted sets that setting, so it can't be changed here."],
  ["notification_step_offsets_not_increasing", "Each step must go out after the one before it."],
];

/**
 * A user-facing message for a failed save. Matches the RPC's RAISE codes;
 * SQLSTATE PT409 (PostgREST answers HTTP 409) is the revision conflict
 * whatever its text.
 */
export function saveErrorMessage(text: string, sqlstate?: string): string {
  const haystack = sqlstate === "PT409" ? `notification_sequence_conflict ${text}` : text;
  for (const [code, message] of SAVE_ERROR_MESSAGES) {
    if (haystack.includes(code)) return message;
  }
  return "Couldn't save the notification settings. Check the fields and try again.";
}

/* --------------------------- Concurrent editors ---------------------------- */

export interface ReconcileInput {
  /** The saved config the open draft started from; undefined for a starter. */
  base: NotificationSequenceConfig | undefined;
  /** What the server has now. */
  saved: NotificationSequenceConfig | undefined;
  /** The open draft; null when the editor shows "Set up". */
  draft: SequenceDraft | null;
  /** The revision this editor's own last save produced, if any. */
  ownSavedRevision: number | null;
  /** As for draftFromSequence. */
  digestCcAllowed?: boolean;
}

/**
 * What the editor does when the server's copy moves under it:
 *
 *   in_sync       the server still has what the draft started from.
 *   adopt_server  reload the draft from the server: nothing unsaved would be
 *                 lost (the draft is untouched, already equals the server's
 *                 copy, or the change is this editor's own save).
 *   keep_draft    someone else saved while this draft has unsaved edits.
 *                 Keep the edits and say so; saving then sends the old
 *                 revision and gets the conflict, as designed.
 */
export function reconcileWithServer(
  input: ReconcileInput,
): "in_sync" | "adopt_server" | "keep_draft" {
  const { base, saved, draft, ownSavedRevision } = input;
  const options = { digestCcAllowed: input.digestCcAllowed };
  if (base?.revision === saved?.revision) return "in_sync";
  if (draft == null) return "adopt_server";
  if (base && draftsEqual(draft, draftFromSequence(base, options))) return "adopt_server";
  if (saved && draftsEqual(draft, draftFromSequence(saved, options))) return "adopt_server";
  if (saved && ownSavedRevision != null && saved.revision === ownSavedRevision) {
    return "adopt_server";
  }
  return "keep_draft";
}

/**
 * Which arrow to focus after a step's message moves to `destIndex`: the same
 * direction, so a second press keeps moving it, unless that arrow is disabled
 * at the top or bottom, then the other one.
 */
export function stepMoveFocusTarget(
  destIndex: number,
  direction: -1 | 1,
  stepCount: number,
): "up" | "down" {
  if (direction === -1) return destIndex === 0 ? "down" : "up";
  return destIndex === stepCount - 1 ? "up" : "down";
}

/* ---------------------- Resolution (org row + default) --------------------- */

/** A step as it will actually go out. */
export interface EffectiveStep {
  position: number;
  offsetDays: number;
  channel: NotificationChannel;
  templateKey: string;
  /** Empty for Minted's default steps, and for the digest unless Minted allows a cc list. */
  ccRecipients: NotificationCcRecipient[];
}

/**
 * The settings an org can leave to Minted's default. The digest's schedule
 * is not one: it has no default (G2), so it is the org's or not set up.
 */
export type InheritableSetting =
  "steps" | "stopConditions" | "targetDaysToReady" | "bounceEscalationStep" | "digestCcAllowed";

/**
 * One purpose as it applies to one org: its own values where it set them,
 * Minted's default everywhere else. A setting that does not apply to the
 * purpose is empty ([] / null / false) and never inherited.
 */
export interface EffectiveNotificationSequence {
  purpose: NotificationPurpose;
  /** On or off: false with no row; never inherited; only Minted sets it (A9). */
  enabled: boolean;
  steps: EffectiveStep[];
  /** Intake; [] for the digest. */
  stopConditions: NotificationStopCondition[];
  /** Intake; null for the digest. */
  targetDaysToReady: number | null;
  /**
   * Intake: the step whose bounce escalates to its own cc list
   * (bounceEscalationRecipients); BOUNCE_ESCALATION_OFF for none. null for
   * the digest, which has no bounce rule.
   */
  bounceEscalationStep: number | null;
  /**
   * Whether the steps may carry a cc list: always for intake; for the digest,
   * digest_cc_allowed, the org's override (Minted sets it) else Minted's
   * default (off: coordinators only).
   */
  ccAllowed: boolean;
  /*
   * The digest's schedule, all five from the org's row (digestScheduleOf):
   * set together, or all null. Null means not set up: Minted has not set the
   * digest up for this org (G2: there is no default), so it is not due. Also
   * null for intake.
   */
  /** Digest: daily, weekly or twice a day (A8). */
  digestFrequency: DigestFrequency | null;
  /** Digest: the weekly ISO weekday (1 = Monday). */
  digestWeekday: number | null;
  /** Digest: the local hour (0 to 23). */
  sendHour: number | null;
  /** Digest: the IANA zone of sendHour, always one this runtime can use. */
  sendTimeZone: string | null;
  /** Digest: the twice-a-day second hour, later than sendHour. */
  secondSendHour: number | null;
  /** True where the value is Minted's default rather than the org's own. */
  inherited: Record<InheritableSetting, boolean>;
}

function sortedByPosition<T extends { position: number }>(steps: readonly T[]): T[] {
  return [...steps].sort((a, b) => a.position - b.position);
}

/** The org's value when it set one, else the default's, and whether it was inherited. */
function inherit<T>(own: T | null | undefined, fallback: T | null): [T | null, boolean] {
  return own != null ? [own, false] : [fallback, true];
}

/** The digest's schedule on an org row (A10, G2): Minted sets all five together. */
export interface DigestScheduleSettings {
  digestFrequency: DigestFrequency;
  digestWeekday: number;
  sendHour: number;
  sendTimeZone: string;
  secondSendHour: number;
}

type DigestScheduleFields = Pick<
  NotificationSequence,
  "digestFrequency" | "digestWeekday" | "sendHour" | "sendTimeZone" | "secondSendHour"
>;

function isHour(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 23;
}

/**
 * An org's digest schedule when Minted has set it up: all five values, each
 * usable here. Null when the row (or the org) has none, which means not set
 * up (G2: there is no default to fall back to, so the digest is not due), and
 * also when any value is unusable: a stored zone this runtime cannot format in
 * (the database checks it on write, but tzdata can change under a stored row),
 * or a second hour not after the first. It never throws.
 */
export function digestScheduleOf(
  org: Partial<DigestScheduleFields> | null | undefined,
): DigestScheduleSettings | null {
  if (!org) return null;
  const { digestFrequency, digestWeekday, sendHour, sendTimeZone, secondSendHour } = org;
  if (!isDigestFrequency(digestFrequency) || !isIsoWeekday(digestWeekday)) return null;
  if (!isHour(sendHour) || sendTimeZone == null || !isIanaTimeZone(sendTimeZone)) return null;
  if (!isHour(secondSendHour) || secondSendHour <= sendHour) return null;
  return { digestFrequency, digestWeekday, sendHour, sendTimeZone, secondSendHour };
}

/**
 * Plain-language problems with an org's digest schedule (A10, G2): all five
 * values together, or none (none: not set up); each of the right shape; the
 * second hour later than the first. Mission Control runs it before saving a
 * schedule for an org; the database refuses the same shapes.
 */
export function validateDigestSchedule(layer: {
  digestFrequency?: unknown;
  digestWeekday?: unknown;
  sendHour?: unknown;
  sendTimeZone?: unknown;
  secondSendHour?: unknown;
}): string[] {
  const values = [
    layer.digestFrequency,
    layer.digestWeekday,
    layer.sendHour,
    layer.sendTimeZone,
    layer.secondSendHour,
  ];
  const set = values.filter((v) => v != null).length;
  if (set === 0) return [];
  const errors: string[] = [];
  if (set !== values.length) {
    errors.push(
      "Set how often, the weekly day, the send hour, the time zone and the second send hour together, or none of them.",
    );
  }
  if (layer.digestFrequency != null && !isDigestFrequency(layer.digestFrequency)) {
    errors.push("The digest goes out daily, weekly or twice a day.");
  }
  if (layer.digestWeekday != null && !isIsoWeekday(layer.digestWeekday)) {
    errors.push("The weekly digest's day must be Monday (1) to Sunday (7).");
  }
  if (layer.sendHour != null && !isHour(layer.sendHour)) {
    errors.push("The send hour must be a whole hour from 0 to 23.");
  }
  if (
    layer.sendTimeZone != null &&
    (typeof layer.sendTimeZone !== "string" || !isIanaTimeZone(layer.sendTimeZone))
  ) {
    errors.push("The time zone must be an IANA zone such as America/Chicago.");
  }
  if (layer.secondSendHour != null) {
    if (!isHour(layer.secondSendHour)) {
      errors.push("The second send hour must be a whole hour from 0 to 23.");
    } else if (isHour(layer.sendHour) && layer.secondSendHour <= layer.sendHour) {
      errors.push("The second send hour must be later than the first.");
    }
  }
  return errors;
}

/**
 * The effective sequence for one purpose: the org's row (or none) over
 * Minted's default. Field by field, a null org value takes the default's; an
 * org with no steps of its own takes the default steps, which cc no one.
 * `enabled` comes from the org's row alone, so a default cannot switch an
 * org on. The digest's schedule comes from the org's row alone too
 * (digestScheduleOf, G2): when the row sets none, digestFrequency,
 * digestWeekday, sendHour, sendTimeZone and secondSendHour are all null,
 * which means not set up and not due. The policy settings resolve field by
 * field through resolveNotificationPolicyRules (the org's row over Minted's
 * default). Throws when the rows are for a different purpose.
 */
export function resolveNotificationSequence(
  purpose: NotificationPurpose,
  org: NotificationSequenceConfig | undefined,
  platformDefault: NotificationSequenceDefaultConfig,
): EffectiveNotificationSequence {
  if (platformDefault.purpose !== purpose || (org && org.purpose !== purpose)) {
    throw new RangeError(`Notification settings are not for ${purpose}`);
  }
  const rules = PURPOSE_RULES[purpose];
  const policy = resolveNotificationPolicyRules(
    {
      bounceEscalationStep: platformDefault.bounceEscalationStep,
      digestCcAllowed: platformDefault.digestCcAllowed,
    },
    {
      bounceEscalationStep: org?.bounceEscalationStep,
      digestCcAllowed: org?.digestCcAllowed,
    },
  );
  const ccAllowed = purposeAllowsCc(purpose, policy);
  const ownSteps = org != null && org.steps.length > 0;
  const steps: EffectiveStep[] = (ownSteps ? sortedByPosition(org.steps) : []).map((step) => ({
    position: step.position,
    offsetDays: step.offsetDays,
    channel: step.channel,
    templateKey: step.templateKey,
    // The database refuses a digest cc unless Minted allows one; never pass
    // one on regardless.
    ccRecipients: ccAllowed ? step.ccRecipients.map((r) => ({ ...r })) : [],
  }));
  if (!ownSteps) {
    for (const step of sortedByPosition(platformDefault.steps)) {
      steps.push({
        position: step.position,
        offsetDays: step.offsetDays,
        channel: step.channel,
        templateKey: step.templateKey,
        ccRecipients: [],
      });
    }
  }

  const none: [null, false] = [null, false];
  const intake = rules.hasIntakeSettings;
  const [stopConditions, stopsInherited] = intake
    ? inherit(org?.stopConditions, platformDefault.stopConditions)
    : none;
  const [targetDaysToReady, targetInherited] = intake
    ? inherit(org?.targetDaysToReady, platformDefault.targetDaysToReady)
    : none;
  const [bounceEscalationStep, bounceInherited]: [number | null, boolean] = intake
    ? [policy.bounceEscalationStep, !isBounceEscalationStep(org?.bounceEscalationStep)]
    : none;
  const digest = purpose === "followup_digest";
  const digestCcInherited = digest && typeof org?.digestCcAllowed !== "boolean";
  // G2: the org's own schedule, or none (not set up, so not due).
  const schedule = rules.hasSendTime ? digestScheduleOf(org) : null;

  return {
    purpose,
    enabled: org?.enabled ?? false,
    steps,
    stopConditions: stopConditions ? STOP_CONDITIONS.filter((c) => stopConditions.includes(c)) : [],
    targetDaysToReady,
    bounceEscalationStep,
    ccAllowed,
    digestFrequency: schedule?.digestFrequency ?? null,
    digestWeekday: schedule?.digestWeekday ?? null,
    sendHour: schedule?.sendHour ?? null,
    sendTimeZone: schedule?.sendTimeZone ?? null,
    secondSendHour: schedule?.secondSendHour ?? null,
    inherited: {
      steps: !ownSteps,
      stopConditions: stopsInherited,
      targetDaysToReady: targetInherited,
      bounceEscalationStep: bounceInherited,
      digestCcAllowed: digestCcInherited,
    },
  };
}

const FREQUENCY_WHEN: Record<DigestFrequency, string> = {
  daily: "once a day",
  weekly: "once a week",
  twice_daily: "twice a day",
};

/**
 * "Step 1 · day 1 after the invite · Email · First reminder" for the
 * read-only views. A digest step names how often it goes out, and nothing
 * when the digest is not set up (no frequency, G2).
 */
export function describeStep(
  purpose: NotificationPurpose,
  step: Pick<EffectiveStep, "position" | "offsetDays" | "channel" | "templateKey">,
  digestFrequency: DigestFrequency | null = null,
): string {
  const when =
    PURPOSE_RULES[purpose].fixedOffsetDays == null
      ? `day ${step.offsetDays} after the invite`
      : digestFrequency
        ? FREQUENCY_WHEN[digestFrequency]
        : null;
  const label = getNotificationTemplate(step.templateKey)?.label ?? step.templateKey;
  return [`Step ${step.position}`, when, CHANNEL_LABELS[step.channel], label]
    .filter((part) => part != null)
    .join(" · ");
}

/* ------------------------------- Send time --------------------------------- */

/** Same pattern as private.notification_time_zone_valid in migration 20261101110100. */
export const IANA_TIME_ZONE_PATTERN = /^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2})$/;

/** True for an IANA zone name ("America/Chicago") that this runtime can format in. */
export function isIanaTimeZone(zone: string): boolean {
  if (!IANA_TIME_ZONE_PATTERN.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Plain names for the US zones Minted's customers work in. */
const US_ZONE_NAMES: Readonly<Record<string, string>> = {
  "America/New_York": "Eastern",
  "America/Detroit": "Eastern",
  "America/Indiana/Indianapolis": "Eastern",
  "America/Chicago": "Central",
  "America/Denver": "Mountain",
  "America/Boise": "Mountain",
  "America/Phoenix": "Arizona",
  "America/Los_Angeles": "Pacific",
  "America/Anchorage": "Alaska",
  "Pacific/Honolulu": "Hawaii",
};

function timeZoneName(zone: string): string {
  const known = US_ZONE_NAMES[zone];
  if (known) return `${known} time`;
  if (isIanaTimeZone(zone)) {
    // A fixed instant: the generic name ("Central European Time") does not
    // depend on the date, and a pure lib never reads the clock.
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" })
      .formatToParts(new Date(Date.UTC(2026, 0, 1)))
      .find((p) => p.type === "timeZoneName")?.value;
    if (part) return part.replace(/ Time$/, " time");
  }
  return `${zone} time`;
}

function hourLabel(hour: number): string {
  if (hour === 0) return "12 am";
  if (hour === 12) return "12 pm";
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

const WEEKDAY_PLURALS = [
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
  "Sundays",
];

/** The card's line for an org whose digest Minted has not set up (G2). */
export const DIGEST_NOT_SET_UP_NOTE =
  "Not set up. Minted sets up the follow-up digest for your organization.";

/**
 * The digest's read-only schedule line, built from its settings (A8). Minted
 * sets all of them per org (Addendum 10, G2), so the line names how often as
 * well as when: "Sent once a day, around 8 am Central time. Minted sets
 * this." (daily), "Sent once a week, on Mondays around 8 am Central time.
 * Minted sets this." (weekly), "Sent twice a day, around 8 am and 2 pm
 * Central time. Minted sets this." (twice a day). DIGEST_NOT_SET_UP_NOTE
 * when the schedule is not set up (digestScheduleOf is null): there is no
 * default to show.
 */
export function describeDigestSchedule(schedule: Partial<DigestScheduleFields>): string {
  const set = digestScheduleOf(schedule);
  if (!set) return DIGEST_NOT_SET_UP_NOTE;
  const first = `${hourLabel(set.sendHour)} ${timeZoneName(set.sendTimeZone)}`;
  const how = `Sent ${FREQUENCY_WHEN[set.digestFrequency]}`;
  if (set.digestFrequency === "weekly") {
    return `${how}, on ${WEEKDAY_PLURALS[set.digestWeekday - 1]} around ${first}. Minted sets this.`;
  }
  if (set.digestFrequency === "twice_daily") {
    return `${how}, around ${hourLabel(set.sendHour)} and ${hourLabel(set.secondSendHour)} ${timeZoneName(set.sendTimeZone)}. Minted sets this.`;
  }
  return `${how}, around ${first}. Minted sets this.`;
}

/* ------------------------------ Bounce rule -------------------------------- */

/**
 * Decision 4, as a setting: when the escalating step of an intake reminder
 * (bounceEscalationStep, step 1 by default) bounces, the people cc'd on that
 * step are told (with the bounce notice template), in their saved order. No
 * other bounce escalates; with escalation off (0) none does; and the digest
 * has no bounce rule. An empty cc list means a bounce reaches no one, which
 * the card warns about. Pass the effective sequence
 * (resolveNotificationSequence): Minted's default steps cc no one.
 */
export function bounceEscalationRecipients(
  sequence: Pick<EffectiveNotificationSequence, "purpose" | "bounceEscalationStep"> & {
    steps: ReadonlyArray<{ position: number; ccRecipients: readonly NotificationCcRecipient[] }>;
  },
  bouncedPosition: number,
): NotificationCcRecipient[] {
  const escalating = sequence.bounceEscalationStep;
  if (
    sequence.purpose !== "intake_reminder" ||
    escalating == null ||
    escalating === BOUNCE_ESCALATION_OFF ||
    bouncedPosition !== escalating
  ) {
    return [];
  }
  const step = sequence.steps.find((s) => s.position === escalating);
  return step ? [...step.ccRecipients] : [];
}

/**
 * The bounce escalation step an intake draft would save: its own, else
 * Minted's default, else the decided step 1. The card's bounce notes read it.
 */
export function draftBounceEscalationStep(
  draft: Pick<SequenceDraft, "bounceEscalationStep">,
  platformDefault: Pick<NotificationSequenceDefault, "bounceEscalationStep">,
): number {
  return resolveNotificationPolicyRules(
    { bounceEscalationStep: platformDefault.bounceEscalationStep },
    { bounceEscalationStep: draft.bounceEscalationStep },
  ).bounceEscalationStep;
}

/* ------------------------------ Intake schedule ----------------------------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function toUtcDay(iso: string): number {
  if (!ISO_DATE.test(iso)) throw new RangeError(`Expected a YYYY-MM-DD date, got "${iso}"`);
  const [y, m, d] = iso.split("-").map(Number);
  const time = Date.UTC(y, m - 1, d);
  const check = new Date(time);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`"${iso}" is not a calendar date`);
  }
  return time / DAY_MS;
}

function fromUtcDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export interface ScheduleInput {
  /** Configured offsets in position order; must strictly increase, each day 1 or later. */
  offsets: readonly number[];
  /** The invite date (YYYY-MM-DD). */
  inviteDate: string;
  targetDaysToReady: number;
}

export interface ScheduledSend {
  position: number;
  /** Days after the invite this step goes out. */
  offsetDays: number;
  sendOn: string;
}

export interface ScheduleResult {
  /** When the provider should be ready: the invite plus the target. */
  readyBy: string;
  sends: ScheduledSend[];
}

/**
 * The send dates for a sequence's steps: step i goes out `offsets[i]` days
 * after the invite, and never on the invite day (A12). There is no
 * start-date compression: it was removed (A13, which supersedes D56), and a
 * report of providers whose start date is approaching with intake still
 * incomplete replaces it (its own ticket).
 */
export function scheduleSequenceSends(input: ScheduleInput): ScheduleResult {
  const invite = toUtcDay(input.inviteDate);
  const { offsets, targetDaysToReady: target } = input;
  offsets.forEach((offset, i) => {
    if (!Number.isInteger(offset) || offset < 1) {
      throw new RangeError(`Offset ${offset} must be a whole number of days, day 1 or later`);
    }
    if (i > 0 && offset <= offsets[i - 1]) throw new RangeError("Offsets must strictly increase");
  });
  if (!Number.isInteger(target) || target < 1) {
    throw new RangeError("Target days must be a whole number of at least 1");
  }
  return {
    readyBy: fromUtcDay(invite + target),
    sends: offsets.map((offset, i) => ({
      position: i + 1,
      offsetDays: offset,
      sendOn: fromUtcDay(invite + offset),
    })),
  };
}

/** "day 1, day 2 and day 3" for the card's one-line schedule summary. */
export function describeOffsets(offsets: readonly number[]): string {
  const parts = offsets.map((offset) => `day ${offset}`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
