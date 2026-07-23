/**
 * Handlers for the tax-season FAQ tools wired into claude.service.ts:
 *   - get_refund_status
 *   - get_submission_status
 *   - get_audit_status
 *   - get_required_documents — computes the SARS-code/industry list of
 *     documents associated with the client's return (with a typical-return
 *     baseline fallback). Pure ADVICE (ADR 0004): it does NOT read the client's
 *     upload records and never tells them what they have or haven't sent.
 *
 * Every handler returns a JSON string the Claude turn loop relays as a
 * tool_result.
 *
 * Tax-year filtering is done in-memory against the OptionSet's
 * FormattedValue annotation (the Dynamics `Prefer: odata.include-annotations`
 * header in getList() makes those available alongside the raw int). This
 * sidesteps the option-set integer formulas, which differ between the
 * `ttt_taxyear` field on new_case (100000xxx scheme) and the `riivo_taxyear`
 * field on tasks/preseason (mixed schemes).
 */

import { dynamicsService } from './dynamics.service';
import { graphMailService } from './graphMail.service';
import { computeRequiredDocuments, formatRequiredDocumentsMessage } from './requiredDocuments.service';
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
                ? `No active tax return for ${params.taxYear} yet — that means TTT hasn't submitted your ${params.taxYear} return yet. We only set one up once we're ready to file. Once your paperwork is in, your consultant picks it up from there, so there's nothing you need to do right now.`
                : `No active tax returns on file — TTT hasn't submitted a return for you yet. We only set one up once your return is ready to be filed. Once your paperwork is in, your consultant picks it up from there, so there's nothing you need to do right now.`,
            reply_guidance: 'Relay this as-is. Do NOT offer a consultant callback or ask if they want someone to reach out — this message already closes the loop.',
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

// ─── get_required_documents ───────────────────────────────────────────────
//
// ADR 0004 (advice-only): this reads the client's PROFILE (SARS source codes +
// industry) to personalise WHICH documents are associated with their return,
// but never reads their upload records and never diffs. Tina advises what to
// gather; she never tells the client what they have or haven't sent.

export async function handleGetRequiredDocuments(params: {
    contactId: string;
    taxYear?: number;
    topic?: DocTopic;
}): Promise<string> {
    const profile = await dynamicsService.getContactTaxProfile(params.contactId);
    const sourceCodes = profile?.sourceCodes || [];
    const industryName = profile?.industryName || null;
    const expected = computeRequiredDocuments(sourceCodes, industryName, new Date(), params.topic);

    const lines: string[] = [formatRequiredDocumentsMessage(expected)];

    const relevantForms = getPersonalizedForms(sourceCodes);
    if (relevantForms.length > 0) {
        lines.push('');
        lines.push(formatTrailingLine(relevantForms, sourceCodes));
    }

    return JSON.stringify({
        status: 'associated_documents',
        message: lines.join('\n'),
        tax_year: expected.taxYear.label,
        documents: [...expected.bySourceCode, ...expected.byIndustry, ...expected.byTopic, ...expected.baseline].map(d => ({ label: d.label, notes: d.reason })),
        has_personalisation: expected.hasPersonalisation,
    });
}
