/**
 * Handlers for the tax-season FAQ tools wired into claude.service.ts:
 *   - get_refund_status
 *   - get_submission_status
 *   - get_received_documents — lists rows from riivo_taxsubmissionsdocuments
 *   - get_audit_status
 *   - get_required_documents — computes the SARS-code/industry checklist
 *     (with a typical-return baseline fallback) and cross-references the
 *     uploaded entity to flag what's still outstanding.
 *
 * Every handler returns a JSON string the Claude turn loop relays as a
 * tool_result. Document-side tools are intentionally NOT feature-flagged:
 * riivo_taxsubmissionsdocuments is the single source of truth for uploads.
 *
 * Tax-year filtering is done in-memory against the OptionSet's
 * FormattedValue annotation (the Dynamics `Prefer: odata.include-annotations`
 * header in getList() makes those available alongside the raw int). This
 * sidesteps the option-set integer formulas, which differ between the
 * `ttt_taxyear` field on new_case (100000xxx scheme) and the `riivo_taxyear`
 * field on tasks/preseason (mixed schemes).
 */

import { dynamicsService, isClientStatedMarkerRow } from './dynamics.service';
import { graphMailService } from './graphMail.service';
import { computeRequiredDocuments } from './requiredDocuments.service';
import type { DocTopic } from './requiredDocuments.service';
import { getPersonalizedForms, formatTrailingLine } from './taxForms.service';
import { summariseAuditDuration } from '../utils/workingDays';

const FAQ_FEATURE_FLAGS = {
    refund:        'ENABLE_REFUND_ANSWERS',
    submission:    'ENABLE_SUBMISSION_ANSWERS',
    audit:         'ENABLE_AUDIT_ANSWERS',
} as const;

function isEnabled(flag: keyof typeof FAQ_FEATURE_FLAGS): boolean {
    const envKey = FAQ_FEATURE_FLAGS[flag];
    return process.env[envKey] !== 'false';
}

function disabledResponse(topic: string): string {
    return JSON.stringify({
        status: 'feature_disabled',
        message: `The ${topic} feature is temporarily turned off. Offer the client a consultant callback.`,
    });
}

function getCaseTaxYearLabel(caseRow: any): string | null {
    return caseRow?.['ttt_taxyear@OData.Community.Display.V1.FormattedValue'] || null;
}

function getCaseStageLabel(caseRow: any): string | null {
    return caseRow?.['icon_casestage@OData.Community.Display.V1.FormattedValue'] || null;
}

function getCaseProcessLabel(caseRow: any): string | null {
    return caseRow?.['icon_caseprocess@OData.Community.Display.V1.FormattedValue'] || null;
}

function filterCasesByYear(cases: any[], year?: number): any[] {
    if (!year) return cases;
    const target = String(year);
    return cases.filter(c => getCaseTaxYearLabel(c) === target);
}

function isOnAuditStage(stageLabel: string | null): boolean {
    if (!stageLabel) return false;
    return /\baudit\b/i.test(stageLabel);
}

function formatRand(amount: number): string {
    return `R${amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── get_refund_status ───────────────────────────────────────────────────

/**
 * Fires a one-shot email to the case owner asking them to confirm the
 * client's potential refund amount. Fire-and-forget — must not delay the
 * client's WhatsApp response. Skipped silently if Graph isn't configured.
 */
async function fireRefundNudgeEmail(params: {
    caseRow: any;
    clientName: string;
    clientPhone: string | null;
    taxYearLabel: string | null;
}): Promise<void> {
    try {
        const ownerId = params.caseRow?._ownerid_value;
        if (!ownerId) return;

        const owner = await dynamicsService.getSystemUserById(ownerId);
        if (!owner?.email) {
            console.warn('[TaxFaq] Refund nudge: owner has no email on file', { ownerId });
            return;
        }

        const yearStr = params.taxYearLabel ? ` for the ${params.taxYearLabel} tax year` : '';
        const subject = `Client ${params.clientName} asked about refund${yearStr} — please confirm potential amount`;
        const body = [
            `Hi ${owner.fullname || 'there'},`,
            '',
            `${params.clientName} just asked me on WhatsApp about their potential refund${yearStr}.`,
            '',
            `The riivo_potentialrefund field on case "${params.caseRow?.new_name || '(unnamed)'}" is currently empty, so I told them we aren't sure yet.`,
            '',
            'Could you have a look and update the potential refund amount on the case so I can give them a better answer next time?',
            params.clientPhone ? `\nClient phone: ${params.clientPhone}` : '',
            '',
            '— Tina',
        ].filter(Boolean).join('\n');

        await graphMailService.sendMail({ to: owner.email, subject, bodyText: body });
        console.log('[TaxFaq] Refund nudge email sent', { to: owner.email, case: params.caseRow?.new_caseid });
    } catch (err: any) {
        console.warn('[TaxFaq] Refund nudge email failed (non-fatal):', err?.message || err);
    }
}

export async function handleGetRefundStatus(params: {
    contactId: string;
    clientName: string;
    clientPhone: string | null;
    taxYear?: number;
}): Promise<string> {
    if (!isEnabled('refund')) return disabledResponse('refund');

    const allCases = await dynamicsService.getActiveTaxCases(params.contactId);
    const cases = filterCasesByYear(allCases, params.taxYear);

    if (cases.length === 0) {
        return JSON.stringify({
            status: 'no_active_case',
            message: params.taxYear
                ? `You don't have an active tax return for ${params.taxYear} on file. Once we set one up I can give you a refund update.`
                : `You don't have any active tax returns yet. Once your return is being prepared I can give you a refund update.`,
        });
    }

    const perCase = await Promise.all(cases.map(async c => {
        const amount = typeof c.riivo_potentialrefund === 'number' ? c.riivo_potentialrefund : null;
        const yearLabel = getCaseTaxYearLabel(c);
        const stageLabel = getCaseStageLabel(c);

        if (amount === null || amount === 0) {
            // Fire-and-forget nudge — do not await with the response.
            fireRefundNudgeEmail({
                caseRow: c,
                clientName: params.clientName,
                clientPhone: params.clientPhone,
                taxYearLabel: yearLabel,
            }).catch(() => {});
            return {
                tax_year: yearLabel,
                stage: stageLabel,
                refund: null,
                message: `For your ${yearLabel || 'tax'} return we aren't sure of the exact refund amount just yet — your consultant will follow up to confirm.`,
            };
        }

        return {
            tax_year: yearLabel,
            stage: stageLabel,
            refund_rand: amount,
            refund_formatted: formatRand(amount),
            message: `Your ${yearLabel || 'tax'} return has a potential refund of ${formatRand(amount)} (stage: ${stageLabel || 'unknown'}).`,
        };
    }));

    return JSON.stringify({ status: 'ok', cases: perCase });
}

// ─── get_submission_status ────────────────────────────────────────────────

export async function handleGetSubmissionStatus(params: {
    contactId: string;
    taxYear?: number;
}): Promise<string> {
    if (!isEnabled('submission')) return disabledResponse('submission');

    const allCases = await dynamicsService.getActiveTaxCases(params.contactId);
    const cases = filterCasesByYear(allCases, params.taxYear);

    if (cases.length === 0) {
        return JSON.stringify({
            status: 'not_submitted',
            message: params.taxYear
                ? `No active tax return for ${params.taxYear} yet — that means TTT hasn't submitted your ${params.taxYear} return yet. We only set one up once we're ready to file.`
                : `No active tax returns on file — TTT hasn't submitted a return for you yet. We only set one up once your return is ready to be filed.`,
        });
    }

    const perCase = cases.map(c => ({
        tax_year: getCaseTaxYearLabel(c),
        stage: getCaseStageLabel(c),
        process: getCaseProcessLabel(c),
        submitted: true,
    }));

    return JSON.stringify({
        status: 'submitted',
        message: 'Yes — there is an active tax return on file, which means we have submitted you.',
        cases: perCase,
    });
}

// ─── get_audit_status ─────────────────────────────────────────────────────

export async function handleGetAuditStatus(params: {
    contactId: string;
    taxYear?: number;
}): Promise<string> {
    if (!isEnabled('audit')) return disabledResponse('audit');

    const allCases = await dynamicsService.getActiveTaxCases(params.contactId);
    const cases = filterCasesByYear(allCases, params.taxYear);

    const onAudit = cases.filter(c => isOnAuditStage(getCaseStageLabel(c)));

    if (onAudit.length === 0) {
        return JSON.stringify({
            status: 'not_on_audit',
            message: cases.length === 0
                ? `You don't have any active tax returns on file, so nothing is currently under SARS audit.`
                : `None of your active tax returns are currently flagged as being under SARS audit.`,
        });
    }

    const perCase = onAudit.map(c => {
        const yearLabel = getCaseTaxYearLabel(c);
        const placedRaw = c?.riivo_dateplacedonaudit;
        if (!placedRaw) {
            return {
                tax_year: yearLabel,
                stage: getCaseStageLabel(c),
                message: `Your ${yearLabel || 'tax'} return is on audit, but the placed-on-audit date isn't recorded yet. Your consultant will be able to give you exact timelines.`,
            };
        }

        const placed = new Date(placedRaw);
        const summary = summariseAuditDuration(placed);
        const yearText = yearLabel ? ` ${yearLabel}` : '';
        let message: string;

        if (summary.bucket === 'within_standard') {
            const remaining = summary.standardDays - summary.daysOnAudit;
            message = `Your${yearText} tax return has been on audit for ${summary.daysOnAudit} working day${summary.daysOnAudit === 1 ? '' : 's'}. SARS audits usually conclude within ${summary.standardDays} working days, so there's about ${remaining} working day${remaining === 1 ? '' : 's'} left in the standard window.`;
        } else if (summary.bucket === 'in_extension') {
            message = `Your${yearText} tax return has been on audit for ${summary.daysOnAudit} working days. That's beyond the usual ${summary.standardDays}-day window — SARS can extend audits up to ${summary.extendedDays} working days in special circumstances. We email you separately if anything changes.`;
        } else {
            message = `Your${yearText} tax return has been on audit for ${summary.daysOnAudit} working days, which is past the ${summary.extendedDays}-day extended window. Your consultant will follow up directly to chase SARS.`;
        }

        return {
            tax_year: yearLabel,
            stage: getCaseStageLabel(c),
            days_on_audit: summary.daysOnAudit,
            bucket: summary.bucket,
            message,
        };
    });

    return JSON.stringify({ status: 'on_audit', cases: perCase });
}

// ─── Document tools ───────────────────────────────────────────────────────
//
// Both tools read from a single source of truth: the
// `riivo_taxsubmissionsdocuments` entity. Every WhatsApp upload writes a row
// there (with `_riivo_client_value` set to the contact); Power Automate does
// the same for emailed docs. No preseason-record reads — the entity rows are
// authoritative.

function pickSubmissionDocLabel(row: any): string {
    return row?.['_riivo_documenttype_value@OData.Community.Display.V1.FormattedValue']
        || row?.riivo_taxsubmissionsdocument
        || 'Document';
}

function formatYearTag(year: number | null): string {
    return year ? ` (${year})` : '';
}

// ─── get_received_documents ───────────────────────────────────────────────

export async function handleGetReceivedDocuments(params: {
    contactId: string;
    taxYear?: number;
}): Promise<string> {
    const rows = await dynamicsService.getTaxSubmissionDocsByClient(params.contactId, params.taxYear);

    if (rows.length === 0) {
        return JSON.stringify({
            status: 'none_received',
            message: `I can't see anything received from you yet${params.taxYear ? ` for ${params.taxYear}` : ''}. If you've already sent docs and they're not showing up here, send them through and I'll get them logged.`,
        });
    }

    // Verified uploads vs. Issue 27 "client states provided" markers. The two
    // are surfaced separately so we never present an unverified, client-stated
    // doc as something TTT has actually received.
    const toEntry = (r: any) => ({
        label: pickSubmissionDocLabel(r),
        tax_year: typeof r?.riivo_taxyear === 'number' ? r.riivo_taxyear : null,
        created_on: r?.createdon || null,
    });
    const docs = rows.filter(r => !isClientStatedMarkerRow(r)).map(toEntry);
    const clientStated = rows.filter(r => isClientStatedMarkerRow(r)).map(toEntry);

    const lines: string[] = [];
    if (docs.length > 0) {
        lines.push(`Here's what we've got on file from you${params.taxYear ? ` for ${params.taxYear}` : ''}:`);
        docs.forEach(d => lines.push(`• ${d.label}${formatYearTag(d.tax_year)}`));
    } else {
        lines.push(`I haven't got any documents confirmed on file from you yet${params.taxYear ? ` for ${params.taxYear}` : ''}.`);
    }

    if (clientStated.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('You\'ve told me these are already with your consultant (I\'ve noted them, but they\'re not confirmed on our side yet):');
        clientStated.forEach(d => lines.push(`• ${d.label}${formatYearTag(d.tax_year)} — noted as sent to your consultant`));
    }

    return JSON.stringify({
        status: docs.length > 0 ? 'received' : 'client_stated_only',
        message: lines.join('\n'),
        documents: docs,
        client_stated_unverified: clientStated,
        count: docs.length,
    });
}

// ─── get_required_documents ───────────────────────────────────────────────

/**
 * Normalise a label so we can match required-list entries against uploaded
 * rows (which carry canonical strings like "IRP5", "Bank Statements",
 * "Medical Aid Tax Certificate", "Logbook", "Other"). Lowercases, strips
 * punctuation and trailing notes in brackets.
 */
function normaliseDocLabel(label: string): string {
    return label
        .toLowerCase()
        .replace(/\([^)]*\)/g, '')
        .replace(/[—–-]/g, ' ')
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function labelsMatch(required: string, uploaded: string): boolean {
    const a = normaliseDocLabel(required);
    const b = normaliseDocLabel(uploaded);
    if (!a || !b) return false;
    if (a === b) return true;
    // Loose substring match — "irp5" matches "irp5", "bank statement" matches
    // "bank statements", "medical aid tax certificate" matches "medical aid
    // tax certificate", etc.
    return a.includes(b) || b.includes(a);
}

export async function handleGetRequiredDocuments(params: {
    contactId: string;
    taxYear?: number;
    topic?: DocTopic;
}): Promise<string> {
    const profile = await dynamicsService.getContactTaxProfile(params.contactId);
    const sourceCodes = profile?.sourceCodes || [];
    const industryName = profile?.industryName || null;
    const expected = computeRequiredDocuments(sourceCodes, industryName, new Date(), params.topic);

    // The target year for the upload cross-reference: caller-supplied if
    // given, otherwise the current SA tax year (which also matches the
    // checklist computed above).
    const targetYear = typeof params.taxYear === 'number' && Number.isFinite(params.taxYear)
        ? params.taxYear
        : expected.taxYear.label;
    const uploadedRows = await dynamicsService.getTaxSubmissionDocsByClient(params.contactId, targetYear);
    // Verified uploads suppress the ask AND count as received; Issue 27
    // "client states provided" markers suppress the ask but are surfaced
    // distinctly — never as a verified receipt.
    const uploadedLabels = uploadedRows.filter(r => !isClientStatedMarkerRow(r)).map(pickSubmissionDocLabel);
    const clientStatedLabels = uploadedRows.filter(r => isClientStatedMarkerRow(r)).map(pickSubmissionDocLabel);

    const allExpected = [...expected.bySourceCode, ...expected.byIndustry, ...expected.byTopic, ...expected.baseline];
    const seen = new Set<string>();
    const received: { label: string }[] = [];
    const clientStated: { label: string }[] = [];
    const outstanding: { label: string; notes?: string }[] = [];
    for (const doc of allExpected) {
        const key = doc.label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (uploadedLabels.some(u => labelsMatch(doc.label, u))) {
            received.push({ label: doc.label });
        } else if (clientStatedLabels.some(u => labelsMatch(doc.label, u))) {
            clientStated.push({ label: doc.label });
        } else {
            outstanding.push({ label: doc.label, notes: doc.reason });
        }
    }

    const yearLabel = targetYear;
    const lines: string[] = [];

    if (received.length > 0) {
        lines.push(`Here's what we've got on file from you for ${yearLabel}:`);
        received.forEach(d => lines.push(`• ${d.label}`));
        lines.push('');
    }

    if (clientStated.length > 0) {
        lines.push(`Noted as already sent to your consultant (not yet confirmed on our side):`);
        clientStated.forEach(d => lines.push(`• ${d.label}`));
        lines.push('');
    }

    if (outstanding.length === 0) {
        lines.push(`Looks like we've got everything we need for your ${yearLabel} return. Your consultant will be in touch if anything else comes up.`);
    } else {
        lines.push(`Still outstanding for your ${yearLabel} return:`);
        outstanding.forEach(d => lines.push(`• ${d.label}${d.notes ? ` (${d.notes})` : ''}`));
        if (!expected.hasPersonalisation) {
            lines.push('');
            lines.push('This is a typical list. Once your consultant has set up your income sources and industry, I can give you a more specific list.');
        }
        lines.push('');
        lines.push("Reply with the file directly — I'll route it to your consultant.");
    }

    const relevantForms = getPersonalizedForms(sourceCodes);
    if (relevantForms.length > 0) {
        lines.push('');
        lines.push(formatTrailingLine(relevantForms, sourceCodes));
    }

    return JSON.stringify({
        status: outstanding.length === 0 ? 'all_received' : 'outstanding',
        message: lines.join('\n'),
        tax_year: yearLabel,
        received,
        client_stated_unverified: clientStated,
        outstanding,
        has_personalisation: expected.hasPersonalisation,
    });
}
