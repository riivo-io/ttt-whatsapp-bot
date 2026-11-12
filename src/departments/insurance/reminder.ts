// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/reminder.ts (commit 62f588b). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5212: every morning, a client whose claim still needs something is sent the list again, so the claim doesn't
// stall on the client's side. The host calls remindTurn() once per client, at 08:00 South African time. What's needed
// is worked out from the claim record (progress.ts), never remembered.
//
// The clock is the client's last message about an open claim (the latest riivo_lastclientmessageon): anything the
// client sends resets it (AC 7). Days are calendar days in South Africa: the day they wrote is day 0, the next day 1.
//
// Per open claim of the client, a reminder goes out when (AC 1, 8):
// - the claim is at Awaiting client docs or Additional info requested (REMINDED_STATUSES). Tina sets Awaiting client
//   docs when she starts on the evidence, so a client who stopped part way through the form's questions (FNOL logged)
//   isn't reminded. A claim stays there when the signing link goes with something still to come: Form sent is for a
//   claim with nothing left to come (followon.ts proceed), and gets no message but the link;
// - something is still needed (missingItems): the items the client can get, by name; on a claim the client left half
//   way, the questions still open, counted. A claim marked evidence complete (riivo_evidencecomplete) is finished as far
//   as the client is concerned, whatever the list works out later (SAPS required afterwards, say): no reminder, no broker step;
// - it is day `fromDay` (1) or later, and before `stopAfterDays` (10). The reminders stop there and the claim goes to
//   the broker as a call to make (below; TTTFG-5289 may move the day);
// - it isn't Sunday in South Africa;
// - the client hasn't said the claim isn't theirs (TTTFG-4830: OpenClaim.disputed, while the broker checks it). Such a
//   claim gets no reminder and no broker step: the broker already has an urgent Follow-up on it;
// - the claim wasn't reminded already today (its Created agent action), so a second run the same day sends nothing.
//
// On the claim's own channel only (AC 2), as a fixed template filled with CRM values (AC 9):
// - a WhatsApp claim: the approved WhatsApp template (REMINDER_TEMPLATE), whatever the 24-hour window, the list in one
//   line because a template variable can't hold line breaks. The host must have it (`template: true`), and Tina must
//   not be waiting on "which claim?";
// - an email claim: an email (REMINDER_EMAIL_TEMPLATE) through the host's `email` port. The email agent has one, and runs
//   remindEmailClaims() each morning. Tina has none, so an email claim gets no reminder from her, and never a WhatsApp one.
// Each reminder writes a Created agent action with the time, the template's name and version and the text as sent.
//
// The broker (the claim's owner) gets a Follow-up, from the same clock, per claim that would be reminded (AC 4, 5):
// - on day `brokerAlertDays` (5): the client hasn't sent the missing items (BROKER_STEPS.alert). Once per quiet spell:
//   a client who writes, then goes quiet again, gets there again (28 Oct);
// - on day `stopAfterDays`, the day the reminders stop: phone the client (BROKER_STEPS.call). Once per claim.
// Each is found again by its wording's name, as the reminder is. They don't wait on the reminder: they go on Sunday,
// without a template or an email sender, and while Tina waits on "which claim?". Both days are settings (AC 6): the
// host reads TTT's Dataverse environment variables (REMINDER_SETTING_VARIABLES, resume-dataverse.ts).
//
// The conversation: a WhatsApp claim whose questions are all asked goes back on its list (FollowOnState phase
// `still-need`), so a reply ("the case number is CAS 123/10/2026") is read against it. A claim the client left half way
// keeps its state: the reply resumes the questions, as it would without a reminder. When two claims are reminded, the
// state is left alone and a reply goes through "which claim?".
import { DEPARTMENT, type Conversation, type Owner } from './claim';
import {
  CLAIM_SETTINGS_DEFAULTS, list, resumeFollowOn, resumeMissing, stillNeedLines, stillNeedNames, stillNeedState, type ClaimSettings, type ClaimStatus,
  type StoredClaimForm,
} from './followon';
import { chased } from './progress';
import { claimWords, isOpenClaim, NO_RESUME_STATE, type ResumePorts, type ResumeState } from './resume';
import { REMINDER_EMAIL_TEMPLATE, REMINDER_TEMPLATE } from './templates';

export interface ReminderSettings extends ClaimSettings {
  /** The first reminder goes on this calendar day after the client's last message (a test by hand: 0, today). */
  fromDay?: number;
  /** The broker's alert (BROKER_STEPS.alert) on this calendar day after the client's last message. */
  brokerAlertDays?: number;
  /** No reminder from this calendar day after the client's last message; the broker phones (BROKER_STEPS.call). */
  stopAfterDays?: number;
  /** The host can send REMINDER_TEMPLATE as an approved WhatsApp template. Without it no WhatsApp reminder goes. */
  template?: boolean;
  /** The email agent's run: only the client's email claims are looked at. WhatsApp claims and their broker steps are Tina's. */
  emailOnly?: boolean;
}
export const REMINDER_SETTINGS_DEFAULTS = { fromDay: 1, brokerAlertDays: 5, stopAfterDays: 10 } as const;

/** AC 6: the Dataverse environment variables TTT sets the two days in (resume-dataverse.ts reads them). */
export const REMINDER_SETTING_VARIABLES = {
  brokerAlertDays: 'riivo_ClaimReminderBrokerAlertDay',
  stopAfterDays: 'riivo_ClaimReminderStopDay',
} as const;

/** AC 1, 8: the claims waiting on the client. Any other status gets no reminder and no broker step. */
export const REMINDED_STATUSES = ['Awaiting client docs', 'Additional info requested'] as const satisfies readonly ClaimStatus[];
const isReminded = (status: ClaimStatus) => (REMINDED_STATUSES as readonly string[]).includes(status);

/** The broker's two Follow-ups: `alert` on day 5, `call` on the stop day. */
export type BrokerStep = 'alert' | 'call';

/** AC 2: the host's email sender, for a claim that came in by email. */
export interface ReminderEmailPort {
  /** The client's first name, or null when they can't be emailed (no address, Do Not Email). */
  contact(contactId: string): Promise<{ firstName: string } | null>;
  send(contactId: string, message: { subject: string; text: string }, claim: { id: string; owner: Owner }): Promise<void>;
}

export interface ReminderPorts extends ResumePorts {
  /** When the claim's last reminder went out (its Created agent action, WhatsApp or email), or null. */
  lastReminderOn(claimId: string): Promise<string | null>;
  /** When the claim's last Follow-up for this broker step was written, or null. */
  lastBrokerStepOn(claimId: string, step: BrokerStep): Promise<string | null>;
  /** Absent (Tina): an email claim gets no reminder ('no-email-sender'). The broker steps still go. */
  email?: ReminderEmailPort;
}

export type ReminderSkip =
  | 'nothing-needed' | 'wrote-today' | 'quiet-too-long' | 'no-message-yet' | 'reminded-today' | 'no-template' | 'question-open'
  | 'sunday' | 'disputed' | 'status' | 'no-email-sender' | 'no-email-address';
/** `broker`: the claim's owner got that step's Follow-up this run. */
export type ReminderOutcome =
  | { reference: string; sent: 'template' | 'email'; lines: string[]; broker?: BrokerStep }
  | { reference: string; skipped: ReminderSkip; broker?: BrokerStep };

export interface BrokerVars {
  reference: string;
  /** Calendar days since the client's last message. */
  days: number;
  /** What's still needed (followon.ts stillNeedLines). */
  lines: readonly string[];
  stopAfterDays: number;
}

/**
 * TTTFG-5212 AC 4 and 5: the broker's Follow-ups. Fixed wording, for the claim owner (never sent to the client). The
 * name goes on the agent action (riivo_subject), so the next run finds it (lastBrokerStepOn).
 */
export const BROKER_STEPS = {
  alert: {
    name: 'Claim - client quiet (broker alert)',
    version: 'draft-1',
    render: (v: BrokerVars) => `Claim ${v.reference}: the client hasn't sent the missing items in ${v.days} days. Still needed: `
      + `${v.lines.join('; ')}. If nothing comes by day ${v.stopAfterDays}, the morning reminders stop and you get a follow-up to phone them.`,
  },
  call: {
    name: 'Claim - client quiet (phone the client)',
    version: 'draft-1',
    render: (v: BrokerVars) => `Claim ${v.reference}: please phone the client. They haven't sent the missing items in ${v.days} days, `
      + `and the morning reminders have stopped. Still needed: ${v.lines.join('; ')}.`,
  },
} as const satisfies Record<BrokerStep, { name: string; version: string; render: (v: BrokerVars) => string }>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The calendar date in South Africa (UTC+2, no daylight saving). */
const sastDate = (iso: string) => new Date(Date.parse(iso) + 2 * HOUR).toISOString().slice(0, 10);
const sastSunday = (now: Date) => new Date(now.getTime() + 2 * HOUR).getUTCDay() === 0;

/** Calendar days in South Africa from the client's last message to `now`: 0 the day they wrote, 1 the next day. */
export const quietDays = (lastHeard: string, now: Date) =>
  Math.round((Date.parse(sastDate(now.toISOString())) - Date.parse(sastDate(lastHeard))) / DAY);

/** Whether this morning is a reminder day, from when the client last wrote about an open claim. Pure. */
export function reminderToday(lastHeard: string | undefined, now: Date, settings: ReminderSettings = {}):
  { ok: true } | { ok: false; skipped: ReminderSkip } {
  if (!lastHeard) return { ok: false, skipped: 'no-message-yet' };
  const days = quietDays(lastHeard, now);
  if (days < (settings.fromDay ?? REMINDER_SETTINGS_DEFAULTS.fromDay)) return { ok: false, skipped: 'wrote-today' };
  if (days >= (settings.stopAfterDays ?? REMINDER_SETTINGS_DEFAULTS.stopAfterDays)) return { ok: false, skipped: 'quiet-too-long' };
  if (sastSunday(now)) return { ok: false, skipped: 'sunday' };
  return { ok: true };
}

/** Which broker step the client's silence has reached, from when they last wrote about an open claim, or null. Pure. */
export function brokerStep(lastHeard: string | undefined, now: Date, settings: ReminderSettings = {}): BrokerStep | null {
  if (!lastHeard) return null;
  const days = quietDays(lastHeard, now);
  if (days >= (settings.stopAfterDays ?? REMINDER_SETTINGS_DEFAULTS.stopAfterDays)) return 'call';
  if (days >= (settings.brokerAlertDays ?? REMINDER_SETTINGS_DEFAULTS.brokerAlertDays)) return 'alert';
  return null;
}

/** The step's Follow-up is still to write: the call once per claim, the alert once since the client last wrote. */
async function brokerDue(ports: ReminderPorts, claimId: string, step: BrokerStep, heard: string): Promise<boolean> {
  const last = await ports.lastBrokerStepOn(claimId, step);
  return !last || (step === 'alert' && Date.parse(last) < Date.parse(heard));
}

type Today = { ok: true } | { ok: false; skipped: ReminderSkip };

/**
 * One client's morning reminders: one per reminded claim that still needs something, on the claim's channel, and the
 * broker's Follow-ups, as the rules at the top of this file say. Returns the conversation state to keep (see above),
 * what happened per claim, and the last WhatsApp text sent (the host keeps it as Tina's last message, so the reply is
 * read against it).
 */
export async function remindTurn(
  ports: ReminderPorts, conv: Conversation, state: ResumeState, contactId: string, now: Date, settings: ReminderSettings = {},
): Promise<{ state: ResumeState; outcomes: ReminderOutcome[]; lastSent?: string }> {
  const at = now.toISOString();
  const open = (await ports.openClaimsForClient(contactId)).filter((c) => isOpenClaim(c.status));
  const heard = open.map((c) => c.lastClientMessageOn).filter((d): d is string => !!d).sort().at(-1);
  const today = reminderToday(heard, now, settings);
  const step = brokerStep(heard, now, settings);

  const outcomes: ReminderOutcome[] = [];
  const reminded: Array<{ ctx: Parameters<typeof resumeMissing>[0]; missing: ReturnType<typeof resumeMissing> }> = [];
  let firstName: string | undefined;
  let lastSent: string | undefined;
  for (const o of open) {
    const email = o.channel === 'Email';
    if (settings.emailOnly && !email) continue;
    if (o.disputed) { outcomes.push({ reference: o.reference, skipped: 'disputed' }); continue; }
    if (!isReminded(o.status)) { outcomes.push({ reference: o.reference, skipped: 'status' }); continue; }
    const when: Today = !today.ok ? today
      : email ? (ports.email ? today : { ok: false, skipped: 'no-email-sender' })
      // Tina asked "which claim?" or "is this a new claim?" and is waiting: a reminder now would cross it.
      : state.pending ? { ok: false, skipped: 'question-open' }
      : !settings.template ? { ok: false, skipped: 'no-template' }
      : today;
    const due = step && (await brokerDue(ports, o.id, step, heard!)) ? step : undefined;
    if (!when.ok && !due) { outcomes.push({ reference: o.reference, skipped: when.skipped }); continue; }

    const claim = await ports.loadClaim(o.id);
    if (claim.evidenceComplete) { outcomes.push({ reference: o.reference, skipped: 'nothing-needed' }); continue; }
    const form: StoredClaimForm = claim.claimFormId
      ? await ports.claimForm(claim.claimFormId)
      : (await ports.activeClaimForm(claim.providerId, claim.claimType)) ?? (await ports.genericClaimForm());
    const ctx = { claim, form, now, warningDays: settings.notificationWarningDays ?? CLAIM_SETTINGS_DEFAULTS.notificationWarningDays };
    const missing = resumeMissing(ctx);
    if (!missing.length) { outcomes.push({ reference: o.reference, skipped: 'nothing-needed' }); continue; }
    const lines = stillNeedLines(missing, claim.answers);
    const channel = email ? 'Email' as const : 'WhatsApp' as const;

    if (due) {
      const wording = BROKER_STEPS[due];
      await ports.createAgentAction({
        kind: 'Follow-up', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claim.id }, contactId: claim.contactId,
        channel, at,
        detail: wording.render({
          reference: claim.reference, days: quietDays(heard!, now), lines,
          stopAfterDays: settings.stopAfterDays ?? REMINDER_SETTINGS_DEFAULTS.stopAfterDays,
        }),
        template: { name: wording.name, version: wording.version },
      });
    }
    const broker = due ? { broker: due } : {};
    if (!when.ok) { outcomes.push({ reference: o.reference, skipped: when.skipped, ...broker }); continue; }
    const last = await ports.lastReminderOn(o.id);
    if (last && sastDate(last) === sastDate(at)) { outcomes.push({ reference: o.reference, skipped: 'reminded-today', ...broker }); continue; }

    // TTTFG-4830 (29 Oct 2026): named as Tina names it back on the claim ("your all risk claim", A6).
    const label = `${claimWords(claim.claimType)} claim (${claim.reference})`;
    const row = { kind: 'Created', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claim.id }, contactId: claim.contactId, channel, at } as const;
    if (email) {
      const contact = await ports.email!.contact(contactId);
      if (!contact) { outcomes.push({ reference: o.reference, skipped: 'no-email-address', ...broker }); continue; }
      const vars = { firstName: contact.firstName, claim: label, lines, questionsLeft: missing.some((i) => !chased(i)) };
      const message = { subject: REMINDER_EMAIL_TEMPLATE.subject(vars), text: REMINDER_EMAIL_TEMPLATE.render(vars) };
      await ports.email!.send(contactId, message, { id: claim.id, owner: claim.owner });
      await ports.createAgentAction({
        ...row, detail: `Reminder email sent for claim ${claim.reference}: ${lines.join('; ')}.`,
        template: { name: REMINDER_EMAIL_TEMPLATE.name, version: REMINDER_EMAIL_TEMPLATE.version, text: `${message.subject}\n\n${message.text}` },
      });
      outcomes.push({ reference: o.reference, sent: 'email', lines, ...broker });
      continue;
    }

    firstName ??= (await ports.contactByWhatsApp(conv.phone))?.firstName ?? 'there';
    const vars = { firstName, claim: label, list: list(stillNeedNames(missing, claim.answers)) };
    const text = REMINDER_TEMPLATE.render(vars);
    await ports.send(conv.phone, { kind: 'template', name: REMINDER_TEMPLATE.name, version: REMINDER_TEMPLATE.version, text, params: REMINDER_TEMPLATE.params(vars) });
    await ports.createAgentAction({
      ...row, detail: `Morning reminder sent on WhatsApp for claim ${claim.reference}: ${lines.join('; ')}.`,
      template: { name: REMINDER_TEMPLATE.name, version: REMINDER_TEMPLATE.version, text },
    });
    outcomes.push({ reference: o.reference, sent: 'template', lines, ...broker });
    reminded.push({ ctx, missing });
    lastSent = text;
  }

  // One claim reminded on WhatsApp, and all its questions asked: the conversation goes back on its list.
  const only = reminded.length === 1 ? reminded[0] : undefined;
  // Not while a guided form is open (TTTFG-5562): the client is still on it, and its Submit carries on from that phase.
  if (only && only.missing.every(chased) && state.followOn?.phase !== 'form') {
    const followOn = stillNeedState({ now }, resumeFollowOn(only.ctx, true), only.missing);
    return { state: { followOn, pending: null }, outcomes, lastSent };
  }
  return { state, outcomes, lastSent };
}

export interface EmailReminderPorts extends ReminderPorts {
  email: ReminderEmailPort;
  /** The clients with an email claim at a reminded status. */
  emailClaimClients(): Promise<string[]>;
}

/** AC 2: there is no conversation on an email claim, and emailOnly keeps remindTurn off the WhatsApp parts. */
const NO_CONVERSATION: Conversation = { phone: '', requestId: '', signUpLink: '' };

/**
 * AC 2: one morning's email reminders and their broker steps, for every client with an email claim waiting on them. One
 * client's failure (a mailbox refused) doesn't stop the others; nothing was recorded for the failed claim, so the next
 * morning tries it again.
 */
export async function remindEmailClaims(ports: EmailReminderPorts, now: Date, settings: ReminderSettings = {}) {
  const counts = { clients: 0, sent: 0, brokerSteps: 0, failed: 0 };
  const errors: Array<{ contactId: string; error: string }> = [];
  for (const contactId of await ports.emailClaimClients()) {
    counts.clients++;
    try {
      const { outcomes } = await remindTurn(ports, NO_CONVERSATION, NO_RESUME_STATE, contactId, now, { ...settings, emailOnly: true });
      counts.sent += outcomes.filter((o) => 'sent' in o).length;
      counts.brokerSteps += outcomes.filter((o) => o.broker).length;
    } catch (e) {
      counts.failed++;
      errors.push({ contactId, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  return { counts, errors };
}
