// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/signature-fill.ts (commit bdccfa6). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5192: the fill half of the requestClaimSignature seam (TTTFG-5248 steps 6 to 8). TTTFG-5176 (WhatsApp) and
// TTTFG-5188 (email) call it when no form answer is missing. It fills the insurer's form, or the summary sheet for the
// generic row, files it as the claim's one unsigned claim form, writes riivo_blankfields and calls the signing step
// (TTTFG-5196), returning that step's result. The step gets the filed PDF with its SHA-256 and where the signature and
// date go (signing.ts signatureStamps, or the summary sheet's lines). TTTFG-5196's step is signing.ts
// claimSigningStep, which the host passes in; a host without the signing page keeps the stub `signingStepNotAvailable`:
// the form is still filed, and TTTFG-5176 moves on to the evidence without a status change.
//
// signature.ts (TTTFG-5176) owns the default seam; this module is wired in when the branches merge.
//
// Re-fill (TTTFG-5248 step 8, `onClaimChanged`): a change to a form answer after the first fill, while the client has
// not signed, fills again, overwrites the same file and row, and calls the signing step again (TTTFG-5196 refuses the
// old link because its document hash no longer matches). Once signed, nothing is filled and the signed copy is never
// touched. The fill never runs because of evidence (riivo_evidencecomplete): the form comes before the evidence in
// TTT's claims guide, and waiting for photos would hold the signature up by days ("the second wrong turn").
//
// I/O sits behind ClaimFillPorts (Dataverse, SharePoint, the signing step), faked in the tests. fill-dataverse.ts is the
// Dataverse adapter (TTTFG-4885's riivo_claim and riivo_claimform, riivo_clientdocument); the host passes where the
// files go (the client's SharePoint claim folder) and the signing step. Policy data is read-only: nothing here writes
// to riivo_policy.
import { createHash } from 'node:crypto';
import type { ClaimAnswers, ClaimForm, RequestClaimSignature, SignatureResult } from './contracts';
import { blankFieldsText, fillClaimForm, splitKey, type BlankField, type CrmValues } from './fill';
import { signatureStamps, type SignStamp } from './signing';
import { summarySheet } from './summarysheet';

/** riivo_clientdocument document type for the filled, unsigned form. */
export const CLAIM_FORM_UNSIGNED = 'Claim form (unsigned)';
/** riivo_claim.riivo_signaturestatus (TTTFG-4885). */
export type SignatureStatus = 'Not sent' | 'Link sent' | 'Signed';

/** What the fill reads from the riivo_claim row. */
export interface ClaimForFill {
  id: string;
  contactId: string;
  /** The insurer's name (riivo_provider), for the file name. */
  insurer: string;
  /** riivo_claimtype as its label. */
  claimType: string;
  signatureStatus: SignatureStatus | null;
  /** riivo_answers (TTTFG-5176). */
  answers: ClaimAnswers;
  /** The claim reference (riivo_name, CLM-…) and the client's name: the SharePoint claim folder is named after them. */
  reference?: string;
  contactName?: string;
  /** What the Dataverse ports need to find the claim's form row and CRM rows (fill-dataverse.ts). */
  providerId?: string;
  policyId?: string;
  claimFormId?: string;
}

/** The filed, unsigned form, as the signing step receives it. */
export interface UnsignedDocument {
  fileName: string;
  /** The SharePoint item. */
  fileRef: string;
  clientDocumentId: string;
  bytes: Uint8Array;
  /** SHA-256 of `bytes`, as filed (riivo_filehash). */
  fileHash: string;
  /** TTTFG-5196: where the signing page stamps the signature and the date. */
  stamps: SignStamp[];
}

export interface ClientDocumentRow {
  claimId: string;
  contactId: string;
  documentType: typeof CLAIM_FORM_UNSIGNED;
  fileName: string;
  fileRef: string;
  /** SHA-256 of the filed PDF (riivo_filehash): TTTFG-5196 signs this hash, and a re-fill changes it. */
  fileHash?: string;
}

/** TTTFG-5196's signing step: creates the signing request, sends the link and sets the signature status to Link sent. */
export type SigningStep = (claimId: string, document: UnsignedDocument) => Promise<SignatureResult>;
/** The default until TTTFG-5196 is deployed. */
export const signingStepNotAvailable: SigningStep = async () => 'notAvailable';

export interface ClaimFillPorts {
  claim(claimId: string): Promise<ClaimForFill>;
  /** The claim's riivo_claimform row, or the generic row when its insurer has no mapped form. */
  claimForm(claim: ClaimForFill): Promise<ClaimForm>;
  /** The contact, riivo_policy, riivo_provider and riivo_claim rows a field map may read. Read only. */
  crmValues(claim: ClaimForFill): Promise<CrmValues>;
  /** The insurer's blank PDF (riivo_claimform.riivo_formurl). */
  blankForm(formPdf: string): Promise<Uint8Array>;
  /** Saves to the client's SharePoint claim folder. With `replaces`, overwrites that item rather than adding one. */
  saveToClaimFolder(claim: ClaimForFill, fileName: string, bytes: Uint8Array, replaces?: string): Promise<{ fileRef: string }>;
  /** The claim's riivo_clientdocument row of this type, if there is one. */
  findClientDocument(claimId: string, documentType: typeof CLAIM_FORM_UNSIGNED): Promise<{ id: string; fileRef: string; fileName: string } | null>;
  createClientDocument(row: ClientDocumentRow): Promise<{ id: string }>;
  updateClientDocument(id: string, row: ClientDocumentRow): Promise<void>;
  /** riivo_claim.riivo_blankfields; '' clears it. */
  writeBlankFields(claimId: string, text: string): Promise<void>;
  signingStep: SigningStep;
}

/** `Claim form - [insurer] - [claim type] - unsigned.pdf` (`signed.pdf` for TTTFG-5196's copy), without characters SharePoint refuses. */
export function claimFormFileName(insurer: string, claimType: string, state: 'unsigned' | 'signed' = 'unsigned'): string {
  const clean = (s: string) => s.replace(/["*:<>?/\\|#%]/g, '-').replace(/\s+/g, ' ').trim();
  return `Claim form - ${clean(insurer)} - ${clean(claimType)} - ${state}.pdf`;
}

export interface FillOutcome {
  result: SignatureResult;
  /** Absent when the client had already signed and nothing was filled. */
  document?: UnsignedDocument;
  blankFields: BlankField[];
}

/** Fills and files the claim's form and calls the signing step. Does nothing once the client has signed. */
export async function fillAndFile(ports: ClaimFillPorts, claimId: string): Promise<FillOutcome> {
  const claim = await ports.claim(claimId);
  // A signed form is final; 'notAvailable' leaves the claim status where it is.
  if (claim.signatureStatus === 'Signed') return { result: 'notAvailable', blankFields: [] };

  const form = await ports.claimForm(claim);
  const crm = await ports.crmValues(claim);
  const filled = form.formPdf
    ? await fillClaimForm(await ports.blankForm(form.formPdf), form, claim.answers, crm)
    : await summarySheet(form, claim.answers, crm);
  const { bytes, blankFields } = filled;
  const stamps = 'stamps' in filled ? filled.stamps : await signatureStamps(form, bytes);

  const fileName = claimFormFileName(claim.insurer, claim.claimType);
  const existing = await ports.findClientDocument(claim.id, CLAIM_FORM_UNSIGNED);
  const { fileRef } = await ports.saveToClaimFolder(claim, fileName, bytes, existing?.fileRef);
  const fileHash = createHash('sha256').update(bytes).digest('hex');
  const row: ClientDocumentRow = { claimId: claim.id, contactId: claim.contactId, documentType: CLAIM_FORM_UNSIGNED, fileName, fileRef, fileHash };
  let clientDocumentId: string;
  if (existing) {
    await ports.updateClientDocument(existing.id, row);
    clientDocumentId = existing.id;
  } else {
    clientDocumentId = (await ports.createClientDocument(row)).id;
  }
  await ports.writeBlankFields(claim.id, blankFieldsText(blankFields));

  const document: UnsignedDocument = { fileName, fileRef, clientDocumentId, bytes, fileHash, stamps };
  return { result: await ports.signingStep(claim.id, document), document, blankFields };
}

/** The seam TTTFG-5176 calls when the last form question is answered. */
export function requestClaimSignature(ports: ClaimFillPorts): RequestClaimSignature {
  return async (claimId) => (await fillAndFile(ports, claimId)).result;
}

// ---------------------------------------------------------------- re-fill

/** A change to a riivo_claim row: the logical names of the changed columns, with riivo_answers before and after when known. */
export interface ClaimChange {
  columns: string[];
  answersBefore?: ClaimAnswers;
  answersAfter?: ClaimAnswers;
}

export type RefillSkip =
  /** No form answer changed: evidence (riivo_evidencecomplete) and every other column never trigger a fill. */
  | 'not-answers'
  /** riivo_answers was rewritten, but no answer the form uses changed (an evidence item, or the same values again). */
  | 'unchanged'
  | 'signed'
  /** No form filed yet: the client is still answering and TTTFG-5176 calls the seam after the last answer. */
  | 'not-filled-yet';

/**
 * The answer keys (without group entry numbers) that change what's on the form: the field map's answers, the answers
 * its conditions test, and, following each, the question's own and its group's onlyIf and the rest of its group (any
 * answer in a group can add an entry). For the generic row, its questions.
 */
export function formAnswerKeys(form: ClaimForm): Set<string> {
  const keys = new Set<string>();
  const answerKey = (k: string | undefined) => k && !k.startsWith('crm:') && keys.add(k);
  if (!form.formPdf) {
    for (const q of form.questionList) if (q.kind === 'question') keys.add(q.key);
  } else {
    for (const e of form.fieldMap) {
      if (e.source.startsWith('answer:')) keys.add(splitKey(e.source.slice('answer:'.length)).base);
      answerKey(e.when?.key);
    }
  }
  for (let size = -1; size !== keys.size;) {
    size = keys.size;
    for (const q of form.questionList.filter((x) => keys.has(x.key))) {
      answerKey(q.onlyIf?.key);
      if (!q.group) continue;
      answerKey(form.questionGroups.find((g) => g.key === q.group)?.onlyIf?.key);
      for (const other of form.questionList) if (other.group === q.group) keys.add(other.key);
    }
  }
  return keys;
}

/** True when an answer the form uses differs in value or status. The answer's time and message id don't count. */
export function formAnswersChanged(form: ClaimForm, before: ClaimAnswers, after: ClaimAnswers): boolean {
  const keys = formAnswerKeys(form);
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!keys.has(splitKey(k).base) && !keys.has(k)) continue;
    if (before[k]?.value !== after[k]?.value || before[k]?.status !== after[k]?.status) return true;
  }
  return false;
}

/** TTTFG-5248 step 8 as a pure decision. Without the before and after answers, a change to riivo_answers counts. */
export function refillDecision(
  change: ClaimChange, signatureStatus: SignatureStatus | null, filed: boolean, form: ClaimForm,
): 'fill' | RefillSkip {
  if (!change.columns.includes('riivo_answers')) return 'not-answers';
  if (signatureStatus === 'Signed') return 'signed';
  if (!filed) return 'not-filled-yet';
  if (change.answersBefore && change.answersAfter && !formAnswersChanged(form, change.answersBefore, change.answersAfter)) return 'unchanged';
  return 'fill';
}

/** Handles a riivo_claim change: fills again when the decision says so. */
export async function onClaimChanged(ports: ClaimFillPorts, claimId: string, change: ClaimChange): Promise<{ refilled: FillOutcome } | { skipped: RefillSkip }> {
  if (!change.columns.includes('riivo_answers')) return { skipped: 'not-answers' }; // no reads for an evidence change
  const claim = await ports.claim(claimId);
  const filed = (await ports.findClientDocument(claimId, CLAIM_FORM_UNSIGNED)) !== null;
  const decision = refillDecision(change, claim.signatureStatus, filed, await ports.claimForm(claim));
  if (decision !== 'fill') return { skipped: decision };
  return { refilled: await fillAndFile(ports, claimId) };
}
