// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/resume.ts (commit c99946b). Do not edit here:
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
// - TTTFG-4830 (28 Oct 2026, from QC): the client says the claim isn't theirs ("I never logged it, this is fraud"), or
//   Tina can't tell what they need. She stops her questions and asks what they'd like to do, with taps: open a new
//   claim, carry on with this one, or talk to their broker. "Not theirs" also gives the broker an urgent Follow-up
//   (NOT_THEIRS), and while that is open the claim is held: Tina asks nothing about it and the morning reminder passes
//   it over, until the client says it is theirs after all (THEIRS) or the broker closes the Follow-up.
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
import {
  claimTurn, clientQuestionDetail, CLIENT_BROKER, DEPARTMENT, sendText, toBrokerText, type AgentActionRow, type ClaimPorts, type Choice, type Conversation,
} from './claim';
import {
  CLAIM_SETTINGS_DEFAULTS, followOnTurn, list, resumeMissing, type ClaimSettings, type ClaimStatus, type ClientReply, type FollowOnClaim,
  type FollowOnPorts, type FollowOnState, type ResumeFile, type StoredClaimForm,
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
  /**
   * TTTFG-4830: the client said the claim isn't theirs (NOT_THEIRS, a Follow-up the broker hasn't closed) and hasn't
   * said since that it is (THEIRS). Tina asks nothing about it, and the morning reminder passes it over.
   */
  disputed?: true;
  /**
   * TTTFG-4830 (29 Oct 2026): the hold is the client's own CANCEL_REQUEST, not NOT_THEIRS. Carrying on with the claim
   * then tells the broker they no longer want to cancel (CANCEL_WITHDRAWN) rather than that it is theirs.
   */
  cancelling?: true;
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
  /**
   * Claude, for "which claim?": the claim the client chose, by id or by its number in the question (1, 2, …). TTTFG-4830
   * (29 Oct 2026): also the claim a cancel names, when several are open ("cancel my windscreen claim").
   */
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
  /**
   * TTTFG-4830, Claude: the client doesn't want to go on with the claim's questions. 'not-theirs': they say the claim
   * isn't theirs (they never logged it, it's fraud or a mistake). 'something-else': Tina can't tell what they need (the
   * wrong claim, cancel it, a person, another matter). `said`: the message, for the broker.
   */
  offTrack?: { kind: 'not-theirs' | 'something-else' | 'cancel'; said: string };
  /** TTTFG-4830, Claude, for "What would you like to do?" (CLARIFY_CHOICES): what the client chose. */
  clarify?: ClarifyChoice;
}

/** TTTFG-4830: the answers to "What would you like to do?". 'nothing': "No, thanks". 'cancel' (28 Oct 2026): "Yes, cancel it". */
export type ClarifyChoice = 'new-claim' | 'carry-on' | 'broker' | 'nothing' | 'cancel';
export const CLARIFY_CHOICE_KINDS = ['new-claim', 'carry-on', 'broker', 'nothing', 'cancel'] as const satisfies readonly ClarifyChoice[];
/** Why Tina asked: the client said it isn't theirs, she couldn't tell what they need, or (28 Oct 2026) they asked to cancel it. */
export type ClarifyWhy = 'disputed' | 'unsure' | 'cancel';

/** A question of this file, waiting for the client's answer. */
export type Pending =
  /**
   * `claimIds` in the order the question named them. `facts` (TTTFG-4830, 28 Oct 2026): what the message that made Tina
   * ask said about an incident, so "New claim" starts from it rather than asking what happened again. `cancel` (29 Oct
   * 2026): the client asked to cancel (their words), so the claim they pick gets "Do you want to cancel …?".
   */
  | { kind: 'which-claim'; claimIds: string[]; held: ResumeFile[]; facts?: Facts; cancel?: string }
  /**
   * `facts`: the new incident as Claude read it. `back`: the follow-on conversation the question interrupted, so a no
   * goes straight back to it.
   */
  | { kind: 'new-claim'; held: ResumeFile[]; facts?: Facts; back?: FollowOnState }
  /**
   * TTTFG-4830: "What would you like to do?" about claim `claimId`. `why` 'disputed': the client said it isn't theirs
   * (now or before); 'unsure': Tina couldn't tell what they need. `said`: their message, for the broker. `back`: as for
   * 'new-claim'. `facts` (29 Oct 2026): as for 'which-claim', for "Open a new claim".
   */
  | { kind: 'clarify'; claimId: string; why: ClarifyWhy; said?: string; held: ResumeFile[]; back?: FollowOnState; facts?: Facts };

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
   * `introSent`: a stale follow-on state of this claim says the duty of disclosure already went out. `confirmed`
   * (TTTFG-4830): the client said a claim they had said wasn't theirs is theirs after all (THEIRS is written first).
   */
  | { kind: 'resume'; claimId: string; files: ResumeFile[]; lead: 'Welcome back.' | 'Thanks.'; introSent?: true; confirmed?: true }
  /** A no to "new claim?" in the middle of a conversation: straight back to it, without the welcome-back list. */
  | { kind: 'back'; claimId: string; files: ResumeFile[]; followOn: FollowOnState; confirmed?: true }
  /** `ask` false: a file arrived while the question was out; it's held and nothing is said. */
  | { kind: 'ask-which'; claims: OpenClaim[]; held: ResumeFile[]; ask: 'first' | 'again' | false; facts?: Facts; cancel?: string }
  | { kind: 'ask-new'; held: ResumeFile[]; facts?: Facts; back?: FollowOnState; ask: 'first' | 'again' | false }
  /**
   * A yes to "new claim?": the 5168 walkthrough starts with what the client already said about the incident. Held
   * files are kept for the new claim (the host passes them to the follow-on's start). `dispute` (TTTFG-4830): the same
   * message said this other claim isn't theirs; the broker gets NOT_THEIRS first.
   */
  | { kind: 'start-new'; held: ResumeFile[]; facts?: Facts; dispute?: { claimId: string; said: string } }
  /**
   * TTTFG-4830: "What would you like to do?" about this claim. `dispute`: the client just said it isn't theirs, so the
   * broker gets NOT_THEIRS first. `question`: the client asked something meanwhile, answered or passed on first.
   */
  | {
    kind: 'clarify'; claimId: string; why: ClarifyWhy; said?: string; held: ResumeFile[]; back?: FollowOnState;
    ask: 'first' | 'again' | false; dispute?: true; question?: { question: string; help?: string }; facts?: Facts;
  }
  /**
   * TTTFG-4830: the answer to "What would you like to do?" was their broker or nothing for now, or (28 Oct 2026) yes to
   * "Do you want to cancel …?". Held files go to the claim.
   */
  | { kind: 'clarified'; claimId: string; why: ClarifyWhy; choice: 'broker' | 'nothing' | 'cancel'; said?: string; held: ResumeFile[] };

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
  // TTTFG-4830: a claim the client said isn't theirs is never resumed or offered in "which claim?". With only such
  // claims open, Tina asks what they'd like to do instead.
  // TTTFG-4830 (29 Oct 2026): `facts` as resumeOrAsk got them, so "Open a new claim" starts from them (B5).
  const onHold = (c: OpenClaim, more: ResumeFile[], facts?: Facts): Decision =>
    ({ kind: 'clarify', claimId: c.id, why: 'disputed', held: more, ask: 'first', ...(facts ? { facts } : {}) });
  // TTTFG-4830 (29 Oct 2026): "Do you want to cancel …?" about claim `c`. A held claim is with the broker already.
  const askCancel = (c: OpenClaim, more: ResumeFile[], said?: string, back?: FollowOnState, facts?: Facts): Decision =>
    (c.disputed ? onHold(c, more, facts) : { kind: 'clarify', claimId: c.id, why: 'cancel', said, held: more, back, ask: 'first' });
  /** `cancel` (29 Oct 2026): the client asked to cancel (their words), so the claim it is about gets the cancel question. */
  const resumeOrAsk = (more: ResumeFile[], lead: 'Welcome back.' | 'Thanks.', facts?: Facts, cancel?: string): Decision => {
    const live = claims.filter((c) => !c.disputed);
    if (live.length === 0) return onHold(claims[0], more, facts);
    if (live.length > 1) return { kind: 'ask-which', claims: live, held: more, ask: 'first', ...(facts ? { facts } : {}), ...(cancel !== undefined ? { cancel } : {}) };
    return cancel !== undefined ? askCancel(live[0], more, cancel) : { kind: 'resume', claimId: live[0].id, files: more, lead };
  };
  const p = state.pending;

  if (p?.kind === 'clarify') {
    const more = [...p.held, ...files];
    const claim = claims.find((c) => c.id === p.claimId);
    // The claim closed while the question was out (the broker withdrew it, say): as for any message.
    if (!claim) return resumeOrAsk(more, 'Welcome back.', p.facts);
    // TTTFG-4830 (29 Oct 2026): the cancel words answer any of these questions. At "Do you want to cancel …?" they are
    // the yes; readReply never takes Claude's reading for that yes, only the tap, the cancel words or a plain yes.
    const choice = message.clarify
      ?? (message.offTrack?.kind === 'cancel' ? 'cancel' : undefined)
      ?? (message.newClaim || message.differentIncident ? 'new-claim' : undefined);
    if (choice === 'new-claim') {
      return { kind: 'start-new', held: more, facts: message.differentIncident && message.facts ? { ...p.facts, ...message.facts } : p.facts };
    }
    // "No, thanks" to "Do you want to cancel …?" is a no to cancelling: back to the claim.
    if (choice === 'carry-on' || (choice === 'nothing' && p.why === 'cancel')) {
      const confirmed = p.why === 'disputed' ? { confirmed: true as const } : {};
      return p.back
        ? { kind: 'back', claimId: claim.id, files: more, followOn: p.back, ...confirmed }
        : { kind: 'resume', claimId: claim.id, files: more, lead: 'Thanks.', ...confirmed };
    }
    // "Yes, cancel it" only answers "Do you want to cancel …?".
    if (choice === 'cancel' && p.why !== 'cancel') return askCancel(claim, more, message.offTrack?.said ?? p.said, p.back, p.facts);
    if (choice) return { kind: 'clarified', claimId: claim.id, why: p.why, choice, said: p.said, held: more };
    // Not theirs, said now about a claim Tina was only unsure about: the broker is told, and the question says so.
    if (message.offTrack?.kind === 'not-theirs' && p.why !== 'disputed' && !claim.disputed) {
      return { kind: 'clarify', claimId: claim.id, why: 'disputed', said: message.offTrack.said, held: more, back: p.back, ask: 'first', dispute: true };
    }
    const question = u.kind === 'question' ? { question: u.question, ...(u.help ? { help: u.help } : {}) } : undefined;
    return {
      kind: 'clarify', claimId: claim.id, why: p.why, said: p.said, held: more, back: p.back,
      ask: question ? 'first' : files.length ? false : 'again', ...(question ? { question } : {}), ...(p.facts ? { facts: p.facts } : {}),
    };
  }

  if (p?.kind === 'new-claim') {
    const held = [...p.held, ...files];
    if (message.yesNo === true || message.newClaim) return { kind: 'start-new', held, facts: p.facts };
    // TTTFG-4830 (29 Oct 2026): "cancel" here is about the claim Tina was on, else the client's open claim.
    if (message.offTrack?.kind === 'cancel') {
      const on = p.back && claims.find((c) => c.id === p.back!.claimId);
      return on ? askCancel(on, held, message.offTrack.said, p.back) : resumeOrAsk(held, 'Thanks.', undefined, message.offTrack.said);
    }
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
    // TTTFG-4830 (29 Oct 2026): a cancel, before "which claim?" or with the answer, is about the claim picked.
    const cancel = p.cancel ?? (message.offTrack?.kind === 'cancel' ? message.offTrack.said : undefined);
    const pick = (c: OpenClaim): Decision =>
      (cancel !== undefined ? askCancel(c, held, cancel) : { kind: 'resume', claimId: c.id, files: held, lead: 'Welcome back.' });
    if (chosen) return pick(chosen);
    // TTTFG-4830 (28 Oct 2026): "New claim" starts from what the first message said (a break-in at home), so Tina
    // doesn't ask what kind of claim it is.
    const facts = p.facts || message.facts ? { ...p.facts, ...message.facts } : undefined;
    if (message.newClaim) return { kind: 'start-new', held, facts };
    if (message.differentIncident) return { kind: 'ask-new', held, facts, ask: 'first' };
    // A claim closed while the question was out: the one left, or ask again about the claims open now.
    if (asked.length === 1) return pick(asked[0]);
    if (asked.length === 0) return resumeOrAsk(held, 'Welcome back.', p.facts, cancel);
    return {
      kind: 'ask-which', claims: asked, held, ask: files.length ? false : 'again', ...(p.facts ? { facts: p.facts } : {}), ...(cancel !== undefined ? { cancel } : {}),
    };
  }

  const f = state.followOn;
  const current = f && claims.find((c) => c.id === f.claimId);
  const last = current?.lastClientMessageOn ? Date.parse(current.lastClientMessageOn) : now.getTime();
  // TTTFG-4830 (still need): a reply to the list of what's still needed (the morning reminder too) goes on the list.
  const listed = f?.phase === 'still-need' && f.listedAt ? Date.parse(f.listedAt) : 0;
  const fresh = !!current && now.getTime() - Math.max(last, listed) < resumeAfterHours * HOUR;
  const back = fresh && !current.disputed ? f! : undefined;

  // TTTFG-4830: "this claim is fraud, I never logged it". The claim it is about is the one Tina is on, else the only
  // one open. The broker is told at once (unless it's already held), Tina stops her questions and offers a new claim.
  const about = current ?? (claims.length === 1 ? claims[0] : undefined);
  const off = message.offTrack;
  if (off?.kind === 'not-theirs' && about) {
    if (message.newClaim || message.differentIncident) {
      return { kind: 'start-new', held: files, facts: message.facts, ...(about.disputed ? {} : { dispute: { claimId: about.id, said: off.said } }) };
    }
    return { kind: 'clarify', claimId: about.id, why: 'disputed', said: off.said, held: files, back, ask: 'first', ...(about.disputed ? {} : { dispute: true }) };
  }

  // TTTFG-4830 (28 Oct 2026, TTT's feedback): "cancel my claim". Tina asks to be sure, then tells the broker. 29 Oct: the
  // claim the client named ("cancel my windscreen claim"), else as above; with several open and none named, "which
  // claim?" first, and the claim picked gets the question.
  if (off?.kind === 'cancel') {
    const c = claims.find((x) => x.id === message.chosenClaim) ?? about;
    return c ? askCancel(c, files, off.said, c === current ? back : undefined) : resumeOrAsk(files, 'Welcome back.', undefined, off.said);
  }

  // TTTFG-4830: the client already said it's a new claim, so it isn't asked.
  if (message.newClaim) return { kind: 'start-new', held: files, facts: message.facts };
  if (message.differentIncident) return { kind: 'ask-new', held: files, facts: message.facts, back, ask: 'first' };

  // TTTFG-4830: Tina can't tell what the client needs, and the message answers nothing: she asks, rather than say
  // "Sorry, I didn't quite get that" and go on with her questions.
  const answersNothing = (u.kind === 'unparsed' || u.kind === 'question') && !('also' in u && u.also?.length) && !('corrections' in u && u.corrections?.length);
  if (off?.kind === 'something-else' && about && answersNothing) {
    return { kind: 'clarify', claimId: about.id, why: about.disputed ? 'disputed' : 'unsure', said: off.said, held: files, back, ask: 'first' };
  }

  if (current?.disputed) return onHold(current, files, message.facts);
  if (current) {
    // A late answer to Tina's last question can only be about that claim. A "hi" or a file after a gap starts afresh.
    if (fresh || (u.kind !== 'unparsed' && u.kind !== 'file')) return { kind: 'continue', claimId: current.id };
    const d = resumeOrAsk(files, 'Welcome back.', message.facts);
    return d.kind === 'resume' && d.claimId === current.id && f.introSent ? { ...d, introSent: true } : d;
  }
  return resumeOrAsk(files, 'Welcome back.', message.facts);
}

// ------------------------------------------------------------------------------------------------------- the texts

/** dd/mm/yyyy in South Africa. */
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg', day: '2-digit', month: '2-digit', year: 'numeric' });

/** TTTFG-4830 (28 Oct 2026): TTT calls a phone or laptop claim "All risk". The morning reminder names it the same way. */
export const claimWords = (t: ClaimType) => (t === 'Portable possessions' ? 'all risk' : t.toLowerCase());

/** TTTFG-5262 step 6. Fixed text. */
export const NEW_CLAIM_QUESTION = 'Is this a new claim?';
export const NEW_CLAIM_AGAIN = 'Sorry, I didn\'t quite get that. Is this a new claim? Please just answer yes or no.';
/** Sent when files held for an earlier question are kept for the new claim the client is starting. */
export const heldFilesKept = (n: number) =>
  n === 1 ? "I'll add the file you sent to the new claim once it's open." : `I'll add the ${n} files you sent to the new claim once it's open.`;
/** A no to "Is this a new claim?" in the middle of a conversation: the words in front of the question Tina was on. */
export const backTo = (claimType: ClaimType) => `No problem, back to your ${claimWords(claimType)} claim.`;

/**
 * TTTFG-4830 (28 Oct 2026): the broker's Follow-up when the client says a claim isn't theirs. Urgent: it may be fraud
 * on their policy. Found again by its name (riivo_subject) while it is open, to hold the claim (OpenClaim.disputed).
 * DRAFT WORDING, as the other broker texts.
 */
export const NOT_THEIRS = {
  name: 'Claim - client says not theirs',
  version: 'draft-1',
  urgencyReason: 'The client says the claim is not theirs',
  render: (v: { reference: string; said: string }) => `Claim ${v.reference}: the client says on WhatsApp it isn't theirs or isn't right: `
    + `"${v.said}". Tina has stopped asking them about it, and the morning reminders are held. Please check it with them (it may be `
    + 'fraud or a mistake), then withdraw the claim, or close this follow-up to carry on with it.',
} as const;
/** TTTFG-4830: the client said a claim they had said wasn't theirs is theirs after all. It lifts the hold. */
export const THEIRS = {
  name: 'Claim - client says theirs',
  version: 'draft-1',
  render: (v: { reference: string }) => `Claim ${v.reference}: the client said on WhatsApp it is theirs after all, and carried on with it.`,
} as const;
/**
 * TTTFG-4830 (28 Oct 2026, TTT's feedback): the broker's Follow-up when the client confirms they want to cancel a claim.
 * Urgent, and it holds the claim like NOT_THEIRS (resume-dataverse.ts): no questions, no reminders, until the broker
 * closes it or the client carries on (CANCEL_WITHDRAWN).
 */
export const CANCEL_REQUEST = {
  name: 'Claim - client asks to cancel',
  version: 'draft-1',
  urgencyReason: 'The client asks to cancel the claim',
  render: (v: { reference: string; said: string }) => `Claim ${v.reference}: the client asked on WhatsApp to cancel it`
    + `${v.said ? `: "${v.said}"` : ''}. Tina has stopped asking them about it, and the morning reminders are held. Please confirm `
    + 'with them, then withdraw the claim, or close this follow-up to carry on with it.',
} as const;
/**
 * TTTFG-4830 (29 Oct 2026): the client carried on with a claim they had asked to cancel. The CANCEL_REQUEST can't be
 * closed from here, so the broker gets a Follow-up, urgent like the request it answers (they may be about to withdraw
 * the claim). It lifts the hold like THEIRS.
 */
export const CANCEL_WITHDRAWN = {
  name: 'Claim - client no longer cancelling',
  version: 'draft-1',
  urgencyReason: 'The client no longer wants to cancel the claim',
  render: (v: { reference: string }) => `Claim ${v.reference}: the client said on WhatsApp they no longer want to cancel it, and `
    + 'carried on with it. Tina is asking them about it again, and the morning reminders are back on. Please don\'t withdraw '
    + 'the claim, and close their cancel follow-up.',
} as const;

/** TTTFG-4830: the Follow-up when the client chose "Talk to my broker". */
export const talkToBrokerDetail = (reference: string, said?: string) =>
  `The client asked on WhatsApp to talk to you about claim ${reference}.${said ? ` They wrote: "${said}".` : ''} Please contact them.`;

/** TTTFG-4830: the taps for "What would you like to do?" (WhatsApp buttons: 20 characters at most). */
export const CLARIFY_CHOICES: Record<ClarifyChoice, Choice> = {
  'new-claim': { title: 'Open a new claim' },
  'carry-on': { title: 'Carry on with claim' },
  broker: { title: 'Talk to my broker' },
  nothing: { title: 'No, thanks' },
  cancel: { title: 'Yes, cancel it' },
};
/** A claim the client says isn't theirs: a new claim first. Cancel: yes or carry on. Otherwise the claim first. Never more than three. */
export const clarifyChoices = (why: ClarifyWhy): Choice[] =>
  (why === 'disputed' ? (['new-claim', 'nothing', 'carry-on'] as const) : why === 'cancel' ? (['cancel', 'carry-on'] as const)
    : (['carry-on', 'new-claim', 'broker'] as const)).map((k) => CLARIFY_CHOICES[k]);

/** What the texts below say about the claim. They never name the broker (TTT's feedback, 28 Oct 2026). */
export interface ClaimLabel { reference: string; claimType: ClaimType; incidentAt: string }
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "claim *CLM-000313* (motor accident, 26/10/2026)": enough for the client to know which one. */
const claimRef = (c: ClaimLabel) => `claim *${c.reference}* (${claimWords(c.claimType)}, ${shortDate(c.incidentAt)})`;

/**
 * TTTFG-4830: "What would you like to do?". `how`: 'dispute' right after the client said it isn't theirs (the broker
 * was just told); 'first' when Tina raises it; 'again' after a reply she couldn't read; 'after-question' after she
 * answered or passed on a question.
 */
export function clarifyText(why: ClarifyWhy, claim: ClaimLabel, how: 'dispute' | 'first' | 'again' | 'after-question'): string {
  if (why === 'cancel') {
    const ask = `Do you want to cancel your ${claimWords(claim.claimType)} claim *${claim.reference}*?`;
    return how === 'again' ? `Sorry, I didn't quite get that. ${ask}` : ask;
  }
  const ask = why === 'disputed' ? 'Would you like to open a new claim?' : 'What would you like to do?';
  if (how === 'again') return `Sorry, I didn't quite get that. ${ask}`;
  if (how === 'after-question') return ask;
  if (why === 'unsure') return `Sorry, I'm not sure what you need. I was asking about your ${claimWords(claim.claimType)} claim *${claim.reference}*.\n\n${ask}`;
  if (how === 'dispute') {
    return `I'm sorry about that. I've asked ${CLIENT_BROKER} to look into ${claimRef(claim)} and contact you. I won't ask you anything `
      + 'more about it for now.\n\nWould you like to open a new claim instead?';
  }
  return `${sentence(CLIENT_BROKER)} is looking into ${claimRef(claim)}, so I won't ask you anything more about it for now.\n\n${ask}`;
}

/** TTTFG-4830: the answer to "What would you like to do?" was their broker, or nothing for now. */
export function clarifiedText(why: ClarifyWhy, choice: 'broker' | 'nothing' | 'cancel', claim: ClaimLabel): string {
  if (choice === 'cancel') {
    return `No problem. I've asked ${CLIENT_BROKER} to cancel claim *${claim.reference}*. They'll confirm it with you, and I won't ask you anything more about it.`;
  }
  if (why === 'disputed') return `No problem. ${sentence(CLIENT_BROKER)} will contact you about claim *${claim.reference}*.`;
  if (choice === 'broker') return `I've asked ${CLIENT_BROKER} to contact you about your ${claimWords(claim.claimType)} claim *${claim.reference}*.`;
  return 'No problem. Message me here whenever you need me.';
}

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
  claim?: { status: ClaimStatus },
): string {
  const names = missingNames(missing);
  if (names.length) return `${lead} For your ${claimWords(claimType)} claim we still need: ${list(names)}.`;
  if (!claim) return lead;
  const owner = sentence(CLIENT_BROKER);
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
      if (d.confirmed) await theirsAfterAll(ports, open.find((c) => c.id === d.claimId)!, at);
      if (!d.files.length) await welcomeBack(ports, conv, d.claimId, d.lead, now, settings);
      const r = await followOnTurn(ports, conv, null, { kind: 'resume', claimId: d.claimId, wamid: message.understood.wamid, files: d.files, introSent: d.introSent }, now, settings);
      return { route: 'claim', state: { followOn: r.state, pending: null } };
    }

    case 'ask-which': {
      await touchAll();
      if (d.ask) await sendText(ports, conv, whichClaimText(d.claims, d.ask === 'again'), null, at);
      const pending: Pending = {
        kind: 'which-claim', claimIds: d.claims.map((c) => c.id), held: d.held, ...(d.facts ? { facts: d.facts } : {}), ...(d.cancel !== undefined ? { cancel: d.cancel } : {}),
      };
      return { route: 'claim', state: { followOn: null, pending } };
    }

    case 'ask-new':
      await touchAll();
      if (d.ask) await sendText(ports, conv, d.ask === 'again' ? NEW_CLAIM_AGAIN : NEW_CLAIM_QUESTION, null, at);
      return { route: 'claim', state: { followOn: null, pending: { kind: 'new-claim', held: d.held, ...(d.facts ? { facts: d.facts } : {}), ...(d.back ? { back: d.back } : {}) } } };

    case 'back': {
      const claim = open.find((c) => c.id === d.claimId)!;
      if (d.confirmed) await theirsAfterAll(ports, claim, at);
      const r = await followOnTurn(ports, conv, null, {
        kind: 'resume', claimId: d.claimId, wamid: message.understood.wamid, files: d.files, introSent: true,
        lead: backTo(claim.claimType), skipped: d.followOn.skipped,
      }, now, settings);
      return { route: 'claim', state: { followOn: r.state, pending: null } };
    }

    case 'start-new': {
      if (d.dispute) await ports.createAgentAction(notTheirsRow(await ports.loadClaim(d.dispute.claimId), d.dispute.said, at));
      if (d.held.length) await sendText(ports, conv, heldFilesKept(d.held.length), null, at);
      const t = await claimTurn(ports, conv, null, { kind: 'start', facts: d.facts }, now);
      return { route: 'new-claim', walkthrough: t.state, held: d.held };
    }

    case 'clarify': {
      await touchAll();
      const claim = await ports.loadClaim(d.claimId);
      const to = { id: claim.id, owner: claim.owner };
      if (d.dispute) await ports.createAgentAction(notTheirsRow(claim, d.said ?? '', at));
      if (d.question?.help) await sendText(ports, conv, d.question.help, to, at, claim.contactId);
      else if (d.question) {
        await ports.createAgentAction({
          kind: 'Follow-up', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claim.id }, contactId: claim.contactId,
          detail: clientQuestionDetail(d.question.question), at,
        });
        await sendText(ports, conv, toBrokerText(), to, at, claim.contactId);
      }
      if (d.ask) {
        const how = d.dispute ? 'dispute' : d.question ? 'after-question' : d.ask === 'again' ? 'again' : 'first';
        await sendText(ports, conv, clarifyText(d.why, labelOf(claim), how), to, at, claim.contactId, clarifyChoices(d.why));
      }
      const pending: Pending = {
        kind: 'clarify', claimId: d.claimId, why: d.why, held: d.held, ...(d.said ? { said: d.said } : {}), ...(d.back ? { back: d.back } : {}),
        ...(d.facts ? { facts: d.facts } : {}),
      };
      return { route: 'claim', state: { followOn: null, pending } };
    }

    case 'clarified': {
      await touchAll();
      const claim = await ports.loadClaim(d.claimId);
      // Files sent while the question was out are the claim's: the broker sees them there.
      for (const h of d.held) {
        if (h.file.media === 'video') await ports.storeVideo(h.file, { claimId: claim.id, itemKey: h.forItem });
        else await ports.fileToPipeline(h.file, { claimId: claim.id, itemKey: h.forItem });
      }
      if (d.choice === 'cancel') {
        await ports.createAgentAction({
          kind: 'Follow-up', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claim.id }, contactId: claim.contactId,
          detail: CANCEL_REQUEST.render({ reference: claim.reference, said: d.said ?? '' }), urgent: true, urgencyReason: CANCEL_REQUEST.urgencyReason,
          template: { name: CANCEL_REQUEST.name, version: CANCEL_REQUEST.version }, at,
        });
      }
      // TTTFG-4830 (29 Oct 2026): at "Do you want to cancel …?" too. A held claim's broker already has a Follow-up.
      if (d.why !== 'disputed' && d.choice === 'broker') {
        await ports.createAgentAction({
          kind: 'Follow-up', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claim.id }, contactId: claim.contactId,
          detail: talkToBrokerDetail(claim.reference, d.said), at,
        });
      }
      await sendText(ports, conv, clarifiedText(d.why, d.choice, labelOf(claim)), { id: claim.id, owner: claim.owner }, at, claim.contactId);
      return { route: 'claim', state: NO_RESUME_STATE };
    }
  }
}

const labelOf = (c: FollowOnClaim): ClaimLabel => ({ reference: c.reference, claimType: c.claimType, incidentAt: c.facts.incidentAt });

/** TTTFG-4830: the broker's urgent Follow-up for a claim the client says isn't theirs. */
const notTheirsRow = (claim: FollowOnClaim, said: string, at: string): AgentActionRow => ({
  kind: 'Follow-up', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claim.id }, contactId: claim.contactId,
  detail: NOT_THEIRS.render({ reference: claim.reference, said }), urgent: true, urgencyReason: NOT_THEIRS.urgencyReason,
  template: { name: NOT_THEIRS.name, version: NOT_THEIRS.version }, at,
});

/**
 * TTTFG-4830: written when the client carries on with a claim they had said wasn't theirs; it lifts the hold. 29 Oct
 * 2026: a claim they had asked to cancel gets CANCEL_WITHDRAWN instead, a Follow-up for the broker.
 */
async function theirsAfterAll(ports: ResumePorts, held: OpenClaim, at: string) {
  const claim = await ports.loadClaim(held.id);
  const row: Pick<AgentActionRow, 'department' | 'owner' | 'regarding' | 'contactId' | 'at'> = {
    department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claim.id }, contactId: claim.contactId, at,
  };
  await ports.createAgentAction(held.cancelling
    ? {
      ...row, kind: 'Follow-up', detail: CANCEL_WITHDRAWN.render({ reference: claim.reference }), urgent: true,
      urgencyReason: CANCEL_WITHDRAWN.urgencyReason, template: { name: CANCEL_WITHDRAWN.name, version: CANCEL_WITHDRAWN.version },
    }
    : { ...row, kind: 'Created', detail: THEIRS.render({ reference: claim.reference }), template: { name: THEIRS.name, version: THEIRS.version } });
}

/** The welcome-back line, from the claim record: what's missing is worked out now, not remembered. */
async function welcomeBack(ports: ResumePorts, conv: Conversation, claimId: string, lead: 'Welcome back.' | 'Thanks.', now: Date, settings: ResumeSettings) {
  const claim = await ports.loadClaim(claimId);
  const form: StoredClaimForm = claim.claimFormId
    ? await ports.claimForm(claim.claimFormId)
    : (await ports.activeClaimForm(claim.providerId, claim.claimType)) ?? (await ports.genericClaimForm());
  const missing = resumeMissing({ claim, form, now, warningDays: settings.notificationWarningDays ?? CLAIM_SETTINGS_DEFAULTS.notificationWarningDays });
  const text = welcomeBackText(claim.claimType, missing, lead, { status: claim.status });
  await sendText(ports, conv, text, { id: claim.id, owner: claim.owner }, now.toISOString());
}
