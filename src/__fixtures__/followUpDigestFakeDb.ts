// An in-memory stand-in for the tables the follow-up digest job reads, and
// for public.notification_sends and its two RPCs
// (supabase/migrations/20261101110200_notification_sends.sql), for the
// MINT-108 job tests.
//
// Reads: from(table).select(columns, { count }).eq().in().or().order(), then
// either .range(from, to) or a bare await. Like hosted PostgREST, a bare read
// returns at most 1,000 rows and says nothing, so a caller that does not page
// silently loses rows. Rows come back WHOLE, whatever the select names: the
// worst case for PHI, so a test proves the caller maps field by field. Every
// read is recorded with its table, columns and filters.
//
// RPCs, as the SQL: one row per (org, job, slot, recipient). The claim
// inserts a new key or re-takes a failed one (true), and answers false while
// the row is claimed or sent; the finish takes sent or failed and touches
// only a claimed row. The SQL itself is exercised by
// supabase/tests/mint108-notification-sends.sql.
//
// And MINT-134's two job RPCs (supabase/migrations/
// 20261101090000_mint134_workflow_advisories.sql, 20261102140000_...):
// record_job_advisory keeps one open row per (org, check, record) and answers
// null for a repeat while it is open; resolve_workflow_advisories stamps the
// open rows for (org, check, record) and answers how many. Like the SQL, a
// record must be the org's own row (organizations) or one of its memberships,
// and a context must be valid, with its ids the org's. Each rpc() is awaitable
// and has supabase-js's .abortSignal(); a stalled RPC answers only when that
// signal aborts, with the error supabase-js gives. The SQL is exercised by
// supabase/tests/mint134-*.sql.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { isAdvisoryContextValid, isCheckKey } from "@/lib/advisoryChecks";
import { JOB_NAME_RE } from "@/server/jobs/registry";
import { NOTIFICATION_SLOT_RE } from "@/server/jobs/notificationSends";

export const POSTGREST_MAX_ROWS = 1000;

export type FakeRow = Record<string, unknown>;

export interface FakeError {
  code: string;
  message: string;
  details?: string;
}

export interface FakeRead {
  table: string;
  columns: string;
  filters: Array<[op: "eq" | "in" | "or", column: string, value: unknown]>;
  ranged: boolean;
}

export interface FakeNotificationSend {
  job: string;
  slot: string;
  org_id: string;
  recipient_user_id: string;
  outcome: "claimed" | "sent" | "failed";
  /** How many times this key was claimed: 1, plus one per retry after a rejection. */
  claims: number;
}

type SendRpc = "claim_notification_send" | "finish_notification_send";
type AdvisoryRpc = "record_job_advisory" | "resolve_workflow_advisories";

/** A workflow_advisories row a job wrote. */
export interface FakeJobAdvisory {
  id: string;
  org_id: string;
  check_key: string;
  severity_at_time: string;
  record_table: string;
  record_id: string;
  job: string;
  context: Record<string, unknown>;
  resolved: boolean;
}

export interface FakeDigestDb {
  db: SupabaseClient<Database>;
  tables: Record<string, FakeRow[]>;
  reads: FakeRead[];
  sends: FakeNotificationSend[];
  advisories: FakeJobAdvisory[];
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  /** A read of this table answers with this error, every time. */
  failTable: Record<string, FakeError>;
  /** A read this returns an error for answers with it (e.g. one org's). */
  failRead: ((read: FakeRead) => FakeError | null) | null;
  /** The next call of this RPC answers with this error. */
  failNextRpc: Partial<Record<SendRpc, FakeError>>;
  /** Every call of this advisory RPC answers with this error. */
  failRpc: Partial<Record<AdvisoryRpc, FakeError>>;
  /** A call of one of these advisory RPCs hangs until its abort signal fires. */
  stallRpc: Set<AdvisoryRpc>;
  /** A claim for one of these recipients answers with a connection error. */
  failClaimFor: Set<string>;
}

type Result = { data: unknown; error: FakeError | null; count?: number | null };

// The subset of PostgREST's or=() grammar the digest uses:
// `col.is.null`, `col.is.true`, `col.is.false`, `col.not.is.null`, `col.eq.value`.
function orClauseMatches(row: FakeRow, clause: string): boolean {
  const [column, ...rest] = clause.split(".");
  const op = rest.join(".");
  const value = row[column];
  if (op === "is.null") return value === null || value === undefined;
  if (op === "not.is.null") return value !== null && value !== undefined;
  if (op === "is.true") return value === true;
  if (op === "is.false") return value === false;
  if (op.startsWith("eq.")) return String(value) === op.slice(3);
  throw new Error(`followUpDigestFakeDb: unsupported or() clause ${clause}`);
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}

export function createFollowUpDigestFakeDb(tables: Record<string, FakeRow[]> = {}): FakeDigestDb {
  const state: FakeDigestDb = {
    db: undefined as unknown as SupabaseClient<Database>,
    tables,
    reads: [],
    sends: [],
    advisories: [],
    rpcCalls: [],
    failTable: {},
    failRead: null,
    failNextRpc: {},
    failRpc: {},
    stallRpc: new Set(),
    failClaimFor: new Set(),
  };

  const from = (table: string) => {
    const read: FakeRead = { table, columns: "", filters: [], ranged: false };
    let wantCount = false;
    const orders: Array<{ column: string; ascending: boolean }> = [];

    const run = (range: [number, number] | null): Result => {
      state.reads.push({ ...read, filters: [...read.filters], ranged: range !== null });
      const failure = state.failTable[table] ?? state.failRead?.(read) ?? null;
      if (failure) return { data: null, error: failure, count: null };
      let rows = (state.tables[table] ?? []).filter((row) =>
        read.filters.every(([op, column, value]) =>
          op === "eq"
            ? row[column] === value
            : op === "or"
              ? column.split(",").some((clause) => orClauseMatches(row, clause))
              : Array.isArray(value) && (value as unknown[]).includes(row[column]),
        ),
      );
      rows = [...rows].sort((a, b) => {
        for (const { column, ascending } of orders) {
          const order = compare(a[column], b[column]);
          if (order !== 0) return ascending ? order : -order;
        }
        return 0;
      });
      const total = rows.length;
      const page = range
        ? rows.slice(range[0], Math.min(range[1] + 1, range[0] + POSTGREST_MAX_ROWS))
        : rows.slice(0, POSTGREST_MAX_ROWS);
      return {
        data: page.map((row) => structuredClone(row)),
        error: null,
        count: wantCount ? total : null,
      };
    };

    const builder = {
      select(columns: string, options?: { count?: string }) {
        read.columns = columns;
        wantCount = options?.count === "exact";
        return builder;
      },
      eq(column: string, value: unknown) {
        read.filters.push(["eq", column, value]);
        return builder;
      },
      in(column: string, values: unknown[]) {
        read.filters.push(["in", column, [...values]]);
        return builder;
      },
      or(expression: string) {
        read.filters.push(["or", expression, null]);
        return builder;
      },
      order(column: string, options?: { ascending?: boolean }) {
        orders.push({ column, ascending: options?.ascending !== false });
        return builder;
      },
      range(start: number, end: number) {
        return { then: (resolve: (r: Result) => unknown) => resolve(run([start, end])) };
      },
      then(resolve: (r: Result) => unknown) {
        return resolve(run(null));
      },
    };
    return builder;
  };

  const keyOf = (args: Record<string, unknown>) => ({
    job: String(args.p_job),
    slot: String(args.p_slot),
    org_id: String(args.p_org_id),
    recipient_user_id: String(args.p_recipient_user_id),
  });
  const find = (key: ReturnType<typeof keyOf>) =>
    state.sends.find(
      (row) =>
        row.job === key.job &&
        row.slot === key.slot &&
        row.org_id === key.org_id &&
        row.recipient_user_id === key.recipient_user_id,
    );

  const claim = (args: Record<string, unknown>): Result => {
    const key = keyOf(args);
    if (!JOB_NAME_RE.test(key.job) || !NOTIFICATION_SLOT_RE.test(key.slot)) {
      return { data: null, error: { code: "23514", message: "notification_sends check" } };
    }
    if (state.failClaimFor.has(key.recipient_user_id)) {
      return { data: null, error: { code: "08006", message: "connection failure" } };
    }
    const row = find(key);
    if (!row) {
      state.sends.push({ ...key, outcome: "claimed", claims: 1 });
      return { data: true, error: null };
    }
    if (row.outcome !== "failed") return { data: false, error: null };
    row.outcome = "claimed";
    row.claims += 1;
    return { data: true, error: null };
  };

  const finish = (args: Record<string, unknown>): Result => {
    const outcome = args.p_outcome;
    if (outcome !== "sent" && outcome !== "failed") {
      return { data: null, error: { code: "22023", message: "finish_notification_send: outcome" } };
    }
    const row = find(keyOf(args));
    if (!row || row.outcome !== "claimed") return { data: false, error: null };
    row.outcome = outcome;
    return { data: true, error: null };
  };

  const refused = (message: string): Result => ({ data: null, error: { code: "22023", message } });
  const rows = (table: string) => state.tables[table] ?? [];
  const recordInOrg = (table: unknown, id: unknown, orgId: unknown) =>
    table === "organizations"
      ? id === orgId
      : table === "memberships"
        ? rows("memberships").some((m) => m.id === id && m.org_id === orgId)
        : false;
  const contextIdsInOrg = (context: Record<string, unknown>, orgId: unknown) =>
    (context.sequence_id === undefined ||
      rows("notification_sequences").some(
        (s) => s.id === context.sequence_id && s.org_id === orgId,
      )) &&
    (context.recipient_id === undefined ||
      rows("memberships").some((m) => m.user_id === context.recipient_id && m.org_id === orgId));
  const openAdvisories = (args: Record<string, unknown>) =>
    state.advisories.filter(
      (row) =>
        !row.resolved &&
        row.org_id === args.p_org_id &&
        row.check_key === args.p_check_key &&
        row.record_table === args.p_record_table &&
        row.record_id === args.p_record_id,
    );

  const recordJobAdvisory = (args: Record<string, unknown>): Result => {
    const context = (args.p_context ?? {}) as Record<string, unknown>;
    if (typeof args.p_job !== "string" || !JOB_NAME_RE.test(args.p_job)) {
      return refused("workflow_advisory_job_invalid");
    }
    if (!isCheckKey(args.p_check_key)) return refused("workflow_advisory_check_key_invalid");
    if (args.p_severity !== "advisory" && args.p_severity !== "block") {
      return refused("workflow_advisory_severity_invalid");
    }
    if (!isAdvisoryContextValid(context)) return refused("workflow_advisory_context_invalid");
    if (!recordInOrg(args.p_record_table, args.p_record_id, args.p_org_id)) {
      return refused("workflow_advisory_record_not_in_org");
    }
    if (!contextIdsInOrg(context, args.p_org_id)) {
      return refused("workflow_advisory_context_not_in_org");
    }
    // ON CONFLICT ... WHERE resolved_at IS NULL DO NOTHING: null for a repeat.
    if (openAdvisories(args).length > 0) return { data: null, error: null };
    const id = `13400000-0000-4000-8000-${String(state.advisories.length + 1).padStart(12, "0")}`;
    state.advisories.push({
      id,
      org_id: String(args.p_org_id),
      check_key: args.p_check_key,
      severity_at_time: args.p_severity,
      record_table: String(args.p_record_table),
      record_id: String(args.p_record_id),
      job: args.p_job,
      context: structuredClone(context),
      resolved: false,
    });
    return { data: id, error: null };
  };

  const resolveAdvisories = (args: Record<string, unknown>): Result => {
    if (!isCheckKey(args.p_check_key)) return refused("workflow_advisory_check_key_invalid");
    const open = openAdvisories(args);
    for (const row of open) row.resolved = true;
    return { data: open.length, error: null };
  };

  const answer = (fn: string, args: Record<string, unknown>): Result => {
    if (fn === "claim_notification_send" || fn === "finish_notification_send") {
      const injected = state.failNextRpc[fn];
      if (injected) {
        delete state.failNextRpc[fn];
        return { data: null, error: injected };
      }
      return fn === "claim_notification_send" ? claim(args) : finish(args);
    }
    if (fn === "record_job_advisory" || fn === "resolve_workflow_advisories") {
      const injected = state.failRpc[fn];
      if (injected) return { data: null, error: injected };
      return fn === "record_job_advisory" ? recordJobAdvisory(args) : resolveAdvisories(args);
    }
    return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
  };

  // Answered at call time, like the SQL; awaitable, with .abortSignal().
  const rpc = (fn: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ fn, args });
    if (state.stallRpc.has(fn as AdvisoryRpc)) {
      let answerWith: (result: Result) => void = () => {};
      const stalled = new Promise<Result>((resolve) => (answerWith = resolve));
      return Object.assign(stalled, {
        abortSignal: (signal: AbortSignal) => {
          signal.addEventListener(
            "abort",
            () => answerWith({ data: null, error: { code: "", message: "AbortError" } }),
            { once: true },
          );
          return stalled;
        },
      });
    }
    const result = Promise.resolve(answer(fn, args));
    return Object.assign(result, { abortSignal: () => result });
  };

  state.db = { from, rpc } as unknown as SupabaseClient<Database>;
  return state;
}
