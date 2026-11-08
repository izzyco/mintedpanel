// Provider intake screens (canvas boards 3, 4, 4b, 4c, 5). Presentational:
// the route owns the step and every call. Practice name first, Minted as the
// operator ("Secure intake by Minted Panel"), phone width first.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { format } from "date-fns";
import { ArrowLeft, CircleCheck, Clock, Lock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { consentParagraphs } from "@/lib/intakeConsent";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { localTodayIso } from "@/hooks/useEnrollmentReadiness";

// #6B7280 (muted-foreground) is 4.4:1 on the #F5F4F1 ground, so text that
// sits on the ground, a disabled button included, uses #4B5563 (6.9:1).
const ON_GROUND = "text-[#4B5563]";
const PRIMARY =
  "h-12 w-full text-[15px] disabled:opacity-100 disabled:border disabled:border-border disabled:bg-muted disabled:text-[#4B5563]";
const SECONDARY = "h-12 w-full border-[#D6D3CE] text-[15px]";
const FIELD =
  "rounded-[4px] border-[#D6D3CE] focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-[rgba(27,77,62,0.18)]";
// An inline action inside a sentence, with its hit area grown to 44px tall.
const INLINE_ACTION =
  "relative font-medium text-primary underline underline-offset-2 after:absolute after:inset-x-0 after:-inset-y-[13px]";

export function IntakeShell({
  practiceName,
  signedInAs,
  onSignOut,
  onBack,
  aside,
  children,
}: {
  practiceName: string | null;
  signedInAs?: string;
  onSignOut?: () => void;
  /** "← Your details" on the signed-in row (board 5b). */
  onBack?: () => void;
  /** Notes that sit above the card, like the board's banners. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    // overflow-wrap: anywhere lets a long email, practice name or file name
    // break onto the next line instead of being cut off or pushing the card wide.
    <div className="min-h-dvh bg-muted px-5 pb-6 pt-7 text-foreground [overflow-wrap:anywhere]">
      <div className="mx-auto w-full max-w-md">
        <div className={cn("flex items-center gap-2.5", signedInAs ? "mb-2.5" : "mb-[22px]")}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-white">
            <ShieldCheck className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            {practiceName ? (
              <>
                <div className="text-[15px] font-semibold">{practiceName}</div>
                <div className={cn("text-[11px]", ON_GROUND)}>Secure intake by Minted Panel</div>
              </>
            ) : (
              <div className={cn("text-[12px]", ON_GROUND)}>Secure intake by Minted Panel</div>
            )}
          </div>
          {onSignOut ? (
            <Button
              variant="link"
              className="h-11 px-1.5 text-[13px] font-normal underline"
              onClick={onSignOut}
            >
              Sign out
            </Button>
          ) : null}
        </div>
        {signedInAs ? (
          <div className="mb-2.5 flex items-center justify-between gap-3">
            {onBack ? (
              <Button
                type="button"
                variant="ghost"
                className="-ml-2 h-11 flex-none px-2 text-[13px] font-normal text-primary"
                onClick={onBack}
              >
                <ArrowLeft aria-hidden />
                Your details
              </Button>
            ) : null}
            <div className={cn("ml-auto text-right text-[12px]", ON_GROUND)}>
              Signed in as {signedInAs}
            </div>
          </div>
        ) : null}
        {aside ? <div className="mb-3 space-y-3">{aside}</div> : null}
        <Card>
          <CardContent className="space-y-4 px-5 py-[22px]">{children}</CardContent>
        </Card>
      </div>
    </div>
  );
}

function Intro({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {icon ? <div className="pb-1.5">{icon}</div> : null}
      <h1 className="text-[18px] font-semibold leading-[1.3]">{title}</h1>
      {children ? (
        <p className="text-[13px] leading-normal text-muted-foreground">{children}</p>
      ) : null}
    </div>
  );
}

function Email({ children }: { children: string }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

function Helper({ children }: { children: ReactNode }) {
  return <p className="text-center text-[12px] leading-[1.45] text-muted-foreground">{children}</p>;
}

function ErrorLine({ id, message }: { id?: string; message: string | null }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-[13px] leading-[1.45] text-[var(--mp-danger-ink)]">
      {message}
    </p>
  );
}

// Board 4b. One screen for unknown, expired and revoked links.
export function InvalidLink() {
  return (
    <IntakeShell practiceName={null}>
      <Intro
        icon={<Clock className="h-6 w-6 text-muted-foreground" aria-hidden />}
        title="This invitation is no longer valid"
      >
        It may have expired or been replaced by a newer one. Use the newest email from your
        practice, or ask your practice administrator for a new invitation.
      </Intro>
    </IntakeShell>
  );
}

// A server or network failure, kept apart from an invalid link so a provider
// with a good link isn't told it's dead.
export function TryAgain({ onRetry }: { onRetry: () => void }) {
  return (
    <IntakeShell practiceName={null}>
      <Intro title="Something went wrong">
        We couldn't open your form just now. Please try again in a moment.
      </Intro>
      <Button className={PRIMARY} onClick={onRetry}>
        Try again
      </Button>
    </IntakeShell>
  );
}

// Intake is paused (provider_intake_settings.paused). Her link and what she
// saved are still good.
export function IntakePaused() {
  return (
    <IntakeShell practiceName={null}>
      <Intro title="This form is paused for now">Try again later, or contact your practice.</Intro>
    </IntakeShell>
  );
}

// Board 3. The code always goes to the invited address (slice 1, S6).
export function IdentifyStep({
  email,
  sending,
  error,
  onSend,
}: {
  email: string;
  sending: boolean;
  error: string | null;
  onSend: () => void;
}) {
  return (
    <>
      <Intro title="Confirm it's you">
        Your practice administrator invited you. We'll send a 6-digit code to <Email>{email}</Email>{" "}
        to open your form.
      </Intro>
      <ErrorLine message={error} />
      <Button className={PRIMARY} onClick={onSend} disabled={sending}>
        {sending ? "Sending…" : "Send me a code"}
      </Button>
      <Helper>Not your email address? Ask your practice administrator to invite you again.</Helper>
      <Helper>Have your NPI, license, CAQH ID, and your CAQH and PECOS logins handy.</Helper>
    </>
  );
}

const RESEND_AFTER_SECONDS = 60;

// Board 4. Six boxes drawn from one real input laid transparently over them,
// so a tap anywhere focuses it and one-time-code autofill and paste still work.
export function CodeStep({
  email,
  checking,
  error,
  onSubmit,
  onResend,
}: {
  email: string;
  checking: boolean;
  error: string | null;
  onSubmit: (code: string) => void;
  onResend: () => Promise<boolean>;
}) {
  const [code, setCode] = useState("");
  const [focused, setFocused] = useState(true);
  const [wait, setWait] = useState(RESEND_AFTER_SECONDS);
  const input = useRef<HTMLInputElement>(null);
  const activeBox = focused && !checking ? Math.min(code.length, 5) : -1;

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  // A full field takes no more digits, so select the wrong code for the next one to replace.
  useEffect(() => {
    if (error) input.current?.select();
  }, [error]);

  function change(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6) onSubmit(digits);
  }

  return (
    <>
      <Intro title="Enter your code">
        We sent a 6-digit code to <Email>{email}</Email>. It expires in 10 minutes.
      </Intro>
      <div className="space-y-2">
        <Label htmlFor="intake-code" className="text-[12px]">
          6-digit code
        </Label>
        <div className="relative">
          <div aria-hidden className="grid grid-cols-6 gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className={cn(
                  "flex h-[52px] items-center justify-center rounded-[4px] border bg-white font-mono text-[22px] font-medium",
                  error ? "border-destructive" : code[i] ? "border-primary" : "border-[#D6D3CE]",
                  i === activeBox &&
                    (error
                      ? "ring-2 ring-[rgba(220,38,38,0.18)]"
                      : "border-primary ring-2 ring-[rgba(27,77,62,0.18)]"),
                )}
              >
                {code[i] ?? ""}
              </div>
            ))}
          </div>
          <input
            ref={input}
            id="intake-code"
            value={code}
            onChange={(e) => change(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            readOnly={checking}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "intake-code-error" : undefined}
            className="absolute inset-0 h-full w-full cursor-text bg-transparent text-[16px] text-transparent caret-transparent outline-none selection:bg-transparent"
            autoFocus
          />
        </div>
        <ErrorLine id="intake-code-error" message={error} />
      </div>
      <Helper>Continues automatically when all six digits are in.</Helper>
      <Button
        className={PRIMARY}
        disabled={checking || code.length < 6}
        onClick={() => onSubmit(code)}
      >
        {checking ? "Checking…" : "Continue"}
      </Button>
      <Helper>
        Didn't get it? Check spam, or{" "}
        {wait > 0 ? (
          <span>
            resend in {Math.floor(wait / 60)}:{String(wait % 60).padStart(2, "0")}
          </span>
        ) : (
          <button
            type="button"
            className={INLINE_ACTION}
            onClick={async () => {
              setCode("");
              if (await onResend()) setWait(RESEND_AFTER_SECONDS);
            }}
          >
            send a new code
          </button>
        )}
        .
      </Helper>
      <Helper>You can ask for 3 codes every 10 minutes. Use the newest one.</Helper>
    </>
  );
}

// Board 5. Signing saves her typed name with this text's version and the
// server's time (provider_intake_consents).
export function ConsentStep({
  practiceName,
  signing,
  error,
  onSign,
  onHelp,
}: {
  practiceName: string;
  signing: boolean;
  error: string | null;
  onSign: (typedName: string) => void;
  onHelp: () => void;
}) {
  const [name, setName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const ready = name.trim().length > 1 && agreed && !signing;
  return (
    <>
      <Intro title="Your consent">Please read and sign before you start your details.</Intro>
      <div className="space-y-2.5 rounded-[4px] border border-border bg-[#FAFAF8] p-3.5 text-[13px] leading-[1.55]">
        {consentParagraphs(practiceName).map((p) => (
          <p key={p.slice(0, 24)}>{p}</p>
        ))}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="consent-name" className="text-[12px]">
          Type your full name to sign <span aria-hidden>*</span>
        </Label>
        <Input
          id="consent-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          maxLength={200}
          aria-required
          className={cn(FIELD, "h-11 bg-[#FDFDFC] px-3 text-[16px] md:text-[16px]")}
        />
      </div>
      <Label
        htmlFor="consent-agree"
        className="flex min-h-11 cursor-pointer items-start gap-2.5 text-[13px] font-normal leading-[1.45]"
      >
        <Checkbox
          id="consent-agree"
          checked={agreed}
          onCheckedChange={(v) => setAgreed(v === true)}
          aria-required
          className="h-5 w-5 rounded-[4px] border-[#6B7280]"
        />
        <span>
          I've read this and I agree. <span aria-hidden>*</span>
        </span>
      </Label>
      <div className="flex justify-between border-t border-[var(--mp-border-subtle)] pt-3 text-[13px]">
        <span className="text-muted-foreground">Date</span>
        <span className="font-medium">{fmtDate(localTodayIso())}</span>
      </div>
      <p className="text-[12px] leading-normal text-muted-foreground">
        Your typed name, the date and this exact text are saved together as your signature on your
        file at {practiceName}.
      </p>
      <ErrorLine id="consent-error" message={error} />
      <Button className={PRIMARY} disabled={!ready} onClick={() => onSign(name.trim())}>
        {signing ? "Signing…" : "Sign and continue"}
      </Button>
      <Helper>
        Questions about this?{" "}
        <button type="button" className={INLINE_ACTION} onClick={onHelp}>
          I need help
        </button>
        . Your practice administrator will reach out.
      </Helper>
    </>
  );
}

// Board 4b. `until` is when the next code may be sent; at or past it, only the
// wrong tries locked this code, so a new one can go right away.
export function TooManyTries({
  until,
  now,
  onSend,
}: {
  until: number;
  now: number;
  onSend: () => void;
}) {
  const paused = now < until;
  const at = format(until, "h:mm a");
  return (
    <>
      <Intro
        icon={<Lock className="h-6 w-6 text-[var(--mp-warn-ink)]" aria-hidden />}
        title="Too many tries"
      >
        {paused
          ? `For your security, new codes are paused for 10 minutes. Come back after ${at}.`
          : "That code is locked after too many wrong tries. Send yourself a new code."}
      </Intro>
      <Button className={PRIMARY} disabled={paused} onClick={onSend}>
        {paused ? `Send me a new code · ${at}` : "Send me a new code"}
      </Button>
    </>
  );
}

// Board 4c. Her answers are saved as she goes, so both say so.
export function SignedOut({
  reason,
  email,
  onContinue,
}: {
  reason: "signed_out" | "timed_out";
  email: string;
  onContinue: () => void;
}) {
  if (reason === "signed_out") {
    return (
      <>
        <Intro
          icon={<CircleCheck className="h-6 w-6 text-[var(--mp-ok-ink)]" aria-hidden />}
          title="You're signed out"
        >
          Your answers are saved. Sign in again to keep going.
        </Intro>
        <Button variant="outline" className={SECONDARY} onClick={onContinue}>
          Sign in again
        </Button>
      </>
    );
  }
  return (
    <>
      <Intro
        icon={<Clock className="h-6 w-6 text-muted-foreground" aria-hidden />}
        title="You were signed out to keep your details safe"
      >
        Your answers are saved. We'll send a new code to <Email>{email}</Email>.
      </Intro>
      <Button className={PRIMARY} onClick={onContinue}>
        Send me a code
      </Button>
    </>
  );
}
