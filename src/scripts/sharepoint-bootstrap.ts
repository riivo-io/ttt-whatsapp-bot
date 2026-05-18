/**
 * One-off helper for the SharePoint KB setup. Acquires a Graph token using
 * the tara-bot app's GRAPH_* credentials and resolves the TaxNavigator site
 * ID — needed for the per-site Sites.Selected grant.
 *
 * If this returns 401/403, Sites.Selected hasn't been granted to the app
 * reg in Entra (or admin consent is missing). Fix that first.
 *
 * If it returns 200 with a site ID, copy the ID and use it as the path
 * parameter in the POST /sites/{site-id}/permissions call.
 *
 *   npx ts-node src/scripts/sharepoint-bootstrap.ts
 */
import 'dotenv/config';
import axios from 'axios';
import * as msal from '@azure/msal-node';

const HOSTNAME = process.env.SHAREPOINT_HOSTNAME || 'tttfinancialgroup.sharepoint.com';
const SITE_PATH = process.env.SHAREPOINT_SITE_PATH || '/sites/TaxNavigator';

async function main() {
    const required = ['GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_TENANT_ID'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length > 0) {
        console.error(`Missing env vars: ${missing.join(', ')}`);
        process.exit(1);
    }

    const cca = new msal.ConfidentialClientApplication({
        auth: {
            clientId: process.env.GRAPH_CLIENT_ID!,
            clientSecret: process.env.GRAPH_CLIENT_SECRET!,
            authority: `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}`,
        },
    });

    const token = await cca.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default'],
    });
    if (!token?.accessToken) {
        console.error('Failed to acquire Graph token');
        process.exit(1);
    }
    console.log('Token acquired.');

    const url = `https://graph.microsoft.com/v1.0/sites/${HOSTNAME}:${SITE_PATH}`;
    console.log(`GET ${url}`);

    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' },
        });
        const site = response.data;
        console.log('\n✓ Site resolved:');
        console.log(`  displayName: ${site.displayName}`);
        console.log(`  webUrl:      ${site.webUrl}`);
        console.log(`  id:          ${site.id}`);
        console.log('\nUse this id in the per-site grant payload (step 2).');
    } catch (e: any) {
        const status = e?.response?.status;
        const body = e?.response?.data;
        console.error(`\n✗ Request failed (HTTP ${status}):`);
        console.error(typeof body === 'object' ? JSON.stringify(body, null, 2) : body);
        if (status === 403) {
            console.error('\nLikely cause: Sites.Selected admin consent not granted in Entra, OR app reg lacks the permission.');
        } else if (status === 404) {
            console.error('\nLikely cause: site path is wrong. Check SHAREPOINT_SITE_PATH or the URL above.');
        }
        process.exit(1);
    }
}

main().catch(e => {
    console.error('Bootstrap failed:', e?.message || e);
    process.exit(1);
});
