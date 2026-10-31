// NPI Registry checks while an import is reviewed — MINT-110 PR 2 / MINT-119.
// Starts an ImportNpiVerifier when the rows to check are known and `enabled`
// (an admin reviewing a run that is ready for review), and stops it when the
// page goes away, the run stops being reviewable, or the caller says stop.
// Outcomes live in memory only; a new set of rows (rare: the existing-provider
// data changed under the review) starts a new run that reuses every NPI
// already checked.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ImportNpiVerifier } from "@/lib/importNpiVerifier";
import {
  importNpiChecksKey,
  type ImportNpiCheckItem,
  type ImportNpiSnapshot,
} from "@/lib/importNpiVerification";
import { verifyNpiRegistryBatch } from "@/services/npiRegistry";

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
  const latest = useRef<ImportNpiVerifier | null>(null);
  const [verifier, setVerifier] = useState<ImportNpiVerifier | null>(null);

  useEffect(() => {
    if (!enabled || !key) return;
    const next = new ImportNpiVerifier(
      itemsRef.current,
      { verifyBatch: (npis, signal) => verifyNpiRegistryBatch(npis, signal) },
      { known: latest.current?.getSnapshot().results },
    );
    latest.current = next;
    setVerifier(next);
    next.start();
    return () => next.stop();
  }, [enabled, key]);

  const [fallback] = useState(() => idleSnapshot(0));
  const snapshot = useSyncExternalStore(
    verifier ? verifier.subscribe : noSubscription,
    verifier ? verifier.getSnapshot : () => fallback,
    verifier ? verifier.getSnapshot : () => fallback,
  );
  const stop = useCallback(() => latest.current?.stop(), []);
  return { snapshot: verifier ? snapshot : { ...snapshot, total: items.length }, stop };
}
