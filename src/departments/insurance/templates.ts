// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/templates.ts (commit 46c8ff2). Do not edit here:
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
  /**
   * The user (18 Nov 2026): a claim the client has already submitted gets the link to the missing-items form (guided.ts topUp)
   * instead of "reply to this email". Absent for a claim not yet submitted, or when no link could be made.
   */
  missingLink?: string;
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

export interface MissingReminderVars {
  /** "motor accident claim (CLM-000301)". */
  claim: string;
  /** What is still needed in one line (stillNeedNames joined by list()): "the SAPS case number and the quotes". */
  list: string;
  /** A fresh link to the missing-items form (guided.ts topUp). */
  link: string;
}

/**
 * The user (18 Nov 2026): the morning reminder for a claim the client has submitted and still owes something on, in the
 * client's words: "Update on your claim: Things we still need from you: <list>. To add it to your claim, tap <link>. You don't need
 * to sign again." It never asks them to send it on WhatsApp. A WhatsApp template variable can't hold a line break, so the list is
 * one line here (the email's is bulleted), and the link sits in the text because Tina's template sender has no URL button.
 * Its own approved template (Tina's CLAIMS_MISSING_TEMPLATE), because REMINDER_TEMPLATE's body ends "Please send them here".
 * Until that is set up the reminder goes as REMINDER_TEMPLATE (reminder.ts signedList).
 */
export const MISSING_REMINDER_TEMPLATE = {
  name: 'Claim - still needed, add missing items (morning reminder)',
  version: 'draft-1',
  approved: false,
  /** The template's variables, in order. */
  params: (v: MissingReminderVars) => [v.claim, v.list, v.link],
  render: (v: MissingReminderVars): string => fillTemplate(MISSING_REMINDER_TEMPLATE.whatsappBody, MISSING_REMINDER_TEMPLATE.params(v)),
  /** For Meta: {{1}} the claim ("motor accident claim (CLM-000301)"), {{2}} the list in one line, {{3}} the link. */
  whatsappBody: "Update on your {{1}}. Things we still need from you: {{2}}. To add it to your claim, tap this link: {{3}} You don't need to sign again.",
} as const;

/**
 * TTTFG-5212 AC 2: the reminder for a claim that came in by email, by email (never on WhatsApp too). The same rules as
 * the WhatsApp one; how to send is a reply to the email. Sent by the host's email sender (TTTFG-4973's templated
 * sends).
 */
export const REMINDER_EMAIL_TEMPLATE = {
  name: 'Claim - still needed (reminder email)',
  version: 'draft-2',
  approved: false,
  subject: (v: Pick<ReminderVars, 'claim' | 'missingLink'>) => (v.missingLink ? `Update on your ${v.claim}` : `Your ${v.claim}: what we still need`),
  /**
   * draft-2 (the user, 18 Nov 2026): on a claim the client has submitted, "Update on your claim: Things we still need from you:",
   * the list, then "tap Add missing items", and no need to sign again. The reply wording stays for a claim not yet submitted.
   */
  render: (v: ReminderVars) => {
    const them = itOrThem(v.lines);
    const list = v.lines.map((l) => `- ${l}`).join('\n');
    if (v.missingLink) {
      return [
        `Good morning ${v.firstName},`,
        `Update on your ${v.claim}:`,
        `Things we still need from you:\n${list}`,
        ...addMissingItems(v.lines, v.missingLink),
        'Kind regards,\nTTT',
      ].join('\n\n');
    }
    return [
      `Good morning ${v.firstName},`,
      `Things we still need from you for your ${v.claim}:\n${list}`,
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
 * with CRM data: Claude writes none of it.
 * draft-3 (the user, 6 Nov 2026): no broker's name, as on WhatsApp since TTT's 28 Oct feedback (FNOL_TEMPLATE draft-3).
 * draft-4 (the user, 9 Nov 2026): with the form's link, as close to WhatsApp's form message as an email can be: we've opened
 * a claim, complete the form so we can submit it. No signing link to come: the client signs at the end of the form.
 * draft-5 (the user, 9 Nov 2026): no AI line and no reference in the body, with or without the link. The reference stays in
 * the subject.
 */
export const FNOL_EMAIL_TEMPLATE = {
  name: 'Claim - FNOL logged (email)',
  version: 'draft-5',
  approved: false,
  subject: (v: Pick<FnolEmailVars, 'reference'>) => `Your claim is logged (${v.reference})`,
  render: (v: FnolEmailVars) => [
    `Hi ${v.firstName}, we've opened a claim for you.`
      + (v.link ? ' Please complete the form below so that we can submit your claim.'
        : " We'll email you separately with anything else we need, such as questions for your insurer's claim form and any photos or documents. You can reply to our emails with your answers and attach what you have."),
    ...(v.link ? [v.link] : []),
    'Kind regards,\nTTT',
  ].join('\n\n'),
} as const;

/**
 * TTTFG-5188 (the user, 3 Nov 2026): an email claim gets the guided form rather than a list of questions, as on WhatsApp
 * (TTTFG-5562). Fixed wording filled with CRM values and the link, so it goes without approval, as the signing link does.
 * The wording waits for TTT's approval with the acknowledgement's. draft-2 (6 Nov 2026): the link's last day written out.
 * draft-3 (the user, 9 Nov 2026): as WhatsApp's form message; the client signs at the end of the form, so no signing link.
 */
export interface FormLinkEmailVars { firstName: string; reference: string; link: string; /** South African date, YYYY-MM-DD. */ expiresOn: string }

export const FORM_LINK_EMAIL_TEMPLATE = {
  name: 'Claim - form link (email)',
  version: 'draft-3',
  approved: false,
  subject: (v: Pick<FormLinkEmailVars, 'reference'>) => `Your claim form (${v.reference})`,
  render: (v: FormLinkEmailVars) => [
    `Hi ${v.firstName}, please complete the form below so that we can submit your claim.`,
    v.link,
    'Kind regards,\nTTT',
  ].join('\n\n'),
} as const;

export interface FormReminderVars {
  firstName: string;
  /** The claim as Tina names it: "motor accident claim (CLM-000486)". */
  claim: string;
  /** A fresh link to the claim's form. The answers already given are kept, so the client carries on where they stopped. */
  link: string;
}

/**
 * The user (13 Nov 2026): on WhatsApp, the morning reminder for a claim whose form went out and hasn't been submitted
 * (reminder.ts) is REMINDER_TEMPLATE, the template Meta has already approved, with this as its {{3}}: "… we still need
 * you to finish your claim form here: <link>." No second template to approve.
 */
export const formStillNeeded = (link: string) => `you to finish your claim form here: ${link}`;

/**
 * The user (18 Nov 2026): the same {{3}} for a submitted claim, with the link to the missing-items form after the list:
 * "… we still need the SAPS case number. You can add it to your claim here: <link>. Please send them here when you have them."
 */
export const missingOnForm = (names: string, link: string) => `${names}. You can add ${/ and /.test(names) ? 'them' : 'it'} to your claim here: ${link}`;

/** The same reminder for a claim that came in by email, from the claim owner's mailbox (no Meta template on email). */
export const FORM_REMINDER_EMAIL_TEMPLATE = {
  name: 'Claim - form not finished (reminder email)',
  version: 'draft-1',
  approved: false,
  subject: (v: Pick<FormReminderVars, 'claim'>) => `Your ${v.claim}: the form isn't finished yet`,
  render: (v: FormReminderVars) => [
    `Good morning ${v.firstName},`,
    `The form for your ${v.claim} isn't finished yet. Please complete it below so that we can submit your claim. What you've already filled in is kept.`,
    v.link,
    'Kind regards,\nTTT',
  ].join('\n\n'),
} as const;

/**
 * The user (9 Nov 2026): what the client hears once they submit the guided form, the same words on WhatsApp
 * (followon.ts formClosingText) and by email (FORM_DONE_EMAIL_TEMPLATE). The sign line only when the signature from the
 * form couldn't be used and a signing link went instead.
 */
export const FORM_THANKS = 'Thank you!';
export const FORM_CLOSING = 'A consultant from TTT will be in touch with you shortly. We will keep you updated on the status of your claim.';

export interface FormDoneEmailVars {
  reference: string;
  /** A signing link went, as the signature from the form couldn't be used. */
  linkSent: boolean;
  /**
   * The user (16 Nov 2026): what the client still has to send, as the lines of "Things we still need from you" (followon.ts
   * stillNeedLines). Nothing on the form holds up signing, so the thank-you says what is still to come. Never a quote or an
   * invoice: TTT gets those.
   */
  stillNeed?: readonly string[];
  /**
   * The user (18 Nov 2026): the link to the missing-items form (guided.ts topUp), for a form signed on the form itself. With it
   * the list is followed by "tap Add missing items" and nothing is asked by reply; without it (no link could be made, or a
   * signing link is still to be used) the client is asked to reply, as before.
   */
  missingLink?: string;
}

/** The label of the missing-items form's link, in an email as on WhatsApp (followon.ts MISSING_LINK_LABEL). */
export const MISSING_ITEMS_LABEL = 'Add missing items';

/**
 * The user (18 Nov 2026): what follows the bulleted list of "Things we still need from you" when the client can add it on the
 * missing-items form: tap the link, and nothing to sign again. The same words by email (a labelled link on its own line)
 * and on WhatsApp's own message; never "send it here".
 */
export const addMissingItems = (lines: readonly string[], link: string) => [
  `To add ${itOrThem(lines)} to your claim, tap ${MISSING_ITEMS_LABEL} below. You don't need to sign again.`,
  `${MISSING_ITEMS_LABEL}: ${link}`,
];

/**
 * The user (9 Nov 2026): the email claim's last email, once the form is submitted and signed: WhatsApp's thank-you.
 * draft-2 (the user, 18 Nov 2026): what is still to come comes with the link to the missing-items form, not a reply to send.
 */
export const FORM_DONE_EMAIL_TEMPLATE = {
  name: 'Claim - form submitted (email)',
  version: 'draft-2',
  approved: false,
  subject: (v: Pick<FormDoneEmailVars, 'reference'>) => `Your claim is submitted (${v.reference})`,
  render: (v: FormDoneEmailVars) => [
    [FORM_THANKS, v.linkSent ? 'Please check and sign the form using the link we emailed you.' : '', FORM_CLOSING].filter(Boolean).join(' '),
    ...(v.stillNeed?.length ? [
      `Things we still need from you:\n${v.stillNeed.map((l) => `- ${l}`).join('\n')}`,
      ...(v.missingLink ? addMissingItems(v.stillNeed, v.missingLink) : [
        `Please reply to this email with ${itOrThem(v.stillNeed)} when you have ${itOrThem(v.stillNeed)}, or send ${itOrThem(v.stillNeed)} to Tina on WhatsApp. We will remind you each morning until ${itOrThem(v.stillNeed) === 'it' ? 'it is' : 'they are'} in.`,
      ]),
    ] : []),
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
  version: 'draft-2',
  approved: false,
  subject: (v: Pick<ClaimToInsurerVars, 'clientName' | 'policyNumber' | 'reference'>) =>
    (v.policyNumber ? `New claim: ${v.clientName} – policy ${v.policyNumber}` : `New claim: ${v.clientName} (${v.reference})`),
  render: (v: ClaimToInsurerVars) => [
    `Please find attached a new claim for ${v.clientName}: the signed claim form, a summary of the claim and the client's supporting documents, each as a separate file.`,
    [
      `Policy number: ${v.policyNumber ?? 'not on file'}`,
      `Claim type: ${v.claimType}`,
      ...(v.incidentDate ? [`Date of incident: ${new Date(v.incidentDate).toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'long', year: 'numeric' })}`] : []),
      `Our reference: ${v.reference}`,
    ].join('\n'),
    `Please reply with your claim number, quoting our reference ${v.reference}.`,
  ].join('\n\n'),
} as const;

export interface InsurerChaseVars {
  clientName: string;
  /** The insurer's claim number. A claim without one isn't chased (chase.ts). */
  insurerClaimNumber: string;
  /** The client's policy number. A claim without one isn't chased (chase.ts). */
  policyNumber: string;
  /** The claim reference, CLM-…. */
  reference: string;
  /** riivo_submittedon, a date and time, or null when the claim holds none. */
  submittedOn: string | null;
}

/**
 * TTTFG-5269 AC 3: the chase that goes to an insurer silent on a submitted claim for 2 working days. Unattended, so the
 * wording is fixed and TTT approves it once; CRM values only, so Claude writes none of it. It goes from the claim owner's
 * mailbox, whose frame adds the signature, so the insurer's reply reaches the broker. Neutral: it asks where the claim
 * stands and never says the insurer is late or in breach.
 */
export const INSURER_CHASE_TEMPLATE = {
  name: 'Insurer claim chase',
  version: 'draft-1',
  approved: false,
  subject: (v: Pick<InsurerChaseVars, 'insurerClaimNumber' | 'clientName'>) => `Claim ${v.insurerClaimNumber} – ${v.clientName} – follow-up`,
  render: (v: InsurerChaseVars) => [
    'Good day,',
    `We are following up on the claim below${v.submittedOn ? `, submitted on ${new Date(v.submittedOn).toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'long', year: 'numeric' })}` : ''}. `
      + 'We have not yet had an update from you. Please let us know where the claim stands, and whether you need anything further from us or the client.',
    [
      `Client: ${v.clientName}`,
      `Policy number: ${v.policyNumber}`,
      `Your claim number: ${v.insurerClaimNumber}`,
      `Our reference: ${v.reference}`,
    ].join('\n'),
    'Thank you.',
  ].join('\n\n'),
} as const;

export interface UnderReviewVars { insurer: string; number: string; reference: string }

/**
 * The user (18 Nov 2026): what the client hears when the broker saves the insurer's claim number. Saving it moves the claim to
 * Under assessment ("under review" to the client), so this one message says so and gives the number (submitted.ts). It replaces
 * TTTFG-5204 AC 7's "Submitted to <insurer>, claim no. <number>", which went when the number set Submitted to insurer.
 * CRM values only, with no approval per message. On WhatsApp it is always the approved template: `meta` and `templateVersion`
 * are its key in the WhatsApp flow's template list (WhatsApp - Automated - Send Templated Message), and Meta must have it.
 * Meta refuses a body that ends with a variable, so the full stop after the number is the body's last word.
 */
export const UNDER_REVIEW_TEMPLATE = {
  name: 'Claim - under review',
  version: 'draft-1',
  approved: true,
  meta: 'claim_under_review',
  templateVersion: 1,
  /** For Meta: {{1}} the insurer, {{2}} the insurer's claim number. */
  whatsappBody: 'Your claim submitted to {{1}} is under review.\n\nYour claim number is: {{2}}.',
  params: (v: UnderReviewVars) => [v.insurer, v.number],
  render: (v: UnderReviewVars) => `Your claim submitted to ${v.insurer} is under review.\n\nYour claim number is: ${v.number}.`,
  emailSubject: (v: UnderReviewVars) => `Your claim ${v.reference} is under review`,
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

/**
 * The user (18 Nov 2026): what the client hears when the broker marks the claim pack as submitted (or the agent sends it to an
 * insurer that takes claims by email): "Update on your claim: your claim has been submitted to <insurer>." and nothing for them to
 * do. Under assessment sends no message of its own any more: it is the saving of the insurer's claim number that tells the client
 * their claim is under review, with the number (UNDER_REVIEW_TEMPLATE). The wording is the user's, so it is approved here; Meta
 * approves per WhatsApp account, and this template comes with its own switch (CLAIMS_WORDING_META_APPROVED), set once Meta has it.
 */
export const SUBMITTED_UPDATE_TEMPLATE: StatusTemplate = {
  name: 'Claim - submitted to insurer',
  version: 'draft-2',
  approved: true,
  metaApproved: false,
  meta: 'claim_submitted_to_insurer',
  templateVersion: 1,
  /** For Meta: {{1}} the insurer. */
  whatsappBody: "Update on your claim: your claim has been submitted to {{1}}. You don't need to do anything for now. We will keep you updated on the status of your claim.",
  params: (v) => [v.insurer],
  render: (v) => `Update on your claim: your claim has been submitted to ${v.insurer}. You don't need to do anything for now. We will keep you updated on the status of your claim.`,
  emailSubject: (v) => `Your claim ${v.reference} has been submitted to ${v.insurer}`,
};

// riivo's best guess, approved by riivo on 6 Nov 2026 so the story can be tested; TTT's Insurance and Advice department
// still has to confirm it (AC 4), and their wording goes in as a new version. `metaApproved` stays false here: Meta approves
// per WhatsApp account, so each environment says so with CLAIMS_STATUS_META_APPROVED (statusupdate-dataverse.ts).
// Meta refuses a body that starts or ends with a variable, or is mostly variables, so it carries fixed text around them.
// Unchanged on 18 Nov 2026 (the user: additional info requested stays as it is).
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
