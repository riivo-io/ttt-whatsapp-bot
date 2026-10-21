// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/claim.ts (commit 7a7ab8c). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5168: one claim turn on WhatsApp. Runs the walkthrough (walkthrough.ts), then carries out what it asks:
// reads the client and their policies, opens the riivo_claim, sets its owner, sends the acknowledgement template and
// writes the agent actions. Every outbound text goes through the claim-outcome gate (gate.ts).
//
// Seam for tests: ClaimPorts. Dataverse, WhatsApp and the clock are faked there. The real adapters come with
// TTTFG-4885 (riivo_claim, riivo_provider.riivo_assistnumber) and the SPEC-05 story that loads department packages
// into Tina (epic TTTFG-4830).
import { claimOutcomeGate } from './gate';
import {
  advance, complete, start,
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
  template?: { name: string; version: string; text: string };
}

export type Outbound = { kind: 'text'; text: string } | { kind: 'template'; name: string; version: string; text: string };

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
  thirdParties: 'Was anyone else involved, for example another driver?',
  thirdPartyDetails: 'Please send me their details, for example their name, number or vehicle registration.',
  saps: 'Were the police (SAPS) involved?',
  injuries: 'Was anyone injured?',
  injuryDetails: 'I am sorry to hear that. Who was hurt, and what happened to them?',
};

const yesNo = (b: boolean | undefined) => (b ? 'Yes' : 'No');
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const describe = (p: Policy) => `${p.insurer} ${p.product} policy (${p.policyNumber})`;

/** Default wording for a question. Plain and short; Claude may phrase it instead (never for the fixed messages). */
export function question(step: Step, missing: Fact[], state: WalkthroughState, correcting = false): string {
  if (correcting) {
    return missing.length ? `What should it be? ${missing.map((f) => FACT_QUESTIONS[f]).join(' ')}` : 'Sorry about that. What should I change?';
  }
  switch (step) {
    case 'policy':
      return state.policies.length === 1
        ? `Is this claim about your ${describe(state.policies[0])}?`
        : `Which policy is this claim about?\n${state.policies.map((p, i) => `${i + 1}. ${describe(p)}`).join('\n')}`;
    case 'danger':
      return 'First, is anyone hurt or in danger right now?';
    case 'summary':
      return summary(state);
    default:
      return missing.map((f) => FACT_QUESTIONS[f]).join(' ');
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
    `Anyone else involved: ${yesNo(f.thirdParties)}${f.thirdPartyDetails ? ` (${f.thirdPartyDetails})` : ''}`,
    `Police (SAPS) involved: ${yesNo(f.saps)}`,
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
  ports: ClaimPorts, conv: Conversation, state: WalkthroughState | null, input: { kind: 'start' } | Answer, now: Date,
): Promise<TurnResult> {
  const at = now.toISOString();
  let turn;
  let contactId = state?.contactId;
  if (input.kind === 'start' || !state) {
    const contact = await ports.contactByWhatsApp(conv.phone);
    contactId = contact?.id;
    turn = start(contact, contact ? await ports.activePolicies(contact.id) : []);
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
    case 'passed-on': {
      const why = say.reason === 'no-active-policy' ? "I can't see an active policy for you on our system" : "I can only open a claim on a policy we have on file";
      const by = passedOn?.dueOn ? ` by ${new Date(passedOn.dueOn).toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg', weekday: 'long', day: 'numeric', month: 'long' })}` : '';
      return `${why}, so I've passed this to ${passedOn?.owner.name ?? 'our insurance team'}, who will contact you${by}.`;
    }
    case 'ask':
      return question(say.step, say.missing, state!, say.correcting);
  }
}

/** Every outbound text passes the claim-outcome gate. A blocked text becomes the holding line and a Follow-up.
 *  Returns the text that went out. */
export async function sendText(
  ports: ClaimPorts, conv: Conversation, text: string, claim: { id: string; owner: Owner } | null, at: string, contactId?: string,
): Promise<string> {
  const gate = claimOutcomeGate(text);
  if (!gate.ok) {
    const owner = claim?.owner ?? (await ownerFor(ports, undefined));
    await ports.createAgentAction({
      kind: 'Follow-up', department: DEPARTMENT, owner,
      regarding: claim ? { table: 'riivo_claim', id: claim.id } : { table: 'riivo_request', id: conv.requestId }, contactId,
      detail: `Tina's reply was blocked by the claim-outcome rule ("${gate.matched}"). The client got the holding line. Please update them.`,
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
