// Saves her answers about a second after she stops typing, and on demand
// before Continue, Back and Finish later. One save runs at a time, each with
// the version the last one returned, so the page never conflicts with itself.
import { useCallback, useEffect, useRef, useState } from "react";
import type { IntakeAnswers, SaveDraftResult } from "@/lib/intakeAnswers";
import type { DraftStep } from "@/lib/intakeFlow";

export const AUTOSAVE_DELAY_MS = 1000;

export type SaveStatus = "idle" | "saving" | "saved" | "failed" | "reloaded";

interface Pending {
  answers: IntakeAnswers;
  step: DraftStep;
}

export interface AutosaveHandlers {
  save: (answers: IntakeAnswers, step: DraftStep, version: number) => Promise<SaveDraftResult>;
  /** Another window saved first: read her state again. */
  reload: () => Promise<void>;
  signedOut: () => void;
  closed: () => void;
}

function keyOf(pending: Pending): string {
  return JSON.stringify(pending);
}

export function useDraftAutosave(handlers: AutosaveHandlers) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  // What the server holds (by its key) and what the page holds now.
  const saved = useRef<{ key: string; version: number } | null>(null);
  const latest = useRef<Pending | null>(null);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancelTimer, []);

  /** Start from what the server holds: nothing is saved until she changes something. */
  const reset = useCallback((pending: Pending, version: number) => {
    cancelTimer();
    latest.current = pending;
    saved.current = { key: keyOf(pending), version };
  }, []);

  /** Resolves true once the server holds what the page holds. */
  const flush = useCallback((step?: DraftStep): Promise<boolean> => {
    cancelTimer();
    if (step && latest.current) latest.current = { ...latest.current, step };
    const run = async (): Promise<boolean> => {
      const pending = latest.current;
      const base = saved.current;
      if (!pending || !base) return true;
      const key = keyOf(pending);
      if (key === base.key) return true;
      setStatus("saving");
      let result: SaveDraftResult;
      try {
        result = await handlersRef.current.save(pending.answers, pending.step, base.version);
      } catch {
        setStatus("failed");
        return false;
      }
      switch (result.kind) {
        case "saved":
          saved.current = { key, version: result.version };
          // A change made while this save ran is already waiting to go.
          setStatus(latest.current && keyOf(latest.current) !== key ? "saving" : "saved");
          return true;
        case "conflict":
          try {
            await handlersRef.current.reload();
            setStatus("reloaded");
          } catch {
            setStatus("failed");
          }
          return false;
        case "signed_out":
          handlersRef.current.signedOut();
          return false;
        case "closed":
          handlersRef.current.closed();
          return false;
      }
    };
    queue.current = queue.current.then(run, run);
    return queue.current;
  }, []);

  const change = useCallback(
    (pending: Pending) => {
      latest.current = pending;
      cancelTimer();
      timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    },
    [flush],
  );

  /** The draft version the server holds, which Submit names. */
  const savedVersion = useCallback(() => saved.current?.version ?? 0, []);

  return { status, reset, change, flush, savedVersion };
}
