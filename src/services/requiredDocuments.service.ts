import { dynamicsService } from './dynamics.service';
import {
    BASELINE_DOCS,
    SOURCE_CODE_DOCS,
    INDUSTRY_DOCS,
    TOPIC_DOCS,
    buildDocRecommendation,
    getCurrentSaTaxYear,
} from '../domain/docRecommendation';
import type { DocSpec, DocTopic, TaxYear, DocRecommendationItem } from '../domain/docRecommendation';

/**
 * Dynamics-backed wrapper over the pure document-recommendation kernel in
 * `src/domain/docRecommendation.ts`. The kernel owns the source-code / industry
 * tables, reasons and form supersession; this module supplies the Dynamics
 * profile reads (source codes + industry) and the grouped/render shapes the
 * tools expect.
 *
 * ADR 0004 (advice-only): this module reads the client's PROFILE to personalise
 * the associated-docs list, but never reads their upload records and never
 * diffs. Tina gives advice on what's associated with the return, never a
 * report of what the client has or hasn't sent.
 *
 * The SA tax year runs 1 March – 28/29 February, labelled by its END year
 * (e.g. "2026 tax year" = 1 Mar 2025 – 28 Feb 2026). To revise the doc tables,
 * edit `docRecommendation.ts`; consumers pick them up on the next request.
 */

// Re-exported for the many existing importers that reach for these via the
// service path (whatsappProcessor, pendingUpload, claude.service, taxFaq).
export { getCurrentSaTaxYear, buildDocRecommendation };
export type { DocSpec, DocTopic, TaxYear, DocRecommendationItem };

export type RequiredDocumentsResult = {
    taxYear: TaxYear;
    baseline: DocSpec[];
    bySourceCode: DocSpec[];
    byIndustry: DocSpec[];
    /** Docs from a disclosed non-code topic (foreign / rental income, Issue 04). */
    byTopic: DocSpec[];
    matchedSourceCodes: string[];
    matchedIndustry: string | null;
    matchedTopic: DocTopic | null;
    hasPersonalisation: boolean;
};

/**
 * Compute the list of tax documents a specific client needs to upload,
 * based on their SARS source codes and industry — plus an optional disclosed
 * `topic` (foreign / rental income, Issue 04) that can't be read off an IRP5.
 * De-duplicates docs that appear in multiple buckets (by label).
 *
 * Reasons carrying the `{taxYearRange}` token are interpolated here against the
 * `today`-derived tax year, so the live message never leaks the raw token (the
 * kernel's `buildDocRecommendation` does the same for its own path).
 */
export function computeRequiredDocuments(
    sourceCodes: string[],
    industryName: string | null,
    today: Date = new Date(),
    topic?: DocTopic,
): RequiredDocumentsResult {
    const taxYear = getCurrentSaTaxYear(today);
    const interpolate = (d: DocSpec): DocSpec =>
        d.reason.includes('{taxYearRange}')
            ? { ...d, reason: d.reason.replace(/\{taxYearRange\}/g, taxYear.rangeText) }
            : d;

    const seen = new Set<string>();
    const pushUnique = (acc: DocSpec[], doc: DocSpec) => {
        const key = doc.label.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        acc.push(interpolate(doc));
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

    const byTopic: DocSpec[] = [];
    const matchedTopic: DocTopic | null = topic ?? null;
    if (matchedTopic) {
        TOPIC_DOCS[matchedTopic].forEach(d => pushUnique(byTopic, d));
    }

    return {
        taxYear,
        baseline,
        bySourceCode,
        byIndustry,
        byTopic,
        matchedSourceCodes,
        matchedIndustry,
        matchedTopic,
        hasPersonalisation: matchedSourceCodes.length > 0 || matchedIndustry !== null || matchedTopic !== null,
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
    lines.push(`Here's a general list of what typically helps for your ${result.taxYear.label} tax year (${result.taxYear.start} to ${result.taxYear.end}). If you've already sent these to your consultant, you're sorted — no need to send them again:`);

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

    if (result.byTopic.length > 0) {
        lines.push('');
        lines.push('*Based on what you told me:*');
        result.byTopic.forEach(d => lines.push(renderDoc(d)));
    }

    lines.push('');
    lines.push('*Everyone should send (if applicable):*');
    result.baseline.forEach(d => lines.push(renderDoc(d)));

    lines.push('');
    if (!result.hasPersonalisation) {
        lines.push('Once your consultant has set up your income sources and industry, I can give you a more specific list.');
    }
    lines.push('Bank statements, logbooks and payslips should cover the full tax year unless noted otherwise. If you haven\'t sent these to your consultant yet, you can reply with the files right here and I\'ll file each one to your profile — send them one at a time.');

    return lines.join('\n');
}

export type AssociatedDocsResult = {
    taxYear: TaxYear;
    /**
     * Documents associated with the client's return, in priority order
     * (forms, source-code, industry, baseline). Pure advice (ADR 0004) — NOT a
     * diff against what's on file. Callers must never present it as
     * "outstanding" or as what the client still owes.
     */
    documents: DocRecommendationItem[];
    matchedSourceCodes: string[];
    matchedIndustry: string | null;
};

/**
 * Compute the documents associated with a specific client's return, given the
 * SARS source codes we've inferred for them (e.g. from a freshly-OCR'd IRP5
 * unioned with prior IRP5s for the same year). Fetches the contact's industry
 * to personalise, then delegates the expand/dedupe to the pure
 * `buildDocRecommendation` kernel. Used by the IRP5 upload flow to drive the
 * follow-up advice message.
 *
 * ADR 0004 (advice-only): this does NOT read the client's upload records
 * (`riivo_taxsubmissionsdocuments`) and does NOT diff. TTT's upload data is
 * unreliable, so Tina gives advice on what's associated with the return and
 * never tells the client what they have or haven't sent.
 *
 * Forms are INCLUDED (`includeForms: true`, Issue 26): Tina presents the full
 * tailored list once — reasons + form-supersedes-doc — rather than dripping one
 * raw doc at a time.
 */
export async function computeAssociatedDocsForClient(
    contactId: string,
    sourceCodes: string[],
    today: Date = new Date(),
): Promise<AssociatedDocsResult> {
    const profile = await dynamicsService.getContactTaxProfile(contactId);
    const industryName = profile?.industryName || null;

    // Union the caller-supplied source codes with whatever's on the contact
    // profile, so an IRP5 that doesn't redundantly carry every code already
    // flagged on the contact (e.g. retirement-only codes the consultant
    // entered manually) still drives the correct doc advice.
    const allCodes = Array.from(new Set([...sourceCodes, ...(profile?.sourceCodes || [])]));

    const rec = buildDocRecommendation({
        sourceCodes: allCodes,
        industryName,
        today,
        includeForms: true,
    });

    return {
        taxYear: rec.taxYear,
        documents: rec.documents,
        matchedSourceCodes: rec.matchedSourceCodes,
        matchedIndustry: rec.matchedIndustry,
    };
}
