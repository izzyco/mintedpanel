import { format } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { handleJobRequest } from "./route";
import { jobLogger } from "./runner";
import { runOnboardingFileCleanup } from "./onboardingFileCleanup";
import type { JobContext } from "./types";

const NOW = new Date("2026-11-07T12:00:00Z");
const SECRET = "cron-secret-0123456789abcdef";
const ORG = "4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d";
const JOURNEY = "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b";
const PROVIDER = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const GROUP = "0b6a3a52-3c9f-4f3e-9a51-6a1d2f6e7c11";
const HOLDING = "provider-intake-uploads";
const VAULT = "provider-documents";

function uploadId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
const held = (n: number) => `org/${ORG}/onboarding/${JOURNEY}/${uploadId(n)}/cv.pdf`;
const copied = (n: number) => `org/${ORG}/provider/${PROVIDER}/${uploadId(n)}/1/cv.pdf`;
const file = (bucket: string, path: string) => ({ bucket, path });

// Storage by bucket. remove answers the objects it deleted, as Storage does,
// so a path that is already gone is not counted.
function fakeStorage(buckets: Record<string, string[]>) {
  const stored: Record<string, Set<string>> = Object.fromEntries(
    Object.entries(buckets).map(([name, paths]) => [name, new Set(paths)]),
  );
  const failing = new Set<string>();
  const remove = vi.fn(async (bucket: string, paths: string[]) => {
    if (failing.has(bucket)) {
      return {
        data: null,
        error: { name: "StorageApiError", statusCode: "500", message: paths[0] },
      };
    }
    const removed = paths.filter((path) => stored[bucket]?.delete(path));
    return { data: removed.map((name) => ({ name })), error: null };
  });
  const from = vi.fn((bucket: string) => ({ remove: (paths: string[]) => remove(bucket, paths) }));
  const left = (bucket: string) => [...(stored[bucket] ?? [])].sort();
  return { storage: { from }, remove, failing, left };
}

function fakeDb(files: unknown, storage: ReturnType<typeof fakeStorage>, rpcError: unknown = null) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: rpcError ? null : files,
    error: rpcError,
  }));
  return { rpc, storage: storage.storage };
}

function context(db: ReturnType<typeof fakeDb>): JobContext {
  return {
    db: db as unknown as SupabaseClient<Database>,
    now: NOW,
    log: jobLogger("onboarding-file-cleanup", { method: "GET", route: "/api/jobs/x" }),
  };
}

let errors: MockInstance<(...args: unknown[]) => void>;
beforeEach(() => {
  vi.stubEnv("DEV", false);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  errors.mockRestore();
});

describe("the onboarding file cleanup job", () => {
  it("asks for files older than 3 hours, 500 at most, and deletes each from its own bucket", async () => {
    const storage = fakeStorage({
      [HOLDING]: [held(1), held(2)],
      [VAULT]: [copied(3), copied(4)],
    });
    const db = fakeDb([file(HOLDING, held(1)), file(VAULT, copied(3))], storage);

    const counts = await runOnboardingFileCleanup(context(db));

    expect(db.rpc).toHaveBeenCalledWith("onboarding_orphan_files", {
      p_cutoff: "2026-11-07T09:00:00.000Z",
      p_limit: 500,
    });
    expect(counts).toEqual({
      files_found: 2,
      holding_removed: 1,
      vault_removed: 1,
      remove_failed: 0,
    });
    expect(storage.left(HOLDING)).toEqual([held(2)]);
    expect(storage.left(VAULT)).toEqual([copied(4)]);
  });

  it("deletes in batches of 100 and counts only what Storage says it deleted", async () => {
    const paths = Array.from({ length: 250 }, (_, i) => copied(i));
    // Ten were deleted by an earlier run that stopped before it answered.
    const storage = fakeStorage({ [VAULT]: paths.slice(10) });
    const db = fakeDb(
      paths.map((path) => file(VAULT, path)),
      storage,
    );

    const counts = await runOnboardingFileCleanup(context(db));

    expect(storage.remove.mock.calls.map(([, chunk]) => chunk.length)).toEqual([100, 100, 50]);
    expect(counts).toEqual({
      files_found: 250,
      holding_removed: 0,
      vault_removed: 240,
      remove_failed: 0,
    });
    expect(storage.left(VAULT)).toEqual([]);
  });

  it("counts a failed delete, logs it without a path, and still deletes the rest", async () => {
    const storage = fakeStorage({ [HOLDING]: [held(1)], [VAULT]: [copied(2)] });
    storage.failing.add(HOLDING);
    const db = fakeDb([file(HOLDING, held(1)), file(VAULT, copied(2))], storage);

    const counts = await runOnboardingFileCleanup(context(db));

    expect(counts).toEqual({
      files_found: 2,
      holding_removed: 0,
      vault_removed: 1,
      remove_failed: 1,
    });
    expect(storage.left(HOLDING)).toEqual([held(1)]);
    expect(errors).toHaveBeenCalledTimes(1);
    const line = format(...errors.mock.calls[0]);
    expect(line).toContain("[jobs:onboarding-file-cleanup] remove_failed");
    expect(line).not.toContain(ORG);
  });

  it("touches no bucket when nothing is left to delete", async () => {
    const storage = fakeStorage({ [HOLDING]: [held(1)] });
    const counts = await runOnboardingFileCleanup(context(fakeDb([], storage)));
    expect(counts).toEqual({
      files_found: 0,
      holding_removed: 0,
      vault_removed: 0,
      remove_failed: 0,
    });
    expect(storage.storage.from).not.toHaveBeenCalled();
  });

  it("fails the run when the list can't be read", async () => {
    const storage = fakeStorage({});
    const db = fakeDb(null, storage, { code: "42501", message: "permission denied" });
    await expect(runOnboardingFileCleanup(context(db))).rejects.toMatchObject({ code: "42501" });
    expect(storage.storage.from).not.toHaveBeenCalled();
  });

  it("deletes nothing at all when the list names any other file", async () => {
    for (const stray of [
      file(VAULT, `org/${ORG}/group/${GROUP}/${uploadId(9)}/1/w9.pdf`),
      file(VAULT, `org/${ORG}/provider/${PROVIDER}/not-an-id/1/cv.pdf`),
      file(VAULT, held(9)),
      file(HOLDING, copied(9)),
      file(HOLDING, `org/${ORG}/onboarding/${JOURNEY}/${uploadId(9)}/a/cv.pdf`),
      file("payer-forms", held(9)),
      { bucket: VAULT },
    ]) {
      const storage = fakeStorage({ [HOLDING]: [held(1)], [VAULT]: [copied(2)] });
      const db = fakeDb([file(HOLDING, held(1)), file(VAULT, copied(2)), stray], storage);
      await expect(runOnboardingFileCleanup(context(db)), JSON.stringify(stray)).rejects.toThrow(
        "onboarding_orphan_files",
      );
      expect(storage.remove).not.toHaveBeenCalled();
    }
  });

  it("is served by GET /api/jobs/onboarding-file-cleanup with the cron bearer", async () => {
    const storage = fakeStorage({ [HOLDING]: [held(1)] });
    const db = fakeDb([file(HOLDING, held(1))], storage);
    const res = await handleJobRequest(
      new Request("https://x.test/api/jobs/onboarding-file-cleanup", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      {
        getDb: () => db as unknown as SupabaseClient<Database>,
        now: () => NOW,
        cronSecret: () => SECRET,
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        job: "onboarding-file-cleanup",
        outcome: "succeeded",
        counts: { files_found: 1, holding_removed: 1, vault_removed: 0, remove_failed: 0 },
      },
      error: null,
      meta: null,
    });
    expect(storage.left(HOLDING)).toEqual([]);
  });
});
