// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/resume.ts (commit a77f99a). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5184: stop a claim and continue later (SPEC-04 "Tina's claim walkthrough", stop and continue; spec user story 6
// and the WhatsApp half of 8). Runs on every client message that isn't part of a 5168 walkthrough in progress, before
// claimTurn() and followOnTurn() see it, and decides which claim the message belongs to:
// - no open claim: nothing here; Tina carries on as today (5168 when it's a new claim);
// - a follow-on conversation in progress on an open claim: followOnTurn() as is;
// - one open claim: the same claim picks up. "Welcome back. For your … claim we still need: …", then the first missing
//   item (followOnTurn's `resume` input);
// - two or more: "Is this about your … claim from … or …?" before the message or file is used. A file waits;
// - a different incident (Claude's yes/no, like `describedAsTheft`): "Is this a new claim?". Only a yes starts the
//   5168 walkthrough for a second claim.
//
// The one wrong turn (TTTFG-5262): the claim's progress is never kept in Tina's conversation memory. ResumeState holds
// only an unanswered question of this file and the follow-on's place in the conversation; what's missing is worked
// out from the claim's riivo_answers and linked documents every time (progress.ts), so a file that arrives by email
// (TTTFG-5188) counts at once. OPEN_CLAIM_STATUSES and openClaimsForClient are the one definition of "open" that
// TTTFG-5188 reuses for email.
//
// When is a follow-on conversation "in progress"? While its state is kept and the client last wrote less than
// `resumeAfterHours` ago (riivo_lastclientmessageon, read before this message updates it). After that, a reply that
// answers Tina's last question still goes on (it can only be about that claim), but a "hi" or a file starts again from
// the claim record. Without that cut-off, "hi" two days later is a miss on the old question, and two misses hand a
// required question to the broker.
import { claimTurn, sendText, type ClaimPorts, type Conversation } from './claim';
import {
  CLAIM_SETTINGS_DEFAULTS, followOnTurn, list, resumeMissing, type ClaimSettings, type ClaimStatus, type ClientReply, type FollowOnPorts,
  type FollowOnState, type ResumeFile, type StoredClaimForm,
} from './followon';
import type { QuestionItem } from './contracts';
import { chased, itemName } from './progress';
import type { ClaimType, Facts, WalkthroughState } from './walkthrough';

/**
 * TTTFG-5262 step 1: the one definition of an open claim, shared with TTTFG-5188. Pack complete is open because
 * TTTFG-5200 recomputes the score when a late optional item arrives; Additional info requested because the insurer
 * has asked the client for more.
 */
export const OPEN_CLAIM_STATUSES = [
  'FNOL logged', 'Cover verified', 'Form sent', 'Awaiting client docs', 'Pack complete', 'Additional info requested',
] as const satisfies readonly ClaimStatus[];
export type OpenClaimStatus = (typeof OPEN_CLAIM_STATUSES)[number];
export const isOpenClaim = (status: ClaimStatus): status is OpenClaimStatus => (OPEN_CLAIM_STATUSES as readonly string[]).includes(status);

/** A riivo_claim row of the client, as openClaimsForClient reads it. */
export interface OpenClaim {
  id: string;
  reference: string;
  claimType: ClaimType;
  /** riivo_incidentdate, ISO 8601 with offset. */
  incidentAt: string;
  status: ClaimStatus;
  /** riivo_lastclientmessageon. */
  lastClientMessageOn?: string;
}

/** The port TTTFG-5188 shares. The client's riivo_claim rows whose status is one of OPEN_CLAIM_STATUSES. */
export interface OpenClaimsPort {
  openClaimsForClient(contactId: string): Promise<OpenClaim[]>;
}

export type ResumePorts = ClaimPorts & FollowOnPorts & OpenClaimsPort;

/** Package settings. `claims.resumeAfterHours`: a follow-on conversation is over this long after the client's last message. */
export interface ResumeSettings extends ClaimSettings { resumeAfterHours?: number }
export const RESUME_SETTINGS_DEFAULTS = { resumeAfterHours: 12 } as const;

/** What Claude understood from the client's message. Code decides what happens next. */
export interface ResumeMessage {
  /** The message as the follow-on reads it: a value for the item Tina asked last, a file, "not yet", or unparsed. */
  understood: ClientReply;
  /** Claude: the message is about an incident other than the open claims (a different date, place or type). */
  differentIncident: boolean;
  /** Claude, for "which claim?": the claim the client chose, by id or by its number in the question (1, 2, …). */
  chosenClaim?: string | number;
  /** Claude, for "is this a new claim?": the client's yes or no. */
  yesNo?: boolean;
  /** TTTFG-4830, Claude: the client said in so many words that this is a new claim ("I'd like to open a new claim"). */
  newClaim?: true;
  /** Claude, for a file: the missing item it is (an item key from the claim's missing list). */
  forItem?: string;
  /**
   * Claude, with `differentIncident`: what the message says about the new incident (type, what happened, when, where).
   * Kept for a yes to "Is this a new claim?", so the walkthrough doesn't ask it again.
   */
  facts?: Facts;
}

/** A question of this file, waiting for the client's answer. */
export type Pending =
  /** `claimIds` in the order the question named them. */
  | { kind: 'which-claim'; claimIds: string[]; held: ResumeFile[] }
  /**
   * `facts`: the new incident as Claude read it. `back`: the follow-on conversation the question interrupted, so a no
   * goes straight back to it.
   */
  | { kind: 'new-claim'; held: ResumeFile[]; facts?: Facts; back?: FollowOnState };

/** Kept on the Tina conversation between messages. Never what the claim holds. */
export interface ResumeState {
  followOn: FollowOnState | null;
  pending: Pending | null;
}
export const NO_RESUME_STATE: ResumeState = { followOn: null, pending: null };

// ---------------------------------------------------------------------------------------------------- pure decision

export type Decision =
  /** No open claim: nothing is said or written here. */
  | { kind: 'no-open-claim' }
  /** A follow-on conversation in progress: `understood` goes to followOnTurn with its state. */
  | { kind: 'continue'; claimId: string }
  /**
   * Back on this claim. With no files, the welcome-back line first (`lead` "Thanks." after a no to "new claim?").
   * `introSent`: a stale follow-on state of this claim says the duty of disclosure already went out.
   */
  | { kind: 'resume'; claimId: string; files: ResumeFile[]; lead: 'Welcome back.' | 'Thanks.'; introSent?: true }
  /** A no to "new claim?" in the middle of a conversation: straight back to it, without the welcome-back list. */
  | { kind: 'back'; claimId: string; files: ResumeFile[]; followOn: FollowOnState }
  /** `ask` false: a file arrived while the question was out; it's held and nothing is said. */
  | { kind: 'ask-which'; claims: OpenClaim[]; held: ResumeFile[]; ask: 'first' | 'again' | false }
  | { kind: 'ask-new'; held: ResumeFile[]; facts?: Facts; back?: FollowOnState; ask: 'first' | 'again' | false }
  /**
   * A yes to "new claim?": the 5168 walkthrough starts with what the client already said about the incident. Held
   * files are kept for the new claim (the host passes them to the follow-on's start).
   */
  | { kind: 'start-new'; held: ResumeFile[]; facts?: Facts };

export interface DecideInput {
  open: readonly OpenClaim[];
  state: ResumeState;
  message: ResumeMessage;
  now: Date;
  resumeAfterHours?: number;
}

const HOUR = 3_600_000;
const byIncident = (a: OpenClaim, b: OpenClaim) => Date.parse(a.incidentAt) - Date.parse(b.incidentAt) || a.reference.localeCompare(b.reference);

/** TTTFG-5262 steps 2, 4 and 6: which claim the message belongs to. Pure. */
export function decide({ open, state, message, now, resumeAfterHours = RESUME_SETTINGS_DEFAULTS.resumeAfterHours }: DecideInput): Decision {
  if (open.length === 0) return { kind: 'no-open-claim' };
  const u = message.understood;
  const files: ResumeFile[] = u.kind === 'file' ? [{ file: u.file, forItem: message.forItem }] : [];
  const claims = [...open].sort(byIncident);
  const resumeOrAsk = (held: ResumeFile[], lead: 'Welcome back.' | 'Thanks.'): Decision =>
    claims.length === 1 ? { kind: 'resume', claimId: claims[0].id, files: held, lead } : { kind: 'ask-which', claims, held, ask: 'first' };
  const p = state.pending;

  if (p?.kind === 'new-claim') {
    const held = [...p.held, ...files];
    if (message.yesNo === true || message.newClaim) return { kind: 'start-new', held, facts: p.facts };
    if (message.yesNo === false) {
      const back = p.back && claims.find((c) => c.id === p.back!.claimId);
      return back ? { kind: 'back', claimId: back.id, files: held, followOn: p.back! } : resumeOrAsk(held, 'Thanks.');
    }
    return { kind: 'ask-new', held, facts: p.facts, back: p.back, ask: files.length ? false : 'again' };
  }

  if (p?.kind === 'which-claim') {
    const held = [...p.held, ...files];
    const asked = p.claimIds.map((id) => claims.find((c) => c.id === id)).filter((c): c is OpenClaim => !!c);
    const chosen =
      typeof message.chosenClaim === 'number' ? asked[message.chosenClaim - 1]
      : typeof message.chosenClaim === 'string' ? asked.find((c) => c.id === message.chosenClaim)
      : undefined;
    if (chosen) return { kind: 'resume', claimId: chosen.id, files: held, lead: 'Welcome back.' };
    if (message.newClaim) return { kind: 'start-new', held, facts: message.facts };
    if (message.differentIncident) return { kind: 'ask-new', held, facts: message.facts, ask: 'first' };
    // A claim closed while the question was out: the one left, or ask again about the claims open now.
    if (asked.length === 1) return { kind: 'resume', claimId: asked[0].id, files: held, lead: 'Welcome back.' };
    if (asked.length === 0) return resumeOrAsk(held, 'Welcome back.');
    return { kind: 'ask-which', claims: asked, held, ask: files.length ? false : 'again' };
  }

  const f = state.followOn;
  const current = f && claims.find((c) => c.id === f.claimId);
  const last = current?.lastClientMessageOn ? Date.parse(current.lastClientMessageOn) : now.getTime();
  // TTTFG-4830 (still need): a reply to the list of what's still needed (the morning reminder too) goes on the list.
  const listed = f?.phase === 'still-need' && f.listedAt ? Date.parse(f.listedAt) : 0;
  const fresh = !!current && now.getTime() - Math.max(last, listed) < resumeAfterHours * HOUR;

  // TTTFG-4830: the client already said it's a new claim, so it isn't asked.
  if (message.newClaim) return { kind: 'start-new', held: files, facts: message.facts };
  if (message.differentIncident) return { kind: 'ask-new', held: files, facts: message.facts, back: fresh ? f! : undefined, ask: 'first' };

  if (current) {
    // A late answer to Tina's last question can only be about that claim. A "hi" or a file after a gap starts afresh.
    if (fresh || (u.kind !== 'unparsed' && u.kind !== 'file')) return { kind: 'continue', claimId: current.id };
    const d = resumeOrAsk(files, 'Welcome back.');
    return d.kind === 'resume' && d.claimId === current.id && f.introSent ? { ...d, introSent: true } : d;
  }
  return resumeOrAsk(files, 'Welcome back.');
}

// ------------------------------------------------------------------------------------------------------- the texts

/** dd/mm/yyyy in South Africa. */
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg', day: '2-digit', month: '2-digit', year: 'numeric' });

const claimWords = (t: ClaimType) => t.toLowerCase();

/** TTTFG-5262 step 6. Fixed text. */
export const NEW_CLAIM_QUESTION = 'Is this a new claim?';
export const NEW_CLAIM_AGAIN = 'Sorry, I didn\'t quite get that. Is this a new claim? Please just answer yes or no.';
/** Sent when files held for an earlier question are kept for the new claim the client is starting. */
export const heldFilesKept = (n: number) =>
  n === 1 ? "I'll add the file you sent to the new claim once it's open." : `I'll add the ${n} files you sent to the new claim once it's open.`;
/** A no to "Is this a new claim?" in the middle of a conversation: the words in front of the question Tina was on. */
export const backTo = (claimType: ClaimType) => `No problem, back to your ${claimType.toLowerCase()} claim.`;

/** "your motor accident claim from 01/11/2026", with the reference when two claims would read the same. */
function claimLabels(claims: readonly OpenClaim[]): string[] {
  const base = claims.map((c) => `your ${claimWords(c.claimType)} claim from ${shortDate(c.incidentAt)}`);
  return base.map((b, i) => (base.filter((x) => x === b).length > 1 ? `${b} (${claims[i].reference})` : b));
}

/** TTTFG-5262 step 4: "Is this about your … claim from … or your … claim from …?" */
export function whichClaimText(claims: readonly OpenClaim[], again = false): string {
  const labels = claimLabels(claims);
  if (!again) return `Is this about ${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}?`;
  return `Sorry, I didn't quite get that. Which claim is this about?\n${labels.map((l, i) => `${i + 1}. ${l.charAt(0).toUpperCase()}${l.slice(1)}`).join('\n')}`;
}

/**
 * The names in the welcome-back list. What the client has to go and find is named (TTTFG-4830: the items a form
 * chases, as on "Things we still need from you": the SAPS case number, the registration number, documents and photos).
 * The form's other questions are counted, not named: Tina asks them straight after, and a Momentum form has over a
 * hundred, whose keys don't read as names.
 */
export function missingNames(items: readonly QuestionItem[]): string[] {
  const named = items.filter((i) => i.kind === 'question' && chased(i)).map(itemName);
  const questions = items.filter((i) => i.kind === 'question' && !chased(i)).length;
  const evidence = items.filter((i) => i.kind === 'evidence').map(itemName);
  const counted = questions === 0 ? [] : [questions === 1 ? 'the answer to 1 more question' : `the answers to ${questions} more questions`];
  return [...named, ...counted, ...evidence];
}

/**
 * TTTFG-5262 step 3: "Welcome back. For your [claim type] claim we still need: [list]." With nothing missing there is
 * no list; Tina says where the claim stands instead (the insurer asking for more is the one case where the client
 * has something to send that isn't on the form).
 */
export function welcomeBackText(
  claimType: ClaimType, missing: readonly QuestionItem[], lead: 'Welcome back.' | 'Thanks.' = 'Welcome back.',
  claim?: { status: ClaimStatus; ownerName: string },
): string {
  const names = missingNames(missing);
  if (names.length) return `${lead} For your ${claimWords(claimType)} claim we still need: ${list(names)}.`;
  if (!claim) return lead;
  const owner = claim.ownerName.charAt(0).toUpperCase() + claim.ownerName.slice(1);
  if (claim.status === 'Additional info requested') {
    return `${lead} The insurer has asked for more information on your ${claimWords(claimType)} claim. ${owner} will tell you what they need, or you can send it here if you already know.`;
  }
  return `${lead} We have everything we need for your ${claimWords(claimType)} claim for now. ${owner} is handling it and will keep you updated.`;
}

// ----------------------------------------------------------------------------------------------------- the turn

export type ResumeResult =
  /**
   * Nothing was said or written: Tina carries on as today (claimTurn() when the client is reporting a claim). Drop the
   * ResumeState: any follow-on state in it belongs to a claim that is no longer open.
   */
  | { route: 'no-open-claim' }
  /** Handled here. Keep `state` for the next message. */
  | { route: 'claim'; state: ResumeState }
  /**
   * A yes to "Is this a new claim?": the 5168 walkthrough has started. The next messages go to claimTurn(). Once it opens
   * the claim, pass `held` as the follow-on start's `files`.
   */
  | { route: 'new-claim'; walkthrough: WalkthroughState | null; held: ResumeFile[] };

/**
 * One client message, when no 5168 walkthrough is in progress. Every client message updates
 * riivo_lastclientmessageon (TTTFG-5262 step 7): followOnTurn() does it for the claim the message belongs to; while
 * Tina is still asking which claim (or whether it's a new one), every open claim of the client gets it.
 */
export async function resumeTurn(
  ports: ResumePorts, conv: Conversation, state: ResumeState, message: ResumeMessage, now: Date, settings: ResumeSettings = {},
): Promise<ResumeResult> {
  const at = now.toISOString();
  const contact = await ports.contactByWhatsApp(conv.phone);
  if (!contact) return { route: 'no-open-claim' };
  const open = (await ports.openClaimsForClient(contact.id)).filter((c) => isOpenClaim(c.status));
  const d = decide({ open, state, message, now, resumeAfterHours: settings.resumeAfterHours });
  const touchAll = () => Promise.all(open.map((c) => ports.setLastClientMessageOn(c.id, at)));

  switch (d.kind) {
    case 'no-open-claim':
      return { route: 'no-open-claim' };

    case 'continue': {
      const u = message.understood;
      const r = await followOnTurn(ports, conv, state.followOn, u.kind === 'file' && message.forItem ? { ...u, forItem: message.forItem } : u, now, settings);
      return { route: 'claim', state: { followOn: r.state, pending: null } };
    }

    case 'resume': {
      if (!d.files.length) await welcomeBack(ports, conv, d.claimId, d.lead, now, settings);
      const r = await followOnTurn(ports, conv, null, { kind: 'resume', claimId: d.claimId, wamid: message.understood.wamid, files: d.files, introSent: d.introSent }, now, settings);
      return { route: 'claim', state: { followOn: r.state, pending: null } };
    }

    case 'ask-which':
      await touchAll();
      if (d.ask) await sendText(ports, conv, whichClaimText(d.claims, d.ask === 'again'), null, at);
      return { route: 'claim', state: { followOn: null, pending: { kind: 'which-claim', claimIds: d.claims.map((c) => c.id), held: d.held } } };

    case 'ask-new':
      await touchAll();
      if (d.ask) await sendText(ports, conv, d.ask === 'again' ? NEW_CLAIM_AGAIN : NEW_CLAIM_QUESTION, null, at);
      return { route: 'claim', state: { followOn: null, pending: { kind: 'new-claim', held: d.held, ...(d.facts ? { facts: d.facts } : {}), ...(d.back ? { back: d.back } : {}) } } };

    case 'back': {
      const claim = open.find((c) => c.id === d.claimId)!;
      const r = await followOnTurn(ports, conv, null, {
        kind: 'resume', claimId: d.claimId, wamid: message.understood.wamid, files: d.files, introSent: true,
        lead: backTo(claim.claimType), skipped: d.followOn.skipped,
      }, now, settings);
      return { route: 'claim', state: { followOn: r.state, pending: null } };
    }

    case 'start-new': {
      if (d.held.length) await sendText(ports, conv, heldFilesKept(d.held.length), null, at);
      const t = await claimTurn(ports, conv, null, { kind: 'start', facts: d.facts }, now);
      return { route: 'new-claim', walkthrough: t.state, held: d.held };
    }
  }
}

/** The welcome-back line, from the claim record: what's missing is worked out now, not remembered. */
async function welcomeBack(ports: ResumePorts, conv: Conversation, claimId: string, lead: 'Welcome back.' | 'Thanks.', now: Date, settings: ResumeSettings) {
  const claim = await ports.loadClaim(claimId);
  const form: StoredClaimForm = claim.claimFormId
    ? await ports.claimForm(claim.claimFormId)
    : (await ports.activeClaimForm(claim.providerId, claim.claimType)) ?? (await ports.genericClaimForm());
  const missing = resumeMissing({ claim, form, now, warningDays: settings.notificationWarningDays ?? CLAIM_SETTINGS_DEFAULTS.notificationWarningDays });
  const text = welcomeBackText(claim.claimType, missing, lead, { status: claim.status, ownerName: claim.owner.name });
  await sendText(ports, conv, text, { id: claim.id, owner: claim.owner }, now.toISOString());
}
