import { describe, expect, it } from "vitest";
import type { IntakeUpload } from "./intakeAnswers";
import { heldFiles, slotUploads, type SlotUpload } from "./intakeUploads";

const cv: IntakeUpload = {
  id: "u-cv",
  slotKey: "cv",
  kind: "cv",
  fileName: "cv.pdf",
  sizeBytes: 2048,
  expiresOn: null,
};
const coi: IntakeUpload = { ...cv, id: "u-coi", slotKey: "coi", kind: "coi", fileName: "coi.pdf" };
const file = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });
// The File a row shows while it uploads or after it failed, and the one Try
// again sends. Compared by identity: any two Files compare equal by value.
const fileOf = (entry: SlotUpload | undefined) =>
  entry && entry.status !== "done" ? entry.file : undefined;

describe("slotUploads", () => {
  it("opens on her saved uploads, one per slot", () => {
    const state = slotUploads({}, { type: "opened", uploads: [cv, coi] });
    expect(heldFiles(state)).toEqual({
      cv: { name: "cv.pdf", sizeBytes: 2048, expiresOn: null },
      coi: { name: "coi.pdf", sizeBytes: 2048, expiresOn: null },
    });
  });

  it("keeps a file still uploading or failed when the saved state is read again", () => {
    const picked = file("new-cv.pdf");
    let state = slotUploads({}, { type: "started", slotKey: "cv", attempt: 1, file: picked });
    state = slotUploads(state, { type: "started", slotKey: "other", attempt: 2, file: picked });
    state = slotUploads(state, { type: "failed", slotKey: "other", attempt: 2 });
    state = slotUploads(state, { type: "opened", uploads: [cv, coi] });
    expect(state.cv?.status).toBe("uploading");
    expect(fileOf(state.cv)).toBe(picked);
    expect(state.other?.status).toBe("failed");
    expect(fileOf(state.other)).toBe(picked);
    expect(heldFiles(state)).toEqual({
      coi: { name: "coi.pdf", sizeBytes: 2048, expiresOn: null },
    });
  });

  it("holds the File while it uploads and lets it go once the server has it", () => {
    const picked = file("cv.pdf");
    let state = slotUploads({}, { type: "started", slotKey: "cv", attempt: 1, file: picked });
    expect(heldFiles(state)).toEqual({});
    state = slotUploads(state, { type: "uploaded", slotKey: "cv", attempt: 1, upload: cv });
    expect(state.cv).toEqual({ status: "done", upload: cv });
    expect(heldFiles(state)).toEqual({ cv: { name: "cv.pdf", sizeBytes: 2048, expiresOn: null } });
  });

  it("keeps the File after a failure so she can retry it", () => {
    const picked = file("cv.pdf");
    let state = slotUploads({}, { type: "started", slotKey: "cv", attempt: 1, file: picked });
    state = slotUploads(state, { type: "failed", slotKey: "cv", attempt: 1 });
    expect(state.cv?.status).toBe("failed");
    expect(fileOf(state.cv)).toBe(picked);
    expect(heldFiles(state)).toEqual({});
  });

  it("ignores an older attempt that finishes after a newer pick", () => {
    const newer = file("newer.pdf");
    let state = slotUploads({}, { type: "started", slotKey: "cv", attempt: 1, file: file("a") });
    state = slotUploads(state, { type: "started", slotKey: "cv", attempt: 2, file: newer });
    const late = slotUploads(state, { type: "uploaded", slotKey: "cv", attempt: 1, upload: cv });
    expect(late.cv?.status).toBe("uploading");
    expect(fileOf(late.cv)).toBe(newer);
    expect(heldFiles(late)).toEqual({});
    const lateFailure = slotUploads(late, { type: "failed", slotKey: "cv", attempt: 1 });
    expect(lateFailure.cv?.status).toBe("uploading");
  });

  it("empties a removed slot and dates only a held file", () => {
    let state = slotUploads({}, { type: "opened", uploads: [cv, coi] });
    state = slotUploads(state, { type: "dated", slotKey: "coi", expiresOn: "2027-06-30" });
    expect(heldFiles(state).coi?.expiresOn).toBe("2027-06-30");
    state = slotUploads(state, { type: "removed", slotKey: "cv" });
    expect(Object.keys(heldFiles(state))).toEqual(["coi"]);
    const datedRemoved = slotUploads(state, {
      type: "dated",
      slotKey: "cv",
      expiresOn: "2027-01-01",
    });
    expect(heldFiles(datedRemoved)).toEqual(heldFiles(state));
    expect(datedRemoved.cv).toBeUndefined();
  });
});
