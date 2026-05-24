import axios from 'axios';
import * as msal from '@azure/msal-node';
import dotenv from 'dotenv';

console.log('[boot] sharepoint.service: imports done');
dotenv.config();

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface DriveFile {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    webUrl: string;
    lastModified: string;
    etag: string;
    parentPath: string;
}

interface GraphDriveItem {
    id: string;
    name: string;
    size?: number;
    file?: { mimeType?: string };
    folder?: { childCount?: number };
    webUrl: string;
    lastModifiedDateTime?: string;
    eTag?: string;
}

interface GraphChildrenResponse {
    value: GraphDriveItem[];
    '@odata.nextLink'?: string;
}

class SharePointService {
    private cca: msal.ConfidentialClientApplication;
    private accessToken: string | null = null;
    private tokenExpiry: number = 0;
    private cachedSiteId: string | null = null;
    private cachedDocsSiteId: string | null = null;

    private readonly hostname: string;
    private readonly sitePath: string;
    private readonly kbFolder: string;
    private readonly docsSitePath: string;
    private readonly docsRootFolder: string;

    constructor() {
        if (!process.env.GRAPH_CLIENT_ID || !process.env.GRAPH_CLIENT_SECRET || !process.env.GRAPH_TENANT_ID) {
            console.warn('[SharePoint] Missing GRAPH_* credentials — service will fail on first call');
        }
        if (!process.env.SHAREPOINT_HOSTNAME || !process.env.SHAREPOINT_SITE_PATH || !process.env.SHAREPOINT_KB_FOLDER) {
            console.warn('[SharePoint] Missing SHAREPOINT_* config — service will fail on first call');
        }

        this.hostname = process.env.SHAREPOINT_HOSTNAME || '';
        this.sitePath = process.env.SHAREPOINT_SITE_PATH || '';
        this.kbFolder = process.env.SHAREPOINT_KB_FOLDER || '';
        this.docsSitePath = process.env.SHAREPOINT_DOCS_SITE_PATH || '';
        this.docsRootFolder = process.env.SHAREPOINT_DOCS_ROOT_FOLDER || 'contact';

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
            throw new Error('[SharePoint] Failed to acquire access token');
        }
        this.accessToken = response.accessToken;
        this.tokenExpiry = response.expiresOn ? response.expiresOn.getTime() : Date.now() + 55 * 60 * 1000;
        return this.accessToken;
    }

    private async authedHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
        const token = await this.getToken();
        return { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra };
    }

    /**
     * Resolve the SharePoint site ID. Cached for the process lifetime — site
     * IDs don't change. The colon syntax (sites/{host}:{path}) is Graph's
     * built-in path-based lookup, no need to know the GUID up front.
     */
    async resolveSiteId(): Promise<string> {
        if (this.cachedSiteId) return this.cachedSiteId;

        const url = `${GRAPH_BASE}/sites/${this.hostname}:${this.sitePath}`;
        const headers = await this.authedHeaders();
        const response = await axios.get<{ id: string }>(url, { headers });
        this.cachedSiteId = response.data.id;
        console.log(`[SharePoint] Resolved site ${this.hostname}${this.sitePath} → ${this.cachedSiteId}`);
        return this.cachedSiteId!;
    }

    /**
     * Walk the KB folder recursively and return every file. Folders themselves
     * are not returned — only their contents. Pagination is followed via
     * @odata.nextLink so libraries with thousands of items still work.
     */
    async listKbFiles(): Promise<DriveFile[]> {
        const siteId = await this.resolveSiteId();
        const headers = await this.authedHeaders();

        const rootUrl = `${GRAPH_BASE}/sites/${siteId}/drive/root:/${encodeURIComponent(this.kbFolder)}:/children`;

        const files: DriveFile[] = [];
        const queue: { url: string; pathPrefix: string }[] = [{ url: rootUrl, pathPrefix: '' }];

        while (queue.length > 0) {
            const { url, pathPrefix } = queue.shift()!;
            let nextUrl: string | null = url;

            while (nextUrl) {
                const currentUrl: string = nextUrl;
                const response = await axios.get<GraphChildrenResponse>(currentUrl, { headers });
                for (const item of response.data.value) {
                    if (item.folder) {
                        const childUrl = `${GRAPH_BASE}/sites/${siteId}/drive/items/${item.id}/children`;
                        const subPath = pathPrefix ? `${pathPrefix}/${item.name}` : item.name;
                        queue.push({ url: childUrl, pathPrefix: subPath });
                    } else if (item.file) {
                        files.push({
                            id: item.id,
                            name: item.name,
                            size: item.size || 0,
                            mimeType: item.file.mimeType || 'application/octet-stream',
                            webUrl: item.webUrl,
                            lastModified: item.lastModifiedDateTime || '',
                            etag: item.eTag || '',
                            parentPath: pathPrefix,
                        });
                    }
                }
                nextUrl = response.data['@odata.nextLink'] || null;
            }
        }

        console.log(`[SharePoint] Listed ${files.length} file(s) under "${this.kbFolder}"`);
        return files;
    }

    /**
     * Download a driveItem's bytes. Graph returns a 302 to a temporary Azure
     * Blob URL; axios follows the redirect transparently with arraybuffer.
     */
    async downloadFile(itemId: string): Promise<Buffer> {
        const siteId = await this.resolveSiteId();
        const url = `${GRAPH_BASE}/sites/${siteId}/drive/items/${itemId}/content`;
        const headers = await this.authedHeaders();
        const response = await axios.get<ArrayBuffer>(url, { headers, responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    }

    /**
     * Resolve the docs-site ID. Separate site from the KB — production client
     * documents live under SHAREPOINT_DOCS_SITE_PATH (e.g. /sites/TTTProduction),
     * which is where the email→Power Automate flow writes too. Cached for the
     * process lifetime.
     */
    private async resolveDocsSiteId(): Promise<string> {
        if (this.cachedDocsSiteId) return this.cachedDocsSiteId;

        const url = `${GRAPH_BASE}/sites/${this.hostname}:${this.docsSitePath}`;
        const headers = await this.authedHeaders();
        const response = await axios.get<{ id: string }>(url, { headers });
        this.cachedDocsSiteId = response.data.id;
        console.log(`[SharePoint] Resolved docs site ${this.hostname}${this.docsSitePath} → ${this.cachedDocsSiteId}`);
        return this.cachedDocsSiteId!;
    }

    /**
     * Build the per-client folder slug Power Automate uses:
     *   "{contact fullname} _ {contact GUID, uppercased, no dashes}"
     * Marina Loggenberg / ccc2b7c3-579e-... → "Marina Loggenberg_CCC2B7C3579E..."
     * Caller is responsible for passing the contact's CURRENT fullname — if
     * the client was renamed after their first upload, Power Automate would
     * have created a new folder under the new name, and we match that
     * behaviour rather than chasing the old folder.
     */
    private buildClientFolderSlug(fullName: string, contactId: string): string {
        const guidSlug = contactId.replace(/-/g, '').toUpperCase();
        return `${fullName}_${guidSlug}`;
    }

    /**
     * SharePoint rejects filenames with leading/trailing spaces, and also
     * spaces immediately before the extension dot (e.g. "foo .pdf"). Strip
     * those without changing the rest of the name so consultants still see
     * something recognisable. Collapses internal whitespace runs too — Graph
     * accepts them but they're a usability hazard in the SharePoint UI.
     */
    private sanitiseSharePointFileName(fileName: string): string {
        const lastDot = fileName.lastIndexOf('.');
        const base = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
        const ext = lastDot > 0 ? fileName.slice(lastDot) : '';
        const cleanBase = base.replace(/\s+/g, ' ').trim();
        const cleanExt = ext.replace(/\s+/g, '').trim();
        return cleanBase + cleanExt;
    }

    /**
     * Upload a file into the per-client/per-upload-year folder structure that
     * the email→Power Automate flow uses. Graph's "PUT to path" endpoint
     * auto-creates parent folders, so we don't need to pre-check or pre-create
     * the year subfolder. Returns the uploaded item's webUrl — that's the
     * exact value that goes into riivo_taxsubmissionsdocuments.riivo_filereference,
     * matching Power Automate.
     *
     * Filename collisions: Graph's default is @microsoft.graph.conflictBehavior=replace
     * for PUT-to-path. We instead pass conflictBehavior=rename so the same client
     * uploading two "IRP5.pdf" files in one year doesn't silently overwrite.
     */
    async uploadDocumentFile(params: {
        contactFullName: string;
        contactId: string;
        uploadYear: number;
        fileName: string;
        mimeType: string;
        buffer: Buffer;
    }): Promise<{ webUrl: string; itemId: string; finalName: string }> {
        const siteId = await this.resolveDocsSiteId();

        const folderSlug = this.buildClientFolderSlug(params.contactFullName, params.contactId);
        const safeFileName = this.sanitiseSharePointFileName(params.fileName);
        const path = `${this.docsRootFolder}/${folderSlug}/${params.uploadYear}/${safeFileName}`;
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');

        const url = `${GRAPH_BASE}/sites/${siteId}/drive/root:/${encodedPath}:/content?@microsoft.graph.conflictBehavior=rename`;
        const headers = await this.authedHeaders({ 'Content-Type': params.mimeType });

        const response = await axios.put<GraphDriveItem>(url, params.buffer, {
            headers,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        console.log(`[SharePoint] Uploaded "${response.data.name}" → ${response.data.webUrl}`);
        return {
            webUrl: response.data.webUrl,
            itemId: response.data.id,
            finalName: response.data.name,
        };
    }
}

console.log('[boot] sharepoint.service: instantiating singleton');
export const sharePointService = new SharePointService();
console.log('[boot] sharepoint.service: singleton ready');
