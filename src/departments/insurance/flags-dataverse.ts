// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/flags-dataverse.ts (commit c99946b). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5263: the flag ports (flags.ts) against Dataverse: riivo_claimflag from TTTFG-4885 step 7, the claim with its form
// and policy, and the claim's riivo_clientdocument rows. Like dataverse.ts, it takes the host's Dataverse call and imports
// nothing from the email agent or Tina. It doesn't import followon-dataverse.ts either, which wires these ports in: the
// claim's owner is read here the way that file's ownerOf reads it.
//
// Where a document's dates are (no extracted-JSON column on riivo_clientdocument): riivo_issuedate holds a SAPS case
// slip's date and a photo's capture date (TTTFG-5263 step 3, exif.ts); riivo_periodend holds a driver's licence's
// valid-to date. Both are date-only columns.
//
// Go4Broker writes 1753-01-01 (SQL Server's empty date) into riivo_inception and riivo_cancelled: in DEV on 28 Oct 2026
// 648 of 692 active policies had it as their cancellation date. It is read as no date.
import type { Owner } from './claim';
import type { Dv } from './dataverse';
import { documentKind, type FlagClaim, type FlagDocument, type FlagPorts, type FlagType } from './flags';
import type { ClaimType } from './walkthrough';

/** riivo_claimflag.riivo_flagtype (local choice, read from DEV on 28 Oct 2026). */
export const FLAG_TYPE: Record<FlagType, number> = {
  'Late notification': 463630000, 'SAPS case missing': 463630001, 'Policy not active': 463630002,
  'Date mismatch': 463630003, 'Licence expired': 463630004, 'Photo date before incident': 463630005,
};
const FLAG_TYPE_OF = Object.fromEntries(Object.entries(FLAG_TYPE).map(([t, v]) => [v, t])) as Record<number, FlagType>;
const POLICY_ACTIVE = 463630000;
const IMAGE = /\.(jpe?g|png|heic|heif|webp|tiff?)$/i;

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (id: string) => {
  if (!GUID.test(id)) throw new Error(`Not a Dataverse id: ${id}`);
  return id;
};
/** A date-only value, or nothing for Go4Broker's empty date. */
const realDate = (v: string | null | undefined) => (v && v.slice(0, 10) > '1900-01-01' ? v.slice(0, 10) : undefined);

interface FlagClaimRow {
  riivo_claimid: string;
  riivo_name: string;
  riivo_claimtype: number | null;
  riivo_incidentdate: string | null;
  riivo_reportedon: string | null;
  riivo_sapscasenumber: string | null;
  riivo_sapsrequired: boolean | null;
  _riivo_contact_value: string | null;
  riivo_ClaimForm: { riivo_notificationperioddays: number | null; riivo_sapscaserequired: boolean | null } | null;
  riivo_Policy: {
    riivo_policynumber: string | null; riivo_policy_no: string | null; riivo_policy_status: number | null;
    riivo_inception: string | null; riivo_cancelled: string | null; [k: string]: unknown;
  } | null;
  owninguser: { systemuserid: string; firstname?: string; fullname?: string } | null;
  owningteam: { teamid: string; name: string } | null;
  [k: string]: unknown;
}

/** The claim's owner, as followon-dataverse.ts ownerOf reads it (the name stays the team's own: no client reads it). */
function ownerOfRow(r: Pick<FlagClaimRow, 'owninguser' | 'owningteam'>): Owner {
  if (r.owninguser) return { kind: 'user', id: r.owninguser.systemuserid, name: (r.owninguser.firstname || r.owninguser.fullname || '').trim().split(/\s+/)[0] };
  if (!r.owningteam) throw new Error('A claim with no owner');
  return { kind: 'team', id: r.owningteam.teamid, name: r.owningteam.name };
}

export interface FlagDataverseOptions {
  dv: Dv;
  /** The claim ports' writer (dataverse.ts), which takes the Follow-up's own due date and urgency reason. */
  createAgentAction: FlagPorts['createAgentAction'];
}

export function dataverseFlagPorts(o: FlagDataverseOptions): FlagPorts {
  const { dv } = o;
  return {
    async loadFlagClaim(claimId) {
      const r = await dv<FlagClaimRow>('GET', `riivo_claims(${guid(claimId)})?$select=riivo_claimid,riivo_name,riivo_claimtype,riivo_incidentdate,`
        + 'riivo_reportedon,riivo_sapscasenumber,riivo_sapsrequired,_riivo_contact_value'
        + '&$expand=riivo_ClaimForm($select=riivo_notificationperioddays,riivo_sapscaserequired),'
        + 'riivo_Policy($select=riivo_policynumber,riivo_policy_no,riivo_policy_status,riivo_inception,riivo_cancelled),'
        + 'owninguser($select=systemuserid,firstname,fullname),owningteam($select=teamid,name)', undefined, { formatted: true });
      if (!r.riivo_incidentdate) throw new Error(`Claim ${r.riivo_name} has no incident date`);
      const p = r.riivo_Policy;
      return {
        id: r.riivo_claimid,
        reference: r.riivo_name,
        contactId: r._riivo_contact_value ?? undefined,
        owner: ownerOfRow(r),
        claimType: (r[`riivo_claimtype${FORMATTED}`] as ClaimType | undefined) ?? 'Other',
        incidentAt: r.riivo_incidentdate,
        reportedOn: r.riivo_reportedon ?? r.riivo_incidentdate,
        notificationPeriodDays: r.riivo_ClaimForm?.riivo_notificationperioddays ?? undefined,
        sapsRequired: r.riivo_ClaimForm?.riivo_sapscaserequired === true || r.riivo_sapsrequired === true,
        sapsCaseNumber: r.riivo_sapscasenumber ?? undefined,
        policy: p ? {
          number: p.riivo_policynumber ?? p.riivo_policy_no ?? '',
          active: p.riivo_policy_status === POLICY_ACTIVE,
          status: (p[`riivo_policy_status${FORMATTED}`] as string | undefined) ?? undefined,
          inception: realDate(p.riivo_inception),
          cancelled: realDate(p.riivo_cancelled),
        } : null,
      } satisfies FlagClaim;
    },

    async claimDocuments(claimId) {
      const r = await dv<{ value: {
        riivo_clientdocumentid: string; riivo_originalfilename: string | null; riivo_claimitem: string | null;
        riivo_issuedate: string | null; riivo_periodend: string | null; riivo_DocumentType: { riivo_documenttype: string | null } | null;
      }[] }>('GET', 'riivo_clientdocuments?$select=riivo_clientdocumentid,riivo_originalfilename,riivo_claimitem,riivo_issuedate,riivo_periodend'
        + `&$expand=riivo_DocumentType($select=riivo_documenttype)&$filter=_riivo_claim_value eq ${guid(claimId)}`);
      return r.value.map((d): FlagDocument => {
        const name = d.riivo_originalfilename ?? 'document';
        const kind = documentKind({ typeName: d.riivo_DocumentType?.riivo_documenttype, itemKey: d.riivo_claimitem, image: IMAGE.test(name) });
        return {
          id: d.riivo_clientdocumentid, name, kind,
          ...(kind !== 'licence' && realDate(d.riivo_issuedate) ? { date: realDate(d.riivo_issuedate) } : {}),
          ...(kind === 'licence' && realDate(d.riivo_periodend) ? { expiry: realDate(d.riivo_periodend) } : {}),
        };
      });
    },

    async existingFlags(claimId) {
      const r = await dv<{ value: { riivo_flagtype: number | null; _riivo_sourcedocument_value: string | null }[] }>('GET',
        `riivo_claimflags?$select=riivo_flagtype,_riivo_sourcedocument_value&$filter=_riivo_claim_value eq ${guid(claimId)}`);
      return r.value.filter((f) => f.riivo_flagtype != null && FLAG_TYPE_OF[f.riivo_flagtype])
        .map((f) => ({ type: FLAG_TYPE_OF[f.riivo_flagtype!], ...(f._riivo_sourcedocument_value ? { documentId: f._riivo_sourcedocument_value } : {}) }));
    },

    async createFlag(claim, flag, at) {
      const row = await dv<{ riivo_claimflagid: string }>('POST', 'riivo_claimflags?$select=riivo_claimflagid', {
        riivo_name: `${claim.reference} - ${flag.type}`.slice(0, 200),
        riivo_flagtype: FLAG_TYPE[flag.type],
        riivo_detail: flag.detail.slice(0, 2000),
        riivo_raisedon: at,
        'riivo_Claim@odata.bind': `/riivo_claims(${guid(claim.id)})`,
        ...(flag.documentId ? { 'riivo_SourceDocument@odata.bind': `/riivo_clientdocuments(${guid(flag.documentId)})` } : {}),
        // Parental to the claim, so the flag has the claim's owner (TTTFG-4885: the agent holds Assign on flags).
        'ownerid@odata.bind': claim.owner.kind === 'user' ? `/systemusers(${guid(claim.owner.id)})` : `/teams(${guid(claim.owner.id)})`,
      }, { returnRow: true });
      return { id: row.riivo_claimflagid };
    },

    setLateNotification: async (claimId) => void (await dv('PATCH', `riivo_claims(${guid(claimId)})`, { riivo_latenotification: true })),

    createAgentAction: o.createAgentAction,
  };
}
