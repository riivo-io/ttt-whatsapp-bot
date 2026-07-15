/**
 * Pure kernel of document guidance (ADR 0002, ADR 0004).
 *
 * Given a client's tax signals (SARS source codes + industry), produce the
 * **concise, reason-annotated, form-deduped** list of documents *associated*
 * with their return — pure advice on what to gather, NOT a status check.
 *
 * ADR 0004 (advice-only): this kernel deliberately does NOT know or care what
 * the client has already sent. TTT's upload records are unreliable, so Tina
 * never diffs the associated list against them and never tells a client what
 * they have or haven't uploaded. The decision logic here is source-code /
 * industry / topic expansion, form supersession, reason attachment, and
 * ordering — no received-doc diff. It is **pure** — no Dynamics reads, no clock
 * beyond an injected `today`. The service (`requiredDocuments.service.ts`)
 * supplies the profile signals, mirroring the `decideCaseRouting` /
 * `decideFeedbackReply` / `clientRoleContext` seam.
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
 *
 * Guide source of truth: `docs/document-requirements-guide.md` §Everyone
 * (baseline). Re-sync this table when that guide section changes.
 */
export const BASELINE_DOCS: DocSpec[] = [
    { label: 'IRP5', reason: "your employer's tax certificate — the starting point for your return" },
    { label: 'Investment tax certificates (IT3(b)/IT3(c))', reason: 'declare the interest and investment income you earned from each bank, savings or investment account' },
    { label: 'Medical aid tax certificate', reason: 'lets us claim your medical aid contributions (only if you are on a scheme)' },
    { label: 'Retirement Annuity (RA) tax certificate', reason: 'lets us claim your RA contributions as a deduction (only if you contribute to one)' },
];

/**
 * Extra docs triggered by a specific SARS source code on the contact.
 * Keys are the 4-digit codes as strings. Every spec carries a reason.
 *
 * Guide source of truth for the vehicle/commission codes: `docs/document-
 * requirements-guide.md` §3606 (commission) / §3701 (travel) / §3802 (company
 * car), reconciled in Issue 02. Those three list only the loose docs neither the
 * Vehicle Detail Sheet nor the Commission Earner Expenses List captures — the
 * forms themselves come from `SOURCE_CODE_FORMS` and supersede the rest. The
 * `{taxYearRange}` token in a reason is interpolated with `taxYear.rangeText` at
 * build time (never hardcode the assessment period). Re-sync on guide edit.
 */
export const SOURCE_CODE_DOCS: Record<string, DocSpec[]> = {
    '3601': [
        { label: 'IRP5', reason: "your employer's tax certificate — the starting point for your return" },
        { label: '12 payslips', reason: 'to verify your monthly earnings against your IRP5, covering the full tax year' },
    ],
    '3605': [], // Annual bonus — covered by IRP5
    // 3606 (commission): both forms (Vehicle Detail Sheet + Commission Earner
    // Expenses List) come from SOURCE_CODE_FORMS. These loose docs are the ones
    // neither form captures, every one conditionally framed so the client
    // self-selects (guide §3606). IRP5 comes from the baseline.
    '3606': [
        { label: 'Vehicle purchase agreement', reason: "only if you want to claim vehicle expenses against your own car — to establish your vehicle's value" },
        { label: 'Vehicle finance statements', reason: 'only if you want to claim vehicle expenses against your own car — to claim the finance interest on the vehicle' },
        { label: 'Vehicle insurance policy schedule', reason: 'only if you want to claim vehicle expenses against your own car — to claim the insurance you carry on the vehicle' },
        { label: 'Bank statements (cheque / savings / credit card)', reason: "only if you want to claim commission / vehicle expenses — to back up the expenses you're claiming, for {taxYearRange}" },
    ],
    '3615': [
        { label: 'IRP5', reason: "your employer's tax certificate — the starting point for your return" },
        { label: '12 payslips', reason: 'to verify your monthly earnings against your IRP5, covering the full tax year' },
    ],
    // 3701 (travel): the Vehicle Detail Sheet (from SOURCE_CODE_FORMS) captures
    // the logbook, service records and leave dates. The purchase agreement is the
    // one loose doc the form does NOT cover, so it survives (guide §3701). Service
    // records / leave dates are listed here only to be folded into the form via
    // supersession — with includeForms:false they resurface. IRP5 is baseline.
    '3701': [
        { label: 'Vehicle purchase agreement', reason: "to establish your vehicle's value for the travel claim" },
        { label: 'Service records', reason: 'captured by the Vehicle Detail Sheet' },
        { label: 'Leave dates', reason: 'the dates you were away or not travelling for work' },
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
    // 3802 (company car / use-of-motor-vehicle fringe benefit): the Vehicle Detail
    // Sheet (from SOURCE_CODE_FORMS) works out the business-use portion. The only
    // genuinely new doc is the fringe-benefit letter — medical aid / RA /
    // investment certificates are NOT duplicated here, they come from the baseline
    // (guide §3802).
    '3802': [
        { label: 'Fringe-benefit letter from your employer', reason: 'confirms the company-car fringe benefit and its terms' },
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
        // Guide source of truth: `docs/document-requirements-guide.md` §Rental
        // income — the full rental document set (Issue 03). Re-sync on guide edit.
        match: /rental|landlord|property/i,
        docs: [
            { label: 'Lease agreement(s)', reason: 'to confirm the rent you charge your tenants' },
            { label: 'Bank statement showing rent received', reason: 'to confirm the rental income you received, for the tax year' },
            { label: 'Bond statement (including bond interest)', reason: 'to claim the interest on your bond as an expense' },
            { label: 'Rates & levies', reason: 'to claim rates and levies against your rental income' },
            { label: 'Maintenance & repairs receipts', reason: 'to claim the cost of keeping the property in shape' },
            { label: 'Insurance', reason: 'to claim the cover you carry on the property' },
            { label: 'Agency commission paid', reason: "to claim the letting agent's commission" },
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
 *
 * Guide source of truth: `docs/document-requirements-guide.md` §3606 / §3701 /
 * §3802 (Issue 02). The Vehicle Detail Sheet is the shared entry behind all three
 * vehicle/commission scenarios — it captures the logbook, service records and
 * leave dates, so those raw docs are superseded; the vehicle purchase agreement is
 * NOT, since the guide asks for it as a loose doc alongside the form. Re-sync on
 * guide edit.
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
        // Generic reason: the form is shared across travel (3701), commission
        // vehicle (3606) and company-car (3802) clients, so it can't lean on any
        // single code's framing.
        reason: 'fill this in and we can work out your vehicle claim straight from the form — no need to dig out a separate logbook, service records or travel dates',
        sourceCodes: ['3701', '3702', '3703', '4015', '3606', '3802'],
        supersedesDocLabels: [
            'Logbook',
            'Fuel slips',
            'Fuel & maintenance slips',
            'Service records',
            'Leave dates',
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

/**
 * Non-code scenarios surfaced on **client disclosure** rather than read off an
 * IRP5 (Issue 04). When the client tells Tina in chat that they earned foreign
 * or rental income, `get_required_documents` is called with the matching
 * `topic` and these specs are unioned into the recommendation, then
 * deduped/diffed exactly like the code- and industry-driven specs.
 *
 * Guide source of truth: `docs/document-requirements-guide.md` §Foreign income /
 * §Rental income. Re-sync this table when those guide sections change.
 *
 * `foreign_income` carries the 183-day / 60-consecutive-day test and the R1.25m
 * exemption **inside the reason strings only** — never as a standalone advice
 * item, and Tina never rules on whether the client qualifies. Its period
 * reference uses the `{taxYearRange}` token, interpolated at build time.
 *
 * `rental_income` mirrors the rental `INDUSTRY_DOCS` entry (Issue 03's upgraded
 * set) **by reference**, so a client who discloses rental income gets the same
 * list as a landlord-by-industry — one list, not two.
 */
export type DocTopic = 'foreign_income' | 'rental_income';

// The rental topic's specs ARE the rental industry specs — resolved from
// INDUSTRY_DOCS at access time (via the same matcher) so the two can never
// drift. No second rental list is maintained (guide §Rental income).
const rentalIndustryDocs = (): DocSpec[] =>
    INDUSTRY_DOCS.find(e => e.match.test('rental'))?.docs ?? [];

export const TOPIC_DOCS: Record<DocTopic, DocSpec[]> = {
    foreign_income: [
        {
            label: 'Proof of foreign income for the tax year (payslips / bank statements)',
            reason: 'to confirm what you earned abroad for {taxYearRange}',
        },
        {
            label: 'Passport showing exit and entry stamps',
            reason: 'so we can check the days you spent outside South Africa for the foreign-income exemption (you must be out for more than 183 days in a 12-month period, 60 of them consecutive, with the first R1.25 million of qualifying foreign employment income exempt)',
        },
    ],
    // Getter so the rental topic always reflects the live rental INDUSTRY_DOCS
    // entry — one source of truth, no drift between topic and industry.
    get rental_income(): DocSpec[] {
        return rentalIndustryDocs();
    },
};

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
    /**
     * Optional non-code scenario the client disclosed in chat — foreign or
     * rental income (Issue 04). Surfaces the matching `TOPIC_DOCS` specs,
     * unioned + deduped like the rest. Foreign income can only ever reach the
     * kernel this way (it is never read off an IRP5). Defaults to none.
     */
    topic?: DocTopic;
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
    /**
     * Ordered, form-deduped list of documents associated with this client's
     * return — pure advice (ADR 0004). This is NOT a diff against anything on
     * file; the caller must present it as "what you'll typically need", never
     * as "outstanding" or "what you still owe us".
     */
    documents: DocRecommendationItem[];
    matchedSourceCodes: string[];
    matchedIndustry: string | null;
    /** The disclosed topic that contributed specs, or null (Issue 04). */
    matchedTopic: DocTopic | null;
    hasPersonalisation: boolean;
};

/**
 * Build the tailored, reason-annotated, form-deduped list of documents
 * associated with the client's return. Pure: the only clock is the injected
 * `today`.
 *
 * Ordering (PRD §Step 2 "lead with the form"): forms first, then source-code
 * docs, then industry docs, then baseline docs. De-dupes by label across all
 * buckets.
 *
 * No-IRP5 fallback (PRD §Step 1, §Step 2): when no source codes match, the
 * source-code bucket is empty and the result is the safe generic list driven by
 * industry + baseline — still reason-annotated, never a dead end.
 *
 * Advice-only (ADR 0004): the kernel does NOT diff against the client's upload
 * records. It returns the full associated list; Tina never reports what the
 * client has or hasn't sent.
 */
export function buildDocRecommendation(input: DocRecommendationInput): DocRecommendation {
    const { sourceCodes, industryName } = input;
    const includeForms = input.includeForms !== false;
    const today = input.today ?? new Date();
    const taxYear = getCurrentSaTaxYear(today);

    // Reasons may reference the assessment period via the `{taxYearRange}` token
    // rather than hardcoding a date range — interpolate it from the derived tax
    // year so the period stays correct year-on-year (Issue 02 acceptance).
    const interpolate = (reason: string) => reason.replace(/\{taxYearRange\}/g, taxYear.rangeText);

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

    // 3b. Topic docs — a non-code scenario the client disclosed in chat
    //     (foreign / rental income, Issue 04). Unioned in like the rest; the
    //     dedupe in step 4 collapses any overlap with the industry set (a
    //     landlord who also discloses rental income sees the rental docs once).
    const matchedTopic: DocTopic | null = input.topic ?? null;
    const topicDocs: DocSpec[] = matchedTopic ? TOPIC_DOCS[matchedTopic] : [];

    // 4. Assemble in priority order, de-duping by label and dropping any doc a
    //    form supersedes. Forms lead.
    const items: DocRecommendationItem[] = [];
    const seen = new Set<string>();

    for (const form of matchedForms) {
        const key = normaliseDocLabel(form.label);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ kind: 'form', label: form.label, reason: interpolate(form.reason), formKey: form.formKey });
    }

    const pushDoc = (doc: DocSpec) => {
        const key = normaliseDocLabel(doc.label);
        if (seen.has(key) || supersededKeys.has(key)) return;
        seen.add(key);
        items.push({ kind: 'doc', label: doc.label, reason: interpolate(doc.reason) });
    };
    sourceCodeDocs.forEach(pushDoc);
    industryDocs.forEach(pushDoc);
    topicDocs.forEach(pushDoc);
    BASELINE_DOCS.forEach(pushDoc);

    // Advice-only (ADR 0004): no diff against on-file records. The assembled,
    // deduped, form-superseded list IS the recommendation.
    return {
        taxYear,
        documents: items,
        matchedSourceCodes,
        matchedIndustry,
        matchedTopic,
        hasPersonalisation: matchedSourceCodes.length > 0 || matchedIndustry !== null || matchedTopic !== null,
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
