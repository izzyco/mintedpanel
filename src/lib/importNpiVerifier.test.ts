// MINT-110 PR 2 / MINT-119 — the import review's NPI Registry scheduler, on a
// fake clock with the batch route injected: batching, pacing to the budget,
// Retry-After, outages, deferred NPIs, the time-left estimate, and stop/cancel
// aborting the request in flight. No network.
import { describe, expect, it, vi } from "vitest";
import {
  ImportNpiVerificationSession,
  ImportNpiVerifier,
  abortableSleep,
  type ImportNpiVerifierDeps,
} from "./importNpiVerifier";
import { importNpiStatusText } from "./importNpiVerification";
import { TokenBucket } from "./npiRegistryBatch";
import type { ImportNpiCheckItem, ImportNpiSnapshot } from "./importNpiVerification";
import type { NpiRegistryBatchResult } from "./npiRegistryBatch";
import type { NpiRegistryRecord } from "./npiRegistry";
import { npiCheckDigit } from "./providerIdentity";

function fakeNpi(n: number): string {
  const first9 = `1${String(n).padStart(8, "0")}`;
  return `${first9}${npiCheckDigit(first9)}`;
}

function items(count: number): ImportNpiCheckItem[] {
  return Array.from({ length: count }, (_, i) => ({
    npi: fakeNpi(i + 1),
    line: i + 2,
    firstName: `Synth${i}`,
    lastName: "Tester",
    credentials: "",
    taxonomyCode: "",
    disposition: "create" as const,
  }));
}

const recordFor = (npi: string): NpiRegistryRecord => ({
  npi,
  enumerationType: "NPI-1",
  firstName: "SYNTH",
  middleName: null,
  lastName: "TESTER",
  organizationName: null,
  credential: null,
  primaryTaxonomy: null,
  practiceCity: null,
  practiceState: null,
  status: "active",
  enumerationDate: null,
  otherNames: [],
});

const allChecked = (npis: string[]): NpiRegistryBatchResult => ({
  results: npis.map((npi) => ({ npi, status: "checked", record: recordFor(npi) })),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`HTTP ${status}`);
  }
}

/** A fake clock; sleeping advances it at once. Each request takes `latencyMs`. */
function harness(
  respond: (
    npis: string[],
    call: number,
  ) => NpiRegistryBatchResult | Promise<NpiRegistryBatchResult>,
  latencyMs = 1_000,
) {
  const clock = { now: 0 };
  const calls: Array<{ at: number; npis: string[] }> = [];
  const sleeps: number[] = [];
  const deps: ImportNpiVerifierDeps = {
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    verifyBatch: async (npis) => {
      calls.push({ at: clock.now, npis });
      clock.now += latencyMs;
      return respond(npis, calls.length);
    },
  };
  return { clock, calls, sleeps, deps };
}

async function settle(verifier: ImportNpiVerifier): Promise<ImportNpiSnapshot> {
  for (let i = 0; i < 1_000; i += 1) {
    const snap = verifier.getSnapshot();
    if (snap.phase === "done" || snap.phase === "stopped") return snap;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("verifier never finished");
}

describe("ImportNpiVerifier", () => {
  it("checks a 100-row file ten at a time, one request in flight, paced to the budget", async () => {
    const h = harness((npis) => allChecked(npis));
    const verifier = new ImportNpiVerifier(items(100), h.deps, { pacingMarginMs: 0 });
    const seen: ImportNpiSnapshot[] = [];
    verifier.subscribe(() => seen.push(verifier.getSnapshot()));
    verifier.start();
    const end = await settle(verifier);

    expect(end).toMatchObject({ phase: "done", total: 100, done: 100, checked: 100 });
    expect(h.calls).toHaveLength(10);
    expect(h.calls.every((call) => call.npis.length === 10)).toBe(true);
    // Every NPI asked exactly once, in order.
    expect(h.calls.flatMap((call) => call.npis)).toEqual(items(100).map((item) => item.npi));
    // The burst of 20 goes at once; after that one batch per 10 s at most.
    expect(h.calls[0].at).toBe(0);
    expect(h.calls[1].at).toBe(1_000);
    for (let i = 3; i < h.calls.length; i += 1) {
      expect(h.calls[i].at - h.calls[i - 1].at).toBeGreaterThanOrEqual(10_000);
    }
    // Never more than the budget in any minute (burst + 60).
    for (const call of h.calls) {
      const inWindow = h.calls
        .filter((other) => other.at >= call.at && other.at < call.at + 60_000)
        .reduce((sum, other) => sum + other.npis.length, 0);
      expect(inWindow).toBeLessThanOrEqual(20 + 60);
    }
    // Progress only ever advances, and ends in a completion state.
    const dones = seen.map((snap) => snap.done);
    expect(dones).toEqual([...dones].sort((a, b) => a - b));
    expect(seen[0]).toMatchObject({ phase: "running", done: 0 });
    expect(seen.at(-1)).toMatchObject({ phase: "done", done: 100 });
  });

  it("estimates the time left once enough rows are done, and only while running", async () => {
    const h = harness((npis) => allChecked(npis));
    const verifier = new ImportNpiVerifier(items(100), h.deps, { pacingMarginMs: 0 });
    const etas: Array<[number, number | null]> = [];
    verifier.subscribe(() => {
      const snap = verifier.getSnapshot();
      etas.push([snap.done, snap.etaMs]);
    });
    verifier.start();
    await settle(verifier);
    expect(etas.filter(([done]) => done < 20).every(([, eta]) => eta === null)).toBe(true);
    const at20 = etas.find(([done]) => done === 20);
    // 80 left at one a second.
    expect(at20?.[1]).toBe(80_000);
    expect(etas.find(([done]) => done === 50)?.[1]).toBe(50_000);
    expect(etas.at(-1)).toEqual([100, null]);
  });

  it("finishes at once when there is nothing to check", () => {
    const h = harness((npis) => allChecked(npis));
    const verifier = new ImportNpiVerifier([], h.deps);
    verifier.start();
    expect(verifier.getSnapshot()).toMatchObject({ phase: "done", total: 0, done: 0 });
    expect(h.calls).toHaveLength(0);
  });

  it("waits out Retry-After on a 429, then sends the same batch again", async () => {
    const h = harness((npis, call) => {
      if (call === 2) throw new HttpError(429, 7);
      return allChecked(npis);
    });
    const verifier = new ImportNpiVerifier(items(30), h.deps, { pacingMarginMs: 0 });
    verifier.start();
    const end = await settle(verifier);
    expect(end).toMatchObject({ phase: "done", checked: 30 });
    expect(h.calls.map((call) => call.npis[0])).toEqual([
      fakeNpi(1),
      fakeNpi(11),
      fakeNpi(11),
      fakeNpi(21),
    ]);
    expect(h.sleeps).toContain(7_000);
    // The retry goes right after the wait, not after a second pacing wait.
    expect(h.calls[2].at - h.calls[1].at).toBe(1_000 + 7_000);
  });

  it("stops asking after repeated 429s and says the rest were not checked", async () => {
    const h = harness(() => {
      throw new HttpError(429, 2);
    });
    const verifier = new ImportNpiVerifier(items(5), h.deps, { maxConsecutiveRateLimits: 2 });
    verifier.start();
    const end = await settle(verifier);
    expect(h.calls).toHaveLength(3);
    expect(end.phase).toBe("done");
    expect([...end.results.values()]).toEqual(
      Array(5).fill({
        status: "not_checked",
        reason: "rate_limited",
        message: "Too many NPI Registry checks right now. Reload the review to check again",
      }),
    );
  });

  it("marks an outage batch not checked, and gives up after two outages in a row", async () => {
    const h = harness((npis, call) => {
      if (call === 1) return allChecked(npis);
      throw new HttpError(502);
    });
    const verifier = new ImportNpiVerifier(items(40), h.deps, { pacingMarginMs: 0 });
    verifier.start();
    const end = await settle(verifier);
    expect(h.calls).toHaveLength(3);
    expect(end).toMatchObject({ phase: "done", done: 40, checked: 10 });
    const unavailable = [...end.results.values()].filter(
      (outcome) => outcome.status === "not_checked" && outcome.reason === "unavailable",
    );
    expect(unavailable).toHaveLength(30);
    // The forms' words for a failed call (npiRegistryErrorMessage).
    expect(new Set(unavailable.map((outcome) => "message" in outcome && outcome.message))).toEqual(
      new Set(["NPI Registry is unavailable"]),
    );
  });

  it("keeps going after a single outage when the registry comes back", async () => {
    const h = harness((npis, call) => {
      if (call === 2) throw new TypeError("Failed to fetch");
      return allChecked(npis);
    });
    const verifier = new ImportNpiVerifier(items(30), h.deps, { pacingMarginMs: 0 });
    verifier.start();
    const end = await settle(verifier);
    expect(end).toMatchObject({ phase: "done", done: 30, checked: 20 });
  });

  it("finishes when the last batch was an outage", async () => {
    const h = harness((npis, call) => {
      if (call === 2) throw new HttpError(502);
      return allChecked(npis);
    });
    const verifier = new ImportNpiVerifier(items(20), h.deps, { pacingMarginMs: 0 });
    verifier.start();
    expect(await settle(verifier)).toMatchObject({ phase: "done", done: 20, checked: 10 });
  });

  it("gives up at once on a status that will not get better", async () => {
    const h = harness(() => {
      throw new HttpError(403);
    });
    const verifier = new ImportNpiVerifier(items(25), h.deps);
    verifier.start();
    const end = await settle(verifier);
    expect(h.calls).toHaveLength(1);
    expect(end).toMatchObject({ phase: "done", done: 25, checked: 0 });
  });

  it("records per-NPI results and asks again for deferred NPIs first", async () => {
    const [a, b, c] = items(3).map((item) => item.npi);
    const h = harness((npis, call) =>
      call === 1
        ? {
            results: [
              { npi: a, status: "checked", record: null },
              { npi: b, status: "unavailable", record: null },
              { npi: c, status: "deferred", record: null },
            ],
          }
        : allChecked(npis),
    );
    const verifier = new ImportNpiVerifier(items(3), h.deps);
    verifier.start();
    const end = await settle(verifier);
    expect(h.calls.map((call) => call.npis)).toEqual([[a, b, c], [c]]);
    expect(end.results.get(a)).toEqual({ status: "checked", record: null });
    expect(end.results.get(b)).toEqual({
      status: "not_checked",
      reason: "unavailable",
      message: "NPI Registry is unavailable",
    });
    expect(end.results.get(c)).toEqual({ status: "checked", record: recordFor(c) });
  });

  it("reuses NPIs already checked and checks only the rest", async () => {
    const h = harness((npis) => allChecked(npis));
    const all = items(12);
    const known = new Map([
      [all[0].npi, { status: "checked" as const, record: null }],
      [
        all[1].npi,
        { status: "not_checked" as const, reason: "stopped" as const, message: "Stopped" },
      ],
    ]);
    const verifier = new ImportNpiVerifier(all, h.deps, { known });
    verifier.start();
    const end = await settle(verifier);
    expect(h.calls.flatMap((call) => call.npis)).toEqual(all.slice(1).map((item) => item.npi));
    expect(end.results.get(all[0].npi)).toEqual({ status: "checked", record: null });
    expect(end.checked).toBe(12);
  });

  it("stop aborts the request in flight, schedules nothing more and marks the rest", async () => {
    const signals: AbortSignal[] = [];
    let release: (() => void) | null = null;
    const verifyBatch = vi.fn(
      (npis: string[], signal: AbortSignal) =>
        new Promise<NpiRegistryBatchResult>((resolve, reject) => {
          signals.push(signal);
          if (verifyBatch.mock.calls.length === 1) {
            resolve(allChecked(npis));
            return;
          }
          release = () => resolve(allChecked(npis));
          signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    const verifier = new ImportNpiVerifier(items(30), { verifyBatch });
    verifier.start();
    await vi.waitFor(() => expect(verifyBatch).toHaveBeenCalledTimes(2));
    expect(verifier.getSnapshot()).toMatchObject({ phase: "running", done: 10 });

    verifier.stop();
    expect(signals[1].aborted).toBe(true);
    const end = verifier.getSnapshot();
    // The bar stays at what was checked; the rest say "stopped".
    expect(end).toMatchObject({ phase: "stopped", total: 30, done: 10, checked: 10 });
    expect(end.results.get(fakeNpi(11))).toEqual({
      status: "not_checked",
      reason: "stopped",
      message: "The checks were stopped",
    });
    // A late answer for the aborted batch changes nothing.
    (release as (() => void) | null)?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(verifyBatch).toHaveBeenCalledTimes(2);
    expect(verifier.getSnapshot()).toBe(end);
    // Stopping again, or starting again, does nothing.
    verifier.stop();
    verifier.start();
    expect(verifier.getSnapshot()).toBe(end);
  });

  it("stop while waiting for budget wakes the wait and sends nothing", async () => {
    vi.useFakeTimers();
    try {
      const verifyBatch = vi.fn(async (npis: string[]) => allChecked(npis));
      const verifier = new ImportNpiVerifier(items(40), { verifyBatch });
      verifier.start();
      await vi.waitFor(() => expect(verifyBatch).toHaveBeenCalledTimes(2));
      // The third batch now waits ~10 s for budget.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(verifyBatch).toHaveBeenCalledTimes(2);
      verifier.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(verifyBatch).toHaveBeenCalledTimes(2);
      expect(verifier.getSnapshot()).toMatchObject({ phase: "stopped", checked: 20, done: 20 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ImportNpiVerifier edges (review findings)", () => {
  it("while running, the status line says done, and never counts an outage row as checked", async () => {
    const h = harness((npis, call) => {
      if (call === 2) throw new HttpError(502);
      return allChecked(npis);
    }, 500);
    const verifier = new ImportNpiVerifier(items(40), h.deps, { pacingMarginMs: 0 });
    const lines: string[] = [];
    verifier.subscribe(() => {
      const snap = verifier.getSnapshot();
      if (snap.phase === "running") lines.push(importNpiStatusText(snap, { notes: 0 }));
    });
    verifier.start();
    await settle(verifier);
    expect(lines).toContain("20 of 40 done, 10 not checked");
    expect(lines.some((line) => line.includes("checked") && !line.includes("not checked"))).toBe(
      false,
    );
  });

  it("a 200 without a results array ends the run as not checked — no hang, no unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const verifier = new ImportNpiVerifier(items(5), {
        now: () => 0,
        sleep: async () => {},
        verifyBatch: async () => ({}) as NpiRegistryBatchResult,
      });
      verifier.start();
      const end = await settle(verifier);
      expect(end).toMatchObject({ phase: "done", done: 5, checked: 0 });
      expect([...end.results.values()].every((o) => o.status === "not_checked")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("a failure past the shape guard reaches the run's safety net: not checked, no hang, no unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      // A results array passes the guard, but reading an entry throws — after
      // the request's try/catch, inside the run itself.
      const poisoned = {
        get npi(): string {
          throw new Error("synthetic: unreadable entry");
        },
      };
      const verifyBatch = vi.fn(async () => ({
        results: [poisoned] as unknown as NpiRegistryBatchResult["results"],
      }));
      const verifier = new ImportNpiVerifier(items(3), {
        now: () => 0,
        sleep: async () => {},
        verifyBatch,
      });
      verifier.start();
      const end = await settle(verifier);
      expect(verifyBatch).toHaveBeenCalledTimes(1);
      expect(end).toMatchObject({ phase: "done", done: 3, checked: 0 });
      expect([...end.results.values()]).toEqual(
        Array(3).fill({
          status: "not_checked",
          reason: "unavailable",
          message: "NPI Registry is unavailable",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("a results value that is not an array takes the shape guard (an outage batch)", async () => {
    const verifyBatch = vi.fn(async () => ({ results: null as unknown as [] }));
    const verifier = new ImportNpiVerifier(items(3), {
      now: () => 0,
      sleep: async () => {},
      verifyBatch,
    });
    verifier.start();
    expect(await settle(verifier)).toMatchObject({ phase: "done", done: 3, checked: 0 });
    expect(verifyBatch).toHaveBeenCalledTimes(1);
  });

  it("paces against a shared bucket, so a second run does not start with a full burst", async () => {
    const h = harness((npis) => allChecked(npis), 100);
    const shared = new TokenBucket(20, 1 / 1000, () => h.clock.now);
    const first = new ImportNpiVerifier(items(20), h.deps, { bucket: shared, pacingMarginMs: 0 });
    first.start();
    await settle(first);
    expect(h.calls.map((call) => call.at)).toEqual([0, 100]);
    const second = new ImportNpiVerifier(items(30).slice(20), h.deps, {
      bucket: shared,
      pacingMarginMs: 0,
    });
    second.start();
    await settle(second);
    // The burst is spent: the third batch waits for ten tokens to refill.
    expect(h.calls[2].at).toBeGreaterThanOrEqual(10_000);
  });
});

describe("ImportNpiVerificationSession (what useImportNpiVerification drives)", () => {
  function sessionHarness() {
    const signals: AbortSignal[] = [];
    const sent: string[][] = [];
    const verifyBatch = vi.fn(
      (npis: string[], signal: AbortSignal) =>
        new Promise<NpiRegistryBatchResult>((resolve, reject) => {
          signals.push(signal);
          sent.push(npis);
          // The first request answers; later ones stay in flight until aborted.
          if (sent.length === 1) {
            resolve(allChecked(npis));
            return;
          }
          signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    const session = new ImportNpiVerificationSession({ verifyBatch });
    return { session, verifyBatch, signals, sent };
  }

  it("end() — the page unmounting — stops the run and aborts the request in flight", async () => {
    const h = sessionHarness();
    const run = h.session.begin(items(30));
    await vi.waitFor(() => expect(h.verifyBatch).toHaveBeenCalledTimes(2));
    h.session.end();
    expect(h.signals[1].aborted).toBe(true);
    expect(run?.getSnapshot()).toMatchObject({ phase: "stopped", checked: 10 });
    // Its snapshot stays readable after the end.
    expect(h.session.current).toBe(run);
  });

  it("end() — checking turned off (enabled false) — schedules nothing more", async () => {
    vi.useFakeTimers();
    try {
      const h = sessionHarness();
      h.session.begin(items(30));
      await vi.waitFor(() => expect(h.verifyBatch).toHaveBeenCalledTimes(2));
      h.session.end();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.verifyBatch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("begin() again — the rows changed — stops the old run and reuses every NPI already checked", async () => {
    const h = sessionHarness();
    const all = items(25);
    const first = h.session.begin(all.slice(0, 20));
    await vi.waitFor(() => expect(h.verifyBatch).toHaveBeenCalledTimes(2));
    const second = h.session.begin(all);
    expect(first?.getSnapshot().phase).toBe("stopped");
    expect(h.signals[1].aborted).toBe(true);
    await vi.waitFor(() => expect(h.verifyBatch).toHaveBeenCalledTimes(3));
    // The 10 checked in the first run are not asked again.
    expect(h.sent[2]).toEqual(all.slice(10, 20).map((item) => item.npi));
    expect(second?.getSnapshot()).toMatchObject({ phase: "running", checked: 10, total: 25 });
    expect(h.session.current).toBe(second);
    h.session.end();
  });

  it("stop() — the user's Stop — is final for the visit: new rows or a recovery never restart it", async () => {
    vi.useFakeTimers();
    try {
      const h = sessionHarness();
      const all = items(30);
      const run = h.session.begin(all.slice(0, 20));
      await vi.waitFor(() => expect(h.verifyBatch).toHaveBeenCalledTimes(2));
      h.session.stop();
      expect(h.session.stopped).toBe(true);
      expect(h.signals[1].aborted).toBe(true);
      // The rows change (the effect ends and begins again)…
      h.session.end();
      expect(h.session.begin(all)).toBe(run);
      // …or a refetch error turns checking off and recovery turns it back on.
      h.session.end();
      expect(h.session.begin(all)).toBe(run);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.verifyBatch).toHaveBeenCalledTimes(2);
      expect(h.session.current).toBe(run);
      expect(run?.getSnapshot()).toMatchObject({ phase: "stopped", checked: 10 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() before any run means none starts", () => {
    const h = sessionHarness();
    h.session.stop();
    expect(h.session.begin(items(5))).toBeNull();
    expect(h.verifyBatch).not.toHaveBeenCalled();
  });

  it("end() alone is not a Stop: the next begin() starts again", async () => {
    const h = sessionHarness();
    h.session.begin(items(5));
    await vi.waitFor(() => expect(h.verifyBatch).toHaveBeenCalledTimes(1));
    h.session.end();
    expect(h.session.stopped).toBe(false);
    const again = h.session.begin(items(15));
    expect(again?.getSnapshot().phase).not.toBe("stopped");
    await vi.waitFor(() => expect(h.verifyBatch).toHaveBeenCalledTimes(2));
    h.session.end();
  });
});

describe("abortableSleep", () => {
  it("resolves after the delay, or at once on abort", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let woke = false;
      void abortableSleep(5_000, controller.signal).then(() => {
        woke = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(woke).toBe(false);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(woke).toBe(true);
      let later = false;
      void abortableSleep(1_000, new AbortController().signal).then(() => {
        later = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(later).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
