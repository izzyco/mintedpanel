# Competitor onboarding benchmark (web research, 2026-10-17)

How five named vendors position onboarding and implementation in public.
Method: indexed search snippets and the cited pages; the sandbox proxy blocked
direct fetches of vendor sites and review sites, so spot-check any quote
against the live page before it goes into customer-facing material. No demo
or trial was signed up for. Third-party aggregators (rfp.wiki, fitgap,
withassured) are labeled as such.

Two corrections to the brief:

- **No credentialing vendor named Trellis Health exists.** The name belongs to
  a Seattle pregnancy-records app, a MaineHealth primary-care practice, and a
  prior-authorization startup (Trellis AI). Not benchmarked.
- **VerityStream is not symplr.** VerityStream was HealthStream's brand and is
  now HealthStream CredentialStream. symplr's product is symplr Provider
  (formerly Cactus). Both are covered below.

## 1. Medallion (medallion.co)

Context: acquired Andros on 2026-09-15; raised $43M in 2025; launched the
CredAlliance payer clearinghouse.

| Claim | Number or quote | Source |
| --- | --- | --- |
| Turnaround | "committee-ready files in as little as one day"; "cut credentialing time by 80%"; "3.5 times faster than legacy CVOs"; "99.5% file accuracy" | https://medallion.co/why-medallion/medallion-vs-other-cvos |
| Payer SLA | "median SLA of 0.8 turnaround days"; start with "only 5 pieces of provider data" via API or CAQH | https://medallion.co/products/credentialing-for-payers |
| One-pager | about 3 days from completed provider profile to ready file | https://try.medallion.co/hubfs/Marketing%20%2B%20Sales%20Content%20Library/Product%20Overviews/New%20-%201-pagers/Medallion_CVOCredentialing.pdf |
| Case study | SMIL: "15 days down to just 3"; staff time on enrollments down 50% | https://medallion.co/resources/case-studies/southwest-medical-imaging-smil |
| Case study | Tampa General: "30 days down to three"; previously "160+ days" to enroll | https://hospitalogy.com/articles/2024-05-22/medallion-delegated-credentialing-tampa-general/ |
| Case study (PT) | Ivy Rehab: "700+ clinics", "0" added headcount; no cycle-time number | https://medallion.co/resources/case-studies/ivy-rehab |
| Implementation duration | "roughly one-month typical setups, though some rollouts feel clunky" (third party citing G2) | https://www.rfp.wiki/vendors/medallion |
| Account team | "Client Executive, an Engagement Manager, a Customer Success Manager (CSM), and Product Managers" | https://hospitalogy.com/articles/2024-08-28/medallion-credentialing-partners-long-term/ |
| Materials | Public API reference and changelog; roster templates by "encrypted email or SFTP"; no help center or kickoff guide found | https://docs.medallion.co/ |
| Pricing | Not public. Vendr median "$45,600" per year (third party); year-one adds implementation, migration, CAQH/API integration | https://www.rfp.wiki/specialty-industries/healthcare-life-sciences/healthcare/healthcare-provider-network-management-software/medallion/assured |
| Complaint | "roughly two years without being contracted" (G2, 13 reviews, 3.8) | https://g2.com/products/medallion/reviews |
| Complaint | "initial rollout was a bit clunky" (Capterra, 9 reviews, 4.7) | https://capterra.com/p/250098/Medallion/reviews/ |
| Segment | Health systems, payers, digital health, provider groups, RCM; "cost-prohibitive for smaller medical practices" (third party) | https://us.fitgap.com/products/medallion |

## 2. Modio Health (OneView)

The most transparent of the five about implementation.

| Claim | Number or quote | Source |
| --- | --- | --- |
| Go-live | "onboarded clients to OneView in under 30 days" | https://www.modiohealth.com/life/?p=5806 |
| Go-live (relayed) | "rapid access to OneView within 30 days", about four weeks of training, "dedicated project manager ... for six months" | https://www.rfp.wiki/vendors/modio-health |
| Steps | discovery call, data import, profile completion, team creation, tracking configuration, team transition, training, form mapping, go-live; "data import is limited by the quality of data provided by Customer"; "$49.00 per provider" to complete a profile from CV/CAQH; flat-rate implementation "for up to 1,100 providers" incl. "three days of an onsite Modio FTE" | https://www.modiohealth.com/life/wp-content/uploads/Implementation-Onboarding-Steps.pdf |
| Process | dedicated data project managers, post-import "profile readiness assessment", handoff to an account manager, quarterly meetings | https://www.modiohealth.com/life/modio-press/take-a-deep-dive-into-modios-award-winning-client-service-with-claire-forgan-director-of-the-project-management-office |
| Materials | Coordinator Start Guide (May 2025); Provider Onboarding for Coordinators (May 2025); Data Export guide (July 2025). No public CSV template; providers added by NPI lookup | https://www.modiohealth.com/life/wp-content/uploads/Tip-Guide-OneView-Coordinator-Start-Guide-May-2025.pdf |
| Differentiators | auto-pull from NPPES, OIG, SAM, LexisNexis; KLAS-rated five years; "nearly 1,000 healthcare organizations"; free provider record | https://oneview-blog.prod.modiohealth.com/?p=5667 |
| Pricing | quote-based after discovery; no per-provider ranges beyond the $49 add-on | https://www.rfp.wiki/vendors/modio-health |
| Reviews | Capterra 4.9 / 29 reviews, "0% negative"; GetApp: "answered any questions I had during the implementation process" | https://www.capterra.com/p/158338/Modio-Health/ |
| Complaint (aggregated) | "support responsiveness ... recurring complaint"; "lack of a public API"; verifications need manual initiation | https://www.rfp.wiki/specialty-industries/healthcare-life-sciences/healthcare/healthcare-provider-data-management-software/modio-health/md-staff |
| Segment | hospitals, groups, MSOs, staffing; mid-market and ambulatory; no PT marketing; only named case study is an RCM firm (~200 providers) | https://oneview-blog.prod.modiohealth.com/?p=5398 |

Note: Modio is software the customer operates. It does not do the
credentialing work, so its "30 days" is to a usable system, not to a
submitted application.

## 3. Andros (formerly CredSimple; now part of Medallion)

| Claim | Number or quote | Source |
| --- | --- | --- |
| Corporate | acquired 2026-09-15; about 300,000 files per year; 11 of 11 NCQA standards; enterprise customers transition to Medallion | https://hitconsultant.net/2026/09/15/ma-medallion-acquires-andros-to-unify-one-million-providers-onto-an-ai-native-credentialing-platform/ |
| Scale | "200 provider networks across all 50 states"; health plans, health systems, provider groups, telehealth since 2013 | https://www.insurancebusinessmag.com/us/news/benefits/ai-credentialing-deal-targets-provider-network-gaps-at-scale-589948.aspx |
| Turnaround | "often under 14 days"; "10x faster than industry average" (competitor roundup) | https://www.withassured.com/blog/8-best-ncqa-certified-cvos-for-credentialing |
| Provider effort | two of three application processes "require no provider input and take about 20 minutes"; staff contact providers "at least three times" on discrepancies | https://www.unite.ai/nl/medallion-buys-credentials-verification-organization-andros/ |
| Implementation | "sales-scoped rather than catalogued"; API docs "require sales diligence" | https://www.rfp.wiki/vendors/andros |
| Materials | one delegated-credentialing webinar; nothing else public | https://resources.industrydive.com/delegated-credentialing |
| Pricing | "custom pricing ... only available upon request" | https://www.withassured.com/alternative/andros |
| Reviews | listings exist with no visible review text | https://www.trustradius.com/products/andros/reviews |
| Post-deal caveat | NCQA credit "follows the certified entity" | https://www.beri.net/article/medallion-andros-acquisition-ncqa-cvo-certification-delegated-credentialing-automatic-credit |

## 4. Trellis Health

Not a credentialing vendor. Entities found: Trellis Health (Seattle,
pregnancy and postpartum app, $1.8M pre-seed, 2025), Trellis Health
(Portland ME, MaineHealth membership primary care), Trellis AI (prior auth
and intake automation). If the intended company goes by another name, rerun
with its domain.

Sources: https://www.geekwire.com/2025/seattle-startup-trellis-health-launches-to-help-women-navigate-pregnancy-and-postpartum-care/ ; https://runtrellis.com/

## 5. symplr Provider (ex-Cactus), with HealthStream CredentialStream (ex-VerityStream)

| Claim | Number or quote | Source |
| --- | --- | --- |
| symplr turnaround | "20% reduction in credentialing timelines" (customer-reported); "50%" fewer committee meetings | https://www.symplr.com/products/symplr-provider |
| symplr target | "30 days or less"; "400+ CVO specialists" | https://www.symplr.com/products/symplr-credentialing-suite |
| symplr CVO | "+7 million applications successfully processed each year"; "reduce turnaround time by up to 75%" | https://www.symplr.com/cvo |
| symplr testimonial | "in just 11 weeks ... over $2 million in backlogged billings submitted to payers" | https://discover.symplr.com/cvo-services/ |
| symplr implementation | G2 average time to implement: 9 months; review titled "Decent product, poor onboarding and customer support experience" | https://www.g2.com/products/symplr-provider/reviews |
| symplr implementation (competitor claim) | "9-18 months" | https://certifyos.com/lp/symplr-alternative |
| symplr materials | online help, User Assistance Center, customer community portal; no implementation guide or templates | https://help.symplr.com/ |
| symplr complaint | "since CACTUS merged with symplr, Customer Service has declined" (GetApp 3.6 / 117 reviews) | https://www.getapp.co.uk/reviews/119239/symplr |
| symplr pricing | custom quote; "cost-prohibitive for smaller medical groups" (third party) | https://us.fitgap.com/products/symplr-provider |
| VerityStream identity | "VerityStream is HealthStream Credentialing" | https://www.healthstream.com/solution/credentialing/veritystream |
| VerityStream complaints | "We were not aware that the agreement we had was self guided. The training video's were outdated"; "It felt like boxes to check off"; "found out I had to load all manually" | https://www.capterra.com/p/172448/Verity/reviews/ |
| VerityStream duration | "> 3 months" (third party); a "for Groups" edition with a "free 30-day trial" | https://intuitionlabs.ai/software/human-resources-talent-management/credentialing-and-privileging/healthstream-credentialstream |
| VerityStream migration example | UVA Health moved symplr to CredentialStream, live Dec 5 2025, privileging winter 2026 | https://news.med.virginia.edu/?p=52038 |

## Comparison

| Vendor | Onboarding promise | Public materials | Target segment | Pricing | Notable complaint |
| --- | --- | --- | --- | --- | --- |
| Medallion | No go-live number; turnaround claims ("as little as one day"); about 1 month setups (third party) | API docs, case studies, one-pagers | Health systems, payers, enterprise PT | Custom; ~$45.6K/yr median (third party) | "roughly two years without being contracted" |
| Modio Health | "under 30 days" to go live; 6-month PM | Public implementation steps PDF, coordinator guides | Mid-market groups, MSOs, staffing | Quote; $49/provider profile add-on | Support responsiveness (aggregated) |
| Andros | None; turnaround only ("under 14 days") | None | Health plans, large networks | Custom | None found |
| Trellis Health | not a credentialing vendor | n/a | n/a | n/a | n/a |
| symplr Provider | No duration; "30 days or less" credentialing target; 9 months to implement (G2) | Online help, support portal | Hospitals, health systems, payers | Custom | "poor onboarding and customer support experience" |
| HealthStream CredentialStream | None; "> 3 months" (third party) | Help center; Groups edition trial | Hospitals; a Groups edition | Custom | "self guided", "outdated" training, manual loading |

## What this means for Minted Panel

- Nobody publishes a "billing-ready in X days" number. The closest public
  speed claims are Modio's "under 30 days" to a working system and Medallion's
  file-turnaround times.
- A measured "first application submitted within 5 business days of a complete
  roster" is faster than every public claim and is backed by KFP (4 days).
- The strongest recurring complaint across vendors is onboarding that turns
  out to be self-guided with manual data loading. Minted's model (we load it)
  is the direct answer, and the Section 4 effort count is the proof.
- Modio publishes its implementation steps. Minted publishes nothing. The
  kickoff deck and homework packet close that gap.
