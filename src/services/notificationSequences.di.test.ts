import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { buildSavePayload, starterDraft, type SequenceDraft } from "@/lib/notificationSequences";
import {
  listNotificationSequences,
  saveNotificationSequence,
  type NotificationSequenceServiceCtx,
} from "./notificationSequences";

// Every call here goes through the injected ctx.db. The mock only keeps the
// module-level browser client from being built, which throws in CI's build
// job where VITE_SUPABASE_* is unset.
vi.mock("@/integrations/supabase/externalClient", () => ({ supabase: {} }));

const ORG = "66666666-6666-4666-8666-666666666666";
const USER = "11111111-1111-4111-8111-111111111111";

const SEQUENCE_ROW = {
  id: "seq-1",
  org_id: ORG,
  purpose: "intake_reminder",
  enabled: true,
  stop_conditions: ["submitted", "withdrawn"],
  target_days_to_ready: 14,
  send_hour: null,
  send_time_zone: null,
  revision: 3,
  created_at: "2026-10-30T00:00:00Z",
  updated_at: "2026-10-30T01:00:00Z",
  updated_by: USER,
};

// Minted's seeded defaults, as PostgREST returns them. The digest's has no
// schedule (G2): its frequency and send time exist only on an org row.
const DEFAULT_ROWS = [
  {
    purpose: "intake_reminder",
    stop_conditions: ["submitted", "paused", "withdrawn", "provider_replied"],
    target_days_to_ready: 14,
    created_at: "2026-10-31T00:00:00Z",
    updated_at: "2026-10-31T00:00:00Z",
  },
  {
    purpose: "followup_digest",
    stop_conditions: null,
    target_days_to_ready: null,
    created_at: "2026-10-31T00:00:00Z",
    updated_at: "2026-10-31T00:00:00Z",
  },
];
const defaultStep = (purpose: string, position: number, offset: number, key: string) => ({
  id: `${purpose}-${position}`,
  purpose,
  position,
  offset_days: offset,
  channel: "email",
  template_key: key,
  created_at: "2026-10-31T00:00:00Z",
  updated_at: "2026-10-31T00:00:00Z",
});
const DEFAULT_STEP_ROWS = [
  defaultStep("intake_reminder", 3, 3, "intake_reminder_final"),
  defaultStep("intake_reminder", 1, 1, "intake_reminder_first"),
  defaultStep("intake_reminder", 2, 2, "intake_reminder_second"),
  defaultStep("followup_digest", 1, 0, "followup_digest_daily"),
];
const WITH_DEFAULTS = {
  notification_sequence_defaults: DEFAULT_ROWS,
  notification_sequence_default_steps: DEFAULT_STEP_ROWS,
};

/** An intake draft with its own steps, from the seeded default (days 1, 2 and 3). */
const OWN_INTAKE: SequenceDraft = {
  ...starterDraft(),
  steps: [1, 2, 3].map((offsetDays, i) => ({
    offsetDays,
    channel: "email",
    templateKey: ["intake_reminder_first", "intake_reminder_second", "intake_reminder_final"][i],
    ccRecipients: [],
  })),
};

const stepRow = (position: number, offset: number, cc: unknown = []) => ({
  id: `step-${position}`,
  sequence_id: "seq-1",
  org_id: ORG,
  position,
  offset_days: offset,
  channel: "email",
  template_key: "intake_reminder_first",
  cc_recipients: cc,
  created_at: "2026-10-30T00:00:00Z",
  updated_at: "2026-10-30T00:00:00Z",
});

function ctxFor(db: unknown): NotificationSequenceServiceCtx {
  return { db: db as SupabaseClient<Database>, orgId: ORG };
}

type FakeError = { code: string; message: string };

function fakeReads(tables: Record<string, unknown[]>, errors: Record<string, FakeError> = {}) {
  type Call = { table: string; filters: Array<[string, unknown]>; order?: string; select?: string };
  const calls: Call[] = [];
  const from = vi.fn((table: string) => {
    const call: Call = { table, filters: [] };
    calls.push(call);
    const builder = {
      select: (columns?: string) => {
        call.select = columns;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return builder;
      },
      order: (column: string) => {
        call.order = column;
        return builder;
      },
      then: (resolve: (value: { data: unknown[] | null; error: FakeError | null }) => void) =>
        resolve(
          errors[table]
            ? { data: null, error: errors[table] }
            : { data: tables[table] ?? [], error: null },
        ),
    };
    return builder;
  });
  return { from, calls };
}

describe("notification sequences service", () => {
  it("reads the org's tables scoped to the org and assembles steps in position order", async () => {
    const { from, calls } = fakeReads({
      ...WITH_DEFAULTS,
      notification_sequences: [SEQUENCE_ROW],
      notification_sequence_steps: [
        stepRow(2, 6, [{ kind: "role", role: "admin" }]),
        stepRow(1, 2, [{ kind: "user", user_id: USER }]),
      ],
    });
    const listed = await listNotificationSequences(ctxFor({ from }));
    expect(listed.status).toBe("available");
    const result = listed.status === "available" ? listed.sequences : {};

    expect(calls.map((c) => c.table)).toEqual([
      "notification_sequences",
      "notification_sequence_steps",
      "notification_sequence_defaults",
      "notification_sequence_default_steps",
    ]);
    // The org's rows are filtered to the org; Minted's defaults have no org.
    expect(calls[0].filters).toContainEqual(["org_id", ORG]);
    expect(calls[1].filters).toContainEqual(["org_id", ORG]);
    expect(calls[2].filters).toEqual([]);
    expect(calls[3].filters).toEqual([]);
    expect(result.followup_digest).toBeUndefined();
    expect(result.intake_reminder).toMatchObject({
      id: "seq-1",
      enabled: true,
      revision: 3,
      stopConditions: ["submitted", "withdrawn"],
      targetDaysToReady: 14,
      sendHour: null,
      sendTimeZone: null,
    });
    expect(result.intake_reminder?.steps.map((s) => [s.position, s.offsetDays])).toEqual([
      [1, 2],
      [2, 6],
    ]);
    expect(result.intake_reminder?.steps[0].ccRecipients).toEqual([{ kind: "user", userId: USER }]);
    expect(result.intake_reminder?.steps[1].ccRecipients).toEqual([
      { kind: "role", role: "admin" },
    ]);
  });

  it("returns no entry for a purpose with no row (off), and Minted's defaults (answer 3)", async () => {
    const { from, calls } = fakeReads({
      ...WITH_DEFAULTS,
      notification_sequences: [],
      notification_sequence_steps: [],
    });
    const listed = await listNotificationSequences(ctxFor({ from }));
    if (listed.status !== "available") throw new Error("expected available");
    expect(listed.sequences).toEqual({});
    expect(listed.defaults.intake_reminder).toMatchObject({
      purpose: "intake_reminder",
      stopConditions: ["submitted", "paused", "withdrawn", "provider_replied"],
      targetDaysToReady: 14,
    });
    expect(listed.defaults.intake_reminder.steps.map((s) => [s.position, s.offsetDays])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(listed.defaults.followup_digest).toMatchObject({ stopConditions: null });
    // G2: a default carries no schedule, so there is nothing to inherit, and
    // the read names none of those columns (they are not on the table).
    const defaultsRead = calls.find((c) => c.table === "notification_sequence_defaults");
    expect(defaultsRead?.select).toMatch(/digest_cc_allowed/);
    expect(defaultsRead?.select).not.toMatch(
      /send_hour|send_time_zone|second_send_hour|digest_frequency|digest_weekday/,
    );
    for (const key of [
      "sendHour",
      "sendTimeZone",
      "secondSendHour",
      "digestFrequency",
      "digestWeekday",
    ]) {
      expect(key in listed.defaults.followup_digest).toBe(false);
    }
    expect(listed.defaults.followup_digest.steps.map((s) => s.templateKey)).toEqual([
      "followup_digest_daily",
    ]);
  });

  it("keeps an org's unset settings as null, so they inherit, and reads the schedule Minted set", async () => {
    const { from } = fakeReads({
      ...WITH_DEFAULTS,
      notification_sequences: [
        { ...SEQUENCE_ROW, stop_conditions: null, target_days_to_ready: null },
        {
          ...SEQUENCE_ROW,
          id: "seq-2",
          purpose: "followup_digest",
          stop_conditions: null,
          target_days_to_ready: null,
          send_hour: 6,
          send_time_zone: "America/New_York",
          second_send_hour: 15,
          digest_frequency: "weekly",
          digest_weekday: 3,
        },
      ],
      notification_sequence_steps: [],
    });
    const listed = await listNotificationSequences(ctxFor({ from }));
    if (listed.status !== "available") throw new Error("expected available");
    expect(listed.sequences.intake_reminder).toMatchObject({
      stopConditions: null,
      targetDaysToReady: null,
      steps: [],
    });
    expect(listed.sequences.followup_digest).toMatchObject({
      sendHour: 6,
      sendTimeZone: "America/New_York",
      secondSendHour: 15,
      digestFrequency: "weekly",
      digestWeekday: 3,
    });
  });

  it("fails loudly when a default has no steps, or the digest more than one", async () => {
    const empty = fakeReads({
      notification_sequence_defaults: DEFAULT_ROWS,
      notification_sequence_default_steps: DEFAULT_STEP_ROWS.filter(
        (row) => row.purpose !== "intake_reminder",
      ),
    });
    await expect(listNotificationSequences(ctxFor({ from: empty.from }))).rejects.toThrow(
      /default notification steps are incomplete \(intake_reminder\)/,
    );
    const twoDigest = fakeReads({
      notification_sequence_defaults: DEFAULT_ROWS,
      notification_sequence_default_steps: [
        ...DEFAULT_STEP_ROWS,
        defaultStep("followup_digest", 2, 1, "followup_digest_daily"),
      ],
    });
    await expect(listNotificationSequences(ctxFor({ from: twoDigest.from }))).rejects.toThrow(
      /default notification steps are incomplete \(followup_digest\)/,
    );
  });

  it("fails loudly when a default is missing rather than calling the purpose off", async () => {
    const { from } = fakeReads({
      notification_sequence_defaults: [DEFAULT_ROWS[0]],
      notification_sequence_default_steps: DEFAULT_STEP_ROWS,
    });
    await expect(listNotificationSequences(ctxFor({ from }))).rejects.toThrow(
      /default notification settings are missing \(followup_digest\)/,
    );
  });

  it("reports the feature unavailable, without throwing, before the migration is applied", async () => {
    const missingSequences = fakeReads(
      {},
      {
        notification_sequences: {
          code: "PGRST205",
          message: "Could not find the table 'public.notification_sequences' in the schema cache",
        },
        notification_sequence_steps: {
          code: "PGRST205",
          message:
            "Could not find the table 'public.notification_sequence_steps' in the schema cache",
        },
      },
    );
    await expect(
      listNotificationSequences(ctxFor({ from: missingSequences.from })),
    ).resolves.toEqual({ status: "unavailable" });
    const missingSteps = fakeReads(
      { notification_sequences: [] },
      {
        notification_sequence_steps: {
          code: "42P01",
          message: 'relation "public.notification_sequence_steps" does not exist',
        },
      },
    );
    await expect(listNotificationSequences(ctxFor({ from: missingSteps.from }))).resolves.toEqual({
      status: "unavailable",
    });
    // Only the defaults table missing is the same: not switched on yet.
    const missingDefaults = fakeReads(
      { notification_sequences: [], notification_sequence_steps: [] },
      {
        notification_sequence_defaults: {
          code: "PGRST205",
          message:
            "Could not find the table 'public.notification_sequence_defaults' in the schema cache",
        },
      },
    );
    await expect(
      listNotificationSequences(ctxFor({ from: missingDefaults.from })),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("still throws real read failures", async () => {
    const denied = fakeReads(
      {},
      {
        notification_sequences: {
          code: "42501",
          message: "permission denied for table notification_sequences",
        },
      },
    );
    await expect(listNotificationSequences(ctxFor({ from: denied.from }))).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("saves through the atomic RPC with the org, purpose and built payload", async () => {
    const payload = buildSavePayload("intake_reminder", OWN_INTAKE, null);
    const rpc = vi.fn().mockResolvedValue({
      data: { sequence: { ...SEQUENCE_ROW, revision: 1 }, steps: [stepRow(1, 2)] },
      error: null,
    });
    const saved = await saveNotificationSequence(
      { purpose: "intake_reminder", payload },
      ctxFor({ rpc }),
    );
    expect(rpc).toHaveBeenCalledWith("save_notification_sequence", {
      p_org_id: ORG,
      p_purpose: "intake_reminder",
      p_payload: payload,
    });
    expect(saved.revision).toBe(1);
    expect(saved.steps).toHaveLength(1);
  });

  it("turns the RPC's conflict and permission codes into plain messages", async () => {
    const payload = buildSavePayload("intake_reminder", OWN_INTAKE, 2);
    const conflict = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "PT409", message: "notification_sequence_conflict" },
    });
    await expect(
      saveNotificationSequence({ purpose: "intake_reminder", payload }, ctxFor({ rpc: conflict })),
    ).rejects.toThrow(/Someone else saved these settings/);

    // PT409 alone (PostgREST's HTTP 409) is the conflict, whatever the text.
    const bareConflict = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "PT409", message: "" },
    });
    await expect(
      saveNotificationSequence(
        { purpose: "intake_reminder", payload },
        ctxFor({ rpc: bareConflict }),
      ),
    ).rejects.toThrow(/Someone else saved these settings/);

    const denied = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "42501", message: "notification_sequence_not_authorized" },
    });
    await expect(
      saveNotificationSequence({ purpose: "intake_reminder", payload }, ctxFor({ rpc: denied })),
    ).rejects.toThrow("Only admins can change notifications.");

    const platform = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "42501", message: "notification_platform_setting: send_hour" },
    });
    await expect(
      saveNotificationSequence({ purpose: "followup_digest", payload }, ctxFor({ rpc: platform })),
    ).rejects.toThrow("Minted sets that setting, so it can't be changed here.");
  });

  it("saves 'use Minted's default' as nulls, with no platform-managed key", async () => {
    const payload = buildSavePayload("intake_reminder", starterDraft(), 3);
    const rpc = vi.fn().mockResolvedValue({
      data: {
        sequence: {
          ...SEQUENCE_ROW,
          stop_conditions: null,
          target_days_to_ready: null,
          revision: 4,
        },
        steps: [],
      },
      error: null,
    });
    const saved = await saveNotificationSequence(
      { purpose: "intake_reminder", payload },
      ctxFor({ rpc }),
    );
    expect(rpc.mock.calls[0][1].p_payload).toEqual({
      stop_conditions: null,
      target_days_to_ready: null,
      expected_revision: 3,
      steps: null,
    });
    expect(saved).toMatchObject({ stopConditions: null, targetDaysToReady: null, steps: [] });
  });

  it("reads the policy settings, and a row without them as unset (inherit)", async () => {
    const { from, calls } = fakeReads({
      notification_sequence_defaults: [
        { ...DEFAULT_ROWS[0], bounce_escalation_step: 1, digest_cc_allowed: null },
        { ...DEFAULT_ROWS[1], bounce_escalation_step: null, digest_cc_allowed: false },
      ],
      notification_sequence_default_steps: DEFAULT_STEP_ROWS,
      notification_sequences: [
        { ...SEQUENCE_ROW, bounce_escalation_step: 0 },
        {
          ...SEQUENCE_ROW,
          id: "seq-digest",
          purpose: "followup_digest",
          stop_conditions: null,
          target_days_to_ready: null,
          digest_cc_allowed: true,
        },
      ],
      notification_sequence_steps: [],
    });
    const listed = await listNotificationSequences(ctxFor({ from }));
    if (listed.status !== "available") throw new Error("expected available");
    expect(calls.map((c) => c.table)).toContain("notification_sequence_defaults");
    expect(listed.defaults.intake_reminder).toMatchObject({
      bounceEscalationStep: 1,
      digestCcAllowed: null,
    });
    expect(listed.defaults.followup_digest).toMatchObject({
      bounceEscalationStep: null,
      digestCcAllowed: false,
    });
    expect(listed.sequences.intake_reminder?.bounceEscalationStep).toBe(0);
    expect(listed.sequences.followup_digest?.digestCcAllowed).toBe(true);

    // Rows from a reader that does not select the columns: unset, not undefined.
    const bareReads = fakeReads({
      ...WITH_DEFAULTS,
      notification_sequences: [SEQUENCE_ROW],
      notification_sequence_steps: [],
    });
    const bare = await listNotificationSequences(ctxFor({ from: bareReads.from }));
    if (bare.status !== "available") throw new Error("expected available");
    expect(bare.defaults.intake_reminder.bounceEscalationStep).toBeNull();
    expect(bare.defaults.followup_digest.digestCcAllowed).toBeNull();
    expect(bare.sequences.intake_reminder?.bounceEscalationStep).toBeNull();
    expect(bare.sequences.intake_reminder?.digestCcAllowed).toBeNull();
  });

  it("sends the org's own bounce escalation step through the RPC", async () => {
    const payload = buildSavePayload(
      "intake_reminder",
      { ...starterDraft(), bounceEscalationStep: 2 },
      3,
    );
    const rpc = vi.fn().mockResolvedValue({
      data: {
        sequence: { ...SEQUENCE_ROW, bounce_escalation_step: 2, revision: 4 },
        steps: [],
      },
      error: null,
    });
    const saved = await saveNotificationSequence(
      { purpose: "intake_reminder", payload },
      ctxFor({ rpc }),
    );
    expect(rpc.mock.calls[0][1].p_payload).toMatchObject({ bounce_escalation_step: 2 });
    expect(saved.bounceEscalationStep).toBe(2);
  });
});
