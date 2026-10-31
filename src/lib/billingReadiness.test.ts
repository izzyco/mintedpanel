import { describe, expect, it, vi } from "vitest";
import {
  assessFeedEvent,
  billingFeedWindowStart,
  buildBillingFeed,
  buildChangeFeedCsv,
  buildNewlyBillableDigestCsv,
  DEFAULT_BILLING_READINESS_RULES,
  evaluateBillingReadiness,
  filterBillingFeed,
  providerPayerStatuses,
  searchBillingProviders,
  resolveBillingReadinessRules,
  validateBillingReadinessRules,
  type BillingReadinessRules,
  type BillingReadinessRulesOverride,
  type BillingReadinessSnapshot,
} from "@/lib/billingReadiness";

const TODAY = "2026-09-25";

function readySnapshot(): BillingReadinessSnapshot {
  return {
    providers: [
      {
        id: "p1",
        firstName: "Ana",
        lastName: "Therapist",
        npi: "1234567893",
        taxonomyCode: "225100000X",
        status: "active",
        verificationState: "verified",
        isTestProvider: false,
      },
    ],
    groups: [
      { id: "g1", name: "North Clinic", tin: "12-3456789", npiType2: "1234567890", isActive: true },
    ],
    facilities: [{ id: "f1", name: "Boulder Clinic", groupId: "g1", state: "CO", isActive: true }],
    payers: [
      { id: "pay1", name: "Acme Health", status: "active", isActive: true, avgDecisionDays: 18 },
    ],
    groupMemberships: [{ providerId: "p1", groupId: "g1", startDate: "2025-01-01", endDate: null }],
    facilityAssignments: [{ providerId: "p1", facilityId: "f1", startDate: "2025-01-01" }],
    licenses: [
      {
        providerId: "p1",
        state: "CO",
        licenseNumber: "PT-123",
        licenseType: "full",
        status: "active",
        verifiedStatus: "verified",
        issueDate: "2020-01-01",
        expirationDate: "2027-01-01",
      },
    ],
    cases: [
      {
        id: "c1",
        providerId: "p1",
        groupId: "g1",
        payerId: "pay1",
        state: "CO",
        caseStatus: "approved",
        submittedDate: "2025-01-01",
        approvedDate: "2025-02-01",
        confirmedEffectiveDate: "2025-02-15",
        expectedEffectiveDate: null,
        terminationDate: null,
        createdAt: "2025-01-01T12:00:00.000Z",
      },
    ],
    caseFacilities: [
      {
        caseId: "c1",
        facilityId: "f1",
        createdAt: "2025-02-01T12:00:00.000Z",
        createdBy: "user-1",
      },
    ],
    statusTransitions: [
      {
        id: "sh1",
        caseId: "c1",
        fromStatus: "in_review",
        toStatus: "approved",
        actorKind: "user",
        changedAt: "2025-02-01T12:00:00.000Z",
      },
    ],
    legacyStatusTransitions: [],
  };
}

const selection = { providerId: "p1", facilityId: "f1", payerId: "pay1" };
const assess = (snapshot: BillingReadinessSnapshot, next: Partial<typeof selection> = {}) =>
  evaluateBillingReadiness(
    snapshot,
    { ...selection, ...next },
    TODAY,
    DEFAULT_BILLING_READINESS_RULES,
  );

describe("billing readiness evaluator", () => {
  it("requires the full exact key and returns ready for complete current evidence", () => {
    const snapshot = readySnapshot();
    expect(assess(snapshot)).toMatchObject({
      status: "ready",
      label: "Billable Ready",
      state: "CO",
      retroEligibility: "Not recorded",
    });
    snapshot.cases[0].groupId = null;
    expect(assess(snapshot)?.status).toBe("stop");
  });

  it("rejects malformed assessment dates and unknown or missing current case status", () => {
    const snapshot = readySnapshot();
    expect(
      evaluateBillingReadiness(snapshot, selection, "2026-02-30", DEFAULT_BILLING_READINESS_RULES),
    ).toBeNull();
    snapshot.cases[0].caseStatus = null;
    expect(assess(snapshot)?.status).toBe("hold");
    snapshot.cases[0].caseStatus = "unknown-status";
    Object.assign(snapshot.cases[0], { credentialingStatusLabel: "In-Network" });
    expect(assess(snapshot)?.status).toBe("hold");
    snapshot.cases[0].caseStatus = "in_network";
    expect(assess(snapshot)?.status).toBe("ready");
  });

  it("uses facility group/state and requires current group membership, started assignment, and explicit case linkage", () => {
    const snapshot = readySnapshot();
    snapshot.facilities[0].state = "CA";
    expect(assess(snapshot)?.state).toBe("CA");
    expect(assess(snapshot)?.status).toBe("stop");
    snapshot.facilities[0].state = "CO";
    snapshot.groupMemberships[0].startDate = "2026-09-26";
    expect(assess(snapshot)?.status).toBe("hold");
    snapshot.groupMemberships[0].startDate = "2025-01-01";
    snapshot.groupMemberships[0].endDate = "2026-09-24";
    expect(assess(snapshot)?.status).toBe("hold");
    snapshot.groupMemberships[0].endDate = null;
    snapshot.facilityAssignments[0].startDate = "2026-09-26";
    expect(assess(snapshot)?.status).toBe("hold");
    snapshot.facilityAssignments[0].startDate = "2025-01-01";
    snapshot.caseFacilities = [];
    expect(assess(snapshot)?.status).toBe("hold");
  });

  describe("an approved, effective enrollment (MINT-76)", () => {
    const ONBOARDING_REASON =
      "Clinician is still marked Onboarding. Mark them Active once they start seeing patients.";

    it("is Billable Ready for an active clinician with a verified license and a linked facility", () => {
      const snapshot = readySnapshot();
      expect(assess(snapshot)).toMatchObject({
        status: "ready",
        label: "Billable Ready",
        reasons: [],
      });
    });

    it("holds an Onboarding clinician with its own reason and never reads Do Not Bill", () => {
      const snapshot = readySnapshot();
      snapshot.providers[0].status = "onboarding";
      const assessment = assess(snapshot);
      expect(assessment).toMatchObject({
        status: "hold",
        label: "Hold",
        reasons: [{ severity: "hold", label: ONBOARDING_REASON }],
      });
      expect(assessment?.reasons.some((reason) => reason.severity === "stop")).toBe(false);
    });

    it("stops a terminated clinician as Do Not Bill", () => {
      const snapshot = readySnapshot();
      snapshot.providers[0].status = "terminated";
      expect(assess(snapshot)).toMatchObject({
        status: "stop",
        label: "Do Not Bill",
        reasons: [{ severity: "stop", label: "The clinician is terminated." }],
      });
    });

    it("holds an unrecognized clinician status instead of stopping it", () => {
      const snapshot = readySnapshot();
      // Not a value providers_status_check allows today; a future one must hold.
      Object.assign(snapshot.providers[0], { status: "inactive" });
      expect(assess(snapshot)).toMatchObject({
        status: "hold",
        reasons: [{ severity: "hold", label: "The clinician status is not recognized." }],
      });
    });

    it("lists both holds for an Onboarding clinician who is also unverified", () => {
      const snapshot = readySnapshot();
      snapshot.providers[0].status = "onboarding";
      snapshot.providers[0].verificationState = "pending_verification";
      expect(assess(snapshot)).toMatchObject({
        status: "hold",
        label: "Hold",
        reasons: [
          { severity: "hold", label: ONBOARDING_REASON },
          { severity: "hold", label: "Clinician verification is incomplete." },
        ],
      });
    });

    it("treats a group membership with no start date as current", () => {
      const snapshot = readySnapshot();
      snapshot.groupMemberships[0].startDate = null;
      expect(assess(snapshot)).toMatchObject({ status: "ready", reasons: [] });
      snapshot.groupMemberships[0].endDate = "2026-09-24";
      expect(assess(snapshot)?.reasons).toContainEqual({
        severity: "hold",
        label: "Current group membership is not established.",
      });
      snapshot.groupMemberships[0].endDate = "2026-13-01";
      expect(assess(snapshot)?.reasons).toContainEqual({
        severity: "hold",
        label: "The group membership dates are invalid.",
      });
    });
  });

  it("honors effective-date and termination day boundaries and invalid dates", () => {
    const snapshot = readySnapshot();
    snapshot.cases[0].confirmedEffectiveDate = TODAY;
    expect(assess(snapshot)?.status).toBe("ready");
    snapshot.cases[0].confirmedEffectiveDate = "2026-09-26";
    expect(assess(snapshot)?.status).toBe("hold");
    snapshot.cases[0].confirmedEffectiveDate = "2026-02-30";
    expect(assess(snapshot)?.status).toBe("hold");
    snapshot.cases[0].confirmedEffectiveDate = "2025-02-15";
    snapshot.cases[0].terminationDate = TODAY;
    expect(assess(snapshot)?.status).toBe("stop");
    snapshot.cases[0].terminationDate = "2026-09-26";
    expect(assess(snapshot)?.status).toBe("ready");
    snapshot.cases[0].approvedDate = "2026-09-26";
    expect(assess(snapshot)?.status).toBe("hold");
  });

  it("requires an active verified valid license and fails closed on future, malformed, expired, or conflicting rows", () => {
    const snapshot = readySnapshot();
    snapshot.licenses[0].expirationDate = TODAY;
    expect(assess(snapshot)?.status).toBe("ready");
    snapshot.licenses[0].issueDate = "2026-09-26";
    expect(assess(snapshot)?.status).toBe("hold");
    snapshot.licenses[0].issueDate = "2020-01-01";
    snapshot.licenses.push({
      ...snapshot.licenses[0],
      licenseNumber: "PT-456",
      verifiedStatus: "failed",
    });
    expect(assess(snapshot)?.status).toBe("hold");
    snapshot.licenses = [snapshot.licenses[0]];
    snapshot.licenses[0].expirationDate = "2026-09-24";
    expect(assess(snapshot)?.status).toBe("stop");
    snapshot.licenses[0].verifiedStatus = "unverified";
    expect(assess(snapshot)?.status).toBe("hold");
    snapshot.licenses = [];
    expect(assess(snapshot)?.status).toBe("hold");
  });

  it("returns a labeled estimate only for a reached submitted date and never uses expected date as confirmed", () => {
    const snapshot = readySnapshot();
    snapshot.cases[0].caseStatus = "submitted";
    snapshot.cases[0].confirmedEffectiveDate = null;
    snapshot.cases[0].expectedEffectiveDate = "2027-01-01";
    snapshot.cases[0].submittedDate = "2026-09-01";
    expect(assess(snapshot)).toMatchObject({
      status: "hold",
      estimatedDecisionDate: "2026-09-19",
      confirmedEffectiveDate: null,
    });
    snapshot.cases[0].submittedDate = "2026-09-26";
    expect(assess(snapshot)?.estimatedDecisionDate).toBeNull();
  });

  it("keeps PTA on hold and lists only eligible same-facility PT candidates", () => {
    const snapshot = readySnapshot();
    snapshot.providers[0].taxonomyCode = "225200000X";
    snapshot.providers.push(
      {
        id: "pt-specialty",
        firstName: "Bea",
        lastName: "PT",
        npi: "1098765432",
        taxonomyCode: "2251X0800X",
        status: "active",
        verificationState: "verified",
        isTestProvider: false,
      },
      {
        id: "pt-inactive",
        firstName: "Cal",
        lastName: "Inactive",
        npi: null,
        taxonomyCode: "225100000X",
        status: "terminated",
        verificationState: "verified",
        isTestProvider: false,
      },
    );
    snapshot.groupMemberships.push({
      providerId: "pt-specialty",
      groupId: "g1",
      startDate: "2025-01-01",
      endDate: null,
    });
    snapshot.groupMemberships.push({
      providerId: "pt-inactive",
      groupId: "g1",
      startDate: "2025-01-01",
      endDate: null,
    });
    snapshot.facilityAssignments.push({
      providerId: "pt-specialty",
      facilityId: "f1",
      startDate: "2025-01-01",
    });
    snapshot.facilityAssignments.push({
      providerId: "pt-inactive",
      facilityId: "f1",
      startDate: "2025-01-01",
    });
    snapshot.licenses.push({ ...snapshot.licenses[0], providerId: "pt-specialty" });
    snapshot.licenses.push({ ...snapshot.licenses[0], providerId: "pt-inactive" });
    expect(assess(snapshot)).toMatchObject({
      status: "hold",
      isPta: true,
      reasons: expect.arrayContaining([
        expect.objectContaining({ label: expect.stringContaining("supervision is unverified") }),
      ]),
      supervisorCandidates: [{ providerId: "pt-specialty", taxonomyCode: "2251X0800X" }],
    });
    snapshot.providers[0].taxonomyCode = "224Z00000X";
    expect(assess(snapshot)).toMatchObject({ status: "hold", isOta: true });
  });
});

describe("billing change feed and digest", () => {
  it("excludes migration snapshot seeds while retaining recorded legacy approvals", () => {
    const snapshot = readySnapshot();
    snapshot.statusTransitions = [
      {
        id: "migration-seed",
        caseId: "c1",
        fromStatus: null,
        toStatus: "approved",
        actorKind: "system",
        changedAt: "2026-09-23T12:00:00.000Z",
      },
    ];
    snapshot.caseFacilities[0].createdAt = "2026-09-23T12:00:00.000Z";
    snapshot.caseFacilities[0].createdBy = null;
    snapshot.legacyStatusTransitions = [
      {
        id: "real-legacy-approval",
        caseId: "c1",
        track: "credentialing",
        toStatusLabel: "Approved",
        changedAt: "2026-09-24T12:00:00.000Z",
      },
    ];

    const feed = buildBillingFeed(snapshot, TODAY);
    expect(feed.filter((event) => event.kind === "approval")).toMatchObject([
      { title: "Enrollment approved (legacy record)", eventDate: "2026-09-24T12:00:00.000Z" },
    ]);
    expect(feed.some((event) => event.kind === "facility_added")).toBe(false);
    expect(
      buildNewlyBillableDigestCsv(snapshot, feed, TODAY, DEFAULT_BILLING_READINESS_RULES).split(
        "\r\n",
      ),
    ).toHaveLength(2);
    snapshot.legacyStatusTransitions = [];
    const backfillOnlyFeed = buildBillingFeed(snapshot, TODAY);
    expect(backfillOnlyFeed).toHaveLength(0);
    expect(
      buildNewlyBillableDigestCsv(
        snapshot,
        backfillOnlyFeed,
        TODAY,
        DEFAULT_BILLING_READINESS_RULES,
      ).split("\r\n"),
    ).toHaveLength(1);
  });

  it("uses local calendar boundaries for timestamp events and date-only warnings", () => {
    vi.stubEnv("TZ", "America/Denver");
    try {
      const snapshot = readySnapshot();
      snapshot.statusTransitions = [
        {
          id: "local-evening",
          caseId: "c1",
          fromStatus: "in_review",
          toStatus: "approved",
          actorKind: "user",
          changedAt: "2026-09-26T01:00:00.000Z", // Sep 25 at 7 p.m. MDT.
        },
        {
          id: "next-local-day",
          caseId: "c1",
          fromStatus: "in_review",
          toStatus: "approved",
          actorKind: "user",
          changedAt: "2026-09-26T06:00:00.000Z", // Sep 26 at midnight MDT.
        },
      ];
      snapshot.cases[0].terminationDate = TODAY;
      const feed = buildBillingFeed(snapshot, TODAY);
      const filtered = filterBillingFeed(feed, { range: 7 }, TODAY);
      expect(filtered.map((event) => event.id)).toContain(
        "approval:c1:f1:2026-09-26T01:00:00.000Z",
      );
      expect(filtered.map((event) => event.id)).not.toContain(
        "approval:c1:f1:2026-09-26T06:00:00.000Z",
      );
      expect(
        filtered.some((event) => event.kind === "termination" && event.eventDate === TODAY),
      ).toBe(true);

      const digestSnapshot = readySnapshot();
      digestSnapshot.statusTransitions = [snapshot.statusTransitions[0]];
      const digestEvents = filterBillingFeed(
        buildBillingFeed(digestSnapshot, TODAY),
        { range: 7 },
        TODAY,
      );
      const csv = buildNewlyBillableDigestCsv(
        digestSnapshot,
        digestEvents,
        TODAY,
        DEFAULT_BILLING_READINESS_RULES,
      );
      expect(csv.split("\r\n")[1]).toContain(',"2026-09-25","2026-09-25"');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("deduplicates matching legacy approvals, preserves distinct transitions, and labels date-derived events", () => {
    const snapshot = readySnapshot();
    snapshot.statusTransitions = [
      {
        id: "new",
        caseId: "c1",
        fromStatus: "in_review",
        toStatus: "approved",
        actorKind: "user",
        changedAt: "2026-09-24T12:00:00.000Z",
      },
      {
        id: "older",
        caseId: "c1",
        fromStatus: "in_review",
        toStatus: "approved",
        actorKind: "user",
        changedAt: "2026-09-20T12:00:00.000Z",
      },
    ];
    snapshot.legacyStatusTransitions = [
      {
        id: "legacy-duplicate",
        caseId: "c1",
        track: "credentialing",
        toStatusLabel: "In-Network",
        changedAt: "2026-09-24T12:00:00.000Z",
      },
      {
        id: "legacy-distinct",
        caseId: "c1",
        track: "credentialing",
        toStatusLabel: "In-Network",
        changedAt: "2026-09-21T12:00:00.000Z",
      },
    ];
    snapshot.caseFacilities[0].createdAt = "2026-09-22T12:00:00.000Z";
    snapshot.cases[0].terminationDate = "2026-09-23";
    snapshot.licenses[0].expirationDate = "2026-09-24";
    const feed = buildBillingFeed(snapshot, TODAY);
    expect(feed.filter((event) => event.kind === "approval")).toHaveLength(3);
    expect(feed[0].eventDate.slice(0, 10)).toBe("2026-09-25");
    expect(feed.some((event) => event.kind === "termination" && !event.recorded)).toBe(true);
    expect(
      feed.some(
        (event) =>
          event.kind === "license_expiration" && event.eventDate === TODAY && !event.recorded,
      ),
    ).toBe(true);
  });

  it("applies 7/30/90-day and facility/payer filters inclusively", () => {
    const snapshot = readySnapshot();
    snapshot.statusTransitions = [
      {
        id: "a",
        caseId: "c1",
        fromStatus: "in_review",
        toStatus: "approved",
        actorKind: "user",
        changedAt: "2026-09-19T12:00:00.000Z",
      },
      {
        id: "b",
        caseId: "c1",
        fromStatus: "in_review",
        toStatus: "approved",
        actorKind: "user",
        changedAt: "2026-08-27T12:00:00.000Z",
      },
      {
        id: "c",
        caseId: "c1",
        fromStatus: "in_review",
        toStatus: "approved",
        actorKind: "user",
        changedAt: "2026-06-27T12:00:00.000Z",
      },
    ];
    const feed = buildBillingFeed(snapshot, TODAY);
    expect(filterBillingFeed(feed, { range: 7 }, TODAY)).toHaveLength(1);
    expect(
      filterBillingFeed(feed, { range: 30, facilityId: "f1", payerId: "pay1" }, TODAY),
    ).toHaveLength(2);
    expect(filterBillingFeed(feed, { range: 90, facilityId: "other" }, TODAY)).toHaveLength(0);
    expect(billingFeedWindowStart(TODAY)).toBe("2026-06-28");
  });

  it("exports only currently ready matching approval/link events, once per case/facility, with formula-safe values", () => {
    const snapshot = readySnapshot();
    snapshot.providers[0].npi = '=HYPERLINK("bad")';
    const events = buildBillingFeed(snapshot, TODAY);
    events.push({
      ...events[0],
      id: "duplicate-event",
      kind: "facility_added",
      eventDate: "2026-09-24T12:00:00.000Z",
    });
    events.push({ ...events[0], id: "wrong-case", caseId: "other-case" });
    events.push({ ...events[0], id: "wrong-group", groupId: "other-group" });
    const csv = buildNewlyBillableDigestCsv(
      snapshot,
      events,
      TODAY,
      DEFAULT_BILLING_READINESS_RULES,
    );
    expect(csv.split("\r\n")).toHaveLength(2);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    snapshot.cases[0].caseStatus = "denied";
    expect(
      buildNewlyBillableDigestCsv(snapshot, events, TODAY, DEFAULT_BILLING_READINESS_RULES).split(
        "\r\n",
      ),
    ).toHaveLength(1);
  });
});

describe("change feed filters and export", () => {
  function recentSnapshot(): BillingReadinessSnapshot {
    const snapshot = readySnapshot();
    snapshot.statusTransitions[0].changedAt = "2026-09-20T12:00:00.000Z";
    snapshot.caseFacilities[0].createdAt = "2026-09-21T12:00:00.000Z";
    return snapshot;
  }

  it("filters by change type alongside range, facility, and payer", () => {
    const snapshot = recentSnapshot();
    const feed = buildBillingFeed(snapshot, TODAY);
    expect(feed.map((event) => event.kind).sort()).toEqual(["approval", "facility_added"]);
    expect(
      filterBillingFeed(feed, { range: 30, kind: "approval" }, TODAY).map((event) => event.kind),
    ).toEqual(["approval"]);
    expect(filterBillingFeed(feed, { range: 30, kind: "termination" }, TODAY)).toEqual([]);
    expect(filterBillingFeed(feed, { range: 7, kind: "approval" }, TODAY)).toHaveLength(1);
  });

  it("assesses each event against its own case and exports reasons, formula-safe", () => {
    const snapshot = recentSnapshot();
    snapshot.providers[0].status = "onboarding";
    snapshot.providers[0].npi = "=1+1";
    const feed = filterBillingFeed(
      buildBillingFeed(snapshot, TODAY),
      { range: 30, kind: "approval" },
      TODAY,
    );
    expect(assessFeedEvent(snapshot, feed[0], TODAY, DEFAULT_BILLING_READINESS_RULES)?.status).toBe(
      "hold",
    );
    expect(
      assessFeedEvent(
        snapshot,
        { ...feed[0], caseId: "other" },
        TODAY,
        DEFAULT_BILLING_READINESS_RULES,
      ),
    ).toBeNull();
    const lines = buildChangeFeedCsv(snapshot, feed, TODAY, DEFAULT_BILLING_READINESS_RULES).split(
      "\r\n",
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"Current readiness","Reasons"');
    expect(lines[1]).toContain('"2026-09-20"');
    expect(lines[1]).toContain('"Hold"');
    expect(lines[1]).toContain("still marked Onboarding");
    expect(lines[1]).toContain(`"'=1+1"`);
  });
});

describe("clearance lookup search and payer statuses", () => {
  function lookupSnapshot(): BillingReadinessSnapshot {
    const snapshot = readySnapshot();
    snapshot.providers.push({
      ...snapshot.providers[0],
      id: "p2",
      npi: "1987654321",
    });
    snapshot.groups.push({ ...snapshot.groups[0], id: "g2", name: "South Clinic" });
    snapshot.facilities.push({
      id: "f2",
      name: "Raleigh Home Visits",
      groupId: "g2",
      state: "NC",
      isActive: true,
    });
    snapshot.payers.push({ ...snapshot.payers[0], id: "pay2", name: "Blue Plan" });
    snapshot.groupMemberships.push({
      providerId: "p2",
      groupId: "g2",
      startDate: null,
      endDate: null,
    });
    snapshot.facilityAssignments.push({
      providerId: "p2",
      facilityId: "f2",
      startDate: "2025-01-01",
    });
    snapshot.cases.push({ ...snapshot.cases[0], id: "c2", payerId: "pay2" });
    return snapshot;
  }

  it("matches name, NPI, state, and location, with group and state to tell duplicates apart", () => {
    const snapshot = lookupSnapshot();
    const byName = searchBillingProviders(
      snapshot,
      "ana ther",
      TODAY,
      DEFAULT_BILLING_READINESS_RULES,
    );
    expect(byName.total).toBe(2);
    expect(byName.matches.map((match) => [match.groupNames, match.states])).toEqual([
      [["North Clinic"], ["CO"]],
      [["South Clinic"], ["NC"]],
    ]);
    expect(
      searchBillingProviders(snapshot, "1987654321", TODAY, DEFAULT_BILLING_READINESS_RULES)
        .matches,
    ).toMatchObject([{ provider: { id: "p2" } }]);
    expect(
      searchBillingProviders(snapshot, "nc", TODAY, DEFAULT_BILLING_READINESS_RULES).matches,
    ).toMatchObject([{ provider: { id: "p2" } }]);
    expect(
      searchBillingProviders(snapshot, "raleigh", TODAY, DEFAULT_BILLING_READINESS_RULES).matches,
    ).toMatchObject([{ provider: { id: "p2" } }]);
    expect(searchBillingProviders(snapshot, "  ", TODAY, DEFAULT_BILLING_READINESS_RULES)).toEqual({
      matches: [],
      total: 0,
    });
    expect(
      searchBillingProviders(snapshot, "zzz", TODAY, DEFAULT_BILLING_READINESS_RULES).total,
    ).toBe(0);
  });

  it("lists every payer case by location, holding a case with no linked location", () => {
    const snapshot = lookupSnapshot();
    const rows = providerPayerStatuses(snapshot, "p1", TODAY, DEFAULT_BILLING_READINESS_RULES);
    expect(rows.map((row) => [row.payer.name, row.facility?.name ?? null, row.status])).toEqual([
      ["Acme Health", "Boulder Clinic", "ready"],
      ["Blue Plan", null, "hold"],
    ]);
    expect(rows[1].reasons[0].label).toContain("No location is linked");
    snapshot.caseFacilities.push({
      caseId: "c2",
      facilityId: "f1",
      createdAt: "2025-02-01T12:00:00.000Z",
      createdBy: null,
    });
    expect(
      providerPayerStatuses(snapshot, "p1", TODAY, DEFAULT_BILLING_READINESS_RULES).map(
        (row) => row.status,
      ),
    ).toEqual(["ready", "ready"]);
    expect(
      providerPayerStatuses(snapshot, "missing", TODAY, DEFAULT_BILLING_READINESS_RULES),
    ).toEqual([]);
  });

  it("holds an approved case whose location moved group or sits in another state, never Do Not Bill", () => {
    const MISMATCH = "This location's group or state no longer matches the enrollment case.";
    const acme = (snapshot: BillingReadinessSnapshot) =>
      providerPayerStatuses(snapshot, "p1", TODAY, DEFAULT_BILLING_READINESS_RULES).filter(
        (row) => row.caseId === "c1",
      );

    const moved = lookupSnapshot();
    moved.facilities[0].groupId = "g2";
    expect(acme(moved)).toMatchObject([
      {
        facility: { id: "f1" },
        status: "hold",
        label: "Hold",
        reasons: [{ severity: "hold", label: MISMATCH }],
      },
    ]);

    const otherState = lookupSnapshot();
    otherState.caseFacilities.push({
      caseId: "c1",
      facilityId: "f2",
      createdAt: "2025-02-01T12:00:00.000Z",
      createdBy: null,
    });
    expect(acme(otherState).map((row) => [row.facility?.name, row.status, row.reasons])).toEqual([
      ["Boulder Clinic", "ready", []],
      ["Raleigh Home Visits", "hold", [{ severity: "hold", label: MISMATCH }]],
    ]);

    const gone = lookupSnapshot();
    gone.caseFacilities[0].facilityId = "f-missing";
    expect(acme(gone)).toMatchObject([
      {
        facility: null,
        locationLabel: "Location not on record",
        status: "hold",
        reasons: [
          {
            severity: "hold",
            label: "The location linked to this enrollment case is not on record.",
          },
        ],
      },
    ]);

    const noState = lookupSnapshot();
    noState.facilities[0].state = null;
    expect(acme(noState)).toMatchObject([
      {
        locationLabel: "Boulder Clinic",
        status: "hold",
        reasons: [{ severity: "hold", label: "This location has no valid state on record." }],
      },
    ]);
  });

  it("keeps the stops that do not depend on the location on a row it cannot assess", () => {
    const MISMATCH = "This location's group or state no longer matches the enrollment case.";
    const acme = (snapshot: BillingReadinessSnapshot) =>
      providerPayerStatuses(snapshot, "p1", TODAY, DEFAULT_BILLING_READINESS_RULES).filter(
        (row) => row.caseId === "c1",
      );

    const terminated = lookupSnapshot();
    terminated.facilities[0].groupId = "g2";
    terminated.cases[0].terminationDate = "2026-09-01";
    expect(acme(terminated)).toMatchObject([
      {
        status: "stop",
        label: "Do Not Bill",
        reasons: [
          { severity: "stop", label: "Enrollment termination is effective." },
          { severity: "hold", label: MISMATCH },
        ],
      },
    ]);

    const denied = lookupSnapshot();
    denied.facilities[0].groupId = "g2";
    denied.cases[0].caseStatus = "denied";
    denied.providers[0].status = "terminated";
    denied.payers[0].isActive = false;
    expect(acme(denied)[0]).toMatchObject({ status: "stop", label: "Do Not Bill" });
    expect(acme(denied)[0].reasons.map((reason) => reason.label)).toEqual([
      "The clinician is terminated.",
      "Enrollment status is denied.",
      "The payer is inactive.",
      MISMATCH,
    ]);

    // A case with no linked location keeps its stops too.
    const unlinked = lookupSnapshot();
    unlinked.caseFacilities = [];
    unlinked.cases[0].terminationDate = "2026-09-01";
    expect(acme(unlinked)).toMatchObject([
      {
        locationLabel: "No linked location",
        status: "stop",
        reasons: [
          { severity: "stop", label: "Enrollment termination is effective." },
          { severity: "hold", label: "No location is linked to this enrollment case." },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The rules behind the clinician-status and membership checks (MINT-129).

const ONBOARDING_LABEL =
  "Clinician is still marked Onboarding. Mark them Active once they start seeing patients.";

const withRules = (next: {
  onboarding?: "hold" | "stop";
  other?: "hold" | "stop";
  membershipWithoutStartDate?: BillingReadinessRules["membershipWithoutStartDate"];
}): BillingReadinessRules => ({
  providerStatusSeverity: {
    ...DEFAULT_BILLING_READINESS_RULES.providerStatusSeverity,
    ...(next.onboarding ? { onboarding: next.onboarding } : {}),
    ...(next.other ? { other: next.other } : {}),
  },
  membershipWithoutStartDate:
    next.membershipWithoutStartDate ?? DEFAULT_BILLING_READINESS_RULES.membershipWithoutStartDate,
});

const assessWith = (snapshot: BillingReadinessSnapshot, rules: BillingReadinessRules) =>
  evaluateBillingReadiness(snapshot, selection, TODAY, rules);

describe("BillingReadinessRules", () => {
  it("defaults to the PM's Oct 20 decisions, frozen", () => {
    expect(DEFAULT_BILLING_READINESS_RULES).toEqual({
      providerStatusSeverity: { terminated: "stop", onboarding: "hold", other: "hold" },
      membershipWithoutStartDate: "current",
    });
    expect(Object.isFrozen(DEFAULT_BILLING_READINESS_RULES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_BILLING_READINESS_RULES.providerStatusSeverity)).toBe(true);
    expect(resolveBillingReadinessRules()).toEqual(DEFAULT_BILLING_READINESS_RULES);
  });

  it("assesses exactly as before when the rules argument is omitted or is the default", () => {
    for (const status of ["active", "onboarding", "terminated"] as const) {
      const snapshot = readySnapshot();
      snapshot.providers[0].status = status;
      snapshot.groupMemberships[0].startDate = null;
      expect(assessWith(snapshot, DEFAULT_BILLING_READINESS_RULES)).toEqual(assess(snapshot));
      expect(assessWith(snapshot, resolveBillingReadinessRules())).toEqual(assess(snapshot));
    }
  });

  it("resolves field by field and one status at a time: organization over platform over default", () => {
    const platform: BillingReadinessRulesOverride = {
      providerStatusSeverity: { onboarding: "stop", other: "stop" },
      membershipWithoutStartDate: "not_current",
    };
    expect(resolveBillingReadinessRules(platform)).toEqual({
      providerStatusSeverity: { terminated: "stop", onboarding: "stop", other: "stop" },
      membershipWithoutStartDate: "not_current",
    });
    expect(
      resolveBillingReadinessRules(platform, {
        providerStatusSeverity: { onboarding: "hold" },
        membershipWithoutStartDate: null,
      }),
    ).toEqual({
      providerStatusSeverity: { terminated: "stop", onboarding: "hold", other: "stop" },
      membershipWithoutStartDate: "not_current",
    });
    expect(
      resolveBillingReadinessRules(null, { membershipWithoutStartDate: "not_current" }),
    ).toEqual({ ...DEFAULT_BILLING_READINESS_RULES, membershipWithoutStartDate: "not_current" });
  });

  it("ignores a stored value of the wrong shape, and never relaxes a terminated clinician", () => {
    const bad = {
      providerStatusSeverity: { terminated: "hold", onboarding: "ready", other: 1 },
      membershipWithoutStartDate: "sometimes",
    } as unknown as BillingReadinessRulesOverride;
    expect(resolveBillingReadinessRules(bad)).toEqual(DEFAULT_BILLING_READINESS_RULES);
    expect(
      resolveBillingReadinessRules({ providerStatusSeverity: { onboarding: "stop" } }, bad),
    ).toEqual(withRules({ onboarding: "stop" }));
    expect(
      resolveBillingReadinessRules(
        "stop" as unknown as BillingReadinessRulesOverride,
        { providerStatusSeverity: "stop" } as unknown as BillingReadinessRulesOverride,
      ),
    ).toEqual(DEFAULT_BILLING_READINESS_RULES);
  });

  it("validates an override in plain language", () => {
    expect(validateBillingReadinessRules(null)).toEqual([]);
    expect(validateBillingReadinessRules({})).toEqual([]);
    expect(
      validateBillingReadinessRules({
        providerStatusSeverity: { terminated: "stop", onboarding: "stop", other: null },
        membershipWithoutStartDate: "not_current",
      }),
    ).toEqual([]);
    expect(validateBillingReadinessRules({ providerStatusSeverity: null })).toEqual([]);
    expect(
      validateBillingReadinessRules({ providerStatusSeverity: { terminated: "hold" } }),
    ).toEqual(["A terminated clinician is always Do Not Bill; it cannot be relaxed to a hold."]);
    expect(
      validateBillingReadinessRules({ providerStatusSeverity: { onboarding: "ready" } }),
    ).toEqual([
      'For an Onboarding clinician, choose a hold ("hold") or Do Not Bill ("stop"), not "ready".',
    ]);
    expect(validateBillingReadinessRules({ providerStatusSeverity: { other: "warn" } })).toEqual([
      'For a clinician status this rule does not recognize, choose a hold ("hold") or Do Not Bill ("stop"), not "warn".',
    ]);
    expect(validateBillingReadinessRules({ providerStatusSeverity: { active: "hold" } })).toEqual([
      '"active" is not a clinician status this setting covers. An Active clinician always counts; the statuses it covers are terminated, onboarding and other.',
    ]);
    expect(validateBillingReadinessRules({ providerStatusSeverity: "stop" })).toEqual([
      "Clinician status settings must name a status and its effect.",
    ]);
    expect(validateBillingReadinessRules({ membershipWithoutStartDate: "never" })).toEqual([
      'A group membership with no start date either counts as current ("current") or holds ("not_current"), not "never".',
    ]);
    expect(validateBillingReadinessRules({ caseNotEffective: "hold" })).toEqual([
      '"caseNotEffective" is not a Billing Readiness setting.',
    ]);
    expect(validateBillingReadinessRules(["stop"])).toEqual([
      "Billing Readiness settings must be a set of named settings.",
    ]);
  });

  it("says 'cannot be relaxed' only for a hold, and names a non-text value by its kind", () => {
    expect(
      validateBillingReadinessRules({ providerStatusSeverity: { terminated: "bogus" } }),
    ).toEqual(['A terminated clinician is always Do Not Bill ("stop"), not "bogus".']);
    expect(validateBillingReadinessRules({ providerStatusSeverity: { terminated: 1 } })).toEqual([
      'A terminated clinician is always Do Not Bill ("stop"), not 1.',
    ]);
    expect(validateBillingReadinessRules({ membershipWithoutStartDate: { a: 1 } })).toEqual([
      'A group membership with no start date either counts as current ("current") or holds ("not_current"), not a set of values.',
    ]);
    expect(
      validateBillingReadinessRules({ providerStatusSeverity: { onboarding: ["stop"] } }),
    ).toEqual([
      'For an Onboarding clinician, choose a hold ("hold") or Do Not Bill ("stop"), not a list.',
    ]);
    expect(validateBillingReadinessRules({ providerStatusSeverity: { other: true } })).toEqual([
      'For a clinician status this rule does not recognize, choose a hold ("hold") or Do Not Bill ("stop"), not true.',
    ]);
  });

  it("accepts only plain objects as a set of settings, never a Date or a list", () => {
    expect(validateBillingReadinessRules(new Date())).toEqual([
      "Billing Readiness settings must be a set of named settings.",
    ]);
    expect(validateBillingReadinessRules(Object.create(null))).toEqual([]);
    expect(validateBillingReadinessRules({ providerStatusSeverity: new Date() })).toEqual([
      "Clinician status settings must name a status and its effect.",
    ]);
    expect(validateBillingReadinessRules({ providerStatusSeverity: [] })).toEqual([
      "Clinician status settings must name a status and its effect.",
    ]);
    const dated = Object.assign(new Date(), { membershipWithoutStartDate: "not_current" });
    expect(resolveBillingReadinessRules(dated as unknown as BillingReadinessRulesOverride)).toEqual(
      DEFAULT_BILLING_READINESS_RULES,
    );
  });

  describe("providerStatusSeverity", () => {
    it("onboarding: holds by default; 'stop' makes it Do Not Bill with the same reason", () => {
      const snapshot = readySnapshot();
      snapshot.providers[0].status = "onboarding";
      expect(assessWith(snapshot, DEFAULT_BILLING_READINESS_RULES)).toMatchObject({
        status: "hold",
        reasons: [{ severity: "hold", label: ONBOARDING_LABEL }],
      });
      expect(assessWith(snapshot, withRules({ onboarding: "stop" }))).toMatchObject({
        status: "stop",
        label: "Do Not Bill",
        reasons: [{ severity: "stop", label: ONBOARDING_LABEL }],
      });
    });

    it("other: holds by default; 'stop' makes an unrecognized status Do Not Bill", () => {
      const snapshot = readySnapshot();
      Object.assign(snapshot.providers[0], { status: "inactive" });
      const reason = "The clinician status is not recognized.";
      expect(assessWith(snapshot, DEFAULT_BILLING_READINESS_RULES)).toMatchObject({
        status: "hold",
        reasons: [{ severity: "hold", label: reason }],
      });
      expect(assessWith(snapshot, withRules({ other: "stop" }))).toMatchObject({
        status: "stop",
        reasons: [{ severity: "stop", label: reason }],
      });
    });

    it("terminated: always Do Not Bill, and Active stays billable-eligible under any rules", () => {
      const strictest = withRules({ onboarding: "stop", other: "stop" });
      const snapshot = readySnapshot();
      expect(assessWith(snapshot, strictest)).toMatchObject({ status: "ready", reasons: [] });
      snapshot.providers[0].status = "terminated";
      for (const rules of [DEFAULT_BILLING_READINESS_RULES, strictest]) {
        expect(assessWith(snapshot, rules)).toMatchObject({
          status: "stop",
          reasons: [{ severity: "stop", label: "The clinician is terminated." }],
        });
      }
    });
  });

  describe("membershipWithoutStartDate", () => {
    it("current (default): a membership with no start date counts, a future start still holds", () => {
      const snapshot = readySnapshot();
      snapshot.groupMemberships[0].startDate = null;
      expect(assessWith(snapshot, DEFAULT_BILLING_READINESS_RULES)).toMatchObject({
        status: "ready",
        reasons: [],
      });
      snapshot.groupMemberships[0].startDate = "2026-09-26";
      expect(assessWith(snapshot, DEFAULT_BILLING_READINESS_RULES)?.reasons).toEqual([
        { severity: "hold", label: "Current group membership is not established." },
      ]);
    });

    it("not_current: no start date holds with its own reason, as before Oct 20", () => {
      const rules = withRules({ membershipWithoutStartDate: "not_current" });
      const snapshot = readySnapshot();
      expect(assessWith(snapshot, rules)).toMatchObject({ status: "ready" });
      snapshot.groupMemberships[0].startDate = null;
      expect(assessWith(snapshot, rules)).toMatchObject({
        status: "hold",
        reasons: [{ severity: "hold", label: "A group membership start date is missing." }],
      });
      // A dated sibling membership that is current still establishes it.
      snapshot.groupMemberships.push({
        providerId: "p1",
        groupId: "g1",
        startDate: "2025-01-01",
        endDate: null,
      });
      expect(assessWith(snapshot, rules)).toMatchObject({ status: "ready", reasons: [] });
    });

    it("reaches the newly billable digest through the rules argument", () => {
      const snapshot = readySnapshot();
      snapshot.groupMemberships[0].startDate = null;
      const feed = buildBillingFeed(snapshot, TODAY);
      expect(
        buildNewlyBillableDigestCsv(snapshot, feed, TODAY, DEFAULT_BILLING_READINESS_RULES).split(
          "\r\n",
        ),
      ).toHaveLength(2);
      expect(
        buildNewlyBillableDigestCsv(
          snapshot,
          feed,
          TODAY,
          withRules({ membershipWithoutStartDate: "not_current" }),
        ).split("\r\n"),
      ).toHaveLength(1);
    });

    it("reaches PTA supervisor candidates through the rules argument", () => {
      const snapshot = readySnapshot();
      snapshot.providers[0].taxonomyCode = "225200000X";
      snapshot.providers.push({ ...snapshot.providers[0], id: "pt-2", taxonomyCode: "225100000X" });
      snapshot.groupMemberships.push({
        providerId: "pt-2",
        groupId: "g1",
        startDate: null,
        endDate: null,
      });
      snapshot.facilityAssignments.push({
        providerId: "pt-2",
        facilityId: "f1",
        startDate: "2025-01-01",
      });
      snapshot.licenses.push({ ...snapshot.licenses[0], providerId: "pt-2" });
      expect(
        assessWith(snapshot, DEFAULT_BILLING_READINESS_RULES)?.supervisorCandidates.map(
          (candidate) => candidate.providerId,
        ),
      ).toEqual(["pt-2"]);
      expect(
        assessWith(snapshot, withRules({ membershipWithoutStartDate: "not_current" }))
          ?.supervisorCandidates,
      ).toEqual([]);
    });
  });
});

// #560's Lookup and Change Feed paths must use the rules they are given, not
// the defaults (the #558 restack review, P2).
describe("the Lookup and the Change Feed follow the rules they are given", () => {
  const DEFAULT = DEFAULT_BILLING_READINESS_RULES;
  const onboardingStops = resolveBillingReadinessRules(null, {
    providerStatusSeverity: { onboarding: "stop" },
  });

  /** An Onboarding clinician with a recent approval on Acme (linked to a
   * location) and a Blue Plan case with no linked location. */
  function onboardingSnapshot(): BillingReadinessSnapshot {
    const snapshot = readySnapshot();
    snapshot.providers[0].status = "onboarding";
    snapshot.payers.push({ ...snapshot.payers[0], id: "pay2", name: "Blue Plan" });
    snapshot.cases.push({ ...snapshot.cases[0], id: "c2", payerId: "pay2" });
    snapshot.statusTransitions[0].changedAt = "2026-09-20T12:00:00.000Z";
    snapshot.caseFacilities[0].createdAt = "2026-09-21T12:00:00.000Z";
    return snapshot;
  }

  it("changes the Lookup's payer-by-payer statuses, for assessed and unassessed rows", () => {
    const snapshot = onboardingSnapshot();
    const statuses = (rules: BillingReadinessRules) =>
      providerPayerStatuses(snapshot, "p1", TODAY, rules).map((row) => [
        row.payer.name,
        row.status,
      ]);
    expect(statuses(DEFAULT)).toEqual([
      ["Acme Health", "hold"],
      ["Blue Plan", "hold"],
    ]);
    expect(statuses(onboardingStops)).toEqual([
      ["Acme Health", "stop"],
      ["Blue Plan", "stop"],
    ]);
    // The row with no linked location carries the clinician's stop beside its
    // own hold, through clinicianReasons.
    expect(
      providerPayerStatuses(snapshot, "p1", TODAY, onboardingStops)[1].reasons.map((reason) => [
        reason.severity,
        reason.label,
      ]),
    ).toEqual([
      ["stop", ONBOARDING_LABEL],
      ["hold", "No location is linked to this enrollment case."],
    ]);
  });

  it("changes the Change Feed's assessment and its CSV", () => {
    const snapshot = onboardingSnapshot();
    const feed = filterBillingFeed(
      buildBillingFeed(snapshot, TODAY),
      { range: 30, kind: "approval" },
      TODAY,
    );
    expect(feed).toHaveLength(1);
    expect(assessFeedEvent(snapshot, feed[0], TODAY, DEFAULT)?.status).toBe("hold");
    expect(assessFeedEvent(snapshot, feed[0], TODAY, onboardingStops)?.status).toBe("stop");
    expect(buildChangeFeedCsv(snapshot, feed, TODAY, DEFAULT).split("\r\n")[1]).toContain('"Hold"');
    expect(buildChangeFeedCsv(snapshot, feed, TODAY, onboardingStops).split("\r\n")[1]).toContain(
      '"Do Not Bill"',
    );
  });

  it("changes which groups the Lookup search names as current", () => {
    const snapshot = readySnapshot();
    snapshot.groups.push({ ...snapshot.groups[0], id: "g2", name: "South Clinic" });
    snapshot.groupMemberships = [
      { providerId: "p1", groupId: "g1", startDate: null, endDate: null },
      { providerId: "p1", groupId: "g2", startDate: "2025-01-01", endDate: null },
    ];
    const groups = (rules: BillingReadinessRules) =>
      searchBillingProviders(snapshot, "ana", TODAY, rules).matches[0].groupNames;
    expect(groups(DEFAULT)).toEqual(["North Clinic", "South Clinic"]);
    expect(
      groups(resolveBillingReadinessRules(null, { membershipWithoutStartDate: "not_current" })),
    ).toEqual(["South Clinic"]);
  });
});
