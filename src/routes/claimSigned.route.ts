import { Router, Request, Response } from 'express';
import express from 'express';
import { handleClaimSigned } from '../services/claimsDemo.service';
import { callbackSecretFromEnv } from '../signing/env';
import { callerCallbackKey, SIGNATURE_HEADER } from '../signing/signing';
import { verifyHmacSha256 } from '../utils/hmac';

const router = Router();

/**
 * POST /webhook/claim-signed
 *
 * TTTFG-5196: the signing page's callback for a claim form (caller "claim"). Signed with HMAC-SHA256 of the raw body
 * under the "claim" caller's callback key (src/signing/env.ts, callerCallbackKey; header x-signing-signature). The claims package files the
 * signed copy in the claim folder, adds its "Claim form (signed)" row and sets the claim to Signed (onClaimFormSigned).
 * Today every claim Tina runs is a demo claim in the demo CRM.
 *
 * Idempotent: the page retries until it gets a 2xx, and a claim already Signed answers 200 with nothing written.
 */
/** No signature header, no body read. */
const signed = (req: Request, res: Response, next: () => void) => {
    if (!/^[0-9a-f]{64}$/.test(req.header(SIGNATURE_HEADER) ?? '')) return void res.status(401).json({ error: 'bad_signature' });
    next();
};

/** One run per signing request at a time: a retry that arrives while the first is still writing waits for it. */
const running = new Map<string, Promise<unknown>>();

router.post('/', signed, express.raw({ type: 'application/json', limit: '15mb' }), async (req: Request, res: Response) => {
    const secret = callbackSecretFromEnv();
    if (!secret) {
        res.status(500).json({ error: 'webhook_not_configured' });
        return;
    }
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyHmacSha256(rawBody, req.header(SIGNATURE_HEADER), callerCallbackKey(secret, 'claim'))) {
        console.warn('[ClaimSigned] bad_signature received');
        res.status(401).json({ error: 'bad_signature' });
        return;
    }
    try {
        const b = JSON.parse(rawBody.toString('utf8'));
        const key = String(b.requestId);
        while (running.has(key)) await running.get(key)!.catch(() => undefined);
        const run = handleClaimSigned({
            requestId: b.requestId, caller: b.caller, callerRecordId: b.callerRecordId,
            signedPdf: new Uint8Array(Buffer.from(String(b.signedPdf ?? ''), 'base64')), audit: b.audit,
        });
        running.set(key, run);
        const outcome = await run.finally(() => running.delete(key));
        console.log(`[ClaimSigned] ${b.callerRecordId}: ${JSON.stringify(outcome)}`);
        res.json({ ok: true, outcome });
    } catch (e) {
        console.error('[ClaimSigned] failed:', (e as Error).message);
        res.status(500).json({ error: 'failed' });
    }
});

export default router;
