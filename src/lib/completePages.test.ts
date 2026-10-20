// Complete list reads: a report source is read page by page until every row
// is in, and fails loudly rather than return a partial list.
import { describe, expect, it } from "vitest";
import {
  COMPLETE_READ_PAGE_SIZE,
  readCompletePages,
  type CompletePageResult,
} from "./completePages";

const SERVER_MAX_ROWS = 1000;
const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

/** A PostgREST stand-in: honors the range, caps a page at max-rows, and
 * reports the exact count only when asked to. */
function server(rows: { id: number }[], { withCount = true } = {}) {
  const calls: Array<[number, number]> = [];
  const readPage = async (
    from: number,
    to: number,
  ): Promise<CompletePageResult<{ id: number }>> => {
    calls.push([from, to]);
    const end = Math.min(to + 1, from + SERVER_MAX_ROWS);
    return {
      data: rows.slice(from, end),
      error: null,
      count: withCount ? rows.length : null,
    };
  };
  return { readPage, calls };
}

describe("readCompletePages", () => {
  it("reads past the server's 1000-row cap, every row exactly once", async () => {
    const all = rowsOf(2345);
    const { readPage, calls } = server(all);
    const rows = await readCompletePages(readPage, { label: "Case list" });
    expect(rows).toEqual(all);
    expect(calls[0]).toEqual([0, COMPLETE_READ_PAGE_SIZE - 1]);
    expect(calls).toHaveLength(Math.ceil(2345 / COMPLETE_READ_PAGE_SIZE));
  });

  it("stops at the exact count without an extra read when the last page is full", async () => {
    const { readPage, calls } = server(rowsOf(COMPLETE_READ_PAGE_SIZE * 2));
    const rows = await readCompletePages(readPage, { label: "Case list" });
    expect(rows).toHaveLength(COMPLETE_READ_PAGE_SIZE * 2);
    expect(calls).toHaveLength(2);
  });

  it("an empty source is an empty list", async () => {
    expect(await readCompletePages(server([]).readPage, { label: "Case list" })).toEqual([]);
    expect(
      await readCompletePages(server([], { withCount: false }).readPage, { label: "Case list" }),
    ).toEqual([]);
  });

  it("without a count, ends on the first short page", async () => {
    const all = rowsOf(1203);
    const { readPage, calls } = server(all, { withCount: false });
    const rows = await readCompletePages(readPage, { label: "Case list" });
    expect(rows).toEqual(all);
    expect(calls).toHaveLength(3);
  });

  it("requireCount fails a read that cannot prove it is complete", async () => {
    await expect(
      readCompletePages(server(rowsOf(3), { withCount: false }).readPage, {
        label: "Billing readiness source",
        requireCount: true,
      }),
    ).rejects.toThrow("Billing readiness source could not verify completeness.");
  });

  it("fails when the pages fall short of the exact count", async () => {
    const readPage = async () => ({ data: rowsOf(10), error: null, count: 2000 });
    await expect(readCompletePages(readPage, { label: "Case list" })).rejects.toThrow(
      "Case list returned an incomplete page set.",
    );
  });

  it("fails when the source changes between pages", async () => {
    let count = 1200;
    const readPage = async (from: number) => ({
      data: rowsOf(COMPLETE_READ_PAGE_SIZE).map((r) => ({ id: r.id + from })),
      error: null,
      count: count++,
    });
    await expect(readCompletePages(readPage, { label: "Case list" })).rejects.toThrow(
      "Case list changed during pagination.",
    );
  });

  it("fails on a page bigger than asked for (the range was ignored)", async () => {
    const readPage = async () => ({ data: rowsOf(COMPLETE_READ_PAGE_SIZE + 1), error: null });
    await expect(readCompletePages(readPage, { label: "Case list" })).rejects.toThrow(
      "Case list returned an oversized page.",
    );
  });

  it("rethrows the query error and rejects a missing payload", async () => {
    const failure = { code: "42501", message: "denied" };
    await expect(
      readCompletePages(async () => ({ data: null, error: failure }), { label: "Case list" }),
    ).rejects.toBe(failure);
    await expect(
      readCompletePages(async () => ({ data: null, error: null }), { label: "Case list" }),
    ).rejects.toThrow("Case list returned no data payload.");
  });
});
