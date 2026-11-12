// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/roadside-unknown.ts (commit 62f588b). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5299 AC 2: roadside help for a number that matches no client. The one thing Tina gives an unknown number
// (decided 9 October 2026), because an insurer's assist line is not client data.
//
// - No ID number is asked for, no client record is read and no client data is shown: Tina asks which insurer they're
//   with, and matches the answer against the insurers in the CRM (riivo_provider) only.
// - The number is that insurer's riivo_assistnumber; with none on file, the number on their policy card (AC 2, 9).
// - Never a claim: Tina says that to claim they email TTT from the address on file.
// - The request writes an open Created agent action owned by the Insurance and Advice team, with the WhatsApp number,
//   the insurer named, the number sent and the time, so the team sees it in My Day.
// Motor only and no emergency numbers, as for a client (roadside.ts).
import { DEPARTMENT, sendText, shortInsurer, type Choice, type Conversation } from './claim';
import {
  COMMON_NAMES, nameWords, NOT_READ, numberText, POLICY_CARD, ROADSIDE_REASON, sastWhen,
  type Insurer, type RoadsidePorts, type RoadsideResult, type RoadsideState,
} from './roadside';
import type { RoadsideRoute } from './roadside-intent';

export const INSURER_QUESTION = 'I can give you your insurer\'s roadside assist number. Which insurer is your car insured with? For example Santam or Hollard.';
export const WHICH_OF_THESE = 'Which of these is your car insured with?';
export const INSURER_AGAIN = "Sorry, I couldn't find that insurer. Please send me just its name, for example Santam.";
export const INSURER_NOT_FOUND = `I couldn't find that insurer on our system. ${POLICY_CARD}`;
/** AC 2: no claim for an unknown number, and how to claim instead. */
export const UNKNOWN_CLAIM_LINE = "I can't open a claim from this number. If you'd like to claim, please email TTT from the email address we have on file for you.";

const keyOf = (i: Insurer) => nameWords(i.name).join(' ');

/** One insurer per name: two rows with the same name read the same, so the one with a number stands for both. */
function distinct(list: Insurer[]): Insurer[] {
  const out = new Map<string, Insurer>();
  for (const i of list) {
    const k = keyOf(i);
    const had = out.get(k);
    if (!had || (!had.assistNumber?.trim() && i.assistNumber?.trim())) out.set(k, i);
  }
  return [...out.values()];
}

/**
 * The insurers the client's words name: the whole name ("old mutual" is Old Mutual Insure, not Old Mutual Life as well).
 * `answer`: the client is answering "which insurer?", so the reply may be the start of a name ("King" for King Price),
 * and an insurer whose name is an everyday word ("One", "First For Women", "Auto & General") counts. In any other
 * message such a name is never read as an insurer: "one of my tyres burst" names no insurer (code review, 9 Nov 2026).
 */
export function matchInsurers(insurers: Insurer[], text: string, o: { answer?: boolean } = {}): Insurer[] {
  const said = nameWords(text).join(' ');
  const everyday = (i: Insurer) => keyOf(i).split(' ').every((w) => COMMON_NAMES.has(w)) || COMMON_NAMES.has(keyOf(i).split(' ')[0]);
  const named = insurers.filter((i) => keyOf(i) && ` ${said} `.includes(` ${keyOf(i)} `) && (o.answer || !everyday(i)));
  if (named.length || !o.answer) return distinct(named);
  return said.length >= 4 ? distinct(insurers.filter((i) => keyOf(i).startsWith(`${said} `))) : [];
}

const choices = (list: Insurer[]): Choice[] => list.map((i, n) => ({ title: shortInsurer(i.name), reply: `${n + 1}. ${i.name}` }));

/** The number for the insurer named (or the policy card), the line about claims, and the team's row. */
async function sendFor(ports: RoadsidePorts, conv: Conversation, s: RoadsideState, insurer: Insurer | null, named: string, at: string): Promise<RoadsideResult> {
  const number = insurer?.assistNumber?.trim() || undefined;
  const body = insurer ? numberText({ insurer: shortInsurer(insurer.name), assistNumber: number }, !!s.someoneHurt) : INSURER_NOT_FOUND;
  const lastSent = await sendText(ports, conv, `${body}\n\n${UNKNOWN_CLAIM_LINE}`, null, at);
  const team = await ports.insuranceTeam();
  const situation = [s.someoneHurt ? ' and someone is hurt' : '', s.fromDamage ? ' after an accident or damage' : ''].join('');
  const sent = number ? `Tina sent ${shortInsurer(insurer!.name)}'s assist number ${number}`
    : insurer ? `${shortInsurer(insurer.name)} has no assist number on file, so Tina asked them to use the number on their policy card`
    : 'Tina found no such insurer on file and asked them to use the number on their policy card';
  await ports.createAgentAction({
    kind: 'Created', open: true, urgencyReason: ROADSIDE_REASON, department: DEPARTMENT, owner: { kind: 'team', id: team.id, name: team.name },
    regarding: { table: 'riivo_request', id: conv.requestId }, at,
    detail: `Roadside help for an unknown WhatsApp number ${conv.phone}, ${sastWhen(at)}: their car broke down${situation}. They named the insurer "${named.slice(0, 80)}". ${sent}. No client record was read and no claim was opened.`,
  });
  return { state: null, lastSent };
}

/** AC 2: an unknown number's first roadside message. When it already names one insurer, the number goes now. */
export async function roadsideFromUnknown(ports: RoadsidePorts, conv: Conversation, route: RoadsideRoute, text: string, now: Date): Promise<RoadsideResult> {
  const at = now.toISOString();
  const s: RoadsideState = {
    roadside: true, opening: text, step: 'insurer',
    ...(route.fromDamage ? { fromDamage: true as const } : {}), ...(route.someoneHurt ? { someoneHurt: true as const } : {}),
  };
  const found = matchInsurers(await ports.insurers(), text);
  if (found.length === 1) return sendFor(ports, conv, s, found[0], found[0].name, at);
  if (found.length > 1 && found.length <= 10) {
    const lastSent = await sendText(ports, conv, WHICH_OF_THESE, null, at, undefined, choices(found));
    return { state: { ...s, candidates: found }, lastSent };
  }
  const lastSent = await sendText(ports, conv, INSURER_QUESTION, null, at);
  return { state: s, lastSent };
}

/** AC 2: the unknown number's answer to "which insurer?". */
export async function roadsideFromUnknownReply(ports: RoadsidePorts, conv: Conversation, state: RoadsideState, text: string, now: Date): Promise<RoadsideResult> {
  const at = now.toISOString();
  const tries = state.tries ?? 0;
  const tap = /^\s*(\d{1,2})\s*(?:[.)]|$)/.exec(text);
  const tapped = tap && state.candidates ? state.candidates[Number(tap[1]) - 1] : undefined;
  if (tapped) return sendFor(ports, conv, state, tapped, tapped.name, at);

  const inList = state.candidates ? matchInsurers(state.candidates, text, { answer: true }) : [];
  const found = inList.length ? inList : matchInsurers(await ports.insurers(), text, { answer: true });
  if (found.length === 1) return sendFor(ports, conv, state, found[0], found[0].name, at);
  if (found.length > 1 && found.length <= 10) {
    const lastSent = await sendText(ports, conv, WHICH_OF_THESE, null, at, undefined, choices(found));
    return { state: { ...state, candidates: found }, lastSent };
  }
  if (tries < 1) {
    const lastSent = await sendText(ports, conv, state.candidates ? `${NOT_READ} ${WHICH_OF_THESE}` : INSURER_AGAIN, null, at, undefined, state.candidates ? choices(state.candidates) : undefined);
    return { state: { ...state, tries: tries + 1 }, lastSent };
  }
  // Asked twice: the policy card, so they still know where to find a number. Never a number the CRM doesn't hold.
  return sendFor(ports, conv, state, null, text.trim(), at);
}
