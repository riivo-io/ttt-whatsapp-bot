// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/claimpack-dataverse.ts (commit 7cb9533). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5200: the claim pack's ports (claimpack.ts ClaimPackPorts) against Dataverse, in the style of
// signing-dataverse.ts: the host passes its Dataverse call (`Dv`) and the claim folder, so this file runs unchanged in
// Tina and in the email agent and imports nothing from either.
//
// - The claim, its answers, its facts and the evidence linked to it are read as TTTFG-5176's follow-on reads them
//   (followon-dataverse.ts loadClaim), and its form the way the fill chooses it, so the score counts what Tina counts.
//   The CRM rows of the summary page are the fill's (fill-dataverse.ts crmValues).
// - riivo_completenessscore (whole number, 0 to 100) and riivo_blankfields are TTTFG-4885's columns on riivo_claim.
// - The pack is its own riivo_clientdocument row, document type "Claim pack" (a riivo_documenttype row:
//   Shared data model/TTTFG-5200/add_document_type.py makes it), linked to the claim and the client.
// - The Review item is a riivo_agentaction (Kind Review, Reason Claim pack). Until TTTFG-4853's Regarding lookup it
//   names the claim in riivo_sourcemessageid as "riivo_claim:<id>", as every claim row does (dataverse.ts). Its due
//   date is the SPEC-04 rule for a claim pack (src/core/urgency.ts REVIEW_RULES): Urgent, within 2 working hours.
// - Risk flags are riivo_claimflag rows (TTTFG-4885 step 7; TTTFG-5263 raises them), open while riivo_outcome is blank.
import { CLAIM_PACK, PACK_FOLLOW_UP, type ClaimFlag, type ClaimPackPorts, type InsurerRoute, type PackClaim, type PackFileRow, type PackItemRow, type ScoreClaim } from './claimpack';
import { dataverseClaimPorts, twoWorkingHours, type Dv } from './dataverse';
import { dataverseFillPorts, type ClaimFormFiles } from './fill-dataverse';
import { CLAIM_STATUSES, dataverseFollowOnPorts } from './followon-dataverse';
import { CLAIM_FORM_SIGNED, documentTypes } from './signing-dataverse';

// 2Tables values, the same in every environment (read from DEV on 28 Oct 2026).
const OPT = 463630000;
const KIND_REVIEW = 463630005;
const KIND_FOLLOW_UP = 463630006;
const REASON_CLAIM_PACK = 463630005;
const STATUS = { Open: 463630000, Queued: 463630001, Approved: 463630002, 'Sent back': 463630003, Done: 463630006 } as const;
const DEPARTMENT_INSURANCE = 463630002;
const URGENT = 463630000;
const CHANNEL = { email: 463630000, whatsapp: 463630001 } as const;
const CLAIM_CHANNELS = ['email', 'whatsapp'] as const;
/** riivo_provider.riivo_claimschannel (TTTFG-5204: Shared data model/TTTFG-5204/add_submission_schema.py). */
export const INSURER_CHANNELS: Record<number, 'Portal' | 'Email'> = { 463630000: 'Portal', 463630001: 'Email' };
const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
export const SUPERSEDED_NOTE = 'Superseded: the client signed again, so a new claim pack replaced this one.';
export const REMADE_NOTE = 'Superseded: the claim pack was made again for the same signature, so the new one replaced this one.';
/** riivo_donenote (2000 characters): the note, and the broker's reason for this pack, which the claim no longer holds. */
export const supersededNote = (reasonBelow100: string | null, why: 'signed-again' | 'remade' = 'signed-again') => {
  const note = why === 'remade' ? REMADE_NOTE : SUPERSEDED_NOTE;
  return (reasonBelow100 ? `${note} The reason given for submitting it below 100%: ${reasonBelow100}` : note).slice(0, 2000);
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (id: string) => {
  if (!GUID.test(id)) throw new Error(`Not a Dataverse id: ${id}`);
  return id;
};

/** The client's SharePoint claim folder: saves as the fill does, and reads a file back by its link. */
export interface ClaimPackFiles extends ClaimFormFiles {
  read(fileRef: string): Promise<Uint8Array>;
}

export interface ClaimPackDataverseOptions {
  dv: Dv;
  files: ClaimPackFiles;
}

interface DocumentRow {
  riivo_clientdocumentid: string;
  riivo_originalfilename: string | null;
  riivo_sharepointlink: string | null;
  riivo_claimitem: string;
  riivo_receivedon: string | null;
  createdon: string;
}

/** How the provider takes claims. */
export async function readInsurerRoute(dv: Dv, providerId: string): Promise<InsurerRoute> {
  const p = await dv<{ riivo_claimschannel: number | null; riivo_claimsemail: string | null }>('GET', `riivo_providers(${guid(providerId)})?$select=riivo_claimschannel,riivo_claimsemail`);
  return { channel: p.riivo_claimschannel == null ? null : INSURER_CHANNELS[p.riivo_claimschannel] ?? null, claimsEmail: p.riivo_claimsemail?.trim() || null };
}

export function dataverseClaimPackPorts(o: ClaimPackDataverseOptions): ClaimPackPorts {
  const { dv } = o;
  const refuse = (what: string) => async () => { throw new Error(`the claim pack ${what}`); };
  // TTTFG-5176's claim and form reading and TTTFG-5192's CRM reading; their sends and stores are never called here.
  const followOn = dataverseFollowOnPorts({ dv, send: refuse('sends nothing'), files: { put: refuse('stores no client files') } });
  // One per pack: the fill's ports keep each claim row they read, and a host keeps these ports for its whole life.
  const fillPorts = () => dataverseFillPorts({ dv, files: { save: refuse('saves through its own files') }, blankForm: refuse('reads no blank form') });
  const claimPorts = dataverseClaimPorts({ dv, send: refuse('sends nothing') });
  const documentTypeId = documentTypes(dv);

  return {
    async scoreClaim(claimId): Promise<ScoreClaim> {
      const [c, r] = await Promise.all([
        followOn.loadClaim(claimId),
        dv<{ riivo_completenessscore: number | null; riivo_signedon: string | null; riivo_packcompleteon: string | null }>('GET',
          `riivo_claims(${guid(claimId)})?$select=riivo_completenessscore,riivo_signedon,riivo_packcompleteon`),
      ]);
      if (!c.contactId) throw new Error(`Claim ${c.reference} has no client`);
      const form = c.claimFormId ? await followOn.claimForm(c.claimFormId)
        : (await followOn.activeClaimForm(c.providerId, c.claimType)) ?? (await followOn.genericClaimForm());
      return {
        id: c.id,
        reference: c.reference,
        contactId: c.contactId,
        owner: c.owner,
        status: c.status,
        signatureStatus: c.signatureStatus,
        signedOn: r.riivo_signedon,
        packCompleteOn: r.riivo_packcompleteon,
        evidenceComplete: c.evidenceComplete === true,
        form,
        answers: c.answers,
        facts: { ...c.facts, sapsCaseNumber: c.sapsCaseNumber, sapsStation: c.sapsStation },
        sapsRequired: c.sapsRequired,
        evidence: c.evidence,
        completenessScore: r.riivo_completenessscore ?? null,
      };
    },

    async packClaim(base): Promise<PackClaim> {
      const claimId = guid(base.id);
      const [r, docs, signed, fromFill] = await Promise.all([
        dv<{ riivo_blankfields: string | null; riivo_channel: number | null; riivo_submittedbelow100reason: string | null; _riivo_provider_value: string | null }>('GET',
          `riivo_claims(${claimId})?$select=riivo_blankfields,riivo_channel,riivo_submittedbelow100reason,_riivo_provider_value`),
        dv<{ value: DocumentRow[] }>('GET',
          'riivo_clientdocuments?$select=riivo_clientdocumentid,riivo_originalfilename,riivo_sharepointlink,riivo_claimitem,riivo_receivedon,createdon'
          + `&$filter=_riivo_claim_value eq ${claimId} and riivo_claimitem ne null and statecode eq 0&$orderby=createdon asc`),
        documentTypeId(CLAIM_FORM_SIGNED).then((typeId) => dv<{ value: { riivo_sharepointlink: string | null; riivo_originalfilename: string | null }[] }>('GET',
          'riivo_clientdocuments?$select=riivo_sharepointlink,riivo_originalfilename&$top=1&$orderby=createdon desc'
          + `&$filter=_riivo_claim_value eq ${claimId} and _riivo_documenttype_value eq ${typeId} and statecode eq 0`)),
        (async () => {
          const fill = fillPorts();
          const f = await fill.claim(claimId);
          return { claim: f, crm: await fill.crmValues(f) };
        })(),
      ]);
      const s = signed.value[0];
      // A read that fails costs the item its email, never the pack: the approval reads it again and says so (submit.ts).
      const insurerRoute: InsurerRoute = r._riivo_provider_value
        ? await readInsurerRoute(dv, r._riivo_provider_value).catch(() => ({ channel: null, claimsEmail: null }))
        : { channel: null, claimsEmail: null };
      return {
        ...base,
        insurerRoute,
        contactName: fromFill.claim.contactName ?? 'Client',
        insurer: fromFill.claim.insurer,
        claimType: fromFill.claim.claimType,
        // A row without a file still counts for the score, so the summary page and the item list it too.
        documents: docs.value
          .map((d) => ({
            id: d.riivo_clientdocumentid, fileName: d.riivo_originalfilename ?? 'file', fileRef: d.riivo_sharepointlink ?? '',
            itemKey: d.riivo_claimitem, receivedOn: d.riivo_receivedon ?? d.createdon,
          })),
        signedForm: s?.riivo_sharepointlink ? { fileRef: s.riivo_sharepointlink, fileName: s.riivo_originalfilename ?? 'Claim form (signed).pdf' } : null,
        crm: fromFill.crm,
        blankFields: r.riivo_blankfields,
        reasonBelow100: r.riivo_submittedbelow100reason?.trim() || null,
        channel: r.riivo_channel == null ? null : CLAIM_CHANNELS[r.riivo_channel - OPT] ?? null,
      };
    },

    setCompletenessScore: async (claimId, score) => void (await dv('PATCH', `riivo_claims(${guid(claimId)})`, { riivo_completenessscore: score })),

    readFile: (fileRef) => o.files.read(fileRef),

    saveToClaimFolder: (claim, fileName, bytes) =>
      o.files.save({ contactId: claim.contactId, contactName: claim.contactName, claimReference: claim.reference }, fileName, bytes),

    async filePackDocument(row: PackFileRow) {
      const typeId = await documentTypeId(CLAIM_PACK);
      const body = {
        riivo_originalfilename: row.fileName.slice(0, 400),
        riivo_sharepointlink: row.fileRef || null,
        riivo_filehash: row.fileHash,
        'riivo_DocumentType@odata.bind': `/riivo_documenttypes(${typeId})`,
        'riivo_Claim@odata.bind': `/riivo_claims(${guid(row.claimId)})`,
        'riivo_Client_contact@odata.bind': `/contacts(${guid(row.contactId)})`,
      };
      // The oldest, so two runs at once update the same row (one may have made a second).
      const found = (await dv<{ value: { riivo_clientdocumentid: string }[] }>('GET', 'riivo_clientdocuments?$select=riivo_clientdocumentid&$top=1&$orderby=createdon asc,riivo_clientdocumentid asc'
        + `&$filter=_riivo_claim_value eq ${guid(row.claimId)} and _riivo_documenttype_value eq ${typeId} and statecode eq 0`)).value[0];
      if (found) {
        await dv('PATCH', `riivo_clientdocuments(${guid(found.riivo_clientdocumentid)})`, body);
        return { id: found.riivo_clientdocumentid };
      }
      const created = await dv<{ riivo_clientdocumentid: string }>('POST', 'riivo_clientdocuments?$select=riivo_clientdocumentid', body, { returnRow: true });
      return { id: created.riivo_clientdocumentid };
    },

    async openFlags(claimId): Promise<ClaimFlag[]> {
      const r = await dv<{ value: Record<string, unknown>[] }>('GET', 'riivo_claimflags?$select=riivo_flagtype,riivo_detail&$orderby=riivo_raisedon asc'
        + `&$filter=_riivo_claim_value eq ${guid(claimId)} and riivo_outcome eq null and statecode eq 0`, undefined, { formatted: true });
      return r.value.map((f) => ({ type: String(f[`riivo_flagtype${FORMATTED}`] ?? 'Other'), detail: String(f.riivo_detail ?? '').trim() }));
    },

    async livePackItems(claimId) {
      const live = [STATUS.Open, STATUS.Queued, STATUS.Approved, STATUS['Sent back']].map((s) => `riivo_status eq ${s}`).join(' or ');
      // Oldest first, the id breaking a tie (createdon is to the second), so two runs pick the same item to keep.
      const r = await dv<{ value: { riivo_agentactionid: string }[] }>('GET', 'riivo_agentactions?$select=riivo_agentactionid&$orderby=createdon asc,riivo_agentactionid asc'
        + `&$filter=riivo_sourcemessageid eq 'riivo_claim:${guid(claimId)}' and riivo_kind eq ${KIND_REVIEW} and riivo_reviewreason eq ${REASON_CLAIM_PACK} and (${live})`);
      return r.value.map((a) => ({ id: a.riivo_agentactionid }));
    },

    supersedePackItem: async (itemId, reasonBelow100, why) => void (await dv('PATCH', `riivo_agentactions(${guid(itemId)})`, {
      riivo_status: STATUS.Done, riivo_donenote: supersededNote(reasonBelow100, why),
    })),

    async createPackItem(row: PackItemRow) {
      const created = await dv<{ riivo_agentactionid: string }>('POST', 'riivo_agentactions?$select=riivo_agentactionid', {
        riivo_name: row.title.slice(0, 300),
        riivo_kind: KIND_REVIEW,
        riivo_status: STATUS.Open,
        riivo_channel: row.claim.channel ? CHANNEL[row.claim.channel] : null,
        riivo_department: DEPARTMENT_INSURANCE,
        riivo_reviewreason: REASON_CLAIM_PACK,
        riivo_heldbackaction: JSON.stringify(row.context),
        // TTTFG-5204 AC 8: the email My Day shows on the item (TTTFG-5060).
        ...(row.context.insurerEmail ? { riivo_recipient: row.context.insurerEmail.to, riivo_subject: row.context.insurerEmail.subject.slice(0, 400), riivo_drafttext: row.context.insurerEmail.text } : {}),
        // My Day lists the pack like an email's files (src/core/attachments.ts); the evidence links are in the context.
        riivo_attachments: JSON.stringify([{ name: row.pack.fileName.slice(0, 200), contentType: 'application/pdf', size: row.pack.size }]),
        riivo_duedate: twoWorkingHours(row.at),
        riivo_urgency: URGENT,
        riivo_urgencyreason: 'Claim pack due to the insurer within 2 working hours',
        riivo_sourcemessageid: `riivo_claim:${guid(row.claim.id)}`,
        'ownerid@odata.bind': row.claim.owner.kind === 'user' ? `/systemusers(${guid(row.claim.owner.id)})` : `/teams(${guid(row.claim.owner.id)})`,
        'riivo_Client_contact@odata.bind': `/contacts(${guid(row.claim.contactId)})`,
      }, { returnRow: true });
      return { id: created.riivo_agentactionid };
    },

    setPackComplete: async (claimId, at, insurerEmail) => void (await dv('PATCH', `riivo_claims(${guid(claimId)})`, {
      riivo_claimstatus: OPT + CLAIM_STATUSES.indexOf('Pack complete'), riivo_packcompleteon: at, riivo_submittedbelow100reason: null,
      ...(insurerEmail ? { riivo_insurercontactemail: insurerEmail } : {}),
    })),

    createAgentAction: (row) => claimPorts.createAgentAction(row),

    async packFollowUpOpen(claimId) {
      const r = await dv<{ value: unknown[] }>('GET', 'riivo_agentactions?$select=riivo_agentactionid&$top=1'
        + `&$filter=riivo_sourcemessageid eq 'riivo_claim:${guid(claimId)}' and riivo_kind eq ${KIND_FOLLOW_UP} and riivo_status eq ${STATUS.Open}`
        + ` and startswith(riivo_name,'${encodeURIComponent(PACK_FOLLOW_UP)}')`);
      return r.value.length > 0;
    },
  };
}
