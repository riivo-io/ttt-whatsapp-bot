// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/signing.ts (commit 05d65be). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5196: the claim's side of the signing page. The page itself (Tina's src/signing/) is generic: it takes a PDF,
// its SHA-256, the channel with the number or address the link went to, where to stamp and a callback URL, and knows
// nothing about claims ("the one wrong turn": never build the page around riivo_claim). Everything claim-shaped is here:
//
// - signatureStamps(): where the client's signature and the date go, from the form's `sign` boxes (TTTFG-5172 config).
//   The summary sheet returns its own (summarysheet.ts).
// - claimSigningStep(): the signing step TTTFG-5192's fill calls with the filed, unsigned form (TTTFG-5252 step 4). It
//   creates the signing request, sends the "ready to sign" link on the claim's own channel (never both), sets the
//   signature status to Link sent and answers 'sent'. TTTFG-5176 (WhatsApp) and TTTFG-5188 (email) set Form sent from
//   that answer; nothing here sets the claim status. When the template isn't signed off, the claim has nowhere to send
//   the link, or the host can't send on that channel yet (email, until TTTFG-4973), it sends nothing, gives the claim
//   owner a Follow-up and answers 'notAvailable', so Tina carries on with the evidence.
// - onClaimFormSigned(): the page's callback (step 9). The signed copy goes to the claim folder as its own
//   riivo_clientdocument ("Claim form (signed)"), and riivo_claim gets Signed, signed on and the audit JSON. The
//   unsigned form and its row stay as they are. Signed is written last: the page calls back until it gets an answer,
//   and a callback that failed half way (the CRM timed out) runs again in full rather than being taken as done.
//
// A re-fill (signature-fill.ts onClaimChanged) calls the signing step again: the page supersedes the earlier request,
// so its link stops working, and the client gets the new one. Once signed, nothing is filled or sent again.
//
// I/O sits behind ports (signing-dataverse.ts is the Dataverse adapter; the host adds the page and the senders).
import { createHash } from 'node:crypto';
import { PDFDocument, type PDFPage, type PDFRef } from 'pdf-lib';
import { DEPARTMENT, type AgentActionRow, type Owner } from './claim';
import type { ClaimForm, SignatureResult } from './contracts';
import type { ClaimForFill, SigningStep, UnsignedDocument } from './signature-fill';
import { claimFormFileName } from './signature-fill';
import { SIGN_FORM_TEMPLATE } from './templates';

export type SignChannel = 'whatsapp' | 'email';
const CHANNEL_NAME: Record<SignChannel, string> = { whatsapp: 'WhatsApp', email: 'email' };

/**
 * Where the signing page stamps, in PDF points from the page's bottom-left, 1-based page. A signature is drawn to fit
 * its box; a date is written with its baseline at x, y, smaller when it's wider than `maxWidth`.
 */
export type SignStamp =
  | { kind: 'signature'; page: number; x: number; y: number; width: number; height: number }
  | { kind: 'date'; page: number; x: number; y: number; size: number; maxWidth?: number; format?: 'date' | 'day' | 'month' | 'yy' };

const DATE_SIZE = 10;
/** How far below a flat form's signature line the signature may reach (a signature's tail hangs below the line). */
const BELOW_LINE = 2;

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------- where to stamp

/** The page (1-based) and rectangle of each widget of a named field. */
function widgetRects(doc: PDFDocument, name: string): { page: number; x: number; y: number; width: number; height: number }[] {
  const field = doc.getForm().getFieldMaybe(name);
  if (!field) return [];
  const pages = doc.getPages();
  // A widget names its page (/P) in most PDFs; otherwise find the page whose annotations hold it.
  let refs: Map<unknown, PDFRef> | undefined;
  const pageOf = (dict: object, p: PDFRef | undefined) => {
    const byP = p ? pages.findIndex((page: PDFPage) => page.ref === p) : -1;
    if (byP >= 0) return byP;
    refs ??= new Map(doc.context.enumerateIndirectObjects().map(([ref, obj]) => [obj, ref] as const));
    const ref = refs.get(dict);
    return pages.findIndex((page) => (page.node.Annots()?.asArray() ?? []).some((a) => a === ref));
  };
  return field.acroField.getWidgets().flatMap((w) => {
    const i = pageOf(w.dict, w.P());
    if (i < 0) return [];
    const r = w.getRectangle();
    return [{ page: i + 1, x: r.x, y: r.y, width: r.width, height: r.height }];
  });
}

/**
 * The stamps for a filled insurer form: each `sign` box in the field map. A field's box is its widget; a position is
 * the line signed on (x, y, `maxWidth`, `height` above it) or where the date's text sits.
 */
export async function signatureStamps(form: ClaimForm, pdf: Uint8Array): Promise<SignStamp[]> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const stamps: SignStamp[] = [];
  for (const e of form.fieldMap) {
    if (!e.sign) continue;
    const t = e.target;
    const format = e.dateFormat && e.dateFormat !== 'date' ? { format: e.dateFormat } : {};
    if ('pdfField' in t) {
      for (const r of widgetRects(doc, t.pdfField)) {
        if (e.sign === 'signature') stamps.push({ kind: 'signature', page: r.page, x: r.x + 2, y: r.y + 2, width: r.width - 4, height: r.height - 4 });
        else {
          const size = Math.min(DATE_SIZE, r.height - 4);
          stamps.push({ kind: 'date', page: r.page, x: r.x + 3, y: r.y + (r.height - size) / 2 + size * 0.2, size, maxWidth: r.width - 6, ...format });
        }
      }
    } else if (e.sign === 'signature') {
      stamps.push({ kind: 'signature', page: t.page, x: t.x, y: t.y - BELOW_LINE, width: t.maxWidth ?? 0, height: (t.height ?? 0) + BELOW_LINE });
    } else {
      stamps.push({ kind: 'date', page: t.page, x: t.x, y: t.y, size: t.size ?? DATE_SIZE, ...(t.maxWidth ? { maxWidth: t.maxWidth } : {}), ...format });
    }
  }
  return stamps;
}

// ---------------------------------------------------------------- the signing step

/** What the signing step reads about the claim. */
export interface SigningClaim {
  id: string;
  reference: string;
  contactId: string;
  firstName: string;
  insurer: string;
  claimType: string;
  owner: Owner;
  /** riivo_claim.riivo_channel; null when the claim has none. */
  channel: SignChannel | null;
  /** The client's WhatsApp number, for a WhatsApp claim. */
  whatsApp: string | null;
  /** The email address on the claim, for an email claim. */
  email: string | null;
}

/** A request on the signing page. The host adds its callback URL. */
export interface SigningRequestInput {
  document: Uint8Array;
  documentHash: string;
  fileName: string;
  /** What the client reads above the form. */
  title: string;
  channel: SignChannel;
  sentTo: string;
  caller: 'claim';
  callerRecordId: string;
  stamps: SignStamp[];
}
export interface SigningRequestCreated { id: string; link: string; expiresAt: string }

export interface LinkMessage {
  template: { name: string; version: string };
  text: string;
  /** The WhatsApp template's variables, for a send outside the 24-hour window. */
  params: string[];
  subject: string;
}

export interface ClaimSigningPorts {
  signingClaim(claimId: string): Promise<SigningClaim>;
  /** TTTFG-4869: the template is signed off (broker lead and FAIS reviewer) and, on WhatsApp, approved by Meta. */
  signedOff(template: typeof SIGN_FORM_TEMPLATE, channel: SignChannel): boolean;
  createSigningRequest(input: SigningRequestInput): Promise<SigningRequestCreated>;
  /** A sender per channel the host can send on: WhatsApp through Tina's sender, email through TTTFG-4973's path. */
  send: Partial<Record<SignChannel, (to: string, message: LinkMessage) => Promise<void>>>;
  setLinkSent(claimId: string): Promise<void>;
  createAgentAction(row: AgentActionRow): Promise<unknown>;
  now?(): Date;
}

const sastDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

/** TTTFG-5252 step 4, as TTTFG-5192's SigningStep. */
export function claimSigningStep(ports: ClaimSigningPorts): SigningStep {
  return async (claimId: string, document: UnsignedDocument): Promise<SignatureResult> => {
    const claim = await ports.signingClaim(claimId);
    const at = (ports.now?.() ?? new Date()).toISOString();
    const followUp = async (why: string) => {
      await ports.createAgentAction({
        kind: 'Follow-up', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claimId }, contactId: claim.contactId, at,
        detail: `The claim form for ${claim.reference} is filled and filed, but no signing link went to the client: ${why}. Please send the client the form to sign.`,
      });
      return 'notAvailable' as const;
    };

    if (!claim.channel) return followUp('the claim has no channel');
    const name = CHANNEL_NAME[claim.channel];
    const to = claim.channel === 'whatsapp' ? claim.whatsApp : claim.email;
    if (!to) return followUp(`there is no ${claim.channel === 'whatsapp' ? 'WhatsApp number' : 'email address'} on the claim`);
    const send = ports.send[claim.channel];
    if (!send) return followUp(`signing links can't go out on ${name} yet`);
    const t = SIGN_FORM_TEMPLATE;
    if (!ports.signedOff(t, claim.channel)) return followUp(`the "${t.name}" message (${t.version}) isn't signed off for ${name}`);
    if (!document.stamps?.some((s) => s.kind === 'signature')) return followUp('the form has no signature box marked');

    let sentText: string;
    try {
      const request = await ports.createSigningRequest({
        document: document.bytes, documentHash: document.fileHash ?? sha256(document.bytes), fileName: document.fileName,
        title: `Claim form for ${claim.insurer} (${claim.reference})`, channel: claim.channel, sentTo: to,
        caller: 'claim', callerRecordId: claimId, stamps: document.stamps,
      });
      const vars = { firstName: claim.firstName, insurer: claim.insurer, reference: claim.reference, link: request.link, expiresOn: sastDate(new Date(request.expiresAt)) };
      sentText = t.render(vars);
      await send(to, { template: { name: t.name, version: t.version }, text: sentText, params: [...t.params(vars)], subject: t.emailSubject(vars) });
    } catch (e) {
      return followUp(`the link could not be sent (${(e as Error).message.slice(0, 300)})`);
    }
    await ports.setLinkSent(claimId);
    await ports.createAgentAction({
      kind: 'Created', department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claimId }, contactId: claim.contactId, at,
      detail: `${t.name} sent on ${name} for claim ${claim.reference}.`, template: { name: t.name, version: t.version, text: sentText },
    });
    return 'sent';
  };
}

// ---------------------------------------------------------------- the callback

/** What the signing page records with every signature (riivo_claim.riivo_signatureaudit). */
export interface SignatureAudit {
  requestId: string;
  signedAt: string;
  ip: string | null;
  userAgent: string | null;
  channel: SignChannel;
  /** The number or address the link was sent to. */
  sentTo: string;
  /** SHA-256 of the unsigned PDF the client saw, checked again when they signed. */
  documentHash: string;
  /** SHA-256 of the signed PDF. */
  signedHash: string;
  linkCreatedAt: string;
  openedAt: string | null;
}

export interface SignedCallback {
  requestId: string;
  caller: string;
  callerRecordId: string;
  signedPdf: Uint8Array;
  audit: SignatureAudit;
}

export interface SignedClaim extends ClaimForFill {
  reference: string;
  owner: Owner;
  /** riivo_claim.riivo_signatureaudit as stored. */
  signatureAudit: string | null;
  /** riivo_filehash of the claim's unsigned form: the request must be for exactly this document. */
  unsignedHash: string | null;
}

export interface ClaimSignedPorts {
  signedClaim(claimId: string): Promise<SignedClaim>;
  /** Saves to the claim folder, replacing a file of the same name (a callback that runs again). */
  saveToClaimFolder(claim: SignedClaim, fileName: string, bytes: Uint8Array): Promise<{ fileRef: string }>;
  /** The claim's "Claim form (signed)" row, if a callback that failed half way already made it. */
  findSignedDocument(claimId: string): Promise<{ id: string } | null>;
  createSignedDocument(row: { claimId: string; contactId: string; fileName: string; fileRef: string; fileHash: string }): Promise<{ id: string }>;
  markSigned(claimId: string, signedOn: string, audit: string): Promise<void>;
  createAgentAction(row: AgentActionRow): Promise<unknown>;
}

export type SignedOutcome =
  | { filed: { fileRef: string; documentId: string } }
  /** The same callback again (the page retries until it's answered). */
  | { skipped: 'already-signed' }
  | { skipped: 'not-a-claim' }
  /** The request was for an earlier fill of the form; the owner has a Follow-up. */
  | { skipped: 'stale-document' };

/** TTTFG-5252 step 9. */
export async function onClaimFormSigned(ports: ClaimSignedPorts, cb: SignedCallback): Promise<SignedOutcome> {
  if (cb.caller !== 'claim') return { skipped: 'not-a-claim' };
  const claim = await ports.signedClaim(cb.callerRecordId);
  if (claim.signatureStatus === 'Signed') return { skipped: 'already-signed' };
  const actionBase: Omit<AgentActionRow, 'kind' | 'detail'> = {
    department: DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim', id: claim.id }, contactId: claim.contactId, at: cb.audit.signedAt,
  };
  if (claim.unsignedHash && claim.unsignedHash !== cb.audit.documentHash) {
    await ports.createAgentAction({
      ...actionBase, kind: 'Follow-up',
      detail: `The client signed an earlier version of the claim form for ${claim.reference} (signing request ${cb.requestId}); the form was filled again after that link went out. It was not filed. Please check the client got the latest link.`,
    });
    return { skipped: 'stale-document' };
  }
  const fileName = claimFormFileName(claim.insurer, claim.claimType, 'signed');
  const { fileRef } = await ports.saveToClaimFolder(claim, fileName, cb.signedPdf);
  const { id } = (await ports.findSignedDocument(claim.id))
    ?? await ports.createSignedDocument({ claimId: claim.id, contactId: claim.contactId, fileName, fileRef, fileHash: sha256(cb.signedPdf) });
  await ports.createAgentAction({
    ...actionBase, kind: 'Created',
    detail: `The client signed the claim form for ${claim.reference} on the signing page (link sent on ${CHANNEL_NAME[cb.audit.channel]} to ${cb.audit.sentTo}).`,
  });
  await ports.markSigned(claim.id, cb.audit.signedAt, JSON.stringify(cb.audit));
  return { filed: { fileRef, documentId: id } };
}
