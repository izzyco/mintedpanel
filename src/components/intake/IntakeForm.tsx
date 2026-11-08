// Boards 5a (first visit) and 5a-2 (a re-invited provider reviews what is on
// file). The SSN and the logins are write-only: their inputs are uncontrolled,
// each goes from its input straight to the vault when she leaves the field,
// and only the last 4 digits or an "on file" flag ever reach the draft.
import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import {
  BOX,
  DateField,
  ErrorSummary,
  ErrorText,
  Field,
  HelpLine,
  LockedField,
  Note,
} from "@/components/intake/IntakeFields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { localTodayIso } from "@/hooks/useEnrollmentReadiness";
import {
  INTAKE_ANSWER_MAX_LENGTH,
  INTAKE_PASSWORD_MAX_LENGTH,
  INTAKE_USERNAME_MAX_LENGTH,
  type IntakePortal,
  type SaveLoginResult,
  type SaveSsnResult,
} from "@/lib/intakeAnswers";
import type { HelpReason } from "@/lib/intakeFlow";
import { isValidNpi } from "@/lib/providerIdentity";
import {
  LOGINS,
  addLicense,
  fieldId,
  missingFields,
  npiProblem,
  provenance,
  ssnProblem,
  typeSsn,
  removeLicense,
  setField,
  type FieldPath,
  ariaFor,
  errorOf,
  thingsLeft,
  type FieldError,
} from "@/lib/intakeForm";
import { sectionProgress } from "@/lib/providerOnboarding";
import { PROVIDER_TAXONOMY_OPTIONS, taxonomyLabel } from "@/lib/providerTaxonomy";
import { US_STATES } from "@/lib/usStates";
import { cn } from "@/lib/utils";
import type { FieldValue, IntakeDraft, IntakeLicense } from "@/types/providerOnboarding";

const SECTIONS = [
  ["identity", "Identity"],
  ["contact", "Contact"],
  ["licenses", "Licenses"],
  ["logins", "Logins"],
] as const;

export function FormStep({
  practiceName,
  draft,
  status,
  onChange,
  onContinue,
  onFinishLater,
  onHelp,
  onSaveSsn,
  onSaveLogin,
  showMissing = false,
}: {
  practiceName: string;
  draft: IntakeDraft;
  /** Whether her answers are saved, shown above the buttons. */
  status?: ReactNode;
  /** Applied to the latest draft, which may be newer than this render's. */
  onChange: (update: (draft: IntakeDraft) => IntakeDraft) => void;
  /** False when something is still missing, so the form shows what. */
  onContinue: () => Promise<boolean>;
  onFinishLater: () => void;
  onHelp: (reason: HelpReason) => void;
  /** Throws on a server or network failure. */
  onSaveSsn: (full: string) => Promise<SaveSsnResult>;
  /** Throws on a server or network failure. */
  onSaveLogin: (
    portal: IntakePortal,
    username: string,
    password: string,
  ) => Promise<SaveLoginResult>;
  /** Opens with the summary of what is missing, as after a Continue. */
  showMissing?: boolean;
}) {
  const today = localTodayIso();
  const [tries, setTries] = useState(showMissing ? 1 : 0);
  // Removing a row shifts the rows below it; a new run remounts them so a
  // date half-typed in one row can't land in another.
  const [licenseRun, setLicenseRun] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tries > 0) summaryRef.current?.focus();
  }, [tries]);

  const missing = tries > 0 ? missingFields(draft) : [];
  const byKey = new Map(missing.map((m) => [m.key, m]));
  const errorAt = (key: string) => errorOf(byKey.get(key));
  const memberError = (key: string, id: string) => {
    const item = byKey.get(key);
    return item?.ids.includes(id) ? errorOf(item) : null;
  };

  const set = (path: FieldPath, value: string | null) =>
    onChange((latest) => setField(latest, path, value, today));
  const note = (field: FieldValue<string>) => provenance(field.source, today);
  const progress = sectionProgress(draft);
  const { identity, contact } = draft;
  const address = contact.homeAddress;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="text-[12px] text-muted-foreground">Step 1 of 2</p>
          <h1 className="text-[18px] leading-snug font-semibold">Your credentialing details</h1>
        </div>
        <span className="flex-none text-[12px] text-muted-foreground">* required</span>
      </div>

      <ErrorSummary
        ref={summaryRef}
        title={thingsLeft(missing.length, "continue")}
        items={missing}
      />

      <ul aria-label="Your progress" className="flex flex-wrap gap-1.5 text-[12px]">
        {SECTIONS.map(([key, label]) => (
          <li key={key} className="rounded-full bg-[#F0EEEA] px-2.5 py-1">
            {label} · {progress[key].done} of {progress[key].total}
          </li>
        ))}
      </ul>

      <Section id="identity" title="Identity" first>
        <div className="grid grid-cols-2 gap-3">
          <TextField
            path={["identity", "firstName"]}
            label="First name"
            field={identity.firstName}
            note={note(identity.firstName)}
            error={errorAt("identity.firstName")}
            onSet={set}
            autoComplete="given-name"
          />
          <TextField
            path={["identity", "lastName"]}
            label="Last name"
            field={identity.lastName}
            note={note(identity.lastName)}
            error={errorAt("identity.lastName")}
            onSet={set}
            autoComplete="family-name"
          />
        </div>
        {identity.npi.locked ? (
          <LockedField
            id={fieldId("identity", "npi")}
            label="NPI"
            display={identity.npi.value ?? ""}
            name="NPI"
            onTell={() => onHelp({ kind: "fix", field: "npi" })}
          />
        ) : (
          <NpiField
            field={identity.npi}
            note={note(identity.npi)}
            error={errorAt("identity.npi")}
            onSet={(npi) => set(["identity", "npi"], npi)}
          />
        )}
        <Field
          id={fieldId("identity", "taxonomyCode")}
          label="Specialty"
          required
          error={errorAt("identity.taxonomyCode")}
          note={note(identity.taxonomyCode) ?? "Pick the one on your NPI record."}
        >
          <SpecialtyPicker
            id={fieldId("identity", "taxonomyCode")}
            value={identity.taxonomyCode.value}
            error={errorAt("identity.taxonomyCode")}
            onPick={(code) => set(["identity", "taxonomyCode"], code)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          {identity.dateOfBirth.locked ? (
            <LockedField
              id={fieldId("identity", "dateOfBirth")}
              label="Date of birth"
              display="On file"
              name="date of birth"
              onTell={() => onHelp({ kind: "fix", field: "dateOfBirth" })}
            />
          ) : (
            <DateField
              id={fieldId("identity", "dateOfBirth")}
              label="Date of birth"
              value={identity.dateOfBirth.value}
              onChange={(iso) => set(["identity", "dateOfBirth"], iso)}
              error={errorAt("identity.dateOfBirth")}
              note={note(identity.dateOfBirth)}
              autoComplete="bday"
            />
          )}
          <TextField
            path={["identity", "caqhId"]}
            label="CAQH ID"
            field={identity.caqhId}
            note={note(identity.caqhId)}
            error={errorAt("identity.caqhId")}
            onSet={set}
            inputMode="numeric"
            placeholder="8 digits"
            autoComplete="off"
          />
        </div>
        {identity.ssn.locked ? (
          <LockedField
            id={fieldId("identity", "ssn")}
            label="Social Security number"
            display={`•••-••-${identity.ssn.value ?? ""}`}
            name="SSN"
            onTell={() => onHelp({ kind: "fix", field: "ssn" })}
          />
        ) : (
          <SsnField
            last4={identity.ssn.value}
            note={note(identity.ssn)}
            error={errorAt("identity.ssn")}
            onLast4={(last4) => set(["identity", "ssn"], last4)}
            onSave={onSaveSsn}
          />
        )}
      </Section>

      <Section id="contact" title="Contact">
        <Field
          id={fieldId("contact", "email")}
          label="Email"
          note="Verified today. To use another address, ask your practice."
        >
          <Input
            id={fieldId("contact", "email")}
            type="email"
            readOnly
            value={contact.email}
            className={cn(BOX, "border-[#E8E5E0] bg-[#F5F4F1] text-[#4B5563]")}
          />
        </Field>
        <TextField
          path={["contact", "mobile"]}
          label="Mobile phone"
          field={contact.mobile}
          note={note(contact.mobile)}
          error={errorAt("contact.mobile")}
          onSet={set}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="(555) 555-0123"
        />
        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-1.5 text-[12px] font-medium">
            Home address<span aria-hidden> *</span>
          </legend>
          {(
            [
              ["street", "Street address", "address-line1"],
              ["city", "City", "address-level2"],
            ] as const
          ).map(([key, label, autoComplete]) => (
            <Input
              key={key}
              id={fieldId("address", key)}
              aria-label={label}
              placeholder={label}
              autoComplete={autoComplete}
              value={address[key].value ?? ""}
              onChange={(e) => set(["address", key], e.target.value)}
              maxLength={INTAKE_ANSWER_MAX_LENGTH}
              className={BOX}
              {...ariaFor(memberError("contact.address", fieldId("address", key)))}
            />
          ))}
          <div className="grid grid-cols-2 gap-2">
            <StateSelect
              id={fieldId("address", "state")}
              aria-label="State"
              autoComplete="address-level1"
              value={address.state.value}
              onChange={(state) => set(["address", "state"], state)}
              error={memberError("contact.address", fieldId("address", "state"))}
            />
            <Input
              id={fieldId("address", "zip")}
              aria-label="ZIP code"
              placeholder="ZIP"
              inputMode="numeric"
              autoComplete="postal-code"
              value={address.zip.value ?? ""}
              onChange={(e) => set(["address", "zip"], e.target.value)}
              maxLength={INTAKE_ANSWER_MAX_LENGTH}
              className={BOX}
              {...ariaFor(memberError("contact.address", fieldId("address", "zip")))}
            />
          </div>
          <ErrorText error={errorAt("contact.address")} />
          <Note>{groupNote(Object.values(address), today)}</Note>
        </fieldset>
      </Section>

      <Section
        id="licenses"
        title="State licenses"
        action={
          <Button
            id={fieldId("licenses", "add")}
            type="button"
            variant="outline"
            className="h-11 border-[#D6D3CE] px-3 text-[13px] font-normal"
            onClick={() => onChange(addLicense)}
            {...ariaFor(errorAt("licenses.none"))}
          >
            + Add a state
          </Button>
        }
      >
        {draft.licenses.map((row, i) => (
          <LicenseRow
            key={`${licenseRun}-${i}`}
            index={i}
            row={row}
            today={today}
            error={errorAt(`licenses.${i}`)}
            invalidIds={byKey.get(`licenses.${i}`)?.ids ?? []}
            onSet={(key, value) => set(["licenses", i, key], value)}
            onRemove={
              draft.licenses.length > 1
                ? () => {
                    onChange((latest) => removeLicense(latest, i));
                    setLicenseRun((run) => run + 1);
                  }
                : undefined
            }
          />
        ))}
        <ErrorText error={errorAt("licenses.none")} />
      </Section>

      <Section
        id="logins"
        title="Logins"
        note="Never shown back. Used only to file and keep up your payer applications."
      >
        {LOGINS.map((login) => (
          <div key={login.key} className="flex flex-col gap-3">
            <h3 className="text-[13px] font-semibold">{login.title}</h3>
            <LoginFields
              login={login}
              onFile={draft.logins[login.flag]}
              error={errorAt(`logins.${login.key}`)}
              onSave={onSaveLogin}
            />
          </div>
        ))}
      </Section>

      <HelpLine onHelp={onHelp} />

      {status}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-12 flex-1 border-[#D6D3CE] text-[15px]"
          onClick={onFinishLater}
        >
          Finish later
        </Button>
        <Button
          type="button"
          className="h-12 flex-1 text-[15px]"
          onClick={() =>
            void onContinue().then((went) => {
              if (!went) setTries((t) => t + 1);
            })
          }
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  note,
  action,
  first = false,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  action?: ReactNode;
  first?: boolean;
  children: ReactNode;
}) {
  const headingId = fieldId(id, "heading");
  return (
    <section
      aria-labelledby={headingId}
      className={cn("flex flex-col gap-3.5", !first && "border-t border-[#F0EEEA] pt-[18px]")}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={headingId} className="text-[15px] font-semibold">
            {title}
          </h2>
          {note ? <p className="text-[12px] text-muted-foreground">{note}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// One line for a group of fields: where its values came from.
function groupNote(fields: FieldValue<string>[], today: string): string | null {
  const lines = [...new Set(fields.map((f) => provenance(f.source, today)).filter(Boolean))];
  return lines.length > 0 ? lines.join("; ") : null;
}

function TextField({
  path,
  label,
  field,
  note,
  error,
  onSet,
  ...input
}: {
  path: FieldPath;
  label: string;
  field: FieldValue<string>;
  note: string | null;
  error: FieldError | null;
  onSet: (path: FieldPath, value: string) => void;
  type?: string;
  inputMode?: "numeric" | "tel";
  autoComplete?: string;
  placeholder?: string;
}) {
  const id = fieldId(...path);
  return (
    <Field id={id} label={label} required error={error} note={note}>
      <Input
        id={id}
        value={field.value ?? ""}
        onChange={(e) => onSet(path, e.target.value)}
        maxLength={INTAKE_ANSWER_MAX_LENGTH}
        className={BOX}
        {...input}
        {...ariaFor(error)}
      />
    </Field>
  );
}

// The draft only ever holds an NPI that passes its check digit.
function NpiField({
  field,
  note,
  error,
  onSet,
}: {
  field: FieldValue<string>;
  note: string | null;
  error: FieldError | null;
  onSet: (npi: string | null) => void;
}) {
  const id = fieldId("identity", "npi");
  const [text, setText] = useState(field.value ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const shown = problem ? { id: `${id}-format`, message: problem } : error;
  return (
    <Field
      id={id}
      label="NPI"
      required
      error={shown}
      note={`${note ? `${note}. ` : ""}Check it carefully. After you submit, only your practice can change it.`}
    >
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        maxLength={10}
        value={text}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
          setText(digits);
          if (isValidNpi(digits)) setProblem(null);
          onSet(isValidNpi(digits) ? digits : null);
        }}
        onBlur={() => setProblem(npiProblem(text))}
        className={BOX}
        {...ariaFor(shown)}
      />
    </Field>
  );
}

function SpecialtyPicker({
  id,
  value,
  error,
  onPick,
}: {
  id: string;
  value: string | null;
  error: FieldError | null;
  onPick: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = PROVIDER_TAXONOMY_OPTIONS.filter((o) =>
    `${o.label} ${o.code}`.toLowerCase().includes(q),
  );
  const chosen = value ? `${taxonomyLabel(value) ?? "Specialty"} (${value})` : null;

  function pick(code: string) {
    onPick(code);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          className={cn(BOX, "flex h-auto min-h-11 items-center gap-2 py-2 text-left")}
          {...ariaFor(error)}
        >
          <span className={cn("min-w-0 flex-1", !chosen && "text-muted-foreground")}>
            {chosen ?? "Search, e.g. Physical Therapist"}
          </span>
          <ChevronDown className="h-4 w-4 flex-none text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] border-[#E8E5E0] p-0 shadow-none"
        // Keep focus in the search box; picking an option closes the popover.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="border-b border-[#F0EEEA] p-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search specialties"
            aria-label="Search specialties"
            className={BOX}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !shown[0]) return;
              e.preventDefault();
              pick(shown[0].code);
            }}
          />
        </div>
        <div role="listbox" aria-label="Specialties" className="max-h-64 overflow-y-auto py-1">
          {shown.length === 0 ? (
            <p className="px-3 py-3 text-center text-[13px] text-muted-foreground">
              No specialty matches
            </p>
          ) : (
            shown.map((o) => (
              <button
                key={o.code}
                type="button"
                role="option"
                aria-selected={o.code === value}
                onClick={() => pick(o.code)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-[14px] hover:bg-[#F5F4F1]",
                  o.code === value && "bg-[#F7FAF8]",
                )}
              >
                <span className="min-w-0 flex-1">{o.label}</span>
                <span className="flex-none text-[12px] text-muted-foreground">{o.code}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function StateSelect({
  id,
  value,
  onChange,
  error,
  ...rest
}: {
  id: string;
  value: string | null;
  onChange: (state: string) => void;
  error: FieldError | null;
  "aria-label"?: string;
  autoComplete?: string;
}) {
  return (
    <select
      id={id}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className={cn(BOX, "px-2.5")}
      {...rest}
      {...ariaFor(error)}
    >
      <option value="">State</option>
      {US_STATES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

function LicenseRow({
  index,
  row,
  today,
  error,
  invalidIds,
  onSet,
  onRemove,
}: {
  index: number;
  row: IntakeLicense;
  today: string;
  error: FieldError | null;
  invalidIds: string[];
  onSet: (key: keyof IntakeLicense, value: string | null) => void;
  onRemove?: () => void;
}) {
  const idOf = (key: keyof IntakeLicense) => fieldId("licenses", index, key);
  const errorFor = (key: keyof IntakeLicense) => (invalidIds.includes(idOf(key)) ? error : null);
  const state = row.state.value?.trim().toUpperCase();
  const name = state ? `${state} license` : `License ${index + 1}`;
  return (
    <div role="group" aria-label={name} className="flex flex-col gap-3">
      {onRemove ? (
        <div className="-mb-2 flex items-center justify-between">
          <span className="text-[13px] font-semibold">{name}</span>
          <Button
            type="button"
            variant="ghost"
            className="h-11 px-2.5 text-[13px] text-primary"
            aria-label={`Remove ${name}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        </div>
      ) : null}
      <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
        <Field id={idOf("state")} label="State" required>
          <StateSelect
            id={idOf("state")}
            value={row.state.value}
            onChange={(value) => onSet("state", value)}
            error={errorFor("state")}
          />
        </Field>
        <Field id={idOf("number")} label="License number" required>
          <Input
            id={idOf("number")}
            value={row.number.value ?? ""}
            onChange={(e) => onSet("number", e.target.value)}
            maxLength={INTAKE_ANSWER_MAX_LENGTH}
            autoComplete="off"
            className={BOX}
            {...ariaFor(errorFor("number"))}
          />
        </Field>
      </div>
      <DateField
        id={idOf("expiresOn")}
        label="Expires"
        value={row.expiresOn.value}
        onChange={(iso) => onSet("expiresOn", iso)}
        groupError={errorFor("expiresOn")}
      />
      <ErrorText error={error} />
      <Note>{groupNote([row.state, row.number, row.expiresOn], today)}</Note>
    </div>
  );
}

// A value she saved this visit: white with a check, so it never reads as the
// grey, locked rows she can't change (those say "Wrong? Tell us" instead).
function SavedRow({
  children,
  changeLabel,
  onChange,
}: {
  children: ReactNode;
  changeLabel: string;
  onChange: () => void;
}) {
  return (
    <div className="flex min-h-11 items-center gap-2.5 rounded-md border border-[#D6D3CE] bg-white pl-3">
      <Check className="h-4 w-4 flex-none text-[#047857]" strokeWidth={2.5} aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        className="h-11 flex-none rounded-md px-3 text-[14px] font-medium text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-label={changeLabel}
        onClick={onChange}
      >
        Change
      </button>
    </div>
  );
}

const SSN_NOT_SAVED =
  "We couldn't save your Social Security number just now. Move to another field to try again.";
const SSN_LOCKED =
  "Your Social Security number is already on file and can't be changed here. Ask your practice to fix it.";

// The input is uncontrolled, so the full number lives only in the field while
// she is on this step (Show reveals it) and never in React state. Leaving the
// field sends it to the vault; the draft keeps the last 4 the vault answers.
// Leaving changes nothing on screen until the vault answers: leaving by
// pressing Continue must not move Continue out from under the pointer.
function SsnField({
  last4,
  note,
  error,
  onLast4,
  onSave,
}: {
  last4: string | null;
  note: string | null;
  error: FieldError | null;
  onLast4: (last4: string | null) => void;
  onSave: (full: string) => Promise<SaveSsnResult>;
}) {
  const id = fieldId("identity", "ssn");
  const toggleId = `${id}-show`;
  // Typing in the field this visit; a number from an earlier step shows as saved.
  const [entering, setEntering] = useState(!last4);
  // What "Change" would put back if she leaves the field empty.
  const [kept, setKept] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Typed since the vault last took it, so leaving an unchanged field sends nothing.
  const changed = useRef(false);

  if (last4 && !entering) {
    return (
      <Field
        id={id}
        label="Social Security number"
        required
        note={`${note ? `${note}. ` : ""}Stored securely. Only the last 4 digits are shown.`}
      >
        <SavedRow
          changeLabel="Change your Social Security number"
          onChange={() => {
            setVisible(false);
            setKept(last4);
            setEntering(true);
          }}
        >
          <input
            id={id}
            readOnly
            value={`•••-••-${last4}`}
            className="w-full bg-transparent text-[16px] text-foreground tabular-nums outline-none"
          />
        </SavedRow>
      </Field>
    );
  }

  // A number the vault didn't take doesn't count as given.
  async function save(full: string) {
    try {
      const result = await onSave(full);
      if (result.kind === "stored") {
        changed.current = false;
        setProblem(null);
      }
      if (result.kind === "locked") {
        setProblem(SSN_LOCKED);
        onLast4(null);
      }
    } catch {
      setProblem(SSN_NOT_SAVED);
      onLast4(null);
    }
  }

  function blur(e: FocusEvent<HTMLInputElement>) {
    if ((e.relatedTarget as HTMLElement | null)?.id === toggleId) return;
    const value = e.currentTarget.value;
    const digits = value.replace(/\D/g, "");
    const flagged = ssnProblem(value);
    setVisible(false);
    if (digits.length === 9 && !flagged) {
      if (changed.current) void save(value);
      return;
    }
    setProblem(flagged);
    if (digits.length === 0 && kept) {
      onLast4(kept);
      setEntering(false);
    } else {
      onLast4(null);
    }
  }

  const shown = problem ? { id: `${id}-format`, message: problem } : error;
  return (
    <Field
      id={id}
      label="Social Security number"
      required
      error={shown}
      note={
        kept
          ? `Leave it empty to keep •••-••-${kept}.`
          : "Saved securely when you leave this field. Only the last 4 digits are shown."
      }
    >
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          inputMode="numeric"
          autoComplete="off"
          placeholder="•••-••-••••"
          maxLength={11}
          autoFocus={Boolean(kept)}
          onInput={(e) => {
            e.currentTarget.value = typeSsn(e.currentTarget.value);
            changed.current = true;
          }}
          onBlur={blur}
          className={cn(
            BOX,
            "pr-[84px] font-mono tracking-wide placeholder:font-sans placeholder:tracking-normal",
          )}
          {...ariaFor(shown)}
        />
        <button
          id={toggleId}
          type="button"
          className="absolute top-0 right-0 flex h-11 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-controls={id}
          aria-pressed={visible}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? (
            <EyeOff className="h-4 w-4" aria-hidden />
          ) : (
            <Eye className="h-4 w-4" aria-hidden />
          )}
          {visible ? "Hide" : "Show"}
        </button>
      </div>
    </Field>
  );
}

// Saved as a pair: once both are filled and focus leaves the pair, they go to
// the vault. Only after it takes them are the inputs cleared and the login
// shown as on file; a failed save leaves them in place to try again. As with
// the SSN, leaving changes nothing on screen until the vault answers.
function LoginFields({
  login,
  onFile,
  error,
  onSave,
}: {
  login: (typeof LOGINS)[number];
  onFile: boolean;
  error: FieldError | null;
  onSave: (portal: IntakePortal, username: string, password: string) => Promise<SaveLoginResult>;
}) {
  const [replacing, setReplacing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const userId = fieldId("logins", login.key, "username");
  const passId = fieldId("logins", login.key, "password");

  if (onFile && !replacing) {
    return (
      <SavedRow
        changeLabel={`Change your ${login.title} login`}
        onChange={() => setReplacing(true)}
      >
        <span className="text-[15px] text-foreground">Login saved</span>
      </SavedRow>
    );
  }

  async function blur(e: FocusEvent<HTMLInputElement>) {
    const user = userRef.current;
    const pass = passRef.current;
    if (!user || !pass || e.relatedTarget === user || e.relatedTarget === pass) return;
    const username = user.value.trim();
    if (username && pass.value) {
      try {
        if ((await onSave(login.key, username, pass.value)) === "stored") {
          user.value = "";
          pass.value = "";
          setProblem(null);
          setReplacing(false);
        }
      } catch {
        setProblem(
          `We couldn't save your ${login.title} login just now. Move to another field to try again.`,
        );
      }
    } else if (!user.value && !pass.value) {
      setReplacing(false);
    }
  }

  const shown = problem ? { id: `${passId}-save`, message: problem } : error;
  return (
    <div className="flex flex-col gap-3">
      <Field id={userId} label={login.userLabel} required>
        <Input
          id={userId}
          ref={userRef}
          autoComplete="off"
          autoFocus={replacing}
          maxLength={INTAKE_USERNAME_MAX_LENGTH}
          onBlur={(e) => void blur(e)}
          className={BOX}
          {...ariaFor(shown)}
        />
      </Field>
      <Field id={passId} label="Password" required>
        <Input
          id={passId}
          ref={passRef}
          type="password"
          autoComplete="off"
          maxLength={INTAKE_PASSWORD_MAX_LENGTH}
          onBlur={(e) => void blur(e)}
          className={BOX}
          {...ariaFor(shown)}
        />
      </Field>
      <ErrorText error={shown} />
    </div>
  );
}

export function ReviewNote({ practiceName }: { practiceName: string }) {
  return (
    <p className="rounded-md border border-[#E8E5E0] bg-white px-3.5 py-3 text-[13px] leading-normal">
      <strong className="font-semibold">{practiceName} asked you to review your details.</strong>{" "}
      What we have on file is filled in. Your changes update your record when you submit.
    </p>
  );
}
