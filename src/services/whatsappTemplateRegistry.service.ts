import axios from 'axios';
import dotenv from 'dotenv';

console.log('[boot] whatsappTemplateRegistry.service: imports done');
dotenv.config();
console.log('[boot] whatsappTemplateRegistry.service: dotenv configured');

const GRAPH_API_VERSION = 'v22.0';
const TTL_MS = 60 * 60 * 1000; // 1 hour
const PAGE_LIMIT = 200;

export type HeaderType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION' | null;

export interface TemplateEntry {
    name: string;
    language: string;
    headerType: HeaderType;
    headerText: string | null;
    headerVariableCount: 0 | 1;
    bodyText: string;
    bodyVariableCount: number;
    footerText: string | null;
}

interface RawComponent {
    type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS' | string;
    format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION' | string;
    text?: string;
}

interface RawTemplate {
    name: string;
    language: string;
    status: string;
    components?: RawComponent[];
}

/**
 * Count distinct `{{n}}` placeholders in a template string. WhatsApp Cloud API
 * uses positional substitution; the count of distinct numbered placeholders is
 * the variable arity. We rely on Meta's own placeholder convention rather than
 * shipping an AST.
 */
function countPositionalVariables(text: string): number {
    const matches = text.match(/{{\s*\d+\s*}}/g);
    if (!matches) return 0;
    const distinct = new Set(matches.map(m => m.replace(/[^\d]/g, '')));
    return distinct.size;
}

function parseComponents(components: RawComponent[] | undefined): {
    headerType: HeaderType;
    headerText: string | null;
    headerVariableCount: 0 | 1;
    bodyText: string;
    bodyVariableCount: number;
    footerText: string | null;
} {
    let headerType: HeaderType = null;
    let headerText: string | null = null;
    let headerVariableCount: 0 | 1 = 0;
    let bodyText = '';
    let bodyVariableCount = 0;
    let footerText: string | null = null;

    for (const c of components || []) {
        if (c.type === 'HEADER') {
            const fmt = (c.format || 'TEXT') as HeaderType;
            if (fmt === 'TEXT') {
                headerType = 'TEXT';
                headerText = c.text || '';
                headerVariableCount = countPositionalVariables(headerText) > 0 ? 1 : 0;
            } else if (fmt === 'IMAGE' || fmt === 'VIDEO' || fmt === 'DOCUMENT' || fmt === 'LOCATION') {
                headerType = fmt;
            }
        } else if (c.type === 'BODY') {
            bodyText = c.text || '';
            bodyVariableCount = countPositionalVariables(bodyText);
        } else if (c.type === 'FOOTER') {
            footerText = c.text || null;
        }
    }

    return { headerType, headerText, headerVariableCount, bodyText, bodyVariableCount, footerText };
}

function key(name: string, language: string): string {
    return `${name}::${language}`;
}

function substitutePositional(text: string, vars: string[]): string {
    return text.replace(/{{\s*(\d+)\s*}}/g, (_match, idxStr) => {
        const idx = parseInt(idxStr, 10) - 1;
        return vars[idx] ?? '';
    });
}

class WhatsappTemplateRegistry {
    private cache: Map<string, TemplateEntry> = new Map();
    private fetchedAt: number = 0;
    private inFlight: Promise<void> | null = null;

    /**
     * True when the cache is empty or past its TTL. Lazy-refresh trigger.
     */
    private isStale(): boolean {
        if (this.cache.size === 0) return true;
        return Date.now() - this.fetchedAt > TTL_MS;
    }

    private wabaId(): string {
        const id = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
        if (!id) throw new Error('WHATSAPP_BUSINESS_ACCOUNT_ID not set');
        return id;
    }

    private token(): string {
        const t = process.env.META_WHATSAPP_TOKEN;
        if (!t) throw new Error('META_WHATSAPP_TOKEN not set');
        return t;
    }

    /**
     * Fetch all approved templates from Meta and rebuild the cache. Paginates
     * via `paging.next` so the WABA's full template set is loaded in one pass.
     * Coalesces concurrent callers onto a single in-flight request.
     */
    private async refresh(): Promise<void> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = (async () => {
            const next: Map<string, TemplateEntry> = new Map();
            // Meta's /{WABA}/message_templates returns "(#200) Provide valid
            // app ID" when the token is sent via Authorization: Bearer even
            // with valid whatsapp_business_management scope. Query-param works.
            // The paging.next URL Meta returns already includes the token, so
            // we only inject it on the first page.
            let url: string | null =
                `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.wabaId()}/message_templates` +
                `?fields=name,language,components,status&limit=${PAGE_LIMIT}` +
                `&access_token=${encodeURIComponent(this.token())}`;

            while (url) {
                const res: any = await axios.get(url);
                const rows: RawTemplate[] = res.data?.data || [];
                for (const t of rows) {
                    if (t.status !== 'APPROVED') continue;
                    const parsed = parseComponents(t.components);
                    next.set(key(t.name, t.language), {
                        name: t.name,
                        language: t.language,
                        ...parsed,
                    });
                }
                url = res.data?.paging?.next || null;
            }

            this.cache = next;
            this.fetchedAt = Date.now();
            console.log(`[TemplateRegistry] Loaded ${this.cache.size} approved template(s)`);
        })();

        try {
            await this.inFlight;
        } finally {
            this.inFlight = null;
        }
    }

    /**
     * Look up a template by name + language. Refetches once on miss to absorb
     * the case where a sender used a template that was approved after our
     * last cache fill. Returns null if still not found after the forced refresh.
     */
    async getEntry(name: string, language: string = 'en'): Promise<TemplateEntry | null> {
        if (this.isStale()) {
            await this.refresh();
        }
        const hit = this.cache.get(key(name, language));
        if (hit) return hit;

        await this.refresh();
        return this.cache.get(key(name, language)) || null;
    }

    /**
     * Bypass the TTL and rebuild the cache. Exposed via /admin/templates/refresh
     * for manual flush when a template's wording changes in Meta.
     */
    async forceRefresh(): Promise<{ templatesLoaded: number; fetchedAt: string }> {
        await this.refresh();
        return {
            templatesLoaded: this.cache.size,
            fetchedAt: new Date(this.fetchedAt).toISOString(),
        };
    }

    /**
     * Compose the seeded-history string from a template entry + caller-supplied
     * variable values. Order: header, body, footer; sections joined with two
     * newlines. Media headers render as a single-line marker so Tina knows
     * non-text content was attached.
     *
     * Missing variables fall back to empty substitution with a warning log —
     * non-fatal so a misconfigured sender doesn't 500 the webhook.
     */
    composeHistoryContent(
        entry: TemplateEntry,
        bodyVars: string[] = [],
        headerVar?: string
    ): string {
        const parts: string[] = [];

        if (entry.headerType === 'TEXT' && entry.headerText) {
            if (entry.headerVariableCount === 1) {
                if (headerVar === undefined || headerVar === null) {
                    console.warn(`[TemplateRegistry] template "${entry.name}" expects a header variable but caller did not supply one — falling back to empty`);
                }
                parts.push(substitutePositional(entry.headerText, [headerVar ?? '']));
            } else {
                parts.push(entry.headerText);
            }
        } else if (entry.headerType === 'IMAGE') {
            parts.push('[image]');
        } else if (entry.headerType === 'VIDEO') {
            parts.push('[video]');
        } else if (entry.headerType === 'DOCUMENT') {
            parts.push('[document]');
        } else if (entry.headerType === 'LOCATION') {
            parts.push('[location]');
        }

        if (entry.bodyVariableCount > 0) {
            if (bodyVars.length < entry.bodyVariableCount) {
                console.warn(`[TemplateRegistry] template "${entry.name}" expects ${entry.bodyVariableCount} body variable(s), got ${bodyVars.length} — missing positions render as empty`);
            } else if (bodyVars.length > entry.bodyVariableCount) {
                console.warn(`[TemplateRegistry] template "${entry.name}" got ${bodyVars.length} body variable(s), expected ${entry.bodyVariableCount} — extras ignored`);
            }
        }
        parts.push(substitutePositional(entry.bodyText, bodyVars));

        if (entry.footerText) {
            parts.push(entry.footerText);
        }

        return parts.join('\n\n');
    }
}

export const whatsappTemplateRegistry = new WhatsappTemplateRegistry();
