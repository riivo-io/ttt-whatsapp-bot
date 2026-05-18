/**
 * Map the WhatsApp bot's `save_document` enum to the canonical doc-type
 * labels the email→Power Automate flow writes into
 * riivo_taxsubmissionsdocuments.riivo_taxsubmissionsdocument (the entity's
 * primary name field, which acts as a free-text doc-type tag because the
 * _riivo_documenttype_value lookup is left null today).
 *
 * Strategy: 6 clean mappings, 5 fall through to "Other". 90% of real
 * uploads are IRP5 / bank statements / medical aid certs so "Other" is
 * the right bucket for the long tail. The actual bot-side label + filename
 * + Claude's free-text summary always go into riivo_documentnotes, so
 * nothing is lost — consultants can re-tag "Other" rows from there.
 *
 * If extending: prefer mapping into a string Power Automate would have
 * emitted, not inventing new labels. The Power Automate switch-statement
 * label list is the canonical set.
 */

const BOT_TO_CANONICAL: Record<string, string> = {
    'IRP5': 'IRP5',
    'IT3(a)': 'Other',
    'IT3(b)': 'IT3(b) Certificate',
    'Payslip': 'Other',
    'Medical Certificate': 'Medical Aid Tax Certificate',
    'Till Slip / Receipt': 'Other',
    'Logbook': 'Logbook',
    'ID Document': 'Other',
    'Bank Statement': 'Bank Statements',
    'Tax Certificate': 'Other',
    'Other': 'Other',
};

export function mapDocTypeToCanonical(botDocType: string): string {
    return BOT_TO_CANONICAL[botDocType] || 'Other';
}
