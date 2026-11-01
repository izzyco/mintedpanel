// The NPI Registry part of a provider form's review step — MINT-110 (A30b,
// A35). Shared by Add Provider's Review step and the roster form's review.
//
// It says what the registry check found — "Checking the NPI Registry…" while
// it runs, updated in place — and lists every advisory the policy shows on the
// review step, each with one-click actions and no reason to type: go to the
// field, use the registry's value, check again, or confirm. Values a pick
// filled are marked "From NPI Registry, <pull date>"; submitting confirms
// them. Nothing here stops the save. Composition of stock primitives, logged
// in DESIGN-DEBT.md.
import { useId } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNpiRegistryCheck } from "@/hooks/useNpiRegistry";
import {
  buildNpiRegistryReview,
  shownAdvisories,
  type NpiReviewAdvisory,
  type NpiReviewFixTarget,
  type NpiReviewInput,
} from "@/lib/npiRegistryReview";
import type { NpiRegistryPolicy } from "@/lib/npiRegistryPolicy";
import { cn } from "@/lib/utils";

const FIX_LABEL: Record<NpiReviewFixTarget["field"], string> = {
  npi: "Go to NPI",
  firstName: "Go to name",
  credentials: "Go to Credentials",
  taxonomyCode: "Go to Taxonomy code",
  licenseNumber: "Go to license",
};

export interface NpiRegistryReviewProps {
  /** The NPI, separators stripped. */
  npi: string;
  verify: boolean;
  firstName: string;
  lastName: string;
  entered: NpiReviewInput["entered"];
  policy: NpiRegistryPolicy;
  /** Advisory ids staff confirmed. */
  confirmed: ReadonlySet<string>;
  onToggleConfirm: (id: string) => void;
  onFix: (target: NpiReviewFixTarget) => void;
  /** Use the registry's value for this field (choose, not clear and type). */
  onUseRegistryValue: (advisory: NpiReviewAdvisory) => void;
  /** Values a pick filled that staff left alone, one line per pull date:
   * "From NPI Registry, <date>: …" — submitting confirms them. */
  sourced: { label: string; values: string[] }[];
}

export function NpiRegistryReview({
  npi,
  verify,
  firstName,
  lastName,
  entered,
  policy,
  confirmed,
  onToggleConfirm,
  onFix,
  onUseRegistryValue,
  sourced,
}: NpiRegistryReviewProps) {
  const titleId = useId();
  const itemId = useId();
  const typed = { firstName, lastName };
  const check = useNpiRegistryCheck(npi, verify, typed, policy);
  const review = buildNpiRegistryReview({
    npi,
    verify,
    state: check.state,
    typed,
    entered,
    policy,
    confirmed,
  });
  const shown = shownAdvisories(review);
  if (!review.line && shown.length === 0 && sourced.length === 0) return null;
  return (
    <section
      aria-labelledby={titleId}
      className="space-y-2 rounded-md border border-border p-4 text-[13px] text-foreground"
    >
      <h3
        id={titleId}
        className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
      >
        NPI Registry check
      </h3>
      {/* Updated in place when a running check ends. */}
      <div role="status" aria-live="polite">
        {review.line ? (
          <p className="flex items-start gap-1.5">
            {review.line.tone === "ok" ? (
              <CircleCheck
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--mp-ok-ink)]"
              />
            ) : review.line.tone === "warn" ? (
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--mp-warn-ink)]"
              />
            ) : null}
            <span>
              <span
                className={cn(
                  "font-medium",
                  review.line.tone === "warn" && "text-[var(--mp-warn-ink)]",
                )}
              >
                {review.line.title}
              </span>
              {review.line.detail ? (
                <span className="text-muted-foreground"> {review.line.detail}</span>
              ) : null}
            </span>
          </p>
        ) : null}
      </div>
      {shown.length > 0 ? (
        <>
          <ul aria-label="To review" className="space-y-2">
            {shown.map((advisory, index) => {
              const describedBy = `${itemId}-${index}`;
              const isConfirmed = confirmed.has(advisory.id);
              return (
                <li key={advisory.id} className="rounded-md border border-border p-2">
                  <p id={describedBy}>
                    <span className="font-medium">{advisory.title}</span>
                    {advisory.detail ? (
                      <span className="text-muted-foreground"> {advisory.detail}</span>
                    ) : null}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {advisory.fix && advisory.fix !== "retry" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[12px]"
                        aria-describedby={describedBy}
                        onClick={() => onFix(advisory.fix as NpiReviewFixTarget)}
                      >
                        {FIX_LABEL[advisory.fix.field]}
                      </Button>
                    ) : null}
                    {advisory.registryValue ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[12px]"
                        aria-describedby={describedBy}
                        onClick={() => onUseRegistryValue(advisory)}
                      >
                        Use {advisory.registryValue}
                      </Button>
                    ) : null}
                    {advisory.fix === "retry" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[12px]"
                        aria-describedby={describedBy}
                        onClick={check.retry}
                      >
                        Check again
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[12px]"
                      aria-describedby={describedBy}
                      aria-pressed={isConfirmed}
                      onClick={() => onToggleConfirm(advisory.id)}
                    >
                      {isConfirmed ? "Confirmed" : "Confirm"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-[12px] text-muted-foreground">
            Fix it, use the registry&apos;s value, or confirm it. Saving works either way.
          </p>
        </>
      ) : null}
      {sourced.map((line) => (
        <p key={line.label} className="text-[12px]">
          <span className="font-medium">{line.label}:</span> {line.values.join("; ")}.{" "}
          <span className="text-muted-foreground">Submitting confirms them.</span>
        </p>
      ))}
    </section>
  );
}
