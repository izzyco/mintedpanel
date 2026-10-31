// MINT-129 — ticking a task's last SOP step sends the day ActivityDateRules
// files an activity under: the viewer's day by default (taskSteps.test.ts pins
// that), one named zone's day when a platform or organization sets one. The
// extension route never sends a date, whatever the rules. Pinned at 11:25 PM
// MDT on Oct 19, 2026 in a Denver browser, when Auckland and UTC are on Oct 20.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { ActivityDateRules } from "@/lib/activityDate";

const holder = vi.hoisted(() => ({ rules: null as ActivityDateRules | null }));

// Stands in for a stored override: the reader returns what the test sets.
vi.mock("@/lib/activityDate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/activityDate")>();
  return { ...actual, activityDateRules: () => holder.rules ?? actual.activityDateRules() };
});

import { completeTaskStep } from "./taskSteps";

const rpc = vi.fn();
const db = { rpc, from: vi.fn() } as unknown as SupabaseClient<Database>;
const context = (source: "panel" | "extension") => ({
  db,
  orgId: "org-a",
  userId: "writer-a",
  source,
});
const priorTz = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/Denver";
});

afterAll(() => {
  if (priorTz === undefined) delete process.env.TZ;
  else process.env.TZ = priorTz;
});

beforeEach(() => {
  holder.rules = null;
  rpc.mockReset();
  rpc.mockResolvedValue({
    data: { kind: "ok", allDone: true, task: { id: "task-1" } },
    error: null,
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T05:25:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

async function sentDate(source: "panel" | "extension"): Promise<Record<string, unknown>> {
  await completeTaskStep(context(source), "task-1", "step-1");
  return rpc.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe("completeTaskStep under ActivityDateRules", () => {
  it("runs the zone the test pins", () => {
    expect(new Date().getTimezoneOffset()).toBe(360);
  });

  it("with no override, or the viewer zone set explicitly, the Panel sends the viewer's day", async () => {
    expect(await sentDate("panel")).toMatchObject({ p_completed_date: "2026-10-19" });
    rpc.mockClear();
    holder.rules = { zone: "viewer" };
    expect(await sentDate("panel")).toMatchObject({ p_completed_date: "2026-10-19" });
  });

  it("with a named zone, the Panel sends that zone's day, not the viewer's", async () => {
    holder.rules = { zone: "Pacific/Auckland" };
    expect(await sentDate("panel")).toMatchObject({ p_completed_date: "2026-10-20" });
  });

  it("the extension route sends no date under any rules", async () => {
    holder.rules = { zone: "Pacific/Auckland" };
    expect(await sentDate("extension")).not.toHaveProperty("p_completed_date");
  });
});
