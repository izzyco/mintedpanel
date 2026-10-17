# Minted Panel onboarding: service blueprint (v1, 2026-10-17)

Built from production data, meeting notes, the repo, and public competitor
pages on 2026-10-17. Every **actual** number traces to
`raw-materials-2026-10-17.md`. Every **target** is a proposal, labeled as
such. Competitor sources are in `competitor-onboarding-benchmark-2026-10-17.md`.

## Read this first: five findings that change the brief

1. **The second live customer in the data is BEST Physical Therapy, not South
   Park.** No "South Park Physician Group" exists in production, staging, or
   any meeting note. BEST (40 providers, 9 states) is used throughout.
2. **No customer has ever logged into the dashboard.** All nine memberships
   across the three orgs are Minted staff accounts. No read-only `billing`
   role has been assigned, ever. Status reaches customers by weekly email, a
   Google Sheet, and a Tuesday call. The client-access slice (E6.12) is built
   but sits behind separate hosted-migration and invite approval gates, and
   the "Invite member" button was removed from the MVP on 2026-07-19.
3. **"Admin Quick-Invite" and `/join/[org-slug]` do not exist in code.** What
   exists: `/client-invites/claim/$token` (the recipient must already have a
   verified account; it sends no email), the dormant `pending_invites` +
   `claim_invites()` + `/welcome` path, and an `invite-member` edge function
   with no UI caller.
4. **Every first provider CSV upload failed on 100% of rows (3 of 3).**
   Minted staff retried within 1 to 4 days. Customers have never touched the
   uploader; it is admin-only and they have no login.
5. **Six payer decisions exist. Forty-two cases are pending, median age 46
   days.** A "billing-ready in X days" headline cannot be backed by this
   sample. The controllable number can: roster to first submission.

## Section 1: Time-to-value waterfall

No contract date or roster-received date exists in any system, so Stage 0
anchors on "org created in Minted Panel". Both live customers were existing
credentialing clients before the product existed, and both onboarded while
the product was being built. Treat the actuals as a floor for process
quality, not a clean measurement.

| Segment | Owner | Actual BEST | Actual KFP | Actual Lionstone | Target (days) | Controllable? |
| --- | --- | --- | --- | --- | --- | --- |
| Contract to kickoff call | Minted | unknown | unknown | unknown | 3 | Yes |
| Kickoff to roster received | Customer | unknown; data arrived piecemeal Jul to Sep | unknown; piecemeal Jun to Aug | unknown | 5 | Partially |
| Roster received to data loaded | Minted | 0 (manual entry same day); provider CSV committed 4 days after a failed first run | 0 same day; provider CSV took 2 attempts (fail Aug 17, commit Aug 18) | 0 | 2 | Yes |
| Data loaded to payer network configured | Minted | 15 (feature was being built) | 2 | 0 | 1 | Yes |
| Payer network to first submission | Minted | 2 | 2 | never recorded (first case on day 42, approved with no submit date) | 2 | Yes |
| **Roster to first submission (Minted segments)** | Minted | **17** | **4** | n/a | **5 business days** | Yes |
| Submission to first decision | Payer | 10 (Aetna NC) | 12 and 25 (Medicare KS); 8 to a denial (Aetna MO) | 6 from case creation (Cigna AK) | 30 to 90 | No |
| Decision to effective date | Payer | 24 (approved Sep 4, effective Sep 28) | 0 to -7 (Medicare backdates) | 1 | 0 to 30 | No |
| **Org created to first effective date** | mixed | **61** (37 on a backfilled case) | **56** | **49** (42 of them idle) | **45 to 100** | Partly |

What slowed each segment, what would halve it, and whose effort it is:

| Segment | What actually slowed it | What halves it | Effort |
| --- | --- | --- | --- |
| Contract to kickoff | Not measured. Neither customer had a kickoff; both were already clients. | A fixed slot within 3 business days of signature, booked from the signature email | Minted |
| Kickoff to roster | Data arrived in pieces: a DOB missing (Jul 20), a wrong tax ID and wrong clinic address (Aug 18), 4 provider logins broken (Aug 31), portal 2FA on the former owner's phone (Jun 16), MPI access the former owner could not give (Jul 7). | One intake packet with a hard list, sent before kickoff. Accept any spreadsheet; require only NPI, name, start date, locations; Minted pulls the rest from NPPES and CAQH | Customer |
| Roster to loaded | First provider CSV failed every row, three times. The header gate rejects pre-parity templates with "download the template and re-upload", which is the likely cause; the `error_report` rows were not read for this audit. | Minted maps the customer's file to the template, never the customer. Run the gate the day the file arrives. | Minted |
| Loaded to payer network | BEST's 15 days was product build. KFP's 2 days is the real number. | Payer network comes from the kickoff worksheet (group × payer × state) and is entered the same day as the roster | Minted |
| Network to first submission | 1 to 2 days when the SOP and portal are trained. Outliers: Tricare NC 26 days case-to-submit, Medicare NC 16, BCBS CA 12; probably waiting on a provider's CAQH or a login. | Submit payers that need no provider action first (PECOS, Aetna, Cigna); hold CAQH-dependent ones in Action Required with a named owner | Minted |
| Submission to decision | Payer time (Aetna and Cigna quoted 30 to 90; UHC about 30; Medicare 12 to 25 observed). But 42 pending at a median of 46 days with only 33 touches across 72 cases says statuses are stale too. | A 14-day follow-up per open case, logged as a touch. The dashboard is only honest if this runs | Minted |
| Decision to effective | Payer. Aetna NC: approved Sep 4, effective Sep 28. | Nothing. Tell billing the gap so claims hold to the right date | Payer |

## Section 2: Failure mode analysis

Only failures that happened with BEST or KFP, plus two the data makes
unavoidable (idle org, stale status). P = probability, I = impact.

| Segment | Failure mode | P | I | Detection | Recovery |
| --- | --- | --- | --- | --- | --- |
| Kickoff / intake | Portal credentials belong to a departed owner (2FA on the old phone; wrong Optum login; MPI access unavailable) | H | H | Intake packet lists every portal login and who holds the 2FA device; test each login on the kickoff call | Reset ownership through the payer (I&A, Availity admin). Budget 5 to 10 days; exclude from the Minted SLA clock |
| Kickoff / intake | Group documents missing (W-9, COI, CMS-460, group NPI letter, bank letter) | H | H | Packet checklist; Org Detail readiness | Do not enter the payer network until the five group docs are in the vault; chase every 2 business days |
| Roster received | Provider CSV fails every row on first upload (3 of 3 in production) | H | M | Header gate at upload | Minted owns the file. Customer never sees the template. Map, gate, fix, commit within 1 business day |
| Roster received | Partial provider data ("DOB and SSN later") | H | M | Provider readiness chips (DOB, SSN last 4, address as presence booleans) | Accept partial. Send the provider their capture link and SSN link directly. 5-day follow-up cadence |
| Roster received | Identity data wrong at the source (legal name vs DBA, tax ID, clinic street number, suite) | M | H | Check NPPES and the IRS letter against the roster before any submission | Medicare rejected KFP on a DBA mismatch (Sep 15). Add a DBA field on the group record and put it on the PECOS checklist |
| Data loaded | Provider lacks the target state as a CAQH "state of practice", so the payer application cannot be downloaded | M | H | Not detectable in the product (no CAQH integration) | Provider fixes CAQH. Put the exact steps in the provider homework email |
| Data loaded | Org loaded, then idle (Lionstone: 42 days to the first case) | M | M | Not detected today. Proposal: Portfolio flag when an org has data and zero cases after 5 business days | Generation run the same day as payer-network entry |
| Submission | Payer sends no confirmation (Aetna, Jun 30) | H | M | Touch logged "submitted, no receipt" | Call at day 7 to confirm receipt; record the reference number on the case |
| Submission | Wrong payer entity (BCBS Kansas denies by county; Kansas City routes to BCBS Kansas City) | M | M | Not detectable in the product | Payer catalog note per state. Resubmit to the correct entity |
| Submission to decision | Status goes stale (42 pending, median 46 days, 33 touches total) | H | H | The follow-up reducer already derives a next date; the Next Best Action queue surfaces it | 14-day follow-up rule per open case, logged as a touch |
| Submission to decision | Denial for a fixable reason (county, name mismatch, missing subspecialty) | M | H | Denied status with a reason code | Reapply path exists (Denied to In Progress). Target 5 business days from denial to resubmission |
| Go-live | Customer bills before in-network (BEST Colorado: $97 out-of-network vs a $40 copay) | M | H | Billing Readiness report | Weekly "do not bill yet" list to the billing contact; effective dates on the status email |
| Go-live | Customer cannot see status and emails to ask (Mark, Sep 17) | H | M | Nothing today | Turn on client access, or until then a fixed weekly email generated from the Matrix |

## Section 3: Service blueprint

Stages across = the waterfall. Lanes down. The line of visibility runs
between Frontstage and Backstage. Durations are targets.

| Lane | Stage 0: Contract to kickoff (Minted, 3 d) | Stage 1: Kickoff to roster (Customer, 5 d) | Stage 2: Roster to loaded (Minted, 2 d) | Stage 3: Loaded to first submission (Minted, 3 d) | Stage 4: Submission to decision (Payer, 30 to 90 d) | Stage 5: Live and mid-cycle |
| --- | --- | --- | --- | --- | --- | --- |
| **Customer actions** | Signs. Replies to the welcome email with a kickoff slot and the admin + billing contact names | Attends a 30 to 60 min kickoff. Returns the intake packet: roster in any format (NPIs required), five group docs, portal logins and 2FA owners, payer list by state. Each provider completes their own links | Answers data-correction questions within 1 business day | Signs applications that need a signature. Providers attest CAQH and add the state of practice | Reads the weekly status email. Forwards any payer mail | Logs into the dashboard (read-only) once it exists. Notifies Minted of a new hire; the hire completes their links |
| **Frontstage (what the customer sees us do)** | Welcome email with calendar link, intake packet, security one-pager | Kickoff deck. Shared checklist of what is still missing. Confirmation email listing what was received | "Roster loaded" email: provider count, location count, gaps by provider | "First applications submitted" email: payer, state, provider, date, reference number | Weekly status email: provider × payer status, effective dates, "do not bill yet" list. Denial notice with reason and reapply date | Monthly summary. New-hire confirmation. Dashboard invite |
| **Backstage (what the customer does not see)** | Create the org (`create_organization`), flip lifecycle to active, create groups | Map the customer file to the three CSV templates; run the header gate; stage and commit; create facilities and assignments; vault the group docs | Enter payer network targets (group × payer × state); verify NPPES and IRS names; send capture and SSN links; chase DOB, SSN, address | Generation run; SOP tasks attached; payer portal forms filled with the internal workbench; submissions logged as touches; status to Submitted | 14-day follow-up per open case; touches logged; status moved with evidence (In Review, Action Required, Approved, Denied); effective dates and payer IDs recorded | Readiness and expiring-credential reports; recredentialing calendar |
| **Support processes** | Supabase (organizations, memberships, status_configs seed); calendar | CSV import engine (header gate, SSN sweep, dedupe and conflict preview); document vault (private bucket); `/capture/$token`; `/ssn-intake/$token` (vault RPCs) | Payer catalog and `payer_network_targets`; footprint rule; readiness evaluator | Generation (`create_case_with_tasks`); SOP templates; portal registry and field maps; payer PDF forms; fill events; touch log | Follow-up reducer; Next Best Action queue; `set_case_status`; Denials report | Cases Matrix; Billing Readiness; Expiring Credentials; Enrollment Explorer (client audience, gated); audit log |
| **Physical evidence** | Welcome email; intake packet (PDF); security one-pager (PDF) | Kickoff deck (PDF); checklist email | "Roster loaded" email with counts | "Submitted" email with reference numbers | Weekly status table; denial email | Dashboard login; monthly PDF summary; new-hire guide |

Where the line of visibility is broken today:

- Stage 1: no intake packet exists. The checklist lives in Sowmya's head and in Granola.
- Stages 2 and 3: no "roster loaded" or "submitted" email is sent. The product sends no email of any kind.
- Stage 4: the weekly email is assembled by hand from the Matrix or a Google Sheet.
- Stage 5: no customer has a login.

## Section 4: Customer effort audit

Counted for a Starter customer (one group, one state, up to 10 providers)
under the Section 3 blueprint. Provider-level actions count once per type,
not once per provider.

| # | Action | Stage | Effort (1 to 3) | Eliminate? | How |
| --- | --- | --- | --- | --- | --- |
| 1 | Sign the agreement | 0 | 1 | No | |
| 2 | Reply with a kickoff slot and the admin + billing contact names | 0 | 1 | Partially | Calendar link in the signature email; contacts collected on the call |
| 3 | Attend the kickoff call | 1 | 2 | No | |
| 4 | Send the provider roster | 1 | 2 | Partially | Any spreadsheet. Require only NPI, legal name, start date, locations; Minted pulls the rest from NPPES and CAQH |
| 5 | Send five group documents (W-9, COI, CMS-460, NPI letter, bank letter) | 1 | 3 | No | One upload link instead of attachments; the capture link already takes files |
| 6 | Hand over portal logins and 2FA ownership (CAQH, PECOS/I&A, Availity, payer portals) | 1 | 3 | No | In the packet; tested on the call; Minted as a delegated user where payers allow |
| 7 | Confirm the payer list by state | 1 | 2 | Partially | Pre-filled from existing contracts and the catalog; customer confirms |
| 8 | Each provider: complete the profile link (DOB, address, licenses, uploads) | 1 | 2 | No | Exists today (`/capture/$token`); send to the provider, not the admin |
| 9 | Each provider: enter SSN through the secure link | 1 | 1 | No | Exists today (`/ssn-intake/$token`) |
| 10 | Each provider: CAQH attestation, state of practice, authorize Minted | 1 | 2 | No | Payer requirement; exact steps in the provider email |
| 11 | Answer data-correction questions (legal name vs DBA, tax ID, suite) | 2 | 1 | Partially | Fewer if NPPES and the IRS letter are checked at intake |
| 12 | Sign applications that need a signature | 3 | 2 | No | Payer requirement; batch into one signing session |
| 13 | Confirm effective dates with billing; release held claims | 4 | 1 | No | Driven by the weekly email |
| 14 | Create a dashboard login | 5 | 1 | Partially | Only once client access ships; today this action does not exist |
| 15 | Notify Minted of a new hire | 5 | 1 | No | Reply email or a form; then 8 to 10 repeat for that provider |

**Count: 15 actions, 13 before go-live. Over the target of 10.** Getting under 10 before go-live:

| Cut | From | To | Mechanism |
| --- | --- | --- | --- |
| Fold 2 into 1 | 13 | 12 | Calendar link and contact fields in the signature email |
| Fold 5, 6, 7 into one intake packet with one upload link | 12 | 10 | Extend the capture link with login and payer-list fields |
| Fold 8 and 9 into one provider email | 10 | 9 | Two routes today, one email |
| Drop 11 by verifying NPPES and IRS at intake | 9 | 8 | Minted-side check before any submission |

Eight before go-live is reachable with no new product work except putting
the two provider links in one email and adding fields to the capture link.
Andros' public benchmark is "about 20 minutes" of provider input; items 8 to
10 should be timed against that in the dry run.

## Section 5: Customer segmentation matrix

| Dimension | Starter (1 to 10 providers, 1 state) | Growth (10 to 50 providers, 2 to 5 states) | Scale (50+ providers, 5+ states) |
| --- | --- | --- | --- |
| Looks like today | KFP's Kansas group; Lionstone | BEST (40 providers; its 9 states are Scale-shaped) | Luna (about 3,000 PTs, about 500 hires per quarter) |
| Kickoff format | 30-min call | 45-min call plus a 30-min billing-contact call | 60-min call, a dedicated implementation lead, weekly standing call for 8 weeks |
| Data collection | Any spreadsheet; Minted maps it; an NPI list is enough to start | Spreadsheet per group plus CAQH access; Minted maps; group docs per tax ID | Bulk CSV per group on the three templates, or one mapped HRIS export reused each hire wave; no API exists |
| Payer network setup | Entered on the kickoff call | Entered from the contract list within 2 days | Per-state waves staged by launch date |
| Target roster to first submission | 5 business days | 10 business days | 15 business days per state wave |
| Provider self-serve links | Sent by Minted | Sent by Minted | Sent in batches from a hire feed the customer supplies |
| Status cadence | Weekly email | Weekly email plus a bi-weekly call | Weekly call plus monthly review; dashboard first |
| Dashboard access | After client access ships | After client access ships; read-only `billing` role for the billing lead | Required before signing; this segment will not accept email-only status |
| Pricing shape (internal note, Jul 28) | $399 per new provider plus $19 per provider per month | Same | Negotiated on volume |
| Risk to watch | Owner-held logins and 2FA | Multi-tax-ID confusion (BEST: wrong tax ID on one entity) | Status staleness at volume; 500 hires a quarter needs automated follow-up, which does not exist |

## Section 6: Competitive benchmark

Detail and URLs: `competitor-onboarding-benchmark-2026-10-17.md`. Two
corrections: no credentialing vendor named Trellis Health exists, and
VerityStream is HealthStream's CredentialStream, not symplr.

| Vendor | Onboarding promise | Public materials | Target segment | Pricing | Minted ahead | Minted behind |
| --- | --- | --- | --- | --- | --- | --- |
| Medallion | No go-live number. Turnaround: "as little as one day", "80% faster". Third party: about one-month setups | API docs, case studies, one-pagers; no kickoff guide | Health systems, payers, enterprise PT (Ivy Rehab, 700+ clinics); "cost-prohibitive" for small practices | Custom; ~$45.6K/yr median (third party) | Roster to first submission 4 to 17 days actual vs about 30 | Named account team, API, CAQH integration, NCQA CVO |
| Modio Health | "Onboarded clients in under 30 days"; six-month PM | Public implementation steps PDF, coordinator start guides | Mid-market groups, MSOs, staffing | Quote; $49 per provider profile | Modio is software only; the customer still does the credentialing | Modio publishes its steps; Minted publishes nothing |
| Andros (now Medallion) | None. Turnaround "under 14 days"; applications need "about 20 minutes" of provider input | None | Health plans, large networks | Custom | Not a competitor for PT groups | Provider-input minimization is the right bar for Section 4 |
| Trellis Health | Not a credentialing vendor | n/a | n/a | n/a | n/a | n/a |
| symplr Provider | No duration; "30 days or less" credentialing; G2: 9 months to implement | Online help, support portal | Hospitals, health systems, payers | Custom | Weeks vs 9 months | Breadth: privileging, contracting |
| HealthStream CredentialStream (ex-VerityStream) | None; "> 3 months" (third party). Capterra: "self guided", "outdated" training, "had to load all manually" | Help center; Groups edition with a 30-day trial | Hospitals; a Groups edition for practices | Custom | Minted loads the data; the customer never touches a template | A trial-able product |

What this means for the deck: the only credible public speed numbers are
Modio's "under 30 days" to a working system and Medallion's file turnaround.
A measured "first application submitted within 5 business days of a complete
roster" beats both and is backed by KFP (4 days). Nobody publishes a
billing-ready number. Minted should not either until there are 20+ decisions.

## Section 7: Collateral derivation

Rules applied: no customer-facing item mentions the Chrome extension or the
internal workbench. The brief's banned phrases do not appear; Section 4's
count stands in for them. Every timeline is Section 1 actual or labeled target.

### Track 1: Sales deck, "What happens after you sign?" (6 slides)

One claim to land: **"Your first payer application goes out within 5 business
days of a complete roster. We measure it."** Draws on Section 1 (KFP 4 days;
BEST 17 including product build), Section 4 (8 to 9 customer actions),
Section 6 (Modio 30 days).

| # | Slide | Content | Draws on |
| --- | --- | --- | --- |
| 1 | The number | 5 business days, roster to first submission. Footnote: measured on live customers; payer decisions follow in 2 to 13 weeks, payer dependent | S1 |
| 2 | What you do (8 things) | Section 4 after cuts, as a checklist with a time estimate per item | S4 |
| 3 | What we do | The backstage lane in plain words: load, verify, enroll, follow up every 14 days, report weekly | S3 |
| 4 | What you see | Weekly status table mockup. Dashboard screenshot only if client access is live when the deck is used | S3 |
| 5 | How long payers take | Observed: Medicare 12 to 25 days, Aetna 10. Quoted: Aetna and Cigna 30 to 90, UHC about 30, Colorado commercial contracting about 8 months. Ranges, not promises | S1; raw 3c |
| 6 | What it costs to wait | Anonymized BEST Colorado: $97 billed out-of-network vs a $40 copay while providers were pending | raw 2c |

### Track 2: Implementation

**Kickoff deck (9 slides).** Claim: "Here is exactly what we need from you,
and what you will hear from us each week."

| # | Slide | Content |
| --- | --- | --- |
| 1 | Your team and ours | Names, roles, the one email address for everything |
| 2 | Timeline | Section 1 target row with this customer's dates filled in |
| 3 | What we already have | Items received before the call, from the packet |
| 4 | What is still missing | Live checklist; owner and date per item |
| 5 | Portal access | The logins and 2FA ownership we need and why; tested on the call |
| 6 | Your providers' homework | The provider email, the two links, the CAQH steps |
| 7 | Payers and states | The group × payer × state grid, confirmed live |
| 8 | How status reaches you | Weekly email sample; status definitions card; the "do not bill yet" rule |
| 9 | Next 5 business days | Who does what, by date |

**Pre-kickoff homework packet (2 pages).** Page 1: the five group documents;
a portal table (portal, username, who holds 2FA); the payer list by state.
Page 2: provider roster minimums (NPI, legal name, start date, locations) and
a note that each provider will receive their own links for DOB, SSN, licenses
and uploads. Draws on Section 2 rows 1, 2, 4.

**CSV roster template and instructions (1 page).** Lead with "send us what you
have." The product's provider template (32 columns, one row per license ×
location × enrollment) is offered only to customers who want to self-serve.
Required for a first submission: `group_name` or `group_tin`,
`provider_first_name`, `provider_last_name`, `npi`, `start_date`,
`facility_name`, `license_state`, `license_number`,
`license_expiration_date`. Everything else is optional and Minted fills it.
Multi-values use `;`; dates are ISO. Never put a full SSN in the file:
`ssn_last4` only, and the uploader redacts anything SSN-shaped. Draws on
`src/lib/importSections.ts`.

**Security and PII one-pager.** Facts verifiable in the repo: hosted on
Supabase (Postgres, us-east-2); private storage buckets with path-validated
access; row-level tenant isolation per organization; three roles with a
read-only role for billing staff; full SSN stored only in an encrypted vault
reachable by three audited functions; every ordinary read returns the last
four only; SSN entered by the provider through a one-time link that never
echoes the value; append-only audit log; profile reads audited; PHI never
logged. Public privacy policy at `/privacy`. Not claimed: SOC 2, a HIPAA
attestation, or a BAA template. None were found; confirm before use.

**Dashboard quick-start guide.** Write it for the read-only `billing` role,
because that is what a customer will get. Pages: Cases (list and Matrix; one
cell is one provider × payer in one state), Providers (readiness chips),
Reporting Center (Billing Readiness, Denials, Expiring Credentials). Say
plainly that there are no email notifications and status appears on refresh.
Hold this guide until client access is live; today it would describe a page
nobody can open.

**Status definitions reference card.** Eight statuses, one line each.

| Status | Means | Who acts |
| --- | --- | --- |
| Not Started | The case exists; no work recorded | Minted |
| In Progress | Application being prepared | Minted, or the provider if CAQH is pending |
| Submitted | Sent to the payer; reference number recorded when the payer gives one | Payer |
| In Review | Payer confirmed receipt and is processing | Payer |
| Action Required | Payer asked for something | Minted or the provider, named in the note |
| Approved | Approved; effective date recorded; bill from that date | Customer billing |
| Denied | Denied; reason recorded; reapply date set | Minted |
| Not Pursuing | Closed on purpose (payer not needed in that state) | Nobody |

Footnote the seven location statuses the dashboard uses (Prospect, Planned,
Interviewing, Pending Fulfillment, Ready for Launch, Live, Inactive).

**Mid-cycle new hire guide (1 page).** Today: email the credentialing inbox
with name, NPI, start date, and location(s). Minted adds the provider, sends
the provider their links, generates a case for every payer in the group's
network for that state, and the hire appears in the next weekly email. Same
5-business-day target to first submission. The hire should not see patients
under the group's commercial contracts until the weekly email shows Approved
with an effective date, except where the customer's billing team already
bills under a supervising provider.

## Section 8: Validation criteria

- [ ] **Dry run.** Sowmya plays customer admin through Stages 0 to 4 on
      staging with a throwaway org, using only the packet and the deck.
      Record every point where she needs knowledge that is not in the
      collateral.
- [ ] **Effort count.** Tally the actions she actually took. Pass: 9 or fewer
      before go-live. Fail: anything that required knowing the product.
- [ ] **CSV gate test.** Push one customer-shaped spreadsheet (BEST's real
      structure, anonymized) through Minted-side mapping. Pass: commits on
      the first try. This closes the 3-of-3 failure.
- [ ] **TTV check.** The deck says 5 business days. Measure org-created to
      first-submission on the next real customer. Pass: 5 or under. If it
      misses, the slide changes, not the measurement.
- [ ] **Status honesty check.** For every open case older than 14 days,
      confirm a touch in the last 14 days. Pass: 90%. Today it is far below.
      Without this the weekly email and the dashboard both lie.
- [ ] **Prospect test.** Walk one warm lead through the Track 1 deck. Capture
      every question not answered on a slide. Three or more on one topic
      means a new slide.
- [ ] **Competitor sanity check.** 5 business days to first submission is
      faster than Modio (under 30 days to go live) and Medallion (about 1
      month setups). Pass. The billing-ready number is deliberately not
      claimed; revisit at 20 decisions.
- [ ] **Access check.** A `billing`-role user can open Cases, Matrix,
      Providers, Reporting and nothing else, and cannot see another org.
      Required before the quick-start ships.

## Open questions (answer before any of this reaches a prospect)

1. **What is "South Park Physician Group"?** (a) a prospect not yet in the
   system; (b) another name for BEST or Lionstone; (c) a customer tracked
   outside Minted Panel. The waterfall used BEST.
2. **Should time-to-value include credentialing done before Minted Panel?**
   KFP's June Medicare approvals are not in the product. (a) product data
   only, as done here; (b) reconstruct from Granola and email; (c) start the
   clock on the next customer and drop history.
3. **When does client access (E6.12) go live?** (a) before the next signing,
   so the deck can show the dashboard; (b) after, so the deck promises weekly
   email only; (c) unknown. The deck and the quick-start depend on this.
4. **Is the CSV uploader ever customer-facing?** (a) never, Minted maps every
   file (recommended, given 3 of 3 failures); (b) Scale customers only; (c)
   everyone, with the template.
5. **Pricing in the deck?** (a) none, per the Aug 21 decision; (b) the $399
   plus $19 per month shape; (c) a range.
