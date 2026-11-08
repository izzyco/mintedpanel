import { describe, expect, it } from "vitest";
import {
  INTAKE_ANSWER_MAX_LENGTH,
  INTAKE_MAX_LICENSES,
  answersFromDraft,
  draftFromState,
  intakeSubmission,
  parseIntakeAnswers,
  resumeFrom,
  type IntakeAnswers,
  type IntakeState,
  type IntakeUpload,
} from "./intakeAnswers";
import { addLicense, setField, type FieldPath } from "./intakeForm";
import type { IntakeDraft } from "@/types/providerOnboarding";

const TODAY = "2026-11-06";

const NOTHING: IntakeAnswers = {
  firstName: null,
  lastName: null,
  npi: null,
  taxonomyCode: null,
  dateOfBirth: null,
  caqhId: null,
  mobile: null,
  homeStreet: null,
  homeCity: null,
  homeState: null,
  homeZip: null,
  licenses: [],
};

function state(overrides: Partial<IntakeState> = {}): IntakeState {
  return {
    practiceName: "Shelby Sports Rehab",
    email: "anita.rao@example.test",
    record: {
      ...NOTHING,
      firstName: "Anita",
      lastName: "Rao",
      homeCity: "Charlotte",
      licenses: [{ state: "NC", number: "PT-48213", expiresOn: "2027-12-31" }],
    },
    lockedFields: [],
    ssnLast4: null,
    loginsOnFile: { caqh: false, pecos: false },
    consent: { signed: false, textVersion: null },
    draft: null,
    uploads: [],
    submitted: false,
    ...overrides,
  };
}

function apply(draft: IntakeDraft, steps: [FieldPath, string | null][]): IntakeDraft {
  return steps.reduce((d, [path, value]) => setField(d, path, value, TODAY), draft);
}

describe("parseIntakeAnswers", () => {
  it("keeps only the answer keys, trims, and reads a blank or missing value as not provided", () => {
    const parsed = parseIntakeAnswers({
      firstName: "  Anita ",
      mobile: "   ",
      npi: null,
      ssn: "123456789",
      password: "hunter2",
      orgId: "someone-elses",
      licenses: [{ state: " NC ", number: "PT-1", expiresOn: "", issuer: "board" }],
    });
    expect(parsed).toEqual({
      ...NOTHING,
      firstName: "Anita",
      licenses: [{ state: "NC", number: "PT-1", expiresOn: null }],
    });
  });

  it("reads missing licenses as none", () => {
    expect(parseIntakeAnswers({})).toEqual(NOTHING);
  });

  it("refuses anything that isn't the answers shape", () => {
    const long = "x".repeat(INTAKE_ANSWER_MAX_LENGTH + 1);
    const tooMany = Array.from({ length: INTAKE_MAX_LICENSES + 1 }, () => ({ state: "NC" }));
    for (const input of [
      null,
      "answers",
      [],
      { firstName: 42 },
      { firstName: { value: "Anita" } },
      { homeStreet: long },
      { licenses: "NC" },
      { licenses: [null] },
      { licenses: [{ number: 7 }] },
      { licenses: [{ state: long }] },
      { licenses: tooMany },
    ]) {
      expect(parseIntakeAnswers(input), JSON.stringify(input)?.slice(0, 60)).toBeNull();
    }
  });

  it("accepts a value at the length bound and the most licenses allowed", () => {
    const max = "x".repeat(INTAKE_ANSWER_MAX_LENGTH);
    const licenses = Array.from({ length: INTAKE_MAX_LICENSES }, () => ({ state: "NC" }));
    const parsed = parseIntakeAnswers({ homeStreet: max, licenses });
    expect(parsed?.homeStreet).toBe(max);
    expect(parsed?.licenses).toHaveLength(INTAKE_MAX_LICENSES);
  });
});

describe("draftFromState", () => {
  it("opens with her record, on file, before she has saved anything", () => {
    const draft = draftFromState(state());
    expect(draft.identity.firstName).toEqual({
      value: "Anita",
      source: { label: "On file", asOf: null },
    });
    expect(draft.identity.npi).toEqual({ value: null, source: null });
    expect(draft.contact.email).toBe("anita.rao@example.test");
    expect(draft.contact.homeAddress.city.value).toBe("Charlotte");
    expect(draft.licenses).toHaveLength(1);
    expect(draft.licenses[0].number).toEqual({
      value: "PT-48213",
      source: { label: "On file", asOf: null },
    });
  });

  it("opens with the SSN last 4 and each login on file as the vaults hold them", () => {
    const fresh = draftFromState(state());
    expect(fresh.identity.ssn).toEqual({ value: null, source: null });
    expect(fresh.logins).toEqual({ caqhOnFile: false, pecosOnFile: false });

    const saved = draftFromState(
      state({ ssnLast4: "6789", loginsOnFile: { caqh: false, pecos: true } }),
    );
    expect(saved.identity.ssn).toEqual({ value: "6789", source: { label: "On file", asOf: null } });
    expect(saved.logins).toEqual({ caqhOnFile: false, pecosOnFile: true });
  });

  it("gives a provider with no license on file one empty row to fill in", () => {
    const draft = draftFromState(state({ record: { ...NOTHING, firstName: "Anita" } }));
    expect(draft.licenses).toEqual([
      {
        state: { value: null, source: null },
        number: { value: null, source: null },
        expiresOn: { value: null, source: null },
      },
    ]);
  });

  it("shows her saved answers as hers, dated by the save, over the record", () => {
    const draft = draftFromState(
      state({
        draft: {
          answers: { ...NOTHING, firstName: "Anitha", mobile: "7045550100", licenses: [] },
          step: "form",
          version: 3,
          updatedAt: "2026-11-05T12:00:00Z",
        },
      }),
    );
    expect(draft.identity.firstName).toEqual({
      value: "Anitha",
      source: { label: "You entered this", asOf: "2026-11-05" },
    });
    expect(draft.contact.mobile.value).toBe("7045550100");
    expect(draft.identity.lastName.source?.label).toBe("On file");
    expect(draft.licenses).toEqual([]);
  });

  it("shows a locked field from the record, locked, even when an answer names it", () => {
    const draft = draftFromState(
      state({
        record: { ...NOTHING, npi: "1730195835", dateOfBirth: "1988-07-21" },
        lockedFields: ["npi", "dateOfBirth", "ssn"],
        ssnLast4: "6789",
        draft: {
          answers: { ...NOTHING, npi: "1234567893" },
          step: "form",
          version: 1,
          updatedAt: "2026-11-05T12:00:00Z",
        },
      }),
    );
    expect(draft.identity.npi).toEqual({
      value: "1730195835",
      source: { label: "On file", asOf: null },
      locked: true,
    });
    expect(draft.identity.dateOfBirth.locked).toBe(true);
    expect(draft.identity.ssn).toEqual({
      value: "6789",
      source: { label: "On file", asOf: null },
      locked: true,
    });
  });
});

describe("answersFromDraft", () => {
  it("sends only what she entered, never a record value, a locked value or the SSN", () => {
    const opened = draftFromState(
      state({ record: { ...state().record, npi: "1730195835" }, lockedFields: ["npi"] }),
    );
    const edited = apply(opened, [
      [["contact", "mobile"], "7045550100"],
      [["identity", "npi"], "1234567893"],
      [["identity", "ssn"], "6789"],
      [["licenses", 0, "expiresOn"], "2028-12-31"],
    ]);
    expect(answersFromDraft(edited)).toEqual({
      ...NOTHING,
      mobile: "7045550100",
      licenses: [{ state: "NC", number: null, expiresOn: "2028-12-31" }],
    });
  });
});

describe("a save and a fresh sign-in", () => {
  it("bring back exactly what she typed, with untouched fields still on file", () => {
    const edited = apply(addLicense(draftFromState(state())), [
      [["identity", "firstName"], "Anitha"],
      [["identity", "dateOfBirth"], "1990-04-01"],
      [["address", "street"], "18 Elm St"],
      [["licenses", 0, "number"], "PT-99999"],
      [["licenses", 1, "state"], "SC"],
      [["licenses", 1, "number"], "SC-123"],
    ]);
    const saved = parseIntakeAnswers(JSON.parse(JSON.stringify(answersFromDraft(edited))));
    if (!saved) throw new Error("the saved answers did not parse");
    const reopened = draftFromState(
      state({
        draft: { answers: saved, step: "form", version: 1, updatedAt: `${TODAY}T12:00:00Z` },
      }),
    );

    const values = (d: IntakeDraft) => ({
      firstName: d.identity.firstName.value,
      dateOfBirth: d.identity.dateOfBirth.value,
      street: d.contact.homeAddress.street.value,
      city: d.contact.homeAddress.city.value,
      licenses: d.licenses.map((l) => [l.state.value, l.number.value, l.expiresOn.value]),
    });
    expect(values(reopened)).toEqual(values(edited));
    expect(reopened.contact.homeAddress.city.source?.label).toBe("On file");
    expect(reopened.licenses[0].state.source?.label).toBe("On file");
    expect(reopened.licenses[0].number.source).toEqual({ label: "You entered this", asOf: TODAY });
    expect(reopened.licenses[0].expiresOn.source?.label).toBe("On file");
    expect(reopened.licenses[1].state.source).toEqual({ label: "You entered this", asOf: TODAY });
  });
});

describe("resumeFrom", () => {
  it("names where signing in lands: consent, her saved step, or done", () => {
    const saved = (step: "form" | "documents") => ({
      answers: NOTHING,
      step,
      version: 1,
      updatedAt: `${TODAY}T12:00:00Z`,
    });
    expect(resumeFrom(state())).toEqual({ consented: false, step: "form", submitted: false });
    expect(
      resumeFrom(state({ consent: { signed: true, textVersion: 1 }, draft: saved("documents") })),
    ).toEqual({ consented: true, step: "documents", submitted: false });
    expect(resumeFrom(state({ submitted: true })).submitted).toBe(true);
  });
});

describe("intakeSubmission", () => {
  const upload = (slotKey: string, extra: Partial<IntakeUpload> = {}): IntakeUpload => ({
    id: `upload-${slotKey}`,
    slotKey,
    kind: slotKey.startsWith("license:") ? "state_license" : (slotKey as IntakeUpload["kind"]),
    fileName: "file.pdf",
    sizeBytes: 100,
    expiresOn: null,
    ...extra,
  });
  const complete = (overrides: Partial<IntakeState> = {}) =>
    state({
      record: {
        firstName: "Anita",
        lastName: "Rao",
        npi: "1730195835",
        taxonomyCode: "225100000X",
        dateOfBirth: "1990-04-02",
        caqhId: "12345678",
        mobile: "7045550100",
        homeStreet: "1 Main St",
        homeCity: "Charlotte",
        homeState: "NC",
        homeZip: "28202",
        licenses: [{ state: "NC", number: "PT-48213", expiresOn: "2027-12-31" }],
      },
      ssnLast4: "6789",
      loginsOnFile: { caqh: true, pecos: true },
      consent: { signed: true, textVersion: 1 },
      uploads: [upload("cv"), upload("license:NC")],
      ...overrides,
    });
  const saved = (answers: Partial<IntakeAnswers>) => ({
    answers: { ...NOTHING, ...answers },
    step: "documents" as const,
    version: 3,
    updatedAt: `${TODAY}T12:00:00Z`,
  });

  it("is ready when the record, the vaults and her files cover every rule, and carries each file", () => {
    const { missing, uploads } = intakeSubmission(complete());
    expect(missing).toEqual([]);
    expect(uploads.map((u) => u.slotKey)).toEqual(["cv", "license:NC"]);
  });

  it("names what the form would: the SSN and a login not on file, a missing CV, an undated COI", () => {
    const { missing } = intakeSubmission(
      complete({
        ssnLast4: null,
        loginsOnFile: { caqh: true, pecos: false },
        uploads: [upload("license:NC"), upload("coi")],
      }),
    );
    expect(missing).toEqual([
      "identity.ssn",
      "logins.pecos",
      "documents.cv",
      "documents.coi.expires",
    ]);
  });

  it("needs her signed consent, which the form asks for before anything else", () => {
    const { missing } = intakeSubmission(
      complete({ consent: { signed: false, textVersion: null } }),
    );
    expect(missing).toEqual(["consent"]);
  });

  it("needs a license copy for every state on her form, and leaves out a copy for a state she removed", () => {
    const { missing, uploads } = intakeSubmission(
      complete({
        draft: saved({
          licenses: [
            { state: "NC", number: null, expiresOn: null },
            { state: "SC", number: "SC-9", expiresOn: "2027-05-01" },
          ],
        }),
        uploads: [upload("cv"), upload("license:NC"), upload("license:VA")],
      }),
    );
    expect(missing).toEqual(["documents.license:SC"]);
    expect(uploads.map((u) => u.slotKey)).toEqual(["cv", "license:NC"]);
  });

  it("refuses an answer the record can't take, under the key the form shows it at", () => {
    const { missing } = intakeSubmission(
      complete({
        draft: saved({
          npi: "1730195836",
          dateOfBirth: "1990-02-30",
          homeState: "North Carolina",
          licenses: [{ state: "NC", number: "PT-1", expiresOn: "12/31/2027" }],
        }),
      }),
    );
    expect(missing).toEqual([
      "identity.npi",
      "identity.dateOfBirth",
      "contact.address",
      "licenses.0",
    ]);
  });

  it("ignores a locked answer, which Submit never writes", () => {
    const { missing } = intakeSubmission(
      complete({
        lockedFields: ["npi", "dateOfBirth"],
        draft: saved({
          npi: "1730195836",
          dateOfBirth: "1990-02-30",
          licenses: [{ state: "NC", number: null, expiresOn: null }],
        }),
      }),
    );
    expect(missing).toEqual([]);
  });
});
