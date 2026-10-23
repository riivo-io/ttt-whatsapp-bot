// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/walkthrough.ts (commit 391dac8). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5168: Tina opens a short-term insurance claim on WhatsApp (SPEC-04 "Tina's claim walkthrough", steps 1 to 6).
// The first piece of the Insurance and Advice department package (SPEC-05). It imports nothing from the email
// pipeline, so it moves into the shared agent package (TTTFG-4830) as it is.
//
// The walkthrough is a state machine in code, not prompt text (TTTFG-5247): a prompt can skip or reorder the "hurt or
// in danger" question, and the order is the point. Claude only understands each answer (the Answer type) and may
// phrase each question; the fixed messages (assist number, unknown number, acknowledgement) are code text.
//
// Steps, in the story's order: find client -> confirm policy -> hurt or in danger -> claim type -> what, when and
// where -> third parties, SAPS and injuries -> summary -> confirmed (the claim opens, status FNOL logged).
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

export type Step = 'policy' | 'danger' | 'claim-type' | 'incident' | 'parties' | 'summary';

/** Stored on the Tina conversation until the client confirms. */
export interface WalkthroughState {
  contactId: string;
  firstName: string;
  policies: Policy[];
  policyId?: string;
  step: Step;
  facts: Facts;
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
  | { kind: 'unclear' };

/** Something Tina says. 'ask' is a question Claude may phrase; the rest are fixed text. */
export type Say =
  /** `correcting`: the client said the summary is wrong; ask for the right value(s) instead of reading it again. */
  | { kind: 'ask'; step: Step; missing: Fact[]; correcting?: true }
  | { kind: 'assist'; insurer: string; number: string }
  /** The insurer has no assist number on file: the general emergency number. */
  | { kind: 'emergency' }
  | { kind: 'unknown-number' }
  /** No active policy, or not the policy on file: a person will contact the client (date from the follow-up). */
  | { kind: 'passed-on'; reason: FollowUpReason };

export type FollowUpReason = 'no-active-policy' | 'policy-not-on-file' | 'no-assist-number';

/** I/O the walkthrough asks for. claim.ts carries it out. */
export type Effect =
  /** A riivo_agentaction Follow-up. 'broker' = the chosen policy's owner, else the Insurance and Advice team. */
  | { kind: 'follow-up'; to: 'broker' | 'team'; reason: FollowUpReason }
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

function merge(f: Facts, more: Facts): Facts {
  const out: Facts = { ...f };
  for (const [k, v] of Object.entries(more) as [Fact, Facts[Fact]][]) {
    if (v === undefined || v === '') continue;
    (out as Record<Fact, unknown>)[k] = typeof v === 'string' ? v.trim() : v;
  }
  if (out.claimType && !CLAIM_TYPES.includes(out.claimType)) delete out.claimType;
  // A no clears the details that only a yes needs.
  if (out.thirdParties === false) delete out.thirdPartyDetails;
  if (out.injuries === false) delete out.injuryDetails;
  joinWhen(out, more);
  return out;
}

const SAST = '+02:00'; // South Africa has no daylight saving.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    out.incidentAt = `${date}T${time}:00${SAST}`;
    delete out.incidentDate;
    delete out.incidentTime;
  }
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
  const state: WalkthroughState = { contactId: contact.id, firstName: contact.firstName, policies, step: 'policy', facts: merge({}, known) };
  return { state, say: [ask('policy', {})], effects: [] };
}

/** One client message. */
export function advance(state: WalkthroughState, answer: Answer): Turn {
  const same = (): Turn => ({ state, say: [ask(state.step, state.facts)], effects: [] });
  const goTo = (s: WalkthroughState): Turn => ({ state: s, say: [ask(s.step, s.facts)], effects: [] });

  switch (state.step) {
    case 'policy': {
      const only = state.policies.length === 1 ? state.policies[0] : undefined;
      const chosen =
        answer.kind === 'policy' ? state.policies.find((p) => p.id === answer.policyId)
        : answer.kind === 'yes' ? only
        : undefined;
      if (chosen) return goTo({ ...state, policyId: chosen.id, step: 'danger' });
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

    case 'danger': {
      if (answer.kind !== 'yes' && answer.kind !== 'no') return same();
      const next = { ...state, step: nextFactStep(state.facts) };
      if (answer.kind === 'no') return goTo(next);
      // AC: the assist number is the first reply, on its own, before any other claim question.
      const policy = state.policies.find((p) => p.id === state.policyId)!;
      const number = policy.assistNumber?.trim();
      return number
        ? { state: next, say: [{ kind: 'assist', insurer: policy.insurer, number }, ask(next.step, next.facts)], effects: [] }
        : {
            state: next,
            say: [{ kind: 'emergency' }, ask(next.step, next.facts)],
            effects: [{ kind: 'follow-up', to: 'broker', reason: 'no-assist-number' }],
          };
    }

    case 'claim-type':
    case 'incident':
    case 'parties': {
      if (answer.kind !== 'facts') return same();
      const facts = merge(state.facts, answer.facts);
      return goTo({ ...state, facts, step: nextFactStep(facts) });
    }

    case 'summary': {
      if (answer.kind === 'confirm') return { state: null, say: [], effects: [{ kind: 'open-claim' }] };
      if (answer.kind === 'correct' || answer.kind === 'facts') {
        const facts = merge(state.facts, answer.facts);
        const step = nextFactStep(facts);
        // Only a value that differs from what is on file is a correction. The model may repeat known values alongside
        // "the date is wrong" (seen 21 Oct 2026); that is not a new date, so Tina asks for it.
        const changed = !sameFacts(facts, state.facts);
        if (step !== 'summary') return goTo({ ...state, facts, step });
        if (!changed) {
          // "No, the date is wrong": ask for the right value. No claim yet.
          const fields = answer.kind === 'correct' && answer.fields?.length ? answer.fields : [];
          return { state: { ...state, facts }, say: [{ kind: 'ask', step: 'summary', missing: fields, correcting: true }], effects: [] };
        }
        return goTo({ ...state, facts, step: 'summary' });
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
