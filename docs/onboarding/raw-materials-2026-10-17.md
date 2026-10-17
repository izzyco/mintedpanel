# Onboarding blueprint: raw materials (pulled 2026-10-17)

Source data behind `onboarding-service-blueprint.md`. Every number here was
read from the production Supabase project (`fkvuhfsqcmujywzgczmc`), the
staging project, Granola meeting notes, or the repo on 2026-10-17. Nothing is
estimated. Where a system had no answer, it says so.

**Reads were PHI-safe.** Org names, payer names, states, dates, counts, and
email domains only. No provider names, SSNs, DOBs, or addresses were pulled.

## 0. Who the live customers actually are

The brief named Kansas Fitness Physio and "South Park Physician Group" as the
two live customers. The systems disagree.

| Org in production | Created | Lifecycle state | Providers | Facilities | Groups | Cases | Target states |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BEST Physical Therapy LLC | 2026-07-29 | prospect | 40 | 28 | 3 | 39 | 9 |
| Kansas Fitness Physio (KFP) | 2026-08-10 | prospect | 13 | 12 | 4 | 32 | 3 |
| Lionstone Physical Therapy | 2026-08-18 | prospect | 2 | 2 | 1 | 1 | 3 |

- **No "South Park Physician Group"** exists in production, staging, or any
  Granola note (38 KFP meetings and 10 Minted Panel meetings searched by exact
  name and aliases). BEST Physical Therapy is used as the second live customer
  throughout. Open question 1 in the blueprint asks what South Park is.
- All three orgs are still `lifecycle_state = prospect`. Nobody has flipped
  one to `active`.
- Staging holds the same three plus a synthetic UX-audit org.

## 1. Actual onboarding timestamps

### 1a. Who has logged in

| Org | Members | Roles | Email domains | Customer-side member? |
| --- | --- | --- | --- | --- |
| BEST | 3 | admin, admin, admin | minted.com, mp.com | **No** |
| KFP | 3 | admin, admin, admin | minted.com, mp.com | **No** |
| Lionstone | 3 | admin, admin, admin | minted.com, mp.com | **No** |

The same three Minted staff accounts are the only members of every org. No
`billing` (read-only) role has ever been assigned. **"Date customer admin first
logged into dashboard" is "never" for all three customers.** Status reaches
customers by email, Google Sheet, and a weekly call (see section 2).

### 1b. First-event dates per org (from `created_at` and case dates)

| Event | BEST | KFP | Lionstone |
| --- | --- | --- | --- |
| Org created in Minted Panel | Jul 29 | Aug 10 | Aug 18 |
| First group / facility / provider / license rows | Jul 29 (same day) | Aug 10 (same day) | Aug 18 (same day) |
| First CSV import committed | Jul 29 (facilities, 25 rows) | Aug 17 (facilities, 3 rows) | none |
| First provider CSV committed | Sep 25 (45 rows; backfill) | Aug 18 (9 rows) | none |
| First payer network target | Aug 13 | Aug 12 | Aug 18 |
| First case generation run | Aug 13 | Aug 13 | Aug 18 |
| First case created | Aug 14 | Aug 13 | Sep 29 |
| First submission recorded | Aug 15 (Tricare NC) | Aug 14 (Aetna KS) | none recorded |
| First approval recorded | Aug 16 (Aetna NC, same-day backfill) | Oct 12 (Medicare KS) | Oct 5 (Cigna AK) |
| First realistic approval | Sep 4 (Aetna NC, submitted Aug 25) | Oct 12 | Oct 5 |
| First confirmed effective date | Sep 4 (backfill) / Sep 28 (realistic) | Oct 5 | Oct 6 |
| Contract signed | not in any system | not in any system | not in any system |
| Roster received | not in any system (see 1c) | not in any system | not in any system |

Caveats that matter:

- **Both customers predate the product.** KFP credentialing started in late
  May 2026 and Medicare approvals existed by Jun 25 (Granola), six weeks before
  the KFP org was created. BEST had payer contracts effective May 1. Several
  `submitted_date` values are backdated (one BEST case shows a submission 13
  days before the case existed). Minted Panel timelines are therefore a
  partial record, not the customer's real time-to-value.
- **The first two onboardings overlapped product build.** BEST's 15-day gap
  between data loaded (Jul 29) and first payer target (Aug 13) is when the
  payer-network and generation features shipped. That gap is not a process
  number.
- **Lionstone sat idle 42 days** between data loaded (Aug 18) and first case
  (Sep 29). Nothing in the DB explains why.

### 1c. CSV import runs (every run in production)

| Date | Org | Entity | Rows | Errors | Outcome |
| --- | --- | --- | --- | --- | --- |
| Jul 29 | BEST | facility | 25 | 0 | committed in 24 s |
| Aug 17 | KFP | facility | 3 | 0 | committed |
| Aug 17 | KFP | provider | 9 | **9** | failed, never committed |
| Aug 18 | KFP | provider | 9 | 0 | committed (8 created) |
| Sep 21 | BEST | provider | 39 | **39** | cancelled |
| Sep 25 | BEST | provider | 45 | 0 | committed (31 created, 5 updated) |
| Sep 25 | KFP | provider | 17 | **17** | cancelled |
| Sep 25 | KFP | provider | 17 | 4 | committed (13 rows, 3 updated) |

**Every first attempt at a provider CSV failed on 100% of rows (3 of 3).**
Each was retried by Minted staff within 1 to 4 days. No customer has ever
uploaded a file; `/admin/import` is admin-only and customers have no login.

### 1d. Days per controllable segment (Minted Panel work)

| Segment | BEST | KFP | Lionstone |
| --- | --- | --- | --- |
| Org created to first data loaded | 0 | 0 | 0 |
| Data loaded to payer network configured | 15 | 2 | 0 |
| Payer network to first case | 1 | 1 | 42 |
| First case to first submission | 1 | 1 | n/a |
| **Org created to first submission** | **17** | **4** | n/a |
| Case created to submitted, typical | 0 to 6 days (outliers 12, 16, 26) | 0 to 5 days | n/a |

## 2. Customer communication log (Granola, May to Oct 2026)

No Gmail or Slack access was available in this session (both connectors
failed to connect). This is what the meeting record shows.

### 2a. What customers asked for

| Date | Who | Ask |
| --- | --- | --- |
| Jun 25 | KFP (Marc) | Weekly Tuesday sync established; Sowmya joins when there are updates |
| Jul 7 | BEST billing team | "Consistent, accessible status updates": a live Google Sheet by payer and provider plus a weekly email. First one promised that Friday |
| Jul 20 | BEST (Mark) | Weekly credentialing update assigned |
| Aug | BEST (Mark) | Monthly email: CAQH setup, roster changes, insurance wins, payer progress, screenshot of the enrollment folder |
| Sep 17 | BEST (Mark) | "Waiting on a status update" on Fran / Best California. Plan: give Mark restricted Minted Panel access, payer tab only. **Never happened** (no customer member exists) |
| Sep 24 | BEST | Asked ASH to send requests by email to the credentialing inbox, not voicemail |

### 2b. What was missing or wrong in the data

| Date | Customer | Problem | Who had to fix it |
| --- | --- | --- | --- |
| May 19 | KFP | Incomplete W-9 and HPSO docs; insurance portal records poorly maintained | Minted chased |
| Jun 16 | KFP | Portal 2FA tied to the former owner's phone; Optum credentials wrong | Minted blocked |
| Jun 25 | KFP | A provider's info not received, credentialing could not start | Minted chased |
| Jun 25 | KFP | BCBS Kansas denied: county not served. Had to find and call BCBS Kansas City | Minted |
| Jun 30 | KFP | Aetna submitted, no confirmation email. Had to keep own record and follow up | Minted |
| Jul 7 | KFP | Former owner could not provide MPI access; fallback was a new tax ID | Customer |
| Jul 20 | BEST and KFP | A provider's date of birth missing | Customer |
| Aug 18 | KFP | Wrong tax ID on one entity; clinic address wrong (2924 vs 2916 S. 4th St, suite pending) | Customer |
| Aug 18 | BEST (new clinic) | Sep 1 go-live needed W-9, COI, CMS-460, group NPI, PECOS and CAQH logins first | Customer |
| Aug 31 | BEST | Roster spelling error; 4 providers with password or login problems | Mixed |
| Sep 3 | KFP | Providers and locations missing from the Availity roster | Minted |
| Sep 15 | KFP | Medicare rejection: business name mismatch between MPI and the filing. DBA added in PECOS | Minted |
| Sep 15 | KFP | A provider lacked Kansas as a CAQH "state of practice", so the Kansas application could not download | Provider |
| Sep 24 | BEST | ASH had no subspecialty on file; new tax ID still processing | Mixed |
| Sep 28 | BEST (Idaho) | Launch depended on one provider updating CAQH first | Provider |

### 2c. Where it cost the customer money

- BEST Colorado: patients billed out-of-network rates ($97 instead of a $40
  copay) from the May 1 contract effective date because providers were not
  yet shown in-network. Workaround was billing under the owner's individual
  name with the group tax ID (Jul 7).
- KFP: Medicare approved for two providers with instruction to bill under the
  owner until individual credentialing cleared (Jun 25).

### 2d. Internal operating notes

- Jul 28: pricing discussed at about $399 per new provider, $19 per provider
  per month to maintain, $200 to $300 for a lapsed recredential. Luna (about
  3,000 PTs, about 500 hires per quarter) named as the large prospect.
- Aug 21: decision not to publish pricing on the website. Client access
  planned as read-only with two views (in/out-of-network status; active
  application progress) plus red/yellow/green provider readiness and daily
  reminders for missing documents. Daily reminders are not built.
- Sep 11: about 30 KFP enrollment records still had to be created by hand in
  Minted Panel.
- Sep 17: payer-form issues tracked: missing gender and middle initial,
  unmapped Kansas BCBS taxonomy, broken date handling, two Kansas form
  variants risking the wrong form.

## 3. Payer decision data (production cases, as of 2026-10-17)

### 3a. Decided cases

| Payer | State | Org | Submitted | Decided | Days | Outcome | Effective |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Aetna | NC | BEST | Aug 25 | Sep 4 | 10 | approved | Sep 28 |
| Medicare | KS | KFP | Sep 30 | Oct 12 | 12 | approved | Oct 12 |
| Medicare | KS | KFP | Sep 17 | Oct 12 | 25 | approved | Oct 5 |
| Aetna | MO | KFP | Aug 31 | Sep 8 | 8 | denied (reapplied Oct 16) | |
| Cigna | AK | Lionstone | not recorded | Oct 5 | 6 from case creation | approved | Oct 6 |
| Aetna | NC | BEST | Aug 16 | Aug 16 | 0 (backfill) | approved | Sep 4 |

Six decisions in total. Four carry a real submit-to-decision interval.

### 3b. Still pending, by age since submission

| Age bucket | Count | Examples |
| --- | --- | --- |
| 60+ days | 7 | Aetna KS (64), UHC KS (64), Cigna KS (60), Tricare NC (63), Medicare NC (62), Aetna CA (71, backdated) |
| 45 to 59 days | 14 | BCBS KS (57), BCBS NC (58), UHC NC (52), six NC payers submitted Aug 31 (47), UHC/Cigna/Humana MO (47) |
| 30 to 44 days | 10 | Aetna ID x2 and UHC ID (43), BCBS NC (36), Medicare ID x2 (31 to 32), Aetna/BCBS/Cigna/UHC KS Sep 15 to 17 (30 to 32) |
| under 30 days | 11 | Cigna ID (25), Tricare NC (25), Anthem CA (23), Trinity ID (12), five KFP KS Oct 15 to 16 (1 to 2) |

Forty-two cases are pending. Median age about 46 days. Either payers are
slow (Granola: Aetna and Cigna quoted 30 to 90 days; UHC about 30) or
statuses are not being updated. Both are probably true: only 33 touch rows
exist across 72 cases in 10 weeks.

### 3c. Payer-side quirks observed

| Payer | Quirk |
| --- | --- |
| BCBS Kansas | Denies by county; Kansas City metro routes to BCBS Kansas City |
| Medicare (PECOS) | Rejects on legal name vs DBA mismatch; location adds by effective date |
| Aetna | No confirmation email on submission; 30 to 90 day window |
| Cigna | 30 to 90 day window |
| UHC | In-network at tax-ID level first, individuals within about 30 days; contract load dates batch (Sep 28) |
| Optum / Optimum | Separate PDF application; phone contact only route that worked |
| ASH | Calls to verify subspecialty and directory data before finalizing |
| Humana | Showed terminated while still paying; test claim needed to tell MA from commercial |
| Colorado commercial contracting | About 8 months (Sep to May) |
| Missouri | 6+ months once started |

## 4. Competitor onboarding experience

See `competitor-onboarding-benchmark-2026-10-17.md`. No demo or trial was
signed up for; everything is public web research.

## 5. Lost deal notes

None found in Granola, the DB, or the repo. The `/contact` lead form writes to
`inbound_leads`; the Reporting Center shows them but none were reviewed here.
