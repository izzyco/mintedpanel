// E6.5 F6.5.3 — the mock-data fill profile for in-editor dry runs.
//
// A dry run proves the MAPPING (every live field map resolves to a value), not
// any provider's data. It therefore fills from this versioned synthetic
// profile and NEVER reads provider/group/facility tables — no PHI is involved,
// no designated test-provider row is required (the F4.2.7 test-provider seam
// this replaces), and a mapped token can never come back empty_token, so
// "pass" reduces to exactly "zero unmapped fields".
//
// Values are deliberately, visibly fake (a real form filled from this profile
// would read "Sample …" everywhere). Bump MOCK_FILL_PROFILE_VERSION when the
// curated values or the heuristics change materially — recorded dry runs are
// interpreted against the profile that produced them.

export const MOCK_FILL_PROFILE_VERSION = 5;

// Curated values for the common catalog tokens (bare form, the extension join
// contract). Everything else falls through to the field-name heuristics below.
export const MOCK_FILL_VALUES: Readonly<Record<string, string>> = {
  // --- provider.* ---
  "provider.firstName": "Sample",
  "provider.lastName": "Provider",
  "provider.fullName": "Sample Provider",
  "provider.lastFirst": "Provider, Sample",
  "provider.middleInitial": "S",
  "provider.suffix": "Jr.",
  "provider.credentials": "PT, DPT",
  "provider.fullNameWithCredentials": "Sample Provider, PT, DPT",
  "provider.degree": "DPT",
  "provider.gender": "Female",
  "provider.ethnicity": "Not Disclosed",
  "provider.dateOfBirth": "1980-01-15",
  "provider.ssnLast4": "0000",
  "provider.email": "sample.provider@example.com",
  "provider.phone": "5555550100",
  "provider.npi": "1999999984",
  "provider.caqhId": "12345678",
  "provider.caqhLastAttestedDate": "2026-01-15",
  "provider.taxonomyCode": "225100000X",
  "provider.specialty": "Physical Therapy",
  "provider.subSpecialty": "Orthopedic",
  "provider.deaNumber": "AB1234563",
  "provider.deaExpirationDate": "2027-01-15",
  "provider.licenseNumber": "SAMPLE-12345",
  "provider.licenseState": "NC",
  "provider.licenseIssueDate": "2020-01-15",
  "provider.licenseExpirationDate": "2027-01-15",
  "provider.schoolName": "Sample University",
  "provider.graduationDate": "2006-05-15",
  "provider.homeStreet": "123 Sample St",
  "provider.homeCity": "Sampleville",
  "provider.homeState": "NC",
  "provider.homeZip": "27601",
  "provider.homeCityStateZip": "Sampleville, NC 27601",
  "provider.homeAddress": "123 Sample St, Sampleville, NC 27601",
  "provider.homeFullAddress": "123 Sample St, Sampleville, NC 27601",
  "provider.startDate": "2026-01-15",
  "provider.terminatedDate": "2028-01-15",
  "provider.boardCertified": "Yes",
  "provider.languages": "English, Spanish",
  "provider.medicaidAttested": "Yes",
  "provider.culturalCompetencyTraining": "Yes",
  "provider.additionalCertifications": "Sample Board Certification",
  "provider.ageGroupsServed": "Adults, Geriatrics",
  "provider.malpracticeCarrier": "Sample Healthcare Assurance",
  "provider.malpracticePolicyNumber": "MP-SAMPLE-999",
  "provider.malpracticeCoverageStart": "2020-01-15",
  "provider.malpracticeCoverageEnd": "2027-01-15",
  "provider.launchId": "launch-sample-001",
  "provider.verificationState": "verified",
  "provider.isTestProvider": "No",
  "provider.referenceOnly": "No",

  // --- group.* ---
  "group.name": "Sample Provider Group",
  "group.tin": "123456789",
  "group.taxIdType": "EIN",
  "group.npiType2": "1999999984",
  "group.states": "NC, SC, VA",
  "group.websiteUrl": "https://example.com",
  "group.preferredContactMethod": "Email",
  "group.payerIssuedId": "SAMPLE-GRP-01",
  "group.billingStreet": "100 Billing St",
  "group.billingSuite": "Suite 200",
  "group.billingCity": "Sampleville",
  "group.billingState": "NC",
  "group.billingZip": "27601",
  "group.billingContactName": "Sample Billing Manager",
  "group.billingFullName": "Sample Billing Manager",
  "group.billingContactFullName": "Sample Billing Manager",
  "group.billingCityStateZip": "Sampleville, NC 27601",
  "group.billingStreetAddress": "100 Billing St, Suite 200",
  "group.billingAddress": "100 Billing St, Suite 200, Sampleville, NC 27601",
  "group.billingFullAddress": "100 Billing St, Suite 200, Sampleville, NC 27601",
  "group.billingPhone": "5555550100",
  "group.billingFax": "5555550101",
  "group.billingEmail": "sample@example.com",
  "group.correspondenceStreet": "100 Correspondence Way",
  "group.correspondenceSuite": "Suite 300",
  "group.correspondenceCity": "Sampleville",
  "group.correspondenceState": "NC",
  "group.correspondenceZip": "27601",
  "group.correspondenceContactName": "Sample Correspondence Contact",
  "group.correspondenceFullName": "Sample Correspondence Contact",
  "group.correspondenceContactFullName": "Sample Correspondence Contact",
  "group.correspondenceCityStateZip": "Sampleville, NC 27601",
  "group.correspondenceStreetAddress": "100 Correspondence Way, Suite 300",
  "group.correspondenceAddress": "100 Correspondence Way, Suite 300, Sampleville, NC 27601",
  "group.correspondenceFullAddress": "100 Correspondence Way, Suite 300, Sampleville, NC 27601",
  "group.correspondencePhone": "5555550100",
  "group.correspondenceFax": "5555550101",
  "group.correspondenceEmail": "correspondence@example.com",
  "group.credentialingStreet": "100 Credentialing Ave",
  "group.credentialingSuite": "Suite 400",
  "group.credentialingCity": "Sampleville",
  "group.credentialingState": "NC",
  "group.credentialingZip": "27601",
  "group.credentialingContactName": "Sample Credentialing Contact",
  "group.credentialingFullName": "Sample Credentialing Contact",
  "group.credentialingContactFullName": "Sample Credentialing Contact",
  "group.credentialingCityStateZip": "Sampleville, NC 27601",
  "group.credentialingStreetAddress": "100 Credentialing Ave, Suite 400",
  "group.credentialingAddress": "100 Credentialing Ave, Suite 400, Sampleville, NC 27601",
  "group.credentialingFullAddress": "100 Credentialing Ave, Suite 400, Sampleville, NC 27601",
  "group.credentialingPhone": "5555550100",
  "group.credentialingFax": "5555550101",
  "group.credentialingEmail": "credentialing@example.com",
  "group.contractingContactName": "Sample Contracting Officer",
  "group.contractingFullName": "Sample Contracting Officer",
  "group.contractingContactFullName": "Sample Contracting Officer",
  "group.contractingContactTitle": "Contract Administrator",
  "group.contractingContactEmail": "contracting@example.com",
  "group.contractSignerName": "Sample Signer",
  "group.contractSignerFullName": "Sample Signer",
  "group.contractSignerEmail": "signer@example.com",

  // --- facility.* ---
  "facility.name": "Sample Clinic",
  "facility.street": "456 Sample Ave",
  "facility.suite": "Suite 100",
  "facility.city": "Sampleville",
  "facility.state": "NC",
  "facility.zip": "27601",
  "facility.county": "Wake",
  "facility.address": "456 Sample Ave, Sampleville, NC 27601",
  "facility.streetAddress": "456 Sample Ave, Suite 100",
  "facility.fullAddress": "456 Sample Ave, Suite 100, Sampleville, NC 27601",
  "facility.cityStateZip": "Sampleville, NC 27601",
  "facility.phone": "5555550100",
  "facility.fax": "5555550101",
  "facility.email": "clinic@example.com",
  "facility.appointmentPhone": "5555550100",
  "facility.contactName": "Sample Clinic Manager",
  "facility.contactFullName": "Sample Clinic Manager",
  "facility.effectiveDate": "2020-01-15",
  // facility.hours is the hoursSummary() text; the per-day keys are the
  // facility.hours{Day}{Status|Open|Close} composites (stored 24h HH:MM).
  "facility.hours": "Open 7 days/week",
  "facility.hoursMonStatus": "Open",
  "facility.hoursMonOpen": "08:00",
  "facility.hoursMonClose": "17:00",
  "facility.hoursTueStatus": "Open",
  "facility.hoursTueOpen": "08:00",
  "facility.hoursTueClose": "17:00",
  "facility.hoursWedStatus": "Open",
  "facility.hoursWedOpen": "08:00",
  "facility.hoursWedClose": "17:00",
  "facility.hoursThuStatus": "Open",
  "facility.hoursThuOpen": "08:00",
  "facility.hoursThuClose": "17:00",
  "facility.hoursFriStatus": "Open",
  "facility.hoursFriOpen": "08:00",
  "facility.hoursFriClose": "17:00",
  "facility.hoursSatStatus": "Open",
  "facility.hoursSatOpen": "09:00",
  "facility.hoursSatClose": "13:00",
  "facility.hoursSunStatus": "Open",
  "facility.hoursSunOpen": "09:00",
  "facility.hoursSunClose": "13:00",
  "facility.acceptingNewPatients": "Yes",
  "facility.adaCompliance": "Yes",
  "facility.languageLine": "Yes",
  "facility.languagesOffered": "English, Spanish",
  "facility.interpreterLanguages": "Spanish, ASL",
  "facility.serviceTypes": "Outpatient Physical Therapy",
  "facility.treatingCategories": "Physical Therapy, Rehabilitation",
  "facility.statusId": "active",
  "facility.referenceOnly": "No",

  // --- license.* ---
  "license.licenseNumber": "SAMPLE-12345",
  "license.state": "NC",
  "license.licenseType": "PT",
  "license.issueDate": "2020-01-15",
  "license.expirationDate": "2027-01-15",
  "license.verifiedStatus": "active",
  "license.verifiedBy": "Sample Verifier",
  "license.verifiedAt": "2026-01-15",
  "license.verificationSourceUrl": "https://verify.example.com",

  // --- assignment.* ---
  "assignment.isPrimary": "Yes",
  "assignment.practiceFrequency": "Full-time",
  "assignment.startDate": "2026-01-15",

  // --- groupInsurance.* ---
  "groupInsurance.insurerName": "Sample Mutual Insurance",
  "groupInsurance.policyNumber": "POL-SAMPLE-123",
  "groupInsurance.insuranceType": "Professional Liability",
  "groupInsurance.coverageLevel": "Primary",
  "groupInsurance.policyStartDate": "2026-01-15",
  "groupInsurance.policyEndDate": "2027-01-15",
  "groupInsurance.notes": "Comprehensive occurrence policy",

  // --- user.* ---
  "user.name": "Sample Operator",
  "user.fullName": "Sample Operator",
  "user.firstName": "Sample",
  "user.lastName": "Operator",
  "user.title": "Credentialing Specialist",
  "user.email": "sample.operator@example.com",

  // --- billingContact.* ---
  "billingContact.firstName": "Sample",
  "billingContact.lastName": "Billing",
  "billingContact.fullName": "Sample Billing",
  "billingContact.title": "Billing Manager",
  "billingContact.email": "billing.contact@example.com",
  "billingContact.phoneOffice": "5555550100",
  "billingContact.phoneExtension": "101",
  "billingContact.phoneMobile": "5555550102",
  "billingContact.fax": "5555550101",
  "billingContact.addressLine1": "100 Billing Way",
  "billingContact.addressLine2": "Suite 200",
  "billingContact.city": "Sampleville",
  "billingContact.state": "NC",
  "billingContact.postalCode": "27601",
  "billingContact.country": "USA",
  "billingContact.cityStateZip": "Sampleville, NC 27601",
  "billingContact.fullAddress": "100 Billing Way, Suite 200, Sampleville, NC 27601",

  // --- credentialingContact.* ---
  "credentialingContact.firstName": "Sample",
  "credentialingContact.lastName": "Credentialing",
  "credentialingContact.fullName": "Sample Credentialing",
  "credentialingContact.title": "Credentialing Coordinator",
  "credentialingContact.email": "credentialing.contact@example.com",
  "credentialingContact.phoneOffice": "5555550100",
  "credentialingContact.phoneExtension": "102",
  "credentialingContact.phoneMobile": "5555550103",
  "credentialingContact.fax": "5555550101",
  "credentialingContact.addressLine1": "100 Credentialing Ave",
  "credentialingContact.addressLine2": "Suite 400",
  "credentialingContact.city": "Sampleville",
  "credentialingContact.state": "NC",
  "credentialingContact.postalCode": "27601",
  "credentialingContact.country": "USA",
  "credentialingContact.cityStateZip": "Sampleville, NC 27601",
  "credentialingContact.fullAddress": "100 Credentialing Ave, Suite 400, Sampleville, NC 27601",

  // --- contractingSigner.* ---
  "contractingSigner.firstName": "Sample",
  "contractingSigner.lastName": "Signer",
  "contractingSigner.fullName": "Sample Signer",
  "contractingSigner.title": "Authorized Signer",
  "contractingSigner.email": "contracting.signer@example.com",
  "contractingSigner.phoneOffice": "5555550100",
  "contractingSigner.phoneExtension": "103",
  "contractingSigner.phoneMobile": "5555550104",
  "contractingSigner.fax": "5555550101",
  "contractingSigner.addressLine1": "100 Executive Blvd",
  "contractingSigner.addressLine2": "Suite 500",
  "contractingSigner.city": "Sampleville",
  "contractingSigner.state": "NC",
  "contractingSigner.postalCode": "27601",
  "contractingSigner.country": "USA",
  "contractingSigner.cityStateZip": "Sampleville, NC 27601",
  "contractingSigner.fullAddress": "100 Executive Blvd, Suite 500, Sampleville, NC 27601",

  // --- payer.* ---
  "payer.name": "Sample Health Plan",
  "payer.payerSlug": "sample-health-plan",
  "payer.payerKind": "commercial",
  "payer.source": "standard",
  "payer.states": "NC, SC, VA",
  "payer.aliases": "SHP, Sample Health",
  "payer.delegationNote": "Direct provider credentialing required",
  "payer.groupIdExpected": "Yes",
  "payer.groupIdLabel": "Payer Group ID",
  "payer.providerIdExpected": "Yes",
  "payer.providerIdLabel": "Provider PIN",
  "payer.resolutionIdExpected": "No",
  "payer.resolutionIdLabel": "Resolution ID",
  "payer.avgDecisionDays": "45",
  "payer.createdBy": "Sample Admin",
  "payer.lastSyncedAt": "2026-01-15",
  "payer.archivedAt": "2026-01-15",
  "payer.mergedIntoId": "sample-payer-primary",

  // --- mso.* ---
  "mso.name": "Sample Management Services",
  "mso.portalUrl": "https://mso.example.com",

  // --- contract.* ---
  "contract.payerGroupId": "SAMPLE-PG-99",
  "contract.state": "NC",
  "contract.effectiveDate": "2026-01-15",
  "contract.expirationDate": "2027-01-15",
  "contract.notes": "Standard participating group agreement",
};

// Field-name heuristics for tokens outside the curated map, keyed on the part
// after the last dot (camelCase). Deterministic; always non-empty.
export function mockValueForToken(token: string): string {
  const curated = MOCK_FILL_VALUES[token];
  if (curated) return curated;
  const field = token.slice(token.lastIndexOf(".") + 1);
  const lower = field.toLowerCase();
  if (lower.includes("ssn")) return "0000";
  if (lower.includes("date")) return "2026-01-15";
  if (lower.includes("email")) return "sample@example.com";
  if (lower.includes("phone") || lower.includes("fax")) return "5555550100";
  if (lower === "state" || lower.endsWith("state")) return "NC";
  if (lower.includes("zip") || lower.includes("postal")) return "27601";
  if (lower.includes("npi")) return "1999999984";
  const words = field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return `Sample ${words}`;
}

/** Build the resolved-token record a dry run feeds computeTestRun — one entry
 * per distinct mapped token, every value synthetic and non-empty. */
export function buildMockTokenMap(
  tokens: Iterable<string | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tokens) {
    const token = t?.trim();
    if (!token || out[token]) continue;
    out[token] = mockValueForToken(token);
  }
  return out;
}
