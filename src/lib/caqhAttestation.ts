// The CAQH attestation window (PM A26, Oct 31 2026): ONE setting, shared by
// enrollment readiness (src/lib/enrollmentReadiness.ts) and the Provider
// Onboarding funnel (src/lib/onboardingFunnel.ts), so the two can never
// disagree about whether a provider's CAQH attestation is current. Platform
// default, organization override, resolved once and passed to both. Nothing
// stores either layer yet (the Mission Control setting is MINT-125), so every
// caller resolves to the default. Pure.

/** The platform default (PM decision 2026-07-11, kept by A26). */
export const DEFAULT_CAQH_ATTESTATION_WINDOW_DAYS = 120;

/** A whole number of days from 1 to 365. */
function isValidWindow(value: number | null | undefined): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 365;
}

/** The organization's value, else the platform's, else the default. A
 * stored value that is not a whole number of days from 1 to 365 is skipped. */
export function resolveCaqhAttestationWindowDays(
  platform?: number | null,
  organization?: number | null,
): number {
  return [organization, platform].find(isValidWindow) ?? DEFAULT_CAQH_ATTESTATION_WINDOW_DAYS;
}
