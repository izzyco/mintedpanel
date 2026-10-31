// MINT-110 PR 2 / MINT-119 — the import review's NPI Registry progress panel:
// progress bar semantics, "N of M checked" with the time left only once it can
// be estimated, the Stop control while running, the completion and stopped
// states, and one polite live region. Rendered statically; no network.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ImportNpiNoteCell, ImportNpiVerificationPanel } from "./ImportNpiVerificationPanel";
import type { ImportNpiOutcome, ImportNpiSnapshot } from "@/lib/importNpiVerification";

function snapshot(over: Partial<ImportNpiSnapshot>): ImportNpiSnapshot {
  return {
    phase: "running",
    total: 100,
    done: 0,
    checked: 0,
    results: new Map(),
    etaMs: null,
    ...over,
  };
}

function render(
  snap: ImportNpiSnapshot,
  counts = { notes: 0, blocked: 0 },
  scope = "new_providers",
  canBlock = false,
) {
  return renderToStaticMarkup(
    <ImportNpiVerificationPanel
      snapshot={snap}
      counts={counts}
      scope={scope as "new_providers" | "all_rows"}
      canBlock={canBlock}
      onStop={vi.fn()}
    />,
  );
}

function progressbar(html: string): string {
  const match = html.match(/<div role="progressbar"[^>]*>/);
  if (!match) throw new Error("no progressbar");
  return match[0];
}

describe("ImportNpiVerificationPanel", () => {
  it("is a labelled progress bar with rows done of rows total", () => {
    const html = render(snapshot({ done: 30, checked: 30 }));
    const bar = progressbar(html);
    expect(bar).toContain('aria-label="NPI Registry checks"');
    expect(bar).toContain('aria-valuemin="0"');
    expect(bar).toContain('aria-valuemax="100"');
    expect(bar).toContain('aria-valuenow="30"');
    expect(bar).toContain('aria-valuetext="30 of 100 done"');
    expect(html).toContain("width:30%");
    expect(html).toContain("30 of 100 done");
  });

  it("shows the time left only when it can be estimated, else just N of M", () => {
    expect(render(snapshot({ done: 10, checked: 10, etaMs: null }))).not.toContain("left");
    const html = render(snapshot({ done: 40, checked: 40, etaMs: 60_000 }));
    expect(html).toContain("40 of 100 done");
    expect(html).toContain("About 1 minute left");
  });

  it("offers Stop while running, and not once the checks end", () => {
    expect(render(snapshot({ done: 10 }))).toContain(">Stop checks</button>");
    const done = render(snapshot({ phase: "done", done: 100, checked: 100 }), {
      notes: 4,
      blocked: 0,
    });
    expect(done).not.toContain("Stop checks");
    expect(done).toContain("Finished — 100 of 100 checked, 4 with notes.");
    expect(progressbar(done)).toContain('aria-valuenow="100"');
    const stopped = render(snapshot({ phase: "stopped", done: 40, checked: 40 }));
    expect(stopped).not.toContain("Stop checks");
    expect(stopped).toContain(
      "Stopped — 40 of 100 checked, 0 with notes. Rows not checked say so.",
    );
  });

  it("says when rows went unchecked because the registry was down", () => {
    const results = new Map<string, ImportNpiOutcome>(
      Array.from({ length: 5 }, (_, i) => [
        `n${i}`,
        {
          status: "not_checked",
          reason: "unavailable",
          message: "NPI Registry is unavailable",
        } as const,
      ]),
    );
    const html = render(snapshot({ phase: "done", done: 100, checked: 95, results }));
    expect(html).toContain("5 not checked — the NPI Registry is unavailable.");
  });

  it("announces through one polite live region, separate from the visible line", () => {
    const html = render(snapshot({ done: 0 }));
    const regions = html.match(/aria-live="polite"/g) ?? [];
    expect(regions).toHaveLength(1);
    expect(html).toContain(
      '<p role="status" aria-live="polite" class="sr-only">Checking 100 NPIs in the NPI Registry.</p>',
    );
    expect(render(snapshot({ done: 55 }))).toContain(">NPI Registry checks 50% done.</p>");
  });

  it("never calls a row the registry could not answer 'checked' — line and value text agree", () => {
    const results = new Map<string, ImportNpiOutcome>(
      Array.from({ length: 10 }, (_, i) => [
        `n${i}`,
        {
          status: "not_checked",
          reason: "unavailable",
          message: "NPI Registry is unavailable",
        } as const,
      ]),
    );
    const html = render(snapshot({ total: 40, done: 20, checked: 10, results }));
    expect(progressbar(html)).toContain('aria-valuetext="20 of 40 done, 10 not checked"');
    expect(html).toContain("<span>20 of 40 done, 10 not checked</span>");
  });

  it("mentions blocking only when the NPI policy can block", () => {
    expect(render(snapshot({}))).toContain(
      "A note never stops a row: every row can still be committed.",
    );
    expect(render(snapshot({}))).not.toContain("NPI policy blocks");
    expect(render(snapshot({}), { notes: 0, blocked: 0 }, "new_providers", true)).toContain(
      "a row your NPI policy blocks is listed under Blocked rows with the reason",
    );
  });

  it("gives the status line a visible focus style, since focus can land there", () => {
    const html = render(snapshot({ phase: "stopped", done: 20, checked: 20 }));
    expect(html).toMatch(/<p tabindex="-1" class="[^"]*focus:ring-2[^"]*"/);
  });

  it("names its scope and that a note never stops a row", () => {
    expect(render(snapshot({}))).toContain("New providers only.");
    expect(render(snapshot({}), { notes: 0, blocked: 0 }, "all_rows")).toContain(
      "Every row with an NPI.",
    );
    expect(render(snapshot({}))).toContain("A note never stops a row");
  });
});

describe("ImportNpiNoteCell", () => {
  it("renders the note's title and detail with a tone icon", () => {
    const warn = renderToStaticMarkup(
      <ImportNpiNoteCell
        note={{
          tone: "warn",
          title: "This NPI belongs to an organization",
          detail: "The registry lists QUILL THERAPY LLC.",
        }}
      />,
    );
    expect(warn).toContain("This NPI belongs to an organization");
    expect(warn).toContain("The registry lists QUILL THERAPY LLC.");
    expect(warn).toContain("--mp-warn-ink");
    const pending = renderToStaticMarkup(
      <ImportNpiNoteCell note={{ tone: "neutral", title: "Not checked yet", detail: null }} />,
    );
    expect(pending).toContain("Not checked yet");
    expect(pending).not.toContain("<svg");
  });
});
