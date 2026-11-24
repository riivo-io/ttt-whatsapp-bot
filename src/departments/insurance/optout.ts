// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/optout.ts (commit 4adb044). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// The user (18 Nov 2026): a client can opt out of Tina's morning reminders (reminder.ts). Two ways in, one effect:
// - on WhatsApp they reply "stop" (asksToStopReminders), which Tina's host checks before it reads the reply as anything
//   else; the reply stops the reminders on every open claim of theirs (stopReminders);
// - on the claim form's page, which both the WhatsApp and the email reminders link to, "Stop reminders" stops them on that
//   claim (stopRemindersFor).
// What it does: the claim's answers get REMINDERS_OFF_KEY, which the reminder reads (OpenClaim.remindersOff), so no more
// WhatsApp or email reminder goes for it. Nothing else changes: the broker's day-5 alert and the stop-day call still
// come (nobody else is chasing the client now), the form's link still works, and a Follow-up tells the claim's owner the
// client asked, with what is still needed. A claim the client opens later is reminded as usual: this is about that claim.
import { DEPARTMENT, type Owner } from './claim';
import type { ClaimAnswers } from './contracts';
import { claimMissing, stillNeedLines, type FollowOnClaim, type FollowOnPorts } from './followon';
import { isOpenClaim, type OpenClaimsPort } from './resume';

/** riivo_claim.riivo_answers: the client asked for no more reminders on this claim. */
export const REMINDERS_OFF_KEY = 'remindersOff';

/** Whether the claim's answers say the client opted out of reminders. */
export const remindersOff = (answers: ClaimAnswers | undefined): boolean => answers?.[REMINDERS_OFF_KEY]?.status === 'answered' && answers[REMINDERS_OFF_KEY].value === true;

/** What the client is told, on WhatsApp and on the form's page. */
export const REMINDERS_STOPPED = "No problem, I won't send you any more reminders. The link I sent you still works if you want to add anything, and your TTT consultant may be in touch about your claim.";

/** The owner's Follow-up, found again by its name so it is written once per claim. */
export const REMINDERS_OFF_FOLLOW_UP = { name: 'Claim - client stopped the reminders', version: 'draft-1' } as const;

const BARE = /^\s*(?:please\s+)?(?:stop|unsubscribe|opt[\s-]*out|stop\s+please|stop\s+it)\s*(?:please|pls|thanks?|thank\s+you)?\s*[.!]*\s*$/i;
const WHEN_ASKED: readonly RegExp[] = [
  // "stop the reminders", "please stop these messages", "turn off the reminders", "cancel reminders"
  /\b(?:stop|end|cancel|turn\s+off|switch\s+off|pause|no\s+more)\b.{0,25}\b(?:reminders?|reminding|notifications?)\b/i,
  // "stop reminding me", "stop messaging me", "stop sending me messages", "stop sending reminders"
  /\b(?:stop|quit)\b.{0,12}\b(?:remind|messag|text|whatsapp|bother|send)\w*\b.{0,20}\b(?:me|us|reminders?|messages?)\b/i,
  /\bno\s+more\s+(?:messages?|texts?|whatsapps?)\b/i,
  /\b(?:don'?t|do\s+not)\s+(?:want|need)\b.{0,20}\b(?:reminders?|these\s+messages?)\b/i,
  /\b(?:don'?t|do\s+not)\s+(?:send|message|text|remind)\s+me\b/i,
  /\b(?:unsubscribe|opt\s*(?:me\s*)?out)\b/i,
];

/**
 * The client's message asks Tina to stop reminding them. Plain words, not a model call, so "STOP" always works, and a
 * miss only means the reply is read as any other. The host calls it where the client isn't in the middle of reporting
 * a claim (the walkthrough has its own "stop here").
 */
export const asksToStopReminders = (text: string): boolean => BARE.test(text) || WHEN_ASKED.some((re) => re.test(text));

type StopPorts = Pick<FollowOnPorts, 'loadClaim' | 'saveAnswers' | 'createAgentAction' | 'claimForm' | 'activeClaimForm' | 'genericClaimForm'>;

/** What the owner is told is still needed, or nothing when the form can't be read. Never fails the opt-out. */
async function stillNeeded(ports: StopPorts, claim: FollowOnClaim): Promise<string[]> {
  try {
    const form = claim.claimFormId ? await ports.claimForm(claim.claimFormId) : (await ports.activeClaimForm(claim.providerId, claim.claimType)) ?? (await ports.genericClaimForm());
    return stillNeedLines(claimMissing(form, claim), claim.answers);
  } catch {
    return [];
  }
}

/** Sets the opt-out on one claim and tells its owner. A claim already opted out is left alone (nothing is written twice). */
export async function stopRemindersFor(ports: StopPorts, claimId: string, now: Date): Promise<'stopped' | 'already'> {
  const claim = await ports.loadClaim(claimId);
  if (remindersOff(claim.answers)) return 'already';
  const at = now.toISOString();
  await ports.saveAnswers(claim.id, { ...claim.answers, [REMINDERS_OFF_KEY]: { value: true, status: 'answered', at } });
  const still = await stillNeeded(ports, claim);
  const owner: Owner = claim.owner;
  await ports.createAgentAction({
    kind: 'Follow-up', department: DEPARTMENT, owner, regarding: { table: 'riivo_claim', id: claim.id }, contactId: claim.contactId, at,
    detail: `Claim ${claim.reference}: the client asked to stop the morning reminders, so Tina and the email agent will send no more for this claim. `
      + (still.length ? `Still needed from them: ${still.join('; ')}. ` : '')
      + 'You will still get the day-5 alert and the phone call step, so please contact them yourself if the claim needs something.',
    template: { name: REMINDERS_OFF_FOLLOW_UP.name, version: REMINDERS_OFF_FOLLOW_UP.version },
  });
  return 'stopped';
}

/** The client's open claims, all of which stop being reminded (they said "stop", not "stop for this claim"). */
export async function stopReminders(ports: StopPorts & OpenClaimsPort, contactId: string, now: Date): Promise<{ stopped: string[] }> {
  const open = (await ports.openClaimsForClient(contactId)).filter((c) => isOpenClaim(c.status));
  const stopped: string[] = [];
  for (const c of open) if ((await stopRemindersFor(ports, c.id, now)) === 'stopped') stopped.push(c.reference);
  return { stopped };
}
