// MINT-110 PR 2 / MINT-119 — the import review's NPI Registry checks, on fake
// timers with the batch route injected: one request of ten at a time,
// Retry-After on a 429, failures, the time-left estimate against a fixed
// window like the server's, and stop/cancel aborting the request in flight.
// No network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImportNpiVerificationSession,
  ImportNpiVerifier,
  abortableSleep,
} from "./importNpiVerifier";
import { importNpiStatusText } from "./importNpiVerification";
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

/** The route, injected: each request takes `latencyMs`, then `respond`
 * answers (or throws). */
function harness(
  respond: (npis: string[], call: number) => NpiRegistryBatchResult,
  latencyMs = 1_000,
) {
  const calls: Array<{ at: number; npis: string[] }> = [];
  const verifyBatch = vi.fn(async (npis: string[]) => {
    calls.push({ at: Date.now(), npis });
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return respond(npis, calls.length);
  });
  return { calls, verifyBatch };
}

/** The server's budget: 60 NPIs a minute, a fixed window per user. `used`
 * NPIs already went in a window that opened `usedAgoMs` before the run (a
 * second tab, an earlier import, the review opened again). */
function fixedWindowServer(used = 0, usedAgoMs = 0) {
  let windowStart = used > 0 ? Date.now() - usedAgoMs : Number.NEGATIVE_INFINITY;
  let count = used;
  const server = {
    first429At: null as number | null,
    respond: (npis: string[]): NpiRegistryBatchResult => {
      const now = Date.now();
      if (now - windowStart >= 60_000) {
        windowStart = now;
        count = 0;
      }
      if (count + npis.length > 60) {
        server.first429At ??= now;
        throw new HttpError(429, Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000)));
      }
      count += npis.length;
      return allChecked(npis);
    },
  };
  return server;
}

async function settle(verifier: ImportNpiVerifier): Promise<ImportNpiSnapshot> {
  for (let i = 0; i < 5_000; i += 1) {
    const snap = verifier.getSnapshot();
    if (snap.phase === "done" || snap.phase === "stopped") return snap;
    await vi.advanceTimersByTimeAsync(100);
  }
  throw new Error("verifier never finished");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ImportNpiVerifier", () => {
  it("checks a 100-row file ten at a time, one request in flight, every NPI once", async () => {
    const h = harness((npis) => allChecked(npis));
    const verifier = new ImportNpiVerifier(items(100), h.verifyBatch);
    const seen: ImportNpiSnapshot[] = [];
    verifier.subscribe(() => seen.push(verifier.getSnapshot()));
    verifier.start();
    const end = await settle(verifier);

    expect(end).toMatchObject({ phase: "done", total: 100, done: 100, checked: 100 });
    expect(h.calls).toHaveLength(10);
    expect(h.calls.every((call) => call.npis.length === 10)).toBe(true);
    // Every NPI asked exactly once, in order.
    expect(h.calls.flatMap((call) => call.npis)).toEqual(items(100).map((item) => item.npi));
    // One in flight: each request starts when the one before has answered.
    for (let i = 1; i < h.calls.length; i += 1) {
      expect(h.calls[i].at - h.calls[i - 1].at).toBe(1_000);
    }
    // Progress only ever advances, and ends in a completion state.
    const dones = seen.map((snap) => snap.done);
    expect(dones).toEqual([...dones].sort((a, b) => a - b));
    expect(seen[0]).toMatchObject({ phase: "running", done: 0 });
    expect(seen.at(-1)).toMatchObject({ phase: "done", done: 100 });
  });

  // Against a server window like the route's, each request taking a second:
  // the run finishes, and every time left shown lands within 5 s of when it
  // really ended (each request's second of latency drifts the server's next
  // window a little). Before its first 429 the browser cannot see a window
  // that was already partly used, so with one the estimates are held to this
  // from that 429 on; it comes within a few requests.
  for (const { label, rows, known, used, usedAgoMs } of [
    { label: "a fresh window, 100 rows", rows: 100, known: 0, used: 0, usedAgoMs: 0 },
    { label: "30 used 20 s before, 100 rows", rows: 100, known: 0, used: 30, usedAgoMs: 20_000 },
    { label: "60 used 30 s before, 100 rows", rows: 100, known: 0, used: 60, usedAgoMs: 30_000 },
    { label: "60 used 30 s before, 200 rows", rows: 200, known: 0, used: 60, usedAgoMs: 30_000 },
    { label: "100 of 150 already checked", rows: 150, known: 100, used: 0, usedAgoMs: 0 },
  ]) {
    it(`time left against the server's window: ${label}`, async () => {
      const server = fixedWindowServer(used, usedAgoMs);
      const h = harness(server.respond);
      const all = items(rows);
      const carried = new Map(
        all.slice(0, known).map((item) => [item.npi, { status: "checked" as const, record: null }]),
      );
      const verifier = new ImportNpiVerifier(all, h.verifyBatch, carried);
      const shown: Array<{ at: number; done: number; eta: number | null; phase: string }> = [];
      verifier.subscribe(() => {
        const snap = verifier.getSnapshot();
        shown.push({ at: Date.now(), done: snap.done, eta: snap.etaMs, phase: snap.phase });
      });
      verifier.start();
      const end = await settle(verifier);
      expect(end).toMatchObject({ phase: "done", done: rows, checked: rows });
      const finishedAt = Date.now();
      if (used > 0) expect(server.first429At).not.toBeNull();
      const held = shown.filter(
        ({ at, eta }) => eta !== null && (used === 0 || at >= (server.first429At ?? 0)),
      );
      if (rows - known > 30) expect(held.length).toBeGreaterThan(0);
      for (const { at, eta } of held) {
        expect(Math.abs(at + (eta ?? 0) - finishedAt)).toBeLessThanOrEqual(5_000);
      }
      // Never frozen: a 429 wait refreshes the time left every second, so
      // no gap is longer than one wait step plus one request (1 s each here).
      const running = shown.filter(({ phase }) => phase === "running");
      for (let i = 1; i < running.length; i += 1) {
        expect(running[i].at - running[i - 1].at).toBeLessThanOrEqual(2_000);
      }
    });
  }

  it("waits out the server's 429 and sends the refused batch again once its window has ended", async () => {
    const server = fixedWindowServer();
    const h = harness(server.respond);
    const verifier = new ImportNpiVerifier(items(100), h.verifyBatch);
    verifier.start();
    expect(await settle(verifier)).toMatchObject({ phase: "done", done: 100, checked: 100 });
    // Six answered, the seventh refused, then the same batch again once the
    // window (opened by the first answer, at 1 s) has ended.
    expect(h.calls).toHaveLength(11);
    expect(h.calls[7].npis).toEqual(h.calls[6].npis);
    expect(h.calls[7].at).toBe(61_000);
  });

  it("finishes at once when there is nothing to check", () => {
    const h = harness((npis) => allChecked(npis));
    const verifier = new ImportNpiVerifier([], h.verifyBatch);
    verifier.start();
    expect(verifier.getSnapshot()).toMatchObject({ phase: "done", total: 0, done: 0 });
    expect(h.calls).toHaveLength(0);
  });

  it("waits out Retry-After on a 429, then sends the same batch again", async () => {
    const h = harness((npis, call) => {
      if (call === 2) throw new HttpError(429, 7);
      return allChecked(npis);
    });
    const verifier = new ImportNpiVerifier(items(30), h.verifyBatch);
    verifier.start();
    const end = await settle(verifier);
    expect(end).toMatchObject({ phase: "done", checked: 30 });
    expect(h.calls.map((call) => call.npis[0])).toEqual([
      fakeNpi(1),
      fakeNpi(11),
      fakeNpi(11),
      fakeNpi(21),
    ]);
    expect(h.calls[2].at - h.calls[1].at).toBe(1_000 + 7_000);
  });

  it("never gives up on the budget: 429s in a row are each waited out", async () => {
    const h = harness((npis, call) => {
      if (call >= 2 && call <= 5) throw new HttpError(429, 2);
      return allChecked(npis);
    });
    const verifier = new ImportNpiVerifier(items(20), h.verifyBatch);
    verifier.start();
    expect(await settle(verifier)).toMatchObject({ phase: "done", done: 20, checked: 20 });
    expect(h.calls).toHaveLength(6);
  });

  it("waits a full minute-long window on a 429 that names no Retry-After", async () => {
    const h = harness((npis, call) => {
      if (call === 1) throw new HttpError(429);
      return allChecked(npis);
    });
    const verifier = new ImportNpiVerifier(items(5), h.verifyBatch);
    verifier.start();
    await settle(verifier);
    expect(h.calls[1].at - h.calls[0].at).toBe(1_000 + 60_000);
  });

  it("marks a failed batch not checked, and gives up after two failures in a row", async () => {
    const h = harness((npis, call) => {
      if (call === 1) return allChecked(npis);
      throw new HttpError(502);
    });
    const verifier = new ImportNpiVerifier(items(40), h.verifyBatch);
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

  it("keeps going after a single failure when the registry comes back", async () => {
    const h = harness((npis, call) => {
      if (call === 2) throw new TypeError("Failed to fetch");
      return allChecked(npis);
    });
    const verifier = new ImportNpiVerifier(items(30), h.verifyBatch);
    verifier.start();
    expect(await settle(verifier)).toMatchObject({ phase: "done", done: 30, checked: 20 });
  });

  it("finishes when the last batch failed", async () => {
    const h = harness((npis, call) => {
      if (call === 2) throw new HttpError(502);
      return allChecked(npis);
    });
    const verifier = new ImportNpiVerifier(items(20), h.verifyBatch);
    verifier.start();
    expect(await settle(verifier)).toMatchObject({ phase: "done", done: 20, checked: 10 });
  });

  it("records per-NPI answers: an NPI the server could not check says not checked", async () => {
    const [a, b, c] = items(3).map((item) => item.npi);
    const h = harness(() => ({
      results: [
        { npi: a, status: "checked", record: null },
        { npi: b, status: "unavailable", record: null },
      ],
    }));
    const verifier = new ImportNpiVerifier(items(3), h.verifyBatch);
    verifier.start();
    const end = await settle(verifier);
    expect(h.calls).toHaveLength(1);
    expect(end.results.get(a)).toEqual({ status: "checked", record: null });
    // Unavailable, or missing from the answer: not checked, never asked again.
    for (const npi of [b, c]) {
      expect(end.results.get(npi)).toEqual({
        status: "not_checked",
        reason: "unavailable",
        message: "NPI Registry is unavailable",
      });
    }
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
    const verifier = new ImportNpiVerifier(all, h.verifyBatch, known);
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
    const verifier = new ImportNpiVerifier(items(30), verifyBatch);
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
    await vi.advanceTimersByTimeAsync(20);
    expect(verifyBatch).toHaveBeenCalledTimes(2);
    expect(verifier.getSnapshot()).toBe(end);
    // Stopping again, or starting again, does nothing.
    verifier.stop();
    verifier.start();
    expect(verifier.getSnapshot()).toBe(end);
  });

  it("stop while waiting out a 429 wakes the wait and sends nothing", async () => {
    const h = harness((npis, call) => {
      if (call === 2) throw new HttpError(429, 30);
      return allChecked(npis);
    });
    const verifier = new ImportNpiVerifier(items(40), h.verifyBatch);
    verifier.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.calls).toHaveLength(2);
    verifier.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(2);
    expect(verifier.getSnapshot()).toMatchObject({ phase: "stopped", checked: 10, done: 10 });
  });
});

describe("ImportNpiVerifier edges (review findings)", () => {
  it("while running, the status line says done, and never counts a failed row as checked", async () => {
    const h = harness((npis, call) => {
      if (call === 2) throw new HttpError(502);
      return allChecked(npis);
    }, 500);
    const verifier = new ImportNpiVerifier(items(40), h.verifyBatch);
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

  it("a malformed answer reaches the run's safety net: not checked, no hang, no unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      // A results entry that throws when read.
      const poisoned = {
        get npi(): string {
          throw new Error("synthetic: unreadable entry");
        },
      };
      for (const answer of [
        {},
        { results: null },
        { results: [poisoned] },
      ] as unknown as NpiRegistryBatchResult[]) {
        const verifyBatch = vi.fn(async () => answer);
        const verifier = new ImportNpiVerifier(items(3), verifyBatch);
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
      }
      await vi.advanceTimersByTimeAsync(10);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
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
    const session = new ImportNpiVerificationSession(verifyBatch);
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
    const h = sessionHarness();
    h.session.begin(items(30));
    await vi.waitFor(() => expect(h.verifyBatch).toHaveBeenCalledTimes(2));
    h.session.end();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.verifyBatch).toHaveBeenCalledTimes(2);
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
  });
});
