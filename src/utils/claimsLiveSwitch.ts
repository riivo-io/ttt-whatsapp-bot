/**
 * Claims go live (the user, 20 Nov 2026): real clients get the form-based claims flow (claimsDemoHost.ts) that the demo
 * numbers have, against Tina's own CRM, instead of the October chat walkthrough (claimsHost.ts).
 *
 * Settings, on ttt-prod-bot AND ttt-prod-bot-worker:
 *   CLAIMS_LIVE            "on": live. Anything else: off, and Tina behaves exactly as before.
 *   CLAIMS_LIVE_NUMBERS    optional comma-separated list: live for those numbers only (our phones, then pilot clients).
 *   CLAIMS_DATAVERSE_URL   the claims CRM (over CLAIMS_DEMO_DATAVERSE_URL; default TTT DEV). Live mode refuses to run unless
 *                          it is Tina's own CRM (DYNAMICS_URL): a real client's claim must never land in DEV.
 *   CLAIMS_SHAREPOINT_SITE the site the client claim folders are on (over CLAIMS_DEMO_SHAREPOINT_SITE; default TTTDevelopment).
 * Live also needs service routing on for the number (serviceRoutingSwitch.ts): routing decides tax or insurance, and
 * only an insurance claim reaches the form flow. In live mode the October chat walkthrough never runs, for any number.
 */
import { serviceRoutingOn } from './serviceRoutingSwitch';

export const DEV_CRM_URL = 'https://tttdevelopment.crm4.dynamics.com';
export const DEV_CLAIMS_SITE = 'tttfinancialgroup.sharepoint.com:/sites/TTTDevelopment';

const host = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();
const digits = (p: string) => p.replace(/\D/g, '').replace(/^0/, '27');

/** The CRM the claims flow reads and writes. */
export function claimsCrmUrl(env: NodeJS.ProcessEnv = process.env): string {
    return (env.CLAIMS_DATAVERSE_URL?.trim() || env.CLAIMS_DEMO_DATAVERSE_URL?.trim() || DEV_CRM_URL).replace(/\/+$/, '');
}

/** The SharePoint site of the client claim folders (host:/sites/<name>). */
export function claimsSite(env: NodeJS.ProcessEnv = process.env): string {
    return env.CLAIMS_SHAREPOINT_SITE?.trim() || env.CLAIMS_DEMO_SHAREPOINT_SITE?.trim() || DEV_CLAIMS_SITE;
}

let warned = false;

/**
 * Live mode, for every number: CLAIMS_LIVE=on and the claims CRM is Tina's own. Switched on but pointed at another CRM:
 * off, said once in the log.
 */
export function claimsLiveMode(env: NodeJS.ProcessEnv = process.env): boolean {
    if ((env.CLAIMS_LIVE ?? '').trim().toLowerCase() !== 'on') return false;
    const own = env.DYNAMICS_URL?.trim();
    if (!own || host(own) !== host(claimsCrmUrl(env))) {
        if (!warned) {
            console.error(`[ClaimsLive] CLAIMS_LIVE=on but the claims CRM (${claimsCrmUrl(env)}) is not Tina's own (${own ?? 'DYNAMICS_URL unset'}): live claims stay OFF. Set CLAIMS_DATAVERSE_URL.`);
            warned = true;
        }
        return false;
    }
    return true;
}

/** Live for this number: live mode, the number on CLAIMS_LIVE_NUMBERS (when set), and service routing on for it. */
export function claimsLiveOn(phone: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!claimsLiveMode(env)) return false;
    const list = (env.CLAIMS_LIVE_NUMBERS ?? '').split(',').map((n) => digits(n.trim())).filter(Boolean);
    if (list.length > 0 && !list.includes(digits(phone))) return false;
    return serviceRoutingOn(phone, env);
}

/** Test seam: the once-only warning. */
export function resetClaimsLiveWarning(): void {
    warned = false;
}
