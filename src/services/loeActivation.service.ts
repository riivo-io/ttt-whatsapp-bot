import { dynamicsService, LEAD_TYPE_TAX, buildDynamicsRecordUrl } from './dynamics.service';
import { metaWhatsAppService } from './meta.service';
import { graphMailService } from './graphMail.service';
import { caseService } from './case.service';
import { supabaseService } from './supabase.service';
import { idempotencyService } from './idempotency.service';
console.log('[boot] loeActivation.service: imports done');

const TAXCREW_EMAIL = 'taxcrew@ttt-tax.co.za';

export type ActivationOutcome =
    | 'activated'
    | 'already_activated'
    | 'non_tax_lead'
    | 'lead_not_found'
    | 'dynamics_unavailable';

export interface ActivationResult {
    outcome: ActivationOutcome;
    leadId: string;
    sentinelId?: string | null;
    whatsappSent?: boolean;
    emailSent?: boolean;
    caseResolvedCount?: number;
    error?: string;
}

/**
 * Build the post-LoE thank-you body the bot WhatsApps the lead. Copy is
 * locked in PRD §7.2.
 */
function buildThankYouMessage(firstName: string): string {
    const safeName = firstName.trim() || 'there';
    return [
        `Got your LoE 🎉 Thanks ${safeName}, that's the heavy lifting done on your side.`,
        '',
        'Last setup step is the SARS eFiling OTP. A member of our taxcrew will call you to walk you through it. They\'ve already been notified and will reach out during working hours (Mon to Fri, 8am to 4pm SAST).',
        '',
        'While you wait, you can fast-track your tax return by sending your latest IRP5 right here. That\'s the tax certificate your employer issues each year. Just send the PDF.',
        '',
        'Got questions about TTT or your tax? Ask away, I\'m here.',
    ].join('\n');
}

/**
 * Build the taxcrew email body. Copy locked in PRD §7.3.
 */
function buildTaxcrewEmail(leadName: string, phone: string | null, leadId: string): { subject: string; body: string } {
    const dynamicsUrl = buildDynamicsRecordUrl('new_lead', leadId) || `(Dynamics lead id: ${leadId})`;
    const phoneLine = phone || '(no phone on file)';
    const subject = `New lead ready for eFiling OTP call — ${leadName}`;
    const body = [
        `${leadName} (${phoneLine}) has signed their Letter of Engagement and is waiting on the SARS eFiling OTP step.`,
        '',
        'Please give them a call during working hours to walk them through the OTP at https://secure.sarsefiling.co.za/app/profileTaxType/taxTypeActivation.',
        '',
        `Lead in Dynamics: ${dynamicsUrl}`,
        '',
        'Tina has already told them to expect a call from the taxcrew, so you can dial in cold — they\'re warmed up and waiting.',
        '',
        '— Tina',
    ].join('\n');
    return { subject, body };
}

/**
 * Run the post-LoE activation flow for a single lead. Called both by the
 * LoE-signed webhook (instant) and the hourly safety-net cron sweep.
 *
 * Concurrency: a Supabase-backed in-flight mutex (loe_activation_inflight)
 * guarantees that only one invocation executes the side effects at a time
 * for a given lead. Postgres unique-key insert is atomic, which Dynamics
 * check-then-write is not. Without this, a webhook retry or a sweep/webhook
 * race double-sent the "Got your LoE" WhatsApp.
 *
 * Failure semantics: the Dynamics sentinel is only written after WhatsApp +
 * email both succeed, so partial failures get retried by the hourly sweep.
 * The in-flight mutex is released in a finally block on every exit path.
 */
export async function activateLeadPostLoe(leadId: string): Promise<ActivationResult> {
    const claimed = await idempotencyService.claimLoeActivation(leadId);
    if (!claimed) {
        console.log(`[Activation] in_flight_skip leadId=${leadId}`);
        return { outcome: 'already_activated', leadId };
    }

    try {
        const lead = await dynamicsService.getLeadById(leadId);
        if (!lead) {
            console.warn(`[Activation] lead_not_found leadId=${leadId}`);
            return { outcome: 'lead_not_found', leadId };
        }

        try {
            const existing = await dynamicsService.findPostLoeActivationSentinel(leadId);
            if (existing) {
                console.log(`[Activation] already_activated leadId=${leadId} sentinel=${existing}`);
                return { outcome: 'already_activated', leadId, sentinelId: existing };
            }
        } catch (e: any) {
            console.warn(`[Activation] sentinel lookup failed leadId=${leadId}: ${e?.message || e}`);
        }

        if (lead.leadType !== null && lead.leadType !== LEAD_TYPE_TAX) {
            console.log(`[Activation] Skipping non-Tax lead ${leadId} (leadType=${lead.leadType})`);
            return { outcome: 'non_tax_lead', leadId };
        }

        const phone = lead.mobilephone;
        const firstName = lead.firstname || '';

        let whatsappSent = false;
        if (phone) {
            const thankYouBody = buildThankYouMessage(firstName);
            let wamid: string | null = null;
            try {
                wamid = await metaWhatsAppService.sendMessage(phone, thankYouBody);
                whatsappSent = true;
                console.log(`[Activation] WhatsApp thank-you sent leadId=${leadId} phone=${phone}`);
            } catch (e: any) {
                console.error(`[Activation] WhatsApp send failed leadId=${leadId} phone=${phone}: ${e?.message || e}`);
                return { outcome: 'dynamics_unavailable', leadId, whatsappSent: false, error: e?.message || 'whatsapp_send_failed' };
            }

            // Seed the thank-you into session history so the lead's next inbound
            // lands with Tina knowing what was just said. Best-effort — failure
            // here doesn't unwind the activation (WhatsApp already delivered).
            try {
                const session = await supabaseService.getOrCreateSession(phone, leadId, 'lead');
                await supabaseService.insertAssistantMessage(session.id, thankYouBody, {
                    externalId: wamid || undefined,
                });
            } catch (e: any) {
                console.warn(`[Activation] failed to seed thank-you history leadId=${leadId}: ${e?.message || e}`);
            }
        } else {
            console.error(`[Activation] no_phone leadId=${leadId} — skipping WhatsApp but continuing with taxcrew email`);
        }

        const { subject, body } = buildTaxcrewEmail(lead.fullname || 'Lead', phone, leadId);
        let emailSent = false;
        try {
            emailSent = await graphMailService.sendMail({ to: TAXCREW_EMAIL, subject, bodyText: body });
            if (!emailSent) {
                console.error(`[Activation] taxcrew email returned false leadId=${leadId}`);
                return { outcome: 'dynamics_unavailable', leadId, whatsappSent, emailSent, error: 'taxcrew_email_failed' };
            }
            console.log(`[Activation] taxcrew email sent leadId=${leadId}`);
        } catch (e: any) {
            console.error(`[Activation] taxcrew email threw leadId=${leadId}: ${e?.message || e}`);
            return { outcome: 'dynamics_unavailable', leadId, whatsappSent, emailSent: false, error: e?.message || 'taxcrew_email_threw' };
        }

        let sentinelId: string | null = null;
        try {
            sentinelId = await dynamicsService.createPostLoeActivationSentinel(leadId, phone || '');
        } catch (e: any) {
            console.warn(`[Activation] sentinel create threw leadId=${leadId}: ${e?.message || e}`);
        }

        let caseResolvedCount = 0;
        try {
            caseResolvedCount = await caseService.resolveByLeadId(leadId, {
                skipFeedback: true,
                reason: 'post_loe_activation',
            });
        } catch (e: any) {
            console.warn(`[Activation] resolveByLeadId failed leadId=${leadId}: ${e?.message || e}`);
        }

        return {
            outcome: 'activated',
            leadId,
            sentinelId,
            whatsappSent,
            emailSent,
            caseResolvedCount,
        };
    } finally {
        await idempotencyService.releaseLoeActivation(leadId);
    }
}
