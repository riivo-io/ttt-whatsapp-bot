// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/resume-dataverse.ts (commit b56d936). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5184: resume.ts's ports against Dataverse. The 5168 claim ports and the 5176 follow-on ports as they are, plus
// openClaimsForClient: the one reading of "open" (OPEN_CLAIM_STATUSES) that TTTFG-5188 reuses for email. Like the other
// two files, the host passes its Dataverse call, its WhatsApp send and where files go; nothing here imports Tina or the
// email agent.
import { dataverseClaimPorts } from './dataverse';
import { CLAIM_STATUSES, CLAIM_TYPE_VALUES, dataverseFollowOnPorts, type FollowOnDataverseOptions } from './followon-dataverse';
import { BROKER_STEPS, type ReminderPorts } from './reminder';
import { NOT_THEIRS, OPEN_CLAIM_STATUSES, THEIRS, type OpenClaim, type OpenClaimsPort, type ResumePorts } from './resume';
import { REMINDER_TEMPLATE } from './templates';

const OPT = 463630000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OpenClaimRow {
  riivo_claimid: string;
  riivo_name: string;
  riivo_claimtype: number | null;
  riivo_claimstatus: number;
  riivo_incidentdate: string | null;
  riivo_lastclientmessageon: string | null;
}

/** The OData filter for an open claim status: riivo_claimstatus is one of OPEN_CLAIM_STATUSES. */
export const OPEN_STATUS_FILTER = `(${OPEN_CLAIM_STATUSES.map((s) => `riivo_claimstatus eq ${OPT + CLAIM_STATUSES.indexOf(s)}`).join(' or ')})`;

export function openClaimsPort(dv: FollowOnDataverseOptions['dv']): OpenClaimsPort {
  return {
    async openClaimsForClient(contactId): Promise<OpenClaim[]> {
      if (!GUID.test(contactId)) throw new Error(`Not a Dataverse id: ${contactId}`);
      const r = await dv<{ value: OpenClaimRow[] }>('GET',
        'riivo_claims?$select=riivo_claimid,riivo_name,riivo_claimtype,riivo_claimstatus,riivo_incidentdate,riivo_lastclientmessageon'
        + `&$filter=_riivo_contact_value eq ${contactId} and statecode eq 0 and ${OPEN_STATUS_FILTER}&$orderby=riivo_incidentdate asc`);
      const disputed = await disputedClaims(dv, r.value.map((c) => c.riivo_claimid));
      return r.value.map((c) => ({
        id: c.riivo_claimid,
        reference: c.riivo_name,
        claimType: c.riivo_claimtype == null ? 'Other' : CLAIM_TYPE_VALUES[c.riivo_claimtype] ?? 'Other',
        // A claim with no incident date sorts by when it was reported; resume.ts only uses the date to name the claim.
        incidentAt: c.riivo_incidentdate ?? new Date(0).toISOString(),
        status: CLAIM_STATUSES[c.riivo_claimstatus - OPT],
        lastClientMessageOn: c.riivo_lastclientmessageon ?? undefined,
        ...(disputed.has(c.riivo_claimid) ? { disputed: true as const } : {}),
      }));
    },
  };
}

/** riivo_agentaction.riivo_status: Discarded and Done close a Follow-up. */
const ACTION_CLOSED = [463630004, 463630006];

/**
 * TTTFG-4830: the claims the client said aren't theirs, and that are still held: the latest of their NOT_THEIRS and
 * THEIRS agent actions is NOT_THEIRS, and the broker hasn't closed it (Done or Discarded). One read for all of them.
 */
async function disputedClaims(dv: FollowOnDataverseOptions['dv'], claimIds: readonly string[]): Promise<Set<string>> {
  const ids = claimIds.filter((id) => GUID.test(id));
  if (!ids.length) return new Set();
  const names = [NOT_THEIRS.name, THEIRS.name].map((n) => `startswith(riivo_subject,'${encodeURIComponent(n)}')`).join(' or ');
  const about = ids.map((id) => `riivo_sourcemessageid eq 'riivo_claim:${id}'`).join(' or ');
  const r = await dv<{ value: { createdon: string; riivo_subject: string | null; riivo_status: number | null; riivo_sourcemessageid: string | null }[] }>('GET',
    `riivo_agentactions?$select=createdon,riivo_subject,riivo_status,riivo_sourcemessageid&$orderby=createdon desc&$filter=(${names}) and (${about})`);
  const out = new Set<string>();
  const seen = new Set<string>();
  for (const a of r.value ?? []) {
    const id = a.riivo_sourcemessageid?.replace(/^riivo_claim:/, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (a.riivo_subject?.startsWith(NOT_THEIRS.name) && !ACTION_CLOSED.includes(a.riivo_status ?? -1)) out.add(id);
  }
  return out;
}

/** Everything resumeTurn() needs, on Dataverse. */
export function dataverseResumePorts(o: FollowOnDataverseOptions): ResumePorts {
  return {
    ...dataverseClaimPorts({ dv: o.dv, send: o.send, insuranceTeamId: o.insuranceTeamId }),
    ...dataverseFollowOnPorts(o),
    ...openClaimsPort(o.dv),
  };
}

/**
 * TTTFG-5212: when the claim's last morning reminder went out (its Created agent action), and when its last broker
 * Follow-up of a step was written. Found by the wording's name in riivo_subject, and by the claim until TTTFG-4853's
 * Regarding lookup, as the duty of disclosure's.
 */
export function lastReminderPort(dv: FollowOnDataverseOptions['dv']): Pick<ReminderPorts, 'lastReminderOn' | 'lastBrokerStepOn'> {
  const lastNamed = async (claimId: string, name: string) => {
    if (!GUID.test(claimId)) throw new Error(`Not a Dataverse id: ${claimId}`);
    const r = await dv<{ value: { createdon: string }[] }>('GET', 'riivo_agentactions?$select=createdon&$top=1&$orderby=createdon desc&$filter='
      + `riivo_sourcemessageid eq 'riivo_claim:${claimId}' and startswith(riivo_subject,'${encodeURIComponent(name)}')`);
    return r.value[0]?.createdon ?? null;
  };
  return {
    lastReminderOn: (claimId) => lastNamed(claimId, REMINDER_TEMPLATE.name),
    lastBrokerStepOn: (claimId, step) => lastNamed(claimId, BROKER_STEPS[step].name),
  };
}

/** Everything remindTurn() needs, on Dataverse. */
export function dataverseReminderPorts(o: FollowOnDataverseOptions): ReminderPorts {
  return { ...dataverseResumePorts(o), ...lastReminderPort(o.dv) };
}
