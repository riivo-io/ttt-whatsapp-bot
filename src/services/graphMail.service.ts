import axios from 'axios';
import * as msal from '@azure/msal-node';
import dotenv from 'dotenv';

console.log('[boot] graphMail.service: imports done');
dotenv.config();

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Microsoft Graph caps subscription lifetime at ~70 hours for mail resources.
// We renew well inside that window from the cron — request 3 days here so any
// drift is absorbed.
const SUBSCRIPTION_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000;

export interface GraphMessageAddress {
    emailAddress: { name?: string; address: string };
}

export interface GraphMessage {
    id: string;
    subject: string | null;
    from: GraphMessageAddress;
    toRecipients: GraphMessageAddress[];
    receivedDateTime: string;
    bodyPreview: string;
    body: { contentType: 'html' | 'text'; content: string };
    internetMessageHeaders?: { name: string; value: string }[];
    hasAttachments: boolean;
}

export interface GraphSubscription {
    id: string;
    resource: string;
    changeType: string;
    notificationUrl: string;
    expirationDateTime: string;
    clientState?: string;
}

export interface GraphChangeNotification {
    subscriptionId: string;
    subscriptionExpirationDateTime: string;
    changeType: string;
    resource: string;
    resourceData: { id: string; '@odata.type'?: string; '@odata.id'?: string };
    clientState?: string;
    tenantId?: string;
}

class GraphMailService {
    private cca: msal.ConfidentialClientApplication;
    private accessToken: string | null = null;
    private tokenExpiry: number = 0;
    private mailbox: string;

    constructor() {
        if (!process.env.GRAPH_CLIENT_ID || !process.env.GRAPH_CLIENT_SECRET || !process.env.GRAPH_TENANT_ID) {
            console.warn('[GraphMail] Missing GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET / GRAPH_TENANT_ID — service will fail on first call');
        }
        if (!process.env.GRAPH_SHARED_MAILBOX) {
            console.warn('[GraphMail] Missing GRAPH_SHARED_MAILBOX — service will fail on first call');
        }

        this.mailbox = process.env.GRAPH_SHARED_MAILBOX || '';

        this.cca = new msal.ConfidentialClientApplication({
            auth: {
                clientId: process.env.GRAPH_CLIENT_ID || '',
                clientSecret: process.env.GRAPH_CLIENT_SECRET || '',
                authority: `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID || ''}`,
            },
        });
    }

    private async getToken(): Promise<string> {
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        const response = await this.cca.acquireTokenByClientCredential({
            scopes: ['https://graph.microsoft.com/.default'],
        });

        if (!response || !response.accessToken) {
            throw new Error('[GraphMail] Failed to acquire access token');
        }

        this.accessToken = response.accessToken;
        this.tokenExpiry = response.expiresOn ? response.expiresOn.getTime() : Date.now() + 55 * 60 * 1000;
        return this.accessToken;
    }

    private async authedHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
        const token = await this.getToken();
        return {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...extra,
        };
    }

    private mailboxPath(): string {
        return `/users/${encodeURIComponent(this.mailbox)}`;
    }

    /**
     * Fetch a single message. Uses Prefer: outlook.body-content-type="text"
     * so Graph hands back a plain-text body — much easier to parse forwarded
     * messages from than HTML.
     */
    async getMessage(messageId: string): Promise<GraphMessage | null> {
        try {
            const headers = await this.authedHeaders({ Prefer: 'outlook.body-content-type="text"' });
            const select = [
                'id', 'subject', 'from', 'toRecipients', 'receivedDateTime',
                'bodyPreview', 'body', 'internetMessageHeaders', 'hasAttachments',
            ].join(',');
            const url = `${GRAPH_BASE}${this.mailboxPath()}/messages/${encodeURIComponent(messageId)}?$select=${select}`;
            const res = await axios.get(url, { headers });
            return res.data as GraphMessage;
        } catch (e: any) {
            // 404s are common (message moved/deleted between notification and fetch)
            const status = e?.response?.status;
            if (status === 404) {
                console.warn(`[GraphMail] getMessage: ${messageId} not found (404) — likely moved/deleted`);
                return null;
            }
            console.error('[GraphMail] getMessage failed:', e?.response?.data || e.message);
            return null;
        }
    }

    /**
     * Send a plain-text email from the shared mailbox. Used to notify the
     * original forwarder of relay outcomes ("delivered", "client declined",
     * "no WhatsApp number on record", "no response in 48h").
     */
    async sendMail(params: {
        to: string | string[];
        cc?: string[];
        subject: string;
        bodyText: string;
        replyToMessageId?: string;
    }): Promise<boolean> {
        try {
            const headers = await this.authedHeaders({ 'Content-Type': 'application/json' });

            // If we have a replyTo message id, use the reply endpoint so the
            // notification threads under the original forward in the staff
            // member's inbox. Otherwise fall back to a fresh send.
            if (params.replyToMessageId) {
                const url = `${GRAPH_BASE}${this.mailboxPath()}/messages/${encodeURIComponent(params.replyToMessageId)}/reply`;
                await axios.post(url, {
                    comment: params.bodyText,
                }, { headers });
                console.log(`[GraphMail] Replied to message ${params.replyToMessageId}`);
                return true;
            }

            const toList = (Array.isArray(params.to) ? params.to : [params.to]).filter(Boolean);
            const ccList = (params.cc || []).filter(Boolean);
            const message: any = {
                subject: params.subject,
                body: { contentType: 'Text', content: params.bodyText },
                toRecipients: toList.map(address => ({ emailAddress: { address } })),
            };
            if (ccList.length > 0) {
                message.ccRecipients = ccList.map(address => ({ emailAddress: { address } }));
            }

            const url = `${GRAPH_BASE}${this.mailboxPath()}/sendMail`;
            await axios.post(url, {
                message,
                saveToSentItems: true,
            }, { headers });
            const ccLog = ccList.length > 0 ? ` cc=${ccList.join(',')}` : '';
            console.log(`[GraphMail] Sent mail to ${toList.join(',')}${ccLog} (subject: "${params.subject}")`);
            return true;
        } catch (e: any) {
            console.error('[GraphMail] sendMail failed:', e?.response?.data || e.message);
            return false;
        }
    }

    /**
     * List all change-notification subscriptions visible to this app. Only
     * ours will be returned (Graph filters by app principal). Used by the
     * renewal cron to find what needs extending.
     */
    async listSubscriptions(): Promise<GraphSubscription[]> {
        try {
            const headers = await this.authedHeaders();
            const res = await axios.get(`${GRAPH_BASE}/subscriptions`, { headers });
            return (res.data?.value || []) as GraphSubscription[];
        } catch (e: any) {
            console.error('[GraphMail] listSubscriptions failed:', e?.response?.data || e.message);
            return [];
        }
    }

    /**
     * Create a change-notification subscription on the shared mailbox's Inbox.
     * Graph does a synchronous validation handshake against `notificationUrl`
     * during this POST — the route must respond with the validationToken in
     * plain text within 10 seconds.
     */
    async createSubscription(notificationUrl: string, clientState: string): Promise<GraphSubscription | null> {
        try {
            const headers = await this.authedHeaders({ 'Content-Type': 'application/json' });
            const expiration = new Date(Date.now() + SUBSCRIPTION_LIFETIME_MS).toISOString();

            const res = await axios.post(`${GRAPH_BASE}/subscriptions`, {
                changeType: 'created',
                notificationUrl,
                resource: `users/${this.mailbox}/mailFolders('Inbox')/messages`,
                expirationDateTime: expiration,
                clientState,
            }, { headers });

            console.log(`[GraphMail] Created subscription ${res.data.id} expires ${res.data.expirationDateTime}`);
            return res.data as GraphSubscription;
        } catch (e: any) {
            console.error('[GraphMail] createSubscription failed:', e?.response?.data || e.message);
            return null;
        }
    }

    /**
     * Push a subscription's expirationDateTime forward.
     */
    async renewSubscription(subscriptionId: string): Promise<GraphSubscription | null> {
        try {
            const headers = await this.authedHeaders({ 'Content-Type': 'application/json' });
            const expiration = new Date(Date.now() + SUBSCRIPTION_LIFETIME_MS).toISOString();
            const res = await axios.patch(`${GRAPH_BASE}/subscriptions/${subscriptionId}`, {
                expirationDateTime: expiration,
            }, { headers });
            console.log(`[GraphMail] Renewed subscription ${subscriptionId} until ${res.data.expirationDateTime}`);
            return res.data as GraphSubscription;
        } catch (e: any) {
            console.error('[GraphMail] renewSubscription failed:', e?.response?.data || e.message);
            return null;
        }
    }

    async deleteSubscription(subscriptionId: string): Promise<boolean> {
        try {
            const headers = await this.authedHeaders();
            await axios.delete(`${GRAPH_BASE}/subscriptions/${subscriptionId}`, { headers });
            console.log(`[GraphMail] Deleted subscription ${subscriptionId}`);
            return true;
        } catch (e: any) {
            console.error('[GraphMail] deleteSubscription failed:', e?.response?.data || e.message);
            return false;
        }
    }

    /**
     * Idempotent ensure: if a subscription already exists for our resource,
     * renew it if it's within the renewal window; otherwise create a fresh one.
     * Called by both the bootstrap script and the renewal cron — same code path.
     */
    async ensureSubscription(notificationUrl: string, clientState: string, renewWithinMs: number): Promise<GraphSubscription | null> {
        const subs = await this.listSubscriptions();
        const ours = subs.find(s => s.resource?.includes(`users/${this.mailbox}/mailFolders('Inbox')/messages`));

        if (!ours) {
            console.log('[GraphMail] No existing subscription found — creating fresh');
            return this.createSubscription(notificationUrl, clientState);
        }

        const expiresAt = new Date(ours.expirationDateTime).getTime();
        const now = Date.now();

        if (expiresAt <= now) {
            console.log(`[GraphMail] Subscription ${ours.id} already expired — recreating`);
            await this.deleteSubscription(ours.id);
            return this.createSubscription(notificationUrl, clientState);
        }

        if (expiresAt - now < renewWithinMs) {
            console.log(`[GraphMail] Subscription ${ours.id} within renewal window — renewing`);
            return this.renewSubscription(ours.id);
        }

        console.log(`[GraphMail] Subscription ${ours.id} healthy until ${ours.expirationDateTime} — no action`);
        return ours;
    }
}

export const graphMailService = new GraphMailService();
