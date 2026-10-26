// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/claim.ts (commit ec01101). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5168: one claim turn on WhatsApp. Runs the walkthrough (walkthrough.ts), then carries out what it asks:
// reads the client and their policies, opens the riivo_claim, sets its owner, sends the acknowledgement template and
// writes the agent actions. Every outbound text goes through the claim-outcome gate (gate.ts).
//
// Seam for tests: ClaimPorts. Dataverse, WhatsApp and the clock are faked there. The real adapters come with
// TTTFG-4885 (riivo_claim, riivo_provider.riivo_assistnumber) and the SPEC-05 story that loads department packages
// into Tina (epic TTTFG-4830).
import { claimGate } from './gate';
import {
  advance, askedKey, complete, isTheft, sastParts, start, VOICE_OR_TEXT,
  type Answer, type ClaimType, type Effect, type Fact, type Facts, type FollowUpReason, type Policy, type Say, type Step, type WalkthroughState,
} from './walkthrough';

export const DEPARTMENT = 'Insurance and Advice';

/** The riivo_policy owner as Dataverse has it. */
export type PolicyOwner = { kind: 'user'; id: string; firstName: string; enabled: boolean } | { kind: 'team'; id: string; name: string };

/** Who owns the claim and its follow-ups. `name` is what the client reads: a first name or the team name. */
export interface Owner { kind: 'user' | 'team'; id: string; name: string }

/** TTTFG-5168 step 10: the policy's broker. A team, a disabled user or no owner gives the Insurance and Advice team. */
export function claimOwner(policyOwner: PolicyOwner | null, team: { id: string; name: string }): Owner {
  if (policyOwner?.kind === 'user' && policyOwner.enabled) return { kind: 'user', id: policyOwner.id, name: policyOwner.firstName };
  return { kind: 'team', id: team.id, name: team.name };
}

/** The riivo_claim row (TTTFG-4885). Dataverse sets the claim reference (riivo_name, CLM-{SEQNUM:6}). */
export interface ClaimRow {
  contactId: string;
  policyId: string;
  providerId: string;
  claimType: ClaimType;
  reportedOn: string;
  incidentAt: string;
  place: string;
  description: string;
  thirdParties: boolean;
  thirdPartyDetails?: string;
  saps: boolean;
  injuries: boolean;
  injuryDetails?: string;
  channel: 'WhatsApp';
  status: 'FNOL logged';
  lastClientMessageOn: string;
  owner: Owner;
}

/** A riivo_agentaction row: the audit trail (SPEC-04 "AI governance") and the follow-ups (SPEC-05 "Follow-ups"). */
export interface AgentActionRow {
  kind: 'Created' | 'Follow-up';
  department: typeof DEPARTMENT;
  owner: Owner;
  regarding: { table: 'riivo_claim' | 'riivo_request'; id: string };
  /** The client (riivo_agentaction.riivo_client), so the row shows on the client's record and in My Day. */
  contactId?: string;
  detail: string;
  /** A Follow-up a person must act on now (someone hurt, no assist number): Urgent, due within 2 working hours. */
  urgent?: true;
  at: string;
  /** For a template send: which template and which version went out, and the text exactly as sent. */
  template?: { name: string; version: string; text?: string };
}

export type Outbound =
  | { kind: 'text'; text: string }
  /**
   * `params` (TTTFG-5212): the template's variables, in order, when it has to go out as an approved WhatsApp template
   * (outside the 24-hour window, the morning reminder). Without them the client is inside the window: send `text`.
   */
  | { kind: 'template'; name: string; version: string; text: string; params?: string[] };

export interface ClaimPorts {
  /** The contact whose WhatsApp number this is, or null. Never an ID-number lookup. */
  contactByWhatsApp(phone: string): Promise<{ id: string; firstName: string } | null>;
  /** The contact's riivo_policy rows with an active status, with the provider name and riivo_assistnumber. Read only. */
  activePolicies(contactId: string): Promise<Policy[]>;
  policyOwner(policyId: string): Promise<PolicyOwner | null>;
  /** The Insurance and Advice fallback team. */
  insuranceTeam(): Promise<{ id: string; name: string }>;
  /** Creates the riivo_claim and reads it back for its reference. */
  createClaim(row: ClaimRow): Promise<{ id: string; reference: string }>;
  /** Writes a riivo_agentaction. A Follow-up comes back with its due date (the next working day). */
  createAgentAction(row: AgentActionRow): Promise<{ id: string; dueOn?: string }>;
  send(to: string, message: Outbound): Promise<void>;
}

export interface Conversation {
  /** The sender's WhatsApp number. */
  phone: string;
  /** The Tina request (riivo_request) this conversation belongs to. */
  requestId: string;
  /** The Insurance and Advice online sign-up link, for the unknown-number reply. */
  signUpLink: string;
}

/**
 * TTTFG-5168 AC 8: the acknowledgement. Fixed text filled with CRM data; Claude writes none of it, because the AI
 * disclosure is a POPIA and TCF requirement and a generated acknowledgement drops or rewords it on some runs.
 * DRAFT WORDING: riivo drafts it, the Insurance and Advice department approves it (decision D11, 12 October 2026), and
 * the approved text replaces this one with a new version before go-live.
 */
export const FNOL_TEMPLATE = {
  name: 'Claim - FNOL logged',
  version: 'draft-1',
  approved: false,
  render: (v: { firstName: string; reference: string; ownerName: string }) =>
    `Hi ${v.firstName}, we've logged your claim. Your claim reference is ${v.reference}.\n\n` +
    `I'll now ask a few more questions the insurer needs, and ${v.ownerName} will check your claim.\n\n` +
    'TTT uses AI-assisted tools to help handle claims. A person at TTT makes every decision about your claim.',
} as const;

/** SPEC-05 "Unknown numbers": the one reply an unknown number gets. */
export const unknownNumberText = (signUpLink: string) =>
  "I can't find this number on our system. If you're already a TTT client, please email us from the address we have on file. " +
  `If you're new, you can sign up here: ${signUpLink}`;

const FACT_QUESTIONS: Record<Fact, string> = {
  claimType: 'What kind of claim is it? For example a car accident, a stolen car, a hijacking, a windscreen, damage or loss at home, or a lost or stolen item you carry with you.',
  description: 'Please tell me in your own words what happened.',
  incidentAt: 'On what date and at roughly what time did it happen?',
  incidentDate: 'On what date did it happen?',
  incidentTime: 'At roughly what time did it happen?',
  place: 'Where did it happen?',
  thirdParties: 'Was anyone else involved?',
  thirdPartyDetails: 'Please send me their details, for example their name and phone number.',
  saps: 'Were the police (SAPS) involved?',
  injuries: 'Was anyone injured?',
  injuryDetails: 'I am sorry to hear that. Who was hurt, and what happened to them?',
};

/** TTTFG-4830: the kinds of claim Tina words her questions for. */
export type ClaimKind = 'motor' | 'windscreen' | 'motor-theft' | 'hijacking' | 'home' | 'home-theft' | 'lost-item' | 'stolen-item' | 'other';

export function claimKind(f: Facts, opening?: string): ClaimKind {
  switch (f.claimType) {
    case 'Motor accident': return 'motor';
    case 'Windscreen': return 'windscreen';
    case 'Motor theft': return 'motor-theft';
    case 'Hijacking': return 'hijacking';
    case 'Property loss or damage': return isTheft(f, opening) ? 'home-theft' : 'home';
    case 'Portable possessions': return isTheft(f, opening) ? 'stolen-item' : 'lost-item';
    default: return isTheft(f, opening) ? 'home-theft' : 'other';
  }
}

const THEFT_DETAILS = 'What do you know about who did it? For example a name, what they looked like, or anyone who saw it. Say "nothing" if you don\'t know.';
const REPORTED = 'Have you reported it to the police (SAPS)?';
const WHEN_THEFT = 'On what date and at roughly what time did it happen? If you only noticed later, when did you notice?';

/**
 * TTTFG-4830: each question in words that fit the claim. "For example another driver" after a break-in, or "where did
 * it happen" for a burst geyser, reads as if Tina wasn't listening. Anything not listed uses FACT_QUESTIONS.
 */
const BY_KIND: Record<ClaimKind, Partial<Record<Fact, string>>> = {
  motor: {
    description: 'Please tell me in your own words what happened, for example how the cars hit each other.',
    place: 'Where did it happen? For example the street and suburb, or the road and the nearest exit.',
    thirdParties: 'Was anyone else involved, for example another driver?',
    thirdPartyDetails: 'Please send me their details, for example their name, phone number and vehicle registration.',
  },
  windscreen: {
    description: 'What happened to the glass? For example a stone hit the windscreen on the highway.',
    place: 'Where did it happen? For example the road you were on.',
    thirdParties: 'Was another vehicle involved, for example a truck that threw up a stone?',
    thirdPartyDetails: 'Do you have any of their details, for example the vehicle registration or the company name?',
  },
  'motor-theft': {
    description: 'Please tell me in your own words what happened, for example where the car was parked and when you noticed it was gone.',
    incidentAt: WHEN_THEFT,
    place: 'Where was the car when it was taken?',
    thirdPartyDetails: THEFT_DETAILS,
    saps: REPORTED,
  },
  hijacking: {
    description: "I'm sorry this happened to you. Please tell me in your own words what happened.",
    place: 'Where were you when it happened?',
    thirdPartyDetails: 'What do you know about the people who did it? For example how many there were, what they looked like, or their vehicle. Say "nothing" if you don\'t know.',
    saps: REPORTED,
    injuries: 'Was anyone hurt?',
  },
  home: {
    description: 'Please tell me in your own words what happened and what was damaged.',
    place: 'What is the address of the property?',
    thirdParties: 'Was anyone else involved, or did someone else cause it? For example a contractor or a neighbour.',
  },
  'home-theft': {
    description: 'Please tell me in your own words what happened: how they got in and what was taken.',
    incidentAt: WHEN_THEFT,
    place: 'What is the address of the property?',
    thirdPartyDetails: THEFT_DETAILS,
    saps: REPORTED,
  },
  'lost-item': {
    description: 'Please tell me in your own words what happened and what was lost.',
    incidentAt: 'On what date and at roughly what time did you last have it?',
    place: 'Where were you when you lost it?',
    saps: 'Have you reported the loss to the police (SAPS)?',
  },
  'stolen-item': {
    description: 'Please tell me in your own words what happened and what was taken.',
    incidentAt: WHEN_THEFT,
    place: 'Where were you when it was taken?',
    thirdPartyDetails: THEFT_DETAILS,
    saps: REPORTED,
  },
  other: {},
};

/**
 * TTTFG-4830: what to gather while the client is still at the scene, by kind of claim, sent once right after "is anyone
 * hurt or in danger" (walkthrough.ts onScene), so they have it all before the questions start. `when` opens the
 * message ("If you're still on the scene"); `towLine`: a car that may need a tow, so the insurer's assist line is
 * given for it (when it's on file).
 * DRAFT WORDING (decision D11): the Insurance and Advice department approves it before go-live.
 */
export const ON_SCENE: Record<ClaimKind, { when: string; lead: string; items: string[]; towLine?: true }> = {
  motor: {
    when: "If you're still on the scene", lead: 'make sure to grab the following where applicable:', towLine: true,
    items: [
      "The other car's registration number (number plate)",
      "The other driver's name and phone number, and a photo of their driver's licence",
      'Photos of both cars and the damage, and of the scene (the road, and any signs or robots)',
      "The other driver's insurer, if they know it",
      'The names and phone numbers of anyone who saw it',
      "If the police come: the officer's name and the accident report (AR) number",
    ],
  },
  windscreen: {
    when: "If you're still on the scene", lead: 'make sure to grab the following where applicable:',
    items: [
      'Photos of the damaged glass, close up and from further away',
      'If a truck or another vehicle threw something up: its registration number, or the company name on it',
      'Where it happened: the road, and the nearest exit or landmark',
    ],
  },
  'motor-theft': {
    when: "While it's fresh", lead: 'these help the most where applicable:',
    items: [
      'Call your tracking company right away, if the car has one',
      'Report it to the police (SAPS) and get the case number',
      'Photos of where the car was parked, and of any broken glass',
      "Ask security at the building or centre for the CCTV footage, and note the guard's name",
      'Your parking ticket, if you have one',
      'The names and phone numbers of anyone who saw anything',
    ],
  },
  hijacking: {
    when: "Once you're safe", lead: 'these help the most where applicable:',
    items: [
      'Report it to the police (SAPS) on 10111 and get the case number',
      'Call your tracking company right away, if the car has one',
      'Write down what you remember about them and their vehicle: how many there were, what they looked like, and the make, colour and registration',
      'Which way they went',
      'The names and phone numbers of anyone who saw it',
    ],
  },
  home: {
    when: "If you're at the property now", lead: 'make sure to do the following where applicable:',
    items: [
      "Stop more damage if it's safe to, for example turn off the water at the mains or switch off the geyser",
      'Take photos of the damage before you clean up or fix anything',
      'Keep the damaged items: the assessor may want to see them',
      'The name and number of the plumber, electrician or contractor, and their report or quote',
    ],
  },
  'home-theft': {
    when: "If you're at the property now", lead: 'these help the most where applicable:',
    items: [
      "Don't touch or clean up anything until the police have been",
      'Report it to the police (SAPS) and get the case number',
      'Photos of how they got in (a broken window, door or lock) and of the rooms',
      "A list of what's missing",
      'Your alarm or armed response company\'s report, and any CCTV footage',
      'The names and phone numbers of neighbours or anyone who saw anything',
    ],
  },
  'lost-item': {
    when: "While it's fresh", lead: 'these help the most where applicable:',
    items: [
      "Ask where you lost it (lost and found, security or the venue), and note the name of the person you spoke to",
      "For a phone: ask your network to block the SIM, and note the phone's IMEI number (it's on the box)",
      'Report the loss to the police (SAPS) and get the reference number',
      "Proof that it's yours: the receipt, the box, or a photo of you with it",
    ],
  },
  'stolen-item': {
    when: "If you're still where it happened", lead: 'these help the most where applicable:',
    items: [
      'Report it to the police (SAPS) and get the case number',
      "Ask security at the shop or centre for the CCTV footage, and note the guard's name",
      "For a phone: ask your network to block the SIM and blacklist the phone (they'll need its IMEI number, it's on the box)",
      'The names and phone numbers of anyone who saw it',
    ],
  },
  other: {
    when: "If you're still on the scene", lead: 'make sure to grab the following where applicable:',
    items: [
      'Photos of the damage and of where it happened',
      'The names and phone numbers of anyone involved or who saw it',
      'Keep anything damaged: the assessor may want to see it',
    ],
  },
};
export const ON_SCENE_PHOTOS = 'You can send me photos here at any time.';

/**
 * TTTFG-4830: the on-scene checklist for this claim. `safeFirst`: someone is hurt or in danger, so it starts "Once
 * everyone is safe". A car that may need a tow gets the insurer's assist line for it, when it's on file.
 */
export function onSceneText(state: WalkthroughState, safeFirst = false): string {
  const c = ON_SCENE[claimKind(state.facts, state.opening)];
  const when = !safeFirst ? c.when : /^(Once|While)\b/.test(c.when) ? 'Once everyone is safe' : `Once everyone is safe, ${lowerFirst(c.when)}`;
  const policy = state.policies.find((p) => p.id === state.policyId);
  const number = policy?.assistNumber?.trim();
  const tow = c.towLine && number
    ? `If the car needs a tow, call ${policy!.insurer} on ${number}, and don't let a tow truck you didn't call take it.`
    : undefined;
  return [`${when}, ${c.lead}`, ...c.items.map((item, i) => `${i + 1}. ${item}`), ...(tow ? [tow] : []), ON_SCENE_PHOTOS].join('\n');
}

const EXAMPLE_TIME = 'Your best estimate is fine, for example "about 11pm" or "around 6 in the morning".';

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/**
 * TTTFG-4830: the question again, never in the same words. `n`: how often it was asked before (1 = second time). Three
 * other wordings each, in turn: the first adds an example, the next ones ask for less ("what's the closest you can
 * say"), so a client stuck on a question gets a different way in each time.
 */
function askedAgain(fact: Fact, f: Facts, n: number, opening?: string): string {
  const base = BY_KIND[claimKind(f, opening)][fact] ?? FACT_QUESTIONS[fact];
  const yesNo = [`${base} Please just answer yes or no.`, `Sorry, I didn't catch that. ${base} Yes or no?`, `Just a yes or a no, please: ${lowerFirst(base)}`];
  const ways: Record<Fact, string[]> = {
    incidentTime: [
      `Thanks. Roughly what time was that? ${EXAMPLE_TIME}`,
      'What\'s the closest you can say, for example "after 10pm" or "between 1 and 3am"? A rough time is enough: your broker will confirm it with you.',
      'Was it in the morning, the afternoon, the evening or at night, and roughly what time? For example "evening, around 7".',
    ],
    incidentDate: [
      'Thanks. And on what date was that? For example "yesterday" or "Saturday the 18th".',
      'Which day was it? For example "last Friday" or "the 18th".',
      'Roughly which day was it? For example "last Monday".',
    ],
    incidentAt: [
      `On what date did it happen, and roughly what time? ${EXAMPLE_TIME}`,
      'When did it happen? The day and a rough time is all I need, for example "Friday night, after 10pm".',
      'Which day was it, and was it in the morning, the afternoon, the evening or at night?',
    ],
    place: [`${base} An address, a street and suburb, or a place like a shopping centre is fine.`, 'Where was it? A street, a suburb or a landmark is fine.', 'Which suburb or town was it in?'],
    description: [
      'Could you tell me a bit more about what happened, in a sentence or two?',
      'In a sentence or two, what happened?',
      'A short answer is fine, for example "my phone was taken from my bag at the mall". What happened?',
    ],
    claimType: [
      'Which of these is closest: a car accident, a stolen car, a hijacking, a windscreen, damage or loss at home, or something you carry with you that was lost or stolen?',
      'Is the claim about your car, your home, or something you carry with you?',
      'In a few words, what is the claim for? For example "my car was hit" or "my phone was stolen".',
    ],
    thirdParties: yesNo,
    saps: yesNo,
    injuries: yesNo,
    thirdPartyDetails: [
      `${base.replace(/^Please send me/, 'Could you send me')}${/nothing/.test(base) ? '' : ' Even a little helps.'}`,
      'Anything you know helps, for example a name, a phone number or a description. If you know nothing, just say "nothing".',
      'What do you know about them? A few words is fine, or "nothing".',
    ],
    injuryDetails: ['Who was hurt, and how? A short description is fine.', 'Who was hurt? For example "my passenger, a cut on the arm".', 'In a few words, who was hurt and how badly?'],
  };
  return ways[fact][(n - 1) % 3];
}

/** TTTFG-4830: the details questions, as the "If yes to N:" line under their yes/no. */
const INJURY_DETAILS_IF_YES = 'who was hurt, and what happened to them?';
const thirdPartyDetailsIfYes = (state: WalkthroughState) => {
  const q = BY_KIND[claimKind(state.facts, state.opening)].thirdPartyDetails ?? FACT_QUESTIONS.thirdPartyDetails;
  return lowerFirst(q);
};

/** One question, in words for this claim; asked before (`n` > 0): in other words. */
function factQuestion(fact: Fact, f: Facts, n = 0, opening?: string): string {
  return n > 0 ? askedAgain(fact, f, n, opening) : BY_KIND[claimKind(f, opening)][fact] ?? FACT_QUESTIONS[fact];
}

const yesNo = (b: boolean | undefined) => (b ? 'Yes' : 'No');
const when = (iso: string) => {
  const t = Date.parse(iso);
  const day = (ms: number, o: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg', ...o });
  // TTTFG-4830: midnight said plainly, so the client can see which night was recorded.
  if (sastParts(iso).time === '00:00') {
    const before = t - 60_000;
    const sameMonth = day(before, { month: 'long' }) === day(t, { month: 'long' });
    return `the night of ${day(before, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'long' })} to ${day(t, { day: 'numeric', month: 'long', year: 'numeric' })}, at midnight`;
  }
  return new Date(t).toLocaleString('en-GB', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const describe = (p: Policy) => `${p.insurer} ${p.product} policy (${p.policyNumber})`;

/**
 * Default wording for a question. Plain and short; Claude may phrase it instead (never for the fixed messages).
 * `tries` (TTTFG-4830): how often each question was asked before, so a second ask is never the same words.
 */
export function question(step: Step, missing: Fact[], state: WalkthroughState, correcting = false, tries: Record<string, number> = {}): string {
  if (correcting) {
    return missing.length ? `What should it be? ${missing.map((f) => factQuestion(f, state.facts, 0, state.opening)).join(' ')}` : 'Sorry about that. What should I change?';
  }
  const again = tries[step] ?? 0;
  switch (step) {
    case 'policy': {
      const list = state.policies.map((p, i) => `${i + 1}. ${describe(p)}`).join('\n');
      const one = state.policies.length === 1 ? describe(state.policies[0]) : '';
      if (one) {
        return [`Is this claim about your ${one}?`, `Sorry, I just need to check: is this claim about your ${one}? Please answer yes or no.`,
          `Is it your ${one}? Yes or no?`][again ? ((again - 1) % 2) + 1 : 0];
      }
      return [`Which policy is this claim about?\n${list}`, `Which one is it? Please reply with its number:\n${list}`,
        `Please reply with 1${state.policies.length > 1 ? `, 2${state.policies.length > 2 ? ' or another number' : ''}` : ''}:\n${list}`][again ? ((again - 1) % 2) + 1 : 0];
    }
    case 'danger':
      return ['First, is anyone hurt or in danger right now?', 'Sorry, I need to check this first: is anyone hurt or in danger right now? Please answer yes or no.',
        'Is anyone hurt or in danger right now? Yes or no?'][again ? ((again - 1) % 2) + 1 : 0];
    case 'summary':
      return again
        ? ['Is everything in the summary above correct? Please answer yes, or tell me what to change.', 'Is that all correct? Yes, or tell me what to change.'][(again - 1) % 2]
        : summary(state);
    default: {
      // TTTFG-4830: a yes/no asked for the first time brings its details question with it ("If yes to 1: please send me
      // their details"), so the yes and the details can come in one reply. Two or more questions are numbered, so the
      // client can answer by number.
      const parts: string[] = [];
      for (const f of missing) {
        const n = tries[askedKey(f)] ?? 0;
        parts.push(factQuestion(f, state.facts, n, state.opening));
        const details = f === 'thirdParties' ? thirdPartyDetailsIfYes(state) : f === 'injuries' ? INJURY_DETAILS_IF_YES : undefined;
        if (details && n === 0) parts.push(`If yes to ${parts.length}: ${details}`);
      }
      // "Thanks." belongs at the start of the message, once, not in the middle of it.
      const thanks = parts.some((p) => p.startsWith('Thanks. '));
      const clean = parts.map((p) => p.replace(/^Thanks\. /, ''));
      const text = clean.length > 1 ? clean.map((p, i) => `${i + 1}. ${p}`).join('\n') : clean.join(' ');
      // TTTFG-4830 (voice notes): the first "what happened" says they can answer by voice note.
      const voice = missing.includes('description') && !(tries[askedKey('description')] ?? 0) ? `${clean.length > 1 ? '\n' : ' '}${VOICE_OR_TEXT}` : '';
      return `${thanks ? `Thanks.${clean.length > 1 ? '\n' : ' '}` : ''}${text}${voice}`;
    }
  }
}

/** SPEC-04 step 10: read back a summary for the client to confirm. */
export function summary(state: WalkthroughState): string {
  const f = state.facts;
  const p = state.policies.find((x) => x.id === state.policyId)!;
  return [
    "Here's what I have. Is it all correct?",
    `Policy: ${p.insurer} ${p.product}`,
    `Claim: ${f.claimType}`,
    `When: ${f.incidentAt ? when(f.incidentAt) : ''}`,
    `Where: ${f.place}`,
    `What happened: ${f.description}`,
    isTheft(f, state.opening) ? `Who did it or saw it: ${f.thirdPartyDetails ?? 'not known'}` : `Anyone else involved: ${yesNo(f.thirdParties)}${f.thirdPartyDetails ? ` (${f.thirdPartyDetails})` : ''}`,
    isTheft(f, state.opening) ? `Reported to the police (SAPS): ${yesNo(f.saps)}` : `Police (SAPS) involved: ${yesNo(f.saps)}`,
    `Anyone injured: ${yesNo(f.injuries)}${f.injuryDetails ? ` (${f.injuryDetails})` : ''}`,
  ].join('\n');
}

const FOLLOW_UP_DETAIL: Record<FollowUpReason, string> = {
  'no-active-policy': 'Client asked on WhatsApp to report a claim but has no active policy on the CRM. Please contact them.',
  'policy-not-on-file': 'Client asked on WhatsApp to report a claim on a policy that is not on the CRM. Please contact them.',
  'no-assist-number': 'Client reporting a claim said someone is hurt or in danger. The insurer has no assist number on file, so Tina gave 112. Please contact them now.',
};

export interface TurnResult {
  state: WalkthroughState | null;
  claim?: { id: string; reference: string; owner: Owner };
  /** The last text Tina sent this turn, so the next client message is read against the question it answers. */
  lastSent?: string;
}

/** One message from the client: { kind: 'start' } when Anchor first routes a claim here, else what Claude understood. */
export async function claimTurn(
  ports: ClaimPorts, conv: Conversation, state: WalkthroughState | null, input: { kind: 'start'; facts?: Facts } | Answer, now: Date,
): Promise<TurnResult> {
  const at = now.toISOString();
  let turn;
  let contactId = state?.contactId;
  if (input.kind === 'start' || !state) {
    const contact = await ports.contactByWhatsApp(conv.phone);
    contactId = contact?.id;
    turn = start(contact, contact ? await ports.activePolicies(contact.id) : [], input.kind === 'start' ? input.facts : undefined);
  } else {
    turn = advance(state, input as Answer);
  }
  const working = turn.state ?? state;

  // Follow-ups first: their due date goes into what Tina says.
  let passedOn: { owner: Owner; dueOn?: string } | undefined;
  for (const e of turn.effects.filter((x): x is Extract<Effect, { kind: 'follow-up' }> => x.kind === 'follow-up')) {
    const owner = await ownerFor(ports, e.to === 'broker' ? working?.policyId : undefined);
    const row = await ports.createAgentAction({
      kind: 'Follow-up', department: DEPARTMENT, owner, regarding: { table: 'riivo_request', id: conv.requestId }, contactId,
      detail: FOLLOW_UP_DETAIL[e.reason], at, ...(e.reason === 'no-assist-number' ? { urgent: true as const } : {}),
    });
    if (e.to === 'team') passedOn = { owner, dueOn: row.dueOn };
  }

  let lastSent: string | undefined;
  for (const say of turn.say) {
    lastSent = await sendText(ports, conv, render(say, turn.state ?? working, conv, passedOn), null, at, contactId);
  }

  if (turn.effects.some((e) => e.kind === 'open-claim')) {
    if (!state || !complete(state)) throw new Error('TTTFG-5168: open-claim before the walkthrough is complete');
    const claim = await openClaim(ports, conv, state, at);
    return { state: null, claim, lastSent: claim.text };
  }
  return { state: turn.state, lastSent };
}

async function ownerFor(ports: ClaimPorts, policyId: string | undefined): Promise<Owner> {
  const team = await ports.insuranceTeam();
  return claimOwner(policyId ? await ports.policyOwner(policyId) : null, team);
}

function render(say: Say, state: WalkthroughState | null, conv: Conversation, passedOn?: { owner: Owner; dueOn?: string }): string {
  switch (say.kind) {
    case 'unknown-number':
      return unknownNumberText(conv.signUpLink);
    case 'assist':
      return `Please call ${say.insurer}'s emergency assist line now: ${say.number}. Come back to me once everyone is safe.`;
    case 'emergency':
      return 'Please call 112 for emergency help now. Come back to me once everyone is safe.';
    case 'on-scene':
      return onSceneText(state!, say.safeFirst);
    case 'passed-on': {
      const why = say.reason === 'no-active-policy' ? "I can't see an active policy for you on our system" : "I can only open a claim on a policy we have on file";
      const by = passedOn?.dueOn ? ` by ${new Date(passedOn.dueOn).toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg', weekday: 'long', day: 'numeric', month: 'long' })}` : '';
      return `${why}, so I've passed this to ${passedOn?.owner.name ?? 'our insurance team'}, who will contact you${by}.`;
    }
    case 'ask':
      return question(say.step, say.missing, state!, say.correcting, say.tries);
  }
}

/** Every outbound text passes the policy gate (gate.ts claimGate). A blocked text becomes the holding line and a
 *  Follow-up. Returns the text that went out. */
export async function sendText(
  ports: ClaimPorts, conv: Conversation, text: string, claim: { id: string; owner: Owner } | null, at: string, contactId?: string,
): Promise<string> {
  const gate = claimGate(text);
  if (!gate.ok) {
    const owner = claim?.owner ?? (await ownerFor(ports, undefined));
    await ports.createAgentAction({
      kind: 'Follow-up', department: DEPARTMENT, owner,
      regarding: claim ? { table: 'riivo_claim', id: claim.id } : { table: 'riivo_request', id: conv.requestId }, contactId,
      detail: `Tina's reply was blocked by the ${gate.rule} rule ("${gate.matched}"). The client got the holding line. Please update them.`,
      at,
    });
  }
  await ports.send(conv.phone, { kind: 'text', text: gate.text });
  return gate.text;
}

async function openClaim(ports: ClaimPorts, conv: Conversation, state: WalkthroughState & { policyId: string }, at: string) {
  const policy = state.policies.find((p) => p.id === state.policyId)!;
  const owner = await ownerFor(ports, policy.id);
  const f = state.facts as Required<Pick<Facts, 'claimType' | 'incidentAt' | 'place' | 'description' | 'thirdParties' | 'saps' | 'injuries'>> & Facts;
  const { id, reference } = await ports.createClaim({
    contactId: state.contactId, policyId: policy.id, providerId: policy.providerId,
    claimType: f.claimType, reportedOn: at, incidentAt: f.incidentAt, place: f.place, description: f.description,
    thirdParties: f.thirdParties, thirdPartyDetails: f.thirdPartyDetails, saps: f.saps, injuries: f.injuries, injuryDetails: f.injuryDetails,
    channel: 'WhatsApp', status: 'FNOL logged', lastClientMessageOn: at, owner,
  });
  await ports.createAgentAction({
    kind: 'Created', department: DEPARTMENT, owner, regarding: { table: 'riivo_claim', id }, contactId: state.contactId, at,
    detail: `Claim ${reference} opened on WhatsApp (FNOL logged).`,
  });

  const text = FNOL_TEMPLATE.render({ firstName: state.firstName, reference, ownerName: owner.name });
  await ports.send(conv.phone, { kind: 'template', name: FNOL_TEMPLATE.name, version: FNOL_TEMPLATE.version, text });
  await ports.createAgentAction({
    kind: 'Created', department: DEPARTMENT, owner, regarding: { table: 'riivo_claim', id }, contactId: state.contactId, at,
    detail: `Acknowledgement sent on WhatsApp for claim ${reference}.`,
    template: { name: FNOL_TEMPLATE.name, version: FNOL_TEMPLATE.version, text },
  });
  return { id, reference, owner, text };
}
