import dotenv from 'dotenv';
import * as msal from '@azure/msal-node';
import axios from 'axios';

dotenv.config();

(async () => {
    console.log('[list-subs] clientId:', process.env.GRAPH_CLIENT_ID?.slice(0, 8) + '…');
    console.log('[list-subs] tenantId:', process.env.GRAPH_TENANT_ID?.slice(0, 8) + '…');
    console.log('[list-subs] secret present:', !!process.env.GRAPH_CLIENT_SECRET);

    const cca = new msal.ConfidentialClientApplication({
        auth: {
            clientId: process.env.GRAPH_CLIENT_ID || '',
            clientSecret: process.env.GRAPH_CLIENT_SECRET || '',
            authority: `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID || ''}`,
        },
    });

    console.log('[list-subs] acquiring token...');
    const r = await cca.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default'],
    });
    console.log('[list-subs] token acquired:', !!r?.accessToken, 'len:', r?.accessToken?.length);

    console.log('[list-subs] GET /subscriptions...');
    const res = await axios.get('https://graph.microsoft.com/v1.0/subscriptions', {
        headers: { Authorization: `Bearer ${r!.accessToken}` },
        timeout: 15000,
    });
    console.log('[list-subs] status:', res.status, 'count:', res.data?.value?.length);
    console.log(JSON.stringify(res.data.value, null, 2));
    process.exit(0);
})().catch(err => {
    console.error('[list-subs] FAILED:', err?.response?.status, err?.response?.data || err?.message || err);
    process.exit(1);
});
