import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { canResend, RESEND_COOLDOWN_MS } from "@/lib/providerOnboarding";
import { cn } from "@/lib/utils";
import type { OnboardingEvent } from "@/types/providerOnboarding";

// Disabled, but its text keeps full contrast: the dashed border says "not now".
const SENT_LOOK =
  "border-dashed border-[var(--mp-border-dashed)] text-muted-foreground disabled:opacity-100";

const COOLDOWN_MINUTES = RESEND_COOLDOWN_MS / 60_000;

type Size = ComponentProps<typeof Button>["size"];

export function SentButton({ size, className }: { size?: Size; className?: string }) {
  return (
    <Button variant="outline" size={size} disabled className={cn(SENT_LOOK, className)}>
      {`Sent · resend in ${COOLDOWN_MINUTES} min`}
    </Button>
  );
}

export function ResendButton({
  events,
  now,
  onResend,
  label = "Resend",
  pending = false,
  size,
  className,
}: {
  events: OnboardingEvent[];
  now: Date;
  onResend: () => void;
  label?: string;
  pending?: boolean;
  size?: Size;
  className?: string;
}) {
  if (!canResend(events, now)) return <SentButton size={size} className={className} />;
  return (
    <Button
      variant="outline"
      size={size}
      className={className}
      onClick={onResend}
      disabled={pending}
    >
      {pending ? "Sending…" : label}
    </Button>
  );
}
