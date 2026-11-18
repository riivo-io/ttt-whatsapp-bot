/**
 * TTTFG-5562: the guided claim form (src/claimform/, the logic in the claims package's guided.ts).
 *   GET  /claim-form/:token            the page (or why the link is refused)
 *   GET  /claim-form/:token/state      the form as the page shows it
 *   POST /claim-form/:token/answers    one screen's answers
 *   POST /claim-form/:token/voice      a recording (raw audio): { text } for the answer box
 *   POST /claim-form/:token/file       one photo or document (raw bytes), ?item=<evidence key>
 *   POST /claim-form/:token/submit     the client is done: Tina carries on on WhatsApp, or tells the email agent.
 *                                      { signature }: the client's signature from the form's last screen (a WhatsApp
 *                                      link, when the signing page is set up: the view's `sign`)
 *   POST /claim-form/api/links         TTTFG-5188: a link for an email claim, with the signing API's key
 *   POST /claim-form/api/form-signature  whether an email claim's client signed at the end of its form, with the same key
 *   POST /claim-form/api/sign-with-form  signs the email agent's new signing request with that signature, with the same key
 *   GET  /claim-form/api/blank-form    TTTFG-5188: an insurer's blank form for the email agent, with the same key
 * The token is the only key: it can't be guessed, and every call checks it again.
 */
import express, { Router, type Request, type Response } from 'express';
import type { ClientFile } from '../departments/insurance/followon';
import type { GuidedSave, GuidedSaved, GuidedView } from '../departments/insurance/guided';
import { CLAIM_FORM_CSP, claimFormPage, refusedPage } from '../claimform/page';
import { createGuidedLink, finishGuidedLink, isBlankFormUrl, openGuidedLink, saveFormSignature, type GuidedLinkDeps, type GuidedLinkRow } from '../claimform/links';
import { signaturePng } from '../signing/signing';
import { clientIp, LINK_PREVIEW, sameKey } from './signing.route';

/** What the route needs for one link's claim. */
export interface ClaimFormSession {
    view(): Promise<GuidedView>;
    save(input: GuidedSave): Promise<GuidedSaved>;
    /** The file's bytes through the same pipeline as a file sent on WhatsApp. */
    file(file: Omit<ClientFile, 'id'>, bytes: Buffer, itemKey: string | undefined): Promise<{ count: number }>;
    hear(bytes: Buffer, mimeType: string, questionKey: string | undefined): Promise<{ text: string } | { problem: string }>;
    /** Required questions still open, or none: the form is ready. */
    finish(): Promise<{ open: string[] }>;
    /** Tells Tina the client is done, on the client's own queue. */
    carryOn(): Promise<void>;
}

export interface ClaimFormDeps extends GuidedLinkDeps {
    session(link: GuidedLinkRow): ClaimFormSession;
    /** Tina's WhatsApp number, for the way back. */
    whatsApp?: string | null;
    /** The signing API's key: the email agent asks for an email claim's link with it. Absent: nobody can. */
    apiKey?: string;
    /** An insurer's blank form, as Tina reads it for a WhatsApp claim. */
    blankForm?(url: string): Promise<Uint8Array>;
    /**
     * The user (9 Nov 2026): the signing page is set up, so the client signs at the end of the form and the signing step
     * signs the filled form with that signature, instead of sending a link. Absent: Submit, and the link after.
     */
    signOnForm?: boolean;
    /**
     * The user (9 Nov 2026): an email claim signs on the form too. The email agent fills the form, so it asks whether there is
     * a signature for the claim, and then has its own new signing request signed with it (claimform/signOnForm.ts).
     */
    emailSigning?: {
        hasFormSignature(claimId: string): Promise<boolean>;
        signWithForm(requestLink: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    };
}

/**
 * Whether this link's client signs on the form: signing set up, and for an email claim's link (callback_url) only when the
 * email agent can use the signature.
 */
const signsHere = (d: ClaimFormDeps, link: GuidedLinkRow) => !!d.signOnForm && (!link.callback_url || !!d.emailSigning);

const VOICE_MAX = 16 * 1024 * 1024;
/** WhatsApp's own limit for an image is 5 MB and a document 100 MB; a phone's camera stays well under this. */
const FILE_MAX = 25 * 1024 * 1024;
const FILE_TYPES: Record<string, { ext: string; media: ClientFile['media'] }> = {
    'image/jpeg': { ext: 'jpg', media: 'photo' }, 'image/png': { ext: 'png', media: 'photo' }, 'image/webp': { ext: 'webp', media: 'photo' },
    'image/heic': { ext: 'heic', media: 'photo' }, 'image/heif': { ext: 'heif', media: 'photo' }, 'application/pdf': { ext: 'pdf', media: 'document' },
    'video/mp4': { ext: 'mp4', media: 'video' }, 'video/quicktime': { ext: 'mov', media: 'video' },
};

const VOICE_PROBLEM: Record<string, string> = {
    unclear: "I couldn't make that out. Please try again, or type your answer.",
    'too-long': 'That recording is a bit long for me. Please try a shorter one, or type your answer.',
    unsupported: "I can't play that recording. Please type your answer.",
    unavailable: "I can't listen right now. Please type your answer.",
};

/** Pages and data: never cached, never indexed, never framed, and the token never leaves in a Referer. */
function privateHeaders(res: Response) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
}

/** A link's calls run one at a time, so two saves from the same page can't overwrite each other's answers. */
const queues = new Map<string, Promise<unknown>>();
function inTurn<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(id) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined).finally(() => { if (queues.get(id) === tail) queues.delete(id); });
    queues.set(id, tail);
    return run;
}

/** What may be saved: the page's own shape, nothing else reaches the claims package. */
function saveInput(body: unknown): GuidedSave {
    const b = (body ?? {}) as Record<string, unknown>;
    const keys = (v: unknown) => (Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string' && k.length < 120).slice(0, 500) : []);
    const answers = Array.isArray(b.answers)
        ? b.answers.filter((a): a is { key: string; value: string | number | boolean } => !!a && typeof a.key === 'string' && a.key.length < 120 && ['string', 'number', 'boolean'].includes(typeof a.value)
            && (typeof a.value !== 'string' || a.value.length <= 5000)).slice(0, 500)
        : [];
    return { answers, notKnown: keys(b.notKnown), cleared: keys(b.cleared), checked: keys(b.checked), detailsConfirmed: b.detailsConfirmed === true, termsAccepted: b.termsAccepted === true };
}

export function claimFormRouter(getDeps: () => ClaimFormDeps | null): Router {
    const router = Router();
    const off = (res: Response) => res.status(503).json({ ok: false, message: 'The claim form is not set up.' });

    /** The link's row for a data call; it answers the request itself when the link doesn't work. */
    const linked = async (d: ClaimFormDeps, req: Request, res: Response): Promise<GuidedLinkRow | null> => {
        privateHeaders(res);
        const opened = await openGuidedLink(d, req.params.token);
        if (!opened.ok) {
            res.status(opened.reason === 'not-found' ? 404 : 410).json({ ok: false, reason: opened.reason });
            return null;
        }
        return opened.row;
    };
    /** The link is checked before the body is read: without one, nothing is buffered. */
    const linkFirst = async (req: Request, res: Response, next: () => void) => {
        const d = getDeps();
        if (!d) return void off(res);
        try {
            const link = await linked(d, req, res);
            if (!link) return;
            res.locals.link = link;
            next();
        } catch (e) { failed('link', res, e); }
    };
    const failed = (what: string, res: Response, e: unknown) => {
        console.error(`[ClaimForm] ${what} failed:`, (e as Error).message);
        if (!res.headersSent) res.status(500).json({ ok: false, message: 'Something went wrong. Please try again.' });
    };

    const apiKey = (req: Request, res: Response, next: () => void) => {
        const d = getDeps();
        if (!d) return void off(res);
        if (!d.apiKey || !sameKey(req.header('authorization') ?? '', `Bearer ${d.apiKey}`)) return void res.status(401).json({ ok: false, message: 'Unauthorised' });
        next();
    };

    // TTTFG-5188: the email agent fills an email claim's form, but only Tina's login reads the insurers' blank forms.
    router.get('/api/blank-form', apiKey, async (req: Request, res: Response) => {
        const d = getDeps()!;
        const url = typeof req.query.url === 'string' ? req.query.url : '';
        if (!isBlankFormUrl(url)) return void res.status(400).json({ ok: false, message: 'Not a blank claim form' });
        if (!d.blankForm) return void off(res);
        try {
            res.set('Cache-Control', 'no-store').type('application/pdf').send(Buffer.from(await d.blankForm(url)));
        } catch (e) { failed('blank form', res, e); }
    });

    // TTTFG-5188: an email claim's link. The key is checked before the body is read. An email claim has no WhatsApp number.
    router.post('/api/links', apiKey, express.json({ limit: '10kb' }), async (req: Request, res: Response) => {
        const d = getDeps()!;
        try {
            const { claimId, contactId, callbackUrl } = (req.body ?? {}) as Record<string, unknown>;
            const id = /^[0-9a-f-]{36}$/i;
            if (typeof claimId !== 'string' || !id.test(claimId) || typeof contactId !== 'string' || !id.test(contactId)) return void res.status(400).json({ ok: false, message: 'claimId and contactId are required' });
            const url = typeof callbackUrl === 'string' ? callbackUrl : '';
            if (!url.startsWith('https://')) return void res.status(400).json({ ok: false, message: 'callbackUrl must be https' });
            const own = (() => { try { return new URL(url).host === new URL(d.publicUrl).host; } catch { return true; } })();
            if (own) return void res.status(400).json({ ok: false, message: 'callbackUrl may not be Tina itself' });
            const made = await createGuidedLink(d, { claimId, contactId, phone: '', callbackUrl: url });
            res.status(201).json({ url: made.url, expiresAt: made.expiresAt });
        } catch (e) { failed('create', res, e); }
    });

    // The user (9 Nov 2026): the email agent's half of signing on the form. The drawing never leaves Tina: the agent asks
    // whether there is one, and then names the signing request it made; Tina signs that request with it.
    router.post('/api/form-signature', apiKey, express.json({ limit: '10kb' }), async (req: Request, res: Response) => {
        const d = getDeps()!;
        if (!d.emailSigning) return void off(res);
        try {
            const claimId = (req.body ?? {}).claimId;
            if (typeof claimId !== 'string' || !/^[0-9a-f-]{36}$/i.test(claimId)) return void res.status(400).json({ ok: false, message: 'claimId is required' });
            res.json({ ok: true, found: await d.emailSigning.hasFormSignature(claimId) });
        } catch (e) { failed('form signature', res, e); }
    });
    router.post('/api/sign-with-form', apiKey, express.json({ limit: '10kb' }), async (req: Request, res: Response) => {
        const d = getDeps()!;
        if (!d.emailSigning) return void off(res);
        try {
            const link = (req.body ?? {}).link;
            if (typeof link !== 'string' || !link.startsWith('https://')) return void res.status(400).json({ ok: false, message: 'link is required' });
            const r = await d.emailSigning.signWithForm(link);
            res.status(r.ok ? 200 : 409).json(r);
        } catch (e) { failed('sign with form', res, e); }
    });

    router.get('/:token', async (req: Request, res: Response) => {
        const d = getDeps();
        if (!d) return void off(res);
        privateHeaders(res);
        res.set('Content-Security-Policy', CLAIM_FORM_CSP);
        try {
            const opened = await openGuidedLink(d, req.params.token, { record: !LINK_PREVIEW.test(req.header('user-agent') ?? '') });
            if (!opened.ok) return void res.status(opened.reason === 'not-found' ? 404 : opened.reason === 'done' ? 200 : 410).type('html').send(refusedPage(opened.reason, d.whatsApp, opened.emailed));
            res.type('html').send(claimFormPage());
        } catch (e) {
            console.error('[ClaimForm] page failed:', (e as Error).message);
            res.status(500).type('text').send('Something went wrong. Please try again in a minute.');
        }
    });

    router.get('/:token/state', async (req: Request, res: Response) => {
        const d = getDeps();
        if (!d) return void off(res);
        try {
            const link = await linked(d, req, res);
            if (link) res.json({ ...(await d.session(link).view()), ...(link.callback_url ? { emailed: true } : {}), ...(signsHere(d, link) ? { sign: true } : {}) });
        } catch (e) { failed('state', res, e); }
    });

    router.post('/:token/answers', linkFirst, express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
        const d = getDeps();
        if (!d) return void off(res);
        try {
            const link = res.locals.link as GuidedLinkRow;
            res.json(await inTurn(link.id, () => d.session(link).save(saveInput(req.body))));
        } catch (e) { failed('save', res, e); }
    });

    router.post('/:token/voice', linkFirst, express.raw({ type: () => true, limit: VOICE_MAX }), async (req: Request, res: Response) => {
        const d = getDeps();
        if (!d) return void off(res);
        try {
            const link = res.locals.link as GuidedLinkRow;
            const bytes = req.body as Buffer;
            const mimeType = String(req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
            if (!Buffer.isBuffer(bytes) || !bytes.length || !/^(audio|video)\//.test(mimeType)) return void res.status(400).json({ ok: false, message: VOICE_PROBLEM.unsupported });
            const r = await d.session(link).hear(bytes, mimeType, typeof req.query.key === 'string' ? req.query.key.slice(0, 120) : undefined);
            res.json('text' in r ? { text: r.text } : { message: VOICE_PROBLEM[r.problem] ?? VOICE_PROBLEM.unavailable });
        } catch (e) { failed('voice', res, e); }
    });

    router.post('/:token/file', linkFirst, express.raw({ type: () => true, limit: FILE_MAX }), async (req: Request, res: Response) => {
        const d = getDeps();
        if (!d) return void off(res);
        try {
            const link = res.locals.link as GuidedLinkRow;
            const bytes = req.body as Buffer;
            const mimeType = String(req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
            const type = FILE_TYPES[mimeType];
            if (!type) return void res.status(415).json({ ok: false, message: 'Please send a photo, a PDF or a video.' });
            if (!Buffer.isBuffer(bytes) || !bytes.length) return void res.status(400).json({ ok: false, message: 'That file was empty. Please try again.' });
            const item = typeof req.query.item === 'string' ? req.query.item.slice(0, 120) : undefined;
            // A name of our own: the client's file name is theirs, and may say anything.
            const fileName = `${item ?? 'claim-file'}-${Date.now()}.${type.ext}`;
            const r = await d.session(link).file({ fileName, mimeType, media: type.media }, bytes, item);
            res.json({ ok: true, count: r.count });
        } catch (e) { failed('file', res, e); }
    });

    router.post('/:token/submit', linkFirst, express.json({ limit: '2mb' }), async (req: Request, res: Response) => {
        const d = getDeps();
        if (!d) return void off(res);
        try {
            const link = res.locals.link as GuidedLinkRow;
            const signature = typeof req.body?.signature === 'string' ? req.body.signature : '';
            // The same check as the signing page's: a PNG from the pad, of a pad's size.
            if (signsHere(d, link) && !signaturePng(signature)) return void res.status(400).json({ ok: false, message: 'Please sign in the box.' });
            const session = d.session(link);
            const r = await inTurn(link.id, () => session.finish());
            if (r.open.length) return void res.json({ ok: false, open: r.open });
            if (signsHere(d, link)) {
                // Kept on the link until Tina has filled the form. If it can't be kept, the client gets a signing link as before.
                await saveFormSignature(d, link.id, { signature, ip: clientIp(req), userAgent: req.header('user-agent') ?? null })
                    .catch((e) => console.error('[ClaimForm] the signature was not kept; a signing link goes instead:', (e as Error).message));
            }
            await session.carryOn();
            await finishGuidedLink(d, link.id);
            res.json({ ok: true, open: [] });
        } catch (e) { failed('submit', res, e); }
    });

    // A body over its limit, or that isn't JSON, gets a sentence, not a stack trace.
    router.use((err: { type?: string; status?: number }, _req: Request, res: Response, next: (e?: unknown) => void) => {
        if (err?.type === 'entity.too.large') return void res.status(413).json({ ok: false, message: 'That file is too big. Please try a smaller one.' });
        if (err?.status === 400) return void res.status(400).json({ ok: false, message: 'Please try that again.' });
        next(err);
    });

    return router;
}
