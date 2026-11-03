// Board 5b. A picked file is checked by its name, size and type; its contents
// are never read.
import { useEffect, useRef, useState } from "react";
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
import { documentSlots, validateUpload } from "@/lib/providerOnboarding";
import { cn } from "@/lib/utils";
import type { DocumentSlot, IntakeDraft } from "@/types/providerOnboarding";

// Only a file's name and size are kept: nothing is uploaded in this build.
export type IntakeFiles = Record<string, DocumentSlot["file"]>;

export function DocumentsStep({
  practiceName,
  draft,
  files,
  onFilesChange,
  onFinishLater,
  onSubmit,
  onHelp,
}: {
  practiceName: string;
  draft: IntakeDraft;
  files: IntakeFiles;
  onFilesChange: (files: IntakeFiles) => void;
  onFinishLater: () => void;
  onSubmit: () => void;
  onHelp: (reason: HelpReason) => void;
}) {
  const [uploadErrors, setUploadErrors] = useState<Record<string, string | null>>({});
  const [tries, setTries] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tries > 0) summaryRef.current?.focus();
  }, [tries]);

  const slots = documentSlots(draft, files);
  const missing = tries > 0 ? missingDocuments(slots) : [];
  const errorAt = (key: string) => errorOf(missing.find((m) => m.key === key));

  function pick(slot: DocumentSlot, file: File) {
    const problem = validateUpload({ name: file.name, type: file.type, size: file.size });
    setUploadErrors((errors) => ({ ...errors, [slot.key]: problem }));
    if (problem) return;
    onFilesChange({
      ...files,
      [slot.key]: { name: file.name, sizeBytes: file.size, expiresOn: null },
    });
  }

  function row(slot: DocumentSlot) {
    const file = slot.file;
    return (
      <DocumentRow
        key={slot.key}
        slot={slot}
        uploadError={uploadErrors[slot.key] ?? null}
        error={errorAt(`documents.${slot.key}`)}
        expiresError={errorAt(`documents.${slot.key}.expires`)}
        onPick={(picked) => pick(slot, picked)}
        onRemove={() => {
          setUploadErrors((errors) => ({ ...errors, [slot.key]: null }));
          onFilesChange({ ...files, [slot.key]: null });
        }}
        onExpires={(expiresOn) => {
          if (file) onFilesChange({ ...files, [slot.key]: { ...file, expiresOn } });
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
          onClick={() =>
            missingDocuments(slots).length === 0 ? onSubmit() : setTries((t) => t + 1)
          }
        >
          Submit
        </Button>
      </div>
    </div>
  );
}

function DocumentRow({
  slot,
  uploadError,
  error,
  expiresError,
  onPick,
  onRemove,
  onExpires,
}: {
  slot: DocumentSlot;
  uploadError: string | null;
  error: FieldError | null;
  expiresError: FieldError | null;
  onPick: (file: File) => void;
  onRemove: () => void;
  onExpires: (iso: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { file } = slot;
  return (
    <li
      className={cn(
        "flex flex-col gap-2 border-b border-[#F0EEEA] px-3.5 py-3 last:border-b-0",
        (uploadError || error) && "bg-[#FDF6F6]",
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
          ) : null}
          {slot.kind === "state_license" ? (
            <span className="text-[12px] text-muted-foreground">
              Uses the expiration date from your form
            </span>
          ) : null}
        </div>
        {file ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 px-2.5 text-[13px] font-normal text-primary"
            aria-label={`Remove ${slot.label}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        ) : (
          <Button
            id={fieldId("doc", slot.key)}
            type="button"
            variant="outline"
            className="h-11 border-[#D6D3CE] px-3.5 text-[13px] font-normal"
            aria-label={`Upload ${slot.label}`}
            onClick={() => inputRef.current?.click()}
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
      {uploadError ? (
        <p role="alert" className="text-[12px] leading-snug text-[#B91C1C]">
          {uploadError}
        </p>
      ) : null}
      <ErrorText error={error} />
      {slot.needsExpiration && file ? (
        <DateField
          id={fieldId("doc", slot.key, "expires")}
          label={
            <>
              Policy expires<span aria-hidden> *</span>{" "}
              <span className="font-normal text-muted-foreground">(needed with this file)</span>
            </>
          }
          required={false}
          value={file.expiresOn}
          onChange={onExpires}
          error={expiresError}
        />
      ) : null}
    </li>
  );
}
