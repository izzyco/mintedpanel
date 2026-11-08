// Her documents on the documents screen, one entry per slot. Pure.
//
// A file she picks is held as a File only while it uploads, and again if the
// upload fails so she can retry it. Once the server has it, the slot holds
// the server's upload and the File is let go. Each pick is an attempt, so an
// older upload finishing late never overwrites a newer pick.
import type { IntakeUpload } from "@/lib/intakeAnswers";
import type { DocumentSlot } from "@/types/providerOnboarding";

export type SlotUpload =
  | { status: "uploading" | "failed"; attempt: number; file: File }
  | { status: "done"; upload: IntakeUpload };

export type SlotUploads = Record<string, SlotUpload>;

export type SlotUploadAction =
  | { type: "opened"; uploads: IntakeUpload[] }
  | { type: "started"; slotKey: string; attempt: number; file: File }
  | { type: "uploaded"; slotKey: string; attempt: number; upload: IntakeUpload }
  | { type: "failed"; slotKey: string; attempt: number }
  | { type: "removed"; slotKey: string }
  | { type: "dated"; slotKey: string; expiresOn: string | null };

export function slotUploads(state: SlotUploads, action: SlotUploadAction): SlotUploads {
  if (action.type === "opened") {
    const next: SlotUploads = {};
    for (const upload of action.uploads) next[upload.slotKey] = { status: "done", upload };
    // A file this page is still sending, or couldn't send, stays: the saved
    // state can't know about it yet.
    for (const [key, entry] of Object.entries(state)) {
      if (entry.status !== "done") next[key] = entry;
    }
    return next;
  }

  const current = state[action.slotKey];
  switch (action.type) {
    case "started":
      return {
        ...state,
        [action.slotKey]: { status: "uploading", attempt: action.attempt, file: action.file },
      };
    case "uploaded":
    case "failed":
      if (current?.status !== "uploading" || current.attempt !== action.attempt) return state;
      return {
        ...state,
        [action.slotKey]:
          action.type === "uploaded"
            ? { status: "done", upload: action.upload }
            : { ...current, status: "failed" },
      };
    case "removed": {
      const next = { ...state };
      delete next[action.slotKey];
      return next;
    }
    case "dated":
      if (current?.status !== "done") return state;
      return {
        ...state,
        [action.slotKey]: {
          status: "done",
          upload: { ...current.upload, expiresOn: action.expiresOn },
        },
      };
  }
}

/** The files the server holds, in the shape the slots and the checks read. */
export function heldFiles(state: SlotUploads): Record<string, DocumentSlot["file"]> {
  const files: Record<string, DocumentSlot["file"]> = {};
  for (const [key, entry] of Object.entries(state)) {
    if (entry.status === "done") {
      const { fileName, sizeBytes, expiresOn } = entry.upload;
      files[key] = { name: fileName, sizeBytes, expiresOn };
    }
  }
  return files;
}
