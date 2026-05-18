/**
 * Handlers for the 5 tax-season FAQ tools wired into claude.service.ts:
 *   - get_refund_status
 *   - get_submission_status
 *   - get_received_documents
 *   - get_audit_status
 *   - get_required_documents (delegates to the existing computed-list path
 *     when no preseason record exists for the year)
 *
 * Every handler returns a JSON string the Claude turn loop relays as a
 * tool_result. Each is independently gated by an env flag so the tax team
 * can disable any one if data quality issues surface in production.
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
import { summariseAuditDuration } from '../utils/workingDays';
import { readPreseasonDocStates, PRESEASON_STATUS_READY } from '../utils/preseasonDocTypes';

const FAQ_FEATURE_FLAGS = {
    refund:        'ENABLE_REFUND_ANSWERS',
    submission:    'ENABLE_SUBMISSION_ANSWERS',
    requiredDocs:  'ENABLE_REQUIRED_DOC_ANSWERS',
    receivedDocs:  'ENABLE_RECEIVED_DOC_ANSWERS',
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

function filterPreseasonByYear(rows: any[], year?: number): any[] {
    if (!year) return rows;
    const target = String(year);
    return rows.filter(r => r?.['riivo_taxyear@OData.Community.Display.V1.FormattedValue'] === target);
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
                ? `You don't have an active tax case for ${params.taxYear} on file. Once we create one I can give you a refund update.`
                : `You don't have any active tax cases yet. Once your return is being prepared I can give you a refund update.`,
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
                message: `For your ${yearLabel || 'tax'} case we aren't sure of the exact refund amount just yet — your consultant will follow up to confirm.`,
            };
        }

        return {
            tax_year: yearLabel,
            stage: stageLabel,
            refund_rand: amount,
            refund_formatted: formatRand(amount),
            message: `Your ${yearLabel || 'tax'} case has a potential refund of ${formatRand(amount)} (case stage: ${stageLabel || 'unknown'}).`,
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
                ? `No active case for ${params.taxYear} yet — that means TTT hasn't submitted your ${params.taxYear} return yet. We only create a case once we're ready to file.`
                : `No active tax cases on file — TTT hasn't submitted a return for you yet. We only create a case once your return is ready to be filed.`,
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
        message: 'Yes — there is an active tax case on file, which means we have submitted you.',
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
                ? `You don't have any active tax cases on file, so nothing is currently under SARS audit.`
                : `None of your active tax cases are currently flagged as being under SARS audit.`,
        });
    }

    const perCase = onAudit.map(c => {
        const yearLabel = getCaseTaxYearLabel(c);
        const placedRaw = c?.riivo_dateplacedonaudit;
        if (!placedRaw) {
            return {
                tax_year: yearLabel,
                stage: getCaseStageLabel(c),
                message: `Your ${yearLabel || 'tax'} case is on audit, but the placed-on-audit date isn't recorded yet. Your consultant will be able to give you exact timelines.`,
            };
        }

        const placed = new Date(placedRaw);
        const summary = summariseAuditDuration(placed);
        const yearText = yearLabel ? ` ${yearLabel}` : '';
        let message: string;

        if (summary.bucket === 'within_standard') {
            const remaining = summary.standardDays - summary.daysOnAudit;
            message = `Your${yearText} case has been on audit for ${summary.daysOnAudit} working day${summary.daysOnAudit === 1 ? '' : 's'}. SARS audits usually conclude within ${summary.standardDays} working days, so there's about ${remaining} working day${remaining === 1 ? '' : 's'} left in the standard window.`;
        } else if (summary.bucket === 'in_extension') {
            message = `Your${yearText} case has been on audit for ${summary.daysOnAudit} working days. That's beyond the usual ${summary.standardDays}-day window — SARS can extend audits up to ${summary.extendedDays} working days in special circumstances. We email you separately if anything changes.`;
        } else {
            message = `Your${yearText} case has been on audit for ${summary.daysOnAudit} working days, which is past the ${summary.extendedDays}-day extended window. Your consultant will follow up directly to chase SARS.`;
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

export async function handleGetRequiredDocuments(params: {
    contactId: string;
    taxYear?: number;
}): Promise<string> {
    if (!isEnabled('requiredDocs')) return disabledResponse('required documents');

    const allPreseason = await dynamicsService.getPreseasonDocsForClient(params.contactId);
    const preseason = filterPreseasonByYear(allPreseason, params.taxYear);

    if (preseason.length > 0) {
        // Use the most recently modified preseason record for the chosen
        // year (the year filter already narrowed if specified).
        const record = preseason.sort((a, b) => new Date(b.modifiedon || 0).getTime() - new Date(a.modifiedon || 0).getTime())[0];
        const states = readPreseasonDocStates(record);
        const outstanding = states.filter(s => s.applicable && !s.received);
        const yearLabel = record?.['riivo_taxyear@OData.Community.Display.V1.FormattedValue'] || null;

        if (outstanding.length === 0) {
            const isReady = record?.statuscode === PRESEASON_STATUS_READY;
            const readyFlag = isReady ? ' Your preseason record is already marked ready for submission.' : '';
            return JSON.stringify({
                status: 'all_received',
                message: `Looking at your${yearLabel ? ` ${yearLabel}` : ''} preseason record, we've received everything that's applicable to you.${readyFlag}`,
            });
        }

        const lines = outstanding.map(o => `• ${o.label}`);
        return JSON.stringify({
            status: 'preseason_outstanding',
            message: `Still outstanding for your${yearLabel ? ` ${yearLabel}` : ''} return:\n${lines.join('\n')}\n\nReply with the file directly — I'll route it to your consultant.`,
            outstanding,
        });
    }

    // No preseason record exists for this year yet — fall back to the
    // generic per-industry computed list. Keeps existing behaviour for
    // clients who are pre-onboarding.
    const profile = await dynamicsService.getContactTaxProfile(params.contactId);
    const sourceCodes = profile?.sourceCodes || [];
    const industryName = profile?.industryName || null;
    const result = computeRequiredDocuments(sourceCodes, industryName);
    const message = formatRequiredDocumentsMessage(result);

    return JSON.stringify({
        status: 'computed_fallback',
        message,
        has_personalisation: result.hasPersonalisation,
    });
}

// ─── get_received_documents ───────────────────────────────────────────────

export async function handleGetReceivedDocuments(params: {
    contactId: string;
    taxYear?: number;
}): Promise<string> {
    if (!isEnabled('receivedDocs')) return disabledResponse('received documents');

    const allPreseason = await dynamicsService.getPreseasonDocsForClient(params.contactId);
    const preseason = filterPreseasonByYear(allPreseason, params.taxYear);

    const allCases = await dynamicsService.getActiveTaxCases(params.contactId);
    const cases = filterCasesByYear(allCases, params.taxYear);

    const receivedFromPreseason: { label: string; taxYear: string | null }[] = [];
    for (const record of preseason) {
        const yearLabel = record?.['riivo_taxyear@OData.Community.Display.V1.FormattedValue'] || null;
        const states = readPreseasonDocStates(record);
        states
            .filter(s => s.applicable && s.received)
            .forEach(s => receivedFromPreseason.push({ label: s.label, taxYear: yearLabel }));
    }

    const submissionDocs: { label: string; createdOn: string | null; taxYear: string | null }[] = [];
    const seenSubmissionDocIds = new Set<string>();

    const pickDocLabel = (r: any): string =>
        r?.['_riivo_documenttype_value@OData.Community.Display.V1.FormattedValue']
        || r?.riivo_taxsubmissionsdocument
        || 'Document';

    for (const c of cases) {
        const rows = await dynamicsService.getTaxSubmissionDocsByCase(c.new_caseid);
        const yearLabel = getCaseTaxYearLabel(c);
        for (const r of rows) {
            const id = r?.riivo_taxsubmissionsdocumentsid;
            if (id && seenSubmissionDocIds.has(id)) continue;
            if (id) seenSubmissionDocIds.add(id);
            submissionDocs.push({ label: pickDocLabel(r), createdOn: r?.createdon || null, taxYear: yearLabel });
        }
    }

    // Also pick up rows linked to preseason records (the WhatsApp bot writes
    // these once ENABLE_PRESEASON_DOC_LINK is on, and Power Automate is being
    // updated to do the same). querySubmissionDocs swallows errors if the
    // _riivo_preseasondoc_value lookup isn't shipped yet, so this is safe to
    // run unconditionally.
    for (const record of preseason) {
        const rows = await dynamicsService.getTaxSubmissionDocsByPreseason(record.riivo_preseasondocumentationid);
        const yearLabel = record?.['riivo_taxyear@OData.Community.Display.V1.FormattedValue'] || null;
        for (const r of rows) {
            const id = r?.riivo_taxsubmissionsdocumentsid;
            if (id && seenSubmissionDocIds.has(id)) continue;
            if (id) seenSubmissionDocIds.add(id);
            submissionDocs.push({ label: pickDocLabel(r), createdOn: r?.createdon || null, taxYear: yearLabel });
        }
    }

    if (receivedFromPreseason.length === 0 && submissionDocs.length === 0) {
        return JSON.stringify({
            status: 'none_received',
            message: `I can't see anything received from you yet${params.taxYear ? ` for ${params.taxYear}` : ''}. If you've already sent docs and they aren't showing up, your consultant can confirm — want me to flag it?`,
        });
    }

    const lines: string[] = [];
    if (receivedFromPreseason.length > 0) {
        lines.push('On your preseason record:');
        receivedFromPreseason.forEach(d => lines.push(`• ${d.label}${d.taxYear ? ` (${d.taxYear})` : ''}`));
    }
    if (submissionDocs.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('Uploaded to your case file:');
        submissionDocs.forEach(d => lines.push(`• ${d.label}${d.taxYear ? ` (${d.taxYear})` : ''}`));
    }

    return JSON.stringify({
        status: 'received',
        message: lines.join('\n'),
        preseason_count: receivedFromPreseason.length,
        submission_doc_count: submissionDocs.length,
    });
}
