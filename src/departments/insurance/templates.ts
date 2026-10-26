// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/templates.ts (commit 78a9547). Do not edit here:
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

/** Sent word for word before the first form question (see the open question on the order in the report). */
export const DISCLOSURE_TEMPLATE = {
  name: 'Claim - duty of disclosure',
  version: 'draft-1',
  approved: false,
  render: () =>
    "Before I ask the insurer's questions: please tell the insurer all the facts that matter to this claim, honestly and in full. " +
    "If you're not sure whether something matters, please tell me anyway.",
} as const;

export type ClaimTemplate = typeof DEADLINE_UPCOMING_TEMPLATE | typeof DEADLINE_PASSED_TEMPLATE | typeof DISCLOSURE_TEMPLATE;
