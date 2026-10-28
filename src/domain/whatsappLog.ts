/**
 * The CRM timeline row for one WhatsApp message (riivo_whatsappcommunications, an activity table). Tina's own
 * conversations write it through dynamicsService.logMessage; the claims demo (TTTFG-4830) writes the same row to its
 * CRM, so both read the same on the timeline. Pure: the callers post it.
 */

/** What a message is filed under on the timeline. */
export type WhatsAppRegarding = { table: 'riivo_claim' | 'riivo_request' | 'contact' | 'new_lead'; id: string };

/**
 * The client the message is with: on the row as its From (the client's message) or To (Tina's), as TTT's own WhatsApp
 * flows set it. A contact's or lead's timeline shows the activities they take part in, so every message shows there
 * too, whatever record it is filed under (a request, a claim). The claims demo sets it (TTTFG-4830); Tina's own
 * conversations (dynamicsService.logMessage) don't yet.
 */
export type WhatsAppParty = { table: 'contact' | 'new_lead'; id: string };

const SETS: Record<WhatsAppRegarding['table'], string> = {
    riivo_claim: 'riivo_claims', riivo_request: 'riivo_requests', contact: 'contacts', new_lead: 'new_leads',
};
const INCOMING = 463630000;
const OUTGOING = 463630001;
const FROM = 1;
const TO = 2;

export function whatsappCommunicationRow(m: {
    text: string; direction: 'Incoming' | 'Outgoing'; phone: string; wamid?: string | null; regarding?: WhatsAppRegarding | null; at?: string;
    party?: WhatsAppParty | null;
}): Record<string, unknown> {
    const row: Record<string, unknown> = {
        subject: `WhatsApp ${m.direction}: ${m.phone}`,
        description: m.text,
        riivo_messagedirection: m.direction === 'Incoming' ? INCOMING : OUTGOING,
        riivo_from: m.direction === 'Incoming' ? m.phone : 'Bot',
        riivo_to: m.direction === 'Incoming' ? 'Bot' : m.phone,
        riivo_timestamp: m.at ?? new Date().toISOString(),
    };
    // Meta's message id (wamid.xxx) for this exact message: the client's inbound message, or the reply we sent. Lets
    // CRM link replies and delivery/read receipts back to the message. Omitted when unknown (synthetic/internal messages).
    if (m.wamid) row.riivo_messageid = m.wamid;
    if (m.regarding) row[`regardingobjectid_${m.regarding.table}@odata.bind`] = `/${SETS[m.regarding.table]}(${m.regarding.id})`;
    if (m.party) {
        row.riivo_WhatsAppCommunications_activity_parties = [{
            [`partyid_${m.party.table}@odata.bind`]: `/${SETS[m.party.table]}(${m.party.id})`,
            participationtypemask: m.direction === 'Incoming' ? FROM : TO,
        }];
    }
    return row;
}

/** Dataverse's attachment limit for a note (the organisation's maxuploadfilesize, 5 MB in TTT's environments). */
export const NOTE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * TTTFG-4830: a client's voice note, kept on its timeline row as a note with the recording attached, beside the
 * transcript in the row's description. Null when the recording is over the attachment limit.
 */
export function voiceNoteNote(m: { communicationId: string; bytes: Buffer; mimeType: string; seconds: number | null; at: string }): Record<string, unknown> | null {
    if (m.bytes.length > NOTE_ATTACHMENT_MAX_BYTES) return null;
    const type = m.mimeType.split(';')[0].trim().toLowerCase();
    const ext = type === 'audio/mp4' ? 'm4a' : type === 'audio/mpeg' ? 'mp3' : type === 'audio/wav' ? 'wav' : 'ogg';
    return {
        subject: 'Voice note',
        notetext: `The client's WhatsApp voice note${m.seconds === null ? '' : ` (${m.seconds}s)`}. What Tina heard is on the message.`,
        filename: `voice-note-${m.at.replace(/[:.]/g, '-')}.${ext}`,
        mimetype: type,
        documentbody: m.bytes.toString('base64'),
        isdocument: true,
        objecttypecode: 'riivo_whatsappcommunications',
        'objectid_riivo_whatsappcommunications@odata.bind': `/riivo_whatsappcommunicationses(${m.communicationId})`,
    };
}
