/**
 * The approved WhatsApp templates Tina sends the claims package's template messages as (outside the 24-hour window). The
 * package names a message (templates.ts) and gives its variables; which template that is at Meta is Tina's setting:
 *
 *   CLAIMS_REMINDER_TEMPLATE        the morning reminder (REMINDER_TEMPLATE.whatsappBody, 3 variables); CLAIMS_REMINDER_TEMPLATE_LANG
 *   CLAIMS_MISSING_TEMPLATE         the user (18 Nov 2026): the morning reminder for a claim the client has submitted and still owes
 *                                   something on, with the items as bullets (MISSING_REMINDER_TEMPLATE.whatsappBody(n)). A variable
 *                                   can't hold a line break, so there is a template for each number of bullets, named by this and the
 *                                   number: "<this>_1" to "<this>_5". CLAIMS_MISSING_TEMPLATE_LANG
 *                                   (default: the reminder's). Unset: the package sends that reminder as REMINDER_TEMPLATE, as before.
 *                                   It has a URL button, "Add missing items", registered as <SIGNING_PUBLIC_URL>/claim-form/{{1}}.
 *
 * Each message goes as its own template and never as the other: their variables differ.
 */
import { MISSING_REMINDER_MAX_ITEMS, MISSING_REMINDER_TEMPLATE } from '../departments/insurance/templates';

export interface WhatsAppTemplate { name: string; language: string }

export function whatsAppTemplateFor(message: string | undefined, env: NodeJS.ProcessEnv = process.env, bullets?: number): WhatsAppTemplate | undefined {
    const reminder = { name: env.CLAIMS_REMINDER_TEMPLATE?.trim(), language: env.CLAIMS_REMINDER_TEMPLATE_LANG?.trim() || 'en' };
    if (message === MISSING_REMINDER_TEMPLATE.name) {
        const base = env.CLAIMS_MISSING_TEMPLATE?.trim();
        // The template for this many bullets: "<base>_3". Without a count there is no template to name.
        return base && bullets && bullets >= 1 && bullets <= MISSING_REMINDER_MAX_ITEMS
            ? { name: `${base}_${bullets}`, language: env.CLAIMS_MISSING_TEMPLATE_LANG?.trim() || reminder.language } : undefined;
    }
    return reminder.name ? { name: reminder.name, language: reminder.language } : undefined;
}

/**
 * The part of a claim form link a template's URL button takes. The button is registered at Meta as
 * "<SIGNING_PUBLIC_URL>/claim-form/{{1}}", so what each send gives is the link's token. Undefined when the link is not one of ours.
 */
export function urlButtonSuffix(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const base = `${(env.SIGNING_PUBLIC_URL ?? '').trim().replace(/\/$/, '')}/claim-form/`;
    if (base === '/claim-form/' || !url.startsWith(base)) return undefined;
    const token = url.slice(base.length);
    return token && !/[/?#\s]/.test(token) ? token : undefined;
}

/** The reminder settings the host tells the package: which approved templates it has. */
export const templateSettings = (env: NodeJS.ProcessEnv = process.env) => ({
    template: !!env.CLAIMS_REMINDER_TEMPLATE?.trim(),
    missingTemplate: !!env.CLAIMS_MISSING_TEMPLATE?.trim(),
});
