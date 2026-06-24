/**
 * Pure kernel of the document-collection journey (ADR 0002, PRD §Step 2).
 *
 * Given a client's tax signals (SARS source codes + industry) and what's
 * already on file, produce the **concise, reason-annotated, form-deduped**
 * outstanding list. This is the decision logic the deletion test in ADR 0002
 * calls out: source-code / industry expansion, received-doc diff, form
 * supersession, reason attachment, and ordering. It is **pure** — no Dynamics
 * reads, no clock beyond an injected `today`. The service (`requiredDocuments
 * .service.ts`) keeps doing the Dynamics reads and feeds the data in, mirroring
 * the `decideCaseRouting` / `decideFeedbackReply` / `clientRoleContext` seam.
 *
 * Two rules from the PRD are encoded structurally:
 *  - **Reason on every spec.** Every `DocSpec` carries a non-empty client-facing
 *    "why you'd need this" so the client can self-select.
 *  - **Form supersedes doc.** Where a fillable form covers a need, we emit the
 *    form and suppress the duplicate raw-doc ask (never "send your logbook"
 *    *and* "fill the vehicle form" for the same need). The client may still
 *    send their own version.
 */

import type { TaxFormKey } from '../services/taxForms.service';

export type TaxYear = {
    label: number;       // e.g. 2026
    start: string;       // e.g. "1 March 2025"
    end: string;         // e.g. "28 February 2026"
    rangeText: string;   // e.g. "1 March 2025 – 28 February 2026 (2026 tax year)"
};

/**
 * Compute the "current" SA tax year for document-gathering purposes: the
 * most recently ended tax year. The SA tax year runs 1 March – 28/29 February
 * and is labelled by its END year. Between 1 March and the following end of
 * February, the most recent closed year is the current calendar year; in
 * January/February, it's the previous calendar year.
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

/**
 * A document the client may need to send. `reason` is the short, client-facing
 * "why you'd need this" — REQUIRED and non-empty on every spec (PRD §Step 2,
 * Issue 25 acceptance). It doubles as the rendered note.
 */
export type DocSpec = { label: string; reason: string };

/**
 * Docs every client needs regardless of source code or industry.
 *
 * Baseline correction (PRD §Baseline correction, 2026-06-24): **Bank Statements
 * are NOT baseline** — they apply only to specific clients and live in the
 * source-code / industry specs. **IRP5 stays** in baseline; **ID Document
 * stays out** entirely.
 */
export const BASELINE_DOCS: DocSpec[] = [
    { label: 'IRP5', reason: "your employer's tax certificate — the starting point for your return" },
    { label: 'IT3(b) — interest earned', reason: 'declares the interest you earned from each bank or savings account' },
    { label: 'Medical aid tax certificate', reason: 'lets us claim your medical aid contributions (only if you are on a scheme)' },
    { label: 'Retirement Annuity (RA) tax certificate', reason: 'lets us claim your RA contributions as a deduction (only if you contribute to one)' },
];

/**
 * Extra docs triggered by a specific SARS source code on the contact.
 * Keys are the 4-digit codes as strings. Every spec carries a reason.
 */
export const SOURCE_CODE_DOCS: Record<string, DocSpec[]> = {
    '3601': [
        { label: 'IRP5', reason: "your employer's tax certificate — the starting point for your return" },
        { label: '12 payslips', reason: 'to verify your monthly earnings against your IRP5, covering the full tax year' },
    ],
    '3605': [], // Annual bonus — covered by IRP5
    '3606': [
        { label: 'IRP5', reason: "your employer's tax certificate — the starting point for your return" },
        { label: 'Logbook', reason: 'to back up the business travel you want to claim' },
        { label: 'Till slips / receipts', reason: 'for the business expenses you want to claim against your commission' },
    ],
    '3615': [
        { label: 'IRP5', reason: "your employer's tax certificate — the starting point for your return" },
        { label: '12 payslips', reason: 'to verify your monthly earnings against your IRP5, covering the full tax year' },
    ],
    '3701': [
        { label: 'IRP5', reason: "your employer's tax certificate — the starting point for your return" },
        { label: 'Logbook', reason: 'to back up your business travel claim, covering the full tax year' },
        { label: 'Vehicle purchase / lease agreement', reason: "to work out your vehicle's value for the travel claim" },
        { label: 'Fuel & maintenance slips', reason: 'to claim your actual vehicle running costs' },
    ],
    '3702': [
        { label: 'IRP5', reason: "your employer's tax certificate — the starting point for your return" },
        { label: 'Logbook', reason: 'to back up your reimbursive travel claim' },
        { label: 'Fuel slips', reason: 'to claim your actual fuel costs' },
    ],
    '3703': [
        { label: 'IRP5', reason: "your employer's tax certificate — the starting point for your return" },
        { label: 'Logbook', reason: 'to back up your reimbursive travel claim' },
        { label: 'Fuel slips', reason: 'to claim your actual fuel costs' },
    ],
    '3713': [
        { label: 'IRP5', reason: "your employer's tax certificate — the starting point for your return" },
        { label: 'Supporting receipts for allowances claimed', reason: 'to support the allowances shown on your IRP5' },
    ],
    '3696': [],
    '3697': [],
    '4005': [
        { label: 'Medical aid tax certificate', reason: 'to claim your medical aid contributions' },
    ],
    '4006': [
        { label: 'Retirement Annuity (RA) tax certificate', reason: 'to claim your RA contributions as a deduction' },
    ],
};

/**
 * Extra docs triggered by industry name. Matching is case-insensitive
 * substring, so "Medical Practitioner (GP)" still matches the "medical"
 * entry. Order matters — first match wins. Every spec carries a reason.
 */
export const INDUSTRY_DOCS: Array<{ match: RegExp; docs: DocSpec[] }> = [
    {
        match: /self.?employ|sole.?prop|freelanc/i,
        docs: [
            { label: 'Business bank statement', reason: 'shows your business income and expenses, full tax year' },
            { label: 'Invoices issued to your clients', reason: 'to confirm the income you billed' },
            { label: 'Supplier invoices', reason: 'to claim what you spent running the business' },
            { label: 'Till slips / receipts for business expenses', reason: 'to back up the smaller expenses you want to claim' },
            { label: 'Logbook', reason: 'to claim business travel if you use a vehicle for work' },
        ],
    },
    {
        match: /rental|landlord|property/i,
        docs: [
            { label: 'Lease agreement(s)', reason: 'to confirm the rent you charge your tenants' },
            { label: 'Bank statement showing rent received', reason: 'to confirm the rental income you received, full tax year' },
            { label: 'Bond statement', reason: 'to claim the interest on your bond as an expense' },
            { label: 'Rates & levy invoices', reason: 'to claim rates and levies against your rental income' },
            { label: 'Maintenance / repair receipts', reason: 'to claim the cost of keeping the property in shape' },
        ],
    },
    {
        match: /medical|doctor|dentist|specialist|health.?practition/i,
        docs: [
            { label: 'Practice bank statement', reason: 'shows your practice income and expenses, full tax year' },
            { label: 'Patient receipts / billing records', reason: 'to confirm the income you billed patients' },
            { label: 'CPD and professional membership receipts', reason: 'to claim your professional development and membership costs' },
        ],
    },
    {
        match: /farm|agric/i,
        docs: [
            { label: 'Farm bank statement', reason: 'shows your farming income and expenses, full tax year' },
            { label: 'Feed / seed / fuel slips', reason: 'to claim your input and running costs' },
            { label: 'Logbook', reason: 'to claim business travel on the farm vehicle' },
            { label: 'Insurance schedule', reason: 'to claim the cover you take out on the operation' },
        ],
    },
    {
        match: /commission|sales/i,
        docs: [
            { label: 'Logbook', reason: 'to back up the business travel you want to claim' },
            { label: 'Client entertainment receipts', reason: 'to claim the cost of entertaining clients' },
            { label: 'Till slips / receipts for expenses claimed', reason: 'to back up the smaller expenses you want to claim' },
        ],
    },
];

/**
 * Mapping from SARS source codes to a fillable form that **supersedes** the
 * raw-doc asks it covers (PRD §Step 2 "form supersedes doc"). When any trigger
 * code is present the builder leads with the form and suppresses every doc
 * whose label matches `supersedesDocLabels` — the client never sees both "send
 * your logbook" and "fill the vehicle form" for the same need. They may still
 * send their own version. `formKey` ties back to the `list_tax_forms` catalog
 * (`taxForms.service.ts`).
 */
export const SOURCE_CODE_FORMS: Array<{
    formKey: TaxFormKey;
    label: string;
    reason: string;
    sourceCodes: string[];
    supersedesDocLabels: string[];
}> = [
    {
        formKey: 'vehicle_detail',
        label: 'Vehicle Detail Sheet',
        reason: "you've got a travel allowance — fill this in and we can claim your business travel without you digging out a separate logbook",
        sourceCodes: ['3701', '3702', '3703', '4015'],
        supersedesDocLabels: [
            'Logbook',
            'Fuel slips',
            'Fuel & maintenance slips',
            'Vehicle purchase / lease agreement',
        ],
    },
    {
        formKey: 'commission_expenses',
        label: 'Commission Earner Expenses List',
        reason: 'you earn commission — list your business expenses here so we can claim them in one go',
        sourceCodes: ['3606'],
        supersedesDocLabels: [
            'Till slips / receipts',
            'Client entertainment receipts',
            'Till slips / receipts for expenses claimed',
        ],
    },
];

/** One item in the tailored recommendation: a raw doc to send or a form to fill. */
export type DocRecommendationItem = {
    kind: 'doc' | 'form';
    label: string;
    reason: string;
    /** Present only when `kind === 'form'` — the `list_tax_forms` catalog key. */
    formKey?: TaxFormKey;
};

export type DocRecommendationInput = {
    /** SARS source codes inferred for the client (e.g. unioned across IRP5s). */
    sourceCodes: string[];
    /** Contact's industry name, or null if unknown. */
    industryName: string | null;
    /** Labels of docs VERIFIED on file (a real upload or Power Automate row). */
    receivedLabels: string[];
    /**
     * Labels of docs the client has *stated* they already sent to their
     * consultant — the Issue 27 escape hatch (ADR 0002 decision 3). These
     * SUPPRESS the re-ask (so the item leaves `outstanding`) but are NEVER
     * counted as a verified receipt: they surface in their own `clientStated`
     * bucket, visibly distinct from `received`. Defaults to none.
     */
    clientStatedLabels?: string[];
    /** Injected clock for the tax-year calc. */
    today?: Date;
    /**
     * Include fillable forms in the output (form-supersedes-doc). Defaults to
     * true. Callers that still drive the legacy one-doc-at-a-time flow can pass
     * false to get a docs-only list until they migrate (Issue 26).
     */
    includeForms?: boolean;
};

export type DocRecommendation = {
    taxYear: TaxYear;
    /** Ordered, form-deduped, received-filtered list of what we don't yet see. */
    outstanding: DocRecommendationItem[];
    /** Items VERIFIED on file, surfaced so the caller can acknowledge them. */
    received: DocRecommendationItem[];
    /**
     * Items the client *stated* they already sent to their consultant (Issue 27
     * escape hatch). Suppressed from `outstanding` but kept distinct from
     * `received` — the caller must never present these as verified/received.
     */
    clientStated: DocRecommendationItem[];
    matchedSourceCodes: string[];
    matchedIndustry: string | null;
    hasPersonalisation: boolean;
};

/**
 * Build the tailored, reason-annotated, form-deduped, received-filtered
 * recommendation. Pure: the only clock is the injected `today`.
 *
 * Ordering (PRD §Step 2 "lead with the form"): forms first, then source-code
 * docs, then industry docs, then baseline docs. De-dupes by label across all
 * buckets.
 *
 * No-IRP5 fallback (PRD §Step 1, §Step 2): when no source codes match, the
 * source-code bucket is empty and the result is the safe generic list driven by
 * industry + baseline — still reason-annotated, never a dead end.
 *
 * Three-way diff (Issue 27): each candidate lands in `received` (verified on
 * file), `clientStated` (client says it's already with their consultant —
 * suppresses the ask but is NOT a verified receipt), or `outstanding`.
 */
export function buildDocRecommendation(input: DocRecommendationInput): DocRecommendation {
    const { sourceCodes, industryName, receivedLabels } = input;
    const clientStatedLabels = input.clientStatedLabels ?? [];
    const includeForms = input.includeForms !== false;
    const today = input.today ?? new Date();

    // 1. Forms that apply, and the doc labels they supersede.
    const matchedForms = includeForms
        ? SOURCE_CODE_FORMS.filter(f => f.sourceCodes.some(c => sourceCodes.includes(c)))
        : [];
    const supersededKeys = new Set<string>();
    for (const form of matchedForms) {
        for (const docLabel of form.supersedesDocLabels) supersededKeys.add(normaliseDocLabel(docLabel));
    }

    // 2. Source-code docs, in the order the codes were supplied.
    const matchedSourceCodes: string[] = [];
    const sourceCodeDocs: DocSpec[] = [];
    for (const code of sourceCodes) {
        const docs = SOURCE_CODE_DOCS[code];
        if (!docs) continue;
        matchedSourceCodes.push(code);
        sourceCodeDocs.push(...docs);
    }

    // 3. Industry docs (first matching industry wins).
    let matchedIndustry: string | null = null;
    const industryDocs: DocSpec[] = [];
    if (industryName) {
        for (const entry of INDUSTRY_DOCS) {
            if (entry.match.test(industryName)) {
                matchedIndustry = industryName;
                industryDocs.push(...entry.docs);
                break;
            }
        }
    }

    // 4. Assemble in priority order, de-duping by label and dropping any doc a
    //    form supersedes. Forms lead.
    const items: DocRecommendationItem[] = [];
    const seen = new Set<string>();

    for (const form of matchedForms) {
        const key = normaliseDocLabel(form.label);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ kind: 'form', label: form.label, reason: form.reason, formKey: form.formKey });
    }

    const pushDoc = (doc: DocSpec) => {
        const key = normaliseDocLabel(doc.label);
        if (seen.has(key) || supersededKeys.has(key)) return;
        seen.add(key);
        items.push({ kind: 'doc', label: doc.label, reason: doc.reason });
    };
    sourceCodeDocs.forEach(pushDoc);
    industryDocs.forEach(pushDoc);
    BASELINE_DOCS.forEach(pushDoc);

    // 5. Split into received (verified) / client-stated (unverified marker) /
    //    outstanding. A verified receipt wins over a client-stated marker for
    //    the same doc. A client-stated marker suppresses the ask (drops it out
    //    of `outstanding`) without ever being counted as received.
    const outstanding: DocRecommendationItem[] = [];
    const received: DocRecommendationItem[] = [];
    const clientStated: DocRecommendationItem[] = [];
    for (const item of items) {
        if (receivedLabels.some(u => labelsLooseMatch(item.label, u))) {
            received.push(item);
        } else if (clientStatedLabels.some(u => labelsLooseMatch(item.label, u))) {
            clientStated.push(item);
        } else {
            outstanding.push(item);
        }
    }

    return {
        taxYear: getCurrentSaTaxYear(today),
        outstanding,
        received,
        clientStated,
        matchedSourceCodes,
        matchedIndustry,
        hasPersonalisation: matchedSourceCodes.length > 0 || matchedIndustry !== null,
    };
}

/**
 * Normalise a doc label for loose comparison: lowercase, drop bracketed notes,
 * collapse dashes/punctuation/whitespace. Shared by the form-supersession
 * dedupe and the received-doc diff.
 */
export function normaliseDocLabel(label: string): string {
    return label
        .toLowerCase()
        .replace(/\([^)]*\)/g, '')
        .replace(/[—–-]/g, ' ')
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Loose match between a required label and an uploaded/received label —
 * exact after normalisation, or one is a substring of the other ("bank
 * statement" ~ "bank statements", "irp5" ~ "irp5 2024").
 */
export function labelsLooseMatch(required: string, uploaded: string): boolean {
    const a = normaliseDocLabel(required);
    const b = normaliseDocLabel(uploaded);
    if (!a || !b) return false;
    if (a === b) return true;
    return a.includes(b) || b.includes(a);
}
