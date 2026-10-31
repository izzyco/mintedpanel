// NPI Registry checks while an import is reviewed — MINT-110 PR 2 / MINT-119.
// A thin React wrapper over ImportNpiVerificationSession (src/lib/
// importNpiVerifier.ts, where the lifecycle is tested): the effect begins a
// run when the rows to check are known and `enabled` (an admin reviewing a run
// that is ready for review, with every existing-provider read loaded), and its
// cleanup ends it — when the page goes away, checking is disabled, or the rows
// change (rare: the existing-provider data changed under the review), in which
// case the next run reuses every NPI already checked. `stop` (Stop, Commit,
// Cancel Import) is final for this visit: the session never begins again after
// it, so new rows or a refetch error and recovery do not restart the checks.
// Outcomes live in memory only.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ImportNpiVerificationSession, type ImportNpiVerifier } from "@/lib/importNpiVerifier";
import {
  importNpiChecksKey,
  type ImportNpiCheckItem,
  type ImportNpiSnapshot,
} from "@/lib/importNpiVerification";
import {
  NPI_REGISTRY_BATCH_BURST,
  NPI_REGISTRY_BATCH_PER_MINUTE,
  TokenBucket,
} from "@/lib/npiRegistryBatch";
import { verifyNpiRegistryBatch } from "@/services/npiRegistry";

// One pacing bucket per tab, mirroring the server's per-user bucket: a new set
// of rows, or opening the review again, does not start with a full burst the
// server has already spent (which would meet a 429).
const tabBucket = new TokenBucket(NPI_REGISTRY_BATCH_BURST, NPI_REGISTRY_BATCH_PER_MINUTE / 60_000);

const noSubscription = () => () => undefined;

function idleSnapshot(total: number): ImportNpiSnapshot {
  return { phase: "idle", total, done: 0, checked: 0, results: new Map(), etaMs: null };
}

export interface ImportNpiVerification {
  snapshot: ImportNpiSnapshot;
  /** Stop the checks now (Stop, Cancel Import, Commit). */
  stop: () => void;
}

export function useImportNpiVerification(
  items: readonly ImportNpiCheckItem[],
  enabled: boolean,
): ImportNpiVerification {
  const key = importNpiChecksKey(items);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [session] = useState(
    () =>
      new ImportNpiVerificationSession(
        { verifyBatch: (npis, signal) => verifyNpiRegistryBatch(npis, signal) },
        { bucket: tabBucket },
      ),
  );
  const [verifier, setVerifier] = useState<ImportNpiVerifier | null>(null);

  useEffect(() => {
    if (!enabled || !key) return;
    setVerifier(session.begin(itemsRef.current));
    return () => session.end();
  }, [enabled, key, session]);

  const [fallback] = useState(() => idleSnapshot(0));
  const snapshot = useSyncExternalStore(
    verifier ? verifier.subscribe : noSubscription,
    verifier ? verifier.getSnapshot : () => fallback,
    verifier ? verifier.getSnapshot : () => fallback,
  );
  const stop = useCallback(() => session.stop(), [session]);
  return { snapshot: verifier ? snapshot : { ...snapshot, total: items.length }, stop };
}
