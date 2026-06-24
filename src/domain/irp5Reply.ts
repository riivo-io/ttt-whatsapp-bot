/**
 * Pure composition of Tina's reply after a client uploads an IRP5
 * (ADR 0002, PRD §Step 2, Issue 26 — list-once, not drip).
 *
 * Two rules from the issue are encoded here so they're testable without any
 * Dynamics / SharePoint / OCR I/O:
 *  - **List once.** After a processed IRP5 we present the FULL tailored
 *    recommendation (reasons + forms, already deduped by the pure builder) in
 *    ONE message — "send whatever you have, in any order" — never the old
 *    one-doc-at-a-time drip.
 *  - **Always confirm receipt.** The cert is stored in SharePoint + tagged in
 *    `riivo_taxsubmissionsdocuments` regardless of OCR success, so the reply
 *    ALWAYS opens with "Got your IRP5 ✅, it's on file." We never tell the
 *    client we couldn't read it — a consultant can.
 *
 * The deterministic WhatsApp path uses `buildIrp5ReceivedAck` verbatim; the
 * Claude tool path embeds `renderOutstandingDocsList` into the model
 * instruction so the model relays the same list in one go.
 */

import type { DocRecommendationItem } from './docRecommendation';

/**
 * Render the tailored outstanding list as WhatsApp bullet lines, each
 * "• label — reason". Form items are flagged so the client knows it's a
 * template they'll fill in (and can ask us to send), not a doc to dig out.
 */
export function renderOutstandingDocsList(items: DocRecommendationItem[]): string[] {
    return items.map(item =>
        item.kind === 'form'
            ? `• ${item.label} (a form we'll send you to fill in) — ${item.reason}`
            : `• ${item.label} — ${item.reason}`,
    );
}

export interface Irp5ReceivedAckInput {
    employerName: string | null;
    assessmentYear: number;
    /** Full tailored outstanding list (forms + docs), already IRP5-filtered. */
    outstanding: DocRecommendationItem[];
    /** Out-of-season / wrong-year caveat, if any. Surfaced as a gentle note. */
    wrongYearWarning?: string;
}

/**
 * Deterministic IRP5-received acknowledgement for the no-AI WhatsApp path.
 * Confirms receipt ALWAYS (the cert is on file regardless of OCR), then
 * presents the FULL tailored list in ONE message, framed "send whatever you
 * have, in any order". Never references OCR or any extraction failure.
 */
export function buildIrp5ReceivedAck(input: Irp5ReceivedAckInput): string {
    const { employerName, assessmentYear, outstanding, wrongYearWarning } = input;
    const receipt = `Got your IRP5${employerName ? ` from ${employerName}` : ''} for the ${assessmentYear} tax year ✅, it's on file.`;
    const caveat = wrongYearWarning ? `One thing — ${wrongYearWarning}` : '';

    if (outstanding.length === 0) {
        return [
            receipt,
            caveat,
            `Looks like that's everything we need for now — your consultant will be in touch if anything else comes up.`,
        ].filter(Boolean).join('\n');
    }

    return [
        receipt,
        caveat,
        '',
        `When you're ready, here's what else will help with your ${assessmentYear} return — send whatever you have, in any order, no rush:`,
        ...renderOutstandingDocsList(outstanding),
    ].filter(Boolean).join('\n');
}
