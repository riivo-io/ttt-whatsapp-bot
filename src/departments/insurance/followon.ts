// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/followon.ts (commit 2ec679b). Do not edit here:
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
import { DEPARTMENT, type AgentActionRow, type Conversation, type Outbound, type Owner } from './claim';
import type { AnswerRecord, ClaimAnswers, ClaimForm, QuestionItem, RequestClaimSignature } from './contracts';
import { formatProblem } from './formats';
import { claimGate } from './gate';
import {
  applies, deferred, formItems, itemName, missingItems, nextItem, sapsStepApplies, SAPS_CASE_KEY, SAPS_ITEMS, SAPS_STATION_KEY,
  type ClaimFacts, type ReceivedEvidence,
} from './progress';
import { DEADLINE_PASSED_TEMPLATE, DEADLINE_UPCOMING_TEMPLATE, DISCLOSURE_TEMPLATE, type ClaimTemplate } from './templates';
import type { ClaimType, Facts } from './walkthrough';

/** Package settings. `claims.notificationWarningDays`: send the Upcoming note when this many days or fewer are left. */
export interface ClaimSettings { notificationWarningDays?: number }
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
  phase: 'saps' | 'items';
  /** The key Tina asked last. */
  asking: string;
  /** Unreadable replies to `asking` in a row. */
  misses: number;
  sapsRequired: boolean;
  /** "Not yet" in this conversation. Still on the missing list. */
  skipped: string[];
  /** TTTFG-4830: the question whose answer Tina said didn't look right (formats.ts). A second such answer is kept. */
  formatChecked?: string;
  signingRequested: boolean;
  evidenceStarted: boolean;
  /** The deadline note and the duty of disclosure are out (TTTFG-5184: a resume doesn't send them again). */
  introSent?: boolean;
  /**
   * TTTFG-5184: on a resumed claim, the item Tina was left waiting on (asked last time, never answered). When it is
   * asked again it starts "Back to where we left off:", so the client doesn't get the same words twice.
   */
  waitingOn?: string;
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
   * new values for questions the client answered earlier ("actually no, there was no other car").
   */
  | { kind: 'value'; value: string | number | boolean; wamid: string; also?: OtherAnswer[]; corrections?: OtherAnswer[] }
  | { kind: 'saps'; caseNumber?: string; station?: string; wamid: string; also?: OtherAnswer[]; corrections?: OtherAnswer[] }
  /** "I don't have it yet." */
  | { kind: 'not-yet'; wamid: string; also?: OtherAnswer[]; corrections?: OtherAnswer[] }
  /** Claude could not get a value from the reply (for the item asked; `also` and `corrections` may still apply). */
  | { kind: 'unparsed'; wamid: string; also?: OtherAnswer[]; corrections?: OtherAnswer[] }
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
/** TTTFG-4830: the client changed an earlier answer. */
export const CORRECTED = "No problem, I've changed that.";
/** TTTFG-4830: the reply answered other questions but not the one Tina asked. */
export const NOTED_OTHERS = "Thanks, I've noted that.";
/** TTTFG-4830: after the duty of disclosure, when the client's report already answered some of the form's questions. */
export const usedReport = (n: number) =>
  `I've filled in ${n === 1 ? 'one of the insurer\'s questions' : `${n} of the insurer's questions`} from what you've already told me, so I won't ask ${n === 1 ? 'it' : 'them'} again.`;

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
  | { kind: 'saps-required' }
  | { kind: 'text'; text: string }
  | { kind: 'template'; template: ClaimTemplate; text: string }
  | { kind: 'received'; item: QuestionItem }
  | { kind: 'closing' }
  | { kind: 'still-missing'; items: QuestionItem[] }
  | { kind: 'save-answer'; key: string; record: AnswerRecord }
  /** TTTFG-4830: an answer that no longer belongs on the claim (a group entry the client took back). */
  | { kind: 'drop-answer'; key: string }
  | { kind: 'save-saps'; caseNumber?: string; station?: string }
  | { kind: 'file'; file: ClientFile; itemKey?: string }
  | { kind: 'request-signature' }
  | { kind: 'status'; status: 'Awaiting client docs' }
  | { kind: 'evidence-complete' };

export interface Ctx { claim: FollowOnClaim; form: ClaimForm; now: Date; warningDays: number }
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
      return s && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined;
    case 'choice':
      return s ? item.choices?.find((c) => c.toLowerCase() === s.toLowerCase()) : undefined;
    default:
      return s || (typeof v === 'number' ? String(v) : undefined);
  }
}

/** The next question or evidence item, the signing step between them, and the end. */
function proceed(c: Ctx, w: Work, st: FollowOnState, out: Out[]): FollowOnState | null {
  // The SAPS keys belong to the SAPS step; the questions never ask them again.
  const skip = [...st.skipped, SAPS_CASE_KEY, SAPS_STATION_KEY];
  const next = nextItem(c.form, w.answers, w.evidence, { facts: w.facts, sapsRequired: st.sapsRequired, skip });
  const lead = next && next.key === st.waitingOn && !deferred(next.key, w.answers) ? LEFT_OFF : undefined;
  if (st.waitingOn) st = { ...st, waitingOn: undefined };
  if (next?.kind === 'question') {
    out.push({ kind: 'ask', item: next, simpler: false, again: deferred(next.key, w.answers), lead });
    return { ...st, phase: 'items', asking: next.key, misses: 0 };
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
  out.push(...(missing.length ? [{ kind: 'still-missing', items: missing } as const] : [{ kind: 'evidence-complete' } as const, { kind: 'closing' } as const]));
  return null;
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
  return proceed(c, w, st, out);
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
  // TTTFG-4830: what the client already said while reporting the claim answers those questions; they aren't asked.
  const used = applyOthers(c, w, st.sapsRequired, reported, { at: c.now.toISOString(), source: 'report' }, out);
  const noteUsed = (step: FollowOnState | null): Step => {
    const first = out.findIndex((o) => o.kind === 'ask');
    if (used && first >= 0) out.splice(first, 0, { kind: 'text', text: usedReport(used) });
    return { state: step, out };
  };
  if (st.sapsRequired && (!w.facts.sapsCaseNumber || !w.facts.sapsStation)) {
    if (!w.facts.sapsCaseNumber) out.push({ kind: 'saps-instruction' });
    const item = sapsAsk(w.facts);
    out.push({ kind: 'ask', item, simpler: false });
    return noteUsed({ ...st, phase: 'saps', asking: item.key });
  }
  return noteUsed(intro(c, w, st, out));
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
  rec: { at: string; wamid?: string; source: 'report' | 'same-message' }, out: Out[], except?: string,
): number {
  if (!others?.length) return 0;
  let saved = 0;
  for (let pass = 0, progress = true; progress && pass < 5; pass++) {
    progress = false;
    const items = formItems(c.form, w.answers, w.facts, sapsRequired);
    for (const o of others) {
      if (o.key === except || o.key.includes('.more.') || isSaps(o.key)) continue;
      const prev = w.answers[o.key];
      if (prev && prev.status !== 'not-yet') continue;
      const item = items.find((i) => i.key === o.key);
      if (!item || item.kind !== 'question' || !applies(item, w.answers, w.facts)) continue;
      const value = accept(item, o.value);
      // A value that doesn't look right isn't saved on the side: Tina asks the question later and checks it then.
      if (value === undefined || formatProblem(item, value)) continue;
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
): { changed: number; flagged: number } {
  let changed = 0;
  let flagged = 0;
  if (!corrections?.length) return { changed, flagged };
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
  return { changed, flagged };
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
      .filter((i) => i.kind === 'evidence' && applies(i, w.answers, w.facts) && !w.evidence.some((e) => e.key === i.key));
    const item = open.find((i) => i.key === f.forItem) ?? (open.length === 1 ? open[0] : undefined);
    out.push({ kind: 'file', file: f.file, itemKey: item?.key });
    if (item) {
      out.push({ kind: 'received', item });
      w.evidence.push({ key: item.key });
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
  const ask = out.slice(first).find((o): o is Extract<Out, { kind: 'ask' }> => o.kind === 'ask');
  if (lead && ask) ask.lead = lead;
  else if (lead) out.splice(first, 0, { kind: 'text', text: lead });
  return { state: next, out };
}

export function advanceFollowOn(c: Ctx, st: FollowOnState, input: Exclude<FollowOnInput, { kind: 'start' | 'resume' }>): Step {
  const w = work(c.claim);
  const out: Out[] = [];
  const at = c.now.toISOString();
  // TTTFG-4830: an earlier answer the client changed, then the other questions this message answered, are saved first,
  // so Tina neither carries on from a wrong answer nor asks for something she was just told.
  const { changed: corrected, flagged } = input.kind === 'file'
    ? { changed: 0, flagged: 0 }
    : applyCorrections(c, w, st.sapsRequired, input.corrections, { at, wamid: input.wamid }, out, st.asking);
  const noted = input.kind === 'file' ? 0 : applyOthers(c, w, st.sapsRequired, input.also, { at, wamid: input.wamid, source: 'same-message' }, out, st.asking);

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

  const item = formItems(c.form, w.answers, w.facts, st.sapsRequired).find((i) => i.key === st.asking);
  if (!item || !applies(item, w.answers, w.facts)) {
    // The correction took away the question Tina was asking (no second car, so no second car's make): on to the next.
    if (corrected) out.push({ kind: 'text', text: CORRECTED });
    return { state: proceed(c, w, { ...st, misses: 0 }, out), out };
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
    const other = input.forItem && input.forItem !== item.key
      ? formItems(c.form, w.answers, w.facts, st.sapsRequired).find((i) => i.key === input.forItem && i.kind === 'evidence'
        && applies(i, w.answers, w.facts) && !w.evidence.some((e) => e.key === i.key))
      : undefined;
    if (other) {
      out.push({ kind: 'file', file: input.file, itemKey: other.key }, { kind: 'received', item: other });
      w.evidence.push({ key: other.key });
      if (item.kind === 'question') out.push({ kind: 'ask', item, simpler: false, lead: 'Back to my question:' });
      return { state: st, out };
    }
    if (item.kind === 'evidence') {
      out.push({ kind: 'file', file: input.file, itemKey: item.key }, { kind: 'received', item });
      w.evidence.push({ key: item.key });
      return { state: proceed(c, w, st, out), out };
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
    if (problem && st.formatChecked !== item.key) {
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

  // "Not yet" passes over an evidence item or an optional question. A required question is never left on a guess:
  // "I don't know" is a miss like any other, and the broker confirms it.
  if (input.kind === 'not-yet' && (item.kind === 'evidence' || !item.required)) {
    // Kept on the claim, so a later conversation doesn't ask an optional item again, and asks a required one as "yet?".
    const record: AnswerRecord = { value: null, status: 'not-yet', at, wamid: input.wamid };
    out.push({ kind: 'save-answer', key: item.key, record });
    w.answers[item.key] = record;
    return { state: proceed(c, w, { ...st, skipped: [...st.skipped, item.key] }, out), out };
  }

  // The message changed an earlier answer or answered other questions, but not this one: that isn't a miss. Say so and
  // ask it again as it was.
  if ((corrected || noted || flagged) && input.kind === 'unparsed') {
    out.push({ kind: 'ask', item, simpler: false, lead: corrected ? CORRECTED : noted ? NOTED_OTHERS : undefined });
    return { state: st, out };
  }

  // A miss. Once: ask again in simpler words. Twice: the broker confirms it (a question) or it stays missing (evidence).
  if (st.misses + 1 < 2) {
    out.push({ kind: 'ask', item, simpler: true });
    return { state: { ...st, misses: st.misses + 1 }, out };
  }
  if (item.kind === 'evidence') return { state: proceed(c, w, { ...st, skipped: [...st.skipped, item.key] }, out), out };
  const record: AnswerRecord = { value: null, status: 'broker-to-confirm', at, wamid: input.wamid };
  out.push({ kind: 'save-answer', key: item.key, record });
  w.answers[item.key] = record;
  return { state: proceed(c, w, st, out), out };
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
    if (item.kind === 'evidence') return `Have you got ${itemName(item)} yet? If so, please send it here.`;
  }
  const prompt = item.kind === 'evidence'
    ? `${evidenceRequest(item)}${item.required || /if you have/i.test(item.prompt) ? '' : " If you don't have this, just say so."}`
    : item.prompt;
  if (!simpler) return prompt;
  const choices = item.answerType === 'choice' && item.choices?.length ? `\n${item.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : '';
  return `Sorry, I didn't quite get that. ${prompt}${HINT[item.answerType] ?? ''}${choices}`;
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

export function stillMissingText(items: QuestionItem[]): string {
  return `Thanks, that's all for now. When you have them, please send me ${list(items.map(itemName))} here.`;
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
  if (input.kind !== 'start') await ports.setLastClientMessageOn(claimId, at);

  const ctx: Ctx = { claim, form, now, warningDays: settings.notificationWarningDays ?? CLAIM_SETTINGS_DEFAULTS.notificationWarningDays };
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
        await say(stillMissingText(o.items));
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
