// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/flags.ts (commit ae6ec03). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5263: staff-only risk flags on a claim (SPEC-04 "Cover check and risk flags"). A flag is a warning for the broker,
// never a finding about the client: Tina never sees one, no message mentions one, and no flag changes the claim's status,
// holds a reminder or blocks the pack. TTTFG-5200 shows the open flags beside the pack; that is the only place they meet
// submission.
//
// Every rule is a fixed comparison of dates in code. Claude plays no part in deciding a flag (the subtask's "one wrong
// turn": a model asked whether a claim looks suspicious makes a judgement about the client, which the TTT claims guide
// forbids and POPIA section 71 restricts, and answers differently each run). Claude only reads dates off documents,
// through the document pipeline, before anything here runs.
//
// Where a flag lives (agreed with TTTFG-5200, 28 Oct 2026): one riivo_claimflag row per rule and source document
// (TTTFG-4885 step 7), open while riivo_outcome is blank. Late notification also sets riivo_claim.riivo_latenotification.
// The same rule firing again for the same document writes nothing.
//
// When: raiseClaimFlags runs at claim open, at the walkthrough end and when a document is linked to the claim. Every
// call checks every dated document on the claim, so a date the pipeline reads after the file arrived is caught on the
// next call. The Dataverse side is flags-dataverse.ts.
import { DEPARTMENT, type AgentActionRow, type Owner } from './claim';
import { nextWorkingDay } from './dataverse';
import { notificationDeadline } from './followon';
import type { ClaimType } from './walkthrough';

/** riivo_claimflag.riivo_flagtype, less Other (a person's choice, never the agent's). */
export type FlagType =
  | 'Late notification' | 'SAPS case missing' | 'Policy not active' | 'Date mismatch' | 'Licence expired' | 'Photo date before incident';

/** The moment a check runs. Late notification and Policy not active are checked at open, SAPS case missing at the end. */
export type FlagTrigger = 'open' | 'walkthrough-end' | 'document';

/** The claim's policy on the day the check runs. Dates are yyyy-mm-dd; Go4Broker's empty date (1753-01-01) is absent. */
export interface FlagPolicy {
  number: string;
  /** riivo_policy_status is Active. */
  active: boolean;
  /** The status label, for the reason. */
  status?: string;
  inception?: string;
  cancelled?: string;
}

/** What the rules read from the claim. */
export interface FlagClaim {
  id: string;
  reference: string;
  contactId?: string;
  owner: Owner;
  claimType: ClaimType;
  incidentAt: string;
  /** riivo_reportedon: when the claim was opened. */
  reportedOn: string;
  /** The claim form's notification period; absent when the claim has no form yet. */
  notificationPeriodDays?: number;
  /** The claim form needs a SAPS case number, or the claim was described as a theft (riivo_sapsrequired). */
  sapsRequired: boolean;
  sapsCaseNumber?: string;
  policy?: FlagPolicy | null;
}

/**
 * A document on the claim, as the rules need it. `date` is the slip's date (the day the case was reported) or a photo's
 * capture date; `expiry` is a licence's valid-to date. Both yyyy-mm-dd, absent when nothing read them.
 */
export interface FlagDocument {
  id: string;
  name: string;
  kind: 'saps-slip' | 'licence' | 'photo' | 'other';
  date?: string;
  expiry?: string;
}

/** A flag to write: the reason in plain words, and the document that caused it. */
export interface FlagDraft { type: FlagType; detail: string; documentId?: string }

/** An agent action row, plus the Follow-up's own due date and urgency reason (the claim.ts row has neither). */
export type FlagActionRow = AgentActionRow & { dueOn?: string; urgencyReason?: string };

export interface FlagPorts {
  loadFlagClaim(claimId: string): Promise<FlagClaim>;
  claimDocuments(claimId: string): Promise<FlagDocument[]>;
  /** The claim's flags, open or reviewed: a reviewed flag is not raised again either. */
  existingFlags(claimId: string): Promise<{ type: FlagType; documentId?: string }[]>;
  /** One riivo_claimflag row, owned by the claim's owner. */
  createFlag(claim: FlagClaim, flag: FlagDraft, at: string): Promise<{ id: string }>;
  /** riivo_claim.riivo_latenotification = Yes. */
  setLateNotification(claimId: string): Promise<void>;
  createAgentAction(row: FlagActionRow): Promise<{ id: string }>;
}

/** Evidence items that photograph the incident or its aftermath. A licence, an ID or proof of ownership is naturally older. */
export const INCIDENT_PHOTO_ITEMS: ReadonlySet<string> = new Set(['damagePhotos', 'scenePhotos', 'vehiclePhotos', 'thirdPartyPhotos', 'forcedEntryProof']);
/** riivo_documenttype names the pipeline files these under (TTTFG-5263 step 2). */
export const SAPS_SLIP_TYPE = 'SAPS case slip';
export const LICENCE_TYPE = "Driver's licence";

/** What a document on the claim is, from its document type or, for a file Tina received, the evidence item it answers. */
export function documentKind(d: { typeName?: string | null; itemKey?: string | null; image: boolean }): FlagDocument['kind'] {
  if (d.typeName === SAPS_SLIP_TYPE) return 'saps-slip';
  if (d.typeName === LICENCE_TYPE || d.itemKey === 'driversLicence') return 'licence';
  if (d.image && d.itemKey && INCIDENT_PHOTO_ITEMS.has(d.itemKey)) return 'photo';
  return 'other';
}

/** The calendar date in South Africa, yyyy-mm-dd. */
const sastDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "3 Nov 2026", from yyyy-mm-dd. Fixed month names: ICU versions differ on "Sep" and "Sept". */
const said = (isoDate: string) => {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

/** The rules. Pure: the same claim, documents and triggers always give the same flags. */
export function claimFlags(claim: FlagClaim, documents: readonly FlagDocument[], triggers: readonly FlagTrigger[]): FlagDraft[] {
  const out: FlagDraft[] = [];
  const incident = sastDay(claim.incidentAt);
  const on = (t: FlagTrigger) => triggers.includes(t);

  // AC 1: the deadline is the incident date plus the form's period; a report after the deadline day is late (the same
  // count as the client's deadline note, TTTFG-5254 step 5).
  if (on('open') && claim.notificationPeriodDays != null) {
    const late = notificationDeadline(claim.incidentAt, claim.notificationPeriodDays, new Date(claim.reportedOn), 0);
    if (late?.variant === 'passed') {
      out.push({ type: 'Late notification', detail: `Reported on ${said(sastDay(claim.reportedOn))}, ${-late.daysLeft + claim.notificationPeriodDays} days `
        + `after the incident on ${said(incident)}. The claim form allows ${claim.notificationPeriodDays} days.` });
    }
  }

  // AC 2.
  if (on('walkthrough-end') && claim.sapsRequired && !claim.sapsCaseNumber?.trim()) {
    out.push({ type: 'SAPS case missing', detail: `No SAPS case number when Tina finished her questions. The claim form needs one for a ${claim.claimType} claim.` });
  }

  // AC 3. At open only: a later status change (a policy cancelled after the claim) is not a cover gap on the incident date,
  // and Go4Broker gives most cancelled policies no cancellation date to tell the two apart.
  const p = claim.policy;
  if (on('open') && p) {
    const why = p.inception && p.inception > incident ? `started on ${said(p.inception)}, after the incident on ${said(incident)}.`
      : p.cancelled && p.cancelled <= incident ? `was cancelled on ${said(p.cancelled)}, on or before the incident on ${said(incident)}.`
      : !p.active && !(p.cancelled && p.cancelled > incident)
        ? `has the status ${p.status ?? 'not active'}, and no cancellation date after the incident on ${said(incident)} is on file.`
      : null;
    if (why) out.push({ type: 'Policy not active', detail: `Policy ${p.number} ${why}` });
  }

  // AC 4 to 6: every dated document on the claim, whatever triggered the check.
  for (const d of documents) {
    if (d.kind === 'saps-slip' && d.date && d.date < incident) {
      out.push({ type: 'Date mismatch', documentId: d.id, detail: `SAPS case slip ${d.name} is dated ${said(d.date)}; the incident was on ${said(incident)}.` });
    } else if (d.kind === 'licence' && d.expiry && d.expiry < incident) {
      out.push({ type: 'Licence expired', documentId: d.id, detail: `Driver's licence ${d.name} expired on ${said(d.expiry)}; the incident was on ${said(incident)}.` });
    } else if (d.kind === 'photo' && d.date && d.date < incident) {
      // AC 6: a photo with no capture date (a WhatsApp picture, which drops it) gives no flag.
      out.push({ type: 'Photo date before incident', documentId: d.id, detail: `Photo ${d.name} was taken on ${said(d.date)} (the camera's date); the incident was on ${said(incident)}.` });
    }
  }
  return out;
}

/** 17:00 SAST today when today is a working day and it is not yet 17:00; otherwise 17:00 on the next working day. */
export function dueToday(at: string): string {
  const t = Date.parse(at);
  const day = sastDay(at);
  const close = Date.parse(`${day}T17:00:00+02:00`);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && t < close ? new Date(close).toISOString() : nextWorkingDay(at);
}

/**
 * Raise the claim's new flags and record each. Returns the flags written. Nothing here reaches the client: the caller
 * uses the result for its log only. The agent action rows say that a flag was raised, never its reason (agent actions
 * are read more widely than flags; the reason stays on the flag, which only the insurance roles read).
 */
export async function raiseClaimFlags(ports: FlagPorts, input: { claimId: string; triggers: readonly FlagTrigger[]; at: string }): Promise<FlagDraft[]> {
  if (!input.triggers.length) return [];
  const claim = await ports.loadFlagClaim(input.claimId);
  const drafts = claimFlags(claim, await ports.claimDocuments(input.claimId), input.triggers);
  if (!drafts.length) return [];
  const existing = await ports.existingFlags(input.claimId);
  const key = (f: { type: FlagType; documentId?: string }) => `${f.type}|${f.documentId ?? ''}`;
  const seen = new Set(existing.map(key));
  const fresh = drafts.filter((d) => !seen.has(key(d)) && seen.add(key(d)));

  const row: Omit<AgentActionRow, 'kind' | 'detail'> = {
    department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claim.id }, contactId: claim.contactId, at: input.at,
  };
  for (const flag of fresh) {
    await ports.createFlag(claim, flag, input.at);
    // AC 10.
    await ports.createAgentAction({ ...row, kind: 'Created', detail: `Risk flag raised on claim ${claim.reference}. Staff only: see the claim's flags.` });
    if (flag.type === 'Late notification') {
      // AC 1: the broker hears today, while there is still time to ask the client about the timing.
      await ports.setLateNotification(claim.id);
      await ports.createAgentAction({
        ...row, kind: 'Follow-up', dueOn: dueToday(input.at), urgencyReason: 'Claim reported after the notification period',
        detail: `Claim ${claim.reference} was reported after the insurer's notification period. Check the claim's flags and ask the client about the timing.`,
      });
    }
  }
  return fresh;
}
