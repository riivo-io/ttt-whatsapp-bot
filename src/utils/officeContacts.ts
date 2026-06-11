/**
 * TTT office (branch) contact details and the routing logic that maps a
 * client's CRM location to the nearest branch.
 *
 * Used by the get_office_contact tool. When a client asks for a general
 * contact number/email (NOT for their specific consultant), Tina surfaces the
 * branch nearest their CRM location; if the location fields are empty or don't
 * match a known region, she lists all four branches and lets them pick.
 */

export type BranchKey = 'durban' | 'johannesburg' | 'cape_town' | 'port_elizabeth';

export interface OfficeBranch {
    key: BranchKey;
    label: string;
    phone: string;
    email: string;
}

export const OFFICE_BRANCHES: Record<BranchKey, OfficeBranch> = {
    durban: { key: 'durban', label: 'Head Office (Durban)', phone: '+27 31 764 7733', email: 'info@ttt-tax.co.za' },
    johannesburg: { key: 'johannesburg', label: 'Johannesburg', phone: '+27 11 463 0052', email: 'info@ttt-tax.co.za' },
    cape_town: { key: 'cape_town', label: 'Cape Town', phone: '+27 21 202 8849', email: 'info@ttt-tax.co.za' },
    port_elizabeth: { key: 'port_elizabeth', label: 'Port Elizabeth', phone: '+27 73 509 2319', email: 'sonja@ttt-tax.co.za' },
};

const BRANCH_ORDER: BranchKey[] = ['durban', 'johannesburg', 'cape_town', 'port_elizabeth'];

/**
 * Region keywords → branch. Matched against the client's CRM city / province /
 * geographic-location fields (case-insensitive substring). Conservative: a
 * miss returns null and the caller lists all branches.
 */
const REGION_RULES: Array<{ branch: BranchKey; patterns: RegExp[] }> = [
    {
        branch: 'durban',
        patterns: [/\bdurban\b/i, /\bkwazulu/i, /\bkzn\b/i, /\bnatal\b/i, /\bpietermaritzburg\b/i, /\bpmb\b/i, /\bumhlanga\b/i, /\bballito\b/i, /\bpinetown\b/i, /\brichards bay\b/i],
    },
    {
        branch: 'johannesburg',
        patterns: [/\bjohannesburg\b/i, /\bjoburg\b/i, /\bjozi\b/i, /\bjhb\b/i, /\bgauteng\b/i, /\bpretoria\b/i, /\btshwane\b/i, /\bsandton\b/i, /\bcenturion\b/i, /\bmidrand\b/i, /\bsoweto\b/i, /\bekurhuleni\b/i, /\bbenoni\b/i, /\bboksburg\b/i, /\bgermiston\b/i, /\brandburg\b/i, /\broodepoort\b/i],
    },
    {
        branch: 'cape_town',
        patterns: [/\bcape town\b/i, /\bkaapstad\b/i, /\bwestern cape\b/i, /\bstellenbosch\b/i, /\bpaarl\b/i, /\bsomerset west\b/i, /\bbellville\b/i, /\bgeorge\b/i, /\bmossel bay\b/i, /\bhermanus\b/i, /\bworcester\b/i],
    },
    {
        branch: 'port_elizabeth',
        patterns: [/\bport elizabeth\b/i, /\bgqeberha\b/i, /\bnelson mandela bay\b/i, /\beastern cape\b/i, /\beast london\b/i, /\buitenhage\b/i, /\bkariega\b/i, /\bgrahamstown\b/i, /\bmakhanda\b/i, /\bmthatha\b/i],
    },
];

/**
 * Pick the branch nearest a client's CRM location. Returns null when nothing
 * usable is on file or no region matches — the caller then lists all branches.
 */
export function pickBranchForLocation(parts: {
    city?: string | null;
    province?: string | null;
    geographicLocation?: string | null;
}): OfficeBranch | null {
    const haystack = [parts.city, parts.province, parts.geographicLocation]
        .filter(Boolean)
        .join(' ')
        .trim();
    if (!haystack) return null;
    for (const rule of REGION_RULES) {
        if (rule.patterns.some(re => re.test(haystack))) {
            return OFFICE_BRANCHES[rule.branch];
        }
    }
    return null;
}

/** WhatsApp-formatted single-branch line. */
export function formatBranch(branch: OfficeBranch): string {
    return `${branch.label}\nPhone: ${branch.phone}\nEmail: ${branch.email}`;
}

/** WhatsApp-formatted list of all four branches. */
export function formatAllBranches(): string {
    return BRANCH_ORDER.map(k => formatBranch(OFFICE_BRANCHES[k])).join('\n\n');
}
