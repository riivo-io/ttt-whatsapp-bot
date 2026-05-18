/**
 * Maps the flat per-type field triplets on riivo_preseasondocumentation
 * into one structured catalogue. The preseason form has 13 doc types, each
 * with an "applicable?" Bool, a "status" OptionSet, and a file-name field.
 *
 * Used by the bot to:
 *   - List outstanding docs (applicable=true AND status != received)
 *   - List received docs (applicable=true AND status == received OR file present)
 *
 * Field names below are taken verbatim from the entity JSON dump confirmed
 * with the user on 2026-05-14.
 */

export interface PreseasonDocTypeFields {
    label: string;
    applicabilityField: string;
    statusField: string;
    fileNameField: string;
}

export const PRESEASON_DOC_TYPES: readonly PreseasonDocTypeFields[] = [
    { label: 'IRP5',                       applicabilityField: 'riivo_irp5',                   statusField: 'riivo_irp5status',                   fileNameField: 'riivo_irp5documentation_name' },
    { label: 'Commission statement',       applicabilityField: 'riivo_commissionstatement',    statusField: 'riivo_commissionstatementstatus',    fileNameField: 'riivo_commissiondocumentation_name' },
    { label: 'Bank statement',             applicabilityField: 'riivo_bankstatement',          statusField: 'riivo_bankstatementstatus',          fileNameField: 'riivo_bankstatementdocumentation_name' },
    { label: 'Investment certificate',     applicabilityField: 'riivo_investmentcertificate',  statusField: 'riivo_investmentcertificatestatus',  fileNameField: 'riivo_investmentcertificatedocument_name' },
    { label: 'Retirement annuity',         applicabilityField: 'riivo_retirementannuity',      statusField: 'riivo_retirementannuitystatus',      fileNameField: 'riivo_retirementannuitytaxcertificate_name' },
    { label: 'Medical aid tax certificate', applicabilityField: 'riivo_medicalaid',            statusField: 'riivo_medicalaidstatus',             fileNameField: 'riivo_medicalaidtaxcertificate_name' },
    { label: 'Vehicle',                    applicabilityField: 'riivo_vehicle',                statusField: 'riivo_vehiclestatus',                fileNameField: 'riivo_vehicledocumentation_name' },
    { label: 'Logbook',                    applicabilityField: 'riivo_logbook',                statusField: 'riivo_logbookstatus',                fileNameField: 'riivo_logbookdocument_name' },
    { label: 'Travel documentation',       applicabilityField: 'riivo_traveldoc',              statusField: 'riivo_traveldocstatus',              fileNameField: 'riivo_traveldoccompleted_name' },
    { label: 'Fringe benefit letter',      applicabilityField: 'riivo_fringebenefit',          statusField: 'riivo_fringebenefitstatus',          fileNameField: 'riivo_fringebenefitletter_name' },
    { label: 'Signed approval',            applicabilityField: 'riivo_signedapproval',         statusField: 'riivo_signedapprovalstatus',         fileNameField: 'riivo_signedapprovaldocument_name' },
    { label: 'Rental income',              applicabilityField: 'riivo_rentalincome',           statusField: 'riivo_rentalincomestatus',           fileNameField: 'riivo_rentalincomedocument_name' },
    { label: 'Donation',                   applicabilityField: 'riivo_donation',               statusField: 'riivo_donationstatus',               fileNameField: 'riivo_donationdocument_name' },
] as const;

export const PRESEASON_SELECT_FIELDS: readonly string[] = [
    'riivo_preseasondocumentationid',
    'riivo_taxyear',
    '_riivo_customer_value',
    'riivo_othersourcecodes',
    'statecode',
    'statuscode',
    'modifiedon',
    ...PRESEASON_DOC_TYPES.flatMap(t => [t.applicabilityField, t.statusField, t.fileNameField]),
];

/**
 * Built-in statuscode OptionSet values on riivo_preseasondocumentation.
 * Confirmed against the live form on 2026-05-15:
 *   1         = Awaiting Documents
 *   100000001 = Ready for Submission
 * Bot reads these directly — no separate "ready" Boolean exists or is
 * needed. The status reason is set by the Power Automate flow watching
 * child taxsubmissionsdocuments rows.
 */
export const PRESEASON_STATUS_AWAITING = 1;
export const PRESEASON_STATUS_READY = 100000001;

/**
 * Match the per-type `riivo_<type>status` FormattedValue (string) against
 * substrings that indicate the doc has been collected. We match by string
 * instead of raw OptionSet integer so this stays correct if the admin
 * renumbers values — the FormattedValue is whatever the OptionSet label
 * shows on the form (e.g. "Received", "Uploaded", "Complete", "Approved").
 */
const RECEIVED_LABEL_PATTERNS: readonly RegExp[] = [
    /\breceived\b/i,
    /\buploaded\b/i,
    /\bcomplete(d)?\b/i,
    /\bapproved\b/i,
    /\bsubmitted\b/i,
];

function looksReceived(statusFormatted: string | null): boolean {
    if (!statusFormatted) return false;
    return RECEIVED_LABEL_PATTERNS.some(p => p.test(statusFormatted));
}

export interface PreseasonDocStateRow {
    label: string;
    applicable: boolean;
    statusRaw: number | null;
    statusFormatted: string | null;
    fileName: string | null;
    received: boolean;
}

/**
 * Walks one preseason record and produces a structured per-type row. The
 * bot can then filter applicable+!received for Q3 and applicable+received
 * for Q4. A present file-name is also treated as received — legacy data
 * may have the file but no status flip, and the client clearly sent it.
 */
export function readPreseasonDocStates(record: any): PreseasonDocStateRow[] {
    return PRESEASON_DOC_TYPES.map(type => {
        const applicable = record?.[type.applicabilityField] === true;
        const statusRaw = typeof record?.[type.statusField] === 'number' ? record[type.statusField] : null;
        const statusFormatted = record?.[`${type.statusField}@OData.Community.Display.V1.FormattedValue`] || null;
        const fileName = record?.[type.fileNameField] || null;
        const received = applicable && (looksReceived(statusFormatted) || !!fileName);
        return { label: type.label, applicable, statusRaw, statusFormatted, fileName, received };
    });
}
