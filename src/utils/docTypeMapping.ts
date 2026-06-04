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

/**
 * Best-effort doc-type guess from an uploaded file's name, returning one of
 * the bot's `save_document` enum labels (feed it through mapDocTypeToCanonical
 * for the CRM tag). Used by the WhatsApp processor to file client uploads
 * immediately without asking the client to classify. Conservative: anything
 * unrecognised falls back to "Other", which consultants can re-tag from the
 * filename + notes preserved on the row.
 *
 * IRP5 detection here is the trigger for the OCR/parse + onboarding flow, so
 * keep it tight — only match clear IRP5 signals, not generic "tax certificate".
 */
const FILENAME_DOCTYPE_RULES: { re: RegExp; docType: string }[] = [
    { re: /irp\s*-?_?5/i, docType: 'IRP5' },
    { re: /it3\s*\(?a\)?/i, docType: 'IT3(a)' },
    { re: /it3\s*\(?b\)?/i, docType: 'IT3(b)' },
    { re: /bank|statement/i, docType: 'Bank Statement' },
    { re: /payslip|salary\s*slip|pay\s*slip/i, docType: 'Payslip' },
    { re: /medical|med\s*aid|discovery|momentum|bonitas/i, docType: 'Medical Certificate' },
    { re: /logbook|log\s*book|mileage|travel\s*log/i, docType: 'Logbook' },
    { re: /receipt|till\s*slip|invoice|slip/i, docType: 'Till Slip / Receipt' },
];

export function inferDocTypeFromFilename(fileName: string): string {
    const name = (fileName || '').toLowerCase();
    for (const rule of FILENAME_DOCTYPE_RULES) {
        if (rule.re.test(name)) return rule.docType;
    }
    return 'Other';
}
