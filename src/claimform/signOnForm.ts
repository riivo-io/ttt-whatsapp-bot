/**
 * The user (9 Nov 2026): the client signs at the end of the guided form (routes/claimForm.route.ts keeps the drawing on the
 * link), and the claims package's signing step signs the filled form with it instead of sending a link.
 */
import { clearFormSignature, EMAIL_CLAIM_CALLER, formSignatureFor, type GuidedLinkDeps } from './links';
import { openSigningRequest, signRequest, type SigningDeps } from '../signing/signing';
import type { ClaimFormDeps } from '../routes/claimForm.route';
import type { DemoSigning } from '../services/claimsDemoWiring';

/**
 * The user (9 Nov 2026): the client signed at the end of the guided form. The signing step takes that signature (it is
 * cleared from the link as it is read: the signed form and its audit are the record, and if it can't be used the client
 * gets the link) and signs the filled form's new request with it, through the signing page's own signRequest: the hash
 * check, stamp, audit and callback, which files the signed copy and sets the claim to Signed. It waits for the callback,
 * so Tina's next words come after it.
 */
export function signWithFormSignature(d: SigningDeps, links: GuidedLinkDeps): Pick<DemoSigning, 'formSignature' | 'signWithFormSignature'> {
    return {
        formSignature: async (claimId) => {
            const s = await formSignatureFor(links, claimId);
            if (!s) return null;
            await clearFormSignature(links, s.linkId);
            return { signature: s.signature, ip: s.ip, userAgent: s.userAgent };
        },
        signWithFormSignature: async (request, s) => {
            const token = new URL(request.link).pathname.split('/').pop() ?? '';
            const r = await signRequest(d, token, s);
            if (!r.ok) {
                console.error(`[ClaimsDemo] signing request ${request.id} with the form's signature refused: ${r.reason}`);
                return false;
            }
            // Signed now, so never a link after it. A callback that isn't taken yet is retried by the signing sweep.
            if (!(await r.delivery)) console.error(`[ClaimsDemo] signed request ${request.id}: the callback wasn't taken yet; the sweep retries it`);
            return true;
        },
    };
}

/**
 * The user (9 Nov 2026): an email claim's client signs at the end of the form too. The email agent fills the form, so it
 * asks Tina whether there is a signature (the drawing stays here), makes its own signing request (caller claim-email) and
 * names it; Tina signs that request with the claim's signature. Only a claim-email request, and only with the signature
 * from that same claim's form. It doesn't wait for the callback (the email agent's own function, which it is calling from):
 * the signing sweep retries it.
 */
export function emailClaimSigning(d: SigningDeps, links: GuidedLinkDeps): NonNullable<ClaimFormDeps['emailSigning']> {
    return {
        hasFormSignature: async (claimId) => !!(await formSignatureFor(links, claimId)),
        signWithForm: async (requestLink) => {
            const token = new URL(requestLink).pathname.split('/').pop() ?? '';
            const opened = await openSigningRequest(d, token, { record: false });
            if (!opened.ok) return { ok: false, reason: opened.reason };
            if (opened.row.caller !== EMAIL_CLAIM_CALLER) return { ok: false, reason: 'not-this-caller' };
            const s = await formSignatureFor(links, opened.row.caller_record_id);
            if (!s) return { ok: false, reason: 'no-signature' };
            // Used once, either way: if it can't sign, the client gets the link instead.
            await clearFormSignature(links, s.linkId);
            const r = await signRequest(d, token, s);
            if (!r.ok) {
                console.error(`[ClaimForm] signing request ${opened.row.id} with the email claim's form signature refused: ${r.reason}`);
                return { ok: false, reason: r.reason };
            }
            void r.delivery.then((ok) => { if (!ok) console.error(`[ClaimForm] signed request ${opened.row.id}: the callback wasn't taken yet; the sweep retries it`); });
            return { ok: true };
        },
    };
}
