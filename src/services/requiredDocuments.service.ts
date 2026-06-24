import { dynamicsService, isClientStatedMarkerRow } from './dynamics.service';
import {
    BASELINE_DOCS,
    SOURCE_CODE_DOCS,
    INDUSTRY_DOCS,
    buildDocRecommendation,
    getCurrentSaTaxYear,
} from '../domain/docRecommendation';
import type { DocSpec, TaxYear, DocRecommendationItem } from '../domain/docRecommendation';

/**
 * Dynamics-backed wrapper over the pure document-recommendation kernel in
 * `src/domain/docRecommendation.ts`. The kernel owns the source-code / industry
 * tables, reasons, form supersession and the diff logic (ADR 0002 deletion
 * test); this module supplies the Dynamics reads and the legacy grouped/render
 * shapes the existing tools still expect.
 *
 * The SA tax year runs 1 March – 28/29 February, labelled by its END year
 * (e.g. "2026 tax year" = 1 Mar 2025 – 28 Feb 2026). To revise the doc tables,
 * edit `docRecommendation.ts`; consumers pick them up on the next request.
 */

// Re-exported for the many existing importers that reach for these via the
// service path (whatsappProcessor, pendingUpload, claude.service, taxFaq).
export { getCurrentSaTaxYear, buildDocRecommendation };
export type { DocSpec, TaxYear, DocRecommendationItem };

export type RequiredDocumentsResult = {
    taxYear: TaxYear;
    baseline: DocSpec[];
    bySourceCode: DocSpec[];
    byIndustry: DocSpec[];
    matchedSourceCodes: string[];
    matchedIndustry: string | null;
    hasPersonalisation: boolean;
};

/**
 * Compute the list of tax documents a specific client needs to upload,
 * based on their SARS source codes and industry. De-duplicates docs that
 * appear in multiple buckets (by label).
 */
export function computeRequiredDocuments(
    sourceCodes: string[],
    industryName: string | null,
    today: Date = new Date()
): RequiredDocumentsResult {
    const seen = new Set<string>();
    const pushUnique = (acc: DocSpec[], doc: DocSpec) => {
        const key = doc.label.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        acc.push(doc);
    };

    const baseline: DocSpec[] = [];
    BASELINE_DOCS.forEach(d => pushUnique(baseline, d));

    const bySourceCode: DocSpec[] = [];
    const matchedSourceCodes: string[] = [];
    for (const code of sourceCodes) {
        const docs = SOURCE_CODE_DOCS[code];
        if (!docs) continue;
        matchedSourceCodes.push(code);
        docs.forEach(d => pushUnique(bySourceCode, d));
    }

    const byIndustry: DocSpec[] = [];
    let matchedIndustry: string | null = null;
    if (industryName) {
        for (const entry of INDUSTRY_DOCS) {
            if (entry.match.test(industryName)) {
                matchedIndustry = industryName;
                entry.docs.forEach(d => pushUnique(byIndustry, d));
                break;
            }
        }
    }

    return {
        taxYear: getCurrentSaTaxYear(today),
        baseline,
        bySourceCode,
        byIndustry,
        matchedSourceCodes,
        matchedIndustry,
        hasPersonalisation: matchedSourceCodes.length > 0 || matchedIndustry !== null,
    };
}

/**
 * Format the result as a human-friendly WhatsApp message. Grouped by
 * personalisation bucket. The matched source codes themselves are NOT
 * exposed to the client — we only surface the resulting doc list.
 */
export function formatRequiredDocumentsMessage(result: RequiredDocumentsResult): string {
    const renderDoc = (d: DocSpec) => `• ${d.label}${d.reason ? ` (${d.reason})` : ''}`;
    const lines: string[] = [];
    lines.push(`Here's what you'll need to upload for the ${result.taxYear.label} tax year — covering ${result.taxYear.start} to ${result.taxYear.end}:`);

    if (result.bySourceCode.length > 0) {
        lines.push('');
        lines.push('*Based on your income sources:*');
        result.bySourceCode.forEach(d => lines.push(renderDoc(d)));
    }

    if (result.byIndustry.length > 0) {
        lines.push('');
        lines.push(`*Based on your industry${result.matchedIndustry ? ` (${result.matchedIndustry})` : ''}:*`);
        result.byIndustry.forEach(d => lines.push(renderDoc(d)));
    }

    lines.push('');
    lines.push('*Everyone should send (if applicable):*');
    result.baseline.forEach(d => lines.push(renderDoc(d)));

    lines.push('');
    if (!result.hasPersonalisation) {
        lines.push('This is a general list. Once your consultant has set up your income sources and industry, I can give you a more specific list.');
    }
    lines.push('Bank statements, logbooks and payslips should cover the full tax year unless noted otherwise. Send documents one at a time — I\'ll file each one to your profile.');

    return lines.join('\n');
}

export type MissingDocsResult = {
    taxYear: TaxYear;
    /** Items the client still needs to send, in priority order (source-code, industry, baseline). */
    outstanding: DocRecommendationItem[];
    /** Items VERIFIED on file for the year — surfaced so the caller can acknowledge them. */
    received: DocRecommendationItem[];
    /**
     * Items the client *stated* they already sent to their consultant (Issue 27
     * escape hatch) — suppressed from `outstanding` but NOT a verified receipt.
     */
    clientStated: DocRecommendationItem[];
    matchedSourceCodes: string[];
    matchedIndustry: string | null;
};

/**
 * Compute the docs a specific client still owes us, given the SARS source
 * codes we've inferred for them (e.g. from a freshly-OCR'd IRP5 unioned
 * with prior IRP5s for the same year). Fetches the contact's industry and
 * the rows already in `riivo_taxsubmissionsdocuments` for the target year,
 * then delegates the expand/diff/dedupe to the pure `buildDocRecommendation`
 * kernel. Used by the IRP5 upload tool to drive the follow-up message.
 *
 * Forms are INCLUDED (`includeForms: true`, Issue 26): after an IRP5 upload
 * Tina presents the full tailored list once — reasons + form-supersedes-doc —
 * rather than dripping one raw doc at a time.
 */
export async function computeMissingDocsForClient(
    contactId: string,
    sourceCodes: string[],
    today: Date = new Date(),
): Promise<MissingDocsResult> {
    const profile = await dynamicsService.getContactTaxProfile(contactId);
    const industryName = profile?.industryName || null;

    // Union the caller-supplied source codes with whatever's on the contact
    // profile, so an IRP5 that doesn't redundantly carry every code already
    // flagged on the contact (e.g. retirement-only codes the consultant
    // entered manually) still drives the correct doc asks.
    const allCodes = Array.from(new Set([...sourceCodes, ...(profile?.sourceCodes || [])]));

    const taxYear = getCurrentSaTaxYear(today);
    const uploadedRows = await dynamicsService.getTaxSubmissionDocsByClient(contactId, taxYear.label);

    // Split verified uploads from the Issue 27 unverified "client states
    // provided" markers. Verified rows count as received; markers only
    // suppress the re-ask without being surfaced as received.
    const rowLabel = (r: any) => (r?.riivo_taxsubmissionsdocument as string | undefined) || '';
    const receivedLabels: string[] = uploadedRows
        .filter((r: any) => !isClientStatedMarkerRow(r))
        .map(rowLabel)
        .filter((s: string) => s.length > 0);
    const clientStatedLabels: string[] = uploadedRows
        .filter((r: any) => isClientStatedMarkerRow(r))
        .map(rowLabel)
        .filter((s: string) => s.length > 0);

    const rec = buildDocRecommendation({
        sourceCodes: allCodes,
        industryName,
        receivedLabels,
        clientStatedLabels,
        today,
        includeForms: true,
    });

    return {
        taxYear: rec.taxYear,
        outstanding: rec.outstanding,
        received: rec.received,
        clientStated: rec.clientStated,
        matchedSourceCodes: rec.matchedSourceCodes,
        matchedIndustry: rec.matchedIndustry,
    };
}
