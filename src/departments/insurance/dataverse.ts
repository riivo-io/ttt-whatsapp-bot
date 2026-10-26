// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/dataverse.ts (commit bf96618). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5168: ClaimPorts against Dataverse (the riivo_claim table from TTTFG-4885). The host passes in its own
// Dataverse call (`Dv`, the same signature as the email agent's adapters/dataverse.ts `dv`) and its WhatsApp send, so
// this file runs unchanged in the email agent and in Tina, and imports nothing from either.
//
// Choices are the 2Tables values, the same in every environment (read from DEV on 21 Oct 2026; Hijacking 463630006 added
// to riivo_claimtype the same day). Gaps carried here until the data model catches up:
// - riivo_agentaction has no Regarding lookup yet (TTTFG-4853 adds it). Until then the row names the claim or request
//   in riivo_sourcemessageid as "<table>:<id>", and links the client through riivo_client.
// - Due dates follow the TTTFG-4853 urgency rule (src/core/urgency.ts): 17:00 South African time on the next working
//   day, Monday to Friday, public holidays not yet skipped. Someone hurt with no assist number is Urgent, due in 2
//   working hours.
import { type AgentActionRow, type ClaimPorts, type ClaimRow, type Outbound, type PolicyOwner } from './claim';
import type { ClaimType, Policy } from './walkthrough';

/** A Dataverse Web API call. formatted: choice labels as annotations. returnRow: a POST answers with the new row. */
export type Dv = <T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, opts?: { formatted?: boolean; returnRow?: boolean }) => Promise<T>;

const CLAIM_TYPE: Record<ClaimType, number> = {
  'Motor accident': 463630000, 'Motor theft': 463630001, 'Hijacking': 463630006, 'Property loss or damage': 463630002,
  'Windscreen': 463630003, 'Portable possessions': 463630004, 'Other': 463630005,
};
const CLAIM_STATUS_FNOL_LOGGED = 463630000;
const CLAIM_CHANNEL_WHATSAPP = 463630001;
const POLICY_ACTIVE = 463630000;

const KIND = { 'Follow-up': 463630006, 'Created': 463630007 } as const;
const STATUS_OPEN = 463630000;
const STATUS_DONE = 463630006;
const ACTION_CHANNEL_WHATSAPP = 463630001;
const DEPARTMENT_INSURANCE = 463630002;
const URGENCY = { Urgent: 463630000, High: 463630001, Normal: 463630002 } as const;

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (id: string) => {
  if (!GUID.test(id)) throw new Error(`Not a Dataverse id: ${id}`);
  return id;
};
const odataString = (v: string) => encodeURIComponent(v.replace(/'/g, "''"));

/** The forms one South African mobile number is stored in: 0821234567, +27821234567, 27821234567. */
export function phoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('27') ? digits.slice(2) : digits.startsWith('0') ? digits.slice(1) : digits;
  if (local.length !== 9) return [phone.trim()];
  return [`0${local}`, `+27${local}`, `27${local}`];
}

// --- Due dates (the TTTFG-4853 rule, see the header) ------------------------------------------------------------------
const SAST = 2 * 3_600_000;
const isWorkday = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
const atHour = (d: Date, h: number) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h) - SAST;

/** 17:00 SAST on the next working day after `at`. */
export function nextWorkingDay(at: string): string {
  const d = new Date(Date.parse(at) + SAST);
  do d.setUTCDate(d.getUTCDate() + 1); while (!isWorkday(d));
  return new Date(atHour(d, 17)).toISOString();
}

/** Two working hours after `at` (working time 08:00 to 17:00 SAST, Monday to Friday). */
export function twoWorkingHours(at: string): string {
  let t = Date.parse(at);
  let left = 2 * 3_600_000;
  for (let i = 0; i < 30; i++) {
    const d = new Date(t + SAST);
    if (!isWorkday(d) || t >= atHour(d, 17)) {
      do d.setUTCDate(d.getUTCDate() + 1); while (!isWorkday(d));
      t = atHour(d, 8);
      continue;
    }
    if (t < atHour(d, 8)) t = atHour(d, 8);
    const close = atHour(d, 17);
    if (t + left <= close) return new Date(t + left).toISOString();
    left -= close - t;
    t = close;
  }
  return new Date(t).toISOString();
}

export interface ClaimsDataverseOptions {
  dv: Dv;
  send: (to: string, message: Outbound) => Promise<void>;
  /** The riivo_InsuranceAdviceTeamId environment variable's value; read from Dataverse when not given. */
  insuranceTeamId?: string;
}

export function dataverseClaimPorts(o: ClaimsDataverseOptions): ClaimPorts {
  const { dv } = o;
  let team: Promise<{ id: string; name: string }> | undefined;

  return {
    async contactByWhatsApp(phone) {
      const or = phoneVariants(phone).map((v) => `mobilephone eq '${odataString(v)}'`).join(' or ');
      const r = await dv<{ value: { contactid: string; firstname?: string; fullname?: string }[] }>('GET',
        `contacts?$select=contactid,firstname,fullname&$top=2&$filter=statecode eq 0 and (${or})`);
      // Only an exact, single match: two contacts on one number can't open a claim in either name.
      if (r.value.length !== 1) return null;
      const c = r.value[0];
      return { id: c.contactid, firstName: (c.firstname || c.fullname || '').trim().split(/\s+/)[0] || 'there' };
    },

    async activePolicies(contactId) {
      const r = await dv<{ value: Record<string, unknown>[] }>('GET',
        'riivo_policies?$select=riivo_policyid,riivo_policynumber,riivo_policy_no,riivo_product,riivo_product_2'
        + `&$filter=_riivo_policyholderid_value eq ${guid(contactId)} and riivo_policy_status eq ${POLICY_ACTIVE}`
        + '&$expand=riivo_Provider($select=riivo_providerid,riivo_providername,riivo_assistnumber)&$orderby=createdon asc',
        undefined, { formatted: true });
      const out: Policy[] = [];
      for (const p of r.value) {
        const prov = p.riivo_Provider as { riivo_providerid?: string; riivo_providername?: string; riivo_assistnumber?: string } | null;
        // A claim needs an insurer. A policy with no provider can't be claimed on here; a person takes it.
        if (!prov?.riivo_providerid) continue;
        out.push({
          id: String(p.riivo_policyid),
          providerId: prov.riivo_providerid,
          insurer: prov.riivo_providername ?? 'your insurer',
          product: String(p[`riivo_product${FORMATTED}`] ?? p.riivo_product_2 ?? 'insurance'),
          // TTTFG-4873's audit keeps riivo_policynumber; riivo_policy_no is the older copy.
          policyNumber: String(p.riivo_policynumber ?? p.riivo_policy_no ?? ''),
          assistNumber: prov.riivo_assistnumber?.trim() || undefined,
        });
      }
      return out;
    },

    async policyOwner(policyId): Promise<PolicyOwner | null> {
      const p = await dv<{ owninguser?: { systemuserid: string; firstname?: string; fullname?: string; isdisabled?: boolean } | null; owningteam?: { teamid: string; name: string } | null }>(
        'GET', `riivo_policies(${guid(policyId)})?$select=riivo_policyid&$expand=owninguser($select=systemuserid,firstname,fullname,isdisabled),owningteam($select=teamid,name)`);
      if (p.owninguser) {
        const u = p.owninguser;
        return { kind: 'user', id: u.systemuserid, firstName: (u.firstname || u.fullname || '').trim().split(/\s+/)[0], enabled: !u.isdisabled };
      }
      return p.owningteam ? { kind: 'team', id: p.owningteam.teamid, name: p.owningteam.name } : null;
    },

    insuranceTeam() {
      team ??= (async () => {
        let id = o.insuranceTeamId;
        if (!id) {
          const v = await dv<{ value: { defaultvalue?: string; environmentvariabledefinition_environmentvariablevalue: { value: string }[] }[] }>('GET',
            "environmentvariabledefinitions?$select=defaultvalue&$filter=schemaname eq 'riivo_InsuranceAdviceTeamId'"
            + '&$expand=environmentvariabledefinition_environmentvariablevalue($select=value)');
          id = v.value[0]?.environmentvariabledefinition_environmentvariablevalue[0]?.value || v.value[0]?.defaultvalue;
        }
        if (!id) throw new Error('riivo_InsuranceAdviceTeamId has no value in this environment');
        const t = await dv<{ teamid: string; name: string }>('GET', `teams(${guid(id)})?$select=teamid,name`);
        // What the client reads: "the Insurance and Advice team".
        return { id: t.teamid, name: /team$/i.test(t.name) ? `the ${t.name}` : `the ${t.name} team` };
      })().catch((e) => { team = undefined; throw e; });
      return team;
    },

    async createClaim(row: ClaimRow) {
      const created = await dv<{ riivo_claimid: string; riivo_name?: string }>('POST', 'riivo_claims?$select=riivo_claimid,riivo_name', {
        'riivo_Contact@odata.bind': `/contacts(${guid(row.contactId)})`,
        'riivo_Policy@odata.bind': `/riivo_policies(${guid(row.policyId)})`,
        'riivo_Provider@odata.bind': `/riivo_providers(${guid(row.providerId)})`,
        'ownerid@odata.bind': row.owner.kind === 'user' ? `/systemusers(${guid(row.owner.id)})` : `/teams(${guid(row.owner.id)})`,
        riivo_claimtype: CLAIM_TYPE[row.claimType],
        riivo_claimstatus: CLAIM_STATUS_FNOL_LOGGED,
        riivo_channel: CLAIM_CHANNEL_WHATSAPP,
        riivo_reportedon: row.reportedOn,
        riivo_incidentdate: row.incidentAt,
        riivo_incidentplace: row.place.slice(0, 200),
        riivo_description: row.description.slice(0, 10000),
        riivo_thirdpartiesinvolved: row.thirdParties,
        riivo_thirdpartydetails: row.thirdPartyDetails?.slice(0, 2000) ?? null,
        riivo_sapsinvolved: row.saps,
        riivo_injuries: row.injuries,
        riivo_injurydetails: row.injuryDetails?.slice(0, 2000) ?? null,
        riivo_lastclientmessageon: row.lastClientMessageOn,
      }, { returnRow: true });
      // Dataverse sets the claim reference (auto-number CLM-{SEQNUM:6}). Read it back if the POST didn't return it.
      const reference = created.riivo_name
        ?? (await dv<{ riivo_name: string }>('GET', `riivo_claims(${created.riivo_claimid})?$select=riivo_name`)).riivo_name;
      return { id: created.riivo_claimid, reference };
    },

    async createAgentAction(row: AgentActionRow) {
      const followUp = row.kind === 'Follow-up';
      const dueOn = followUp ? (row.urgent ? twoWorkingHours(row.at) : nextWorkingDay(row.at)) : undefined;
      const created = await dv<{ riivo_agentactionid: string }>('POST', 'riivo_agentactions?$select=riivo_agentactionid', {
        riivo_name: row.detail.slice(0, 300),
        riivo_kind: KIND[row.kind],
        // A Created row records something already done; a Follow-up is open work for a person.
        riivo_status: followUp ? STATUS_OPEN : STATUS_DONE,
        riivo_channel: ACTION_CHANNEL_WHATSAPP,
        riivo_department: DEPARTMENT_INSURANCE,
        riivo_promise: followUp ? row.detail.slice(0, 2000) : null,
        riivo_duedate: dueOn ?? null,
        riivo_urgency: followUp ? (row.urgent ? URGENCY.Urgent : URGENCY.High) : URGENCY.Normal,
        riivo_urgencyreason: followUp ? (row.urgent ? 'Someone is hurt and the insurer has no assist number on file' : 'Promised to the client') : 'The agent created a record to check',
        riivo_actedon: followUp ? null : row.at,
        // Until TTTFG-4853's Regarding lookup: the claim or request this row is about.
        riivo_sourcemessageid: `${row.regarding.table}:${row.regarding.id}`,
        riivo_subject: row.template ? `${row.template.name} (${row.template.version})` : null,
        riivo_finaltext: row.template?.text ?? null,
        'ownerid@odata.bind': row.owner.kind === 'user' ? `/systemusers(${guid(row.owner.id)})` : `/teams(${guid(row.owner.id)})`,
        ...(row.contactId ? { 'riivo_Client_contact@odata.bind': `/contacts(${guid(row.contactId)})` } : {}),
      }, { returnRow: true });
      return { id: created.riivo_agentactionid, dueOn };
    },

    send: o.send,
  };
}
