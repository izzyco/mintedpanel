// NPI Registry checks on the import review — MINT-110 PR 2 / MINT-119. The
// progress panel (a progress bar, "N of M checked", the estimated time left
// once it can be estimated, a Stop control, a completion state) and the note
// shown in each new provider's row. Presentational: the snapshot comes from
// useImportNpiVerification. Composition of stock primitives and tokens,
// logged in DESIGN-DEBT.md.
//
// Accessibility: the bar is role="progressbar" with value/max and a label;
// progress is announced through one polite live region at the start, each
// quarter and the end, never per row. Focus is never moved, except when the
// Stop button itself had focus as it went away (it leaves when the checks
// end), so focus lands on the status line instead of the page body.
import { useEffect, useId, useRef } from "react";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  formatTimeRemaining,
  importNpiAnnouncement,
  importNpiStatusText,
  type ImportNpiCounts,
  type ImportNpiSnapshot,
} from "@/lib/importNpiVerification";
import type { NpiVerificationView } from "@/lib/npiRegistry";
import type { NpiImportVerifyScope } from "@/lib/npiRegistryPolicy";
import { cn } from "@/lib/utils";

export function ImportNpiVerificationPanel({
  snapshot,
  counts,
  scope,
  onStop,
}: {
  snapshot: ImportNpiSnapshot;
  /** Checked rows with a warning, and rows a block holds back. */
  counts: ImportNpiCounts;
  scope: NpiImportVerifyScope;
  onStop: () => void;
}) {
  const headingId = useId();
  const stopRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const restoreFocus = useRef(false);
  const running = snapshot.phase === "running";

  // The render that removes the Stop button still sees it in the document.
  if (
    !running &&
    typeof document !== "undefined" &&
    stopRef.current !== null &&
    document.activeElement === stopRef.current
  ) {
    restoreFocus.current = true;
  }
  useEffect(() => {
    if (running || !restoreFocus.current) return;
    restoreFocus.current = false;
    statusRef.current?.focus();
  }, [running]);

  const { total, done } = snapshot;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const eta = running && snapshot.etaMs !== null ? formatTimeRemaining(snapshot.etaMs) : null;
  const status = importNpiStatusText(snapshot, counts);

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-2 rounded-md border border-[#E8E5E0] bg-white p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-[13px] font-medium text-foreground">
          NPI Registry check
        </h2>
        {running ? (
          <Button ref={stopRef} type="button" variant="outline" size="sm" onClick={onStop}>
            Stop checks
          </Button>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-label="NPI Registry checks"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${total} checked`}
        className="h-2 w-full overflow-hidden rounded-[4px] bg-[var(--mp-neutral-tint)]"
      >
        <div
          className="h-full bg-[#1B4D3E] transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p
        ref={statusRef}
        tabIndex={-1}
        className="flex flex-wrap items-center gap-x-2 text-[12px] tabular-nums text-foreground focus:outline-none"
      >
        {snapshot.phase === "done" ? (
          <CircleCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--mp-ok-ink)]" />
        ) : null}
        <span>{status}</span>
        {eta ? <span className="text-muted-foreground">· {eta}</span> : null}
      </p>
      <p className="text-[12px] text-muted-foreground">
        {scope === "all_rows"
          ? "Every row with an NPI. Notes are under New providers, Updates and Skipped."
          : "New providers only. Each row's note is under New providers."}{" "}
        A note never stops a row; a row your NPI policy blocks is listed under Blocked rows with the
        reason.
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {importNpiAnnouncement(snapshot, counts)}
      </p>
    </section>
  );
}

/** A row's registry note: a tone icon (the same tones as the provider forms'
 * note, "block" included), the title, and detail. */
export function ImportNpiNoteCell({ note }: { note: NpiVerificationView }) {
  return (
    <div className="flex items-start gap-1.5 text-[12px]">
      {note.tone === "ok" ? (
        <CircleCheck
          aria-hidden="true"
          className="mt-px h-4 w-4 shrink-0 text-[var(--mp-ok-ink)]"
        />
      ) : note.tone === "warn" ? (
        <TriangleAlert
          aria-hidden="true"
          className="mt-px h-4 w-4 shrink-0 text-[var(--mp-warn-ink)]"
        />
      ) : note.tone === "block" ? (
        <CircleAlert aria-hidden="true" className="mt-px h-4 w-4 shrink-0 text-destructive" />
      ) : null}
      <p>
        <span
          className={cn(
            note.tone === "warn"
              ? "font-medium text-[var(--mp-warn-ink)]"
              : note.tone === "block"
                ? "font-medium text-destructive"
                : note.tone === "ok"
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
          )}
        >
          {note.title}
        </span>
        {note.detail ? <span className="text-muted-foreground"> {note.detail}</span> : null}
      </p>
    </div>
  );
}
