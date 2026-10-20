// E4.2 F4.2.7 / TE-17 — the ONE shared predicate for the designated test
// provider. The test provider is an ordinary `providers` row with
// `is_test_provider = true`; it exists only for dry-run form fills and must be
// excluded from EVERY work-facing derivation (queue, generation candidates,
// scorecard/reporting — every Reporting Center report included). Every
// surface calls this one predicate rather than re-checking the flag, so the
// exclusion can never drift between surfaces.

/** Anything carrying the (optional, camelCased) test-provider flag. */
export interface HasTestProviderFlag {
  isTestProvider?: boolean | null;
}

/** True when the provider is the org's designated test provider. */
export function isTestProvider(provider: HasTestProviderFlag): boolean {
  return provider.isTestProvider === true;
}

/** Drop test providers from a work-facing list (queue/generation/scorecard). */
export function excludeTestProviders<T extends HasTestProviderFlag>(providers: readonly T[]): T[] {
  return providers.filter((p) => !isTestProvider(p));
}

/** The ids of the designated test providers in a provider list — for the
 * derivations keyed by provider id rather than holding the provider row
 * (cases, documents, assignments). */
export function testProviderIds(
  providers: readonly (HasTestProviderFlag & { id: string })[],
): Set<string> {
  return new Set(providers.filter(isTestProvider).map((p) => p.id));
}

/** Drop rows owned by a test provider from a reporting derivation. A row with
 * no provider (a group-owned document) is never a test provider's. */
export function excludeTestProviderRows<T extends { providerId?: string | null }>(
  rows: readonly T[],
  testIds: ReadonlySet<string>,
): T[] {
  if (testIds.size === 0) return rows.slice();
  return rows.filter((row) => !row.providerId || !testIds.has(row.providerId));
}
