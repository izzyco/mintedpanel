// Board 5b. A picked file is checked by its name, size and type; its contents
// are never read here. It uploads as soon as it passes, and the row shows
// whether it is uploading, held, or failed with a retry.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DateField, ErrorSummary, ErrorText, HelpLine } from "@/components/intake/IntakeFields";
import { Button } from "@/components/ui/button";
import type { HelpReason } from "@/lib/intakeFlow";
import {
  fieldId,
  formatBytes,
  missingDocuments,
  ariaFor,
  errorOf,
  thingsLeft,
  type FieldError,
} from "@/lib/intakeForm";
import type { IntakeUpload } from "@/lib/intakeAnswers";
import { heldFiles, type SlotUpload, type SlotUploads } from "@/lib/intakeUploads";
import { documentSlots, validateUpload } from "@/lib/providerOnboarding";
import { cn } from "@/lib/utils";
import type { DocumentSlot, IntakeDraft } from "@/types/providerOnboarding";

const REMOVE_FAILED = "We couldn't remove this file just now. Please try again.";
const DATE_FAILED = "We couldn't save this date just now. Change it to try again.";

export function DocumentsStep({
  practiceName,
  draft,
  uploads,
  status,
  onUpload,
  onRemove,
  onExpires,
  onFinishLater,
  onSubmit,
  submitting = false,
  submitError = null,
  onHelp,
}: {
  practiceName: string;
  draft: IntakeDraft;
  uploads: SlotUploads;
  /** Whether her answers are saved, shown above the buttons. */
  status?: ReactNode;
  onUpload: (slot: DocumentSlot, file: File) => void;
  /** False when it couldn't be removed. */
  onRemove: (slot: DocumentSlot, upload: IntakeUpload) => Promise<boolean>;
  /** False when the date couldn't be saved. */
  onExpires: (
    slot: DocumentSlot,
    upload: IntakeUpload,
    expiresOn: string | null,
  ) => Promise<boolean>;
  onFinishLater: () => void;
  /** False when something is still missing, so the screen shows what. */
  onSubmit: () => Promise<boolean>;
  submitting?: boolean;
  /** Why the last Submit didn't go through, when it wasn't a missing file. */
  submitError?: string | null;
  onHelp: (reason: HelpReason) => void;
}) {
  const [rowErrors, setRowErrors] = useState<Record<string, string | null>>({});
  const [tries, setTries] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tries > 0) summaryRef.current?.focus();
  }, [tries]);

  const slots = documentSlots(draft, heldFiles(uploads));
  const missing = tries > 0 ? missingDocuments(slots) : [];
  const errorAt = (key: string) => errorOf(missing.find((m) => m.key === key));
  const setRowError = (slot: DocumentSlot, message: string | null) =>
    setRowErrors((errors) => ({ ...errors, [slot.key]: message }));

  function pick(slot: DocumentSlot, file: File) {
    const problem = validateUpload({ name: file.name, type: file.type, size: file.size });
    setRowError(slot, problem);
    if (!problem) onUpload(slot, file);
  }

  function row(slot: DocumentSlot) {
    const entry = uploads[slot.key];
    return (
      <DocumentRow
        key={slot.key}
        slot={slot}
        entry={entry}
        rowError={rowErrors[slot.key] ?? null}
        error={errorAt(`documents.${slot.key}`)}
        expiresError={errorAt(`documents.${slot.key}.expires`)}
        onPick={(picked) => pick(slot, picked)}
        onRetry={(file) => onUpload(slot, file)}
        onRemove={async (upload) => {
          setRowError(slot, (await onRemove(slot, upload)) ? null : REMOVE_FAILED);
        }}
        onExpires={async (upload, expiresOn) => {
          setRowError(slot, (await onExpires(slot, upload, expiresOn)) ? null : DATE_FAILED);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="text-[12px] text-muted-foreground">Step 2 of 2</p>
        <h1 className="text-[18px] leading-snug font-semibold">Your documents</h1>
        <p className="text-[13px] leading-normal text-muted-foreground">
          * required · PDF, JPG or PNG, up to 10 MB each.
        </p>
      </div>

      <ErrorSummary ref={summaryRef} title={thingsLeft(missing.length, "submit")} items={missing} />

      <ul className="flex flex-col rounded-md border border-[#E8E5E0]">
        {slots.filter((s) => s.required).map(row)}
      </ul>

      <h2 className="mt-1 text-[13px] font-semibold text-[#4B5563]">If you have them</h2>
      <ul className="flex flex-col rounded-md border border-[#E8E5E0]">
        {slots.filter((s) => !s.required).map(row)}
      </ul>

      <p className="text-[12px] text-muted-foreground">
        On a phone, Upload also lets you take a photo.
      </p>

      <HelpLine onHelp={onHelp} />

      <p className="rounded-md bg-[#F5F4F1] px-3 py-2.5 text-[13px] leading-normal">
        Once you submit, your answers go to {practiceName} and this form closes. If something
        changes later, contact {practiceName}.
      </p>

      {status}
      {submitError ? (
        <p role="alert" className="text-[13px] leading-[1.45] text-[var(--mp-danger-ink)]">
          {submitError}
        </p>
      ) : null}
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
          className="h-auto min-h-12 flex-[1.4] py-2 text-[15px] leading-tight whitespace-normal"
          disabled={submitting}
          onClick={() => {
            if (missingDocuments(slots).length > 0) {
              setTries((t) => t + 1);
              return;
            }
            void onSubmit().then((sent) => {
              if (!sent) setTries((t) => t + 1);
            });
          }}
        >
          {submitting ? "Submitting…" : "Submit"}
        </Button>
      </div>
    </div>
  );
}

function DocumentRow({
  slot,
  entry,
  rowError,
  error,
  expiresError,
  onPick,
  onRetry,
  onRemove,
  onExpires,
}: {
  slot: DocumentSlot;
  entry: SlotUpload | undefined;
  rowError: string | null;
  error: FieldError | null;
  expiresError: FieldError | null;
  onPick: (file: File) => void;
  onRetry: (file: File) => void;
  onRemove: (upload: IntakeUpload) => Promise<void>;
  onExpires: (upload: IntakeUpload, iso: string | null) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [removing, setRemoving] = useState(false);
  const { file } = slot;
  const choose = () => inputRef.current?.click();

  async function remove(upload: IntakeUpload) {
    setRemoving(true);
    try {
      await onRemove(upload);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <li
      className={cn(
        "flex flex-col gap-2 border-b border-[#F0EEEA] px-3.5 py-3 last:border-b-0",
        (rowError || error || entry?.status === "failed") && "bg-[#FDF6F6]",
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-medium">
            {slot.label}
            {slot.required ? <span aria-hidden> *</span> : null}
          </span>
          {file ? (
            <span className="text-[12px] text-[#047857]">
              {file.name} · {formatBytes(file.sizeBytes)}
            </span>
          ) : entry && entry.status !== "done" ? (
            <span className="text-[12px] text-muted-foreground">
              {entry.file.name} · {formatBytes(entry.file.size)}
            </span>
          ) : null}
          {entry?.status === "uploading" ? (
            <span role="status" className="text-[12px] text-[#4B5563]">
              Uploading…
            </span>
          ) : null}
          {slot.kind === "state_license" ? (
            <span className="text-[12px] text-muted-foreground">
              Uses the expiration date from your form
            </span>
          ) : null}
        </div>
        {entry?.status === "done" ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 px-2.5 text-[13px] font-normal text-primary"
            aria-label={`Remove ${slot.label}`}
            disabled={removing}
            onClick={() => void remove(entry.upload)}
          >
            Remove
          </Button>
        ) : entry?.status === "failed" ? (
          <Button
            type="button"
            variant="outline"
            className="h-11 border-[#D6D3CE] px-3.5 text-[13px] font-normal"
            aria-label={`Try uploading ${slot.label} again`}
            onClick={() => onRetry(entry.file)}
          >
            Try again
          </Button>
        ) : entry?.status === "uploading" ? null : (
          <Button
            id={fieldId("doc", slot.key)}
            type="button"
            variant="outline"
            className="h-11 border-[#D6D3CE] px-3.5 text-[13px] font-normal"
            aria-label={`Upload ${slot.label}`}
            onClick={choose}
            {...ariaFor(error)}
          >
            Upload
          </Button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = "";
            if (picked) onPick(picked);
          }}
        />
      </div>
      {entry?.status === "failed" ? (
        <div className="flex flex-col items-start gap-1">
          <p role="alert" className="text-[12px] leading-snug text-[#B91C1C]">
            This file didn't upload. Check your connection and try again.
          </p>
          {/* A file that can never pass would leave her stuck on Try again. */}
          <Button
            type="button"
            variant="ghost"
            className="h-11 px-0 text-[13px] font-normal text-primary"
            aria-label={`Choose another file for ${slot.label}`}
            onClick={choose}
          >
            Choose another file
          </Button>
        </div>
      ) : null}
      {rowError ? (
        <p role="alert" className="text-[12px] leading-snug text-[#B91C1C]">
          {rowError}
        </p>
      ) : null}
      <ErrorText error={error} />
      {slot.needsExpiration && entry?.status === "done" ? (
        <DateField
          id={fieldId("doc", slot.key, "expires")}
          label={
            <>
              Policy expires<span aria-hidden> *</span>{" "}
              <span className="font-normal text-muted-foreground">(needed with this file)</span>
            </>
          }
          required={false}
          value={entry.upload.expiresOn}
          onChange={(iso) => void onExpires(entry.upload, iso)}
          error={expiresError}
        />
      ) : null}
    </li>
  );
}
