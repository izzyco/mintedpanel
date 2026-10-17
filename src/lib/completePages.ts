// Complete list reads. PostgREST caps an unranged list read at the server's
// max-rows setting (1000 on Supabase) and says nothing when it does, so a
// report built on that read silently drops every row past the cap. This
// walks a query PAGE_SIZE rows at a time until it has every row, and throws
// rather than return a partial list. Pure: the caller injects the page
// reader (a ranged PostgREST query), so the paging rules test without I/O.

export const COMPLETE_READ_PAGE_SIZE = 500;
export const COMPLETE_READ_MAX_ROWS = 100_000;

export interface CompletePageResult<T> {
  data: T[] | null;
  error: unknown;
  /** The exact total, when the query asked for `count: "exact"`. */
  count?: number | null;
}

export interface CompletePagesOptions {
  /** Prefix for every failure message, e.g. "Case list". */
  label: string;
  /**
   * True: a page with no exact count fails the read. False (default): a
   * missing count falls back to ending on the first short page, which is
   * complete as long as COMPLETE_READ_PAGE_SIZE stays under the server's
   * max-rows cap. A count that IS present is always enforced.
   */
  requireCount?: boolean;
}

export async function readCompletePages<T>(
  readPage: (from: number, to: number) => Promise<CompletePageResult<T>>,
  { label, requireCount = false }: CompletePagesOptions,
): Promise<T[]> {
  const rows: T[] = [];
  // undefined until the first page answers; null = that page carried no count.
  let expectedCount: number | null | undefined;
  while (true) {
    const page = await readPage(rows.length, rows.length + COMPLETE_READ_PAGE_SIZE - 1);
    if (page.error) throw page.error;
    if (page.data === null) throw new Error(`${label} returned no data payload.`);
    const count = page.count ?? null;
    if (
      (count === null && requireCount) ||
      (count !== null && (!Number.isSafeInteger(count) || count < 0))
    ) {
      throw new Error(`${label} could not verify completeness.`);
    }
    if (expectedCount === undefined) expectedCount = count;
    else if (count !== expectedCount) throw new Error(`${label} changed during pagination.`);
    if (expectedCount !== null && expectedCount > COMPLETE_READ_MAX_ROWS) {
      throw new Error(`${label} exceeded the complete-read limit.`);
    }
    if (page.data.length > COMPLETE_READ_PAGE_SIZE) {
      throw new Error(`${label} returned an oversized page.`);
    }
    rows.push(...page.data);
    if (expectedCount !== null) {
      if (rows.length > expectedCount) {
        throw new Error(`${label} returned more rows than its exact count.`);
      }
      if (rows.length === expectedCount) return rows;
    }
    if (rows.length >= COMPLETE_READ_MAX_ROWS) {
      throw new Error(`${label} exceeded the complete-read limit.`);
    }
    if (page.data.length < COMPLETE_READ_PAGE_SIZE) {
      if (expectedCount !== null) throw new Error(`${label} returned an incomplete page set.`);
      return rows;
    }
  }
}
