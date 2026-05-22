import crypto from 'crypto';

function base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function mintLoeToken(leadId: string, secret: string): string {
    const issuedAt = Math.floor(Date.now() / 1000);
    const mac = crypto.createHmac('sha256', secret).update(`${leadId}:${issuedAt}`).digest();
    return `${issuedAt}.${base64url(mac)}`;
}

export function buildLoeMagicLink(leadId: string): string | null {
    const secret = process.env.LOE_SIGNING_SECRET;
    if (!secret) {
        console.warn('[LoE link] LOE_SIGNING_SECRET not set — cannot mint magic link');
        return null;
    }
    if (!leadId) return null;
    const host = process.env.LOE_ONBOARDING_HOST || 'ttt-financial-forms.vercel.app';
    const token = mintLoeToken(leadId, secret);
    return `https://${host}/onboarding/loe/${leadId}?token=${encodeURIComponent(token)}`;
}
