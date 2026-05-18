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

// Markers that signal "the forwarded content starts here." The earliest
// occurrence in the body wins. Patterns are tolerant — Outlook, Gmail, Apple
// Mail, and Office 365 web all wrap forwards differently.
const FORWARD_MARKERS: RegExp[] = [
    /^[ \t>]*-{2,}\s*Forwarded message\s*-{2,}/im,
    /^[ \t>]*Begin forwarded message\s*:?\s*$/im,
    /^[ \t>]*-{2,}\s*Original Message\s*-{2,}/im,
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
    const marker = findFirstMarkerIndex(body, FORWARD_MARKERS);
    const forwardedRegion = marker.index >= 0 ? body.slice(marker.matchEnd) : body;

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
