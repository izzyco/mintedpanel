// Field parts shared by the intake form and documents steps (boards 5a, 5b).
import { Fragment, useState, type ReactNode, type Ref } from "react";
import { Lock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { HelpReason } from "@/lib/intakeFlow";
import {
  ariaFor,
  isoToUsDate,
  parseUsDate,
  typeDate,
  type FieldError,
  type MissingField,
} from "@/lib/intakeForm";
import { cn } from "@/lib/utils";

export const BOX =
  "h-11 w-full rounded-md border border-[#D6D3CE] bg-white px-3 text-[16px] text-foreground md:text-[16px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[invalid=true]:border-[#DC2626]";

export function ErrorText({ error }: { error: FieldError | null }) {
  if (!error) return null;
  return (
    <p id={error.id} className="text-[12px] leading-snug text-[#B91C1C]">
      {error.message}
    </p>
  );
}

export function Note({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="text-[11px] leading-snug text-muted-foreground">{children}</p>;
}

export function Field({
  id,
  label,
  required = false,
  error = null,
  note,
  children,
}: {
  id: string;
  label: ReactNode;
  required?: boolean;
  error?: FieldError | null;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-[12px] font-medium leading-normal">
        {label}
        {required ? <span aria-hidden> *</span> : null}
      </Label>
      {children}
      <ErrorText error={error} />
      <Note>{note}</Note>
    </div>
  );
}

// A value on her live record she can't change here; she asks for a fix.
export function LockedField({
  id,
  label,
  display,
  name,
  onTell,
}: {
  id: string;
  label: string;
  display: string;
  name: string;
  onTell: () => void;
}) {
  return (
    <Field
      id={id}
      label={label}
      required
      note={
        <>
          On file.{" "}
          <button
            type="button"
            className="font-medium text-primary underline"
            aria-label={`Tell us your ${name} is wrong`}
            onClick={onTell}
          >
            Wrong? Tell us
          </button>
        </>
      }
    >
      <div className="relative">
        <Lock
          className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[#4B5563]"
          aria-hidden
        />
        <Input
          id={id}
          readOnly
          value={display}
          className={cn(BOX, "border-[#E8E5E0] bg-[#F5F4F1] pl-8 text-[#374151]")}
        />
      </div>
    </Field>
  );
}

// MM/DD/YYYY as text: she types digits, the slashes appear. The draft only
// ever receives a whole, real date (ISO) or null.
export function DateField({
  id,
  label,
  required = true,
  value,
  onChange,
  error = null,
  groupError = null,
  note,
  autoComplete,
}: {
  id: string;
  label: ReactNode;
  required?: boolean;
  value: string | null;
  onChange: (iso: string | null) => void;
  error?: FieldError | null;
  /** A message shown elsewhere, for a row this date belongs to. */
  groupError?: FieldError | null;
  note?: ReactNode;
  autoComplete?: string;
}) {
  const [text, setText] = useState(() => isoToUsDate(value));
  const [badFormat, setBadFormat] = useState(false);
  const shown = badFormat
    ? { id: `${id}-format`, message: "Enter the date as MM/DD/YYYY." }
    : error;
  return (
    <Field id={id} label={label} required={required} error={shown} note={note}>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete={autoComplete ?? "off"}
        placeholder="MM/DD/YYYY"
        maxLength={10}
        value={text}
        onChange={(e) => {
          const next = typeDate(e.target.value);
          setText(next);
          const iso = parseUsDate(next);
          if (iso) setBadFormat(false);
          onChange(iso);
        }}
        onBlur={() => setBadFormat(text !== "" && !parseUsDate(text))}
        className={BOX}
        {...ariaFor(shown ?? groupError)}
      />
    </Field>
  );
}

export function ErrorSummary({
  ref,
  title,
  items,
}: {
  ref: Ref<HTMLDivElement>;
  title: string;
  items: MissingField[];
}) {
  if (items.length === 0) return null;
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="rounded-md border border-[#F3C7C7] bg-[#FDF2F2] px-3.5 py-3 text-[13px] leading-normal text-[#7F1D1D] outline-none focus-visible:ring-2 focus-visible:ring-[#B91C1C]"
    >
      <p className="font-semibold">{title}</p>
      <p>
        {items.map((item, i) => (
          <Fragment key={item.key}>
            {i > 0 ? " · " : null}
            <a
              href={`#${item.ids[0]}`}
              className="underline"
              onClick={(e) => {
                e.preventDefault();
                const target = document.getElementById(item.ids[0]);
                target?.focus();
                target?.scrollIntoView({ block: "center" });
              }}
            >
              {item.label}
            </a>
          </Fragment>
        ))}
      </p>
    </div>
  );
}

export function HelpLine({ onHelp }: { onHelp: (reason: HelpReason) => void }) {
  return (
    <p className="border-t border-[#F0EEEA] pt-4 text-center text-[12px] leading-normal text-muted-foreground">
      Stuck on a question?{" "}
      <button
        type="button"
        className="font-medium text-primary underline"
        onClick={() => onHelp({ kind: "help" })}
      >
        I need help
      </button>
      . Your practice administrator will reach out.
    </p>
  );
}
