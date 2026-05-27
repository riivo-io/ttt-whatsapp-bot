import { dynamicsService } from './dynamics.service';

/**
 * Mapping of SARS source code / industry → the tax documents the client
 * needs to upload for the current South African tax filing season.
 *
 * The SA tax year runs 1 March – 28/29 February. A tax year is labelled by
 * its END year (e.g. "2026 tax year" = 1 Mar 2025 – 28 Feb 2026).
 *
 * Draft mapping — expected to be revised by the TTT tax team. When refining,
 * edit the tables below; the consuming tool picks them up on the next
 * request, no other code changes required.
 */

export type TaxYear = {
    label: number;       // e.g. 2026
    start: string;       // e.g. "1 March 2025"
    end: string;         // e.g. "28 February 2026"
    rangeText: string;   // e.g. "1 March 2025 – 28 February 2026 (2026 tax year)"
};

/**
 * Compute the "current" SA tax year for document-gathering purposes: the
 * most recently ended tax year. Between 1 March (year-end +1 day) and the
 * following 28/29 February, the most recent closed year is the current
 * calendar year; in January/February, it's the previous calendar year.
 */
export function getCurrentSaTaxYear(today: Date = new Date()): TaxYear {
    const year = today.getFullYear();
    const monthIndex = today.getMonth(); // 0 = Jan, 2 = Mar
    const label = monthIndex >= 2 ? year : year - 1;
    const start = `1 March ${label - 1}`;
    const end = `28 February ${label}`;
    return {
        label,
        start,
        end,
        rangeText: `${start} – ${end} (${label} tax year)`,
    };
}

type DocSpec = { label: string; notes?: string };

/**
 * Docs every client needs regardless of source code or industry.
 */
const BASELINE_DOCS: DocSpec[] = [
    { label: 'ID Document', notes: 'only if not already on file' },
    { label: 'IT3(b) — interest earned', notes: 'from each bank / savings account' },
    { label: 'Medical aid tax certificate', notes: 'only if you are on a medical scheme' },
    { label: 'Retirement Annuity (RA) tax certificate', notes: 'only if you contribute to an RA' },
];

/**
 * Extra docs triggered by a specific SARS source code on the contact.
 * Keys are the 4-digit codes as strings.
 */
const SOURCE_CODE_DOCS: Record<string, DocSpec[]> = {
    '3601': [
        { label: 'IRP5' },
        { label: '12 payslips', notes: 'covering the full tax year' },
    ],
    '3605': [], // Annual bonus — covered by IRP5
    '3606': [
        { label: 'IRP5' },
        { label: 'Logbook', notes: 'for business travel claim' },
        { label: 'Till slips / receipts', notes: 'for any expenses you want to claim' },
    ],
    '3615': [
        { label: 'IRP5' },
        { label: '12 payslips', notes: 'covering the full tax year' },
    ],
    '3701': [
        { label: 'IRP5' },
        { label: 'Logbook', notes: 'covering the full tax year' },
        { label: 'Vehicle purchase / lease agreement' },
        { label: 'Fuel & maintenance slips' },
    ],
    '3702': [
        { label: 'IRP5' },
        { label: 'Logbook' },
        { label: 'Fuel slips' },
    ],
    '3703': [
        { label: 'IRP5' },
        { label: 'Logbook' },
        { label: 'Fuel slips' },
    ],
    '3713': [
        { label: 'IRP5' },
        { label: 'Supporting receipts for allowances claimed' },
    ],
    '3696': [],
    '3697': [],
    '4005': [
        { label: 'Medical aid tax certificate' },
    ],
    '4006': [
        { label: 'Retirement Annuity (RA) tax certificate' },
    ],
};

/**
 * Extra docs triggered by industry name. Matching is case-insensitive
 * substring, so "Medical Practitioner (GP)" still matches the "medical"
 * entry. Order matters — first match wins.
 */
const INDUSTRY_DOCS: Array<{ match: RegExp; docs: DocSpec[] }> = [
    {
        match: /self.?employ|sole.?prop|freelanc/i,
        docs: [
            { label: 'Business bank statement', notes: 'full tax year' },
            { label: 'Invoices issued to your clients' },
            { label: 'Supplier invoices' },
            { label: 'Till slips / receipts for business expenses' },
            { label: 'Logbook', notes: 'if you claim business travel' },
        ],
    },
    {
        match: /rental|landlord|property/i,
        docs: [
            { label: 'Lease agreement(s)' },
            { label: 'Bank statement showing rent received', notes: 'full tax year' },
            { label: 'Bond statement' },
            { label: 'Rates & levy invoices' },
            { label: 'Maintenance / repair receipts' },
        ],
    },
    {
        match: /medical|doctor|dentist|specialist|health.?practition/i,
        docs: [
            { label: 'Practice bank statement', notes: 'full tax year' },
            { label: 'Patient receipts / billing records' },
            { label: 'CPD and professional membership receipts' },
        ],
    },
    {
        match: /farm|agric/i,
        docs: [
            { label: 'Farm bank statement', notes: 'full tax year' },
            { label: 'Feed / seed / fuel slips' },
            { label: 'Logbook' },
            { label: 'Insurance schedule' },
        ],
    },
    {
        match: /commission|sales/i,
        docs: [
            { label: 'Logbook' },
            { label: 'Client entertainment receipts' },
            { label: 'Till slips / receipts for expenses claimed' },
        ],
    },
];

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
    const renderDoc = (d: DocSpec) => `• ${d.label}${d.notes ? ` (${d.notes})` : ''}`;
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
    /** Docs the client still needs to send, in priority order (source-code, industry, baseline). */
    outstanding: DocSpec[];
    /** Docs already on file for the year — surfaced so the caller can acknowledge them. */
    received: DocSpec[];
    matchedSourceCodes: string[];
    matchedIndustry: string | null;
};

/**
 * Compute the docs a specific client still owes us, given the SARS source
 * codes we've inferred for them (e.g. from a freshly-OCR'd IRP5 unioned
 * with prior IRP5s for the same year). Fetches the contact's industry and
 * the rows already in `riivo_taxsubmissionsdocuments` for the target year,
 * then subtracts anything that's already on file. Used by the IRP5 upload
 * tool to drive the "next, I'll need your logbook..." follow-up message.
 *
 * Defensive: if any CRM read fails we fall back to the full required list
 * — the caller would rather over-ask than silently skip a doc.
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

    const expected = computeRequiredDocuments(allCodes, industryName, today);

    const uploadedRows = await dynamicsService.getTaxSubmissionDocsByClient(contactId, expected.taxYear.label);
    const uploadedLabels: string[] = uploadedRows
        .map((r: any) => (r?.riivo_taxsubmissionsdocument as string | undefined) || '')
        .filter((s: string) => s.length > 0);

    const allExpected = [...expected.bySourceCode, ...expected.byIndustry, ...expected.baseline];
    const seen = new Set<string>();
    const outstanding: DocSpec[] = [];
    const received: DocSpec[] = [];
    for (const doc of allExpected) {
        const key = doc.label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const hit = uploadedLabels.some(u => labelsLooseMatch(doc.label, u));
        if (hit) received.push(doc);
        else outstanding.push(doc);
    }

    return {
        taxYear: expected.taxYear,
        outstanding,
        received,
        matchedSourceCodes: expected.matchedSourceCodes,
        matchedIndustry: expected.matchedIndustry,
    };
}

function normaliseDocLabel(label: string): string {
    return label
        .toLowerCase()
        .replace(/\([^)]*\)/g, '')
        .replace(/[—–-]/g, ' ')
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function labelsLooseMatch(required: string, uploaded: string): boolean {
    const a = normaliseDocLabel(required);
    const b = normaliseDocLabel(uploaded);
    if (!a || !b) return false;
    if (a === b) return true;
    return a.includes(b) || b.includes(a);
}
