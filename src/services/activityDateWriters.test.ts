// MINT-129 — the browser's activity writes follow ActivityDateRules: the
// viewer's day by default (localActivityDates.test.ts pins that), one named
// zone's day when a platform or organization sets one. Pinned at 11:25 PM MDT
// on Oct 19, 2026 in a Denver browser, when Auckland and UTC are on Oct 20.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityDateRules } from "@/lib/activityDate";

const holder = vi.hoisted(() => ({
  writes: [] as Array<{ table: string; op: "update" | "insert"; payload: unknown }>,
  row: {} as Record<string, unknown>,
  rules: null as ActivityDateRules | null,
}));

vi.mock("@/integrations/supabase/externalClient", () => ({
  supabase: {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.update = (payload: unknown) => {
        holder.writes.push({ table, op: "update", payload });
        return builder;
      };
      builder.insert = (payload: unknown) => {
        holder.writes.push({ table, op: "insert", payload });
        return builder;
      };
      builder.single = async () => ({ data: holder.row, error: null });
      builder.maybeSingle = async () => ({ data: holder.row, error: null });
      return builder;
    },
  },
}));
vi.mock("@/lib/audit", () => ({
  currentUserId: () => "user-1",
  requireActiveOrg: () => "org-1",
  writeAudit: vi.fn(),
}));
// Stands in for a stored override: the reader returns what the test sets.
vi.mock("@/lib/activityDate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/activityDate")>();
  return { ...actual, activityDateRules: () => holder.rules ?? actual.activityDateRules() };
});

import { updateTaskStatus } from "./tasks";
import { logNote } from "./touches";

const priorTz = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/Denver";
});

afterAll(() => {
  if (priorTz === undefined) delete process.env.TZ;
  else process.env.TZ = priorTz;
});

beforeEach(() => {
  holder.writes = [];
  holder.row = { id: "task-1", status: "in_progress" };
  holder.rules = null;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T05:25:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

async function completedDate(): Promise<unknown> {
  await updateTaskStatus("task-1", "completed");
  const update = holder.writes.find((w) => w.table === "tasks" && w.op === "update");
  return (update?.payload as { completed_date?: unknown } | undefined)?.completed_date;
}

async function noteDate(): Promise<unknown> {
  holder.row = { id: "touch-1", case_id: "case-1", entry_type: "note" };
  await logNote("case-1", { content: "Called the payer back." });
  const insert = holder.writes.find((w) => w.table === "touches" && w.op === "insert");
  return (insert?.payload as { touch_date?: unknown } | undefined)?.touch_date;
}

describe("activity writes under ActivityDateRules", () => {
  it("runs the zone and the moment the test pins", () => {
    expect(new Date().getTimezoneOffset()).toBe(360);
  });

  it("with no override, a completion and a note take the viewer's day", async () => {
    expect(await completedDate()).toBe("2026-10-19");
    expect(await noteDate()).toBe("2026-10-19");
  });

  it("with the viewer zone set explicitly, nothing changes", async () => {
    holder.rules = { zone: "viewer" };
    expect(await completedDate()).toBe("2026-10-19");
    expect(await noteDate()).toBe("2026-10-19");
  });

  it("with a named zone, both take that zone's day, not the viewer's", async () => {
    holder.rules = { zone: "Pacific/Auckland" };
    expect(await completedDate()).toBe("2026-10-20");
    expect(await noteDate()).toBe("2026-10-20");
  });

  it("reopening a task clears completed_date whatever the zone", async () => {
    holder.rules = { zone: "Pacific/Auckland" };
    await updateTaskStatus("task-1", "in_progress");
    const update = holder.writes.find((w) => w.table === "tasks" && w.op === "update");
    expect(update?.payload).toEqual({ status: "in_progress", completed_date: null });
  });
});
