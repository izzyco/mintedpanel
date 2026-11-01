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

/** The check a stored value must pass; empty when valid. null inherits. */
export function validateCaqhAttestationWindowDays(value: unknown): string[] {
  if (value == null || isValidCaqhAttestationWindowDays(value)) return [];
  return [
    `The CAQH attestation window must be a whole number of days from 1 to ${MAX_CAQH_ATTESTATION_WINDOW_DAYS}.`,
  ];
}

export interface CaqhAttestationWindowResolution {
  windowDays: number;
  /** Stored values that were not used, and why, so Mission Control can flag
   * them ("override ignored: invalid", A19). Empty when everything stored
   * was used. */
  ignored: Array<{ layer: "platform" | "organization"; reasons: string[] }>;
}

/** The organization's value, else the platform's, else the default, plus
 * which stored value was ignored and why. */
export function explainCaqhAttestationWindowDays(
  platform?: unknown,
  organization?: unknown,
): CaqhAttestationWindowResolution {
  const ignored: CaqhAttestationWindowResolution["ignored"] = [];
  for (const [layer, value] of [
    ["platform", platform],
    ["organization", organization],
  ] as const) {
    const reasons = validateCaqhAttestationWindowDays(value);
    if (reasons.length > 0) ignored.push({ layer, reasons });
  }
  const windowDays =
    [organization, platform].find(isValidCaqhAttestationWindowDays) ??
    DEFAULT_CAQH_ATTESTATION_WINDOW_DAYS;
  return { windowDays, ignored };
}

/** The organization's value, else the platform's, else the default. A stored
 * value that is not a whole number of days from 1 to 365 is not used;
 * explainCaqhAttestationWindowDays reports it. */
export function resolveCaqhAttestationWindowDays(
  platform?: number | null,
  organization?: number | null,
): number {
  return explainCaqhAttestationWindowDays(platform, organization).windowDays;
}
