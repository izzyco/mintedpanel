// The closed registry of emails Minted Panel sends. A caller names a template
// and supplies its typed data; it can never pass a free-form subject or body.
// sendgrid.ts consumes only the rendered { subject, text, html }, so moving
// the wording out of git later changes this file and nothing else.
//
// A type-only import is erased before Node runs the email CLI, so it keeps
// this module's relative-`.ts`-only rule.
import type {
  FollowUpDigestEmailData,
  FollowUpDigestRow,
  FollowUpDigestSection,
} from "../../lib/followUpDigest.ts";

export interface TemplateDataMap {
  test: { practiceName: string };
  provider_invitation: { practiceName: string; firstName: string; link: string };
  intake_code: { practiceName: string; code: string };
  // To her after Submit. Nothing she sent is echoed back.
  intake_submitted: { practiceName: string; firstName: string };
  // To ONBOARDING_OPS_EMAIL when she submits or asks for help: the practice
  // and a link to the record, never her name or anything she entered.
  onboarding_ops_alert: { practiceName: string; kind: "submitted" | "help"; link: string };
  // MINT-108: the coordinator follow-up digest (daily, weekly or twice a
  // day; the key keeps its first name). The key is the
  // catalog's (src/lib/notificationTemplates.ts); the data is built by
  // planFollowUpDigests (src/lib/followUpDigest.ts).
  followup_digest_daily: FollowUpDigestEmailData;
}

// Canvas board 2. The canvas's reassurance line is placeholder copy (Q3), so
// it is left out rather than sent to a real inbox. So are the help links and
// the postal address: nothing exists yet for them to point at or read from.
const HAVE_READY = [
  "Your NPI",
  "Your state license number and expiration date",
  "Your CAQH ID",
  "Your CAQH ProView login (username and password)",
  "Your PECOS login (username and password)",
  "Your mobile number and home address",
  "Your CV and a copy of your state license",
];

export type TemplateKey = keyof TemplateDataMap;

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

// Names inside the text/plain part: one line, no control characters.
/* eslint-disable no-control-regex */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
/* eslint-enable no-control-regex */

function plainInline(value: string): string {
  return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Oct 31, 2026" (the app's fmtDate spelling) for a YYYY-MM-DD date, read as a
// calendar date so no time zone can move it. Anything else comes back as it
// was, HTML-escaped, so the result is safe in either part.
function formatDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const month = MONTHS[m - 1];
  return month && Number.isInteger(y) && Number.isInteger(d)
    ? `${month} ${d}, ${y}`
    : escapeHtml(iso);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function sectionSummary(section: FollowUpDigestSection): string {
  return `${section.overdue} overdue, ${section.dueToday} due today`;
}

// The status alone. An at-risk line ("submitted N days ago") waits for
// MINT-111, which gives payers a decision time from their closed cases.
function statusLabel(row: FollowUpDigestRow): string {
  return row.status === "overdue" ? "Overdue" : "Due today";
}

function rowText(row: FollowUpDigestRow): string {
  const parts = [
    `C-${row.caseNumber}`,
    plainInline(row.providerName),
    plainInline(row.payerName),
    `due ${formatDay(row.dueDate)}`,
    statusLabel(row),
  ];
  return `- ${parts.join(" · ")}\n  ${row.caseLink}`;
}

function rowHtml(row: FollowUpDigestRow): string {
  return [
    "<tr>",
    `<td><a href="${escapeHtml(row.caseLink)}">C-${row.caseNumber}</a></td>`,
    `<td>${escapeHtml(row.providerName)}</td>`,
    `<td>${escapeHtml(row.payerName)}</td>`,
    `<td>${formatDay(row.dueDate)}</td>`,
    `<td>${statusLabel(row)}</td>`,
    "</tr>",
  ].join("");
}

const ROW_HEADER =
  '<tr><th align="left">Case</th><th align="left">Provider</th><th align="left">Payer</th><th align="left">Follow-up due</th><th align="left">Status</th></tr>';

function moreLine(section: FollowUpDigestSection): string | null {
  return section.more > 0
    ? `And ${plural(section.more, "more follow-up", "more follow-ups")} in Work.`
    : null;
}

// One coordinator's own follow-ups (MINT-108). Nobody else gets a copy: the
// digest has no cc list, and unassigned follow-ups go to no one.
function followUpDigest(data: FollowUpDigestEmailData): RenderedEmail {
  const day = formatDay(data.digestDate);
  const section = data.followUps;
  const more = moreLine(section);
  const name = data.recipientFirstName;
  const practice = data.practiceName.trim();
  // `day` is already HTML-safe (formatDay), so the intro is not escaped again.
  const intro = `Here are your follow-ups due on ${day}, and the ones that are overdue.`;
  // Minted turns the digest on (A9), and it may be daily, weekly or twice a
  // day (A8), so the footer names neither the org nor a frequency.
  const footer =
    "You get this email because Minted turned on follow-up digests for your organization.";
  return {
    subject: `Your follow-ups for ${day}: ${sectionSummary(section)}`,
    text: [
      name ? `Hi ${plainInline(name)},` : "Hi,",
      intro,
      [
        `YOUR FOLLOW-UPS (${sectionSummary(section)})`,
        ...section.rows.map(rowText),
        ...(more ? [more] : []),
      ].join("\n"),
      `Open Work: ${data.workQueueLink}`,
      footer,
      ...(practice ? [`${plainInline(practice)} via Minted Panel`] : []),
    ].join("\n\n"),
    html: [
      `<p>${name ? `Hi ${escapeHtml(name)},` : "Hi,"}</p>`,
      `<p>${intro}</p>`,
      "<h3>Your follow-ups</h3>",
      `<p>${escapeHtml(sectionSummary(section))}.</p>`,
      `<table cellpadding="4" cellspacing="0">${ROW_HEADER}${section.rows.map(rowHtml).join("")}</table>`,
      ...(more ? [`<p>${escapeHtml(more)}</p>`] : []),
      `<p><a href="${escapeHtml(data.workQueueLink)}">Open Work</a></p>`,
      `<p>${escapeHtml(footer)}</p>`,
      ...(practice ? [`<p>${escapeHtml(practice)} via Minted Panel</p>`] : []),
    ].join(""),
  };
}

// The letter in the header badge. emailShell escapes it. The first letter or
// digit, so "(Shelby) Rehab" and an emoji-led name still get one; "M" (Minted)
// when the name has none, which includes the blank name the routes can pass.
export function practiceInitial(practiceName: string): string {
  const first = practiceName.match(/[\p{L}\p{N}]/u);
  return first ? first[0].toUpperCase() : "M";
}

function sentOnBehalf(practiceName: string): string {
  return `Sent by Minted Panel on behalf of ${practiceName}`;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';
const GAP = "margin:14px 0 0;";
const MUTED = "font-size:13px;color:#6B7280;";

// The canvas card in markup mail clients keep: tables and inline styles only.
// Gmail drops <style> and SVG, so the shield mark becomes the practice's
// initial; Outlook ignores padding on a link, so a button is a filled cell.
function emailShell(practiceName: string, body: string): string {
  return (
    `<table ${TABLE} width="100%" bgcolor="#F3F4F6" style="background:#F3F4F6;"><tr><td align="center" style="padding:16px 12px;">` +
    `<table ${TABLE} width="100%" style="max-width:600px;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:8px;"><tr>` +
    `<td style="padding:22px 20px;font-family:${FONT};font-size:14px;line-height:1.55;color:#1F2937;">` +
    `<table ${TABLE} width="100%" style="border-bottom:1px solid #F0EEEA;"><tr><td style="padding-bottom:12px;"><table ${TABLE}><tr>` +
    `<td width="24" height="24" align="center" valign="middle" bgcolor="#1B4D3E" style="width:24px;height:24px;border-radius:6px;background:#1B4D3E;color:#FFFFFF;font-size:13px;font-weight:600;line-height:24px;">${escapeHtml(practiceInitial(practiceName))}</td>` +
    `<td style="padding-left:8px;font-size:13px;font-weight:600;color:#1F2937;">${escapeHtml(practiceName)}</td>` +
    `</tr></table></td></tr></table>` +
    body +
    `</td></tr></table>` +
    `<p style="margin:0;padding:14px 8px 0;font-family:${FONT};font-size:11px;line-height:1.5;color:#4B5563;text-align:center;">${escapeHtml(sentOnBehalf(practiceName))}</p>` +
    `</td></tr></table>`
  );
}

export const TEMPLATES: { [K in TemplateKey]: (data: TemplateDataMap[K]) => RenderedEmail } = {
  test: ({ practiceName }) => ({
    subject: `Test email from ${practiceName}`,
    text: `This is a test email from ${plainInline(practiceName)} via Minted Panel.\n\nIf you received it, sending works.`,
    html: `<p>This is a test email from <strong>${escapeHtml(practiceName)}</strong> via Minted Panel.</p><p>If you received it, sending works.</p>`,
  }),
  provider_invitation: ({ practiceName, firstName, link }) => {
    const intro =
      "Welcome aboard. Before you can see patients under our payer contracts, we need your credentialing details. You can do it in one sitting, or save and finish later.";
    const codeLine = "We'll send a 6-digit code to this address after you tap the button.";
    return {
      subject: `Welcome to ${practiceName}: your credentialing form`,
      text: [
        `Hi ${plainInline(firstName)},`,
        intro,
        "Make sure you have these on hand before you start:",
        HAVE_READY.map((item) => `- ${item}`).join("\n"),
        `Get started: ${link}`,
        codeLine,
        "Questions? Just reply to this email.",
        `Thanks,\n${plainInline(practiceName)}`,
        sentOnBehalf(plainInline(practiceName)),
      ].join("\n\n"),
      html: emailShell(
        practiceName,
        [
          `<p style="${GAP}">Hi ${escapeHtml(firstName)},</p>`,
          `<p style="${GAP}">${intro}</p>`,
          `<p style="${GAP}">Make sure you have these on hand before you start:</p>`,
          `<ul style="${GAP}padding-left:20px;">${HAVE_READY.map((item) => `<li style="margin:0 0 4px;">${item}</li>`).join("")}</ul>`,
          `<table ${TABLE} width="100%" style="margin-top:14px;"><tr><td align="center" bgcolor="#1B4D3E" style="border-radius:6px;background:#1B4D3E;">` +
            `<a href="${escapeHtml(link)}" style="display:block;padding:13px 16px;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;">Get started</a>` +
            `</td></tr></table>`,
          `<p style="${GAP}${MUTED}">${codeLine}</p>`,
          `<table ${TABLE} width="100%" style="margin-top:14px;border-top:1px solid #F0EEEA;"><tr><td style="padding-top:12px;${MUTED}">Questions? Just reply to this email.</td></tr></table>`,
          `<p style="${GAP}">Thanks,<br>${escapeHtml(practiceName)}</p>`,
        ].join(""),
      ),
    };
  },
  intake_code: ({ practiceName, code }) => ({
    // The code stays out of the subject, so lock-screen previews don't show it.
    subject: `Your sign-in code for ${practiceName}`,
    text: `Your code is ${code}. It expires in 10 minutes.\n\nIf you didn't ask for a code, you can ignore this email.\n\n${sentOnBehalf(plainInline(practiceName))}`,
    html: emailShell(
      practiceName,
      [
        `<p style="${GAP}">Your code is:</p>`,
        `<table ${TABLE} width="100%" style="margin-top:10px;"><tr><td align="center" bgcolor="#F3F4F6" style="border-radius:6px;background:#F3F4F6;padding:14px 16px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:28px;font-weight:600;letter-spacing:6px;color:#1F2937;">${escapeHtml(code)}</td></tr></table>`,
        `<p style="${GAP}">It expires in 10 minutes.</p>`,
        `<p style="${GAP}${MUTED}">If you didn't ask for a code, you can ignore this email.</p>`,
      ].join(""),
    ),
  }),
  intake_submitted: ({ practiceName, firstName }) => {
    const thanks = "Thank you for sending your credentialing details.";
    const next = `${practiceName} has them and will be in touch if anything else is needed.`;
    const changed = `If something has changed, contact ${practiceName}.`;
    return {
      subject: `${practiceName} has your credentialing details`,
      text: [
        `Hi ${plainInline(firstName)},`,
        `${thanks} ${plainInline(next)}`,
        plainInline(changed),
        sentOnBehalf(plainInline(practiceName)),
      ].join("\n\n"),
      html: emailShell(
        practiceName,
        [
          `<p style="${GAP}">Hi ${escapeHtml(firstName)},</p>`,
          `<p style="${GAP}">${thanks} ${escapeHtml(next)}</p>`,
          `<p style="${GAP}${MUTED}">${escapeHtml(changed)}</p>`,
        ].join(""),
      ),
    };
  },
  onboarding_ops_alert: ({ practiceName, kind, link }) => {
    const what =
      kind === "submitted"
        ? "submitted the onboarding form"
        : "asked for help with the onboarding form";
    const line = `A provider at ${practiceName} ${what}.`;
    return {
      subject:
        kind === "submitted"
          ? `Onboarding form submitted at ${practiceName}`
          : `Onboarding help requested at ${practiceName}`,
      text: `${plainInline(line)}\n\nOpen the provider record: ${link}`,
      html: `<p>${escapeHtml(line)}</p><p><a href="${escapeHtml(link)}">Open the provider record</a></p>`,
    };
  },
  followup_digest_daily: followUpDigest,
};
