import crypto from 'crypto';

/**
 * Constant-time HMAC-SHA256 verification of a raw request body against a
 * hex-encoded signature header value. Shared by every signed webhook the bot
 * receives — LoE-signed, outbound-notify, anything else added later. All
 * comparisons are constant-time to keep the route resistant to timing attacks.
 */
export function verifyHmacSha256(rawBody: Buffer, headerSig: string | undefined, secret: string): boolean {
    if (!headerSig) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    let b: Buffer;
    try {
        b = Buffer.from(headerSig, 'utf8');
    } catch {
        return false;
    }
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}
