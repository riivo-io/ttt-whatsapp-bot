import { GraphMessage } from './graphMail.service';

console.log('[boot] forwardedEmail.service: imports done');

export interface ParsedForwardedEmail {
    originalSenderEmail: string;
    originalSenderName: string | null;
    originalBody: string;
    forwarderEmail: string;
    forwarderName: string | null;
    subject: string | null;
}

// Banner-style markers that signal "the forwarded content starts here." These
// sit ABOVE the forwarded headers, so once one matches we slice PAST it to get
// at the "From:" line beneath. Patterns are tolerant — Outlook, Gmail, Apple
// Mail, and Office 365 web all wrap forwards differently.
const BANNER_MARKERS: RegExp[] = [
    /^[ \t>]*-{2,}\s*Forwarded message\s*-{2,}/im,
    /^[ \t>]*Begin forwarded message\s*:?\s*$/im,
    /^[ \t>]*-{2,}\s*Original Message\s*-{2,}/im,
];

// "From:"-style markers. These ARE the original sender's header line — when one
// of these is the earliest marker (no banner above it, which is how Outlook
// inline-forwards look) we must slice from the START of the match, not past it.
// Slicing past it would land the extractor on the NEXT "From:" line down the
// thread — i.e. the consultant's own reply — and relay to the wrong person.
const FROM_MARKERS: RegExp[] = [
    /^[ \t>]*From\s*:\s*.+?\s*<[^>]+@[^>]+>\s*$/im,
    /^[ \t>]*De\s*:\s*.+?\s*<[^>]+@[^>]+>\s*$/im,
    /^[ \t>]*Van\s*:\s*.+?\s*<[^>]+@[^>]+>\s*$/im,
    /^[ \t>]*Von\s*:\s*.+?\s*<[^>]+@[^>]+>\s*$/im,
];

// Reply-quote markers — once we hit one of these in the original body, drop
// everything after. The original message rarely needs the prior thread.
const REPLY_QUOTE_MARKERS: RegExp[] = [
    /^On\s+.+?\s+wrote\s*:\s*$/im,
    /^Le\s+.+?\s+a écrit\s*:\s*$/im,
    /^Op\s+.+?\s+schreef\s+.+?\s*:\s*$/im,
    /^From\s*:\s*.+?\s*<[^>]+@[^>]+>\s*$/im,
];

// Match a "From: Display Name <email@host>" or "From: email@host" line.
// Used to extract the original client's email from inside the forwarded body.
const FROM_LINE_REGEX = /^[ \t>]*(?:From|De|Van|Von|Da)\s*:\s*(?:"?([^"<\n]*?)"?\s*<?\s*)?([\w.+\-]+@[\w\-]+\.[\w.\-]+)>?\s*$/im;

const SUBJECT_LINE_REGEX = /^[ \t>]*(?:Subject|Sujet|Onderwerp|Betreff|Asunto)\s*:\s*(.+?)\s*$/im;

/**
 * Strip a body of HTML tags as a fallback. We ask Graph for plain text, but
 * Outlook occasionally still sends HTML through. This is a best-effort cleanup
 * — for the v1 parser we then re-run all the regex matches on the result.
 */
function stripHtml(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\r\n/g, '\n');
}

/**
 * Find the earliest position in `text` where any of the markers matches.
 * Returns -1 if none match.
 */
function findFirstMarkerIndex(text: string, markers: RegExp[]): { index: number; matchEnd: number } {
    let earliest = { index: -1, matchEnd: -1 };
    for (const m of markers) {
        const match = m.exec(text);
        if (match && match.index !== undefined) {
            if (earliest.index === -1 || match.index < earliest.index) {
                earliest = { index: match.index, matchEnd: match.index + match[0].length };
            }
        }
    }
    return earliest;
}

/**
 * Locate the start of the forwarded region. Whichever of the two marker
 * families matches earliest wins:
 *   - A banner marker ("----- Forwarded message -----") sits above the headers,
 *     so we slice PAST it (`matchEnd`) to reach the "From:" line beneath.
 *   - A "From:" marker IS the original sender's header, so we slice from its
 *     START (`index`) so the From-line extractor reads that very line — not the
 *     next message down the thread.
 * Returns -1 if neither family matches.
 */
function findForwardedRegionStart(body: string): number {
    const banner = findFirstMarkerIndex(body, BANNER_MARKERS);
    const from = findFirstMarkerIndex(body, FROM_MARKERS);

    if (banner.index === -1 && from.index === -1) return -1;

    // Banner wins only if it's strictly above the first From: line. (When a
    // banner precedes the headers, the From: line lives inside the banner's
    // trailing region anyway, so slicing past the banner still finds it.)
    const bannerWins =
        banner.index !== -1 && (from.index === -1 || banner.index < from.index);

    return bannerWins ? banner.matchEnd : from.index;
}

/**
 * Parse a Microsoft Graph message that should be a forwarded email.
 * Returns null if we can't extract the original sender's email — caller
 * is expected to handle that by emailing the forwarder asking for the
 * client's WhatsApp number directly.
 */
export function parseForwarded(message: GraphMessage): ParsedForwardedEmail | null {
    const forwarderEmail = (message.from?.emailAddress?.address || '').toLowerCase().trim();
    const forwarderName = message.from?.emailAddress?.name || null;
    const subject = message.subject?.replace(/^(?:Fwd?|Re|FW)\s*:\s*/gi, '').trim() || null;

    if (!forwarderEmail) {
        console.warn('[ForwardedEmail] Message has no From address — cannot parse');
        return null;
    }

    let body = message.body?.content || '';
    if (message.body?.contentType === 'html') {
        body = stripHtml(body);
    }

    if (!body.trim()) {
        console.warn('[ForwardedEmail] Message body empty');
        return null;
    }

    // Locate the forwarded section. If we don't find any marker, treat the
    // whole body as the original message (rare — usually means the staff
    // member typed something that looked like a forward but technically isn't).
    const regionStart = findForwardedRegionStart(body);
    const forwardedRegion = regionStart >= 0 ? body.slice(regionStart) : body;

    // Inside the forwarded region, find the From: line. The first match wins.
    const fromMatch = FROM_LINE_REGEX.exec(forwardedRegion);
    if (!fromMatch) {
        // Fallback: scan the whole body. Sometimes the From: line sits ABOVE
        // the explicit "Forwarded message" marker (Outlook does this with
        // some clients).
        const fallback = FROM_LINE_REGEX.exec(body);
        if (!fallback) {
            console.warn('[ForwardedEmail] No "From:" line found in body');
            return null;
        }
        return buildResult(body, fallback, subject, forwarderEmail, forwarderName);
    }

    return buildResult(forwardedRegion, fromMatch, subject, forwarderEmail, forwarderName);
}

function buildResult(
    region: string,
    fromMatch: RegExpExecArray,
    subject: string | null,
    forwarderEmail: string,
    forwarderName: string | null
): ParsedForwardedEmail {
    const originalSenderName = (fromMatch[1] || '').trim() || null;
    const originalSenderEmail = fromMatch[2].toLowerCase().trim();

    // Skip past the From: line and any subsequent header-like lines (To, Sent,
    // Date, Subject, Cc) before the body proper begins. We treat the first
    // blank line after the From: block as the start of the body.
    const afterFrom = region.slice((fromMatch.index || 0) + fromMatch[0].length);
    const bodyStartMatch = /\n\s*\n/.exec(afterFrom);
    let body = bodyStartMatch ? afterFrom.slice(bodyStartMatch.index + bodyStartMatch[0].length) : afterFrom;

    // Try to extract the subject from the forwarded headers if we don't already
    // have one (the email's own Subject is "Fwd: ..." which we already stripped).
    let resolvedSubject = subject;
    if (!resolvedSubject) {
        const subjectMatch = SUBJECT_LINE_REGEX.exec(region.slice(fromMatch.index || 0));
        if (subjectMatch) resolvedSubject = subjectMatch[1].trim();
    }

    // Drop any nested reply-quote section ("On <date>, <name> wrote:" + quoted
    // text). The current email is what the client wants help with; deeper
    // history is rarely useful and bloats the prompt.
    const quoteMarker = findFirstMarkerIndex(body, REPLY_QUOTE_MARKERS);
    if (quoteMarker.index > 0) {
        body = body.slice(0, quoteMarker.index);
    }

    // Tidy whitespace: collapse 3+ blank lines, strip leading/trailing.
    body = body.replace(/\n{3,}/g, '\n\n').trim();

    return {
        originalSenderEmail,
        originalSenderName,
        originalBody: body,
        forwarderEmail,
        forwarderName,
        subject: resolvedSubject,
    };
}

// ---------------------------------------------------------------------------
// Forwarder round-trip: parsing a consultant's reply for the client's details
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Loose phone matcher: a run starting with an optional + then 9+ digits, with
// spaces / dots / dashes / parens allowed between them. Trimmed and validated
// by digit-count afterwards.
const PHONE_REGEX = /\+?\d[\d\s().-]{7,}\d/g;

export interface ForwarderReplyIdentifiers {
    emails: string[];
    phones: string[];
}

/**
 * Return just the consultant's freshly-typed text from a reply — everything
 * ABOVE the first quoted-thread marker. We only want what they wrote back to
 * us ("her number is 082..."), not the email addresses littered through the
 * quoted history below.
 */
export function freshReplyText(message: GraphMessage): string {
    let body = message.body?.content || '';
    if (message.body?.contentType === 'html') {
        body = stripHtml(body);
    }
    const cutoffs = [
        findForwardedRegionStart(body),
        findFirstMarkerIndex(body, REPLY_QUOTE_MARKERS).index,
    ].filter(i => i >= 0);
    if (cutoffs.length === 0) return body;
    return body.slice(0, Math.min(...cutoffs));
}

/**
 * Pull candidate client identifiers (emails and phone numbers) out of a
 * consultant's reply. `exclude` is a list of addresses to ignore — the
 * forwarder's own address and tina-bot's mailbox — so we don't treat the
 * consultant's signature email as the client's. Phones are normalised to
 * digits (leading + preserved) so the CRM phone lookup can match its variants.
 */
export function extractForwarderReplyIdentifiers(
    message: GraphMessage,
    exclude: string[] = []
): ForwarderReplyIdentifiers {
    const text = freshReplyText(message);
    const excludeSet = new Set(exclude.map(e => e.toLowerCase().trim()).filter(Boolean));

    const emails = Array.from(
        new Set((text.match(EMAIL_REGEX) || []).map(e => e.toLowerCase().trim()))
    ).filter(e => !excludeSet.has(e));

    const phones = Array.from(
        new Set(
            (text.match(PHONE_REGEX) || [])
                .map(raw => {
                    const hasPlus = raw.trim().startsWith('+');
                    const digits = raw.replace(/\D/g, '');
                    return hasPlus ? '+' + digits : digits;
                })
                // SA numbers land in 9–13 digits once normalised; this also
                // filters out stray years / reference numbers in signatures.
                .filter(p => {
                    const d = p.replace(/\D/g, '');
                    return d.length >= 9 && d.length <= 13;
                })
        )
    );

    return { emails, phones };
}
