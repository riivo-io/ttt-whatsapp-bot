// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/fill-dataverse.ts (commit 05d65be). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5192: the fill's ports (signature-fill.ts ClaimFillPorts) against Dataverse, in the style of TTTFG-5176's
// followon-dataverse.ts: the host passes its Dataverse call (`Dv`), where the filled form goes (the client's SharePoint
// claim folder), how to read the insurer's blank PDF and the signing step, so this file runs unchanged in Tina and in
// the email agent and imports nothing from either.
//
// - The claim's form is the riivo_claimform row on the claim (TTTFG-5176 sets it at the first question). A claim
//   without one gets the active row for its insurer and claim type, else the generic row, as TTTFG-5176 chooses.
// - CRM values are read, never written (Policy data is Go4Broker's). The field maps read `riivo_policy.riivo_policy_no`;
//   TTTFG-4873's audit keeps riivo_policynumber, so the policy number is read the way TTTFG-5168's adapter reads it:
//   riivo_policynumber, else the older riivo_policy_no.
// - The unsigned form is one riivo_clientdocument row per claim, document type "Claim form (unsigned)" (a
//   riivo_documenttype row; DEV has it from scripts/claims-dev/walkthrough-5194.ts setup). Its riivo_sharepointlink is
//   the file, riivo_filehash the SHA-256 of what was filed.
import { CLAIM_FORM_UNSIGNED, signingStepNotAvailable, type ClaimFillPorts, type ClaimForFill, type ClientDocumentRow, type SignatureStatus, type SigningStep } from './signature-fill';
import type { ClaimAnswers } from './contracts';
import type { Dv } from './dataverse';
import type { CrmValues } from './fill';
import { ADDRESS_KEY } from './followon';
import { CLAIM_TYPE_VALUES, dataverseFollowOnPorts } from './followon-dataverse';
import type { ClaimType } from './walkthrough';

const OPT = 463630000;
const SIGNATURE_STATUSES: readonly SignatureStatus[] = ['Not sent', 'Link sent', 'Signed'];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (id: string) => {
  if (!GUID.test(id)) throw new Error(`Not a Dataverse id: ${id}`);
  return id;
};

/** Where the filled form goes. `replaces` is the fileRef of the claim's earlier unsigned form: overwrite that file. */
export interface ClaimFormFiles {
  save(to: { contactId: string; contactName: string; claimReference: string }, fileName: string, bytes: Uint8Array, replaces?: string): Promise<{ fileRef: string }>;
}

export interface FillDataverseOptions {
  dv: Dv;
  files: ClaimFormFiles;
  /** The insurer's blank PDF from riivo_claimform.riivo_formurl. */
  blankForm(formUrl: string): Promise<Uint8Array>;
  /** TTTFG-5196's signing step. Default: the stub that answers notAvailable. */
  signingStep?: SigningStep;
}

interface ClaimRow {
  riivo_claimid: string;
  riivo_name: string;
  riivo_claimtype: number | null;
  riivo_signaturestatus: number | null;
  riivo_answers: string | null;
  riivo_incidentdate: string | null;
  riivo_incidentplace: string | null;
  riivo_description: string | null;
  riivo_sapsinvolved: boolean | null;
  riivo_sapscasenumber: string | null;
  riivo_sapsstation: string | null;
  riivo_thirdpartiesinvolved: boolean | null;
  riivo_thirdpartydetails: string | null;
  riivo_injuries: boolean | null;
  _riivo_contact_value: string | null;
  _riivo_policy_value: string | null;
  _riivo_claimform_value: string | null;
  riivo_Provider: { riivo_providerid: string; riivo_providername?: string } | null;
  riivo_Contact: { fullname?: string } | null;
}

const CLAIM_SELECT = [
  'riivo_name', 'riivo_claimtype', 'riivo_signaturestatus', 'riivo_answers', 'riivo_incidentdate', 'riivo_incidentplace',
  'riivo_description', 'riivo_sapsinvolved', 'riivo_sapscasenumber', 'riivo_sapsstation', 'riivo_thirdpartiesinvolved',
  'riivo_thirdpartydetails', 'riivo_injuries', '_riivo_contact_value', '_riivo_policy_value', '_riivo_claimform_value',
].join(',');
/** The contact columns the go-live field maps read (config/claimforms). */
const CONTACT_SELECT = 'fullname,firstname,lastname,ttt_idnumber,mobilephone,telephone1,emailaddress1,address1_composite';

export function dataverseFillPorts(o: FillDataverseOptions): ClaimFillPorts {
  const { dv } = o;
  // TTTFG-5176's claim form reading (fromColumns via claimFormOf); its send and file store are never called here.
  const forms = dataverseFollowOnPorts({
    dv,
    send: async () => { throw new Error('the fill sends nothing'); },
    files: { put: async () => { throw new Error('the fill stores client files through ClaimFormFiles'); } },
  });
  const rows = new Map<string, ClaimRow>();
  let documentType: Promise<string> | undefined;

  const claimRow = async (claimId: string) => {
    const r = await dv<ClaimRow>('GET', `riivo_claims(${guid(claimId)})?$select=${CLAIM_SELECT}`
      + '&$expand=riivo_Provider($select=riivo_providerid,riivo_providername),riivo_Contact($select=fullname)');
    rows.set(claimId, r);
    return r;
  };

  /** The riivo_documenttype row "Claim form (unsigned)". */
  const documentTypeId = () => (documentType ??= (async () => {
    const r = await dv<{ value: { riivo_documenttypeid: string }[] }>('GET',
      `riivo_documenttypes?$select=riivo_documenttypeid&$filter=riivo_documenttype eq '${CLAIM_FORM_UNSIGNED}' and statecode eq 0`);
    if (!r.value[0]) throw new Error(`No active document type "${CLAIM_FORM_UNSIGNED}" in this environment`);
    return r.value[0].riivo_documenttypeid;
  })().catch((e) => { documentType = undefined; throw e; }));

  const documentBody = async (row: ClientDocumentRow) => ({
    riivo_originalfilename: row.fileName.slice(0, 400),
    riivo_sharepointlink: row.fileRef || null,
    riivo_filehash: row.fileHash ?? null,
    'riivo_DocumentType@odata.bind': `/riivo_documenttypes(${await documentTypeId()})`,
    'riivo_Claim@odata.bind': `/riivo_claims(${guid(row.claimId)})`,
    'riivo_Client_contact@odata.bind': `/contacts(${guid(row.contactId)})`,
  });

  return {
    async claim(claimId): Promise<ClaimForFill> {
      const r = await claimRow(claimId);
      if (!r._riivo_contact_value) throw new Error(`Claim ${r.riivo_name} has no client`);
      if (!r.riivo_Provider) throw new Error(`Claim ${r.riivo_name} has no insurer`);
      return {
        id: r.riivo_claimid,
        contactId: r._riivo_contact_value,
        insurer: r.riivo_Provider.riivo_providername ?? 'Insurer',
        claimType: r.riivo_claimtype == null ? 'Other' : CLAIM_TYPE_VALUES[r.riivo_claimtype] ?? 'Other',
        signatureStatus: r.riivo_signaturestatus == null ? null : SIGNATURE_STATUSES[r.riivo_signaturestatus - OPT] ?? null,
        answers: r.riivo_answers ? (JSON.parse(r.riivo_answers) as ClaimAnswers) : {},
        reference: r.riivo_name,
        contactName: r.riivo_Contact?.fullname ?? 'Client',
        providerId: r.riivo_Provider.riivo_providerid,
        policyId: r._riivo_policy_value ?? undefined,
        claimFormId: r._riivo_claimform_value ?? undefined,
      };
    },

    async claimForm(claim) {
      if (claim.claimFormId) return forms.claimForm(claim.claimFormId);
      const mapped = claim.providerId ? await forms.activeClaimForm(claim.providerId, claim.claimType as ClaimType) : null;
      return mapped ?? forms.genericClaimForm();
    },

    async crmValues(claim): Promise<CrmValues> {
      const r = rows.get(claim.id) ?? await claimRow(claim.id);
      const contact = await dv<Record<string, string | null>>('GET', `contacts(${guid(claim.contactId)})?$select=${CONTACT_SELECT}`);
      const policy = claim.policyId
        ? await dv<{ riivo_policynumber: string | null; riivo_policy_no: string | null; riivo_broker: string | null }>('GET',
          `riivo_policies(${guid(claim.policyId)})?$select=riivo_policynumber,riivo_policy_no,riivo_broker`)
        : null;
      // TTTFG-4830: an address the client confirmed on WhatsApp is the one on the form; the broker updates the CRM.
      const confirmed = claim.answers[ADDRESS_KEY];
      const address = confirmed?.status === 'answered' && typeof confirmed.value === 'string' ? confirmed.value : null;
      return {
        contact: { ...Object.fromEntries(CONTACT_SELECT.split(',').map((k) => [k, contact[k] ?? null])), ...(address ? { address1_composite: address } : {}) },
        riivo_policy: policy ? { riivo_policy_no: policy.riivo_policynumber || policy.riivo_policy_no, riivo_broker: policy.riivo_broker } : {},
        riivo_provider: { riivo_providername: claim.insurer },
        riivo_claim: {
          riivo_name: r.riivo_name, riivo_claimtype: claim.claimType, riivo_incidentdate: r.riivo_incidentdate,
          riivo_incidentplace: r.riivo_incidentplace, riivo_description: r.riivo_description, riivo_sapsinvolved: r.riivo_sapsinvolved,
          riivo_sapscasenumber: r.riivo_sapscasenumber, riivo_sapsstation: r.riivo_sapsstation,
          riivo_thirdpartiesinvolved: r.riivo_thirdpartiesinvolved, riivo_thirdpartydetails: r.riivo_thirdpartydetails,
          riivo_injuries: r.riivo_injuries,
        },
      };
    },

    blankForm: (formUrl) => o.blankForm(formUrl),

    saveToClaimFolder: (claim, fileName, bytes, replaces) =>
      o.files.save({ contactId: claim.contactId, contactName: claim.contactName ?? 'Client', claimReference: claim.reference ?? claim.id }, fileName, bytes, replaces),

    async findClientDocument(claimId) {
      const r = await dv<{ value: { riivo_clientdocumentid: string; riivo_sharepointlink: string | null; riivo_originalfilename: string }[] }>('GET',
        'riivo_clientdocuments?$select=riivo_clientdocumentid,riivo_sharepointlink,riivo_originalfilename&$orderby=createdon asc'
        + `&$filter=_riivo_claim_value eq ${guid(claimId)} and _riivo_documenttype_value eq ${await documentTypeId()} and statecode eq 0`);
      const d = r.value[0];
      return d ? { id: d.riivo_clientdocumentid, fileRef: d.riivo_sharepointlink ?? '', fileName: d.riivo_originalfilename } : null;
    },

    async createClientDocument(row) {
      const created = await dv<{ riivo_clientdocumentid: string }>('POST', 'riivo_clientdocuments?$select=riivo_clientdocumentid', await documentBody(row), { returnRow: true });
      return { id: created.riivo_clientdocumentid };
    },

    async updateClientDocument(id, row) {
      await dv('PATCH', `riivo_clientdocuments(${guid(id)})`, await documentBody(row));
    },

    async writeBlankFields(claimId, text) {
      await dv('PATCH', `riivo_claims(${guid(claimId)})`, { riivo_blankfields: text || null });
    },

    signingStep: o.signingStep ?? signingStepNotAvailable,
  };
}
