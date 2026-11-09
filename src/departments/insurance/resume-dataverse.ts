// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/resume-dataverse.ts (commit 297301a). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5184: resume.ts's ports against Dataverse. The 5168 claim ports and the 5176 follow-on ports as they are, plus
// openClaimsForClient: the one reading of "open" (OPEN_CLAIM_STATUSES) that TTTFG-5188 reuses for email. Like the other
// two files, the host passes its Dataverse call, its WhatsApp send and where files go; nothing here imports Tina or the
// email agent.
import { dataverseClaimPorts } from './dataverse';
import { CLAIM_STATUSES, CLAIM_TYPE_VALUES, dataverseFollowOnPorts, type FollowOnDataverseOptions } from './followon-dataverse';
import { BROKER_STEPS, REMINDED_STATUSES, REMINDER_SETTING_VARIABLES, type ReminderPorts, type ReminderSettings } from './reminder';
import { CANCEL_REQUEST, CANCEL_WITHDRAWN, NOT_THEIRS, OPEN_CLAIM_STATUSES, THEIRS, type OpenClaim, type OpenClaimsPort, type ResumePorts } from './resume';
import { REMINDER_EMAIL_TEMPLATE, REMINDER_TEMPLATE } from './templates';

const OPT = 463630000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OpenClaimRow {
  riivo_claimid: string;
  riivo_name: string;
  riivo_claimtype: number | null;
  riivo_claimstatus: number;
  riivo_incidentdate: string | null;
  createdon: string;
  riivo_lastclientmessageon: string | null;
  riivo_channel?: number | null;
  _riivo_policy_value?: string | null;
  riivo_description?: string | null;
}

/** riivo_claim.riivo_channel. */
const CLAIM_CHANNEL_EMAIL = 463630000;

/** The OData filter for an open claim status: riivo_claimstatus is one of OPEN_CLAIM_STATUSES. */
export const OPEN_STATUS_FILTER = `(${OPEN_CLAIM_STATUSES.map((s) => `riivo_claimstatus eq ${OPT + CLAIM_STATUSES.indexOf(s)}`).join(' or ')})`;

export function openClaimsPort(dv: FollowOnDataverseOptions['dv']): OpenClaimsPort {
  return {
    async openClaimsForClient(contactId): Promise<OpenClaim[]> {
      if (!GUID.test(contactId)) throw new Error(`Not a Dataverse id: ${contactId}`);
      const r = await dv<{ value: OpenClaimRow[] }>('GET',
        'riivo_claims?$select=riivo_claimid,riivo_name,riivo_claimtype,riivo_claimstatus,riivo_incidentdate,createdon,riivo_lastclientmessageon,riivo_channel,_riivo_policy_value,riivo_description'
        + `&$filter=_riivo_contact_value eq ${contactId} and statecode eq 0 and ${OPEN_STATUS_FILTER}&$orderby=riivo_incidentdate asc`);
      const disputed = await disputedClaims(dv, r.value.map((c) => c.riivo_claimid));
      return r.value.map((c) => ({
        id: c.riivo_claimid,
        reference: c.riivo_name,
        claimType: c.riivo_claimtype == null ? 'Other' : CLAIM_TYPE_VALUES[c.riivo_claimtype] ?? 'Other',
        // A claim with no incident date yet (TTTFG-5562: its form isn't back) goes by when it was opened; resume.ts only uses the date to name the claim.
        incidentAt: c.riivo_incidentdate ?? c.createdon,
        status: CLAIM_STATUSES[c.riivo_claimstatus - OPT],
        lastClientMessageOn: c.riivo_lastclientmessageon ?? undefined,
        ...(c.riivo_channel === CLAIM_CHANNEL_EMAIL ? { channel: 'Email' as const } : {}),
        ...(c._riivo_policy_value ? { policyId: c._riivo_policy_value } : {}),
        ...(c.riivo_description ? { description: c.riivo_description } : {}),
        ...(c.riivo_incidentdate ? {} : { noIncidentDate: true as const }),
        ...(disputed.has(c.riivo_claimid) ? { disputed: true as const } : {}),
        ...(disputed.get(c.riivo_claimid) === 'cancel' ? { cancelling: true as const } : {}),
      }));
    },
  };
}

/** riivo_agentaction.riivo_status: Discarded and Done close a Follow-up. */
const ACTION_CLOSED = [463630004, 463630006];

/**
 * TTTFG-4830: the claims the client said aren't theirs (or, 28 Oct 2026, asked to cancel), and that are still held: the
 * latest of their NOT_THEIRS, CANCEL_REQUEST, THEIRS and (29 Oct 2026) CANCEL_WITHDRAWN agent actions is one of the
 * first two, and the broker hasn't closed it (Done or Discarded). One read for all of them. Each held claim comes back
 * with what holds it: 'cancel' for a CANCEL_REQUEST.
 */
async function disputedClaims(dv: FollowOnDataverseOptions['dv'], claimIds: readonly string[]): Promise<Map<string, 'not-theirs' | 'cancel'>> {
  const ids = claimIds.filter((id) => GUID.test(id));
  if (!ids.length) return new Map();
  const names = [NOT_THEIRS.name, CANCEL_REQUEST.name, THEIRS.name, CANCEL_WITHDRAWN.name].map((n) => `startswith(riivo_subject,'${encodeURIComponent(n)}')`).join(' or ');
  const about = ids.map((id) => `riivo_sourcemessageid eq 'riivo_claim:${id}'`).join(' or ');
  const r = await dv<{ value: { createdon: string; riivo_subject: string | null; riivo_status: number | null; riivo_sourcemessageid: string | null }[] }>('GET',
    `riivo_agentactions?$select=createdon,riivo_subject,riivo_status,riivo_sourcemessageid&$orderby=createdon desc&$filter=(${names}) and (${about})`);
  const out = new Map<string, 'not-theirs' | 'cancel'>();
  const seen = new Set<string>();
  for (const a of r.value ?? []) {
    const id = a.riivo_sourcemessageid?.replace(/^riivo_claim:/, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const holds = a.riivo_subject?.startsWith(NOT_THEIRS.name) ? 'not-theirs' : a.riivo_subject?.startsWith(CANCEL_REQUEST.name) ? 'cancel' : undefined;
    if (holds && !ACTION_CLOSED.includes(a.riivo_status ?? -1)) out.set(id, holds);
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
  const lastNamed = async (claimId: string, ...names: string[]) => {
    if (!GUID.test(claimId)) throw new Error(`Not a Dataverse id: ${claimId}`);
    const named = names.map((n) => `startswith(riivo_subject,'${encodeURIComponent(n)}')`).join(' or ');
    const r = await dv<{ value: { createdon: string }[] }>('GET', 'riivo_agentactions?$select=createdon&$top=1&$orderby=createdon desc&$filter='
      + `riivo_sourcemessageid eq 'riivo_claim:${claimId}' and (${named})`);
    return r.value[0]?.createdon ?? null;
  };
  return {
    lastReminderOn: (claimId) => lastNamed(claimId, REMINDER_TEMPLATE.name, REMINDER_EMAIL_TEMPLATE.name),
    lastBrokerStepOn: (claimId, step) => lastNamed(claimId, BROKER_STEPS[step].name),
  };
}

interface EnvironmentVariableRow {
  schemaname: string;
  defaultvalue: string | null;
  environmentvariabledefinition_environmentvariablevalue?: { value: string | null }[];
}

/**
 * TTTFG-5212 AC 6: the broker alert day and the stop day as TTT sets them, in the Dataverse environment variables
 * REMINDER_SETTING_VARIABLES: the current value, else the default value. One that is missing, or not a number above 0,
 * is left out, so the code's default applies.
 */
export async function reminderSettingsFromDataverse(dv: FollowOnDataverseOptions['dv']): Promise<Pick<ReminderSettings, 'brokerAlertDays' | 'stopAfterDays'>> {
  const vars = Object.entries(REMINDER_SETTING_VARIABLES) as Array<[keyof typeof REMINDER_SETTING_VARIABLES, string]>;
  const r = await dv<{ value: EnvironmentVariableRow[] }>('GET', 'environmentvariabledefinitions?$select=schemaname,defaultvalue'
    + '&$expand=environmentvariabledefinition_environmentvariablevalue($select=value)'
    + `&$filter=${vars.map(([, name]) => `schemaname eq '${name}'`).join(' or ')}`);
  const out: Pick<ReminderSettings, 'brokerAlertDays' | 'stopAfterDays'> = {};
  for (const [setting, name] of vars) {
    const row = r.value.find((v) => v.schemaname.toLowerCase() === name.toLowerCase());
    const raw = row?.environmentvariabledefinition_environmentvariablevalue?.[0]?.value ?? row?.defaultvalue;
    const days = Number(raw?.trim() || NaN);
    if (days > 0) out[setting] = days;
  }
  return out;
}

/** TTTFG-5212 AC 2: the clients with an email claim at a reminded status, each once. */
export async function emailClaimClients(dv: FollowOnDataverseOptions['dv']): Promise<string[]> {
  const statuses = REMINDED_STATUSES.map((s) => `riivo_claimstatus eq ${OPT + CLAIM_STATUSES.indexOf(s)}`).join(' or ');
  const r = await dv<{ value: { _riivo_contact_value: string | null }[] }>('GET',
    `riivo_claims?$select=_riivo_contact_value&$filter=statecode eq 0 and riivo_channel eq ${CLAIM_CHANNEL_EMAIL} and (${statuses})`);
  return [...new Set(r.value.map((c) => c._riivo_contact_value).filter((id): id is string => !!id))];
}

/** Everything remindTurn() needs, on Dataverse. */
export function dataverseReminderPorts(o: FollowOnDataverseOptions): ReminderPorts {
  return { ...dataverseResumePorts(o), ...lastReminderPort(o.dv) };
}
