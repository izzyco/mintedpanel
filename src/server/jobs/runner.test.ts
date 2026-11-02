import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import { validateJobCounts } from "./counts";
import { createJobRegistry, JOB_REGISTRY } from "./registry";
import { jobLogger, runJob } from "./runner";
import type { JobContext, JobCounts, JobDefinition } from "./types";

// MINT-106 runner: run the job, check its counts, and report failures through
// the safe logger. There is no run ledger, so every call runs the job.
const SITE = { method: "GET", route: "/api/jobs/test-job" };
const COUNT_KEYS = ["orgs", "sent"] as const;
const NOW = new Date("2026-10-30T13:00:00Z");
const db = { stand_in: "service client" } as unknown as SupabaseClient<Database>;

let consoleError: MockInstance<(...args: unknown[]) => void>;
beforeEach(() => {
  vi.stubEnv("DEV", false);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  consoleError.mockRestore();
});

function testJob(run: (ctx: JobContext) => Promise<JobCounts>) {
  const spy = vi.fn(run);
  const job: JobDefinition = { name: "test-job", countKeys: COUNT_KEYS, run: spy };
  return { job, spy };
}

function run(job: JobDefinition) {
  return runJob(job, { db, now: NOW, site: SITE });
}

describe("runJob", () => {
  it("hands the job its context and returns its counts", async () => {
    const { job, spy } = testJob(async () => ({ orgs: 3, sent: 2 }));
    const result = await run(job);
    expect(result).toEqual({ job: "test-job", outcome: "succeeded", counts: { orgs: 3, sent: 2 } });
    const ctx = spy.mock.calls[0][0];
    expect(ctx.db).toBe(db);
    expect(ctx.now.toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(ctx.now).not.toBe(NOW);
    expect(Object.keys(ctx).sort()).toEqual(["db", "log", "now"]);
    expect(typeof ctx.log.error).toBe("function");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("runs the job on every call: there is no run ledger", async () => {
    const { job, spy } = testJob(async () => ({ sent: 1 }));
    const outcomes = (await Promise.all([run(job), run(job)])).map((r) => r.outcome);
    expect((await run(job)).outcome).toBe("succeeded");
    expect(outcomes).toEqual(["succeeded", "succeeded"]);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("runJob: failures", () => {
  it("reports a throw as failed with empty counts and returns the log id", async () => {
    const { job } = testJob(async () => {
      throw new Error("boom");
    });
    const result = await run(job);
    expect(result).toMatchObject({ job: "test-job", outcome: "failed", counts: {} });
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(consoleError.mock.calls[0][0])).toBe("[jobs:test-job] run_failed");
    expect(String(consoleError.mock.calls[0][1])).toContain(`"requestId":"${result.requestId}"`);
  });

  it("reports counts that are not JobCounts as failed / invalid_counts", async () => {
    const { job } = testJob(async () => ({ sent: 1.5 }));
    const result = await run(job);
    expect(result).toMatchObject({ outcome: "failed", counts: {} });
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(consoleError.mock.calls[0][0])).toBe("[jobs:test-job] invalid_counts");
    expect(String(consoleError.mock.calls[0][1])).toContain('"errorClass":"InvalidJobCountsError"');
  });

  it("refuses a well-formed key the job did not declare, such as a name", async () => {
    // jane_doe is a valid shape; only the declaration keeps it out.
    expect(validateJobCounts({ jane_doe: 19610412 }, ["jane_doe"])).not.toBeNull();
    const { job } = testJob(async () => ({ jane_doe: 19610412 }));
    const result = await run(job);
    expect(result).toMatchObject({ outcome: "failed", counts: {} });
    const output = JSON.stringify([result, consoleError.mock.calls]);
    expect(output).not.toContain("19610412");
    expect(output).not.toContain("jane_doe");
  });

  it("accepts a subset of the declared keys", async () => {
    const { job } = testJob(async () => ({ sent: 0 }));
    expect(await run(job)).toMatchObject({ outcome: "succeeded", counts: { sent: 0 } });
  });
});

describe("validateJobCounts", () => {
  it("accepts snake_case keys mapped to non-negative safe integers, as a copy", () => {
    const input = { orgs: 3, sent_ok: 0, failed: Number.MAX_SAFE_INTEGER };
    const counts = validateJobCounts(input, ["orgs", "sent_ok", "failed", "unused"]);
    expect(counts).toEqual(input);
    expect(counts).not.toBe(input);
    expect(validateJobCounts({}, [])).toEqual({});
    expect(
      validateJobCounts(Object.assign(Object.create(null) as object, { sent: 1 }), ["sent"]),
    ).toEqual({ sent: 1 });
  });

  it("refuses a key outside the declared set", () => {
    expect(validateJobCounts({ sent: 1, orgs: 2 }, ["sent"])).toBeNull();
    expect(validateJobCounts({ sent: 1 }, [])).toBeNull();
  });

  it.each([
    ["null", null],
    ["an array", [1, 2]],
    ["a number", 3],
    ["a string", "sent"],
    ["a Map", new Map([["sent", 1]])],
    ["a class instance", new (class Counts {})()],
    ["a negative count", { sent: -1 }],
    ["a fraction", { sent: 1.5 }],
    ["NaN", { sent: Number.NaN }],
    ["Infinity", { sent: Number.POSITIVE_INFINITY }],
    ["an unsafe integer", { sent: 2 ** 53 }],
    ["a numeric string", { sent: "2" }],
    ["a nested object", { sent: { org: 1 } }],
    ["an uppercase key", { Sent: 1 }],
    ["a hyphenated key", { "sent-ok": 1 }],
    ["a key with digits (a date)", { d1961_04_12: 1 }],
    ["a key that starts with _", { _sent: 1 }],
    ["__proto__ as a key", JSON.parse('{"__proto__": 1}') as unknown],
    ["a 41-character key", { ["a".repeat(41)]: 1 }],
    ["33 keys", Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${"a".repeat(i)}`, 1]))],
    ["a symbol key", { [Symbol("sent")]: 1 }],
    ["a getter", Object.defineProperty({}, "sent", { get: () => 1, enumerable: true })],
    ["a non-enumerable key", Object.defineProperty({}, "sent", { value: 1, enumerable: false })],
  ])("refuses %s, even with every key declared", (_label, value) => {
    // Declaring the value's own keys isolates the shape rule from the
    // declaration rule.
    const declared =
      typeof value === "object" && value !== null ? Object.getOwnPropertyNames(value) : [];
    expect(validateJobCounts(value, declared)).toBeNull();
  });
});

describe("registry", () => {
  it("ships the follow-up digest (MINT-108)", () => {
    expect([...JOB_REGISTRY.keys()]).toEqual(["followup-digest"]);
  });

  const noop = async () => ({});
  const job = (name: string, countKeys: readonly string[] = ["sent"]): JobDefinition => ({
    name,
    countKeys,
    run: noop,
  });

  it("refuses a name that is not a path-safe identifier, and duplicates", () => {
    expect(() => createJobRegistry([job("Daily Digest")])).toThrow();
    expect(() => createJobRegistry([job("daily/digest")])).toThrow();
    expect(() => createJobRegistry([job("a".repeat(49))])).toThrow();
    expect(() => createJobRegistry([job("daily-digest"), job("daily-digest")])).toThrow();
    expect([...createJobRegistry([job("daily-digest")]).keys()]).toEqual(["daily-digest"]);
  });

  it("refuses count keys that are malformed, repeated or too many", () => {
    expect(() => createJobRegistry([job("daily-digest", ["Sent"])])).toThrow();
    expect(() => createJobRegistry([job("daily-digest", ["d1961_04_12"])])).toThrow();
    expect(() => createJobRegistry([job("daily-digest", ["sent", "sent"])])).toThrow();
    const many = Array.from({ length: 33 }, (_, i) => `k${"a".repeat(i)}`);
    expect(() => createJobRegistry([job("daily-digest", many)])).toThrow();
    expect(() => createJobRegistry([job("daily-digest", many.slice(0, 32))])).not.toThrow();
    expect(() => createJobRegistry([job("daily-digest", [])])).not.toThrow();
  });
});

describe("jobLogger", () => {
  it("logs a snake_case event under the job's scope and replaces anything else", () => {
    const log = jobLogger("test-job", SITE);
    log.error("org_send_failed", new Error("x"));
    log.error("send failed for 742 Evergreen Terrace", new Error("x"));
    expect(consoleError.mock.calls.map((call) => call[0])).toEqual([
      "[jobs:test-job] org_send_failed",
      "[jobs:test-job] invalid_event",
    ]);
  });
});
