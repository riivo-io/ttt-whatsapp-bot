/**
 * TTTFG-5196: the signing page (src/signing/).
 *
 *   POST /sign/api/requests       another service creates a request (Authorization: Bearer <SIGNING_API_KEY>); body:
 *                                 the CreateRequestInput fields with `document` as base64. Answers { id, link, expiresAt }.
 *                                 Tina's own claims flow creates its requests in process: the API refuses its callers
 *                                 (RESERVED_CALLERS) and callbacks to Tina itself, so an API key can't act as the claims flow.
 *   GET  /sign/:token             the page (or why the link is refused)
 *   GET  /sign/:token/document    the unsigned PDF, while the link works
 *   POST /sign/:token             { signature: <PNG data URL> }: the client signs
 *
 * Mounted before the global express.json(): it has its own body limits (a PDF in a request, a PNG in a signature).
 */
import express, { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { signingFromEnv } from '../signing/env';
import { refusalMessage, refusedPage, SIGNING_PAGE_CSP, signingPage } from '../signing/page';
import { createSigningRequest, openSigningRequest, signRequest, SigningError, type SigningDeps } from '../signing/signing';

/** Callers Tina creates requests for in process; the API may not use them. */
export const RESERVED_CALLERS = ['claim'];

/**
 * The client's address. Azure App Service's front end adds it at the end of X-Forwarded-For (with the port); what
 * comes before it is whatever the client sent, so only the last entry is trusted.
 */
export function clientIp(req: Request): string | null {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean).pop() ?? '';
    const raw = forwarded || req.socket.remoteAddress || '';
    const ip = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : /^\d+\.\d+\.\d+\.\d+:\d+$/.test(raw) ? raw.split(':')[0] : raw;
    return ip || null;
}

const sameKey = (a: string, b: string) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Pages and the PDF: never cached, never indexed, never framed, and the token never leaves in a Referer. */
function privateHeaders(res: Response) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
}

export function signingRouter(getDeps: () => (SigningDeps & { apiKey?: string }) | null = signingFromEnv): Router {
    const router = Router();
    const off = (res: Response) => res.status(503).json({ ok: false, message: 'Signing is not set up.' });

    // The key is checked before the body is read.
    const apiKey = (req: Request, res: Response, next: () => void) => {
        const d = getDeps();
        if (!d) return void off(res);
        if (!d.apiKey || !sameKey(req.header('authorization') ?? '', `Bearer ${d.apiKey}`)) return void res.status(401).json({ ok: false, message: 'Unauthorised' });
        next();
    };

    router.post('/api/requests', apiKey, express.json({ limit: '20mb' }), async (req: Request, res: Response) => {
        const d = getDeps()!;
        try {
            const b = req.body ?? {};
            if (RESERVED_CALLERS.includes(String(b.caller))) return void res.status(400).json({ ok: false, message: `caller "${b.caller}" is Tina's own` });
            const own = (u: string) => { try { return new URL(u).host === new URL(d.publicUrl).host; } catch { return false; } };
            if (own(String(b.callbackUrl ?? ''))) return void res.status(400).json({ ok: false, message: 'callbackUrl may not be Tina itself' });
            const created = await createSigningRequest(d, { ...b, document: new Uint8Array(Buffer.from(String(b.document ?? ''), 'base64')) });
            res.status(201).json(created);
        } catch (e) {
            if (e instanceof SigningError) return void res.status(400).json({ ok: false, message: e.message });
            console.error('[Signing] create failed:', (e as Error).message);
            res.status(500).json({ ok: false, message: 'Could not create the request' });
        }
    });

    router.get('/:token', async (req: Request, res: Response) => {
        const d = getDeps();
        if (!d) return void off(res);
        privateHeaders(res);
        res.set('Content-Security-Policy', SIGNING_PAGE_CSP);
        try {
            const opened = await openSigningRequest(d, req.params.token);
            if (!opened.ok) return void res.status(opened.reason === 'not-found' ? 404 : 410).type('html').send(refusedPage(opened.reason));
            res.type('html').send(signingPage(opened.row.title));
        } catch (e) {
            console.error('[Signing] page failed:', (e as Error).message);
            res.status(500).type('text').send('Something went wrong. Please try again in a minute.');
        }
    });

    router.get('/:token/document', async (req: Request, res: Response) => {
        const d = getDeps();
        if (!d) return void off(res);
        privateHeaders(res);
        try {
            const opened = await openSigningRequest(d, req.params.token, { record: false });
            if (!opened.ok) return void res.status(410).json({ ok: false, reason: opened.reason });
            res.type('application/pdf').set('Content-Disposition', 'inline').send(Buffer.from(await d.store.unsignedPdf(opened.row)));
        } catch (e) {
            console.error('[Signing] document failed:', (e as Error).message);
            res.status(500).json({ ok: false });
        }
    });

    router.post('/:token', express.json({ limit: '2mb' }), async (req: Request, res: Response) => {
        const d = getDeps();
        if (!d) return void off(res);
        privateHeaders(res);
        try {
            const r = await signRequest(d, req.params.token, { signature: String(req.body?.signature ?? ''), ip: clientIp(req), userAgent: req.header('user-agent') ?? null });
            if (r.ok) return void res.json({ ok: true });
            if (r.reason === 'bad-signature') return void res.status(400).json({ ok: false, reason: r.reason, message: 'Please draw your signature again.' });
            res.status(409).json({ ok: false, reason: r.reason, message: `${refusalMessage(r.reason).title}. ${refusalMessage(r.reason).text}` });
        } catch (e) {
            console.error('[Signing] sign failed:', (e as Error).message);
            res.status(500).json({ ok: false, message: 'Something went wrong. Please try again.' });
        }
    });

    return router;
}

export default signingRouter();
