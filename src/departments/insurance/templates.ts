// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/templates.ts (commit 573eaf9). Do not edit here:
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

const longDate = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00+02:00`).toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'long', year: 'numeric' });

export interface DeadlineVars {
  insurer: string;
  periodDays: number;
  /** The deadline as a calendar date in South Africa, YYYY-MM-DD. */
  deadline: string;
  /** The claim owner's first name, or the team name. */
  ownerName: string;
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

/** The deadline is behind us. Says when it was and that the owner takes it from here; never what that means for cover. */
export const DEADLINE_PASSED_TEMPLATE = {
  name: 'Claim - notification deadline (Passed)',
  version: 'draft-1',
  approved: false,
  render: (v: DeadlineVars) =>
    `${v.insurer} asks for claims to be reported within ${v.periodDays} days of the incident. ` +
    `For this incident, that date was ${longDate(v.deadline)}. ${v.ownerName} will take it from here.`,
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
  /** The list's lines (followon.ts stillNeedLines), or for the WhatsApp template the same in one line. */
  lines: readonly string[];
  /** Some of it is questions Tina asks one by one (a claim the client left half way), not things to send. */
  questionsLeft?: boolean;
}

/**
 * TTTFG-5212 (first cut, for the TTTFG-4830 demo): the morning reminder of what the client still has to send
 * (reminder.ts). Never says what happens if they don't. Inside WhatsApp's 24-hour window it goes as this text; outside
 * it, as the approved WhatsApp template whose body is `whatsappBody`, with the list in one line ({{3}}).
 */
export const REMINDER_TEMPLATE = {
  name: 'Claim - still needed (morning reminder)',
  version: 'draft-1',
  approved: false,
  render: (v: ReminderVars) => [
    `Good morning ${v.firstName}, it's Tina from TTT. Things we still need from you for your ${v.claim}:`,
    ...v.lines.map((l) => `- ${l}`),
    v.questionsLeft ? "Reply here when you're ready and I'll take you through them." : `Please send ${itOrThem(v.lines)} here when you have ${itOrThem(v.lines)}.`,
  ].join('\n'),
  /** For Meta: {{1}} first name, {{2}} the claim, {{3}} the list in one line ("the SAPS case number and the quotes"). */
  whatsappBody: "Good morning {{1}}, it's Tina from TTT. For your {{2}} we still need {{3}}. Please send them here when you have them.",
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
