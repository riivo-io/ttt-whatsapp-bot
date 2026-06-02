import { sharePointService } from './sharepoint.service';

export type TaxFormKey =
    | 'vehicle_detail'
    | 'vehicle_detail_multijob'
    | 'commission_expenses';

export interface TaxFormSpec {
    key: TaxFormKey;
    filenamePrefix: string;
    label: string;
    whatItCaptures: string;
    whoShouldFill: string;
    triggers: {
        sourceCodes?: string[];
        multiEmployer?: boolean;
    };
}

export const TAX_FORMS: TaxFormSpec[] = [
    {
        key: 'vehicle_detail',
        filenamePrefix: '3701 Vehicle Detail Sheet',
        label: 'Vehicle Detail Sheet',
        whatItCaptures: 'Vehicle info, distance from home to office, six business travel reasons, six areas you travel to, service record, and your leave period for the year.',
        whoShouldFill: 'For anyone with a travel allowance (3701), reimbursive travel (3702), or commission-related travel (4015) on your IRP5.',
        triggers: { sourceCodes: ['3701', '3702', '4015'] },
    },
    {
        key: 'vehicle_detail_multijob',
        filenamePrefix: '3802 Vehicle Details Sheet',
        label: 'Universal Vehicle Details Form',
        whatItCaptures: 'Same idea as the standard vehicle form but split across two jobs - reasons, areas, distance and mileage for each employer separately.',
        whoShouldFill: 'Use this instead of the standard vehicle form if you claim travel at two different jobs.',
        triggers: { sourceCodes: ['3701', '3702', '4015'], multiEmployer: true },
    },
    {
        key: 'commission_expenses',
        filenamePrefix: 'TTT Commission Expenses Sheet',
        label: 'Commission Earner Expenses List',
        whatItCaptures: 'Annual business expenses (client entertainment, fuel, internet, cellphone, banking fees, etc.) plus home office costs if you work from home.',
        whoShouldFill: 'Fill this in if your commission is 50% or more of your gross income - SARS only allows the expense claim above that threshold.',
        triggers: { sourceCodes: ['3606'] },
    },
];

export function getAllForms(): TaxFormSpec[] {
    return TAX_FORMS.slice();
}

export function getFormByKey(key: string): TaxFormSpec | null {
    return TAX_FORMS.find(f => f.key === key) || null;
}

/**
 * Forms whose `triggers.sourceCodes` overlap the client's codes. Multi-employer
 * forms are excluded from personalization (per PRD §4 — surfaced only in "all"
 * mode or when the client explicitly mentions multiple jobs).
 */
export function getPersonalizedForms(sourceCodes: string[]): TaxFormSpec[] {
    return TAX_FORMS.filter(form => {
        if (form.triggers.multiEmployer) return false;
        const codes = form.triggers.sourceCodes ?? [];
        return codes.some(c => sourceCodes.includes(c));
    });
}

/**
 * Trigger summary for the get_required_documents trailing line. Maps the
 * matched source codes back to plain-English language the client recognises
 * without exposing the SARS code itself.
 */
export function summarizeTriggers(sourceCodes: string[]): string {
    const hasTravel = sourceCodes.some(c => ['3701', '3702', '4015'].includes(c));
    const hasCommission = sourceCodes.includes('3606');
    if (hasTravel && hasCommission) return 'profile';
    if (hasTravel) return 'travel allowance';
    if (hasCommission) return 'commission earnings';
    return 'profile';
}

function joinLabels(labels: string[]): string {
    if (labels.length === 0) return '';
    if (labels.length === 1) return `*${labels[0]}*`;
    if (labels.length === 2) return `*${labels[0]}* and *${labels[1]}*`;
    return labels.slice(0, -1).map(l => `*${l}*`).join(', ') + `, and *${labels[labels.length - 1]}*`;
}

/**
 * Renders the WhatsApp-formatted body Claude should relay verbatim. Three
 * shapes per PRD §5.6: personalized-single, personalized-multi, and all.
 */
export function formatCatalogMessage(
    forms: TaxFormSpec[],
    mode: 'personalized' | 'all',
    omittedForms: TaxFormSpec[],
): string {
    if (mode === 'all') {
        const lines: string[] = ['Here are the tax forms we have:', ''];
        forms.forEach((f, idx) => {
            lines.push(`*${f.label}*`);
            lines.push(`${f.whoShouldFill} ${f.whatItCaptures}`);
            if (idx < forms.length - 1) lines.push('');
        });
        lines.push('');
        lines.push("Reply with the name of any you'd like and I'll send them through.");
        return lines.join('\n');
    }

    const lines: string[] = [];
    if (forms.length === 1) {
        lines.push("Based on your profile, here's the form we'd recommend you fill in:");
    } else {
        lines.push("Based on your profile, here are the forms we'd recommend you fill in:");
    }
    lines.push('');
    forms.forEach((f, idx) => {
        lines.push(`*${f.label}*`);
        lines.push(`${f.whoShouldFill} ${f.whatItCaptures}`);
        if (idx < forms.length - 1) lines.push('');
    });
    lines.push('');
    lines.push(forms.length === 1 ? 'Want me to send it through?' : 'Want me to send either through?');

    if (omittedForms.length > 0) {
        lines.push('');
        const articled = omittedForms.map(f => `the *${f.label}*`);
        const omittedLabels = articled.length === 1
            ? articled[0]
            : articled.length === 2
                ? `${articled[0]} and ${articled[1]}`
                : `${articled.slice(0, -1).join(', ')}, and ${articled[articled.length - 1]}`;
        const pronoun = omittedForms.length === 1 ? 'it' : 'either';
        lines.push(`We also have ${omittedLabels} - you can request ${pronoun} anytime.`);
    }
    return lines.join('\n');
}

export function formatSendCaption(label: string, year: number): string {
    return `Here's the ${label} for the ${year} tax year. Fill it in and send it back here when you're done.`;
}

/**
 * Trailing line appended to get_required_documents output when one or more
 * personalized forms apply. Format per PRD §5.6.
 */
export function formatTrailingLine(forms: TaxFormSpec[], sourceCodes: string[]): string {
    if (forms.length === 0) return '';
    const trigger = summarizeTriggers(sourceCodes);
    const triggerText = trigger === 'profile' ? 'your profile' : `your ${trigger}`;
    const labelsJoined = joinLabels(forms.map(f => f.label));
    const article = forms.length === 1 ? 'a ' : '';
    return `By the way, based on ${triggerText}, we also have ${article}${labelsJoined} you can fill in - ask anytime.`;
}

const YEAR_SUFFIX_REGEX = /-\s*(\d{4})\.pdf$/i;

function extractYearFromFilename(name: string): number | null {
    const match = name.match(YEAR_SUFFIX_REGEX);
    if (!match) return null;
    const year = parseInt(match[1], 10);
    return Number.isFinite(year) ? year : null;
}

export interface ResolvedFormFile {
    buffer: Buffer;
    filename: string;
    year: number;
}

/**
 * Lists files in the SharePoint forms folder, filters by the form's filename
 * prefix, picks the highest year suffix, downloads, returns. Caller must
 * handle `null` (no matching file found in SharePoint).
 */
export async function resolveLatestFormFile(form: TaxFormSpec): Promise<ResolvedFormFile | null> {
    const files = await sharePointService.listFormFiles();
    const matches = files
        .filter(f => f.name.startsWith(form.filenamePrefix))
        .map(f => ({ ...f, year: extractYearFromFilename(f.name) }))
        .filter((f): f is typeof f & { year: number } => f.year !== null)
        .sort((a, b) => b.year - a.year);
    if (matches.length === 0) {
        console.warn(`[TaxForms] resolve_failed key=${form.key} prefix="${form.filenamePrefix}"`);
        return null;
    }
    const latest = matches[0];
    const buffer = await sharePointService.downloadFormFile(latest.id);
    console.log(`[TaxForms] resolved key=${form.key} filename="${latest.name}" year=${latest.year}`);
    return { buffer, filename: latest.name, year: latest.year };
}

/**
 * Match an inbound filename against the catalog by filename prefix. Used by
 * the return-flow tagging path in whatsappProcessor.
 */
export function matchFormByFilename(filename: string): TaxFormSpec | null {
    return TAX_FORMS.find(f => filename.startsWith(f.filenamePrefix)) || null;
}

const KEBAB_REGEX = /[^a-z0-9]+/g;
export function kebabLabel(label: string): string {
    return label.toLowerCase().replace(KEBAB_REGEX, '-').replace(/^-|-$/g, '');
}

/**
 * Stub for the 48h "recently sent" context-window match. No audit table
 * exists in Supabase today, so per PRD §3.7 this falls back to a no-op and
 * the no-match-via-context branch never fires. Filename matching alone
 * handles the dominant case.
 */
export async function getRecentTaxFormSendForClient(
    _contactGuid: string,
    _withinHours: number,
): Promise<TaxFormSpec | null> {
    return null;
}
