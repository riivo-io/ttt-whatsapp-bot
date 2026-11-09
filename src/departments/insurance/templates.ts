// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/templates.ts (commit 2621603). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5176 (TTTFG-5254 steps 5, 6 and 16): the fixed messages Tina sends after the claim acknowledgement. Code text
// filled with CRM data; Claude writes none of it.
//
// Why fixed: "helpful" generated wording for a deadline drifts into "your claim might be rejected if you wait", which
// TTT's claims guide and TCF forbid, and the duty of disclosure must be TTT's neutral wording, not Tina's. The
// claim-risk rule in gate.ts is the backstop; these texts must pass it too (the tests check that).
//
// DRAFT WORDING, like FNOL_TEMPLATE in claim.ts: riivo drafts it and the Insurance and Advice department approves it
// (decision D11, 12 October 2026; the story wins over TTTFG-5254 step 16, which still names TTT's FAIS reviewer). The
// approved text replaces each one with a new version before go-live. The deadline note never says the claim is at
// risk, late or may be rejected: it states the insurer's period and the date, nothing more.

import { AI_HANDLING_LINE } from './claim';

export const longDate = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00+02:00`).toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'long', year: 'numeric' });

export interface DeadlineVars {
  insurer: string;
  periodDays: number;
  /** The deadline as a calendar date in South Africa, YYYY-MM-DD. */
  deadline: string;
}

/** 7 or fewer days left (the claims.notificationWarningDays setting). */
export const DEADLINE_UPCOMING_TEMPLATE = {
  name: 'Claim - notification deadline (Upcoming)',
  version: 'draft-1',
  approved: false,
  render: (v: DeadlineVars) =>
    `${v.insurer} asks for claims to be reported within ${v.periodDays} days of the incident, so by ${longDate(v.deadline)}. ` +
    "We've logged your claim today.",
} as const;

/**
 * The deadline is behind us. Says when it was and that the broker takes it from here; never what that means for cover.
 * draft-2 (28 Oct 2026): "your broker", never their name.
 */
export const DEADLINE_PASSED_TEMPLATE = {
  name: 'Claim - notification deadline (Passed)',
  version: 'draft-2',
  approved: false,
  render: (v: DeadlineVars) =>
    `${v.insurer} asks for claims to be reported within ${v.periodDays} days of the incident. ` +
    `For this incident, that date was ${longDate(v.deadline)}. Your broker will take it from here.`,
} as const;

/**
 * Sent word for word before the first form question (see the open question on the order in the report). draft-2
 * (TTTFG-4830, 28 Oct 2026): shorter, the ask in bold; the first questions follow in the same message.
 */
export const DISCLOSURE_TEMPLATE = {
  name: 'Claim - duty of disclosure',
  version: 'draft-2',
  approved: false,
  render: () =>
    "*Please give the insurer all the facts that matter, honestly and in full.* If you're not sure whether something matters, tell me anyway.",
} as const;

/**
 * TTTFG-5562: what opens the guided form, quick to get through: the duty of disclosure that Tina doesn't send on
 * WhatsApp when she sends the form. Fixed text for the same reason as the rest of this file. Saved under the duty of
 * disclosure's name, so a client who moves to chat later isn't told it again.
 * form-draft-2 (the user, 9 Nov 2026): the duty of disclosure and how to stop and come back, nothing else, and Begin.
 */
export const FORM_TERMS = {
  name: DISCLOSURE_TEMPLATE.name,
  version: 'form-draft-2',
  title: 'Before you start',
  lines: [
    "Please give the insurer all the facts that matter, honestly and in full. If you're not sure whether something matters, tell us anyway.",
    "If you don't know something, just leave it blank. You can stop and come back with the same link.",
  ],
  agree: 'Begin',
} as const;

export type ClaimTemplate = typeof DEADLINE_UPCOMING_TEMPLATE | typeof DEADLINE_PASSED_TEMPLATE | typeof DISCLOSURE_TEMPLATE;

/**
 * TTTFG-4830 (still need): "it" or "them" for a list's lines: "them" for several, or for one whose main word is a
 * plural ("Photos of the damage", "Quotes"); "it" for "Vehicle registration number".
 */
export function itOrThem(lines: readonly string[]): 'it' | 'them' {
  if (lines.length !== 1) return 'them';
  const head = lines[0].split(/ (?:of|you|the|for|that|where|to) /)[0].trim().split(/\s+/).at(-1) ?? '';
  return /[^s]s$/i.test(head) ? 'them' : 'it';
}

export interface ReminderVars {
  firstName: string;
  /** "motor theft claim (CLM-000301)". */
  claim: string;
  /** The list's lines (followon.ts stillNeedLines). */
  lines: readonly string[];
  /** Some of it is questions Tina asks one by one (a claim the client left half way), not things to send. */
  questionsLeft?: boolean;
}

export interface ReminderTemplateVars {
  firstName: string;
  claim: string;
  /** The same items in one line (stillNeedNames joined by list()): "the SAPS case number and the quotes". */
  list: string;
}

/** Fills a WhatsApp template body's {{1}}, {{2}}, … with `params`, in order: the text the client sees. */
export const fillTemplate = (body: string, params: readonly string[]) => body.replace(/\{\{(\d+)\}\}/g, (m, n: string) => params[Number(n) - 1] ?? m);

/**
 * TTTFG-5212: the morning reminder on WhatsApp, of what the client still has to send (reminder.ts). Never says what
 * happens if they don't. It always goes as the approved WhatsApp template, `whatsappBody` (AC 2), with the list in one
 * line ({{3}}); `render` is that body filled in, the text the client sees and the agent action keeps.
 * draft-2 (2 Nov 2026): always the template. draft-1 sent a bulleted text inside the 24-hour window.
 */
export const REMINDER_TEMPLATE = {
  name: 'Claim - still needed (morning reminder)',
  version: 'draft-2',
  approved: false,
  /** The template's variables, in order. */
  params: (v: ReminderTemplateVars) => [v.firstName, v.claim, v.list],
  render: (v: ReminderTemplateVars): string => fillTemplate(REMINDER_TEMPLATE.whatsappBody, REMINDER_TEMPLATE.params(v)),
  /** For Meta: {{1}} first name, {{2}} the claim, {{3}} the list in one line ("the SAPS case number and the quotes"). */
  whatsappBody: "Good morning {{1}}, it's Tina from TTT. For your {{2}} we still need {{3}}. Please send them here when you have them.",
} as const;

/**
 * TTTFG-5212 AC 2: the reminder for a claim that came in by email, by email (never on WhatsApp too). The same rules as
 * the WhatsApp one; how to send is a reply to the email. Sent by the host's email sender (TTTFG-4973's templated
 * sends).
 */
export const REMINDER_EMAIL_TEMPLATE = {
  name: 'Claim - still needed (reminder email)',
  version: 'draft-1',
  approved: false,
  subject: (v: Pick<ReminderVars, 'claim'>) => `Your ${v.claim}: what we still need`,
  render: (v: ReminderVars) => {
    const them = itOrThem(v.lines);
    return [
      `Good morning ${v.firstName},`,
      `Things we still need from you for your ${v.claim}:\n${v.lines.map((l) => `- ${l}`).join('\n')}`,
      v.questionsLeft
        ? 'Please reply to this email with the answers, and attach any photos or documents to your reply.'
        : `Please reply to this email with ${them} when you have ${them}. You can attach photos and documents to your reply.`,
      'Kind regards,\nTTT',
    ].join('\n\n');
  },
} as const;

export interface FnolEmailVars {
  firstName: string;
  /** The claim reference, CLM-…. */
  reference: string;
  link?: string;
  /** The last day the link works, as a calendar date in South Africa, YYYY-MM-DD. */
  expiresOn?: string;
}

/**
 * TTTFG-5188 AC 5: the acknowledgement for a claim that came in by email. Sent with no approval, so it is fixed text filled
 * with CRM data: Claude writes none of it. The AI line is the same as on WhatsApp (claim.ts AI_HANDLING_LINE).
 * draft-3 (the user, 6 Nov 2026): no broker's name, as on WhatsApp since TTT's 28 Oct feedback (FNOL_TEMPLATE draft-3),
 * and the link's last day written out ("20 November 2026"), as in the signing link.
 */
export const FNOL_EMAIL_TEMPLATE = {
  name: 'Claim - FNOL logged (email)',
  version: 'draft-3',
  approved: false,
  subject: (v: Pick<FnolEmailVars, 'reference'>) => `Your claim is logged (${v.reference})`,
  render: (v: FnolEmailVars) => [
    `Thanks ${v.firstName}, your claim is logged. Your claim reference is ${v.reference}.`,
    // The user (3 Nov 2026): one email. With the form's link when it can go with it; otherwise the link follows on its own.
    ...(v.link
      ? ['Next step: please fill in your claim form here:', v.link, `You can stop and come back to it: the link works until ${longDate(v.expiresOn!)}. Once you've submitted it, we'll email you the form to sign.`]
      : ["Next steps: we'll email you separately with anything else we need, such as questions for your insurer's claim form and any photos or documents. You can reply to our emails with your answers and attach what you have."]),
    AI_HANDLING_LINE,
    'Kind regards,\nTTT',
  ].join('\n\n'),
} as const;

/**
 * TTTFG-5188 (the user, 3 Nov 2026): an email claim gets the guided form rather than a list of questions, as on WhatsApp
 * (TTTFG-5562). Fixed wording filled with CRM values and the link, so it goes without approval, as the signing link does.
 * The wording waits for TTT's approval with the acknowledgement's. draft-2 (6 Nov 2026): the link's last day written out.
 */
export interface FormLinkEmailVars { firstName: string; reference: string; link: string; /** South African date, YYYY-MM-DD. */ expiresOn: string }

export const FORM_LINK_EMAIL_TEMPLATE = {
  name: 'Claim - form link (email)',
  version: 'draft-2',
  approved: false,
  subject: (v: Pick<FormLinkEmailVars, 'reference'>) => `Your claim form (${v.reference})`,
  render: (v: FormLinkEmailVars) => [
    `Hi ${v.firstName}, to carry on with your claim (${v.reference}), please fill in your claim form here:`,
    v.link,
    `You can stop and come back to it: the link works until ${longDate(v.expiresOn)}. Once you've submitted it, we'll email you the form to sign.`,
    'Kind regards,\nTTT',
  ].join('\n\n'),
} as const;

/**
 * TTTFG-5188 AC 8: the one reply to a claim email from an address on no contact. It asks for no ID number and no policy number
 * (decided 9 October 2026: anyone who knows a client's ID number could otherwise claim in their name) and holds no client
 * details. A person approves it, as for any draft reply.
 */
export const UNKNOWN_SENDER_EMAIL_TEMPLATE = {
  name: 'Claim - unknown sender (email)',
  version: 'draft-1',
  approved: false,
  render: (v: { signUpLink: string }) => [
    "Thank you for your email. We can't find this email address on our system.",
    "If you're already a TTT client, please write to us from the address we have on file, and we'll help you from there.",
    `If you're new, you can sign up here: ${v.signUpLink}`,
    'Kind regards,\nTTT',
  ].join('\n\n'),
} as const;

export interface SignFormVars {
  firstName: string;
  insurer: string;
  /** The claim reference, CLM-…. */
  reference: string;
  link: string;
  /** The last day the link works, as a calendar date in South Africa, YYYY-MM-DD. */
  expiresOn: string;
}

/**
 * TTTFG-5196: the one message at Form sent, with the signing link (TTTFG-5208 sends nothing more on Form sent). It goes
 * on the claim's own channel only. Inside WhatsApp's 24-hour window (always, in practice: the client has just sent the
 * last item, or went quiet on an optional one minutes ago) it goes as this text; outside it, as the approved WhatsApp
 * template whose body is
 * `whatsappBody`. Email uses `emailSubject` and the same text (TTTFG-4973's templated send path).
 */
export const SIGN_FORM_TEMPLATE = {
  name: 'Claim - form ready to sign',
  version: 'draft-1',
  approved: false,
  render: (v: SignFormVars) =>
    `${v.firstName}, your claim form for ${v.insurer} (${v.reference}) is ready. Please read it through and sign it here: ${v.link}\n` +
    `The link is just for you and works until ${longDate(v.expiresOn)}.`,
  /** For Meta: {{1}} first name, {{2}} insurer, {{3}} claim reference, {{4}} the link, {{5}} the last day it works. */
  whatsappBody: '{{1}}, your claim form for {{2}} ({{3}}) is ready. Please read it through and sign it here: {{4}} The link is just for you and works until {{5}}.',
  params: (v: SignFormVars) => [v.firstName, v.insurer, v.reference, v.link, longDate(v.expiresOn)],
  emailSubject: (v: SignFormVars) => `Your claim form is ready to sign (${v.reference})`,
} as const;

export interface ClaimToInsurerVars {
  clientName: string;
  policyNumber: string | null;
  /** The claim reference, CLM-…. */
  reference: string;
  claimType: string;
  insurer: string;
  /** riivo_incidentdate, a date and time, or null when the claim holds none. */
  incidentDate: string | null;
}

/**
 * TTTFG-5204 AC 8 and 9: the email that takes a claim pack to an insurer that takes claims by email, with the pack attached.
 * Fixed text with CRM values only, and the broker approves the item that holds it, so Claude writes none of it and the
 * recipient is code's (the insurer's riivo_claimsemail). It states no cover position.
 */
export const CLAIM_TO_INSURER_TEMPLATE = {
  name: 'Claim to insurer',
  version: 'draft-1',
  approved: false,
  subject: (v: Pick<ClaimToInsurerVars, 'clientName' | 'policyNumber' | 'reference'>) =>
    (v.policyNumber ? `New claim: ${v.clientName} – policy ${v.policyNumber}` : `New claim: ${v.clientName} (${v.reference})`),
  render: (v: ClaimToInsurerVars) => [
    `Please find attached a new claim for ${v.clientName}. The pack holds the signed claim form, a summary of the claim and the client's supporting documents.`,
    [
      `Policy number: ${v.policyNumber ?? 'not on file'}`,
      `Claim type: ${v.claimType}`,
      ...(v.incidentDate ? [`Date of incident: ${new Date(v.incidentDate).toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'long', year: 'numeric' })}`] : []),
      `Our reference: ${v.reference}`,
    ].join('\n'),
    `Please reply with your claim number, quoting our reference ${v.reference}.`,
  ].join('\n\n'),
} as const;

export interface SubmittedVars { insurer: string; number: string; reference: string }

/**
 * TTTFG-5204 AC 7: what the client hears when their claim moves to Submitted to insurer. CRM values only, with no approval
 * per message, so TTT approves the wording once. On WhatsApp it is always the approved template: `meta` and `templateVersion`
 * are its key in the WhatsApp flow's template list (WhatsApp - Automated - Send Templated Message), and Meta must have it.
 */
export const SUBMITTED_TEMPLATE = {
  name: 'Claim - submitted to insurer',
  version: 'draft-1',
  approved: false,
  meta: 'claim_submitted',
  templateVersion: 1,
  /** For Meta: {{1}} the insurer, {{2}} the insurer's claim number. */
  whatsappBody: 'Submitted to {{1}}, claim no. {{2}}.',
  params: (v: SubmittedVars) => [v.insurer, v.number],
  render: (v: SubmittedVars) => `Submitted to ${v.insurer}, claim no. ${v.number}.`,
  emailSubject: (v: SubmittedVars) => `Your claim is with ${v.insurer} (${v.reference})`,
} as const;

export interface StatusUpdateVars { insurer: string; reference: string }

/**
 * TTTFG-5208 AC 1, 3: what the client hears when a claim moves to a status that tells them something. CRM values only, so no
 * model text and no per-message approval; it never implies an outcome. `approved` is TTT's Insurance and Advice department
 * (AC 4) and `metaApproved` is Meta's: statusupdate.ts sends nothing until they say so, and the claim's owner tells the
 * client by hand. On WhatsApp, `meta` and `templateVersion` are the key in the WhatsApp flow's template list.
 *
 * No first name (a blank one fails at Meta), no insurer claim number (a claim can get here with none) and no broker's name
 * (TTT, 28 Oct 2026). The list of what the insurer asked for needs TTTFG-5216: nothing holds it on the claim yet.
 */
export interface StatusTemplate {
  name: string;
  version: string;
  approved: boolean;
  metaApproved: boolean;
  meta: string;
  templateVersion: number;
  whatsappBody: string;
  params(v: StatusUpdateVars): string[];
  render(v: StatusUpdateVars): string;
  emailSubject(v: StatusUpdateVars): string;
}

// riivo's best guess, approved by riivo on 6 Nov 2026 so the story can be tested; TTT's Insurance and Advice department
// still has to confirm it (AC 4), and their wording goes in as a new version. `metaApproved` stays false here: Meta approves
// per WhatsApp account, so each environment says so with CLAIMS_STATUS_META_APPROVED (statusupdate-dataverse.ts).
// Meta refuses a body that starts or ends with a variable, or is mostly variables, so both carry fixed text around them.
export const UNDER_ASSESSMENT_TEMPLATE: StatusTemplate = {
  name: 'Claim - under assessment',
  version: 'riivo-1',
  approved: true,
  metaApproved: false,
  meta: 'claim_under_assessment',
  templateVersion: 1,
  /** For Meta: {{1}} our reference, {{2}} the insurer. */
  whatsappBody: 'An update on your claim {{1}}: {{2}} is now assessing it. You don\'t need to do anything for now. We will be in touch when there is news.',
  params: (v) => [v.reference, v.insurer],
  render: (v) => `An update on your claim ${v.reference}: ${v.insurer} is now assessing it. You don't need to do anything for now. We will be in touch when there is news.`,
  emailSubject: (v) => `Your claim ${v.reference} is being assessed`,
};

export const ADDITIONAL_INFO_TEMPLATE: StatusTemplate = {
  name: 'Claim - additional info requested',
  version: 'riivo-1',
  approved: true,
  metaApproved: false,
  meta: 'claim_additional_info',
  templateVersion: 1,
  /** For Meta: {{1}} our reference, {{2}} the insurer. */
  whatsappBody: 'An update on your claim {{1}}: {{2}} has asked for more information before they can carry on. We will be in touch to tell you what is needed.',
  params: (v) => [v.reference, v.insurer],
  render: (v) => `An update on your claim ${v.reference}: ${v.insurer} has asked for more information before they can carry on. We will be in touch to tell you what is needed.`,
  emailSubject: (v) => `More information needed on your claim ${v.reference}`,
};
