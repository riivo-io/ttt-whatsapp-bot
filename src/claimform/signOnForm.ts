/**
 * The user (9 Nov 2026): the client signs at the end of the guided form (routes/claimForm.route.ts keeps the drawing on the
 * link), and the claims package's signing step signs the filled form with it instead of sending a link.
 */
import { clearFormSignature, formSignatureFor, type GuidedLinkDeps } from './links';
import { signRequest, type SigningDeps } from '../signing/signing';
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
