/**
 * Working-day math for SARS audit duration. Mon-Fri only in v1 — does not
 * exclude South African public holidays. Acceptable for the bot's audit
 * answers because the 21/60-day SARS window is itself approximate and TTT
 * communicates exceptions via email.
 */

const STANDARD_AUDIT_WORKING_DAYS = 21;
const EXTENDED_AUDIT_WORKING_DAYS = 60;

export function workingDaysBetween(from: Date, to: Date): number {
    if (to <= from) return 0;
    let count = 0;
    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setHours(0, 0, 0, 0);

    while (cursor < end) {
        cursor.setDate(cursor.getDate() + 1);
        const day = cursor.getDay();
        if (day !== 0 && day !== 6) count++;
    }
    return count;
}

export type AuditDurationBucket = 'within_standard' | 'in_extension' | 'past_extension';

export interface AuditDurationSummary {
    daysOnAudit: number;
    bucket: AuditDurationBucket;
    standardDays: number;
    extendedDays: number;
}

export function summariseAuditDuration(placedOnAudit: Date, now: Date = new Date()): AuditDurationSummary {
    const daysOnAudit = workingDaysBetween(placedOnAudit, now);
    let bucket: AuditDurationBucket;
    if (daysOnAudit <= STANDARD_AUDIT_WORKING_DAYS) bucket = 'within_standard';
    else if (daysOnAudit <= EXTENDED_AUDIT_WORKING_DAYS) bucket = 'in_extension';
    else bucket = 'past_extension';

    return {
        daysOnAudit,
        bucket,
        standardDays: STANDARD_AUDIT_WORKING_DAYS,
        extendedDays: EXTENDED_AUDIT_WORKING_DAYS,
    };
}
