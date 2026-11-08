import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERSON_CHECK_KEYS,
  admitLocationCheck,
  admitLocations,
  admittedLine,
  cardPhase,
  inviteLine,
  onboardingEvents,
  parseOnboardingRead,
  progressItems,
  verificationChecks,
  waitingOnLine,
  type CardDocument,
  type CardLicense,
  type CardProvider,
} from "./onboardingCard";
import { canResend, deriveStage, helpAwaitsContact } from "./providerOnboarding";
import type { ProviderOnboardingRead } from "@/types";

const TODAY = "2026-11-06";

function read(
  over: Partial<ProviderOnboardingRead["journey"]> = {},
  rest: Partial<ProviderOnboardingRead> = {},
): ProviderOnboardingRead {
  return {
    journey: {
      id: "j1",
      source: "staff",
      createdRecord: true,
      openedAt: "2026-10-13T13:40:00Z",
      firstSignedInAt: null,
      consentedAt: null,
      submittedAt: null,
      admittedAt: null,
      admittedByName: null,
      admittedFacilityId: null,
      cancelledAt: null,
      lastHelpAt: null,
      lastContactedAt: null,
      ...over,
    },
    invite: {
      email: "lena.ortiz@example.test",
      lastSentAt: "2026-10-13T13:40:00Z",
      delivery: "sent",
      sends: 1,
    },
    checks: [],
    loginsOnFile: { caqh: true, pecos: true },
    ssnOnFile: true,
    heldUploads: 0,
    hasCase: false,
    npiInUse: false,
    ...rest,
  };
}

const SUBMITTED = {
  firstSignedInAt: "2026-10-15T22:52:00Z",
  consentedAt: "2026-10-15T22:54:00Z",
  submittedAt: "2026-10-16T23:48:00Z",
};

const PROVIDER: CardProvider = {
  npi: "1234567893",
  caqhId: "12345678",
  caqhLastAttestedDate: "2026-09-02",
  dateOfBirth: "1990-04-02",
};

const NC_VERIFIED: CardLicense = {
  state: "NC",
  expirationDate: "2027-06-30",
  verifiedStatus: "verified",
};

function doc(
  id: string,
  docType: CardDocument["docType"],
  supersedes: string | null = null,
): CardDocument {
  return {
    id,
    docType,
    documentFamilyId: supersedes ?? id,
    versionNumber: supersedes ? 2 : 1,
    supersedesDocumentId: supersedes,
  };
}

const FULL_DOCS = [doc("cv1", "cv"), doc("lic1", "state_license")];

const stageOf = (r: ProviderOnboardingRead) => deriveStage(onboardingEvents(r));
const helpOf = (r: ProviderOnboardingRead) => helpAwaitsContact(onboardingEvents(r));
const lineOf = (r: ProviderOnboardingRead) => waitingOnLine(r.journey, onboardingEvents(r), "Lena");

function byKey(checks: ReturnType<typeof verificationChecks>) {
  return Object.fromEntries(checks.map((c) => [c.key, c]));
}

describe("cardPhase", () => {
  it("shows nothing without a journey or after a cancel", () => {
    expect(cardPhase(null)).toBe("none");
    expect(cardPhase(read({ cancelledAt: "2026-10-20T00:00:00Z" }))).toBe("none");
  });

  it("is open until Admit, then one line", () => {
    expect(cardPhase(read())).toBe("open");
    expect(cardPhase(read({ ...SUBMITTED }))).toBe("open");
    expect(cardPhase(read({ ...SUBMITTED, admittedAt: "2026-11-06T15:00:00Z" }))).toBe("admitted");
  });
});

describe("the card's stage", () => {
  it("follows the journey's timestamps", () => {
    expect(stageOf(read())).toBe("invited");
    expect(stageOf(read({ firstSignedInAt: "2026-10-15T22:52:00Z" }))).toBe("started");
    expect(stageOf(read({ ...SUBMITTED }))).toBe("submitted");
    expect(stageOf(read({ ...SUBMITTED, admittedAt: "2026-11-06T15:00:00Z" }))).toBe("ready");
    expect(
      stageOf(read({ ...SUBMITTED, admittedAt: "2026-11-06T15:00:00Z" }, { hasCase: true })),
    ).toBe("in_credentialing");
  });

  it("ignores a case that predates an open gap-fill journey", () => {
    expect(stageOf(read({ firstSignedInAt: "2026-10-15T22:52:00Z" }, { hasCase: true }))).toBe(
      "started",
    );
  });
});

describe("waitingOnLine and helpAwaitsContact", () => {
  it("waits on her until Submit", () => {
    expect(lineOf(read())).toEqual({
      who: "provider",
      label: "Lena",
      detail: "invited, hasn't signed in yet",
    });
    expect(lineOf(read({ firstSignedInAt: "2026-10-15T22:52:00Z" })).detail).toBe(
      "signed in, not submitted",
    );
  });

  it("waits on the practice while a help request is newer than the last contact", () => {
    const asked = read({ lastHelpAt: "2026-10-17T15:00:00Z" });
    expect(helpOf(asked)).toBe(true);
    expect(lineOf(asked)).toEqual({
      who: "practice",
      label: "The practice",
      detail: "Lena asked for help Oct 17, 2026",
    });
    const contacted = read({
      lastHelpAt: "2026-10-17T15:00:00Z",
      lastContactedAt: "2026-10-18T09:00:00Z",
    });
    expect(helpOf(contacted)).toBe(false);
    expect(lineOf(contacted).who).toBe("provider");
    const askedAgain = read({
      lastHelpAt: "2026-10-19T15:00:00Z",
      lastContactedAt: "2026-10-18T09:00:00Z",
    });
    expect(lineOf(askedAgain).who).toBe("practice");
  });

  it("waits on Minted after Submit, naming an open help request", () => {
    expect(lineOf(read({ ...SUBMITTED }))).toEqual({
      who: "minted",
      label: "Minted",
      detail: "submitted Oct 16, 2026, ready for review",
    });
    const asked = read({ ...SUBMITTED, lastHelpAt: "2026-10-18T15:00:00Z" });
    expect(helpOf(asked)).toBe(true);
    expect(lineOf(asked)).toMatchObject({
      who: "minted",
      detail: "submitted Oct 16, 2026, ready for review; asked for help Oct 18, 2026",
    });
  });
});

describe("inviteLine, progressItems, admittedLine", () => {
  it("names the address and a resend", () => {
    expect(inviteLine(read())).toBe("Oct 13, 2026 · lena.ortiz@example.test");
    expect(
      inviteLine(
        read(
          {},
          {
            invite: {
              email: "lena@example.test",
              lastSentAt: "2026-10-15T14:00:00Z",
              delivery: "sent",
              sends: 2,
            },
          },
        ),
      ),
    ).toBe("Oct 13, 2026 · lena@example.test · resent Oct 15, 2026");
  });

  it("lists what she has saved before Submit", () => {
    expect(
      progressItems(read({}, { ssnOnFile: false, loginsOnFile: { caqh: false, pecos: false } })),
    ).toEqual(["Nothing saved yet"]);
    expect(
      progressItems(
        read(
          { consentedAt: "2026-10-15T22:54:00Z" },
          { heldUploads: 2, loginsOnFile: { caqh: true, pecos: false } },
        ),
      ),
    ).toEqual([
      "Consent signed Oct 15, 2026",
      "2 files uploaded",
      "SSN on file",
      "CAQH login on file",
    ]);
  });

  it("collapses to who admitted her, where, and whether a case exists", () => {
    const admitted = read({
      ...SUBMITTED,
      admittedAt: "2026-11-06T15:00:00Z",
      admittedByName: "Jordan Seed",
    });
    expect(admittedLine(admitted, "Charlotte")).toBe(
      "Admitted Nov 6, 2026 by Jordan Seed · Charlotte · Ready for credentialing",
    );
    expect(admittedLine({ ...admitted, hasCase: true }, null)).toBe(
      "Admitted Nov 6, 2026 by Jordan Seed · In credentialing",
    );
  });
});

describe("canResend from the card's events", () => {
  it("offers Resend ten minutes after the last send, a resend included", () => {
    const tenMinutes = 10 * 60 * 1000;
    const invitedAt = Date.parse(read().journey.openedAt);
    expect(canResend(onboardingEvents(read()), new Date(invitedAt + tenMinutes - 1))).toBe(false);
    expect(canResend(onboardingEvents(read()), new Date(invitedAt + tenMinutes))).toBe(true);

    const lastSentAt = "2026-10-15T14:00:00Z";
    const resent = read(
      {},
      { invite: { email: "lena@example.test", lastSentAt, delivery: "sent", sends: 2 } },
    );
    const resentAt = Date.parse(lastSentAt);
    expect(canResend(onboardingEvents(resent), new Date(resentAt + tenMinutes - 1))).toBe(false);
    expect(canResend(onboardingEvents(resent), new Date(resentAt + tenMinutes))).toBe(true);
  });
});

describe("verificationChecks", () => {
  const base = { provider: PROVIDER, licenses: [NC_VERIFIED], documents: FULL_DOCS, today: TODAY };

  it("confirms every automatic check on a complete record, leaving the person checks", () => {
    const checks = verificationChecks({ ...base, read: read({ ...SUBMITTED }) });
    expect(checks.map((c) => [c.key, c.method, c.status])).toEqual([
      ["npi", "auto", "confirmed"],
      ["npi_unique", "auto", "confirmed"],
      ["caqh_id", "auto", "confirmed"],
      ["caqh_attestation", "person", "pending"],
      ["license:NC", "auto", "confirmed"],
      ["dob_ssn", "auto", "confirmed"],
      ["logins_on_file", "auto", "confirmed"],
      ["documents", "auto", "confirmed"],
      ["caqh_login", "person", "pending"],
      ["pecos_login", "person", "pending"],
    ]);
    const k = byKey(checks);
    expect(k["caqh_attestation"].detail).toBe("The record says Sep 2, 2026, 65 days ago");
    expect(k["caqh_login"]).toMatchObject({
      action: "test_login",
      portal: { key: "caqh", name: "CAQH" },
    });
    expect(k["pecos_login"]).toMatchObject({ portal: { key: "pecos", name: "PECOS" } });
    expect(k["caqh_attestation"]).toMatchObject({ portal: null, action: "confirm" });
  });

  it("says what is missing and where to fix it", () => {
    const k = byKey(
      verificationChecks({
        read: read(
          { ...SUBMITTED },
          { ssnOnFile: false, loginsOnFile: { caqh: true, pecos: false } },
        ),
        provider: { npi: null, caqhId: null, caqhLastAttestedDate: null, dateOfBirth: null },
        licenses: [
          NC_VERIFIED,
          { state: "SC", expirationDate: "2027-01-31", verifiedStatus: "verified" },
        ],
        documents: [doc("lic1", "state_license")],
        today: TODAY,
      }),
    );
    expect(k["npi"]).toMatchObject({
      status: "pending",
      detail: "No NPI on the record",
      section: "identity",
    });
    expect(k["caqh_id"]).toMatchObject({ status: "pending", detail: "Missing: CAQH ID" });
    expect(k["dob_ssn"].detail).toBe("Missing: date of birth, SSN");
    expect(k["logins_on_file"].detail).toBe("Missing: PECOS");
    expect(k["documents"]).toMatchObject({
      detail: "Missing: CV, 1 license copy",
      section: "documents",
    });
    expect(k["caqh_attestation"].detail).toBe("No attestation date on the record");
    expect(k["pecos_login"]).toMatchObject({ action: "confirm", detail: "No PECOS login on file" });
  });

  it("flags a bad NPI and one another provider has", () => {
    expect(
      byKey(
        verificationChecks({ ...base, provider: { ...PROVIDER, npi: "1234567890" }, read: read() }),
      )["npi"].status,
    ).toBe("problem");
    expect(
      byKey(verificationChecks({ ...base, read: read({}, { npiInUse: true }) }))["npi_unique"],
    ).toMatchObject({
      status: "problem",
      detail: "Another provider in this organization has this NPI",
    });
  });

  it("reads each state's newest license from its PSV trail", () => {
    const k = byKey(
      verificationChecks({
        ...base,
        read: read(),
        licenses: [
          { state: "NC", expirationDate: "2025-06-30", verifiedStatus: "verified" },
          { state: "NC", expirationDate: "2027-06-30", verifiedStatus: "unverified" },
          { state: "SC", expirationDate: "2026-10-01", verifiedStatus: "verified" },
          { state: "VA", expirationDate: "2027-10-01", verifiedStatus: "failed" },
        ],
      }),
    );
    expect(k["license:NC"]).toMatchObject({
      status: "pending",
      detail: "Not verified yet",
      label: "NC license verified",
    });
    expect(k["license:SC"]).toMatchObject({ status: "problem", detail: "Expired Oct 1, 2026" });
    expect(k["license:VA"]).toMatchObject({ status: "problem", detail: "Verification failed" });
  });

  it("asks for a license when there is none", () => {
    const checks = verificationChecks({ ...base, read: read(), licenses: [] });
    expect(checks.filter((c) => c.key.startsWith("license"))).toEqual([
      expect.objectContaining({
        key: "license",
        status: "pending",
        detail: "No license on the record",
      }),
    ]);
  });

  it("counts only the current version of a document", () => {
    const k = byKey(
      verificationChecks({
        ...base,
        read: read(),
        licenses: [
          NC_VERIFIED,
          { state: "SC", expirationDate: "2027-01-31", verifiedStatus: "verified" },
        ],
        documents: [
          doc("cv1", "cv"),
          doc("lic1", "state_license"),
          doc("lic2", "state_license", "lic1"),
        ],
      }),
    );
    expect(k["documents"].detail).toBe("Missing: 1 license copy");
  });

  // read_provider_onboarding sends one row per key, its newest (DISTINCT ON
  // ... checked_at DESC). Given more, the lib keeps the last row listed per key.
  it("shows one person check per key, the last row listed for that key", () => {
    const k = byKey(
      verificationChecks({
        ...base,
        read: read(
          { ...SUBMITTED },
          {
            checks: [
              {
                checkKey: "caqh_login",
                outcome: "confirmed",
                note: null,
                checkedByName: "Priya Seed",
                checkedAt: "2026-11-04T09:00:00Z",
              },
              {
                checkKey: "pecos_login",
                outcome: "problem",
                note: "Account locked",
                checkedByName: "Priya Seed",
                checkedAt: "2026-11-04T09:05:00Z",
              },
              {
                checkKey: "caqh_login",
                outcome: "problem",
                note: "Password rejected",
                checkedByName: "Jordan Seed",
                checkedAt: "2026-11-05T10:00:00Z",
              },
              {
                checkKey: "pecos_login",
                outcome: "confirmed",
                note: null,
                checkedByName: "Jordan Seed",
                checkedAt: "2026-11-05T10:05:00Z",
              },
            ],
          },
        ),
      }),
    );
    expect(k["caqh_login"]).toMatchObject({
      status: "problem",
      detail: "Password rejected",
      confirmedBy: "Jordan Seed",
      checkedAt: "2026-11-05T10:00:00Z",
    });
    expect(k["pecos_login"]).toMatchObject({
      status: "confirmed",
      detail: null,
      confirmedBy: "Jordan Seed",
      checkedAt: "2026-11-05T10:05:00Z",
    });
  });
});

describe("Admit & assign", () => {
  const facilities = [
    {
      id: "f-clt",
      name: "Charlotte",
      city: "Charlotte",
      state: "NC",
      groupId: "g1",
      isActive: true,
    },
    { id: "f-col", name: "Columbia", city: "Columbia", state: "SC", groupId: "g1", isActive: true },
    {
      id: "f-old",
      name: "Asheville",
      city: "Asheville",
      state: "NC",
      groupId: "g1",
      isActive: false,
    },
    { id: "f-other", name: "Raleigh", city: "Raleigh", state: "NC", groupId: "g2", isActive: true },
    { id: "f-ended", name: "Durham", city: "Durham", state: "NC", groupId: "g3", isActive: true },
  ];
  const assignments = [
    { providerId: "p1", groupId: "g1", endDate: null },
    { providerId: "p1", groupId: "g3", endDate: "2026-01-01" },
    { providerId: "p2", groupId: "g2", endDate: null },
  ];

  it("offers the active locations of her current groups", () => {
    expect(admitLocations(facilities, assignments, "p1").map((l) => l.id)).toEqual([
      "f-clt",
      "f-col",
    ]);
  });

  it("checks the pick against her license states", () => {
    const locations = admitLocations(facilities, assignments, "p1");
    expect(admitLocationCheck(null, locations, ["NC"])).toEqual({ kind: "pick" });
    expect(admitLocationCheck("f-other", locations, ["NC"])).toEqual({ kind: "pick" });
    expect(admitLocationCheck("f-clt", locations, ["NC"])).toEqual({ kind: "ok" });
    expect(admitLocationCheck("f-col", locations, ["NC", "NC"])).toEqual({
      kind: "out_of_state",
      state: "SC",
      licenseStates: ["NC"],
    });
    expect(admitLocationCheck("f-clt", [{ ...locations[0], state: null }], [])).toEqual({
      kind: "out_of_state",
      state: null,
      licenseStates: [],
    });
  });
});

describe("PERSON_CHECK_KEYS", () => {
  it("matches the check_key CHECK on provider_onboarding_checks", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20261107010000_provider_onboarding_staff.sql"),
      "utf8",
    );
    const list = /CHECK \(check_key IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    expect(list.split(",").map((k) => k.trim().replace(/'/g, ""))).toEqual([...PERSON_CHECK_KEYS]);
  });
});

describe("parseOnboardingRead", () => {
  it("reads the RPC payload", () => {
    expect(
      parseOnboardingRead({
        journey: {
          id: "j1",
          source: "staff",
          created_record: true,
          opened_at: "2026-10-13T13:40:00Z",
          first_signed_in_at: "2026-10-15T22:52:00Z",
          consented_at: null,
          submitted_at: null,
          admitted_at: null,
          admitted_by_name: null,
          admitted_facility_id: null,
          cancelled_at: null,
          last_help_at: null,
          last_contacted_at: null,
        },
        invite: {
          email: "lena@example.test",
          last_sent_at: "2026-10-13T13:40:00Z",
          delivery: "failed",
          sends: 2,
        },
        checks: [
          {
            check_key: "caqh_login",
            outcome: "problem",
            note: "No access",
            checked_by_name: "Jordan Seed",
            checked_at: "2026-11-05T10:00:00Z",
          },
          { check_key: "npi", outcome: "confirmed", checked_at: "2026-11-05T10:00:00Z" },
        ],
        logins_on_file: { caqh: true, pecos: false },
        ssn_on_file: true,
        held_uploads: 2,
        has_case: false,
        npi_in_use: false,
      }),
    ).toEqual({
      journey: expect.objectContaining({
        id: "j1",
        firstSignedInAt: "2026-10-15T22:52:00Z",
      }),
      invite: {
        email: "lena@example.test",
        lastSentAt: "2026-10-13T13:40:00Z",
        delivery: "failed",
        sends: 2,
      },
      checks: [
        {
          checkKey: "caqh_login",
          outcome: "problem",
          note: "No access",
          checkedByName: "Jordan Seed",
          checkedAt: "2026-11-05T10:00:00Z",
        },
      ],
      loginsOnFile: { caqh: true, pecos: false },
      ssnOnFile: true,
      heldUploads: 2,
      hasCase: false,
      npiInUse: false,
    });
  });

  it("reads anything else as no journey", () => {
    for (const raw of [null, 0, [], "x", {}, { journey: null }, { journey: { id: "j1" } }]) {
      expect(parseOnboardingRead(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});
