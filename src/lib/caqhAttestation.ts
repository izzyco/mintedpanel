// The CAQH attestation window (PM A26, Oct 31 2026): ONE setting, shared by
// enrollment readiness (src/lib/enrollmentReadiness.ts) and the Provider
// Onboarding funnel (src/lib/onboardingFunnel.ts), so the two can never
// disagree about whether a provider's CAQH attestation is current. Platform
// default, organization override, resolved once and passed to both. Nothing
// stores either layer yet (the Mission Control setting is MINT-125), so every
// caller resolves to the default. Pure.

/** The platform default (PM decision 2026-07-11, kept by A26). */
export const DEFAULT_CAQH_ATTESTATION_WINDOW_DAYS = 120;
export const MAX_CAQH_ATTESTATION_WINDOW_DAYS = 365;

/** A whole number of days from 1 to 365. */
export function isValidCaqhAttestationWindowDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_CAQH_ATTESTATION_WINDOW_DAYS
  );
}

/** The organization's value, else the platform's, else the default. A stored
 * value that is not a whole number of days from 1 to 365 is skipped like a
 * missing one. */
export function resolveCaqhAttestationWindowDays(
  platform?: number | null,
  organization?: number | null,
): number {
  for (const value of [organization, platform]) {
    if (isValidCaqhAttestationWindowDays(value)) return value;
  }
  return DEFAULT_CAQH_ATTESTATION_WINDOW_DAYS;
}

/** The check a stored value must pass; empty when valid. null inherits. */
export function validateCaqhAttestationWindowDays(value: unknown): string[] {
  if (value == null || isValidCaqhAttestationWindowDays(value)) return [];
  return [
    `The CAQH attestation window must be a whole number of days from 1 to ${MAX_CAQH_ATTESTATION_WINDOW_DAYS}.`,
  ];
}
