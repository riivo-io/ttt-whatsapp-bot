// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/reminder.ts (commit ba38887). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5212 (first cut, built for the TTTFG-4830 WhatsApp demo): every morning, a client whose claim still needs
// something is sent the list again ("Things we still need from you"), so the claim doesn't stall on the client's side.
// The host calls remindTurn() once per client, at 08:00 South African time. What's needed is worked out from the claim
// record (progress.ts), never remembered.
//
// Per open claim of the client (OPEN_CLAIM_STATUSES), a reminder goes out when:
// - something is still needed (missingItems): the items the client can get, by name; on a claim the client left half
//   way, the questions still open, counted;
// - the client hasn't written for `quietHours` (default 12). 5212: anything the client sends resets the clock;
// - the client's last message is less than `stopAfterDays` old (default 10). 5212 stops the reminders there and hands
//   the claim to the broker as a call to make (below; TTTFG-5289 may move the day);
// - it isn't Sunday in South Africa (5212 AC 1);
// - the claim wasn't reminded already today (its Created agent action), so a second run the same day sends nothing;
// - WhatsApp allows it: a client who last wrote more than 24 hours ago can only be sent an approved template. With
//   `template: true` (the host has one) the reminder goes as REMINDER_TEMPLATE's WhatsApp body, the list in one line,
//   because a template variable can't hold line breaks. Without it the claim is passed over.
//
// The broker (the claim's owner) gets a Follow-up, from the same clock, per open claim that still needs something:
// - when the client's last message is `brokerAlertDays` old (default 5): the client hasn't sent the missing items
//   (BROKER_STEPS.alert). Once per quiet spell: a client who writes, then goes quiet again, gets there again (28 Oct);
// - when it is `stopAfterDays` old, the day the reminders stop: phone the client (BROKER_STEPS.call). Once per claim.
// Each is found again by its wording's name, as the reminder is. They don't wait on the reminder: they go on Sunday,
// outside the 24-hour window, and while Tina waits on "which claim?".
// Not built from 5212 yet: email claims reminded by email (TTTFG-4973's templated sends), and AC 8's two statuses
// (every open status is reminded until TTTFG-5208 moves claims to Awaiting client docs or Additional info requested).
//
// The conversation: a claim whose questions are all asked goes back on its list (FollowOnState phase `still-need`), so
// a reply ("the case number is CAS 123/10/2026") is read against it. A claim the client left half way keeps its state:
// the reply resumes the questions, as it would without a reminder. When two claims are reminded, the state is left
// alone and a reply goes through "which claim?".
import { DEPARTMENT, type Conversation } from './claim';
import { CLAIM_SETTINGS_DEFAULTS, list, resumeFollowOn, resumeMissing, stillNeedLines, stillNeedState, type ClaimSettings, type StoredClaimForm } from './followon';
import { chased } from './progress';
import { missingNames, isOpenClaim, type ResumePorts, type ResumeState } from './resume';
import { REMINDER_TEMPLATE } from './templates';

export interface ReminderSettings extends ClaimSettings {
  /** No reminder when the client wrote less than this many hours ago. */
  quietHours?: number;
  /** The broker's alert (BROKER_STEPS.alert) when the client's last message is this many days old. */
  brokerAlertDays?: number;
  /** No reminder when the client's last message is this many days old or more; the broker phones (BROKER_STEPS.call). */
  stopAfterDays?: number;
  /** The host can send REMINDER_TEMPLATE as an approved WhatsApp template (outside the 24-hour window). */
  template?: boolean;
}
export const REMINDER_SETTINGS_DEFAULTS = { quietHours: 12, brokerAlertDays: 5, stopAfterDays: 10 } as const;

/** The broker's two Follow-ups: `alert` on day 5, `call` on the stop day. */
export type BrokerStep = 'alert' | 'call';

export interface ReminderPorts extends ResumePorts {
  /** When the claim's last morning reminder went out (its Created agent action), or null. */
  lastReminderOn(claimId: string): Promise<string | null>;
  /** When the claim's last Follow-up for this broker step was written, or null. */
  lastBrokerStepOn(claimId: string, step: BrokerStep): Promise<string | null>;
}

export type ReminderSkip =
  | 'nothing-needed' | 'wrote-recently' | 'quiet-too-long' | 'no-message-yet' | 'reminded-today' | 'outside-24h' | 'question-open'
  | 'sunday';
/** `broker`: the claim's owner got that step's Follow-up this run. */
export type ReminderOutcome =
  | { reference: string; sent: 'text' | 'template'; lines: string[]; broker?: BrokerStep }
  | { reference: string; skipped: ReminderSkip; broker?: BrokerStep };

export interface BrokerVars {
  reference: string;
  /** Whole days since the client's last message. */
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

/**
 * Whether the client gets reminders at all this morning, from when they last wrote about an open claim. Pure. `window`:
 * inside WhatsApp's 24-hour window, so the reminder can go as a plain message.
 */
export function reminderWindow(lastHeard: string | undefined, now: Date, settings: ReminderSettings = {}):
  { ok: true; window: boolean } | { ok: false; skipped: ReminderSkip } {
  if (!lastHeard) return { ok: false, skipped: 'no-message-yet' };
  const quiet = now.getTime() - Date.parse(lastHeard);
  if (quiet < (settings.quietHours ?? REMINDER_SETTINGS_DEFAULTS.quietHours) * HOUR) return { ok: false, skipped: 'wrote-recently' };
  if (quiet >= (settings.stopAfterDays ?? REMINDER_SETTINGS_DEFAULTS.stopAfterDays) * DAY) return { ok: false, skipped: 'quiet-too-long' };
  if (sastSunday(now)) return { ok: false, skipped: 'sunday' };
  const window = quiet < DAY;
  if (!window && !settings.template) return { ok: false, skipped: 'outside-24h' };
  return { ok: true, window };
}

/** Which broker step the client's silence has reached, from when they last wrote about an open claim, or null. Pure. */
export function brokerStep(lastHeard: string | undefined, now: Date, settings: ReminderSettings = {}): BrokerStep | null {
  if (!lastHeard) return null;
  const quiet = now.getTime() - Date.parse(lastHeard);
  if (quiet >= (settings.stopAfterDays ?? REMINDER_SETTINGS_DEFAULTS.stopAfterDays) * DAY) return 'call';
  if (quiet >= (settings.brokerAlertDays ?? REMINDER_SETTINGS_DEFAULTS.brokerAlertDays) * DAY) return 'alert';
  return null;
}

/** The step's Follow-up is still to write: the call once per claim, the alert once since the client last wrote. */
async function brokerDue(ports: ReminderPorts, claimId: string, step: BrokerStep, heard: string): Promise<boolean> {
  const last = await ports.lastBrokerStepOn(claimId, step);
  return !last || (step === 'alert' && Date.parse(last) < Date.parse(heard));
}

/**
 * One client's morning reminders: one message per open claim that still needs something, and the broker's Follow-ups,
 * as the rules at the top of this file say. Returns the conversation state to keep (see above), what happened per claim,
 * and the last text sent (the host keeps it as Tina's last message, so the reply is read against it).
 */
export async function remindTurn(
  ports: ReminderPorts, conv: Conversation, state: ResumeState, contactId: string, now: Date, settings: ReminderSettings = {},
): Promise<{ state: ResumeState; outcomes: ReminderOutcome[]; lastSent?: string }> {
  const at = now.toISOString();
  const open = (await ports.openClaimsForClient(contactId)).filter((c) => isOpenClaim(c.status));
  const heard = open.map((c) => c.lastClientMessageOn).filter((d): d is string => !!d).sort().at(-1);
  // Tina asked "which claim?" or "is this a new claim?" and is waiting: a reminder now would cross it.
  const when = state.pending ? { ok: false as const, skipped: 'question-open' as const } : reminderWindow(heard, now, settings);
  const step = brokerStep(heard, now, settings);
  if (!when.ok && !step) return { state, outcomes: open.map((c) => ({ reference: c.reference, skipped: when.skipped })) };

  const firstName = when.ok ? (await ports.contactByWhatsApp(conv.phone))?.firstName ?? 'there' : 'there';
  const outcomes: ReminderOutcome[] = [];
  const reminded: Array<{ ctx: Parameters<typeof resumeMissing>[0]; missing: ReturnType<typeof resumeMissing> }> = [];
  let lastSent: string | undefined;
  for (const o of open) {
    const due = step && (await brokerDue(ports, o.id, step, heard!)) ? step : undefined;
    if (!when.ok && !due) { outcomes.push({ reference: o.reference, skipped: when.skipped }); continue; }
    const claim = await ports.loadClaim(o.id);
    const form: StoredClaimForm = claim.claimFormId
      ? await ports.claimForm(claim.claimFormId)
      : (await ports.activeClaimForm(claim.providerId, claim.claimType)) ?? (await ports.genericClaimForm());
    const ctx = { claim, form, now, warningDays: settings.notificationWarningDays ?? CLAIM_SETTINGS_DEFAULTS.notificationWarningDays };
    const missing = resumeMissing(ctx);
    if (!missing.length) { outcomes.push({ reference: o.reference, skipped: 'nothing-needed' }); continue; }
    const lines = stillNeedLines(missing, claim.answers);

    if (due) {
      const wording = BROKER_STEPS[due];
      await ports.createAgentAction({
        kind: 'Follow-up', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claim.id }, contactId: claim.contactId, at,
        detail: wording.render({
          reference: claim.reference, days: Math.floor((now.getTime() - Date.parse(heard!)) / DAY), lines,
          stopAfterDays: settings.stopAfterDays ?? REMINDER_SETTINGS_DEFAULTS.stopAfterDays,
        }),
        template: { name: wording.name, version: wording.version },
      });
    }
    const broker = due ? { broker: due } : {};
    if (!when.ok) { outcomes.push({ reference: o.reference, skipped: when.skipped, ...broker }); continue; }
    const last = await ports.lastReminderOn(o.id);
    if (last && sastDate(last) === sastDate(at)) { outcomes.push({ reference: o.reference, skipped: 'reminded-today', ...broker }); continue; }

    const label = `${claim.claimType.toLowerCase()} claim (${claim.reference})`;
    const text = REMINDER_TEMPLATE.render({ firstName, claim: label, lines, questionsLeft: missing.some((i) => !chased(i)) });
    await ports.send(conv.phone, {
      kind: 'template', name: REMINDER_TEMPLATE.name, version: REMINDER_TEMPLATE.version, text,
      ...(when.window ? {} : { params: [firstName, label, list(missingNames(missing))] }),
    });
    await ports.createAgentAction({
      kind: 'Created', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claim.id },
      contactId: claim.contactId, at, detail: `Morning reminder sent on WhatsApp for claim ${claim.reference}: ${lines.join('; ')}.`,
      template: { name: REMINDER_TEMPLATE.name, version: REMINDER_TEMPLATE.version, text },
    });
    outcomes.push({ reference: o.reference, sent: when.window ? 'text' : 'template', lines, ...broker });
    reminded.push({ ctx, missing });
    lastSent = text;
  }

  // One claim reminded, and all its questions asked: the conversation goes back on its list.
  const only = reminded.length === 1 ? reminded[0] : undefined;
  if (only && only.missing.every(chased)) {
    const followOn = stillNeedState({ now }, resumeFollowOn(only.ctx, true), only.missing);
    return { state: { followOn, pending: null }, outcomes, lastSent };
  }
  return { state, outcomes, lastSent };
}
