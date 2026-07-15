/**
 * Pure composition of Tina's reply after a client uploads an IRP5
 * (ADR 0002, ADR 0004, PRD §Step 2, Issue 26 — list-once, not drip).
 *
 * Rules encoded here so they're testable without any Dynamics / SharePoint /
 * OCR I/O:
 *  - **List once, as advice.** After a processed IRP5 we present the FULL
 *    tailored list of documents associated with the return (reasons + forms,
 *    already deduped by the pure builder) in ONE message — "send whatever you
 *    have, in any order" — never the old one-doc-at-a-time drip. ADR 0004:
 *    this is advice on what helps, NOT a diff against what's on file, so we
 *    never say what the client still owes or has already sent.
 *  - **Always confirm receipt of the IRP5 they just sent.** The cert is stored
 *    in SharePoint + tagged in `riivo_taxsubmissionsdocuments` regardless of
 *    OCR success, so the reply ALWAYS opens with "Got your IRP5 ✅, it's on
 *    file." We never tell the client we couldn't read it — a consultant can.
 *    This confirmation is about THIS upload only, never a record lookup.
 *
 * The deterministic WhatsApp path uses `buildIrp5ReceivedAck` verbatim; the
 * Claude tool path embeds `renderAssociatedDocsList` into the model
 * instruction so the model relays the same list in one go.
 */

import type { DocRecommendationItem } from './docRecommendation';

/**
 * Render the tailored associated-docs list as WhatsApp bullet lines, each
 * "• label — reason". Form items are flagged so the client knows it's a
 * template they'll fill in (and can ask us to send), not a doc to dig out.
 */
export function renderAssociatedDocsList(items: DocRecommendationItem[]): string[] {
    return items.map(item =>
        item.kind === 'form'
            ? `• ${item.label} (a form we'll send you to fill in) — ${item.reason}`
            : `• ${item.label} — ${item.reason}`,
    );
}

export interface Irp5ReceivedAckInput {
    employerName: string | null;
    assessmentYear: number;
    /** Full tailored associated-docs list (forms + docs), already IRP5-filtered. */
    associatedDocs: DocRecommendationItem[];
    /** Out-of-season / wrong-year caveat, if any. Surfaced as a gentle note. */
    wrongYearWarning?: string;
}

/**
 * Deterministic IRP5-received acknowledgement for the no-AI WhatsApp path.
 * Confirms receipt of the cert they just sent ALWAYS (it's on file regardless
 * of OCR), then presents the FULL tailored advice list in ONE message, framed
 * "send whatever you have, in any order". ADR 0004: advice only — never a
 * report of what the client has or hasn't sent. Never references OCR or any
 * extraction failure.
 */
export function buildIrp5ReceivedAck(input: Irp5ReceivedAckInput): string {
    const { employerName, assessmentYear, associatedDocs, wrongYearWarning } = input;
    const receipt = `Got your IRP5${employerName ? ` from ${employerName}` : ''} for the ${assessmentYear} tax year ✅, it's on file.`;
    const caveat = wrongYearWarning ? `One thing — ${wrongYearWarning}` : '';

    if (associatedDocs.length === 0) {
        return [
            receipt,
            caveat,
            `Your consultant will be in touch if anything else is needed for your return.`,
        ].filter(Boolean).join('\n');
    }

    return [
        receipt,
        caveat,
        '',
        `Here's what typically helps with a ${assessmentYear} return — send whatever applies to you, in any order, no rush:`,
        ...renderAssociatedDocsList(associatedDocs),
    ].filter(Boolean).join('\n');
}
