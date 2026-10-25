// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/resume-dataverse.ts (commit 5bddb94). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5184: resume.ts's ports against Dataverse. The 5168 claim ports and the 5176 follow-on ports as they are, plus
// openClaimsForClient: the one reading of "open" (OPEN_CLAIM_STATUSES) that TTTFG-5188 reuses for email. Like the other
// two files, the host passes its Dataverse call, its WhatsApp send and where files go; nothing here imports Tina or the
// email agent.
import { dataverseClaimPorts } from './dataverse';
import { CLAIM_STATUSES, CLAIM_TYPE_VALUES, dataverseFollowOnPorts, type FollowOnDataverseOptions } from './followon-dataverse';
import { OPEN_CLAIM_STATUSES, type OpenClaim, type OpenClaimsPort, type ResumePorts } from './resume';

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
      return r.value.map((c) => ({
        id: c.riivo_claimid,
        reference: c.riivo_name,
        claimType: c.riivo_claimtype == null ? 'Other' : CLAIM_TYPE_VALUES[c.riivo_claimtype] ?? 'Other',
        // A claim with no incident date sorts by when it was reported; resume.ts only uses the date to name the claim.
        incidentAt: c.riivo_incidentdate ?? new Date(0).toISOString(),
        status: CLAIM_STATUSES[c.riivo_claimstatus - OPT],
        lastClientMessageOn: c.riivo_lastclientmessageon ?? undefined,
      }));
    },
  };
}

/** Everything resumeTurn() needs, on Dataverse. */
export function dataverseResumePorts(o: FollowOnDataverseOptions): ResumePorts {
  return {
    ...dataverseClaimPorts({ dv: o.dv, send: o.send, insuranceTeamId: o.insuranceTeamId }),
    ...dataverseFollowOnPorts(o),
    ...openClaimsPort(o.dv),
  };
}
