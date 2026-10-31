// NPI Registry batch check — MINT-110 PR 2. The pure half shared by
// POST /api/npi-registry/verify-batch and the import review screen: the wire
// shapes, the request validation, and the per-user budget both sides agree on
// (one token bucket implementation, so the browser paces itself to exactly the
// budget the server enforces). No I/O.
//
// Only NPIs travel. The name match runs in the browser through the same
// compareNpiRegistryName / npiVerificationView the provider forms use, so the
// import notes and the form notes are the same words from the same code.
import {
  validateNpiRegistryLookup,
  type NpiRegistryRecord,
  type Validation,
} from "@/lib/npiRegistry";

/** The most NPIs one request checks. */
export const NPI_REGISTRY_BATCH_MAX = 10;

/** The batch budget, per user and separate from the interactive 30 a minute,
 * so a coordinator typing an NPI into a form keeps working while an import is
 * being checked. A token bucket: up to NPI_REGISTRY_BATCH_BURST NPIs at once,
 * refilled at NPI_REGISTRY_BATCH_PER_MINUTE. Every NPI in a request spends
 * one, cache hit or not (the same rule as /lookup), which is what lets the
 * import screen pace itself to the budget and estimate the time left.
 *
 * Why 60 a minute: NPPES publishes no rate limit, and every organization's
 * lookups leave from the same server addresses, so one large import must never
 * get the registry to throttle everyone else. One NPI a second per user (twice
 * the interactive allowance, still a polite rate) checks a 100-row file in
 * about a minute and a half; the burst of 20 makes a small file finish at
 * once. In memory per server instance, best effort (TECH-DEBT TD-55/TD-56). */
export const NPI_REGISTRY_BATCH_BURST = 20;
export const NPI_REGISTRY_BATCH_PER_MINUTE = 60;

export const NPI_REGISTRY_BATCH_RATE_LIMIT_MESSAGE =
  "Too many NPI Registry checks — wait a few seconds and try again";
export const NPI_REGISTRY_BATCH_SIZE_MESSAGE = `Send 1 to ${NPI_REGISTRY_BATCH_MAX} NPIs to check`;

/** checked: `record` is the registry's answer (null = not in the registry).
 * unavailable: the registry failed for this NPI, so it was not checked.
 * deferred: not looked up this time because the request ran out of time; it
 * cost no budget, so ask again. */
export type NpiRegistryBatchItemStatus = "checked" | "unavailable" | "deferred";

export interface NpiRegistryBatchItemResult {
  npi: string;
  status: NpiRegistryBatchItemStatus;
  record: NpiRegistryRecord | null;
}

/** One entry per distinct NPI sent, in the order sent. */
export interface NpiRegistryBatchResult {
  results: NpiRegistryBatchItemResult[];
}

/** `{ npis: string[] }`: 1 to NPI_REGISTRY_BATCH_MAX NPIs, each passing the
 * same check as /lookup (dashes and spaces stripped, then the CMS check digit).
 * The value is the distinct stripped NPIs in order; a repeat is checked once. */
export function validateNpiRegistryBatch(input: unknown): Validation<string[]> {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const raw = (body as Record<string, unknown>).npis;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > NPI_REGISTRY_BATCH_MAX) {
    return { ok: false, error: NPI_REGISTRY_BATCH_SIZE_MESSAGE };
  }
  const npis: string[] = [];
  for (const [index, value] of raw.entries()) {
    const one = validateNpiRegistryLookup({ npi: value });
    if (!one.ok) return { ok: false, error: `NPI ${index + 1} of ${raw.length}: ${one.error}` };
    if (!npis.includes(one.value)) npis.push(one.value);
  }
  return { ok: true, value: npis };
}

export type TokenBucketDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** A token bucket per key: `capacity` tokens, refilled continuously at
 * `refillPerMs`. A key never seen starts full. */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private level(key: string, now: number): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.capacity;
    return Math.min(this.capacity, bucket.tokens + (now - bucket.at) * this.refillPerMs);
  }

  /** Milliseconds until `cost` tokens are there (0 when they are now). */
  msUntilAvailable(key: string, cost: number): number {
    const missing = cost - this.level(key, this.now());
    return missing <= 0 ? 0 : Math.ceil(missing / this.refillPerMs);
  }

  /** Spend `cost` tokens, or say how long to wait. Nothing is spent on a no. */
  take(key: string, cost: number): TokenBucketDecision {
    const now = this.now();
    if (this.buckets.size > 1_000) {
      for (const [k] of this.buckets) {
        if (this.level(k, now) >= this.capacity) this.buckets.delete(k);
      }
    }
    const tokens = this.level(key, now);
    if (tokens >= cost) {
      this.buckets.set(key, { tokens: tokens - cost, at: now });
      return { allowed: true };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((cost - tokens) / this.refillPerMs / 1000)),
    };
  }

  /** Give back tokens for work that never happened (capped at capacity). */
  refund(key: string, amount: number): void {
    if (amount <= 0) return;
    const now = this.now();
    this.buckets.set(key, {
      tokens: Math.min(this.capacity, this.level(key, now) + amount),
      at: now,
    });
  }

  /** Empty the bucket (the server just said it is empty). */
  drain(key: string): void {
    this.buckets.set(key, { tokens: 0, at: this.now() });
  }

  clear(): void {
    this.buckets.clear();
  }
}
