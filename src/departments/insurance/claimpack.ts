// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/claimpack.ts (commit 0bdca86). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5200: the claim pack. Once the client has signed and every required item is in, the agent puts the claim
// together for the broker: the signed form, a one-page summary and the evidence, with a completeness score.
//
// The score (AC 6) is the share of the claim form's evidence checklist received: evidence items received over every
// evidence item that applies to this claim, required and optional, as a whole percentage. An item whose condition
// doesn't hold ("If the car was found damaged: …" on a car never found) isn't on this claim's checklist, so a claim
// with everything it can have scores 100. The signed form is the pack's precondition, not a checklist item. The score
// is worked out again every time evidence reaches the claim, also after the pack exists (a late optional item lifts
// it), by updateClaimPack: Tina's follow-on calls it after a turn that filed something, and the email agent
// (TTTFG-5188) calls it after it links an email's files to a claim.
//
// The pack (AC 1, 4, 5) is one PDF: the signed form, the summary page, then every evidence PDF received. Photos and
// videos stay separate files: the Review item links them (TTTFG-5256 step 5). An evidence PDF that won't open (a
// password, a broken file) is linked the same way rather than dropped. The pack goes to the claim folder and gets its
// own riivo_clientdocument row, document type "Claim pack".
//
// The one wrong turn to avoid (TTTFG-5256): no signature, no pack, whatever else the claim holds (SPEC-04 user story
// 14: no claim goes to an insurer without the client's signature and the broker's approval). The pack goes to the
// insurer, so the summary page never shows the score or a risk flag: those are for the broker (POPIA section 71).
//
// The broker sees the pack as one Review item in My Day (AC 2, 7): reason Claim pack, Insurance and Advice, owned by
// the claim owner, about the claim. Its context (riivo_heldbackaction, kind "claim-pack") holds the score, the missing
// checklist items by name, the open risk flags with their type and detail ("No open flags" when there are none:
// TTTFG-5263 raises them as riivo_claimflag rows, open while their outcome is blank), the pack and the evidence links.
// TTTFG-5060's panel shows it. Making the item sets the claim to Pack complete and stamps riivo_packcompleteon (AC 3),
// which TTTFG-5267's 3-working-hour clock reads. A pack made again (a new signature, AC 9) closes the claim's earlier
// live pack items as Superseded first, so the broker never sees two.
import { PDFDocument, StandardFonts, type PDFPage } from 'pdf-lib';
import { DEPARTMENT, PACK_FOLLOW_UP, type AgentActionRow, type Owner } from './claim';
import type { ClaimAnswers, ClaimForm, QuestionItem } from './contracts';
import { formatText, type CrmValues } from './fill';
import { CLAIM_TO_INSURER_TEMPLATE } from './templates';
import type { ClaimStatus, SignatureStatus } from './followon';
import { applies, entryWord, evidenceIn, formItems, itemName, type ClaimFacts, type ReceivedEvidence } from './progress';
import { sha256 } from './signing';
import { drawBlocks, fitSize, paragraph, sectionedRows, summaryRows, type SummaryRow } from './summarysheet';

/** riivo_documenttype of the pack, and riivo_agentaction.riivo_reviewreason of its Review item. */
export const CLAIM_PACK = 'Claim pack';

export interface Completeness {
  /** 0 to 100. A claim with no evidence item on its checklist scores 100. */
  score: number;
  /** The checklist items that apply to this claim, in the list's order. */
  items: QuestionItem[];
  /** Those not received yet, required and optional. */
  missing: QuestionItem[];
}

export interface CompletenessOptions {
  facts?: ClaimFacts;
  sapsRequired?: boolean;
}

/** AC 6: the claim's completeness score. Pure. */
export function completeness(form: ClaimForm, answers: ClaimAnswers, evidence: ReceivedEvidence, o: CompletenessOptions = {}): Completeness {
  const items = formItems(form, answers, o.facts, o.sapsRequired).filter((i) => i.kind === 'evidence' && applies(i, answers, o.facts));
  const missing = items.filter((i) => !evidenceIn(i, evidence));
  const score = items.length ? Math.floor((100 * (items.length - missing.length)) / items.length) : 100;
  return { score, items, missing };
}

/** A riivo_clientdocument row linked to the claim as evidence (riivo_claimitem set). */
export interface PackDocument {
  id: string;
  fileName: string;
  /** riivo_sharepointlink; '' when the row has no file (SharePoint refused it): listed, never in the pack. */
  fileRef: string;
  /** riivo_claimitem: the question list item it answers. */
  itemKey: string;
  /** riivo_receivedon, else when the row was made. */
  receivedOn: string | null;
}

/** What the score and the pack's preconditions read from the claim: every evidence turn reads this much. */
export interface ScoreClaim {
  id: string;
  reference: string;
  contactId: string;
  owner: Owner;
  status: ClaimStatus;
  signatureStatus: SignatureStatus;
  /** riivo_signedon: when the client signed (TTTFG-5196); a new signature moves it on. */
  signedOn: string | null;
  /** riivo_packcompleteon: when the last pack was made. */
  packCompleteOn: string | null;
  /** riivo_evidencecomplete: every required item is in. */
  evidenceComplete: boolean;
  form: ClaimForm;
  answers: ClaimAnswers;
  facts?: ClaimFacts;
  sapsRequired?: boolean;
  /** riivo_clientdocument rows linked to the claim, by question list item. */
  evidence: ReceivedEvidence;
  /** riivo_claim.riivo_completenessscore as stored; null before the first score. */
  completenessScore: number | null;
}

/** What the pack reads besides, once one is due. */
export interface PackClaim extends ScoreClaim {
  contactName: string;
  insurer: string;
  claimType: string;
  /** The evidence documents, in the order they arrived. */
  documents: PackDocument[];
  /** The claim's "Claim form (signed)" document, the newest. */
  signedForm: { fileRef: string; fileName: string } | null;
  /** The CRM rows the summary page reads, as the fill reads them (fill-dataverse.ts crmValues). */
  crm: CrmValues;
  /** riivo_claim.riivo_blankfields: the boxes the fill left empty, one line each (fill.ts blankFieldsText). */
  blankFields: string | null;
  /** riivo_submittedbelow100reason: the broker's reason for the live pack, cleared when a new pack is made. */
  reasonBelow100: string | null;
  /** riivo_claim.riivo_channel: where the claim came in; the Review item carries it. */
  channel: 'email' | 'whatsapp' | null;
  /** TTTFG-5204: how the insurer takes claims (riivo_provider.riivo_claimschannel) and where (riivo_claimsemail). */
  insurerRoute: InsurerRoute;
}

/** How an insurer takes claims. A provider with no channel set is treated as a portal: nothing is ever emailed to it. */
export interface InsurerRoute { channel: 'Portal' | 'Email' | null; claimsEmail: string | null }

/** TTTFG-5204 AC 8: the email to the insurer, shown on the Review item for the broker to approve. */
export interface InsurerEmail { to: string; subject: string; text: string }

export interface PackFileRow { claimId: string; contactId: string; fileName: string; fileRef: string; fileHash: string }

/** An open riivo_claimflag row (TTTFG-5263): outcome blank. */
export interface ClaimFlag { type: string; detail: string }

/** The Review item's context: riivo_agentaction.riivo_heldbackaction, for TTTFG-5060's claim pack panel. */
export interface PackContext {
  kind: 'claim-pack';
  version: 1;
  claimId: string;
  reference: string;
  score: number;
  /** The checklist items not received, by name. */
  missing: string[];
  flags: ClaimFlag[];
  pack: { documentId: string; fileName: string; fileRef: string };
  evidence: PackEvidence[];
  /** The same in one paragraph, for a pane that shows text. */
  text: string;
  /** TTTFG-5204 AC 8: for an insurer that takes claims by email. The pack above is its attachment. */
  insurerEmail?: InsurerEmail;
}

export interface PackItemRow {
  claim: Pick<PackClaim, 'id' | 'reference' | 'contactId' | 'owner' | 'channel'>;
  /** riivo_name. */
  title: string;
  context: PackContext;
  pack: BuiltPack;
  at: string;
}

export interface ClaimPackPorts {
  /** Every evidence turn: only what the score and noPack need. */
  scoreClaim(claimId: string): Promise<ScoreClaim>;
  /** The rest of what the pack reads, once one is due, on top of what scoreClaim read. */
  packClaim(claim: ScoreClaim): Promise<PackClaim>;
  /** riivo_claim.riivo_completenessscore. */
  setCompletenessScore(claimId: string, score: number): Promise<void>;
  /** A file in the claim folder, by its riivo_sharepointlink. */
  readFile(fileRef: string): Promise<Uint8Array>;
  /** Saves to the claim folder, replacing a file of the same name (a pack built again for the same signature). */
  saveToClaimFolder(claim: PackClaim, fileName: string, bytes: Uint8Array): Promise<{ fileRef: string }>;
  /** The pack's riivo_clientdocument row ("Claim pack"): the claim's row of this file name, updated, else a new one. */
  filePackDocument(row: PackFileRow): Promise<{ id: string }>;
  /** The claim's riivo_claimflag rows with no outcome yet, oldest first. */
  openFlags(claimId: string): Promise<ClaimFlag[]>;
  /** The claim's Claim pack Review items a person may still act on (Open, Queued, Approved, Sent back), oldest first. */
  livePackItems(claimId: string): Promise<{ id: string }[]>;
  /**
   * Done, with the note that a newer pack replaced it (`why`: the client signed again, or the pack was made again for
   * the same signature after a run that didn't finish), and the reason the broker gave for submitting it below 100%.
   */
  supersedePackItem(itemId: string, reasonBelow100: string | null, why: 'signed-again' | 'remade'): Promise<void>;
  createPackItem(row: PackItemRow): Promise<{ id: string }>;
  /**
   * riivo_claimstatus Pack complete and riivo_packcompleteon, and riivo_submittedbelow100reason cleared: a reason is
   * for one pack, so the new one needs its own. The cover columns are left as they are (TTTFG-5204). `insurerEmail`:
   * riivo_insurercontactemail, which My Day reads to show a pack as going by email (TTTFG-5060).
   */
  setPackComplete(claimId: string, at: string, insurerEmail?: string): Promise<void>;
  createAgentAction(row: AgentActionRow): Promise<unknown>;
  /** Whether the claim owner already has an open claim pack Follow-up (PACK_FOLLOW_UP) on this claim. */
  packFollowUpOpen(claimId: string): Promise<boolean>;
}

export { PACK_FOLLOW_UP };

/** Why a claim gets no pack now. */
export type NoPack = 'not-signed' | 'evidence-incomplete' | 'past-pack' | 'already-packed';

/** The statuses a pack may still be made in: after submission, the insurer has the claim. */
const PACK_STAGES: readonly ClaimStatus[] = ['FNOL logged', 'Cover verified', 'Form sent', 'Awaiting client docs', 'Pack complete'];

/**
 * AC 4: a pack only for a signed claim with every required item in, before it goes to the insurer. AC 9: one pack per
 * signature. A pack made at or after the signature is this signature's: a late optional item only lifts the score,
 * and the callback run again finds its pack made. A new signature (riivo_signedon later than the pack) makes a new one.
 */
export function noPack(claim: Pick<ScoreClaim, 'signatureStatus' | 'evidenceComplete' | 'status' | 'signedOn' | 'packCompleteOn'>): NoPack | null {
  if (claim.signatureStatus !== 'Signed') return 'not-signed';
  if (!claim.evidenceComplete) return 'evidence-incomplete';
  if (!PACK_STAGES.includes(claim.status)) return 'past-pack';
  if (claim.packCompleteOn && (!claim.signedOn || Date.parse(claim.packCompleteOn) >= Date.parse(claim.signedOn))) return 'already-packed';
  // Pack complete with no time: a person set it after a run that couldn't stamp it (its Follow-up asks them to). The
  // item that run made stands; making the pack again would supersede what the broker may have approved.
  if (claim.status === 'Pack complete' && !claim.packCompleteOn) return 'already-packed';
  return null;
}

/** One evidence document on the summary page and on the Review item. */
export interface PackEvidence {
  name: string;
  fileName: string;
  fileRef: string;
  receivedOn: string | null;
  /** In the pack PDF; false for a photo, a video or a PDF that won't open, which the Review item links. */
  inPack: boolean;
}

export interface BuiltPack {
  documentId: string;
  fileName: string;
  fileRef: string;
  size: number;
  evidence: PackEvidence[];
}

export type PackOutcome =
  | { score: number; built: BuiltPack & { itemId: string; superseded: string[] } }
  | { score: number; skipped: NoPack }
  /** The pack couldn't be built (a file unreadable, say); the claim owner has a Follow-up. */
  | { score: number; failed: string };

/**
 * The one hook for "evidence reached this claim" and "the client signed": the score is worked out again and written
 * when it changed, then the pack is built if the claim is ready for one.
 */
export async function updateClaimPack(ports: ClaimPackPorts, claimId: string, at: string): Promise<PackOutcome> {
  const base = await ports.scoreClaim(claimId);
  const c = completeness(base.form, base.answers, base.evidence, { facts: base.facts, sapsRequired: base.sapsRequired });
  if (base.completenessScore !== c.score) await ports.setCompletenessScore(claimId, c.score);
  const why = noPack(base);
  if (why) return { score: c.score, skipped: why };
  // What is done when a step fails, for the owner's Follow-up.
  let stage: 'build' | 'item' | 'status' = 'build';
  let fileName = packFileName(base.reference);
  try {
    const claim = await ports.packClaim(base);
    const pack = await buildPack(ports, claim);
    fileName = pack.fileName;
    const flags = await ports.openFlags(claim.id);
    const context = packContext(claim, c, flags, pack);
    const email = insurerEmailFor(claim);
    if (email) context.insurerEmail = email;
    // AC 9: the earlier item first, so a failure in between never leaves two live pack items. Without a pack complete
    // time the earlier item is this signature's own, from a run that didn't finish: it was made again, not re-signed.
    stage = 'item';
    const why = claim.packCompleteOn ? 'signed-again' : 'remade';
    const superseded: string[] = [];
    for (const { id } of await ports.livePackItems(claim.id)) {
      await ports.supersedePackItem(id, claim.reasonBelow100, why);
      superseded.push(id);
    }
    const title = `Claim pack ${claim.reference}: ${c.score}% complete${flags.length ? `, ${flags.length} open flag${flags.length === 1 ? '' : 's'}` : ''}`;
    const { id: created } = await ports.createPackItem({ claim, title, context, pack, at });
    // Two runs at once (the signing callback and an evidence turn) both made an item: every run keeps the oldest, so
    // they agree on which one stays.
    const live = await ports.livePackItems(claim.id);
    const itemId = live[0]?.id ?? created;
    for (const { id } of live.slice(1)) await ports.supersedePackItem(id, null, 'remade');
    stage = 'status';
    // Never before the signature: the signing page keeps its own clock, and a pack stamped before its signature would
    // look like an earlier signature's (noPack) and be made again.
    const stamp = claim.signedOn && Date.parse(claim.signedOn) > Date.parse(at) ? claim.signedOn : at;
    await ports.setPackComplete(claim.id, stamp, email?.to);
    return { score: c.score, built: { ...pack, itemId, superseded } };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ').slice(0, 300);
    // A failure that repeats (a file that can't be read) would otherwise raise one on every evidence turn.
    if (!(await ports.packFollowUpOpen(base.id))) {
      const what = {
        build: `the client signed and every required item is in, but the agent could not build the pack: ${msg}. Please put the pack together by hand, or ask riivo to run it again.`,
        item: `the agent built the pack (${fileName} in the claim folder) but could not put it in My Day: ${msg}. Please review the pack from the claim folder, or ask riivo to run it again.`,
        status: `the pack is in My Day, but the agent could not set the claim to Pack complete: ${msg}. Please set Pack complete on the claim.`,
      }[stage];
      await ports.createAgentAction({
        kind: 'Follow-up', department: DEPARTMENT, owner: base.owner, regarding: { table: 'riivo_claim', id: base.id }, contactId: base.contactId, at,
        detail: `${PACK_FOLLOW_UP}${base.reference}: ${what}`,
      });
    }
    return { score: c.score, failed: msg };
  }
}

const isPdf = (fileName: string) => /\.pdf$/i.test(fileName);
const clean = (s: string) => s.replace(/["*:<>?/\\|#%]/g, '-').replace(/\s+/g, ' ').trim();

/** `Claim pack - CLM-000300.pdf`: one file per claim, replaced when the pack is built again. */
export const packFileName = (reference: string) => `Claim pack - ${clean(reference)}.pdf`;

/** The pack PDF: the signed form, the summary page, the evidence PDFs that open. Saved and filed. */
export async function buildPack(ports: ClaimPackPorts, claim: PackClaim): Promise<BuiltPack> {
  if (!claim.signedForm) throw new Error('there is no signed claim form on the claim');
  const out = await PDFDocument.create();
  out.setTitle(`Claim pack - ${claim.reference}`);
  const append = async (bytes: Uint8Array, o: { ignoreEncryption?: boolean } = {}) => {
    const src = await PDFDocument.load(bytes, o);
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  };
  // The signed form is the package's own PDF, filled from the insurer's blank (fill.ts reads those the same way).
  await append(await ports.readFile(claim.signedForm.fileRef), { ignoreEncryption: true });

  // As the checklist is: an entry of a repeating group is filed as `<key>.<n>`.
  const byItem = new Map(formItems(claim.form, claim.answers, claim.facts, claim.sapsRequired).map((q) => [q.key, q]));
  const evidence: PackEvidence[] = [];
  const copied: PDFPage[][] = [];
  for (const d of claim.documents) {
    const item = byItem.get(d.itemKey);
    const e: PackEvidence = { name: item ? itemName(item) : d.itemKey, fileName: d.fileName, fileRef: d.fileRef, receivedOn: d.receivedOn, inPack: false };
    if (isPdf(d.fileName) && d.fileRef) {
      // A read that fails (SharePoint throttling, say) fails the build, so the next run tries again: the pack is final
      // once made. A password or a broken file is linked instead. pdf-lib loads leniently, so a broken file can load
      // and then fail to copy: its pages are copied here, and added after the summary page.
      const bytes = await ports.readFile(d.fileRef);
      try {
        const src = await PDFDocument.load(bytes);
        copied.push(await out.copyPages(src, src.getPageIndices()));
        e.inPack = true;
      } catch { /* linked on the Review item */ }
    }
    evidence.push(e);
  }
  await append(await packSummary(claim, evidence));
  for (const page of copied.flat()) out.addPage(page);

  const bytes = await out.save();
  const fileName = packFileName(claim.reference);
  const { fileRef } = await ports.saveToClaimFolder(claim, fileName, bytes);
  const { id } = await ports.filePackDocument({ claimId: claim.id, contactId: claim.contactId, fileName, fileRef, fileHash: sha256(bytes) });
  return { documentId: id, fileName, fileRef, size: bytes.length, evidence };
}

/** AC 6, 7: what the broker reads beside the pack. The flags are here, and only here: never in the pack. */
/**
 * TTTFG-5204 AC 8: the email for an insurer that takes claims by email, or null. The address is the insurer's record's, by
 * code; the wording is the template's. One with no address gets no email here, and its approval says why (submit.ts).
 */
export function insurerEmailFor(claim: Pick<PackClaim, 'insurerRoute' | 'contactName' | 'insurer' | 'reference' | 'claimType' | 'crm'>): InsurerEmail | null {
  const to = claim.insurerRoute.claimsEmail?.trim();
  if (claim.insurerRoute.channel !== 'Email' || !to) return null;
  const policy = claim.crm.riivo_policy?.riivo_policy_no;
  const incident = claim.crm.riivo_claim?.riivo_incidentdate;
  const vars = {
    clientName: claim.contactName, policyNumber: policy ? String(policy) : null, reference: claim.reference, claimType: claim.claimType, insurer: claim.insurer,
    incidentDate: incident ? String(incident) : null,
  };
  return { to, subject: CLAIM_TO_INSURER_TEMPLATE.subject(vars), text: CLAIM_TO_INSURER_TEMPLATE.render(vars) };
}

export function packContext(claim: Pick<PackClaim, 'id' | 'reference'>, c: Completeness, flags: ClaimFlag[], pack: BuiltPack): PackContext {
  const missing = [...new Set(c.missing.map(itemName))];
  const text = [
    `Completeness ${c.score}%.`,
    missing.length ? `Missing: ${missing.join(', ')}.` : 'Every checklist item is in.',
    flags.length ? `Open flags: ${flags.map((f) => `${f.type}: ${f.detail}`).join('; ')}.` : 'No open flags.',
  ].join(' ');
  return {
    kind: 'claim-pack', version: 1, claimId: claim.id, reference: claim.reference, score: c.score, missing, flags,
    pack: { documentId: pack.documentId, fileName: pack.fileName, fileRef: pack.fileRef }, evidence: pack.evidence, text,
  };
}

// ---------------------------------------------------------------- the summary page

export type PackSummaryRow = SummaryRow;

/** An item's name as a label on the page: "the photo of the driver's licence" -> "Photo of the driver's licence". */
const asLabel = (name: string) => {
  const n = name.replace(/^the\s+/i, '');
  return n.charAt(0).toUpperCase() + n.slice(1);
};

/** riivo_blankfields' lines without the field-map key: "Engine number [crm:…]: no answer" -> "Engine number: no answer". */
const blankLines = (text: string | null) => (text ?? '').split('\n').map((l) => l.replace(/\s*\[[^\]]*\]:/, ':').trim()).filter(Boolean);

/** The summary page's section for people and items the insurer's form has no row for. */
export const PAST_THE_FORM = 'More than the claim form has room for';

/**
 * The entries of a repeating group past the rows the insurer's form prints (a fourth passenger on a form with three
 * rows): one row each, with what the client gave. The generic row prints nothing itself; its summary sheet holds them all.
 */
export function pastTheForm(form: ClaimForm, answers: ClaimAnswers): PackSummaryRow[] {
  if (!form.fieldMap.length) return [];
  const rows: PackSummaryRow[] = [];
  for (const g of form.questionGroups ?? []) {
    const members = form.questionList.filter((q) => q.group === g.key && q.kind === 'question').map((q) => q.key);
    const printed = (n: number) => members.some((k) => form.fieldMap.some((e) => e.source === `answer:${k}.${n}`));
    for (let n = 1; n <= g.max; n++) {
      if (printed(n)) continue;
      const parts = members.flatMap((k) => {
        const a = answers[`${k}.${n}`];
        return a?.status === 'answered' && a.value !== null && a.value !== '' ? [typeof a.value === 'boolean' ? (a.value ? 'Yes' : 'No') : String(a.value)] : [];
      });
      if (!parts.length) continue;
      const word = entryWord(g.key);
      rows.push({ section: PAST_THE_FORM, label: `${word.charAt(0).toUpperCase()}${word.slice(1)} ${n}`, value: parts.join(', ') });
    }
  }
  return rows;
}

/**
 * AC 5: the rows of the summary page. The client, policy and claim rows of the summary sheet (summarysheet.ts, the
 * same `crm:` sources), every evidence document with its date, and the blank fields. Never the score or a flag.
 */
export function packSummaryRows(claim: PackClaim, evidence: PackEvidence[]): PackSummaryRow[] {
  // The summary sheet's own client, policy and claim rows; the answers are on the signed form.
  const rows: PackSummaryRow[] = summaryRows(claim.form, claim.answers, claim.crm).rows.filter((r) => r.section !== 'Your answers');
  // The answers are on the signed form, except anyone past its rows: they go here, or the insurer never sees them.
  rows.push(...pastTheForm(claim.form, claim.answers));
  if (!evidence.length) rows.push({ section: 'Evidence', label: 'Documents', value: 'None received' });
  for (const e of evidence) {
    const date = e.receivedOn ? formatText(e.receivedOn, 'date') : null;
    const where = e.inPack ? 'in this pack' : !e.fileRef ? 'no file on record'
      : isPdf(e.fileName) ? 'sent as a separate file (it could not be added to this pack)' : 'sent as a separate file';
    rows.push({ section: 'Evidence', label: asLabel(e.name), value: `${e.fileName}${date ? `, received ${date}` : ''}, ${where}` });
  }
  const blanks = blankLines(claim.blankFields);
  if (!blanks.length) rows.push({ section: 'Blank fields on the claim form', label: 'None', value: '' });
  // On the last ": ": a label may hold one ("If the car was found: where is it now?"), the reason never does.
  for (const b of blanks) {
    const i = b.lastIndexOf(': ');
    rows.push({ section: 'Blank fields on the claim form', label: i < 0 ? b : b.slice(0, i), value: i < 0 ? '' : b.slice(i + 2) });
  }
  return rows;
}

/** The summary page: one A4 page, the text shrinking (down to MIN_SIZE) until it fits, as the summary sheet does. */
export async function packSummary(claim: PackClaim, evidence: PackEvidence[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const blocks = [paragraph(`Claim pack summary - ${claim.reference}`, bold, 1.6), ...sectionedRows(packSummaryRows(claim, evidence), font, bold)];
  drawBlocks(doc, blocks, fitSize(blocks));
  return doc.save();
}
