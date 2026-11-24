// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/roadside.ts (commit 231a71e). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5299: roadside help on WhatsApp. A client whose car has broken down gets their insurer's assist number from the
// CRM straight away, at any hour, with no person involved; the broker sees in My Day that their client needed help.
//
// The rules, from the acceptance criteria and the developer's decisions at plan approval (9 Nov 2026):
// - The number only ever comes from the CRM (riivo_provider.riivo_assistnumber, read with the policy). Tina never gives
//   a number the CRM doesn't hold, and Claude writes none of these texts: they are fixed, filled with CRM data (AC 9).
// - Tina never says whether roadside help is covered: the insurer confirms what the policy includes (AC 5).
// - Motor only. Tina never tells anyone to call the police or emergency services: someone hurt gets the insurer's assist
//   number first, before any question (AC 4, without the 112 the Jira text has; the developer's decision).
// - No choice that doesn't matter. One motor policy, or several at one insurer: the number straight away. Motor policies
//   at different insurers: "Which policy is this car on?", with taps (AC 3). The CRM has no vehicle per policy, so the
//   taps are the policies. Someone hurt with several insurers gets every insurer's number at once, never a question.
// - No number on file, or no active motor policy: the number on the policy card or schedule, and an urgent Follow-up for
//   the broker (AC 6).
// - Every request writes an open Created agent action, owned by the policy's broker, for My Day (AC 7).
// - No question about whether anyone is hurt or whether it came from an accident (the developer, 18 Nov 2026). Every
//   number goes out with a button, "Complete my claim", and tapping it hands over to the claim walkthrough on the same
//   policy, which sends the form (AC 8). The host starts it (RoadsideResult.claim). Nothing opens until the client taps.
//   "ok" and "thanks" are only thanks; a message that isn't an answer is read as a new message (RoadsideResult.again).
//
// An unknown number is roadside-unknown.ts (AC 2); roadside-turn.ts is what the host calls. Every text goes through the claim gate (sendText).
// DRAFT WORDING (decision D11): the Insurance and Advice department approves it before go-live.
import { CLIENT_BROKER, DEPARTMENT, describe, ownerFor, policyTitle, sendText, shortInsurer, type ClaimPorts, type Choice, type Conversation } from './claim';
import type { RoadsideRoute } from './roadside-intent';
import { policyKind, type Facts, type Policy } from './walkthrough';

/** An insurer as riivo_provider holds it. `assistNumber`: riivo_assistnumber, absent when none is on file. */
export interface Insurer { id: string; name: string; assistNumber?: string }

export interface RoadsidePorts extends ClaimPorts {
  /** Every active riivo_provider with its assist number, for an unknown number's "which insurer?" (AC 2). Read only. */
  insurers(): Promise<Insurer[]>;
}

/** Kept by the host between messages, like the claim walkthrough. */
export interface RoadsideState {
  roadside: true;
  /** The client's words that started it, for the claim walkthrough when they say yes to a claim (AC 8). */
  opening: string;
  /** Absent for an unknown number (AC 2). */
  contactId?: string;
  firstName?: string;
  /** 'policy': asked which policy the car is on. 'insurer': asked an unknown number which insurer. 'claim-offer': the number went out with the "Complete my claim" button. */
  step: 'policy' | 'insurer' | 'claim-offer';
  /** The motor policies offered at 'policy'. */
  policies?: Policy[];
  /** An unknown number: the insurers that matched what they typed, offered as taps. */
  candidates?: Insurer[];
  /** The policy the number went out for, when it was one: the claim walkthrough starts on it. */
  policyId?: string;
  fromDamage?: true;
  someoneHurt?: true;
  /** How often the question at this step was asked again after a reply Tina couldn't read. */
  tries?: number;
  /** The host's: the riivo_request this conversation runs under, where the host keeps it with the state (the demo numbers). */
  requestId?: string;
}

export interface RoadsideResult {
  /** null: the roadside conversation has ended. */
  state: RoadsideState | null;
  lastSent?: string;
  /**
   * AC 8: the client tapped "Complete my claim". The host starts the claim walkthrough with these, on this policy when set.
   * `facts` are what roadside already knows (a car, so a motor claim): the host puts what Claude reads from `opening` over
   * them, so the tap never meets "What kind of claim is it?" and the form can follow at once.
   */
  claim?: { policyId?: string; opening: string; facts: Facts };
  /**
   * The message isn't an answer to the roadside conversation (the client moved on, or is stuck and asks again): it ends,
   * and the host reads the message as a new one, roadside check first. Nothing was sent.
   */
  again?: true;
}

/** AC 5: the line in every reply that gives a number. Cover is the insurer's to confirm, never Tina's to state. */
export const insurerConfirms = (insurer: string) => `${insurer} will confirm what your policy includes when you call.`;
/** AC 7: why the open Created row is in My Day (riivo_urgencyreason). */
export const ROADSIDE_REASON = 'The client needed roadside help';
const TOLD_BROKER = `I've let ${CLIENT_BROKER} know you needed help.`;
const BROKER_WILL_CALL = `I've asked ${CLIENT_BROKER} to contact you.`;
/** AC 6: no number on file, or no motor policy. */
export const POLICY_CARD = 'Please call the roadside or assist number on your policy card or schedule.';
export const WHICH_POLICY = 'Which policy is this car on?';
/** AC 8: the tap that completes the claim, sent with every number. WhatsApp sends its title back when it is tapped. */
export const CLAIM_BUTTON = 'Complete my claim';
export const CLAIM_BUTTONS: Choice[] = [{ title: CLAIM_BUTTON }];
export const CLAIM_PROMPT = "When you're ready, tap the button below to complete your claim.";
export const CLAIM_LATER = "No problem. If you'd like to claim later, just send me a message.";
export const THANKS_REPLY = `You're welcome. ${CLAIM_PROMPT}`;
/** What a claim started from roadside already is: a motor claim. Claude's reading of the client's words wins where it finds more. */
export const ROADSIDE_CLAIM_FACTS: Facts = { claimType: 'Motor accident' };
export const NOT_READ = "Sorry, I didn't quite get that.";
export const NO_MOTOR_TEXT = `I can't see a car policy for you on our system. ${POLICY_CARD} ${BROKER_WILL_CALL}`;

/** The client's motor policies: everything not for the home alone. "Personal" (most of TTT's) can cover a car. */
export const motorPolicies = (policies: Policy[]) => policies.filter((p) => policyKind(p) !== 'home');

/** The client's motor policies at one insurer, with that insurer's assist number. */
export interface InsurerGroup { providerId: string; insurer: string; assistNumber?: string; policies: Policy[] }

export function byInsurer(policies: Policy[]): InsurerGroup[] {
  const out: InsurerGroup[] = [];
  for (const p of policies) {
    const g = out.find((x) => x.providerId === p.providerId);
    if (g) g.policies.push(p);
    else out.push({ providerId: p.providerId, insurer: shortInsurer(p.insurer), ...(p.assistNumber?.trim() ? { assistNumber: p.assistNumber.trim() } : {}), policies: [p] });
  }
  return out;
}

/** AC 1, 4, 5, 6 and 9: the reply for one insurer. Fixed text; the number is the CRM's or there is none. */
export function numberText(g: Pick<InsurerGroup, 'insurer' | 'assistNumber'>, hurt: boolean): string {
  if (!g.assistNumber) return `I don't have a roadside number for ${g.insurer} on our system. ${POLICY_CARD}`;
  const call = hurt
    ? `Call ${g.insurer}'s assist line now on *${g.assistNumber}* and tell them someone is hurt.`
    : `Call ${g.insurer}'s roadside assistance line on *${g.assistNumber}*.`;
  return `${call}\n\n${insurerConfirms(g.insurer)}`;
}

/** Every insurer at once: someone hurt with motor policies at several insurers, or a policy question asked twice. */
export function numbersText(groups: InsurerGroup[], hurt: boolean): string {
  const lines = groups.map((g) => `• ${g.insurer}: ${g.assistNumber ? `*${g.assistNumber}*` : "the number on your policy card or schedule (I don't have it on our system)"}`);
  const lead = hurt ? "Call your insurer's assist line now and tell them someone is hurt:" : "Here are your insurers' roadside assist numbers:";
  return `${lead}\n${lines.join('\n')}\n\nYour insurer will confirm what your policy includes when you call.`;
}

/** AC 3: one tap per motor policy. Two at one insurer would read the same, so their numbers tell them apart. */
export function policyChoices(policies: Policy[]): Choice[] {
  const twice = (p: Policy) => policies.filter((x) => x.providerId === p.providerId).length > 1;
  // 16 Nov 2026: a name too long for a list row ("Momentum Short Term Insurance (MO-1)") is the insurer's main name, which is not cut (policyTitle).
  return policies.map((p, i) => ({
    title: policyTitle('', p.insurer, twice(p) ? p.policyNumber : undefined),
    description: `${p.product} policy (${p.policyNumber})`,
    reply: `${i + 1}. ${describe(p)}`,
  }));
}

const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Words that never tell one insurer from another. */
const GENERIC = new Set([
  'insurance', 'insure', 'insurer', 'insurers', 'insured', 'company', 'limited', 'ltd', 'pty', 'short', 'term', 'shortterm', 'group', 'the',
  'of', 'and', 'sa', 'south', 'africa', 'african', 'co', 'general', 'holdings', 'direct', 'my', 'with', 'is', 'im', 'i', 'am', 'its', 'it', 'car',
]);
/**
 * Insurer names that are everyday words ("One", "First For Women", "Auto & General", "Budget", "Compass"): never read
 * from words the client wrote about something else, only from an answer to "which insurer?" (code review, 9 Nov 2026).
 */
export const COMMON_NAMES = new Set(['one', 'first', 'auto', 'budget', 'compass', 'cia', 'senate', 'zone']);
/** The words of a name or a message that can tell insurers apart: lower case, no punctuation, no generic words. */
export const nameWords = (t: string) => t.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !GENERIC.has(w));

/**
 * The policy the client tapped or named: its number in the list ("2", "2. Santam ..."), its policy number, or its
 * insurer's name as a whole phrase ("Old Mutual") or a first word of four letters or more that isn't an everyday word.
 */
export function pickPolicy(policies: Policy[], text: string): Policy | undefined {
  const n = /^\s*(\d{1,2})\s*(?:[.)]|$)/.exec(text);
  if (n) return policies[Number(n[1]) - 1];
  const said = squash(text);
  const byNumber = policies.filter((p) => p.policyNumber && squash(p.policyNumber).length >= 3 && said.includes(squash(p.policyNumber)));
  if (byNumber.length === 1) return byNumber[0];
  const words = ` ${nameWords(text).join(' ')} `;
  const insurers = new Set<string>();
  const named = policies.filter((p) => {
    const name = nameWords(shortInsurer(p.insurer));
    const first = name[0] ?? '';
    const hit = (name.length > 0 && words.includes(` ${name.join(' ')} `)) || (first.length >= 4 && !COMMON_NAMES.has(first) && words.includes(` ${first} `));
    if (hit) insurers.add(p.providerId);
    return hit;
  });
  // One insurer named: its number is the same for each of its policies, so the first will do.
  return insurers.size === 1 ? named[0] : undefined;
}

/**
 * The tap on "Complete my claim", or a clear yes typed instead: it starts with yes (or yeah, yep, ja, yebo, sure), or it is
 * only "go ahead", "claim", or "start / complete / finish / open a claim". "please hurry, the tow truck isn't here" is not
 * one (code review, 9 Nov 2026), and "ok" is only thanks now that the message asks for a tap, not a yes (18 Nov 2026).
 */
export const YES_WORDS = /^\W*(?:(?:yes|yeah|yep|ja|yebo|sure)\b|(?:go ahead|claim|(?:complete|finish|start|open|make|do)(?: my| the| a| it| one)?(?: claim)?)\W*$)/i;
export const NO_WORDS = /^\W*(?:no|nope|nah|nee|not now|not yet|later|don'?t)\b/i;
/** Thanks for the number: it keeps the button on offer and starts nothing. */
export const THANKS_WORDS = /^\W*(?:(?:ok(?:ay)?|k|thanks?|thank you|cheers|great|perfect|got it|noted|will do|lekker|dankie|siyabonga|so much|very much|a lot|cool|awesome|brilliant|appreciate(?:d)?|ta)\b\W*)+$/i;
const EMOJI_ONLY = /^[\s\p{Extended_Pictographic}️‍]+$/u;

/** Tuesday 10 November 2026, 21:40, South African time: for the broker's row. */
export const sastWhen = (at: string) =>
  new Date(at).toLocaleString('en-GB', { timeZone: 'Africa/Johannesburg', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function situation(s: RoadsideState): string {
  return [s.someoneHurt ? ' and someone is hurt' : '', s.fromDamage ? ' after an accident or damage' : ''].join('');
}

/**
 * AC 6 and 7: the broker's rows for one insurer. An open Created row with the client, policy, insurer, number and time;
 * with no number on file, an urgent Follow-up too.
 */
async function brokerRows(ports: ClaimPorts, conv: Conversation, s: RoadsideState, g: InsurerGroup, at: string): Promise<void> {
  const owner = await ownerFor(ports, g.policies[0].id);
  const policies = g.policies.map((p) => `${p.product} ${p.policyNumber}`).join(', ');
  const who = s.firstName ?? 'The client';
  const sent = g.assistNumber
    ? `Tina sent ${g.insurer}'s assist number ${g.assistNumber}`
    : `${g.insurer} has no assist number on file, so Tina asked them to use the number on their policy card`;
  await ports.createAgentAction({
    kind: 'Created', open: true, urgencyReason: ROADSIDE_REASON, department: DEPARTMENT, owner, regarding: { table: 'riivo_request', id: conv.requestId }, contactId: s.contactId, at,
    detail: `Roadside help on WhatsApp, ${sastWhen(at)}: ${who}'s car broke down${situation(s)}. ${sent} (policy ${policies}).`,
  });
  if (!g.assistNumber) {
    await ports.createAgentAction({
      kind: 'Follow-up', urgent: true, department: DEPARTMENT, owner, regarding: { table: 'riivo_request', id: conv.requestId }, contactId: s.contactId, at,
      urgencyReason: 'The client broke down and the insurer has no assist number on file',
      detail: `Roadside: ${who}'s car broke down${situation(s)} and ${g.insurer} has no assist number on file (policy ${policies}). Tina asked them to use the number on their policy card. Please contact them now.`,
    });
  }
}

/**
 * The number (or numbers) go out in one message with the "Complete my claim" button, and the broker's rows are written.
 * The conversation stays open for the tap (AC 8): the claim walkthrough starts on this policy when the number went out for
 * one; else it asks which, as it does.
 */
async function sendNumbers(ports: ClaimPorts, conv: Conversation, s: RoadsideState, groups: InsurerGroup[], at: string): Promise<RoadsideResult> {
  const hurt = !!s.someoneHurt;
  const body = groups.length === 1 ? numberText(groups[0], hurt) : numbersText(groups, hurt);
  const tail = groups.some((g) => !g.assistNumber) ? BROKER_WILL_CALL : TOLD_BROKER;
  const lastSent = await sendText(ports, conv, `${body} ${tail}\n\n${CLAIM_PROMPT}`, null, at, s.contactId, CLAIM_BUTTONS);
  for (const g of groups) await brokerRows(ports, conv, s, g, at);
  const only = groups.length === 1 && groups[0].policies.length === 1 ? groups[0].policies[0].id : s.policyId;
  const { tries: _t, policies: _p, ...rest } = s;
  return { state: { ...rest, step: 'claim-offer', ...(only ? { policyId: only } : {}) }, lastSent };
}

/** AC 6 and 7: no active motor policy. The policy card, an open Created row and an urgent Follow-up for the broker. */
async function noMotorPolicy(ports: ClaimPorts, conv: Conversation, s: RoadsideState, all: Policy[], at: string): Promise<RoadsideResult> {
  const lastSent = await sendText(ports, conv, NO_MOTOR_TEXT, null, at, s.contactId);
  const owner = await ownerFor(ports, all[0]?.id);
  const who = s.firstName ?? 'The client';
  await ports.createAgentAction({
    kind: 'Created', open: true, urgencyReason: ROADSIDE_REASON, department: DEPARTMENT, owner, regarding: { table: 'riivo_request', id: conv.requestId }, contactId: s.contactId, at,
    detail: `Roadside help on WhatsApp, ${sastWhen(at)}: ${who}'s car broke down${situation(s)}. There is no active motor policy on file, so Tina sent no number and asked them to use the number on their policy card.`,
  });
  await ports.createAgentAction({
    kind: 'Follow-up', urgent: true, department: DEPARTMENT, owner, regarding: { table: 'riivo_request', id: conv.requestId }, contactId: s.contactId, at,
    urgencyReason: 'The client broke down and has no active motor policy on file',
    detail: `Roadside: ${who}'s car broke down${situation(s)} and there is no active motor policy on file. Tina asked them to use the number on their policy card. Please contact them now.`,
  });
  return { state: null, lastSent };
}

/** AC 1, 3, 4, 6, 7: a known client's first roadside message. */
export async function roadsideForClient(
  ports: RoadsidePorts, conv: Conversation, contact: { id: string; firstName: string }, route: RoadsideRoute, text: string, now: Date,
): Promise<RoadsideResult> {
  const at = now.toISOString();
  const s: RoadsideState = {
    roadside: true, opening: text, contactId: contact.id, firstName: contact.firstName, step: 'policy',
    ...(route.fromDamage ? { fromDamage: true as const } : {}), ...(route.someoneHurt ? { someoneHurt: true as const } : {}),
  };
  const all = await ports.activePolicies(contact.id);
  const motor = motorPolicies(all);
  if (!motor.length) return noMotorPolicy(ports, conv, s, all, at);
  const groups = byInsurer(motor);
  // One insurer: one number, no question. Someone hurt: every number now, no question before it (AC 4).
  if (groups.length === 1 || route.someoneHurt) return sendNumbers(ports, conv, s, groups, at);
  const lastSent = await sendText(ports, conv, WHICH_POLICY, null, at, contact.id, policyChoices(motor));
  return { state: { ...s, policies: motor }, lastSent };
}

/** A known client's next message in a roadside conversation (roadside-turn.ts dispatches). */
export async function roadsideClientReply(ports: RoadsidePorts, conv: Conversation, state: RoadsideState, text: string, now: Date): Promise<RoadsideResult> {
  const at = now.toISOString();
  const tries = state.tries ?? 0;

  if (state.step === 'policy') {
    const policies = state.policies ?? [];
    const chosen = pickPolicy(policies, text);
    if (chosen) {
      return sendNumbers(ports, conv, { ...state, policyId: chosen.id }, byInsurer(policies.filter((p) => p.providerId === chosen.providerId)).map((g) => ({ ...g, policies: [chosen] })), at);
    }
    if (tries < 1) {
      const lastSent = await sendText(ports, conv, `${NOT_READ} ${WHICH_POLICY}`, null, at, state.contactId, policyChoices(policies));
      return { state: { ...state, tries: tries + 1 }, lastSent };
    }
    // Asked twice: every insurer's number, so nobody is left on the road without one.
    return sendNumbers(ports, conv, state, byInsurer(policies), at);
  }

  if (state.step === 'claim-offer') {
    // AC 8: the tap (or a clear yes) completes the claim, on the policy the number went out for.
    if (YES_WORDS.test(text)) return { state: null, claim: { ...(state.policyId ? { policyId: state.policyId } : {}), opening: state.opening, facts: ROADSIDE_CLAIM_FACTS } };
    if (NO_WORDS.test(text)) {
      const lastSent = await sendText(ports, conv, CLAIM_LATER, null, at, state.contactId);
      return { state: null, lastSent };
    }
    // Thanks for the number: the button stays on offer, once more, and nothing starts.
    if (THANKS_WORDS.test(text) || EMOJI_ONLY.test(text)) {
      const lastSent = await sendText(ports, conv, THANKS_REPLY, null, at, state.contactId, CLAIM_BUTTONS);
      return { state, lastSent };
    }
    // Anything else isn't an answer ("I'm still waiting, send the number again", a tax question): read it as a new message.
    return { state: null, again: true };
  }

  return { state: null };
}
