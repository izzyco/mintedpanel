// /api/npi-registry/* — MINT-110 staff lookups in the NPI Registry (NPPES).
//
//   POST /api/npi-registry/search  { firstName, lastName, state? }
//     → { results: NpiRegistryRecord[], truncated }   individuals (NPI-1), ≤ 10
//   POST /api/npi-registry/lookup  { npi }
//     → { record: NpiRegistryRecord | null }          null = not in the registry
//   POST /api/npi-registry/verify-batch  { npis }     1–10 NPIs (MINT-110 PR 2)
//     → { results: [{ npi, status: "checked" | "unavailable", record }] }
//   POST /api/npi-registry/pulls  { providerId, npi, sourced, confirmed }
//     → 201 { pull: { id, pulledAt, sourced, confirmed } }   (MINT-110 PR 3)
//
// POST, not GET, so typed names and NPIs stay out of URLs and request logs.
// All run behind the full org guard (authenticate()) and are writer-only: the
// consumers are the provider create/edit forms and the import review. The
// lookups read no org data and write no audit row — the registry is public,
// and nothing they answer is stored. /pulls is the one writer: after a
// provider-form save that used a registry answer it stores the reply as
// source data (provider_registry_pulls), one insert, for a provider of the
// caller's org. An import commit records no pull.
//
// Limits are per server instance: per-user fixed windows (typed lookups, and
// the import's batch checks counted per NPI) and a short TTL cache, all in
// memory. On Vercel every function instance keeps its own copies and loses
// them on a cold start, so the limits are best effort, not a guarantee
// (TECH-DEBT.md). The cache is shared across users and orgs on
// purpose: an answer depends only on the query, never on who asked. That makes
// a cache hit faster than a miss, so response timing can hint that someone
// searched the same public name recently; accepted, because the cache holds
// only public registry data and no caller, org or provider detail.
import type { Json } from "@/integrations/supabase/types";
import { fail, ok } from "./envelope";
import { isWriter, type AuthContext } from "./guard";
import {
  FixedWindowRateLimiter,
  NpiRegistryQueryRejectedError,
  NpiRegistryUnavailableError,
  TtlCache,
  lookupNppes,
  searchNppes,
  type NppesDeps,
} from "./npiRegistry";
import {
  NPI_REGISTRY_RATE_LIMIT_MESSAGE,
  NPI_REGISTRY_UNAVAILABLE_MESSAGE,
  validateNpiRegistryLookup,
  validateNpiRegistrySearch,
  type NpiRegistryLookupResult,
  type NpiRegistrySearchResult,
} from "@/lib/npiRegistry";
import {
  NPI_REGISTRY_BATCH_PER_MINUTE,
  NPI_REGISTRY_BATCH_RATE_LIMIT_MESSAGE,
  trimNpiRecordForImport,
  validateNpiRegistryBatch,
  type NpiRegistryBatchItemResult,
  type NpiRegistryBatchResult,
} from "@/lib/npiRegistryBatch";
import {
  keepNpiRegistrySourced,
  validateNpiRegistryPull,
  type NpiRegistryPullResult,
} from "@/lib/npiRegistryPulls";
import { stripNpiSeparators } from "@/lib/providerIdentity";

export const NPI_REGISTRY_RATE_LIMIT = 30;
export const NPI_REGISTRY_RATE_WINDOW_MS = 60_000;
export const NPI_REGISTRY_CACHE_TTL_MS = 10 * 60_000;
export const NPI_REGISTRY_CACHE_MAX = 500;

type CachedAnswer = NpiRegistrySearchResult | NpiRegistryLookupResult;

let limiter = new FixedWindowRateLimiter(NPI_REGISTRY_RATE_LIMIT, NPI_REGISTRY_RATE_WINDOW_MS);
// The import's batch checks: their own window, counted per NPI, so an import
// never eats the typed lookups' 30 a minute (NPI_REGISTRY_BATCH_PER_MINUTE).
let batchLimiter = new FixedWindowRateLimiter(
  NPI_REGISTRY_BATCH_PER_MINUTE,
  NPI_REGISTRY_RATE_WINDOW_MS,
);
let cache = new TtlCache<CachedAnswer>(NPI_REGISTRY_CACHE_TTL_MS, NPI_REGISTRY_CACHE_MAX);

/** Tests only: fresh limiters and cache, optionally on a fake clock. */
export function resetNpiRegistryLimits(now: () => number = Date.now): void {
  limiter = new FixedWindowRateLimiter(NPI_REGISTRY_RATE_LIMIT, NPI_REGISTRY_RATE_WINDOW_MS, now);
  batchLimiter = new FixedWindowRateLimiter(
    NPI_REGISTRY_BATCH_PER_MINUTE,
    NPI_REGISTRY_RATE_WINDOW_MS,
    now,
  );
  cache = new TtlCache<CachedAnswer>(NPI_REGISTRY_CACHE_TTL_MS, NPI_REGISTRY_CACHE_MAX, now);
}

function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

// Role, then input, then the per-user budget — so a malformed or forbidden
// request never spends the budget and never reaches the registry.
function precheck(ctx: AuthContext): Response | null {
  if (!isWriter(ctx)) {
    return privateResponse(fail(403, "Only admins and specialists can search the NPI Registry"));
  }
  return null;
}

function spendBudget(ctx: AuthContext): Response | null {
  const decision = limiter.take(ctx.userId);
  if (decision.allowed) return null;
  const response = privateResponse(fail(429, NPI_REGISTRY_RATE_LIMIT_MESSAGE));
  response.headers.set("Retry-After", String(decision.retryAfterSeconds));
  return response;
}

async function answer<T extends CachedAnswer>(
  key: string,
  load: () => Promise<T>,
): Promise<Response> {
  const cached = cache.get(key) as T | undefined;
  if (cached) return privateResponse(ok(cached));
  try {
    const result = await load();
    cache.set(key, result);
    return privateResponse(ok(result));
  } catch (error) {
    // The registry refused the query itself (for example a character it
    // will not search): the caller can fix it, so a 422, not an outage.
    if (error instanceof NpiRegistryQueryRejectedError) {
      return privateResponse(fail(422, error.message));
    }
    if (error instanceof NpiRegistryUnavailableError) {
      // The failure kind and upstream status only — never the query.
      console.warn(
        `[npi-registry] upstream unavailable: ${error.kind}${error.status ? ` ${error.status}` : ""}`,
      );
      return privateResponse(fail(502, NPI_REGISTRY_UNAVAILABLE_MESSAGE));
    }
    throw error;
  }
}

export async function handleNpiRegistrySearch(
  body: unknown,
  ctx: AuthContext,
  deps: NppesDeps = {},
): Promise<Response> {
  const denied = precheck(ctx);
  if (denied) return denied;
  const input = validateNpiRegistrySearch(body);
  if (!input.ok) return privateResponse(fail(422, input.error));
  const limited = spendBudget(ctx);
  if (limited) return limited;
  const { firstName, lastName, state } = input.value;
  const key = `search:${[firstName, lastName, state ?? ""].join("|").toUpperCase()}`;
  return answer(key, () => searchNppes(input.value, deps));
}

export async function handleNpiRegistryLookup(
  body: unknown,
  ctx: AuthContext,
  deps: NppesDeps = {},
): Promise<Response> {
  const denied = precheck(ctx);
  if (denied) return denied;
  const input = validateNpiRegistryLookup(body);
  if (!input.ok) return privateResponse(fail(422, input.error));
  const limited = spendBudget(ctx);
  if (limited) return limited;
  return answer(`npi:${input.value}`, () => lookupNppes(input.value, deps));
}

/** MINT-110 PR 2: the import review checks its new providers' NPIs, up to
 * NPI_REGISTRY_BATCH_MAX per request. Role, then validation, then the batch
 * window (every NPI counts, cache hit or not), so a forbidden or malformed
 * request never spends it. Each NPI goes through the same cache and key as
 * /lookup, one registry call at a time; only the NPI goes upstream. The first
 * registry failure stops the request: that NPI and those after it come back
 * "unavailable". Nothing checked at all is a 502. `signal` is the caller's:
 * once it has gone, no more calls start. The answer is a trimmed record
 * (trimNpiRecordForImport). Logs the failure kind and a count, never an NPI. */
export async function handleNpiRegistryVerifyBatch(
  body: unknown,
  ctx: AuthContext,
  deps: NppesDeps = {},
  signal?: AbortSignal,
): Promise<Response> {
  if (!isWriter(ctx)) {
    return privateResponse(
      fail(403, "Only admins and specialists can check NPIs in the NPI Registry"),
    );
  }
  const input = validateNpiRegistryBatch(body);
  if (!input.ok) return privateResponse(fail(422, input.error));
  const decision = batchLimiter.take(ctx.userId, input.value.length);
  if (!decision.allowed) {
    const response = privateResponse(fail(429, NPI_REGISTRY_BATCH_RATE_LIMIT_MESSAGE));
    response.headers.set("Retry-After", String(decision.retryAfterSeconds));
    return response;
  }

  const results: NpiRegistryBatchItemResult[] = [];
  let failure: string | null = null;
  for (const npi of input.value) {
    if (failure || signal?.aborted) {
      results.push({ npi, status: "unavailable", record: null });
      continue;
    }
    const key = `npi:${npi}`;
    try {
      let answer = cache.get(key) as NpiRegistryLookupResult | undefined;
      if (!answer) {
        answer = await lookupNppes(npi, deps);
        cache.set(key, answer);
      }
      const record = answer.record ? trimNpiRecordForImport(answer.record) : null;
      results.push({ npi, status: "checked", record });
    } catch (error) {
      if (error instanceof NpiRegistryUnavailableError) {
        failure = `${error.kind}${error.status ? ` ${error.status}` : ""}`;
      } else if (error instanceof NpiRegistryQueryRejectedError) {
        failure = "rejected";
      } else {
        throw error;
      }
      results.push({ npi, status: "unavailable", record: null });
    }
  }
  if (failure) {
    const unchecked = results.filter((result) => result.status === "unavailable").length;
    // The failure kind, upstream status and a count — never an NPI.
    console.warn(
      `[npi-registry] verify-batch: ${unchecked} of ${results.length} not checked (${failure})`,
    );
  }
  if (!results.some((result) => result.status === "checked")) {
    return privateResponse(fail(502, NPI_REGISTRY_UNAVAILABLE_MESSAGE));
  }
  const result: NpiRegistryBatchResult = { results };
  return privateResponse(ok(result));
}

/** MINT-110 PR 3: after a save that used a registry answer (a pick, or the
 * check of a new or changed NPI), store that answer as the provider's source
 * data. Writer-only; then the body; then the provider, which must be the
 * caller's org's (a 404 otherwise, before anything else) and hold that NPI (a
 * 409). The reply is the server's cached answer for the NPI or a fresh
 * lookup, never anything the client sent; a fresh lookup spends the batch
 * window (NPI_REGISTRY_BATCH_PER_MINUTE), the budget for calls nobody typed.
 * `sourced` keeps only the fields whose saved value equals the reply's
 * (keepNpiRegistrySourced). One insert with the service-role client; the org
 * and the actor come from the guard. `confirmed` marks an Add Provider Review
 * step submit, so the actor (pulled_by) is the confirmer. A registry failure
 * or the batch window writes nothing: the save went through already, and the
 * caller logs and moves on (no retry). */
export async function handleNpiRegistryPull(
  body: unknown,
  ctx: AuthContext,
  deps: NppesDeps = {},
): Promise<Response> {
  if (!isWriter(ctx)) {
    return privateResponse(fail(403, "Only admins and specialists can record NPI Registry pulls"));
  }
  const input = validateNpiRegistryPull(body);
  if (!input.ok) return privateResponse(fail(422, input.error));
  const { providerId, npi, sourced: claimed, confirmed } = input.value;

  const { data: provider, error: providerError } = await ctx.db
    .from("providers")
    .select("id, npi, credentials, taxonomy_code, gender, phone")
    .eq("org_id", ctx.orgId)
    .eq("id", providerId)
    .maybeSingle();
  if (providerError) throw providerError;
  if (!provider) return privateResponse(fail(404, "Provider not found"));
  if (stripNpiSeparators((provider.npi ?? "").trim()) !== npi) {
    return privateResponse(fail(409, "The provider does not hold that NPI"));
  }

  const key = `npi:${npi}`;
  let answer = cache.get(key) as NpiRegistryLookupResult | undefined;
  if (!answer) {
    const decision = batchLimiter.take(ctx.userId);
    if (!decision.allowed) {
      const response = privateResponse(fail(429, NPI_REGISTRY_BATCH_RATE_LIMIT_MESSAGE));
      response.headers.set("Retry-After", String(decision.retryAfterSeconds));
      return response;
    }
    try {
      answer = await lookupNppes(npi, deps);
      cache.set(key, answer);
    } catch (error) {
      if (error instanceof NpiRegistryQueryRejectedError) {
        return privateResponse(fail(422, error.message));
      }
      if (error instanceof NpiRegistryUnavailableError) {
        // The failure kind and upstream status only — never the NPI.
        console.warn(
          `[npi-registry] pull: upstream unavailable: ${error.kind}${error.status ? ` ${error.status}` : ""}`,
        );
        return privateResponse(fail(502, NPI_REGISTRY_UNAVAILABLE_MESSAGE));
      }
      throw error;
    }
  }

  let licenses: { state: string; number: string | null }[] = [];
  if (claimed.licenses?.length) {
    const { data: rows, error: licenseError } = await ctx.db
      .from("state_licenses")
      .select("state, license_number")
      .eq("org_id", ctx.orgId)
      .eq("provider_id", providerId);
    if (licenseError) throw licenseError;
    licenses = (rows ?? []).map((row) => ({ state: row.state, number: row.license_number }));
  }
  const sourced = keepNpiRegistrySourced(
    claimed,
    {
      credentials: provider.credentials,
      taxonomyCode: provider.taxonomy_code,
      gender: provider.gender,
      phone: provider.phone,
      licenses,
    },
    answer.record,
  );

  const { data: row, error: insertError } = await ctx.db
    .from("provider_registry_pulls")
    .insert({
      org_id: ctx.orgId,
      provider_id: providerId,
      npi,
      pulled_at: answer.pulledAt ?? new Date().toISOString(),
      pulled_by: ctx.userId,
      reply: (answer.record ?? null) as unknown as Json,
      sourced: sourced as unknown as Json,
      confirmed,
    })
    .select("id, pulled_at")
    .single();
  if (insertError) throw insertError;
  const result: NpiRegistryPullResult = {
    pull: { id: row.id, pulledAt: row.pulled_at, sourced, confirmed },
  };
  return privateResponse(ok(result, null, 201));
}
