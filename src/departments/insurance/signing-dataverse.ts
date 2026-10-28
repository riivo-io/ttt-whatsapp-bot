// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/signing-dataverse.ts (commit 39b117f). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5196: the signing step's and the callback's ports (signing.ts) against Dataverse, in the style of
// fill-dataverse.ts. The host passes its Dataverse call (`Dv`) and where claim files go; it adds the signing page
// (createSigningRequest), its senders and whether the template is signed off, so this file runs unchanged in Tina and
// in the email agent and imports nothing from either.
//
// - The claim's channel is riivo_claim.riivo_channel (Email, WhatsApp). The link goes to the client's mobile number
//   (contact.mobilephone) on a WhatsApp claim, or to their email address (contact.emailaddress1) on an email claim; a
//   host that knows the number the client is writing from passes that instead.
// - The signed copy is its own riivo_clientdocument row, document type "Claim form (signed)" (a riivo_documenttype row:
//   Shared data model/TTTFG-5196/add_document_type.py makes it), linked to the claim and the client like the unsigned one.
// - riivo_signaturestatus, riivo_signedon and riivo_signatureaudit are TTTFG-4885's columns on riivo_claim.
import type { Dv } from './dataverse';
import { dataverseClaimPorts } from './dataverse';
import type { ClaimFormFiles } from './fill-dataverse';
import { CLAIM_TYPE_VALUES, ownerOf } from './followon-dataverse';
import type { SignatureStatus } from './signature-fill';
import { CLAIM_FORM_UNSIGNED } from './signature-fill';
import type { ClaimSignedPorts, ClaimSigningPorts, SignChannel, SignedClaim } from './signing';

/** riivo_documenttype for the signed copy. */
export const CLAIM_FORM_SIGNED = 'Claim form (signed)';

const OPT = 463630000;
/** riivo_claim.riivo_channel (TTTFG-4885 CHANNEL). */
const CHANNELS: readonly SignChannel[] = ['email', 'whatsapp'];
const SIGNATURE_STATUSES: readonly SignatureStatus[] = ['Not sent', 'Link sent', 'Signed'];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (id: string) => {
  if (!GUID.test(id)) throw new Error(`Not a Dataverse id: ${id}`);
  return id;
};

interface ClaimRow {
  riivo_claimid: string;
  riivo_name: string;
  riivo_claimtype: number | null;
  riivo_channel: number | null;
  riivo_signaturestatus: number | null;
  riivo_signatureaudit: string | null;
  _riivo_contact_value: string | null;
  riivo_Provider: { riivo_providername?: string } | null;
  riivo_Contact: { firstname?: string | null; fullname?: string | null; mobilephone?: string | null; emailaddress1?: string | null } | null;
  owninguser: { systemuserid: string; firstname?: string; fullname?: string } | null;
  owningteam: { teamid: string; name: string } | null;
}

export interface SigningDataverseOptions {
  dv: Dv;
  /** The client's SharePoint claim folder (the same store the unsigned form went to). */
  files: ClaimFormFiles;
}

export type DataverseSigningPorts = Pick<ClaimSigningPorts, 'signingClaim' | 'setLinkSent' | 'createAgentAction'> & ClaimSignedPorts;

export function dataverseSigningPorts(o: SigningDataverseOptions): DataverseSigningPorts {
  const { dv } = o;
  const claimPorts = dataverseClaimPorts({ dv, send: async () => { throw new Error('the signing ports send nothing through the claim ports'); } });
  const typeIds = new Map<string, Promise<string>>();
  /** The active riivo_documenttype row of this name. */
  const documentTypeId = (name: string) => {
    let id = typeIds.get(name);
    if (!id) {
      id = dv<{ value: { riivo_documenttypeid: string }[] }>('GET',
        `riivo_documenttypes?$select=riivo_documenttypeid&$filter=riivo_documenttype eq '${name}' and statecode eq 0`)
        .then((r) => {
          if (!r.value[0]) throw new Error(`No active document type "${name}" in this environment`);
          return r.value[0].riivo_documenttypeid;
        });
      id.catch(() => typeIds.delete(name));
      typeIds.set(name, id);
    }
    return id;
  };
  const claimRow = (claimId: string) => dv<ClaimRow>('GET', `riivo_claims(${guid(claimId)})`
    + '?$select=riivo_name,riivo_claimtype,riivo_channel,riivo_signaturestatus,riivo_signatureaudit,_riivo_contact_value'
    + '&$expand=riivo_Provider($select=riivo_providername),riivo_Contact($select=firstname,fullname,mobilephone,emailaddress1),'
    + 'owninguser($select=systemuserid,firstname,fullname),owningteam($select=teamid,name)');
  const common = (r: ClaimRow) => {
    if (!r._riivo_contact_value) throw new Error(`Claim ${r.riivo_name} has no client`);
    return {
      id: r.riivo_claimid,
      reference: r.riivo_name,
      contactId: r._riivo_contact_value,
      insurer: r.riivo_Provider?.riivo_providername ?? 'Insurer',
      claimType: r.riivo_claimtype == null ? 'Other' : CLAIM_TYPE_VALUES[r.riivo_claimtype] ?? 'Other',
      owner: ownerOf(r),
    };
  };

  return {
    async signingClaim(claimId) {
      const r = await claimRow(claimId);
      const c = r.riivo_Contact;
      return {
        ...common(r),
        firstName: (c?.firstname || c?.fullname || '').trim().split(/\s+/)[0] || 'Hi there',
        channel: r.riivo_channel == null ? null : CHANNELS[r.riivo_channel - OPT] ?? null,
        whatsApp: c?.mobilephone?.trim() || null,
        email: c?.emailaddress1?.trim() || null,
      };
    },

    setLinkSent: async (claimId) => void (await dv('PATCH', `riivo_claims(${guid(claimId)})`, { riivo_signaturestatus: OPT + SIGNATURE_STATUSES.indexOf('Link sent') })),

    async signedClaim(claimId): Promise<SignedClaim> {
      const r = await claimRow(claimId);
      const unsigned = await dv<{ value: { riivo_filehash: string | null }[] }>('GET',
        'riivo_clientdocuments?$select=riivo_filehash&$orderby=createdon asc'
        + `&$filter=_riivo_claim_value eq ${guid(claimId)} and _riivo_documenttype_value eq ${await documentTypeId(CLAIM_FORM_UNSIGNED)} and statecode eq 0`);
      return {
        ...common(r),
        contactName: r.riivo_Contact?.fullname ?? 'Client',
        signatureStatus: r.riivo_signaturestatus == null ? null : SIGNATURE_STATUSES[r.riivo_signaturestatus - OPT] ?? null,
        signatureAudit: r.riivo_signatureaudit,
        unsignedHash: unsigned.value[0]?.riivo_filehash ?? null,
        answers: {},
      };
    },

    saveToClaimFolder: (claim, fileName, bytes) =>
      o.files.save({ contactId: claim.contactId, contactName: claim.contactName ?? 'Client', claimReference: claim.reference }, fileName, bytes),

    async findSignedDocument(claimId) {
      const r = await dv<{ value: { riivo_clientdocumentid: string }[] }>('GET', 'riivo_clientdocuments?$select=riivo_clientdocumentid&$top=1'
        + `&$filter=_riivo_claim_value eq ${guid(claimId)} and _riivo_documenttype_value eq ${await documentTypeId(CLAIM_FORM_SIGNED)} and statecode eq 0`);
      return r.value[0] ? { id: r.value[0].riivo_clientdocumentid } : null;
    },

    async createSignedDocument(row) {
      const created = await dv<{ riivo_clientdocumentid: string }>('POST', 'riivo_clientdocuments?$select=riivo_clientdocumentid', {
        riivo_originalfilename: row.fileName.slice(0, 400),
        riivo_sharepointlink: row.fileRef || null,
        riivo_filehash: row.fileHash,
        'riivo_DocumentType@odata.bind': `/riivo_documenttypes(${await documentTypeId(CLAIM_FORM_SIGNED)})`,
        'riivo_Claim@odata.bind': `/riivo_claims(${guid(row.claimId)})`,
        'riivo_Client_contact@odata.bind': `/contacts(${guid(row.contactId)})`,
      }, { returnRow: true });
      return { id: created.riivo_clientdocumentid };
    },

    markSigned: async (claimId, signedOn, audit) => void (await dv('PATCH', `riivo_claims(${guid(claimId)})`, {
      riivo_signaturestatus: OPT + SIGNATURE_STATUSES.indexOf('Signed'), riivo_signedon: signedOn, riivo_signatureaudit: audit.slice(0, 10000),
    })),

    createAgentAction: (row) => claimPorts.createAgentAction(row),
  };
}
