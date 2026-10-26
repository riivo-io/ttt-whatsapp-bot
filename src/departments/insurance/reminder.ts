// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/reminder.ts (commit 240b9bb). Do not edit here:
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
//   the claim to the broker as a call to make (that follow-up isn't built yet; TTTFG-5289 may move the day);
// - the claim wasn't reminded already today (its Created agent action), so a second run the same day sends nothing;
// - WhatsApp allows it: a client who last wrote more than 24 hours ago can only be sent an approved template. With
//   `template: true` (the host has one) the reminder goes as REMINDER_TEMPLATE's WhatsApp body, the list in one line,
//   because a template variable can't hold line breaks. Without it the claim is passed over.
// Not built from 5212 yet: the day-5 broker alert, the day-10 broker follow-up, email claims reminded by email.
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
  /** No reminder when the client's last message is this many days old or more. */
  stopAfterDays?: number;
  /** The host can send REMINDER_TEMPLATE as an approved WhatsApp template (outside the 24-hour window). */
  template?: boolean;
}
export const REMINDER_SETTINGS_DEFAULTS = { quietHours: 12, stopAfterDays: 10 } as const;

export interface ReminderPorts extends ResumePorts {
  /** When the claim's last morning reminder went out (its Created agent action), or null. */
  lastReminderOn(claimId: string): Promise<string | null>;
}

export type ReminderSkip =
  | 'nothing-needed' | 'wrote-recently' | 'quiet-too-long' | 'no-message-yet' | 'reminded-today' | 'outside-24h' | 'question-open';
export type ReminderOutcome =
  | { reference: string; sent: 'text' | 'template'; lines: string[] }
  | { reference: string; skipped: ReminderSkip };

const HOUR = 3_600_000;
/** The calendar date in South Africa (UTC+2, no daylight saving). */
const sastDate = (iso: string) => new Date(Date.parse(iso) + 2 * HOUR).toISOString().slice(0, 10);

/**
 * Whether the client gets reminders at all this morning, from when they last wrote about an open claim. Pure. `window`:
 * inside WhatsApp's 24-hour window, so the reminder can go as a plain message.
 */
export function reminderWindow(lastHeard: string | undefined, now: Date, settings: ReminderSettings = {}):
  { ok: true; window: boolean } | { ok: false; skipped: ReminderSkip } {
  if (!lastHeard) return { ok: false, skipped: 'no-message-yet' };
  const quiet = now.getTime() - Date.parse(lastHeard);
  if (quiet < (settings.quietHours ?? REMINDER_SETTINGS_DEFAULTS.quietHours) * HOUR) return { ok: false, skipped: 'wrote-recently' };
  if (quiet >= (settings.stopAfterDays ?? REMINDER_SETTINGS_DEFAULTS.stopAfterDays) * 24 * HOUR) return { ok: false, skipped: 'quiet-too-long' };
  const window = quiet < 24 * HOUR;
  if (!window && !settings.template) return { ok: false, skipped: 'outside-24h' };
  return { ok: true, window };
}

/**
 * One client's morning reminders: one message per open claim that still needs something, as the rules at the top of
 * this file say. Returns the conversation state to keep (see above), what happened per claim, and the last text sent
 * (the host keeps it as Tina's last message, so the reply is read against it).
 */
export async function remindTurn(
  ports: ReminderPorts, conv: Conversation, state: ResumeState, contactId: string, now: Date, settings: ReminderSettings = {},
): Promise<{ state: ResumeState; outcomes: ReminderOutcome[]; lastSent?: string }> {
  const at = now.toISOString();
  const open = (await ports.openClaimsForClient(contactId)).filter((c) => isOpenClaim(c.status));
  // Tina asked "which claim?" or "is this a new claim?" and is waiting: a reminder now would cross it.
  if (state.pending) return { state, outcomes: open.map((c) => ({ reference: c.reference, skipped: 'question-open' as const })) };
  const heard = open.map((c) => c.lastClientMessageOn).filter((d): d is string => !!d).sort().at(-1);
  const when = reminderWindow(heard, now, settings);
  if (!when.ok) return { state, outcomes: open.map((c) => ({ reference: c.reference, skipped: when.skipped })) };

  const contact = await ports.contactByWhatsApp(conv.phone);
  const firstName = contact?.firstName ?? 'there';
  const outcomes: ReminderOutcome[] = [];
  const reminded: Array<{ ctx: Parameters<typeof resumeMissing>[0]; missing: ReturnType<typeof resumeMissing> }> = [];
  let lastSent: string | undefined;
  for (const o of open) {
    const claim = await ports.loadClaim(o.id);
    const form: StoredClaimForm = claim.claimFormId
      ? await ports.claimForm(claim.claimFormId)
      : (await ports.activeClaimForm(claim.providerId, claim.claimType)) ?? (await ports.genericClaimForm());
    const ctx = { claim, form, now, warningDays: settings.notificationWarningDays ?? CLAIM_SETTINGS_DEFAULTS.notificationWarningDays };
    const missing = resumeMissing(ctx);
    if (!missing.length) { outcomes.push({ reference: o.reference, skipped: 'nothing-needed' }); continue; }
    const last = await ports.lastReminderOn(o.id);
    if (last && sastDate(last) === sastDate(at)) { outcomes.push({ reference: o.reference, skipped: 'reminded-today' }); continue; }

    const lines = stillNeedLines(missing, claim.answers);
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
    outcomes.push({ reference: o.reference, sent: when.window ? 'text' : 'template', lines });
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
