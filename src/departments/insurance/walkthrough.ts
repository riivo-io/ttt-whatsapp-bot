// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/walkthrough.ts (commit 39b117f). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5168: Tina opens a short-term insurance claim on WhatsApp (SPEC-04 "Tina's claim walkthrough", steps 1 to 6).
// The first piece of the Insurance and Advice department package (SPEC-05). It imports nothing from the email
// pipeline, so it moves into the shared agent package (TTTFG-4830) as it is.
//
// The walkthrough is a state machine in code, not prompt text (TTTFG-5247): a prompt can skip or reorder what to do if
// anyone is hurt, and the order is the point. Claude only understands each answer (the Answer type) and may
// phrase each question; the fixed messages (what to do if anyone is hurt, unknown number, acknowledgement) are code text.
//
// Steps, in the story's order: find client -> confirm policy -> claim type -> what to gather at the scene, and ready
// -> what, when and where -> third parties, SAPS and injuries -> summary -> confirmed (the claim opens, FNOL logged).
// TTTFG-4830 (28 Oct 2026): "Is anyone hurt or in danger?" is no longer a question. The reply to the policy starts with
// what to do if anyone is (call 10111, come back once everyone is safe), so nobody waits on a yes before getting it.
// Once Tina knows the kind of claim, she sends what to gather while they are still at the scene (claim.ts
// onSceneText), once, and waits for the client to say they're ready before the questions about what happened.
//
// Only a WhatsApp number on the CRM can open a claim (decided 9 October 2026): an unknown number gets the
// unknown-number reply, no claim and no follow-up. Tina never asks for an ID number or a policy number.
//
// Pure: no reads, no clock. claim.ts does the I/O.

/** One of the client's active riivo_policy rows, with its provider. Read once when the claim starts. */
export interface Policy {
  id: string;
  providerId: string;
  insurer: string;
  product: string;
  policyNumber: string;
  /** riivo_provider.riivo_assistnumber; empty when the insurer has none on file. */
  assistNumber?: string;
}

/** riivo_claim.riivo_claimtype. The values follow the go-live forms (TTTFG-5172) until TTTFG-4885 sets the choice. */
export const CLAIM_TYPES = [
  'Motor accident', 'Motor theft', 'Hijacking', 'Windscreen', 'Property loss or damage', 'Portable possessions', 'Other',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** What the client has told Tina about the incident so far. */
export interface Facts {
  claimType?: ClaimType;
  description?: string;
  /** Date and time of the incident, ISO 8601 with offset. */
  incidentAt?: string;
  /** Half of incidentAt, when the client gave only the date (YYYY-MM-DD, South African time) or only the time (HH:mm)
   *  so far. merge() joins them into incidentAt; Tina then asks only for the other half. Never sent to the CRM. */
  incidentDate?: string;
  incidentTime?: string;
  place?: string;
  thirdParties?: boolean;
  thirdPartyDetails?: string;
  saps?: boolean;
  injuries?: boolean;
  injuryDetails?: string;
}
export type Fact = keyof Facts;

/** 'danger': a conversation saved before 28 Oct 2026 that was asked "Is anyone hurt or in danger?"; read as 'ready'. */
export type Step = 'policy' | 'ready' | 'danger' | 'claim-type' | 'incident' | 'parties' | 'summary';

/** Stored on the Tina conversation until the client confirms. */
export interface WalkthroughState {
  contactId: string;
  firstName: string;
  policies: Policy[];
  policyId?: string;
  step: Step;
  facts: Facts;
  /**
   * TTTFG-4830: how often each question has been asked (by askedKey), so Tina never sends the same words twice: the
   * second time is worded differently, with an example. The date and time count as one question.
   */
  asked?: Record<string, number>;
  /**
   * TTTFG-4830: the client's first words about it when too short to keep as the description ("Hi, my phone was
   * stolen"). Never sent to the CRM; read only to tell what kind of claim it is (isTheft), so Tina words her questions
   * for a stolen phone while she still asks for the whole story.
   */
  opening?: string;
  /** TTTFG-4830: the on-scene checklist has gone out (it goes once). */
  onSceneSent?: true;
}

/** What Claude understood from the client's message. Code decides what happens next. */
export type Answer =
  | { kind: 'policy'; policyId: string }
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'facts'; facts: Facts }
  /** At the summary: the client says it is right. */
  | { kind: 'confirm' }
  /** At the summary: the client says something is wrong, with the new values when they gave them. */
  | { kind: 'correct'; facts: Facts; fields?: Fact[] }
  /**
   * TTTFG-4830 (28 Oct 2026): the client asked Tina something instead of answering. `help`: Claude's short answer about
   * Tina's question (what a word means, where to find it); absent: it's for the broker (cover, payment, advice).
   */
  | { kind: 'question'; question: string; help?: string }
  | { kind: 'unclear' };

/** Something Tina says. 'ask' is a question Claude may phrase; the rest are fixed text. */
export type Say =
  /** `correcting`: the client said the summary is wrong; ask for the right value(s) instead of reading it again. */
  /** `tries`: how often each question in it was asked before this time (askedKey); absent or 0 is the first time. */
  | { kind: 'ask'; step: Step; missing: Fact[]; correcting?: true; tries?: Record<string, number> }
  /** TTTFG-4830: what to do if anyone is hurt or in danger. Said once, at the start of the reply to the policy. */
  | { kind: 'safety' }
  /** TTTFG-4830: the answer to the client's question about what Tina asked (Answer 'question'), before she asks again. */
  | { kind: 'help'; text: string }
  /** TTTFG-4830: the client's question is for the broker, who got it as a Follow-up. */
  | { kind: 'to-broker' }
  /**
   * TTTFG-4830: what to gather while still at the scene, for the kind of claim, ending with "tell me when you're ready"
   * (claim.ts onSceneText).
   */
  | { kind: 'on-scene' }
  | { kind: 'unknown-number' }
  /** No active policy, or not the policy on file: a person will contact the client (date from the follow-up). */
  | { kind: 'passed-on'; reason: FollowUpReason };

/** 'client-question' (TTTFG-4830): the client asked something only a person can answer. */
export type FollowUpReason = 'no-active-policy' | 'policy-not-on-file' | 'client-question';

/** I/O the walkthrough asks for. claim.ts carries it out. */
export type Effect =
  /** A riivo_agentaction Follow-up. 'broker' = the chosen policy's owner, else the Insurance and Advice team. */
  /** `question`: the client's question, for 'client-question'. */
  | { kind: 'follow-up'; to: 'broker' | 'team'; reason: FollowUpReason; question?: string }
  | { kind: 'open-claim' };

export interface Turn {
  /** null when the walkthrough has ended (claim opened, or handed to a person). */
  state: WalkthroughState | null;
  say: Say[];
  effects: Effect[];
}

/** The facts each step needs, in order. A yes on third parties or injuries also needs the details. */
export function missingFor(step: Step, f: Facts): Fact[] {
  switch (step) {
    case 'claim-type':
      return f.claimType ? [] : ['claimType'];
    case 'incident': {
      const m: Fact[] = [];
      if (!f.description) m.push('description');
      if (!f.incidentAt) m.push(f.incidentDate ? 'incidentTime' : f.incidentTime ? 'incidentDate' : 'incidentAt');
      if (!f.place) m.push('place');
      return m;
    }
    case 'parties': {
      const m: Fact[] = [];
      if (f.thirdParties === undefined) m.push('thirdParties');
      else if (f.thirdParties && !f.thirdPartyDetails) m.push('thirdPartyDetails');
      if (f.saps === undefined) m.push('saps');
      if (f.injuries === undefined) m.push('injuries');
      else if (f.injuries && !f.injuryDetails) m.push('injuryDetails');
      return m;
    }
    default:
      return [];
  }
}

const FACT_STEPS: Step[] = ['claim-type', 'incident', 'parties'];

/** The first fact step with something missing, else the summary. Facts the client volunteers early are kept. */
function nextFactStep(f: Facts): Step {
  return FACT_STEPS.find((s) => missingFor(s, f).length > 0) ?? 'summary';
}

const ask = (step: Step, f: Facts): Say => ({ kind: 'ask', step, missing: missingFor(step, f) });

/**
 * The question a fact belongs to. The date and time asked together are "when"; asked for on their own, after part of
 * "when" came back, they count on from it ("Thanks. Roughly what time was that?", never "At roughly what time…" again).
 */
export const askedKey = (f: Fact): string => (f === 'incidentAt' ? 'when' : f === 'incidentTime' ? 'when-time' : f === 'incidentDate' ? 'when-date' : f);

/** TTTFG-4830: an ask, with how often each of its questions was asked before; the state counts this time. */
function counted(state: WalkthroughState, say: Say): { state: WalkthroughState; say: Say } {
  if (say.kind !== 'ask' || say.correcting) return { state, say };
  const keys = say.missing.length ? [...new Set(say.missing.map(askedKey))] : [say.step];
  // The summary is "the same question" only while it says the same: after a correction it's read out in full again.
  const counter = (k: string) => (k === 'summary' ? `summary:${JSON.stringify(state.facts)}` : k);
  const asked = { ...(state.asked ?? {}) };
  const after = (k: string) => ((k === 'when-time' || k === 'when-date') && (asked.when ?? 0) > 0 ? 1 : 0);
  const tries = Object.fromEntries(keys.map((k) => [k, (asked[counter(k)] ?? 0) + after(k)]));
  for (const k of keys) asked[counter(k)] = (asked[counter(k)] ?? 0) + 1;
  return { state: { ...state, asked }, say: { ...say, tries } };
}

/** TTTFG-4830: words that say something was stolen (with the claim type, isTheft decides). */
const THEFT_WORDS = /\b(stole|stolen|steal|theft|thief|thieves|burglar|burglary|broke in|broke into|broken into|break[- ]?in|robbed|robbery|hijack|mugged|pickpocket|snatched|grabbed|took|taken)/i;

/**
 * TTTFG-4830: a theft, break-in or hijacking. Someone else is always involved, so Tina doesn't ask whether anyone else
 * was ("for example another driver" makes no sense after a break-in); she asks what the client knows about who did it,
 * and whether it was reported to the police.
 */
export function isTheft(f: Facts, opening?: string): boolean {
  if (f.claimType === 'Motor theft' || f.claimType === 'Hijacking') return true;
  return !!f.claimType && ['Property loss or damage', 'Portable possessions', 'Other'].includes(f.claimType)
    && THEFT_WORDS.test(`${f.description ?? ''} ${opening ?? ''}`);
}

function merge(f: Facts, more: Facts, opening?: string): Facts {
  const out: Facts = { ...f };
  for (const [k, v] of Object.entries(more) as [Fact, Facts[Fact]][]) {
    if (v === undefined || v === '') continue;
    (out as Record<Fact, unknown>)[k] = typeof v === 'string' ? v.trim() : v;
  }
  if (out.claimType && !CLAIM_TYPES.includes(out.claimType)) delete out.claimType;
  if (isTheft(out, opening)) out.thirdParties = true;
  // A no clears the details that only a yes needs.
  if (out.thirdParties === false) delete out.thirdPartyDetails;
  if (out.injuries === false) delete out.injuryDetails;
  joinWhen(out, more);
  return out;
}

const SAST = '+02:00'; // South Africa has no daylight saving.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/**
 * A South African date and time as an ISO instant. TTTFG-4830: "24:00" is midnight at the end of that date (Claude
 * writes "yesterday at midnight" as yesterday 24:00), so it becomes 00:00 the next day: the night the client meant.
 */
export function sastInstant(date: string, time: string): string {
  if (time !== '24:00') return `${date}T${time}:00${SAST}`;
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return `${next}T00:00:00${SAST}`;
}

/** Joins a date and a time given in different messages into incidentAt. A new date alone keeps the time already on
 *  file, and the other way round ("no, it was the 2nd"). A whole incidentAt in `more` wins. */
function joinWhen(out: Facts, more: Facts): void {
  if (more.incidentAt) {
    delete out.incidentDate;
    delete out.incidentTime;
    return;
  }
  const prev = out.incidentAt ? sastParts(out.incidentAt) : undefined;
  const date = out.incidentDate ?? prev?.date;
  const time = out.incidentTime ?? prev?.time;
  if (date && DAY.test(date) && time && TIME.test(time)) {
    out.incidentAt = sastInstant(date, time);
    delete out.incidentDate;
    delete out.incidentTime;
  }
}

/**
 * TTTFG-4830 (voice notes): the client can answer by voice note as well as by typing. Said once in the walkthrough (with
 * the first "what happened" question) and once in the follow-on (with the first batch of the insurer's questions).
 */
export const VOICE_OR_TEXT = 'You can type your answers or send a voice note.';

/**
 * TTTFG-4830 (voice notes): told to Claude with a message that is the transcript of a WhatsApp voice note (the host
 * transcribes it). Speech recognition mishears letters and digits, so a registration or ID number that came out garbled
 * is left for Tina to ask again rather than read into a value; followon.ts says back what was saved.
 */
export const SPOKEN_HELP = `The client recorded this message as a voice note; <client_message> is what speech recognition made of it.
- Read it for what the client meant: it may have no punctuation, filler words ("um", "ja", "so ja"), a misheard word or
  numbers written as words.
- A client who corrects themselves while speaking ("on the Tuesday, no sorry, the Wednesday") means the last value.
- Write numbers, amounts and letters the usual way: "C A one two three four five six" is "CA 123456", "twelve thousand
  five hundred rand" is 12500, "C for Charlie" is C.
- Copy a registration, ID, policy, account or phone number exactly as the transcript has it; never add or change a
  character. When one is plainly incomplete or garbled, leave it out (null), so Tina asks for it again.
- The client may speak Afrikaans or another South African language, or mix languages. Give a text answer in English,
  with names, places and numbers as they said them.`;

/**
 * TTTFG-4830 (28 Oct 2026): told to Claude with every client message (understand.ts, reply.ts). The client may ask
 * Tina something instead of answering. Claude may explain what Tina asked, in a sentence or two; anything about cover,
 * payment, the insurer's decision or advice goes to the broker. The gate (gate.ts) checks the answer like any text.
 */
export const QUESTION_HELP = `The client may ask Tina something instead of answering: what a word means, why she needs it, where to find it,
what to do if they don't have it, or they may say they want to change something they told her. Then use kind
"question", set clientQuestion to what they asked (short, in their words), and:
- explain: Tina's answer to what the client actually asked, when it is about the claim's questions or documents (what
  a word means, why it's needed, where to find something, what to do if they don't have it): one or two short
  sentences, under 35 words, in everyday words (no dashes), as Tina ("I"). For example what a NaTIS document is and
  where to find it, that a licence number is on the front of the licence card, that a rough time is fine, or that they
  can tell her the change now. Say only what you're sure of. Tina asks her question again after it, so don't repeat it.
- forBroker: true, with explain null, when the question is about anything else: whether the claim is covered, will be
  paid or approved, amounts, the excess, the policy's terms, what the insurer will decide, or advice. Never answer
  those, and never state a fact about the client's claim or policy that isn't in this conversation.
A message that answers Tina's question is never kind "question", even if it ends with "?" or also asks something.`;

/** TTTFG-4830: Claude's answer to the client's question, when it's short enough to be one; otherwise the broker's. */
export function questionHelp(explain: unknown): string | undefined {
  const t = typeof explain === 'string' ? explain.trim() : '';
  return t && t.length <= 400 ? t : undefined;
}

/** The South African date and time of an ISO instant. */
export function sastParts(iso: string): { date: string; time: string } {
  const local = new Date(new Date(iso).getTime() + 2 * 3600_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

/**
 * Step 1: the sender's WhatsApp number against the CRM, then the client's active policies. `known`: what the client
 * already said about this incident (TTTFG-5184: the message that made Tina ask "Is this a new claim?"), so the later
 * steps don't ask it again.
 */
export function start(contact: { id: string; firstName: string } | null, policies: Policy[], known: Facts = {}): Turn {
  if (!contact) return { state: null, say: [{ kind: 'unknown-number' }], effects: [] };
  if (policies.length === 0) {
    return {
      state: null,
      say: [{ kind: 'passed-on', reason: 'no-active-policy' }],
      effects: [{ kind: 'follow-up', to: 'team', reason: 'no-active-policy' }],
    };
  }
  const first = counted({ contactId: contact.id, firstName: contact.firstName, policies, step: 'policy', facts: merge({}, known) }, ask('policy', {}));
  return { state: first.state, say: [first.say], effects: [] };
}

/** One client message. */
export function advance(state: WalkthroughState, answer: Answer): Turn {
  const askIn = (s: WalkthroughState, before: Say[] = []): Turn => {
    const c = counted(s, ask(s.step, s.facts));
    return { state: c.state, say: [...before, c.say], effects: [] };
  };
  const same = (): Turn => askIn(state);
  // TTTFG-4830: once the kind of claim is known, the on-scene checklist (once), and Tina waits for "ready" before the
  // questions about what happened. Until it's known, the claim type is asked first.
  const toReady = (s: WalkthroughState, before: Say[] = []): Turn => {
    if (!s.facts.claimType) return askIn({ ...s, step: 'claim-type' }, before);
    if (s.onSceneSent) return askIn({ ...s, step: nextFactStep(s.facts) }, before);
    return { state: { ...s, step: 'ready', onSceneSent: true }, say: [...before, { kind: 'on-scene' }], effects: [] };
  };

  // TTTFG-4830: a question about what Tina asked gets its short answer, a question only a person can answer goes to the
  // broker; then she asks again. It isn't a miss, and nothing the client told her changes.
  if (answer.kind === 'question') {
    const t = same();
    if (answer.help) return { ...t, say: [{ kind: 'help', text: answer.help }, ...t.say] };
    return { ...t, say: [{ kind: 'to-broker' }, ...t.say], effects: [{ kind: 'follow-up', to: 'broker', reason: 'client-question', question: answer.question }] };
  }

  switch (state.step) {
    case 'policy': {
      const only = state.policies.length === 1 ? state.policies[0] : undefined;
      const chosen =
        answer.kind === 'policy' ? state.policies.find((p) => p.id === answer.policyId)
        : answer.kind === 'yes' ? only
        : undefined;
      if (chosen) return toReady({ ...state, policyId: chosen.id }, [{ kind: 'safety' }]);
      if (answer.kind === 'no' && only) {
        // Not the policy on file: TTT doesn't hold it, so a person takes it from here.
        return {
          state: null,
          say: [{ kind: 'passed-on', reason: 'policy-not-on-file' }],
          effects: [{ kind: 'follow-up', to: 'team', reason: 'policy-not-on-file' }],
        };
      }
      return same();
    }

    case 'danger':
      // Asked "Is anyone hurt or in danger?" before 28 Oct 2026: whatever the answer, what to do if anyone is, then on.
      return toReady({ ...state, step: 'ready' }, [{ kind: 'safety' }]);

    case 'ready': {
      // Anything but a "not yet" moves on; what happened, when or where, if the client already said it, is kept.
      if (answer.kind === 'no') return same();
      const facts = answer.kind === 'facts' ? merge(state.facts, answer.facts, state.opening) : state.facts;
      return askIn({ ...state, facts, step: nextFactStep(facts) });
    }

    case 'claim-type':
    case 'incident':
    case 'parties': {
      if (answer.kind !== 'facts') return same();
      const facts = merge(state.facts, answer.facts, state.opening);
      if (state.step === 'claim-type' && facts.claimType) return toReady({ ...state, facts });
      return askIn({ ...state, facts, step: nextFactStep(facts) });
    }

    case 'summary': {
      if (answer.kind === 'confirm') return { state: null, say: [], effects: [{ kind: 'open-claim' }] };
      if (answer.kind === 'correct' || answer.kind === 'facts') {
        const facts = merge(state.facts, answer.facts, state.opening);
        const step = nextFactStep(facts);
        // Only a value that differs from what is on file is a correction. The model may repeat known values alongside
        // "the date is wrong" (seen 21 Oct 2026); that is not a new date, so Tina asks for it.
        const changed = !sameFacts(facts, state.facts);
        if (step !== 'summary') return askIn({ ...state, facts, step });
        if (!changed) {
          // "No, the date is wrong": ask for the right value. No claim yet.
          const fields = answer.kind === 'correct' && answer.fields?.length ? answer.fields : [];
          return { state: { ...state, facts }, say: [{ kind: 'ask', step: 'summary', missing: fields, correcting: true }], effects: [] };
        }
        return askIn({ ...state, facts, step: 'summary' });
      }
      return same();
    }
  }
}

function sameFacts(a: Facts, b: Facts): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<Fact>;
  return [...keys].every((k) => a[k] === b[k]);
}

/** The facts are complete: everything the claim row needs from the client. */
export function complete(state: WalkthroughState): state is WalkthroughState & { policyId: string } {
  return !!state.policyId && FACT_STEPS.every((s) => missingFor(s, state.facts).length === 0);
}
