// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/followon.ts (commit da163a4). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5176: the claim conversation after the acknowledgement (SPEC-04 "Tina's claim walkthrough" steps 7 to 9).
// claimTurn() in claim.ts ends with { state: null, claim } once the FNOL acknowledgement is sent; this file takes over
// with its own state machine, keyed by claim id, and its own turn function in the same style.
//
// Order, all in code (TTTFG-5254 step 3): SAPS step (when needed) -> notification deadline note (when needed) -> duty
// of disclosure -> the form's questions -> the signing step -> evidence items, one at a time -> complete. Claude only
// turns the client's reply into a typed value (FollowOnInput) and may rephrase a question (the `phrase` port). It never
// decides what comes next, and it writes none of the fixed texts.
//
// The state holds only where the conversation is (which key was asked, how many misses). What is answered and what is
// missing is read from the claim every turn (progress.ts), because the claim record is the source of truth: the
// client may continue later (TTTFG-5184) or by email (TTTFG-5188).
//
// Things this story must not do (TTTFG-5254 "Agent context"):
// - Flags: Late notification and SAPS case missing are TTTFG-5263's. Nothing here writes riivo_claimflag or
//   riivo_latenotification, and no flag reaches Tina's reply.
// - Filing: Tina never files a file herself. Photos and documents go to the document pipeline (TTTFG-4945) with the
//   claim id; a video is stored and recorded but never read (no OCR, no model).
//
// TTTFG-5184 added the `resume` input: the client comes back to a claim after the conversation ended (resume.ts
// decides that). resumeFollowOn() rebuilds the state from the claim record alone, so the duty of disclosure and the
// deadline note are not sent again, and the conversation carries on from the first missing item.
//
// TTTFG-4830 (batches): the questions of one section of the form go out together, up to five in a numbered list
// (progress.ts nextBatch). The client may answer them in one message or in several. Every message's answers are saved
// at once; what is still open is listed again only when the client goes quiet (the host sends `nudge` after a quiet
// spell, when it can: ClaimSettings.waitForMore) or straight away when it can't. A question listed again and still open
// the next time goes to the broker, as after two misses on one question. Forms without sections are asked one question
// at a time, as before.
//
// TTTFG-4830 (still need): when everything has been asked, what the client still has to get (the items a form marks
// `chase`, the required evidence, the SAPS case number) goes out as one list, "Things we still need from you:", and the
// conversation stays on it (phase `still-need`): whatever the client sends next is read against the list, and the
// morning reminder (reminder.ts) puts a client back on it. "I don't know" to one of those items is "not yet", so it
// stays the client's to send; the broker takes only what the client can't get.
import { DEPARTMENT, type AgentActionRow, type Conversation, type Outbound, type Owner } from './claim';
import type { AnswerRecord, ClaimAnswers, ClaimForm, QuestionItem, RequestClaimSignature } from './contracts';
import { formatProblem } from './formats';
import { claimGate } from './gate';
import {
  applies, chased, deferred, evidenceIn, fileCount, filesFor, formItems, itemName, missingItems, nextBatch, nextItem, sapsStepApplies, SAPS_CASE_KEY,
  SAPS_ITEMS, SAPS_STATION_KEY,
  type ClaimFacts, type ReceivedEvidence,
} from './progress';
import { DEADLINE_PASSED_TEMPLATE, DEADLINE_UPCOMING_TEMPLATE, DISCLOSURE_TEMPLATE, itOrThem, type ClaimTemplate } from './templates';
import { VOICE_OR_TEXT, type ClaimType, type Facts } from './walkthrough';

/**
 * Package settings. `claims.notificationWarningDays`: send the Upcoming note when this many days or fewer are left.
 * `waitForMore` (TTTFG-4830): the host calls back with { kind: 'nudge' } after a quiet spell, so when a message answers
 * part of a batch Tina waits for the rest instead of listing what's open straight away.
 */
export interface ClaimSettings { notificationWarningDays?: number; waitForMore?: boolean }
export const CLAIM_SETTINGS_DEFAULTS = { notificationWarningDays: 7 } as const;

/** riivo_claim.riivo_claimstatus (TTTFG-4885). */
export type ClaimStatus =
  | 'FNOL logged' | 'Cover verified' | 'Form sent' | 'Awaiting client docs' | 'Pack complete' | 'Submitted to insurer'
  | 'Under assessment' | 'Additional info requested' | 'Approved' | 'Partially approved' | 'Rejected' | 'Representations'
  | 'Ombud' | 'Settled' | 'Closed' | 'Withdrawn';
/** riivo_claim.riivo_signaturestatus (TTTFG-4885). */
export type SignatureStatus = 'Not sent' | 'Link sent' | 'Signed';

/** A riivo_claimform row. */
export type StoredClaimForm = ClaimForm & { id: string };

/** What this story reads from the riivo_claim row and its linked documents. */
export interface FollowOnClaim {
  id: string;
  reference: string;
  /** riivo_claim.riivo_contact: the agent actions name the client (TTTFG-5168 does the same). */
  contactId?: string;
  providerId: string;
  insurer: string;
  claimType: ClaimType;
  /** The walkthrough's facts on the claim row; `incidentAt` drives the deadline note. */
  facts: Facts & { incidentAt: string };
  sapsCaseNumber?: string;
  sapsStation?: string;
  /** riivo_claim.riivo_sapsrequired (TTTFG-5184): the SAPS step applies, set when the follow-on starts. */
  sapsRequired?: boolean;
  /**
   * TTTFG-5184: the duty of disclosure already went out on this claim (its Created agent action exists), so a client
   * who comes back is never sent it twice, even if they stopped before answering anything.
   */
  introSent?: boolean;
  status: ClaimStatus;
  signatureStatus: SignatureStatus;
  /** riivo_claim.riivo_claimform, once set. */
  claimFormId?: string;
  /** riivo_claim.riivo_answers. */
  answers: ClaimAnswers;
  /** riivo_clientdocument rows linked to the claim, by question list item. */
  evidence: ReceivedEvidence;
  owner: Owner;
  /**
   * TTTFG-4830: the client's address on the CRM (contact.address1_composite), for the address check. null: the CRM has
   * none (Tina asks for it). Absent: the host didn't read it, so there's no check.
   */
  contactAddress?: string | null;
}

/** A file the client sent on WhatsApp. `media` comes from the WhatsApp message type. */
export interface ClientFile { id: string; fileName: string; mimeType: string; media: 'photo' | 'document' | 'video' }

export interface FollowOnPorts {
  loadClaim(claimId: string): Promise<FollowOnClaim>;
  /** The active riivo_claimform for this provider and claim type, or null. */
  activeClaimForm(providerId: string, claimType: ClaimType): Promise<StoredClaimForm | null>;
  /** The generic row (provider null): an insurer with no mapped form. */
  genericClaimForm(): Promise<StoredClaimForm>;
  claimForm(id: string): Promise<StoredClaimForm>;
  setClaimForm(claimId: string, formId: string): Promise<void>;
  /** riivo_sapscasenumber and riivo_sapsstation; a case number also sets riivo_sapsinvolved = Yes. */
  saveSaps(claimId: string, v: { caseNumber?: string; station?: string }): Promise<void>;
  /**
   * riivo_sapsrequired = Yes (TTTFG-5184). Claude's describedAsTheft lives only in the start message, so the claim keeps
   * whether the SAPS step applies; a client who comes back days later is still asked for the case number.
   */
  setSapsRequired(claimId: string): Promise<void>;
  /** Writes riivo_answers (the whole JSON). */
  saveAnswers(claimId: string, answers: ClaimAnswers): Promise<void>;
  setStatus(claimId: string, status: ClaimStatus): Promise<void>;
  /** riivo_evidencecomplete = Yes. */
  setEvidenceComplete(claimId: string): Promise<void>;
  setLastClientMessageOn(claimId: string, at: string): Promise<void>;
  /** The document pipeline (TTTFG-4945): files it, creates the riivo_clientdocument row with the claim lookup. */
  fileToPipeline(file: ClientFile, to: { claimId: string; itemKey?: string }): Promise<{ documentId: string }>;
  /** A video: into the client's SharePoint claim folder plus a riivo_clientdocument row. Never opened or read. */
  storeVideo(file: ClientFile, to: { claimId: string; itemKey?: string }): Promise<{ documentId: string }>;
  /** The signing seam (signature.ts by default; TTTFG-5192's fill once merged). */
  requestClaimSignature: RequestClaimSignature;
  createAgentAction(row: AgentActionRow): Promise<{ id: string; dueOn?: string }>;
  send(to: string, message: Outbound): Promise<void>;
  /** Claude may rephrase a question in simpler words (never into insurance jargon). Absent: the prompt as written. */
  phrase?(text: string, ask: { key: string; simpler: boolean }): Promise<string>;
}

/** Stored on the Tina conversation, keyed by claim id. Where the conversation is, not what the claim holds. */
export interface FollowOnState {
  claimId: string;
  /**
   * `address` (TTTFG-4830): Tina is confirming the client's home address, between the duty of disclosure and the form.
   * `still-need` (TTTFG-4830): everything has been asked and Tina listed what the client still has to send; each message
   * is read for any of it. `asking` is empty.
   */
  phase: 'saps' | 'address' | 'items' | 'still-need';
  /** The key Tina asked last. */
  asking: string;
  /** Unreadable replies to `asking` in a row. */
  misses: number;
  sapsRequired: boolean;
  /** "Not yet" in this conversation. Still on the missing list. */
  skipped: string[];
  /**
   * TTTFG-4830: the question whose answer Tina said didn't look right (formats.ts). A second such answer is kept. A list
   * in a batch, where several answers may be pointed out.
   */
  formatChecked?: string | string[];
  /**
   * TTTFG-4830 (batches): the questions Tina asked together in her last message, in the order she numbered them;
   * `asking` is the first. Absent: one question at a time.
   */
  batch?: string[];
  /** TTTFG-4830: per question of the batch, how often Tina listed it again because the client's replies left it open. */
  relisted?: Record<string, number>;
  /**
   * TTTFG-4830: the client's message (its wamid) that answered part of the batch. Tina is waiting for the rest; the
   * host's `nudge` with this wamid lists what's still open. A later message replaces it, so an older nudge does nothing.
   */
  waiting?: string;
  /**
   * TTTFG-4830: what Tina is `waiting` for: 'files' when files are coming in for the evidence item she asked (`asking`).
   * Every file sent belongs to it, and she answers once they stop coming (the host waits less long than for answers).
   */
  waitingFor?: 'files';
  /**
   * TTTFG-4830: the evidence item of any number of files (photos of the scene) whose files Tina asked "Are those all of
   * them?" about. A yes takes her on; a no, or more files, keeps her on it.
   */
  confirming?: string;
  /** TTTFG-4830: Tina has said "if you don't know something, just say so" in this conversation. */
  batchHint?: true;
  /** TTTFG-4830: what the last batch was about, so the next one on the same topic says "a few more questions". */
  topic?: string;
  signingRequested: boolean;
  evidenceStarted: boolean;
  /** The deadline note and the duty of disclosure are out (TTTFG-5184: a resume doesn't send them again). */
  introSent?: boolean;
  /**
   * TTTFG-5184: on a resumed claim, the item Tina was left waiting on (asked last time, never answered). When it is
   * asked again it starts "Back to where we left off:", so the client doesn't get the same words twice.
   */
  waitingOn?: string;
  /**
   * TTTFG-4830 (still need): when Tina last sent the client the list of what she still needs (at the end of the
   * questions, or in the morning reminder). A reply within resumeAfterHours of it goes on the list (resume.ts).
   */
  listedAt?: string;
}

/** What Claude understood from the client's message. Code decides what happens next. */
/**
 * TTTFG-4830: a value for a form question other than the one Tina asked, from the same message (or, at the start,
 * from what the client said while reporting the claim). Code checks each one with accept() and saves only values for
 * questions that apply and are still open; it never answers the question Tina is asking, and never starts a new entry
 * of a repeating group.
 */
export interface OtherAnswer { key: string; value: string | number | boolean }

export type FollowOnInput =
  /** Right after claimTurn() opened the claim. `describedAsTheft`: Claude read the description as a theft, burglary or hijacking. */
  | {
    kind: 'start'; claimId: string; describedAsTheft: boolean;
    /** TTTFG-5184: files the client sent before saying yes to "Is this a new claim?", kept for the new claim. */
    files?: ResumeFile[];
    /** TTTFG-4830: form answers Claude read from what the client said while reporting the claim. */
    reported?: OtherAnswer[];
  }
  /**
   * The value for the item being asked. `also`: values the same message gave for other open questions. `corrections`:
   * new values for questions the client answered earlier ("actually no, there was no other car"). `spoken`
   * (TTTFG-4830, here and on the replies below): the message was a voice note, so what is saved from it is said back.
   */
  | { kind: 'value'; value: string | number | boolean; wamid: string; also?: OtherAnswer[]; corrections?: OtherAnswer[]; spoken?: true }
  /**
   * TTTFG-4830: the reply to a batch. `answers`: values for questions of the batch; `dontKnow`: questions of the batch
   * the client says they don't know or don't have; `also` and `corrections` as for 'value'.
   */
  | {
    kind: 'batch'; answers: OtherAnswer[]; dontKnow: string[]; wamid: string; also?: OtherAnswer[]; corrections?: OtherAnswer[]; spoken?: true;
  }
  /**
   * TTTFG-4830: from the host, not the client: the quiet spell after the message `wamid` is over. Tina lists what's still
   * open in the batch, if she is still waiting on that message (FollowOnState.waiting).
   */
  | { kind: 'nudge'; wamid: string }
  | { kind: 'saps'; caseNumber?: string; station?: string; wamid: string; also?: OtherAnswer[]; corrections?: OtherAnswer[]; spoken?: true }
  /** "I don't have it yet." */
  | { kind: 'not-yet'; wamid: string; also?: OtherAnswer[]; corrections?: OtherAnswer[]; spoken?: true }
  /** Claude could not get a value from the reply (for the item asked; `also` and `corrections` may still apply). */
  | { kind: 'unparsed'; wamid: string; also?: OtherAnswer[]; corrections?: OtherAnswer[]; spoken?: true }
  /** `forItem`: Claude's reading of which evidence item the file is, when it can tell (TTTFG-5184). */
  | { kind: 'file'; file: ClientFile; wamid: string; forItem?: string }
  /**
   * TTTFG-5184: the client is back on this claim (resume.ts chose it). Files (a file sent with the message, or files
   * held while Tina asked which claim) are filed against the claim first, each as `forItem` (Claude's reading of which
   * missing item it is) when that item is still missing. Then the first missing item is asked. `introSent`: the
   * conversation's own state (kept, but stale) says the duty of disclosure already went out.
   */
  | {
    kind: 'resume'; claimId: string; wamid: string; files?: ResumeFile[]; introSent?: boolean;
    /** Words in front of the first question, in the same message ("No problem, back to your … claim."). */
    lead?: string;
    /** Items the client said "not yet" to earlier in this same conversation: not asked again. */
    skipped?: string[];
  };

/** A file for a resumed claim, with Claude's reading of which missing item it is. */
export interface ResumeFile { file: ClientFile; forItem?: string }

/** TTTFG-5184: in front of a question that still stands after the client sent something else, so it isn't repeated bare. */
export const SAVED_FILE = "Thanks, I've saved that with your claim. Back to my question:";
export const SAVED_SAPS = "Thanks, I've saved the SAPS case number. Back to my question:";
export const LEFT_OFF = 'Back to where we left off:';
/** TTTFG-4830: "I don't know" to a required question. */
export const BROKER_WILL_CHECK = 'No problem, your broker will check that with you.';
/** TTTFG-4830 (still need): "I don't know" to items the client can get (chased): they go on the list for later. */
export const sendLater = (items: readonly QuestionItem[]) =>
  `No problem, send me ${list(items.map(itemName))} when you have ${items.length === 1 ? 'it' : 'them'}.`;
/** TTTFG-4830 (still need): said after sendLater() when some of the same message's "don't know"s are the broker's. */
export const BROKER_THE_OTHERS = 'Your broker will check the others with you.';
/** TTTFG-4830 (still need): "not yet" to the list. */
export const WHEN_YOU_HAVE_THEM = 'No problem, send them here when you have them.';
/** TTTFG-4830 (still need): the list after the last of the insurer's questions. */
export const ALL_FOR_NOW = "Thanks, that's all for now.";
/** TTTFG-4830: the client changed an earlier answer. */
export const CORRECTED = "No problem, I've changed that.";
/** TTTFG-4830: the reply answered other questions but not the one Tina asked. */
export const NOTED_OTHERS = "Thanks, I've noted that.";
/** TTTFG-4830 (voice notes): around what Tina saved from a voice note, said back first (heardText). */
export const HEARD = { lead: 'From your voice note I noted:', end: 'If I misheard anything, just tell me.' } as const;
/** TTTFG-4830 (batches): said with the first batch of a conversation. */
export const BATCH_HINT = `Answer as best you can, and if you don't know something, just say so. ${VOICE_OR_TEXT}`;
/** TTTFG-4830: what's still open after a reply that answered part of a batch (several, or one). */
export const STILL_NEED = { many: 'Thanks. I still need these:', one: 'Thanks. I still need this one:' } as const;
/** TTTFG-4830: a reply that answered none of the batch. One question left is asked "in simpler words", as before. */
export const SORRY_BATCH = "Sorry, I didn't quite get that. Could you answer these?";
/**
 * TTTFG-4830: files for an evidence item of any number (photos of the scene), once they stop coming: Tina asks whether
 * that's all of them before she moves on.
 */
export const allOfThem = (n: number, item: QuestionItem) =>
  `Thanks, I've got ${n === 1 ? 'that one' : `those ${n}`}. ${n === 1 ? 'Is that' : 'Are those'} all ${itemName(item)}, or do you have more?`;
/** TTTFG-4830: the same, asked again after a reply that wasn't a yes or a no. */
export const allOfThemAgain = (item: QuestionItem) => `Is that all ${itemName(item)}? Please just answer yes or no.`;
/** TTTFG-4830: "No, there are more" to allOfThem. */
export const SEND_THE_REST = "No problem, send the rest here when you're ready.";
/** TTTFG-4830: an evidence item of a set number of files (the front and back): fewer came. */
export const theOthers = (have: number, need: number) =>
  `Thanks, I've got ${have} of the ${need}. Please send me the other${need - have > 1 ? 's' : ' one'} too.`;
/** TTTFG-4830: a file in the middle of a batch, acknowledged while Tina waits for the rest. */
export const FILE_SAVED = "Thanks, I've saved that with your claim.";
/** TTTFG-4830: "Back to my question:" for a batch. */
const plural = (lead: string) => lead.replace(/my question:$/, 'my questions:');

/** TTTFG-5254 step 4: fixed text, sent when the claim has no SAPS case number. */
export const SAPS_INSTRUCTION = "If you haven't yet, please report this to the SAPS. The insurer needs the case number.";
const SAPS_BOTH: QuestionItem = {
  ...SAPS_ITEMS[0],
  prompt: "What is the SAPS case number, and at which police station did you report it? If you don't have a case number yet, just tell me.",
};

// ---------------------------------------------------------------------------------------------------- pure decisions

const DAY = 86_400_000;
/** The calendar date in South Africa (UTC+2, no daylight saving), as YYYY-MM-DD. */
const sastDate = (d: Date) => new Date(d.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
const dayNumber = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`) / DAY;

/**
 * TTTFG-5254 step 5: the deadline is the incident date plus the form's notification period, in calendar days. Upcoming
 * when `warningDays` or fewer are left (the deadline day itself included), Passed after it, otherwise no note.
 */
export function notificationDeadline(
  incidentAt: string, periodDays: number, now: Date, warningDays: number = CLAIM_SETTINGS_DEFAULTS.notificationWarningDays,
): { variant: 'upcoming' | 'passed'; deadline: string; daysLeft: number } | null {
  const deadline = new Date((dayNumber(sastDate(new Date(incidentAt))) + periodDays) * DAY).toISOString().slice(0, 10);
  const daysLeft = dayNumber(deadline) - dayNumber(sastDate(now));
  if (daysLeft < 0) return { variant: 'passed', deadline, daysLeft };
  if (daysLeft <= warningDays) return { variant: 'upcoming', deadline, daysLeft };
  return null;
}

/** Something Tina says or does, in order. */
type Out =
  | { kind: 'saps-instruction' }
  /**
   * `again`: the client said "not yet" to it in an earlier conversation, so it is asked as "Have you got … yet?", not
   * in the same words. `lead`: words in front of the question, in the same message.
   */
  | { kind: 'ask'; item: QuestionItem; simpler: boolean; again?: boolean; lead?: string }
  /**
   * TTTFG-4830: several questions in one numbered message. `intro`: a new batch ("A few questions about your car.",
   * with the hint the first time, "a few more" on the same topic); without it, `lead` says why they're listed again.
   */
  | { kind: 'ask-batch'; items: QuestionItem[]; lead?: string; intro?: { hint: boolean; same: boolean } }
  | { kind: 'saps-required' }
  | { kind: 'text'; text: string }
  | { kind: 'template'; template: ClaimTemplate; text: string }
  | { kind: 'received'; item: QuestionItem }
  | { kind: 'closing' }
  /** `lead` (TTTFG-4830): the words in front of "Things we still need from you:" ('' for none). */
  | { kind: 'still-missing'; items: QuestionItem[]; lead: string }
  | { kind: 'save-answer'; key: string; record: AnswerRecord }
  /** TTTFG-4830: an answer that no longer belongs on the claim (a group entry the client took back). */
  | { kind: 'drop-answer'; key: string }
  | { kind: 'save-saps'; caseNumber?: string; station?: string }
  | { kind: 'file'; file: ClientFile; itemKey?: string }
  | { kind: 'request-signature' }
  | { kind: 'status'; status: 'Awaiting client docs' }
  | { kind: 'evidence-complete' }
  /** TTTFG-4830: open work for the claim's owner (the broker), for example to update the client's address in the CRM. */
  | { kind: 'follow-up'; detail: string };

/** `waitForMore`: ClaimSettings.waitForMore. */
export interface Ctx { claim: FollowOnClaim; form: ClaimForm; now: Date; warningDays: number; waitForMore?: boolean }
/** The claim as it stands within this turn. */
interface Work { answers: ClaimAnswers; evidence: { key: string }[]; facts: ClaimFacts }

export interface Step { state: FollowOnState | null; out: Out[] }

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function work(claim: FollowOnClaim): Work {
  return {
    answers: { ...claim.answers },
    evidence: [...claim.evidence],
    facts: { ...claim.facts, claimType: claim.claimType, sapsCaseNumber: claim.sapsCaseNumber || undefined, sapsStation: claim.sapsStation || undefined },
  };
}

/** TTTFG-4830: a whole message that is only a no ("No", "none", "nobody"). */
export const BARE_NO = /^\s*(no|nope|nah|none|nothing|nobody|no one|n\/?a)\s*[.!]?\s*$/i;
/**
 * A free-text question that "no" answers: one asked as a yes/no ("Does the car have any marks…?") or one that invites
 * it ('Say "no" if not'). "What is that person's full name?" is not.
 */
const NO_INVITED = /^(do|does|did|is|are|was|were|has|have|had|can|could|will|would|any)\b|say "(no|none|nothing|don't know)"|"(no|none)" if/i;

/** The value Claude gave, checked against the item's answer type. undefined = not a usable value (a miss). */
export function accept(item: QuestionItem, v: string | number | boolean): string | number | boolean | undefined {
  const s = typeof v === 'string' ? v.trim() : undefined;
  switch (item.answerType) {
    case 'yes/no':
      return typeof v === 'boolean' ? v : undefined;
    case 'number': {
      const n = typeof v === 'number' ? v : s ? Number(s.replace(/[\s,]/g, '').replace(/^R/i, '')) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case 'date':
      // TTTFG-4830: a month and year (YYYY-MM) is enough for questions like "when did you buy it?".
      if (s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return s;
      return s && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined;
    case 'choice':
      return s ? item.choices?.find((c) => c.toLowerCase() === s.toLowerCase()) : undefined;
    default:
      // TTTFG-4830: "No" is not a name or a number. It answers a free-text question only when the question invites it.
      if (s && BARE_NO.test(s) && !NO_INVITED.test(item.prompt)) return undefined;
      return s || (typeof v === 'number' ? String(v) : undefined);
  }
}

/** The state without what belongs to the question (or batch) Tina was on. */
const moveOn = ({ waitingOn: _o, batch: _b, relisted: _r, waiting: _w, waitingFor: _f, confirming: _c, ...st }: FollowOnState): FollowOnState => st;

/**
 * The next question (or batch of questions, TTTFG-4830) or evidence item, the signing step between them, and the end.
 * `thanks` (TTTFG-4830): the client just finished a batch, so the next question starts with "Thanks.".
 */
function proceed(c: Ctx, w: Work, st: FollowOnState, out: Out[], thanks?: 'Thanks.', listLead: string = ALL_FOR_NOW): FollowOnState | null {
  // The SAPS keys belong to the SAPS step; the questions never ask them again.
  const skip = [...st.skipped, SAPS_CASE_KEY, SAPS_STATION_KEY];
  const batch = nextBatch(c.form, w.answers, w.evidence, { facts: w.facts, sapsRequired: st.sapsRequired, skip });
  const next = batch[0] ?? null;
  const leftOff = next && next.key === st.waitingOn && !deferred(next.key, w.answers) ? LEFT_OFF : undefined;
  const lead = [thanks, leftOff].filter(Boolean).join(' ') || undefined;
  const { topic: before, ...rest } = moveOn(st);
  st = before ? { ...rest, topic: before } : rest;
  if (next?.kind === 'question') {
    const topic = next.section ? batchTopic(batch) : undefined;
    const kept = { ...rest, phase: 'items' as const, asking: next.key, misses: 0, ...(topic ? { topic } : {}) };
    if (batch.length > 1) {
      out.push({ kind: 'ask-batch', items: batch, lead, intro: { hint: !st.batchHint, same: !!topic && topic === before } });
      return { ...kept, batch: batch.map((i) => i.key), batchHint: true };
    }
    out.push({ kind: 'ask', item: next, simpler: false, again: deferred(next.key, w.answers), lead });
    return kept;
  }
  // TTTFG-5254 step 11: the last form question is answered. The form goes to sign before any evidence is asked.
  if (!st.signingRequested) {
    out.push({ kind: 'request-signature' });
    st = { ...st, signingRequested: true };
  }
  if (next) {
    if (!st.evidenceStarted) {
      out.push({ kind: 'status', status: 'Awaiting client docs' });
      st = { ...st, evidenceStarted: true };
    }
    out.push({ kind: 'ask', item: next, simpler: false, again: deferred(next.key, w.answers), lead });
    return { ...st, phase: 'items', asking: next.key, misses: 0 };
  }
  const missing = missingItems(c.form, w.answers, w.evidence, { facts: w.facts, sapsRequired: st.sapsRequired });
  if (!missing.length) {
    out.push({ kind: 'evidence-complete' }, { kind: 'closing' });
    return null;
  }
  // TTTFG-4830 (still need): the list, and the conversation stays on it.
  out.push({ kind: 'still-missing', items: missing, lead: listLead });
  return stillNeedState(c, st, missing);
}

/**
 * TTTFG-4830 (still need): the state once Tina has listed what the client still has to send. The listed items are
 * skipped in this conversation, so only something new (a question a correction opened) is asked one by one; the rest
 * comes in on the list.
 */
export function stillNeedState(c: Pick<Ctx, 'now'>, st: FollowOnState, missing: readonly QuestionItem[]): FollowOnState {
  const { topic: _t, formatChecked: _f, ...rest } = moveOn(st);
  return {
    ...rest, phase: 'still-need', asking: '', misses: 0,
    skipped: [...new Set([...st.skipped, ...missing.map((i) => i.key)])], listedAt: c.now.toISOString(),
  };
}

/** After the SAPS step: the deadline note when needed, the duty of disclosure, then the first question. */
function intro(c: Ctx, w: Work, st: FollowOnState, out: Out[]): FollowOnState | null {
  if (st.introSent) return proceed(c, w, st, out);
  st = { ...st, introSent: true };
  const d = notificationDeadline(c.claim.facts.incidentAt, c.form.notificationPeriodDays, c.now, c.warningDays);
  if (d) {
    const template = d.variant === 'upcoming' ? DEADLINE_UPCOMING_TEMPLATE : DEADLINE_PASSED_TEMPLATE;
    const vars = { insurer: c.claim.insurer, periodDays: c.form.notificationPeriodDays, deadline: d.deadline, ownerName: capital(c.claim.owner.name) };
    out.push({ kind: 'template', template, text: template.render(vars) });
  }
  out.push({ kind: 'template', template: DISCLOSURE_TEMPLATE, text: DISCLOSURE_TEMPLATE.render() });
  // TTTFG-4830: the client's home address goes on every form; confirmed first when it's missing or looks out of date.
  const check = addressAsk(c.claim, w.answers);
  if (check) {
    out.push({ kind: 'ask', item: check, simpler: false });
    return { ...st, phase: 'address', asking: check.key, misses: 0 };
  }
  return proceed(c, w, st, out);
}

// ------------------------------------------------------------------------------- TTTFG-4830: the client's address

/**
 * The address the client confirmed when it isn't the one on the CRM (or the CRM has none). The form's "physical
 * address" uses it instead of the CRM's (fill-dataverse.ts), and the broker gets a Follow-up to update the contact:
 * Tina never changes a client's address in the CRM herself.
 */
export const ADDRESS_KEY = 'clientAddress';
/** The answer to "is that still your address?": STILL, MOVED or OTHER. */
export const ADDRESS_CHECK_KEY = 'clientAddressCheck';
/** The answer to "is <the address where it happened> your home address?" when the CRM has none. */
export const ADDRESS_IS_HOME_KEY = 'clientAddressIsHome';
const STILL = 'Still the same';
const MOVED = 'Moved there';
const OTHER = 'Another address';

/** The address in the place the client gave ("8 Kingsbury Park Road, Rondebosch (home)"): a street number and name. */
export function addressIn(place?: string): string | undefined {
  if (!place || !/\d+[a-z]?\s+[A-Za-z]{2,}/.test(place)) return undefined;
  return place.replace(/\s*\((my )?home\)\s*$/i, '').replace(/^(at\s+)?(my\s+)?(home|house)\b[,:]?\s*/i, '').trim();
}

const plain = (a: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** One line, as Tina says it. */
export const oneLine = (a: string) => a.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(', ');
/** The same address: the first line on file (street number and name) is in the other one. */
export function sameAddress(onFile: string, given: string): boolean {
  const first = plain(onFile.split(/\r?\n|,/)[0] ?? '');
  return !!first && plain(given).includes(first);
}

/** The question for an address key, in words for this claim. */
export function addressItem(claim: FollowOnClaim, key: string): QuestionItem | undefined {
  const onFile = claim.contactAddress?.trim();
  const here = claim.claimType === 'Property loss or damage' ? addressIn(claim.facts.place) : undefined;
  switch (key) {
    case ADDRESS_CHECK_KEY:
      return onFile && here ? {
        key, kind: 'question', answerType: 'choice', required: true, choices: [STILL, MOVED, OTHER], name: 'your home address',
        prompt: `We have ${oneLine(onFile)} as your home address. Is that still right, or do you live at ${here} now?`,
      } : undefined;
    case ADDRESS_IS_HOME_KEY:
      return here ? {
        key, kind: 'question', answerType: 'yes/no', required: true, name: 'your home address',
        prompt: `We don't have your home address on file. Is ${here} your home address?`,
      } : undefined;
    case ADDRESS_KEY:
      return {
        key, kind: 'question', answerType: 'text', required: true, name: 'your home address',
        prompt: onFile || here ? 'What is your home address now? Please include the suburb and town.' : "We don't have your home address on file. What is your home address? Please include the suburb and town.",
      };
  }
  return undefined;
}

/**
 * The first address question, or null when there's nothing to confirm: the claim at the client's home (Property loss
 * or damage) gave an address that isn't the one on the CRM, or the CRM has no address at all. Asked once per claim.
 */
export function addressAsk(claim: FollowOnClaim, answers: ClaimAnswers): QuestionItem | null {
  if (claim.contactAddress === undefined || [ADDRESS_KEY, ADDRESS_CHECK_KEY, ADDRESS_IS_HOME_KEY].some((k) => answers[k])) return null;
  const onFile = claim.contactAddress?.trim();
  const here = claim.claimType === 'Property loss or damage' ? addressIn(claim.facts.place) : undefined;
  if (onFile) return here && !sameAddress(onFile, here) ? addressItem(claim, ADDRESS_CHECK_KEY)! : null;
  return addressItem(claim, here ? ADDRESS_IS_HOME_KEY : ADDRESS_KEY)!;
}

/** The address question's answer: saved, the new address passed to the broker, then the next address question or the form. */
function advanceAddress(c: Ctx, w: Work, st: FollowOnState, input: ClientReply, out: Out[], at: string): FollowOnState | null {
  const item = addressItem(c.claim, st.asking);
  const toForm = () => proceed(c, w, { ...st, phase: 'items', misses: 0 }, out);
  if (!item) return toForm();
  const value = input.kind === 'value' ? accept(item, input.value) : undefined;
  if (value === undefined) {
    // "Not yet" or a miss: once in simpler words, then on to the form with the CRM's address (the broker checks it).
    if (input.kind !== 'not-yet' && st.misses + 1 < 2) {
      out.push({ kind: 'ask', item, simpler: true });
      return { ...st, misses: st.misses + 1 };
    }
    return toForm();
  }
  const save = (key: string, v: string | number | boolean) => {
    const record: AnswerRecord = { value: v, status: 'answered', at, wamid: input.wamid };
    out.push({ kind: 'save-answer', key, record });
    w.answers[key] = record;
  };
  const onFile = c.claim.contactAddress?.trim();
  const newAddress = (address: string) => {
    save(ADDRESS_KEY, address);
    out.push({
      kind: 'follow-up',
      detail: `The client gave their home address on WhatsApp as ${address}${onFile ? `; the CRM has ${oneLine(onFile)}` : '; the CRM has none'}. `
        + 'Please update the contact in the CRM, and check that the policy covers this address.',
    });
    out.push({ kind: 'text', text: "Thanks, I've noted your address. I'll use it on your claim and ask your broker to update it on our system." });
    return toForm();
  };
  const ask = (key: string) => {
    out.push({ kind: 'ask', item: addressItem(c.claim, key)!, simpler: false });
    return { ...st, asking: key, misses: 0 };
  };
  const here = addressIn(c.claim.facts.place);
  // The new address given in the same message ("No, I live at 5 Main Road, Claremont now"): not asked for again.
  const given = input.kind === 'value' ? input.also?.find((a) => a.key === ADDRESS_KEY && typeof a.value === 'string' && a.value.trim()) : undefined;
  const elsewhere = () => (given ? newAddress(String(given.value).trim()) : ask(ADDRESS_KEY));
  switch (st.asking) {
    case ADDRESS_CHECK_KEY:
      save(ADDRESS_CHECK_KEY, value);
      if (value === MOVED && here) return newAddress(here);
      if (value === OTHER || value === MOVED) return elsewhere();
      return toForm();
    case ADDRESS_IS_HOME_KEY:
      save(ADDRESS_IS_HOME_KEY, value);
      return value === true && here ? newAddress(here) : elsewhere();
    default:
      return typeof value === 'string' ? newAddress(value) : toForm();
  }
}

/** The SAPS question for what is still missing. */
function sapsAsk(f: ClaimFacts): QuestionItem {
  if (!f.sapsCaseNumber && !f.sapsStation) return SAPS_BOTH;
  return f.sapsCaseNumber ? SAPS_ITEMS[1] : SAPS_ITEMS[0];
}

export function startFollowOn(c: Ctx, describedAsTheft: boolean, files: readonly ResumeFile[] = [], reported: readonly OtherAnswer[] = []): Step {
  const w = work(c.claim);
  const out: Out[] = [];
  const st: FollowOnState = {
    claimId: c.claim.id, phase: 'items', asking: '', misses: 0, skipped: [], signingRequested: false,
    sapsRequired: sapsStepApplies(c.claim.claimType, c.form, describedAsTheft),
    evidenceStarted: c.claim.status === 'Awaiting client docs',
  };
  if (st.sapsRequired) out.push({ kind: 'saps-required' });
  // Files kept from before the claim opened: filed now, so Tina never asks for one the client already sent.
  fileHeld(c, w, files, out, st.sapsRequired);
  // TTTFG-4830: what the client already said while reporting the claim answers those questions; they aren't asked, and
  // Tina doesn't announce it (one message less before the first question).
  applyOthers(c, w, st.sapsRequired, reported, { at: c.now.toISOString(), source: 'report' }, out);
  if (st.sapsRequired && (!w.facts.sapsCaseNumber || !w.facts.sapsStation)) {
    if (!w.facts.sapsCaseNumber) out.push({ kind: 'saps-instruction' });
    const item = sapsAsk(w.facts);
    out.push({ kind: 'ask', item, simpler: false });
    return { state: { ...st, phase: 'saps', asking: item.key }, out };
  }
  return { state: intro(c, w, st, out), out };
}

/**
 * TTTFG-4830: saves the values a message (or the client's report) gave for open questions other than `except` (the one
 * Tina is asking). Each is checked with accept() against its question; a question already answered, a SAPS key or a
 * group's "another one?" question is never set this way, so no repeating-group entry is started. An answer can open a
 * question (a yes to "Were there passengers?" opens the passenger's name), so it goes round until nothing more fits.
 * Returns how many were saved.
 */
function applyOthers(
  c: Ctx, w: Work, sapsRequired: boolean, others: readonly OtherAnswer[] | undefined,
  rec: { at: string; wamid?: string; source: 'report' | 'same-message' }, out: Out[], except?: string | readonly string[],
): number {
  if (!others?.length) return 0;
  // The question (or TTTFG-4830 batch of questions) Tina is asking: answered as such, never on the side.
  const asked = new Set(typeof except === 'string' ? [except] : except ?? []);
  let saved = 0;
  for (let pass = 0, progress = true; progress && pass < 5; pass++) {
    progress = false;
    const items = formItems(c.form, w.answers, w.facts, sapsRequired);
    for (const o of others) {
      if (asked.has(o.key) || o.key.includes('.more.') || isSaps(o.key)) continue;
      const prev = w.answers[o.key];
      if (prev && prev.status !== 'not-yet') continue;
      const item = items.find((i) => i.key === o.key);
      if (!item || item.kind !== 'question' || !applies(item, w.answers, w.facts)) continue;
      const value = accept(item, o.value);
      // A value that doesn't look right isn't saved on the side: Tina asks the question later and checks it then.
      if (value === undefined || formatProblem(item, value)) continue;
      // TTTFG-4830: a "no" read from the report is nearly always the absence of a mention ("stole my TV" -> "no phone
      // stolen", "a break-in at midnight" -> "nobody home"). A wrong "no" goes to the insurer; a missed one costs a question.
      if (rec.source === 'report' && item.answerType === 'yes/no' && value === false) continue;
      const record: AnswerRecord = { value, status: 'answered', at: rec.at, ...(rec.wamid ? { wamid: rec.wamid } : {}), source: rec.source };
      out.push({ kind: 'save-answer', key: item.key, record });
      w.answers[item.key] = record;
      saved++;
      progress = true;
    }
  }
  return saved;
}

/**
 * TTTFG-4830: new values for questions already answered (the host lets Claude see only recent answers and the
 * "another one?" answers). Each is checked with accept(); the question Tina is asking and SAPS keys are left alone. A
 * "no" to a group's "another one?" ends the group there: the entries after it are dropped from the claim, so a car the
 * client took back never reaches the form. A new value that doesn't look right (formats.ts) is pointed out and not
 * saved. Returns how many answers changed and how many corrections were pointed out.
 */
function applyCorrections(
  c: Ctx, w: Work, sapsRequired: boolean, corrections: readonly OtherAnswer[] | undefined, rec: { at: string; wamid?: string }, out: Out[], except?: string,
): { changed: number; flagged: number; ownReading: boolean } {
  let changed = 0;
  let flagged = 0;
  let ownReading = 0;
  if (!corrections?.length) return { changed, flagged, ownReading: false };
  for (const k of corrections) {
    const prev = w.answers[k.key];
    if (k.key === except || isSaps(k.key) || !prev || prev.status === 'not-yet') continue;
    const item = formItems(c.form, w.answers, w.facts, sapsRequired).find((i) => i.key === k.key);
    if (!item || item.kind !== 'question') continue;
    const value = accept(item, k.value);
    if (value === undefined || (prev.status === 'answered' && prev.value === value)) continue;
    const problem = formatProblem(item, value);
    if (problem) {
      // The corrected value doesn't look right either: say so, and keep the earlier answer until it comes back right.
      out.push({ kind: 'text', text: problem });
      flagged++;
      continue;
    }
    const record: AnswerRecord = { value, status: 'answered', at: rec.at, ...(rec.wamid ? { wamid: rec.wamid } : {}), source: 'correction' };
    out.push({ kind: 'save-answer', key: item.key, record });
    w.answers[item.key] = record;
    changed++;
    if (prev.source === 'report') ownReading++;
    const more = /^(.+)\.more\.(\d+)$/.exec(item.key);
    if (more && value === false) {
      const [, group, n] = more;
      const members = new Set(c.form.questionList.filter((q) => q.group === group).map((q) => q.key));
      for (const key of Object.keys(w.answers)) {
        const m = /^(.+)\.more\.(\d+)$/.exec(key) ?? /^(.+)\.(\d+)$/.exec(key);
        const later = m && Number(m[2]) > Number(n) && (members.has(m[1]) || m[1] === group);
        if (later) {
          out.push({ kind: 'drop-answer', key });
          delete w.answers[key];
        }
      }
    }
  }
  // Every change was to Tina's own reading of the report: nothing the client said is being taken back.
  return { changed, flagged, ownReading: changed > 0 && ownReading === changed };
}

// ---------------------------------------------------------------------------------------- TTTFG-5184: resuming

const BEFORE_FORM: readonly ClaimStatus[] = ['FNOL logged', 'Cover verified'];
const BEFORE_EVIDENCE: readonly ClaimStatus[] = [...BEFORE_FORM, 'Form sent'];
const isSaps = (key: string) => key === SAPS_CASE_KEY || key === SAPS_STATION_KEY;

/**
 * Whether the SAPS step applies, from the claim record alone. Known gap: Claude's `describedAsTheft` isn't stored on
 * the claim, so a theft described in words on a non-theft claim type loses the step on resume unless the claim already
 * has a SAPS case number or station (a column for it is suggested to TTTFG-4885).
 */
function resumedSaps(c: Ctx): boolean {
  return !!c.claim.sapsRequired || sapsStepApplies(c.claim.claimType, c.form, false) || !!(c.claim.sapsCaseNumber || c.claim.sapsStation);
}

/**
 * Files the client sent before Tina could ask for them (on a resumed claim, or held until a new claim opened): each is
 * filed as `forItem` (Claude's reading) when that evidence item is still open, else as the only open evidence item
 * when there is one, else against the claim with no item for the pipeline to sort. A matched file is thanked by name
 * and counts as received, so Tina doesn't ask for it.
 */
function fileHeld(c: Ctx, w: Work, files: readonly ResumeFile[], out: Out[], sapsRequired: boolean) {
  for (const f of files) {
    const open = formItems(c.form, w.answers, w.facts, sapsRequired)
      .filter((i) => i.kind === 'evidence' && applies(i, w.answers, w.facts) && !evidenceIn(i, w.evidence));
    const item = open.find((i) => i.key === f.forItem) ?? (open.length === 1 ? open[0] : undefined);
    out.push({ kind: 'file', file: f.file, itemKey: item?.key });
    if (item) {
      w.evidence.push({ key: item.key });
      if (evidenceIn(item, w.evidence)) out.push({ kind: 'received', item });
    }
  }
}

/** The required items still missing on the claim, as resume.ts lists them in the welcome-back line. */
export function resumeMissing(c: Ctx): QuestionItem[] {
  const w = work(c.claim);
  return missingItems(c.form, w.answers, w.evidence, { facts: w.facts, sapsRequired: resumedSaps(c) });
}

/**
 * TTTFG-5184: the follow-on state rebuilt from the claim record, for a client who comes back after the conversation
 * ended. Nothing is read from an earlier conversation:
 * - the intro (deadline note, duty of disclosure) went out if the claim holds a form answer or a document, or the
 *   caller says so (a stale follow-on state of the same claim). Otherwise it is sent (again), because the disclosure
 *   must come before the first form question;
 * - the signing step was asked for once no required form question is missing, or once the signature or the status
 *   says so (5192's re-fill makes a second call harmless, but it isn't made without reason);
 * - the evidence stage has started once the status is past Form sent. Pack complete and Additional info requested are
 *   never set back to Awaiting client docs;
 * - "not yet" items from the earlier conversation are asked again: the client may have them now.
 */
export function resumeFollowOn(c: Ctx, introSent = false, skipped: readonly string[] = []): FollowOnState {
  const w = work(c.claim);
  const sapsRequired = resumedSaps(c);
  const missing = missingItems(c.form, w.answers, w.evidence, { facts: w.facts, sapsRequired });
  const { status, signatureStatus } = c.claim;
  const st: FollowOnState = {
    claimId: c.claim.id, phase: 'items', asking: '', misses: 0, skipped: [...skipped], sapsRequired,
    signingRequested: signatureStatus !== 'Not sent' || !BEFORE_FORM.includes(status) || !missing.some((i) => i.kind === 'question' && !isSaps(i.key)),
    evidenceStarted: !BEFORE_EVIDENCE.includes(status),
    introSent: introSent || !!c.claim.introSent || Object.keys(w.answers).some((k) => !isSaps(k)) || w.evidence.length > 0,
  };
  const next = nextItem(c.form, w.answers, w.evidence, { facts: w.facts, sapsRequired, skip: [...skipped, SAPS_CASE_KEY, SAPS_STATION_KEY] });
  // Past the duty of disclosure, the first open item is the one Tina asked last and is still waiting on.
  if (st.introSent && next) st.waitingOn = next.key;
  if (sapsRequired && (!w.facts.sapsCaseNumber || !w.facts.sapsStation) && !skipped.includes(SAPS_CASE_KEY)) {
    return { ...st, phase: 'saps', asking: sapsAsk(w.facts).key };
  }
  return { ...st, asking: next?.key ?? '' };
}

/**
 * TTTFG-5184: the client is back. Files are filed first, each as `forItem` when Claude named a missing evidence item,
 * else as the only missing evidence item when there is one, else against the claim with no item: the pipeline sorts
 * it, and Tina asks for the item again rather than guess. Then the SAPS step or the first missing item, the same way
 * the follow-on goes on after an answer. With no file and nothing left to ask, nothing is said or written (resume.ts
 * sent the welcome-back line), so evidence complete isn't set a second time.
 */
export function resumeStep(c: Ctx, files: readonly ResumeFile[] = [], introSent = false, lead?: string, skipped: readonly string[] = []): Step {
  const out: Out[] = [];
  const held = work(c.claim);
  fileHeld(c, held, files, out, resumedSaps(c));
  const claim = { ...c.claim, evidence: held.evidence };
  const ctx = { ...c, claim };
  // What Tina was waiting on is read from the claim as it stood before these files.
  let st: FollowOnState = { ...resumeFollowOn(ctx, introSent, skipped), waitingOn: resumeFollowOn(c, introSent, skipped).waitingOn };
  // No file and no lead: resume.ts has just sent the welcome-back line naming what's needed, so the first item needs no
  // "back to where we left off" (nor after "No problem, back to your … claim."). After the SAPS step it does.
  if (st.phase === 'items' && (lead || !files.length)) st = { ...st, waitingOn: undefined };
  const w = work(claim);
  if (st.phase === 'saps') {
    const item = sapsAsk(w.facts);
    out.push({ kind: 'ask', item, simpler: false, again: deferred(SAPS_CASE_KEY, w.answers), lead });
    return { state: st, out };
  }
  if (!files.length && !st.asking && st.signingRequested) return { state: null, out: lead ? [...out, { kind: 'text', text: lead }] : out };
  const first = out.length;
  const next = intro(ctx, w, st, out);
  // The words in front go on the first question asked, if one is (not on a template or a closing line).
  const ask = out.slice(first).find((o): o is Extract<Out, { kind: 'ask' | 'ask-batch' }> => o.kind === 'ask' || o.kind === 'ask-batch');
  if (lead && ask) ask.lead = lead;
  else if (lead) out.splice(first, 0, { kind: 'text', text: lead });
  return { state: next, out };
}

/** A client message, as the follow-on reads it (not the start, a resume or the host's nudge). */
export type ClientReply = Exclude<FollowOnInput, { kind: 'start' | 'resume' | 'nudge' }>;

/**
 * TTTFG-4830: a reply read for one question while Tina asked a batch, or for a batch while she asked one question
 * (the host reads against the state it had), in the shape the state needs.
 */
function fitted(st: FollowOnState, input: ClientReply): ClientReply {
  if (st.batch && st.phase === 'items') {
    const rest = { wamid: input.wamid, ...('also' in input && input.also ? { also: input.also } : {}), ...('corrections' in input && input.corrections ? { corrections: input.corrections } : {}) };
    if (input.kind === 'value') return { kind: 'batch', answers: [{ key: st.asking, value: input.value }], dontKnow: [], ...rest };
    if (input.kind === 'not-yet' || input.kind === 'unparsed') return { kind: 'batch', answers: [], dontKnow: [], ...rest };
    return input;
  }
  if (input.kind !== 'batch') return input;
  const also = [...(input.also ?? []), ...input.answers.filter((a) => a.key !== st.asking)];
  const rest = { wamid: input.wamid, ...(also.length ? { also } : {}), ...(input.corrections ? { corrections: input.corrections } : {}) };
  const mine = input.answers.find((a) => a.key === st.asking);
  if (mine) return { kind: 'value', value: mine.value, ...rest };
  return { kind: input.dontKnow.includes(st.asking) ? 'not-yet' : 'unparsed', ...rest };
}

export function advanceFollowOn(c: Ctx, st: FollowOnState, raw: Exclude<FollowOnInput, { kind: 'start' | 'resume' }>): Step {
  const step = advanceReply(c, st, raw);
  return 'spoken' in raw && raw.spoken ? withHeard(c, st, raw.wamid, step) : step;
}

function advanceReply(c: Ctx, st: FollowOnState, raw: Exclude<FollowOnInput, { kind: 'start' | 'resume' }>): Step {
  if (raw.kind === 'nudge') return nudged(c, st, raw.wamid);
  const input = fitted(st, raw);
  const w = work(c.claim);
  const out: Out[] = [];
  const at = c.now.toISOString();
  // TTTFG-4830: an earlier answer the client changed, then the other questions this message answered, are saved first,
  // so Tina neither carries on from a wrong answer nor asks for something she was just told.
  const { changed: corrected, flagged, ownReading } = input.kind === 'file'
    ? { changed: 0, flagged: 0, ownReading: false }
    : applyCorrections(c, w, st.sapsRequired, input.corrections, { at, wamid: input.wamid }, out, st.asking);
  const noted = input.kind === 'file' ? 0 : applyOthers(c, w, st.sapsRequired, input.also, { at, wamid: input.wamid, source: 'same-message' }, out, st.batch ?? st.asking);

  if (st.phase === 'address') return { state: advanceAddress(c, w, st, input, out, at), out };
  if (st.phase === 'still-need') return { state: advanceStillNeed(c, w, st, input, out, { corrected, flagged, ownReading, noted }), out };

  if (st.phase === 'saps') {
    let caseNumber = input.kind === 'saps' ? input.caseNumber?.trim() || undefined : undefined;
    let station = input.kind === 'saps' ? input.station?.trim() || undefined : undefined;
    if (input.kind === 'value' && typeof input.value === 'string' && input.value.trim()) {
      if (st.asking === SAPS_STATION_KEY) station = input.value.trim();
      else caseNumber = input.value.trim();
    }
    if (input.kind === 'not-yet') {
      // Move on; the case number stays on the missing list (TTTFG-5184 and TTTFG-5212 ask for it again, as "yet?").
      for (const key of [SAPS_CASE_KEY, SAPS_STATION_KEY]) {
        if (key === SAPS_CASE_KEY ? w.facts.sapsCaseNumber : w.facts.sapsStation) continue;
        const record: AnswerRecord = { value: null, status: 'not-yet', at, wamid: input.wamid };
        out.push({ kind: 'save-answer', key, record });
        w.answers[key] = record;
      }
      return { state: intro(c, w, { ...st, skipped: [...st.skipped, SAPS_CASE_KEY, SAPS_STATION_KEY] }, out), out };
    }
    if (input.kind === 'file') {
      // A photo of the SAPS slip, say: filed against the claim, and the question stands (not repeated bare).
      out.push({ kind: 'file', file: input.file }, { kind: 'ask', item: sapsAsk(w.facts), simpler: false, lead: SAVED_FILE });
      return { state: st, out };
    }
    if (caseNumber || station) {
      out.push({ kind: 'save-saps', caseNumber, station });
      w.facts = { ...w.facts, sapsCaseNumber: caseNumber ?? w.facts.sapsCaseNumber, sapsStation: station ?? w.facts.sapsStation };
      if (w.facts.sapsCaseNumber && w.facts.sapsStation) return { state: intro(c, w, st, out), out };
      const item = sapsAsk(w.facts);
      out.push({ kind: 'ask', item, simpler: false });
      return { state: { ...st, asking: item.key, misses: 0 }, out };
    }
    if (st.misses + 1 >= 2) return { state: intro(c, w, { ...st, skipped: [...st.skipped, SAPS_CASE_KEY, SAPS_STATION_KEY] }, out), out };
    out.push({ kind: 'ask', item: sapsAsk(w.facts), simpler: true });
    return { state: { ...st, misses: st.misses + 1 }, out };
  }

  if (st.batch) return { state: advanceBatch(c, w, st, input, out, at, { corrected, flagged, ownReading, noted }), out };

  const item = formItems(c.form, w.answers, w.facts, st.sapsRequired).find((i) => i.key === st.asking);
  if (!item || !applies(item, w.answers, w.facts)) {
    // The correction took away the question Tina was asking (no second car, so no second car's make): on to the next.
    if (corrected) out.push({ kind: 'text', text: ownReading ? NOTED_OTHERS : CORRECTED });
    return { state: proceed(c, w, { ...st, misses: 0 }, out), out };
  }

  // TTTFG-4830: "Are those all of them?" (an evidence item of any number of files): a yes takes Tina on, a no keeps her
  // waiting for the rest, "later" moves on with what came; anything else is asked once more, then she moves on.
  if (item.kind === 'evidence' && st.confirming === item.key && input.kind !== 'file') {
    const s = { ...st, waiting: undefined, waitingFor: undefined };
    if (input.kind === 'value' && input.value === false) {
      out.push({ kind: 'text', text: SEND_THE_REST });
      return { state: s, out };
    }
    if (input.kind === 'unparsed' && st.misses < 1) {
      out.push({ kind: 'text', text: allOfThemAgain(item) });
      return { state: { ...s, misses: st.misses + 1 }, out };
    }
    out.push({ kind: 'received', item });
    return { state: proceed(c, w, s, out), out };
  }
  // TTTFG-4830: files were coming in for this item and the client wrote before the quiet spell was over: Tina answers
  // about the files now. "I don't have the back" passes over what's missing, as "not yet" does.
  if (item.kind === 'evidence' && st.waitingFor === 'files' && input.kind !== 'file') {
    st = { ...st, waiting: undefined, waitingFor: undefined };
    if (input.kind !== 'not-yet') return { state: filesIn(c, w, st, item, out), out };
  }

  if (input.kind === 'saps' && input.caseNumber) {
    // The case number the client didn't have earlier: saved, and the current item stands.
    out.push({ kind: 'save-saps', caseNumber: input.caseNumber.trim(), station: input.station?.trim() || undefined });
    out.push({ kind: 'ask', item, simpler: false, lead: SAVED_SAPS });
    return { state: st, out };
  }

  if (input.kind === 'file') {
    // TTTFG-5184: Claude reads the file as another open evidence item: filed and thanked as that item. Tina's question
    // stands; on an evidence item she just waits (asking again straight away would ask the same thing twice).
    // TTTFG-4830: while Tina asks for an evidence item, every file sent belongs to it (the front and the back, several
    // photos of the scene); she answers once they stop coming. Only a file the client named themself (a document's own
    // file name, "quote.pdf") can be another item: a camera photo's name is Tina's (image-<time>), so Claude's reading of
    // it is a guess from her question.
    const other = (item.kind === 'question' || clientNamed(input.file)) && input.forItem && input.forItem !== item.key
      ? formItems(c.form, w.answers, w.facts, st.sapsRequired).find((i) => i.key === input.forItem && i.kind === 'evidence'
        && applies(i, w.answers, w.facts) && !evidenceIn(i, w.evidence))
      : undefined;
    if (other) {
      out.push({ kind: 'file', file: input.file, itemKey: other.key });
      w.evidence.push({ key: other.key });
      const complete = evidenceIn(other, w.evidence);
      if (complete) out.push({ kind: 'received', item: other });
      // On a question Tina asks it again; on an evidence item she just waits (asking again would ask the same thing twice).
      if (item.kind === 'question') out.push({ kind: 'ask', item, simpler: false, lead: complete ? 'Back to my question:' : SAVED_FILE });
      else if (!complete) out.push({ kind: 'text', text: FILE_SAVED });
      return { state: st, out };
    }
    if (item.kind === 'evidence') {
      out.push({ kind: 'file', file: input.file, itemKey: item.key });
      w.evidence.push({ key: item.key });
      if (c.waitForMore) return { state: { ...st, waiting: input.wamid, waitingFor: 'files', misses: 0 }, out };
      return { state: filesIn(c, w, st, item, out), out };
    }
    // A file in the middle of the questions still goes to the pipeline against the claim; the question stands.
    out.push({ kind: 'file', file: input.file }, { kind: 'ask', item, simpler: false, lead: SAVED_FILE });
    return { state: st, out };
  }

  if (item.kind === 'question' && input.kind === 'value') {
    const value = accept(item, input.value);
    // TTTFG-4830: a phone number, email or ID number that doesn't look right is pointed out once. The same again is kept
    // as given, with the reason for the broker: a client who means it is never stuck on a question.
    const problem = value === undefined ? null : formatProblem(item, value);
    if (problem && !formatChecked(st).includes(item.key)) {
      out.push({ kind: 'text', text: problem });
      return { state: { ...st, formatChecked: item.key }, out };
    }
    if (value !== undefined) {
      const record: AnswerRecord = { value, status: 'answered', at, wamid: input.wamid, ...(problem ? { doubt: problem.replace(/ Could you.*$/, '') } : {}) };
      out.push({ kind: 'save-answer', key: item.key, record });
      w.answers[item.key] = record;
      // The answer may open questions the same message also answered ("yes, my aunt Arona" opens the passenger's name).
      applyOthers(c, w, st.sapsRequired, input.also, { at, wamid: input.wamid, source: 'same-message' }, out, st.asking);
      return { state: proceed(c, w, st, out), out };
    }
  }

  // "Not yet" passes over an evidence item or an optional question. TTTFG-4830 (still need): and over a question the
  // client can get (chased), which goes on their list for later rather than to the broker.
  if (input.kind === 'not-yet' && (item.kind === 'evidence' || !item.required || chased(item))) {
    // Kept on the claim, so a later conversation doesn't ask an optional item again, and asks a required one as "yet?".
    const record: AnswerRecord = { value: null, status: 'not-yet', at, wamid: input.wamid };
    out.push({ kind: 'save-answer', key: item.key, record });
    w.answers[item.key] = record;
    if (item.kind === 'question' && item.required) out.push({ kind: 'text', text: sendLater([item]) });
    return { state: proceed(c, w, { ...st, skipped: [...st.skipped, item.key] }, out), out };
  }

  // A required question is never left on a guess, but "I don't know" (the thief's name) isn't a miss either: asking
  // again would go in circles (TTTFG-4830). The broker confirms it with the client, and Tina says so.
  if (input.kind === 'not-yet' && item.kind === 'question') {
    const record: AnswerRecord = { value: null, status: 'broker-to-confirm', at, wamid: input.wamid };
    out.push({ kind: 'save-answer', key: item.key, record }, { kind: 'text', text: BROKER_WILL_CHECK });
    w.answers[item.key] = record;
    return { state: proceed(c, w, st, out), out };
  }

  // The message changed an earlier answer or answered other questions, but not this one: that isn't a miss. Say so and
  // ask it again as it was.
  if ((corrected || noted || flagged) && input.kind === 'unparsed') {
    out.push({ kind: 'ask', item, simpler: false, lead: corrected ? (ownReading ? NOTED_OTHERS : CORRECTED) : noted ? NOTED_OTHERS : undefined });
    return { state: st, out };
  }

  // A miss. Once: ask again in simpler words. Twice: the broker confirms it (a question) or it stays missing (evidence).
  if (st.misses + 1 < 2) {
    out.push({ kind: 'ask', item, simpler: true });
    return { state: { ...st, misses: st.misses + 1 }, out };
  }
  // TTTFG-4830 (still need): an item the client can get stays theirs: it goes on the list at the end.
  if (item.kind === 'evidence' || chased(item)) return { state: proceed(c, w, { ...st, skipped: [...st.skipped, item.key] }, out), out };
  const record: AnswerRecord = { value: null, status: 'broker-to-confirm', at, wamid: input.wamid };
  out.push({ kind: 'save-answer', key: item.key, record });
  w.answers[item.key] = record;
  return { state: proceed(c, w, st, out), out };
}

// ------------------------------------------------------------------------------------ TTTFG-4830: voice notes

/** A saved value as the client reads it back: yes or no, a date in words ("12 October 2026"), otherwise as saved. */
export function heardValue(item: QuestionItem | undefined, v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  if (item?.answerType === 'date' && /^\d{4}-\d{2}(-\d{2})?$/.test(v)) {
    const month = v.length === 7;
    return new Date(`${month ? `${v}-01` : v}T00:00:00Z`)
      .toLocaleDateString('en-GB', { timeZone: 'UTC', ...(month ? {} : { day: 'numeric' }), month: 'long', year: 'numeric' });
  }
  return v;
}

/**
 * What Tina saved from a voice note, as she says it back: a value of the question she asked alone; otherwise one line
 * each, by its number in the batch Tina asked (the list the client just answered), then the others by their question.
 * Null when nothing was saved (only "don't know", or nothing understood).
 */
export function heardText(entries: ReadonlyArray<{ item?: QuestionItem; key: string; value: string | number | boolean }>, st: FollowOnState): string | null {
  if (!entries.length) return null;
  const batch = st.phase === 'items' ? st.batch ?? [] : [];
  if (entries.length === 1 && entries[0].key === st.asking && !batch.length) {
    return `${HEARD.lead} ${heardValue(entries[0].item, entries[0].value)}. ${HEARD.end}`;
  }
  const at = (key: string) => (batch.includes(key) ? batch.indexOf(key) : batch.length);
  const lines = [...entries].sort((a, b) => at(a.key) - at(b.key)).map((e) => {
    const value = heardValue(e.item, e.value);
    if (batch.includes(e.key)) return `${batch.indexOf(e.key) + 1}. ${value}`;
    // The question in Tina's words when it is one ("What make is the car? VW"), otherwise its name ("Your home address:").
    const asked = e.item?.prompt.split(/(?<=[.?!])\s/)[0].trim();
    if (asked?.endsWith('?')) return `- ${asked} ${value}`;
    return `- ${e.item ? capital(itemName(e.item)) : e.key}: ${value}`;
  });
  return [HEARD.lead, ...lines, HEARD.end].join('\n');
}

/** Out items Tina says to the client (the others are writes). */
const SAYS = new Set<Out['kind']>(['saps-instruction', 'ask', 'ask-batch', 'text', 'template', 'received', 'closing', 'still-missing']);

/**
 * TTTFG-4830 (voice notes): the step for a voice note, with what it saved said back before anything else Tina says, so
 * a misheard registration or date is caught by the client rather than the insurer.
 */
function withHeard(c: Ctx, st: FollowOnState, wamid: string, step: Step): Step {
  const w = work(c.claim);
  const answers = { ...w.answers };
  for (const o of step.out) if (o.kind === 'save-answer') answers[o.key] = o.record;
  const list = formItems(c.form, answers, w.facts, st.sapsRequired);
  const entries: Array<{ item?: QuestionItem; key: string; value: string | number | boolean }> = [];
  for (const o of step.out) {
    if (o.kind === 'save-answer' && o.record.status === 'answered' && o.record.value !== null && o.record.wamid === wamid) {
      entries.push({ item: list.find((i) => i.key === o.key) ?? addressItem(c.claim, o.key), key: o.key, value: o.record.value });
    } else if (o.kind === 'save-saps') {
      if (o.caseNumber) entries.push({ item: SAPS_ITEMS.find((i) => i.key === SAPS_CASE_KEY), key: SAPS_CASE_KEY, value: o.caseNumber });
      if (o.station) entries.push({ item: SAPS_ITEMS.find((i) => i.key === SAPS_STATION_KEY), key: SAPS_STATION_KEY, value: o.station });
    }
  }
  const text = heardText(entries.filter((e, i) => entries.findIndex((f) => f.key === e.key) === i), st);
  if (!text) return step;
  const first = step.out.findIndex((o) => SAYS.has(o.kind));
  const out = [...step.out];
  out.splice(first < 0 ? out.length : first, 0, { kind: 'text', text });
  return { ...step, out };
}

// -------------------------------------------------------------------------------- TTTFG-4830: questions in batches

/** The questions whose answers Tina said didn't look right (FollowOnState.formatChecked). */
const formatChecked = (st: FollowOnState): string[] => (Array.isArray(st.formatChecked) ? st.formatChecked : st.formatChecked ? [st.formatChecked] : []);

/** The batch's questions still open: unanswered and applying, or waiting on a yes or a no still open in the batch. */
function openBatch(c: Ctx, w: Work, st: FollowOnState): QuestionItem[] {
  const list = formItems(c.form, w.answers, w.facts, st.sapsRequired);
  const open: QuestionItem[] = [];
  for (const key of st.batch ?? []) {
    const item = list.find((i) => i.key === key);
    const a = w.answers[key];
    if (!item || item.kind !== 'question' || st.skipped.includes(key) || (a && a.status !== 'not-yet')) continue;
    if (applies(item, w.answers, w.facts) || (item.onlyIf && open.some((o) => o.key === item.onlyIf!.key))) open.push(item);
  }
  return open;
}

/**
 * How Tina leads into the batch's open questions when she lists them again (`many`), or the one left (`one`; absent: the
 * question alone, in simpler words when `simpler`). `count`: the listing counts as asking them again.
 */
interface Relist { many: string; one?: string; simpler?: boolean; count: boolean }
const BACK: Relist = { many: 'Back to my questions:', one: 'Back to my question:', count: false };

/**
 * One reply to a batch. Its answers are saved, each checked against its own question as for one question; "don't
 * know" goes to the broker (a required question) or is "not yet" (an optional one); a file or a SAPS case number is
 * filed as in the middle of one question. Then:
 * - nothing open: the next batch, after "Thanks.";
 * - the message moved things on (or Tina was already waiting) and the host can wait (waitForMore): Tina says nothing
 *   more until the client goes quiet;
 * - otherwise what's still open is listed again (relist): "Thanks. I still need these:" after some answers, "Sorry, I
 *   didn't quite get that." after none, "Back to my questions:" after a file or a correction (not counted).
 */
function advanceBatch(
  c: Ctx, w: Work, st: FollowOnState, input: ClientReply, out: Out[], at: string,
  side: { corrected: number; flagged: number; ownReading: boolean; noted: number },
): FollowOnState | null {
  const batch = st.batch ?? [];
  const list = () => formItems(c.form, w.answers, w.facts, st.sapsRequired);
  const save = (key: string, record: AnswerRecord) => {
    out.push({ kind: 'save-answer', key, record });
    w.answers[key] = record;
  };
  let answered = false;
  let back: Relist | undefined;
  if (side.corrected) {
    out.push({ kind: 'text', text: side.ownReading ? NOTED_OTHERS : CORRECTED });
    back = BACK;
  } else if (side.flagged) back = BACK;
  else if (side.noted) back = { ...BACK, many: `${NOTED_OTHERS} ${BACK.many}`, one: `${NOTED_OTHERS} ${BACK.one}` };

  if (input.kind === 'file') {
    // Filed against the claim, as the evidence item Claude read it as when that one is still missing.
    const item = input.forItem
      ? list().find((i) => i.key === input.forItem && i.kind === 'evidence' && applies(i, w.answers, w.facts) && !evidenceIn(i, w.evidence))
      : undefined;
    out.push({ kind: 'file', file: input.file, itemKey: item?.key });
    if (item) w.evidence.push({ key: item.key });
    if (item && evidenceIn(item, w.evidence)) {
      out.push({ kind: 'received', item });
      back = BACK;
    } else back = { many: plural(SAVED_FILE), one: SAVED_FILE, count: false };
  } else if (input.kind === 'saps' && input.caseNumber) {
    out.push({ kind: 'save-saps', caseNumber: input.caseNumber.trim(), station: input.station?.trim() || undefined });
    back = { many: plural(SAVED_SAPS), one: SAVED_SAPS, count: false };
  } else if (input.kind === 'batch') {
    const checked = new Set(formatChecked(st));
    // An answer can open another question of the batch (a "no" to "Is the car registered in your name?" opens whose
    // name it is), so go round until nothing more fits.
    const given = new Map(input.answers.filter((a) => batch.includes(a.key)).map((a) => [a.key, a.value] as const));
    for (let pass = 0, more = true; more && pass < batch.length; pass++) {
      more = false;
      for (const [key, v] of given) {
        const item = list().find((i) => i.key === key);
        if (!item || item.kind !== 'question' || !applies(item, w.answers, w.facts)) continue;
        given.delete(key);
        more = true;
        const prev = w.answers[key];
        const value = prev && prev.status !== 'not-yet' ? undefined : accept(item, v);
        if (value === undefined) continue;
        answered = true;
        // A phone number, email or ID number that doesn't look right is pointed out once, by its number; the same
        // again is kept as given, with the reason for the broker.
        const problem = formatProblem(item, value);
        if (problem && !checked.has(key)) {
          out.push({ kind: 'text', text: `About number ${batch.indexOf(key) + 1}: ${problem}` });
          checked.add(key);
          continue;
        }
        save(key, { value, status: 'answered', at, wamid: input.wamid, ...(problem ? { doubt: problem.replace(/ Could you.*$/, '') } : {}) });
      }
    }
    if (checked.size) st = { ...st, formatChecked: [...checked] };
    let broker = false;
    const later: QuestionItem[] = [];
    for (const key of input.dontKnow) {
      const item = list().find((i) => i.key === key);
      const prev = w.answers[key];
      if (!batch.includes(key) || item?.kind !== 'question' || !applies(item, w.answers, w.facts) || (prev && prev.status !== 'not-yet')) continue;
      answered = true;
      if (item.required && !chased(item)) {
        // "I don't know" isn't a miss: the broker confirms it with the client, as for one question.
        save(key, { value: null, status: 'broker-to-confirm', at, wamid: input.wamid });
        broker = true;
      } else {
        // An optional question, or (TTTFG-4830, still need) one the client can get: theirs, for later.
        save(key, { value: null, status: 'not-yet', at, wamid: input.wamid });
        st = { ...st, skipped: [...st.skipped, key] };
        if (item.required) later.push(item);
      }
    }
    if (later.length) out.push({ kind: 'text', text: broker ? `${sendLater(later)} ${BROKER_THE_OTHERS}` : sendLater(later) });
    else if (broker) out.push({ kind: 'text', text: BROKER_WILL_CHECK });
  }

  if (!openBatch(c, w, st).length) return proceed(c, w, st, out, 'Thanks.');
  if (c.waitForMore && (answered || back || st.waiting)) {
    // A file or a case number is acknowledged now; answers are thanked when Tina next writes.
    if (input.kind === 'file' && !out.some((o) => o.kind === 'received')) out.push({ kind: 'text', text: FILE_SAVED });
    if (input.kind === 'saps' && input.caseNumber) out.push({ kind: 'text', text: SAVED_SAPS.replace(/ Back to.*$/, '') });
    return { ...st, waiting: input.wamid };
  }
  if (answered) return relist(c, w, st, out, { ...STILL_NEED, count: true }, at, input.wamid);
  return relist(c, w, st, out, back ?? { many: SORRY_BATCH, simpler: true, count: true }, at, input.wamid);
}

/**
 * What's still open in the batch, listed again after `lead` and numbered from 1. When the listing counts, a question
 * listed again before and still open goes to the broker, as after two misses on one question (a question waiting on its
 * yes or no isn't counted). One question left is asked on its own, as before; none, and Tina moves on.
 */
function relist(c: Ctx, w: Work, st: FollowOnState, out: Out[], lead: Relist, at: string, wamid: string): FollowOnState | null {
  const relisted = { ...(st.relisted ?? {}) };
  if (lead.count) {
    const later: string[] = [];
    for (const item of openBatch(c, w, st)) {
      if (!applies(item, w.answers, w.facts)) continue;
      if (!relisted[item.key]) {
        relisted[item.key] = 1;
        continue;
      }
      // TTTFG-4830 (still need): one the client can get stays theirs (on the list at the end), not the broker's.
      const record: AnswerRecord = { value: null, status: chased(item) ? 'not-yet' : 'broker-to-confirm', at, wamid };
      out.push({ kind: 'save-answer', key: item.key, record });
      w.answers[item.key] = record;
      if (record.status === 'not-yet') later.push(item.key);
    }
    if (later.length) st = { ...st, skipped: [...st.skipped, ...later] };
  }
  const open = openBatch(c, w, st);
  if (!open.length) return proceed(c, w, st, out);
  const base = { ...moveOn(st), phase: 'items' as const, asking: open[0].key };
  if (open.length === 1) {
    out.push({ kind: 'ask', item: open[0], simpler: !lead.one && !!lead.simpler, lead: lead.one });
    return { ...base, misses: relisted[open[0].key] ?? 0 };
  }
  out.push({ kind: 'ask-batch', items: open, lead: lead.many });
  return { ...base, batch: open.map((i) => i.key), misses: 0, relisted };
}

/** The host's nudge: when Tina is still waiting on that message, what's open is listed again. */
/** TTTFG-4830: a file whose name the client gave (a document), not one Tina's host named (image-<time>.jpeg). */
export const clientNamed = (file: ClientFile) => !/^(image|document|video|audio)-\d+(\.\w+)?$/i.test(file.fileName);

/**
 * TTTFG-4830: Tina's one answer about the files the client sent for the evidence item she asked: all its files are in
 * (the front and back): thanked and on to the next item; fewer than it needs: asks for the rest; an item of any number
 * (photos of the scene): "Are those all of them?" and she waits for the yes.
 */
function filesIn(c: Ctx, w: Work, st: FollowOnState, item: QuestionItem, out: Out[]): FollowOnState | null {
  const have = filesFor(item, w.evidence);
  const need = fileCount(item);
  if (need === 'any') {
    out.push({ kind: 'text', text: allOfThem(have, item) });
    return { ...st, confirming: item.key, misses: 0 };
  }
  if (have < need) {
    out.push({ kind: 'text', text: theOthers(have, need) });
    return st;
  }
  out.push({ kind: 'received', item });
  return proceed(c, w, st, out);
}

function nudged(c: Ctx, st: FollowOnState, wamid: string): Step {
  if (st.waiting !== wamid) return { state: st, out: [] };
  if (st.phase === 'still-need') return stillNeedNudged(c, st);
  if (st.waitingFor === 'files') {
    // TTTFG-4830: the files for the evidence item have stopped coming: one answer about all of them.
    const w = work(c.claim);
    const item = formItems(c.form, w.answers, w.facts, st.sapsRequired).find((i) => i.key === st.asking && i.kind === 'evidence');
    const s = { ...st, waiting: undefined, waitingFor: undefined };
    if (!item) return { state: s, out: [] };
    const out: Out[] = [];
    return { state: filesIn(c, w, s, item, out), out };
  }
  if (!st.batch) return { state: st, out: [] };
  const out: Out[] = [];
  return { state: relist(c, work(c.claim), st, out, { ...STILL_NEED, count: true }, c.now.toISOString(), wamid), out };
}

// ------------------------------------------------------------- TTTFG-4830: what the client still has to send

/**
 * A message while Tina is on the list of what the client still has to send (phase `still-need`). It may bring any of
 * it: answers to the listed questions (saved before this, as `also`), the SAPS case number or station, a file. Then:
 * - something new to ask (a correction opened a question), or nothing left (evidence complete): on as after any answer;
 * - something came in and the host can wait (waitForMore): a file is thanked now, and the list goes out again after the
 *   quiet spell, because a client often sends several photos in a row;
 * - otherwise the list again, after "Thanks." when something came in. "Not yet" lists nothing.
 */
function advanceStillNeed(
  c: Ctx, w: Work, st: FollowOnState, input: ClientReply, out: Out[],
  side: { corrected: number; flagged: number; ownReading: boolean; noted: number },
): FollowOnState | null {
  let got = side.noted > 0 || side.corrected > 0;
  let filed = false;
  if (side.corrected) out.push({ kind: 'text', text: side.ownReading ? NOTED_OTHERS : CORRECTED });
  const caseNumber = input.kind === 'saps' ? input.caseNumber?.trim() || undefined : undefined;
  const station = input.kind === 'saps' ? input.station?.trim() || undefined : undefined;
  if (caseNumber || station) {
    out.push({ kind: 'save-saps', caseNumber, station });
    w.facts = { ...w.facts, sapsCaseNumber: caseNumber ?? w.facts.sapsCaseNumber, sapsStation: station ?? w.facts.sapsStation };
    got = true;
  } else if (input.kind === 'file') {
    // As the evidence item Claude read it as, else the only one missing, else against the claim for the pipeline to sort.
    const open = formItems(c.form, w.answers, w.facts, st.sapsRequired)
      .filter((i) => i.kind === 'evidence' && applies(i, w.answers, w.facts) && !evidenceIn(i, w.evidence));
    const item = open.find((i) => i.key === input.forItem) ?? (open.length === 1 ? open[0] : undefined);
    out.push({ kind: 'file', file: input.file, itemKey: item?.key });
    if (item) w.evidence.push({ key: item.key });
    if (item && evidenceIn(item, w.evidence)) out.push({ kind: 'received', item });
    else out.push({ kind: 'text', text: FILE_SAVED });
    got = filed = true;
  } else if (input.kind === 'not-yet' && !got) {
    out.push({ kind: 'text', text: WHEN_YOU_HAVE_THEM });
    return { ...st, waiting: undefined };
  }
  // A new value that doesn't look right was pointed out (formats.ts): Tina waits for it again.
  if (!got && side.flagged) return { ...st, waiting: undefined };

  const thanks = got && !filed ? 'Thanks.' : undefined;
  const next = nextItem(c.form, w.answers, w.evidence, { facts: w.facts, sapsRequired: st.sapsRequired, skip: [...st.skipped, SAPS_CASE_KEY, SAPS_STATION_KEY] });
  const missing = missingItems(c.form, w.answers, w.evidence, { facts: w.facts, sapsRequired: st.sapsRequired });
  if (next || !missing.length) return proceed(c, w, { ...st, waiting: undefined }, out, thanks, thanks ?? '');
  if (got && c.waitForMore) return { ...st, waiting: input.wamid };
  out.push({ kind: 'still-missing', items: missing, lead: thanks ?? '' });
  return stillNeedState(c, st, missing);
}

/** The host's nudge after a quiet spell on the list: what's still needed, listed again (or the end, if nothing is). */
function stillNeedNudged(c: Ctx, st: FollowOnState): Step {
  const w = work(c.claim);
  const out: Out[] = [];
  return { state: proceed(c, w, { ...st, waiting: undefined }, out, undefined, 'Thanks.'), out };
}

// ------------------------------------------------------------------------------------------------------- the texts

const HINT: Partial<Record<QuestionItem['answerType'], string>> = {
  'yes/no': ' Please just answer yes or no.',
  date: ' For example: 3 November 2026.',
  number: ' Please reply with a number.',
  photo: ' You can send it here as a photo.',
  document: ' You can send it here as a photo or a PDF.',
  video: ' You can send it here as a video.',
};

/**
 * An evidence item's prompt as a request. The go-live configs (TTTFG-5172) describe the item ("A copy of the car's
 * registration papers (NaTIS document).", "If the car was found damaged: a damage report from the panelbeater."), so
 * Tina puts "Please send me" in front, keeping the config's words. A prompt that already asks is left alone.
 */
export function evidenceRequest(item: QuestionItem): string {
  const p = item.prompt.trim();
  if (/^(please|can you|could you|send|upload|share|attach)\b/i.test(p)) return p;
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const cond = /^(If [^:]+):\s*(.+)$/s.exec(p);
  return cond ? `${cond[1]}, please send me ${lower(cond[2])}` : `Please send me ${lower(p)}`;
}

/**
 * The default wording: the question list's plain-language prompt (an evidence item's as a request; an optional one
 * says the client can tell Tina they don't have it). A second try adds how to answer.
 */
export function askText(item: QuestionItem, simpler: boolean, again = false): string {
  // TTTFG-5184: asked again only because the client said "not yet" last time; never the same words twice.
  if (again && !simpler) {
    if (item.key === SAPS_CASE_KEY) return 'Do you have the SAPS case number yet? If so, please send it with the name of the police station you reported it at.';
    if (item.kind === 'evidence' || chased(item)) return `Have you got ${itemName(item)} yet? If so, please send it here.`;
  }
  const prompt = item.kind === 'evidence'
    ? `${evidenceRequest(item)}${item.required || /if you have/i.test(item.prompt) ? '' : " If you don't have this, just say so."}`
    : item.prompt;
  if (!simpler) return prompt;
  const choices = item.answerType === 'choice' && item.choices?.length ? `\n${item.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : '';
  return `Sorry, I didn't quite get that. ${prompt}${HINT[item.answerType] ?? ''}${choices}`;
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/**
 * TTTFG-4830: what a batch is about, as "A few questions about …" ends: its first question's section, and for a later
 * entry of a repeating group, which one ("the passenger (the second one)").
 */
export function batchTopic(items: readonly QuestionItem[]): string {
  const first = items[0];
  const section = first?.section ?? 'your claim';
  const n = first?.group ? Number(/\.(\d+)$/.exec(first.key)?.[1] ?? 1) : 1;
  if (n < 2) return section;
  return `${section} (${ORDINALS[n - 1] ? `the ${ORDINALS[n - 1]} one` : `number ${n}`})`;
}

/** "What is…" becomes "what is…"; "SAPS…" stays. */
const uncap = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/**
 * TTTFG-4830: a batch's questions as Tina words them, without the numbers. A question asked ahead of the yes or no it
 * depends on says so ("If no to 4: whose name is the car registered in?"). `choices`: a choice question shows its
 * choices (when it's listed again).
 */
export function batchLines(items: readonly QuestionItem[], choices = false): string[] {
  return items.map((item) => {
    const c = item.onlyIf;
    const parent = c && typeof c.equals === 'boolean' ? items.findIndex((p) => p.key === c.key) : -1;
    const text = parent >= 0 ? `If ${c!.equals ? 'yes' : 'no'} to ${parent + 1}: ${uncap(item.prompt)}` : item.prompt;
    return `${text}${choices && item.answerType === 'choice' && item.choices?.length ? ` (${item.choices.join(', ')})` : ''}`;
  });
}

/** TTTFG-4830: a batch as Tina sends it: the lead and the intro, then the questions numbered from 1. */
export function batchText(items: readonly QuestionItem[], o: { lead?: string; intro?: { hint: boolean; same: boolean } } = {}): string {
  const intro = o.intro
    ? `${o.intro.same ? 'A few more questions about' : o.intro.hint ? 'A few questions about' : 'Next, a few questions about'} ${batchTopic(items)}.`
      + (o.intro.hint ? ` ${BATCH_HINT}` : '')
    : undefined;
  const lines = batchLines(items, !o.intro).map((l, i) => `${i + 1}. ${l}`);
  return [[o.lead, intro].filter(Boolean).join(' '), ...lines].filter(Boolean).join('\n');
}

/** TTTFG-5254 step 14. The sign line only while a signing link is out: not when signed, and not when none was sent. */
export function closingText(signature: SignatureStatus, owner: Owner): string {
  return [
    "That's everything the insurer needs for now.",
    signature === 'Link sent' ? 'Please check and sign the form using the link I sent.' : '',
    `${capital(owner.name)} will check your claim next.`,
  ].filter(Boolean).join(' ');
}

/** "a, b and c". Names that come out the same (several missing questions of one group entry) are listed once. */
export const list = (names: string[]) => {
  const n = [...new Set(names)];
  return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
};

/** TTTFG-4830 (still need): the heading of the list, in the client's words. */
export const STILL_NEED_HEADING = 'Things we still need from you:';

/** "the vehicle registration number" as a line of a list: "Vehicle registration number". */
export const lineName = (item: QuestionItem) => {
  const name = itemName(item).replace(/^the\s+/i, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
};

/**
 * TTTFG-4830 (still need): the lines of "Things we still need from you", one per item the client can get (chased), in
 * the question list's order. On a claim the client left half way (TTTFG-5212's reminder), the questions Tina hasn't
 * asked yet are counted in one line instead, after the questions: she asks those one by one when the client is back.
 * The SAPS items, the documents and anything the client said "not yet" to are named there too.
 */
export function stillNeedLines(items: readonly QuestionItem[], answers: ClaimAnswers = {}): string[] {
  const halfWay = items.some((i) => !chased(i));
  const named = (i: QuestionItem) => chased(i) && (!halfWay || i.kind === 'evidence' || isSaps(i.key) || deferred(i.key, answers));
  const questions = [...new Set(items.filter((i) => i.kind === 'question' && named(i)).map(lineName))];
  const others = items.filter((i) => !named(i)).length;
  const counted = others ? [others === 1 ? 'The answer to 1 more question' : `The answers to ${others} more questions`] : [];
  const evidence = [...new Set(items.filter((i) => i.kind === 'evidence' && named(i)).map(lineName))];
  return [...questions, ...counted, ...evidence];
}

/**
 * TTTFG-4830 (still need): "Thanks, that's all for now. Things we still need from you:", the items as a bulleted list
 * (WhatsApp shows "- " lines as bullets), then how to send them. `lead` replaces "Thanks, that's all for now." ('' for none).
 */
export function stillMissingText(items: readonly QuestionItem[], lead: string = ALL_FOR_NOW): string {
  const lines = stillNeedLines(items);
  const them = itOrThem(lines);
  return [[lead, STILL_NEED_HEADING].filter(Boolean).join(' '), ...lines.map((l) => `- ${l}`), `Please send ${them} here when you have ${them}.`].join('\n');
}

// ----------------------------------------------------------------------------------------------------- the turn

/**
 * One turn: { kind: 'start', claimId } right after claimTurn() opened the claim, else what Claude understood from the
 * client's message. Returns the state to keep, or null when Tina has nothing more to ask.
 */
export async function followOnTurn(
  ports: FollowOnPorts, conv: Conversation, state: FollowOnState | null, input: FollowOnInput, now: Date, settings: ClaimSettings = {},
): Promise<{ state: FollowOnState | null }> {
  const at = now.toISOString();
  // TTTFG-4830: a nudge Tina isn't waiting on any more (the client wrote again since) reads and writes nothing.
  if (input.kind === 'nudge' && (!state || state.waiting !== input.wamid)) return { state };
  if (input.kind !== 'start' && input.kind !== 'resume' && !state) throw new Error('TTTFG-5176: a follow-on message with no follow-on state');
  const claimId = input.kind === 'start' || input.kind === 'resume' ? input.claimId : state!.claimId;
  const claim = await ports.loadClaim(claimId);

  let form: StoredClaimForm;
  if (input.kind === 'start' || !claim.claimFormId) {
    // TTTFG-5254 step 2: the active form for the provider and claim type, else the generic row.
    form = (await ports.activeClaimForm(claim.providerId, claim.claimType)) ?? (await ports.genericClaimForm());
    await ports.setClaimForm(claimId, form.id);
  } else {
    form = await ports.claimForm(claim.claimFormId);
  }
  if (input.kind !== 'start' && input.kind !== 'nudge') await ports.setLastClientMessageOn(claimId, at);

  const ctx: Ctx = {
    claim, form, now, warningDays: settings.notificationWarningDays ?? CLAIM_SETTINGS_DEFAULTS.notificationWarningDays,
    ...(settings.waitForMore ? { waitForMore: true } : {}),
  };
  const step =
    input.kind === 'start' ? startFollowOn(ctx, input.describedAsTheft, input.files, input.reported)
    : input.kind === 'resume' ? resumeStep(ctx, input.files, input.introSent, input.lead, input.skipped)
    : advanceFollowOn(ctx, state!, input);

  const answers: ClaimAnswers = { ...claim.answers };
  let status = claim.status;
  let signature = claim.signatureStatus;
  const action = (detail: string, template?: { name: string; version: string; text: string }) =>
    ports.createAgentAction({
      kind: 'Created', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claimId }, contactId: claim.contactId, detail, at, template,
    });
  const say = (text: string) => sendClaimText(ports, conv, text, claim, at);
  const setStatus = async (to: ClaimStatus) => {
    if (status === to) return;
    await ports.setStatus(claimId, to);
    await action(`Claim ${claim.reference} status set to ${to}.`);
    status = to;
  };

  for (const [i, o] of step.out.entries()) {
    switch (o.kind) {
      case 'saps-instruction':
        await say(SAPS_INSTRUCTION);
        break;
      case 'ask': {
        const text = askText(o.item, o.simpler, o.again);
        const phrased = ports.phrase ? await ports.phrase(text, { key: o.item.key, simpler: o.simpler }) : text;
        await say(o.lead ? `${o.lead} ${phrased}` : phrased);
        break;
      }
      case 'ask-batch':
        // TTTFG-4830: code text, never rephrased: the numbers are what the client answers by.
        await say(batchText(o.items, o));
        break;
      case 'saps-required':
        await ports.setSapsRequired(claimId);
        break;
      case 'text':
        await say(o.text);
        break;
      case 'template':
        await ports.send(conv.phone, { kind: 'template', name: o.template.name, version: o.template.version, text: o.text });
        await action(`${o.template.name} sent on WhatsApp for claim ${claim.reference}.`, { name: o.template.name, version: o.template.version, text: o.text });
        break;
      case 'received':
        await say(`Thanks, I've got ${itemName(o.item)}.`);
        break;
      case 'closing':
        await say(closingText(signature, claim.owner));
        break;
      case 'still-missing':
        await say(stillMissingText(o.items, o.lead));
        break;
      case 'save-answer':
      case 'drop-answer':
        if (o.kind === 'save-answer') answers[o.key] = o.record;
        else delete answers[o.key];
        // Several changes from one message are written together.
        if (!['save-answer', 'drop-answer'].includes(step.out[i + 1]?.kind ?? '')) await ports.saveAnswers(claimId, answers);
        break;
      case 'save-saps':
        await ports.saveSaps(claimId, { caseNumber: o.caseNumber, station: o.station });
        break;
      case 'file':
        if (o.file.media === 'video') await ports.storeVideo(o.file, { claimId, itemKey: o.itemKey });
        else await ports.fileToPipeline(o.file, { claimId, itemKey: o.itemKey });
        break;
      case 'request-signature':
        if ((await ports.requestClaimSignature(claimId)) === 'sent') {
          await setStatus('Form sent');
          signature = 'Link sent';
        }
        break;
      case 'status':
        await setStatus(o.status);
        break;
      case 'evidence-complete':
        await ports.setEvidenceComplete(claimId);
        await action(`All required items are in for claim ${claim.reference} (evidence complete).`);
        break;
      case 'follow-up':
        await ports.createAgentAction({
          kind: 'Follow-up', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claimId }, contactId: claim.contactId,
          detail: o.detail, at,
        });
        break;
    }
  }
  return { state: step.state };
}

/** Every text Tina sends on the claim passes the policy gate. A blocked one becomes the holding line and a Follow-up. */
async function sendClaimText(ports: FollowOnPorts, conv: Conversation, text: string, claim: FollowOnClaim, at: string) {
  const gate = claimGate(text);
  if (!gate.ok) {
    await ports.createAgentAction({
      kind: 'Follow-up', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claim.id }, contactId: claim.contactId, at,
      detail: `Tina's reply on claim ${claim.reference} was blocked by the ${gate.rule} rule ("${gate.matched}"). The client got the holding line. Please update them.`,
    });
  }
  await ports.send(conv.phone, { kind: 'text', text: gate.text });
}
