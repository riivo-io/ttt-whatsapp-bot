// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/followon-dataverse.ts (commit da163a4). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5176: the follow-on's ports (followon.ts FollowOnPorts) against Dataverse, in the style of TTTFG-5168's
// dataverse.ts: the host passes its Dataverse call (`Dv`), its WhatsApp send and where files go, so this file runs
// unchanged in Tina and in the email agent and imports nothing from either.
//
// The claim record is the source of truth (followon.ts): every turn reads the claim, its claim form and the documents
// linked to it, and writes back only what changed.
// - riivo_claim.riivo_answers holds ClaimAnswers as JSON; riivo_evidencecomplete is the flag (both added by this story).
// - A document answers a question list item through riivo_clientdocument.riivo_claimitem (added by this story), so
//   progress.ts can tell which evidence is in.
// - riivo_claimform rows are read back with TTTFG-5172's fromColumns(), the same reading its loader
//   (Shared data model/TTTFG-5172/claimforms_dv.py) and its DEV check use.
//
// Files. Until the WhatsApp document pipeline exists (TTTFG-4945), `fileToPipeline` stores the file in the client's
// SharePoint claim folder and writes the riivo_clientdocument row, linked to the claim, with no OCR and no reading. A
// host with the pipeline passes it as `pipeline` instead. A video always takes the store-only path: never opened, never
// read (story: "Video is stored as evidence but not watched or read by the agent").
import type { AgentActionRow, Outbound, Owner } from './claim';
import { fromColumns } from './claimform';
import { ClaimFormSchema, type ClaimAnswers, type RequestClaimSignature } from './contracts';
import { dataverseClaimPorts, type Dv } from './dataverse';
import type { ClaimStatus, ClientFile, FollowOnClaim, FollowOnPorts, SignatureStatus, StoredClaimForm } from './followon';
import { requestClaimSignature as signatureStub } from './signature';
import { DISCLOSURE_TEMPLATE } from './templates';
import { CLAIM_TYPES, type ClaimType } from './walkthrough';

// 2Tables values, the same in every environment (TTTFG-4885 build_schema.py; read from DEV on 21 Oct 2026).
const OPT = 463630000;
const CLAIM_TYPE_VALUES: Record<number, ClaimType> = {
  463630000: 'Motor accident', 463630001: 'Motor theft', 463630002: 'Property loss or damage', 463630003: 'Windscreen',
  463630004: 'Portable possessions', 463630005: 'Other', 463630006: 'Hijacking',
};
const CLAIM_TYPE_OF = Object.fromEntries(Object.entries(CLAIM_TYPE_VALUES).map(([v, t]) => [t, Number(v)])) as Record<ClaimType, number>;
export const CLAIM_STATUSES: readonly ClaimStatus[] = [
  'FNOL logged', 'Cover verified', 'Form sent', 'Awaiting client docs', 'Pack complete', 'Submitted to insurer',
  'Under assessment', 'Additional info requested', 'Approved', 'Partially approved', 'Rejected', 'Representations',
  'Ombud', 'Settled', 'Closed', 'Withdrawn',
];
const SIGNATURE_STATUSES: readonly SignatureStatus[] = ['Not sent', 'Link sent', 'Signed'];
const DOCUMENT_CHANNEL_WHATSAPP = 463630001;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (id: string) => {
  if (!GUID.test(id)) throw new Error(`Not a Dataverse id: ${id}`);
  return id;
};

/** Where a client file goes: the client's SharePoint folder, under the claim. Returns the file's link. */
export interface ClaimFileStore {
  put(file: ClientFile, to: { contactId: string; contactName: string; claimReference: string }): Promise<string>;
}

export interface FollowOnDataverseOptions {
  dv: Dv;
  send: (to: string, message: Outbound) => Promise<void>;
  files: ClaimFileStore;
  /** The WhatsApp document pipeline (TTTFG-4945), once it exists. Without it: store and register, nothing read. */
  pipeline?: FollowOnPorts['fileToPipeline'];
  /** The signing seam; TTTFG-5192's fill once wired. Default: the stub that answers notAvailable. */
  requestClaimSignature?: RequestClaimSignature;
  phrase?: FollowOnPorts['phrase'];
  /** The riivo_InsuranceAdviceTeamId value; read from Dataverse when not given (only TTTFG-5168's ports use it). */
  insuranceTeamId?: string;
}

interface ClaimRow {
  riivo_claimid: string;
  riivo_name: string;
  riivo_claimtype: number | null;
  riivo_claimstatus: number | null;
  riivo_signaturestatus: number | null;
  riivo_incidentdate: string | null;
  riivo_incidentplace: string | null;
  riivo_description: string | null;
  riivo_thirdpartiesinvolved: boolean | null;
  riivo_thirdpartydetails: string | null;
  riivo_sapsinvolved: boolean | null;
  riivo_sapscasenumber: string | null;
  riivo_sapsstation: string | null;
  riivo_sapsrequired: boolean | null;
  riivo_injuries: boolean | null;
  riivo_injurydetails: string | null;
  riivo_answers: string | null;
  _riivo_claimform_value: string | null;
  _riivo_contact_value: string | null;
  riivo_Provider: { riivo_providerid: string; riivo_providername?: string } | null;
  riivo_Contact: { fullname?: string; address1_composite?: string | null } | null;
  owninguser: { systemuserid: string; firstname?: string; fullname?: string } | null;
  owningteam: { teamid: string; name: string } | null;
}

interface ClaimFormRow {
  riivo_claimformid: string;
  riivo_name: string;
  riivo_evidencechecklist: string | null;
  riivo_claimtype: number | null;
  riivo_formurl: string | null;
  riivo_notificationperioddays: number | null;
  riivo_sapscaserequired: boolean | null;
  riivo_questionlist: string | null;
  riivo_fieldmap: string | null;
  statecode: number;
  riivo_Provider: { riivo_providername?: string } | null;
}

const CLAIM_SELECT = [
  'riivo_name', 'riivo_claimtype', 'riivo_claimstatus', 'riivo_signaturestatus', 'riivo_incidentdate', 'riivo_incidentplace',
  'riivo_description', 'riivo_thirdpartiesinvolved', 'riivo_thirdpartydetails', 'riivo_sapsinvolved', 'riivo_sapscasenumber',
  'riivo_sapsstation', 'riivo_sapsrequired', 'riivo_injuries', 'riivo_injurydetails', 'riivo_answers', '_riivo_claimform_value', '_riivo_contact_value',
].join(',');
const FORM_SELECT = 'riivo_claimformid,riivo_name,riivo_evidencechecklist,riivo_claimtype,riivo_formurl,riivo_notificationperioddays,riivo_sapscaserequired,riivo_questionlist,riivo_fieldmap,statecode';

/** What the client reads as the owner: the user's first name, or "the Insurance and Advice team" (as TTTFG-5168). */
export function ownerOf(r: Pick<ClaimRow, 'owninguser' | 'owningteam'>): Owner {
  if (r.owninguser) {
    const u = r.owninguser;
    return { kind: 'user', id: u.systemuserid, name: (u.firstname || u.fullname || '').trim().split(/\s+/)[0] };
  }
  if (!r.owningteam) throw new Error('A claim with no owner');
  const name = r.owningteam.name;
  return { kind: 'team', id: r.owningteam.teamid, name: /team$/i.test(name) ? `the ${name}` : `the ${name} team` };
}

/**
 * A riivo_claimform row as the contract's ClaimForm (TTTFG-5172's fromColumns). A column that isn't valid JSON stops the
 * turn rather than asking from half a list; a hand-edited evidence checklist that drifted is TTTFG-5172's check to
 * report, and the question list is what Tina asks from.
 */
export function claimFormOf(r: ClaimFormRow): StoredClaimForm {
  const { form, errors } = fromColumns({
    riivo_name: r.riivo_name,
    provider: r.riivo_Provider?.riivo_providername ?? null,
    claimType: r.riivo_claimtype == null ? null : CLAIM_TYPE_VALUES[r.riivo_claimtype] ?? null,
    riivo_formurl: r.riivo_formurl,
    riivo_questionlist: r.riivo_questionlist,
    riivo_evidencechecklist: r.riivo_evidencechecklist,
    riivo_fieldmap: r.riivo_fieldmap,
    riivo_notificationperioddays: r.riivo_notificationperioddays,
    riivo_sapscaserequired: r.riivo_sapscaserequired,
    active: r.statecode === 0,
  });
  const broken = errors.filter((e) => !e.startsWith('riivo_evidencechecklist'));
  if (broken.length) throw new Error(`Claim form ${r.riivo_name}: ${broken.join('; ')}`);
  return { ...ClaimFormSchema.parse(form), id: r.riivo_claimformid };
}

export function dataverseFollowOnPorts(o: FollowOnDataverseOptions): FollowOnPorts {
  const { dv } = o;
  const claimPorts = dataverseClaimPorts({ dv, send: o.send, insuranceTeamId: o.insuranceTeamId });
  const patch = async (claimId: string, body: Record<string, unknown>) => void (await dv('PATCH', `riivo_claims(${guid(claimId)})`, body));
  const forms = (filter: string) => dv<{ value: ClaimFormRow[] }>('GET',
    `riivo_claimforms?$select=${FORM_SELECT}&$expand=riivo_Provider($select=riivo_providername)&$orderby=createdon asc&$filter=${filter}`);

  /** The register row for a client file on the claim, after the file is stored. */
  async function register(file: ClientFile, to: { claimId: string; itemKey?: string }): Promise<{ documentId: string }> {
    const c = await dv<Pick<ClaimRow, 'riivo_name' | '_riivo_contact_value' | 'riivo_Contact'>>('GET',
      `riivo_claims(${guid(to.claimId)})?$select=riivo_name,_riivo_contact_value&$expand=riivo_Contact($select=fullname)`);
    if (!c._riivo_contact_value) throw new Error(`Claim ${c.riivo_name} has no client`);
    const link = await o.files.put(file, { contactId: c._riivo_contact_value, contactName: c.riivo_Contact?.fullname ?? 'Client', claimReference: c.riivo_name });
    const row = await dv<{ riivo_clientdocumentid: string }>('POST', 'riivo_clientdocuments?$select=riivo_clientdocumentid', {
      riivo_originalfilename: file.fileName.slice(0, 400),
      riivo_sharepointlink: link || null,
      riivo_channel: DOCUMENT_CHANNEL_WHATSAPP,
      riivo_receivedon: new Date().toISOString(),
      // The WhatsApp media id, so the file can be traced to the client's message.
      riivo_sourcemessageid: file.id,
      riivo_claimitem: to.itemKey ?? null,
      'riivo_Claim@odata.bind': `/riivo_claims(${guid(to.claimId)})`,
      'riivo_Client_contact@odata.bind': `/contacts(${guid(c._riivo_contact_value)})`,
    }, { returnRow: true });
    return { documentId: row.riivo_clientdocumentid };
  }

  return {
    async loadClaim(claimId) {
      const r = await dv<ClaimRow>('GET', `riivo_claims(${guid(claimId)})?$select=${CLAIM_SELECT}`
        + '&$expand=riivo_Provider($select=riivo_providerid,riivo_providername),riivo_Contact($select=fullname,address1_composite),'
        + 'owninguser($select=systemuserid,firstname,fullname),owningteam($select=teamid,name)');
      const docs = await dv<{ value: { riivo_claimitem: string | null }[] }>('GET',
        `riivo_clientdocuments?$select=riivo_claimitem&$filter=_riivo_claim_value eq ${guid(claimId)} and riivo_claimitem ne null`);
      // TTTFG-5184: the duty of disclosure's Created agent action (named by the claim until TTTFG-4853's Regarding).
      const disclosure = await dv<{ value: unknown[] }>('GET', `riivo_agentactions?$select=riivo_agentactionid&$top=1&$filter=`
        + `riivo_sourcemessageid eq 'riivo_claim:${guid(claimId)}' and startswith(riivo_subject,'${encodeURIComponent(DISCLOSURE_TEMPLATE.name)}')`);
      const claimType = r.riivo_claimtype == null ? 'Other' : CLAIM_TYPE_VALUES[r.riivo_claimtype] ?? 'Other';
      if (!r.riivo_Provider) throw new Error(`Claim ${r.riivo_name} has no insurer`);
      if (!r.riivo_incidentdate) throw new Error(`Claim ${r.riivo_name} has no incident date`);
      const claim: FollowOnClaim = {
        id: r.riivo_claimid,
        reference: r.riivo_name,
        contactId: r._riivo_contact_value ?? undefined,
        providerId: r.riivo_Provider.riivo_providerid,
        insurer: r.riivo_Provider.riivo_providername ?? 'your insurer',
        claimType,
        facts: {
          claimType, incidentAt: r.riivo_incidentdate,
          description: r.riivo_description ?? undefined, place: r.riivo_incidentplace ?? undefined,
          thirdParties: r.riivo_thirdpartiesinvolved ?? undefined, thirdPartyDetails: r.riivo_thirdpartydetails ?? undefined,
          saps: r.riivo_sapsinvolved ?? undefined, injuries: r.riivo_injuries ?? undefined, injuryDetails: r.riivo_injurydetails ?? undefined,
        },
        sapsCaseNumber: r.riivo_sapscasenumber ?? undefined,
        sapsStation: r.riivo_sapsstation ?? undefined,
        sapsRequired: r.riivo_sapsrequired ?? undefined,
        introSent: disclosure.value.length > 0,
        status: CLAIM_STATUSES[(r.riivo_claimstatus ?? OPT) - OPT] ?? 'FNOL logged',
        signatureStatus: SIGNATURE_STATUSES[(r.riivo_signaturestatus ?? OPT) - OPT] ?? 'Not sent',
        claimFormId: r._riivo_claimform_value ?? undefined,
        answers: r.riivo_answers ? (JSON.parse(r.riivo_answers) as ClaimAnswers) : {},
        evidence: docs.value.map((d) => ({ key: d.riivo_claimitem! })),
        owner: ownerOf(r),
        contactAddress: r.riivo_Contact?.address1_composite?.trim() || null,
      };
      return claim;
    },

    async activeClaimForm(providerId, claimType) {
      const r = await forms(`statecode eq 0 and _riivo_provider_value eq ${guid(providerId)} and riivo_claimtype eq ${CLAIM_TYPE_OF[claimType]}`);
      return r.value[0] ? claimFormOf(r.value[0]) : null;
    },

    async genericClaimForm() {
      const r = await forms('statecode eq 0 and _riivo_provider_value eq null and riivo_claimtype eq null');
      if (!r.value[0]) throw new Error('No active generic claim form (provider and claim type empty). Load config/claimforms first.');
      return claimFormOf(r.value[0]);
    },

    async claimForm(id) {
      const r = await dv<ClaimFormRow>('GET', `riivo_claimforms(${guid(id)})?$select=${FORM_SELECT}&$expand=riivo_Provider($select=riivo_providername)`);
      return claimFormOf(r);
    },

    setClaimForm: (claimId, formId) => patch(claimId, { 'riivo_ClaimForm@odata.bind': `/riivo_claimforms(${guid(formId)})` }),

    async saveSaps(claimId, v) {
      await patch(claimId, {
        ...(v.caseNumber ? { riivo_sapscasenumber: v.caseNumber.slice(0, 50), riivo_sapsinvolved: true } : {}),
        ...(v.station ? { riivo_sapsstation: v.station.slice(0, 100) } : {}),
      });
    },

    // TTTFG-5184: riivo_sapsrequired, so a resumed claim still runs the SAPS step.
    setSapsRequired: (claimId) => patch(claimId, { riivo_sapsrequired: true }),
    saveAnswers: (claimId, answers) => patch(claimId, { riivo_answers: JSON.stringify(answers) }),
    setStatus: (claimId, status) => patch(claimId, { riivo_claimstatus: OPT + CLAIM_STATUSES.indexOf(status) }),
    setEvidenceComplete: (claimId) => patch(claimId, { riivo_evidencecomplete: true }),
    setLastClientMessageOn: (claimId, at) => patch(claimId, { riivo_lastclientmessageon: at }),

    fileToPipeline: (file, to) => (o.pipeline ? o.pipeline(file, to) : register(file, to)),
    storeVideo: (file, to) => register(file, to),

    requestClaimSignature: o.requestClaimSignature ?? signatureStub,
    createAgentAction: (row: AgentActionRow) => claimPorts.createAgentAction(row),
    send: o.send,
    phrase: o.phrase,
  };
}

/** Exported for the loader and the tests. */
export { CLAIM_TYPE_OF, CLAIM_TYPE_VALUES };
export const KNOWN_CLAIM_TYPES: readonly string[] = CLAIM_TYPES;
