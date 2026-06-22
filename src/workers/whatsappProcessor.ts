import { claudeService } from '../services/claude.service';
import { metaWhatsAppService } from '../services/meta.service';
import { dynamicsService, REQUEST_STATUSCODE } from '../services/dynamics.service';
import { supabaseService } from '../services/supabase.service';
import { stagePendingUpload, peekPendingUpload, clearPendingUpload, saveClientDocumentDirect, processClientIrp5Upload } from '../services/pendingUpload.service';
import { inferDocTypeFromFilename } from '../utils/docTypeMapping';
import { pendingIrp5Service } from '../services/pendingIrp5.service';
import {
    caseService,
    CASE_FEEDBACK_BUTTON_YES,
    CASE_FEEDBACK_BUTTON_NO,
    CASE_FEEDBACK_PROMPT_TEXT,
} from '../services/case.service';
import { sharePointService } from '../services/sharepoint.service';
import {
    matchFormByFilename,
    resolveLatestFormFile,
    kebabLabel,
    getRecentTaxFormSendForClient,
} from '../services/taxForms.service';
import { getCurrentSaTaxYear } from '../services/requiredDocuments.service';
import { handleClientRelayResponse, RELAY_BUTTON_PAYLOAD } from '../controllers/emailRelay.controller';
import { knowledgeBaseService, KbChunkHit } from '../services/knowledgeBase.service';
import { graphMailService } from '../services/graphMail.service';
import { messageContextStorage } from '../utils/messageContext';
import { WhatsAppJobPayload } from '../queue/whatsappQueue';
import { enqueueFeedbackPrompt } from '../queue/feedbackPromptQueue';
import { buildLoeMagicLink } from '../utils/loeMagicLink';
import { postWhatsAppSignupNotification } from '../services/whatsappSignupNotifier';
import {
    REFERRAL_CODE_PATTERN,
    REFERRAL_KEYWORD_PATTERN,
    buildReferralFallback,
    serviceLabelFromLeadType,
} from '../utils/firstContactRouting';
import { looksLikeGreetingOnly } from '../utils/greeting';
import {
    looksLikeAutoReply,
    shouldSendAutoReplyClarification,
    AUTO_REPLY_CLARIFICATION,
} from '../utils/autoReply';

const WRAP_UP_NOTIFICATION = "Glad I could help! 🙌 I've marked this as resolved. Message me any time if anything else comes up.";

// Text-only fallback fired only when the cold-signup Meta template send fails.
// The branded templates (`ttt_welcome_signup`, `ttt_referral_welcome`) are
// the primary path — see PRD-first-contact-templates.md §5.1(b).
const SIGN_UP_GREETING = `Welcome to TTT Financial Group 👋\n\nYou're one tap from having your tax, accounting and insurance handled here on WhatsApp.\n\nRegister in under a minute: https://www.ttt-tax.co.za/client-onboarding`;

const SIGNUP_TEMPLATE_NAME = process.env.WHATSAPP_SIGNUP_TEMPLATE_NAME || '';
const SIGNUP_TEMPLATE_LANG = process.env.WHATSAPP_SIGNUP_TEMPLATE_LANG || 'en';
const SIGNUP_TEMPLATE_HEADER_URL = process.env.WHATSAPP_SIGNUP_TEMPLATE_HEADER_URL
    || 'https://tttassets.blob.core.windows.net/assets/Welcome_TTTFinancialGroup.png';

const REFERRAL_TEMPLATE_NAME = process.env.WHATSAPP_REFERRAL_TEMPLATE_NAME || '';
const REFERRAL_TEMPLATE_LANG = process.env.WHATSAPP_REFERRAL_TEMPLATE_LANG || 'en';
// Filename in the blob container is `Refer&Earn2026 Banner.png` — space and
// ampersand are URL-encoded so Meta's fetcher hits the right asset.
const REFERRAL_TEMPLATE_HEADER_URL = process.env.WHATSAPP_REFERRAL_TEMPLATE_HEADER_URL
    || 'https://tttassets.blob.core.windows.net/assets/Refer%26Earn2026%20Banner.png';

// Stable ids for the client first-message interactive menu. Kept namespaced
// (`menu:client:*`) so future lead/staff menus can coexist without colliding.
const CLIENT_MENU_IDS = {
    INVOICES: 'menu:client:invoices',
    CASES: 'menu:client:cases',
    UPLOAD: 'menu:client:upload',
    FORMS: 'menu:client:forms',
    REFERRAL: 'menu:client:referral',
    OTHER: 'menu:client:other',
} as const;

// When a client taps a non-OTHER row, we translate the tap into a canonical
// question so the existing AI path routes to the correct tool without any
// bespoke dispatch logic.
const CLIENT_MENU_CANONICAL_TEXT: Record<string, string> = {
    [CLIENT_MENU_IDS.INVOICES]: 'Please show me my invoices and outstanding balance.',
    [CLIENT_MENU_IDS.CASES]: 'What is the status on my open tax returns?',
    [CLIENT_MENU_IDS.UPLOAD]: 'What tax documents do I need to upload?',
    [CLIENT_MENU_IDS.FORMS]: 'What tax forms do you have for me?',
    [CLIENT_MENU_IDS.REFERRAL]: 'Please share my referral code and sharing link.',
};

const CLIENT_MENU_OTHER_ACK = "Sure — what's on your mind?";

const LOE_BUTTON_PAYLOAD = {
    SIGNED: 'loe:signed',
    LATER: 'loe:later',
} as const;

// The OTP instructions go out via a CRM-initiated WhatsApp template (sent
// manually by a consultant once they've added the client on SARS eFiling).
// The template defines two quick-reply buttons whose payloads MUST match the
// ids below — `otp:done` flags the lead for auto-conversion to a contact,
// `otp:help` escalates to taxcrew@ttt-tax.co.za with a tracked request.
const OTP_BUTTON_PAYLOAD = {
    DONE: 'otp:done',
    HELP: 'otp:help',
} as const;

const TAXCREW_EMAIL = 'taxcrew@ttt-tax.co.za';

// Conversation caps. Apply to clients, leads, and unknown users — staff
// (entityType === 'user') are exempt because their tool-driven workflows
// legitimately rack up turns. Tune these once we have a few weeks of usage
// data in claude_usage_daily.
const CAP_MESSAGES_PER_SESSION = 50;
const CAP_TOKENS_PER_SESSION = 200_000;
const CAP_MESSAGES_PER_DAY = 100;

const CAP_HIT_REPLY = "You've reached the message limit for this conversation. ⏸️\n\nTo make sure you get the right help from here, a TTT consultant has been notified and will be in touch with you directly — there's nothing more you need to do.\n\nNo need to reply here; we'll reach out to you shortly.";
const CAP_BLOCKED_REPLY = "You're still at the message limit for this conversation. A TTT consultant has already been notified and will be in touch with you directly — please hold tight, there's no need to reply here.";

type SignUpFlowResponse = {
    first_name?: string;
    last_name?: string;
    email?: string;
    referral_code?: string;
    client_type?: string;
    service_needed?: string;
    notes?: string;
    terms_agreement?: boolean;
    offers_acceptance?: boolean;
};

type ResolvedEntity = {
    crmEntity: any | null;
    staffRoleId: string | null;
    permittedTools: string[];
};

export type IncomingMessage = {
    from: string;
    text: string;
    interactiveId?: string;
    document?: { id: string; filename: string; mimeType: string };
    flowResponse?: SignUpFlowResponse;
};

/**
 * Convert a raw Meta `messages[i]` object into our internal IncomingMessage
 * shape, or null for message types we don't handle. Pure / sync — safe to
 * call from the webhook ingest path before enqueueing.
 */
export function extractIncoming(metaMessage: any): IncomingMessage | null {
    const from = metaMessage.from;
    if (!from) return null;

    if (metaMessage.type === 'text') {
        return { from, text: metaMessage.text?.body || '' };
    }

    if (metaMessage.type === 'interactive') {
        const interactive = metaMessage.interactive;
        if (interactive?.type === 'button_reply') {
            return { from, text: interactive.button_reply.title, interactiveId: interactive.button_reply.id };
        }
        if (interactive?.type === 'list_reply') {
            return { from, text: interactive.list_reply.title, interactiveId: interactive.list_reply.id };
        }
        if (interactive?.type === 'nfm_reply') {
            const raw = interactive.nfm_reply?.response_json;
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw) as SignUpFlowResponse;
                return { from, text: '', flowResponse: parsed };
            } catch (e) {
                console.warn('[Processor] nfm_reply response_json parse failed:', (e as Error).message);
                return null;
            }
        }
        return null;
    }

    // Template quick-reply buttons come back as type='button' (distinct from
    // interactive button_reply, which is for non-template interactive messages).
    // Used by the email-relay consent template; the payload is what we set when
    // sending the template, e.g. 'relay_yes' / 'relay_no'.
    if (metaMessage.type === 'button') {
        const btn = metaMessage.button;
        if (!btn) return null;
        return { from, text: btn.text || '', interactiveId: btn.payload || '' };
    }

    if (metaMessage.type === 'document') {
        const doc = metaMessage.document;
        return {
            from,
            text: doc?.caption || '',
            document: {
                id: doc.id,
                filename: doc.filename || `document-${Date.now()}.pdf`,
                mimeType: doc.mime_type || 'application/pdf',
            },
        };
    }

    if (metaMessage.type === 'image') {
        const img = metaMessage.image;
        return {
            from,
            text: img?.caption || '',
            document: {
                id: img.id,
                filename: `image-${Date.now()}.${(img.mime_type || 'image/jpeg').split('/')[1] || 'jpg'}`,
                mimeType: img.mime_type || 'image/jpeg',
            },
        };
    }

    return null;
}

async function sendClientWelcomeMenu(to: string, firstName: string): Promise<string> {
    const body = `Hey ${firstName || 'there'}! 👋 Tina here, your TTT tax sidekick.\n\nWhat can I help with today?`;
    await metaWhatsAppService.sendListMessage(
        to,
        body,
        'Choose an option',
        [
            {
                title: 'Your account',
                rows: [
                    { id: CLIENT_MENU_IDS.INVOICES, title: '📄 Invoices & balances', description: "View, download, or check what's due" },
                    { id: CLIENT_MENU_IDS.CASES, title: '📂 Tax return updates', description: 'Status on your open tax returns' },
                    { id: CLIENT_MENU_IDS.UPLOAD, title: '📎 Upload tax docs', description: 'IRP5, IT3, payslips and more' },
                    { id: CLIENT_MENU_IDS.FORMS, title: '📋 Tax forms to fill in', description: 'Blank templates for travel, commission, etc.' },
                ],
            },
            {
                title: 'Get help',
                rows: [
                    { id: CLIENT_MENU_IDS.REFERRAL, title: '🎁 Refer a friend', description: 'Get your referral link' },
                    { id: CLIENT_MENU_IDS.OTHER, title: '💬 Something else', description: 'Ask me anything' },
                ],
            },
        ],
    );
    return body;
}

/**
 * Fast-path tagged upload for a client's filled-in tax form. Triggered when
 * the inbound filename matches a known TAX_FORMS prefix (or when the 48h
 * context-window helper resolves a recent send). Bypasses the normal
 * Claude→save_document flow:
 *   1. Rename to a stable form: `{ClientFullName}_{label-kebab}_{year}.pdf`.
 *   2. Upload to Contact/{FullName}_{GUID}/{tax_year}/.
 *   3. Post Dynamics timeline entry.
 *   4. Send a brief ack to the client and clear the staged upload.
 */
async function handleTaxFormReturn(
    crmEntity: { id: string; fullname: string; type: string },
    phoneNumber: string,
    sessionId: string,
    incomingText: string,
    crmRequestId: string | null,
    formMatch: { key: string; label: string; filenamePrefix: string },
    source: 'filename' | 'context',
): Promise<void> {
    const staged = peekPendingUpload(phoneNumber);
    if (!staged) {
        console.warn(`[TaxForms] return_skip_no_staged phone=${phoneNumber}`);
        return;
    }
    const spec = matchFormByFilename(formMatch.filenamePrefix) || null;
    const formSpec = spec || (formMatch as any);

    let resolved;
    try {
        resolved = await resolveLatestFormFile(formSpec);
    } catch (e: any) {
        console.warn(`[TaxForms] return_resolve_year_failed key=${formMatch.key} err=${e?.message || e}`);
    }
    const year = resolved?.year ?? getCurrentSaTaxYear().label;

    const renamed = `${crmEntity.fullname}_${kebabLabel(formMatch.label)}_${year}.pdf`;

    try {
        await sharePointService.uploadDocumentFile({
            contactFullName: crmEntity.fullname,
            contactId: crmEntity.id,
            uploadYear: year,
            fileName: renamed,
            mimeType: staged.mimeType,
            buffer: staged.buffer,
        });
    } catch (e: any) {
        const msg = e?.response?.data?.error?.message || e?.message || 'unknown';
        console.error(`[TaxForms] return_sharepoint_failed key=${formMatch.key} err=${msg}`);
        clearPendingUpload(phoneNumber);
        const errReply = "I got the file but hit a snag filing it. Your consultant will pick it up — please try again later if you don't hear back.";
        await metaWhatsAppService.sendMessage(phoneNumber, errReply);
        await supabaseService.saveMessage(sessionId, 'user', incomingText);
        await supabaseService.saveMessage(sessionId, 'assistant', errReply);
        return;
    }

    try {
        await dynamicsService.logTaxFormReceivedFromContact(crmEntity.id, formMatch.label, renamed, crmEntity.id);
    } catch (e: any) {
        console.warn(`[TaxForms] return_timeline_failed key=${formMatch.key} err=${e?.message || e}`);
    }

    clearPendingUpload(phoneNumber);

    if (source === 'context') {
        console.log(`[TaxForms] return_tagged_via_context key=${formMatch.key} clientId=${crmEntity.id}`);
    } else {
        console.log(`[TaxForms] return_tagged key=${formMatch.key} clientId=${crmEntity.id}`);
    }

    const ack = `Got your ${formMatch.label} — filed under your ${year} return. Thanks!`;
    await supabaseService.saveMessage(sessionId, 'user', incomingText);
    await supabaseService.saveMessage(sessionId, 'assistant', ack);
    await metaWhatsAppService.sendMessage(phoneNumber, ack);
    try {
        await dynamicsService.logMessage(crmEntity as any, incomingText || '(document)', 'Incoming', phoneNumber, crmRequestId);
        await dynamicsService.logMessage(crmEntity as any, ack, 'Outgoing', phoneNumber, crmRequestId);
    } catch (e) {
        console.warn('[Processor] Tax-form return log failed:', (e as Error).message);
    }
}

async function resolveSender(phoneNumber: string): Promise<ResolvedEntity> {
    let crmEntity: any = null;
    let staffRoleId: string | null = null;
    let permittedTools: string[] = [];

    // Staff (internal "user") mode is gated behind STAFF_MODE_ENABLED. While it's
    // off we skip the users-table lookup entirely so staff phones fall through to
    // the Dynamics resolution below and get the lead/client experience like anyone
    // else. Flip STAFF_MODE_ENABLED=true to restore the colleague/CRM-tools path.
    if (process.env.STAFF_MODE_ENABLED === 'true') {
        const staff = await supabaseService.findStaffByPhone(phoneNumber);
        if (staff) {
            crmEntity = { id: staff.dynamics_user_id, type: 'user', fullname: staff.full_name };
            staffRoleId = staff.role_id;
            permittedTools = staff.role_id ? await supabaseService.getPermittedTools(staff.role_id) : [];
            console.log(`[Processor] ${phoneNumber} matched staff "${staff.full_name}" role_id=${staff.role_id || 'NONE'} tools=${permittedTools.length}`);
            return { crmEntity, staffRoleId, permittedTools };
        }
    }

    const previousSession = await supabaseService.findPreviousSession(phoneNumber);
    // Staff identity is authoritative via findStaffByPhone above. If that returned
    // null, the sender is not staff — ignore any prior 'user'-typed session cache
    // so a revoked staff mapping doesn't keep routing them through the staff path.
    if (previousSession && previousSession.crm_type !== 'user') {
        try {
            crmEntity = await dynamicsService.getEntityById(previousSession.crm_id, previousSession.crm_type);
            if (crmEntity) {
                console.log(`[Processor] ${phoneNumber} identified from Supabase cache: ${crmEntity.type} "${crmEntity.fullname}"`);
                return { crmEntity, staffRoleId, permittedTools };
            }
        } catch (e) {
            console.warn('[Processor] Supabase-cached CRM lookup failed:', (e as Error).message);
        }
    }

    try {
        crmEntity = await dynamicsService.getContactByPhone(phoneNumber);
        if (crmEntity) {
            console.log(`[Processor] ${phoneNumber} found in Dynamics: ${crmEntity.type} "${crmEntity.fullname}"`);
        }
    } catch (e) {
        console.warn('[Processor] Dynamics lookup failed:', (e as Error).message);
    }

    return { crmEntity, staffRoleId, permittedTools };
}

async function handleSignUpFlowSubmission(from: string, flow: SignUpFlowResponse): Promise<void> {
    const firstName = (flow.first_name || '').trim();
    const lastName = (flow.last_name || '').trim();
    const email = (flow.email || '').trim();

    if (!firstName || !lastName || !email) {
        console.warn(`[Processor] Sign-up flow from ${from} missing required fields`, flow);
        await metaWhatsAppService.sendMessage(
            from,
            "We didn't get your name or email from that form. Please try again or sign up at https://ttt-tax.co.za/client-onboarding."
        );
        return;
    }
    if (flow.terms_agreement !== true) {
        console.warn(`[Processor] Sign-up flow from ${from} without terms agreement`);
        await metaWhatsAppService.sendMessage(
            from,
            "You'll need to agree to the terms to sign up. Please try again, or visit https://ttt-tax.co.za/client-onboarding."
        );
        return;
    }

    const clientType = flow.client_type !== undefined && flow.client_type !== '' ? Number(flow.client_type) : undefined;
    const leadType = flow.service_needed !== undefined && flow.service_needed !== '' ? Number(flow.service_needed) : undefined;

    let referredByContactId: string | undefined;
    let ownerSystemUserId: string | undefined;
    let referrerFullname: string | null = null;
    const referralCode = (flow.referral_code || '').trim();
    if (referralCode) {
        try {
            const referrer = await dynamicsService.getContactByReferralCode(referralCode);
            if (referrer) {
                referredByContactId = referrer.id;
                referrerFullname = referrer.fullname || null;
                const ownerId = await dynamicsService.getContactOwnerId(referrer.id);
                if (ownerId) ownerSystemUserId = ownerId;
                console.log(`[Processor] Referral code ${referralCode} matched ${referrer.fullname} (${referrer.id})`);
            } else {
                console.warn(`[Processor] Referral code ${referralCode} from ${from} did not match any contact`);
            }
        } catch (e) {
            console.warn('[Processor] Referral code lookup failed:', (e as Error).message);
        }
    }

    const baseNotes = (flow.notes || '').trim();
    const referralNote = referrerFullname
        ? `Referred by ${referrerFullname} (code ${referralCode}).`
        : referralCode && !referredByContactId
            ? `Submitted referral code ${referralCode} — no match in Dynamics.`
            : '';
    const combinedNotes = [baseNotes, referralNote].filter(Boolean).join(' ') || undefined;

    // WhatsApp signups tag the lead with Lead Source = WhatsApp. Ownership
    // defaults to the tax crew team (so the lead lands in their shared queue);
    // a resolved referrer's owner takes precedence. Both team and systemuser
    // GUIDs are prod-only, so createLead retries with the service principal
    // systemuser as a cross-environment fallback, and finally strips ownerid
    // entirely if Dataverse still rejects.
    const WHATSAPP_LEAD_SOURCE = 463630005;
    const TAX_CREW_TEAM_ID = 'eb735c44-7b5a-f111-bec7-000d3ada6ac0';
    const TAX_CREW_FALLBACK_OWNER_ID = '873db3ff-d563-f011-bec3-000d3ab7e7df';

    const created = await dynamicsService.createLead({
        firstName,
        lastName,
        phone: from,
        email,
        notes: combinedNotes,
        clientType: typeof clientType === 'number' && !Number.isNaN(clientType) ? clientType : undefined,
        leadType: typeof leadType === 'number' && !Number.isNaN(leadType) ? leadType : undefined,
        leadSource: WHATSAPP_LEAD_SOURCE,
        referredByContactId,
        ownerSystemUserId,
        ownerTeamId: ownerSystemUserId ? undefined : TAX_CREW_TEAM_ID,
        ownerFallbackSystemUserId: TAX_CREW_FALLBACK_OWNER_ID,
    });

    if (!created) {
        console.error(`[Processor] createLead failed for ${from}`);
        await metaWhatsAppService.sendMessage(
            from,
            "Thanks for signing up! We hit a snag saving your details — a consultant will reach out shortly. If you'd prefer, you can also register at https://ttt-tax.co.za/client-onboarding."
        );
        return;
    }

    console.log(`[Processor] Sign-up flow created lead ${created.new_leadid} for ${from}`);

    // Fire-and-await the LOE app's team-notification + thank-you emailer.
    // Failures are logged and swallowed inside the helper — the lead is already
    // in Dynamics, so we never block the user-visible welcome on email delivery.
    await postWhatsAppSignupNotification({
        name: `${firstName} ${lastName}`.trim(),
        email,
        phone: from,
        service: serviceLabelFromLeadType(leadType),
        clientType,
        dynamicsId: created.new_leadid,
    });

    const loeLink = buildLoeMagicLink(created.new_leadid);
    if (loeLink) {
        const welcome = `Thanks ${firstName}, you're signed up with TTT Financial Group. 🎉\n\nNext up is your Letter of Engagement (LoE). It's the legally binding contract between you and TTT that lets us act for you at SARS. It sets out the scope of work and the responsibilities on both sides. SARS won't let us file or correspond on your behalf without it, so this one is non-negotiable.\n\nSign yours here (link valid 72 hours):\n${loeLink}\n\nIt takes about 2 minutes. As soon as it's signed I'll message you with the next step.`;
        await metaWhatsAppService.sendMessage(from, welcome);
    } else {
        await metaWhatsAppService.sendMessage(
            from,
            `Thanks, ${firstName}! You're all signed up with TTT Financial Group. A consultant will be in touch shortly. In the meantime, feel free to message any questions.`
        );
    }
}

// Tap on the OTP template's two quick-reply buttons. DONE flags the lead for
// auto-conversion in Dynamics (a Power Automate flow converts the lead to a
// contact once icon_converttoclient flips) and resolves any open OTP-flavoured
// riivo_requests for the lead. HELP creates a tracked riivo_request and emails
// taxcrew@ttt-tax.co.za from the tina-bot mailbox so a human picks it up.
// Neither path uses ESCALATED — the OTP step is the normal next handoff in
// signup, not an escalation; consultants pick it up during working hours.
async function handleOtpTemplateResponse(from: string, payload: string, crmEntity: any): Promise<void> {
    if (crmEntity?.type !== 'lead' || !crmEntity?.id) {
        console.warn(`[Processor] OTP button "${payload}" from ${from} but sender is not a lead (type=${crmEntity?.type}). Ignoring.`);
        await metaWhatsAppService.sendMessage(
            from,
            "Thanks for the update! Someone from our team will reach out if anything's still outstanding."
        );
        return;
    }

    const leadId: string = crmEntity.id;
    const leadName: string = (crmEntity.fullname || '').trim() || 'Lead';

    if (payload === OTP_BUTTON_PAYLOAD.DONE) {
        const result = await dynamicsService.markLeadOtpCompleteAndReadyToConvert(leadId, leadId);
        if (!result.success) {
            console.error(`[Processor] markLeadOtpCompleteAndReadyToConvert failed for lead ${leadId}: ${result.error}`);
            await metaWhatsAppService.sendMessage(
                from,
                "Thanks for confirming! 🙌 We hit a snag on our side updating your profile — a consultant will check on it shortly and reach out here."
            );
            return;
        }
        await dynamicsService.resolveOpenOtpRequestsForLead(leadId);
        await metaWhatsAppService.sendMessage(
            from,
            "Amazing, thank you! 🎉 You're all set. We'll finalise your account on our side and a TTT consultant will be in touch shortly to welcome you in properly."
        );
        return;
    }

    // HELP path: create a tracked request and email taxcrew so a human picks
    // it up. Lands in AWAITING_FEEDBACK rather than ESCALATED — the consultant
    // outreach during working hours is the normal handoff, not an escalation.
    const description = `Lead "${leadName}" tapped Need-help on SARS OTP template — consultant to walk them through.`;
    const created = await dynamicsService.createRequest({
        leadId,
        contactType: 'lead',
        phoneNumber: from,
        description,
    });
    if (created?.riivo_requestid) {
        await dynamicsService.updateRequest(created.riivo_requestid, {
            statuscode: REQUEST_STATUSCODE.AWAITING_FEEDBACK,
            riivo_classificationtopic: 'otp_help',
        });
    }

    const emailSubject = `Lead needs help with SARS OTP — ${leadName}`;
    const emailBody = [
        `Lead "${leadName}" (${from}) has tapped the "Need help" button on the SARS eFiling OTP template.`,
        '',
        'They need a consultant to walk them through the OTP step on https://secure.sarsefiling.co.za/app/profileTaxType/taxTypeActivation.',
        '',
        created?.riivo_requestid
            ? `A tracked riivo_request has been created for follow-up: ${created.riivo_requestid}.`
            : 'NOTE: we were unable to create a riivo_request for this lead — please pick this up from the email and follow up manually.',
        '',
        `Dynamics lead id: ${leadId}`,
    ].join('\n');
    await graphMailService.sendMail({
        to: TAXCREW_EMAIL,
        subject: emailSubject,
        bodyText: emailBody,
    });

    await metaWhatsAppService.sendMessage(
        from,
        "No worries — I've flagged this for the team. A TTT consultant will reach out here on WhatsApp to walk you through it."
    );
}

async function processMessage(incoming: IncomingMessage, outboundPrefix?: string): Promise<void> {
    const { from, text, interactiveId, document, flowResponse } = incoming;

    if (flowResponse) {
        await handleSignUpFlowSubmission(from, flowResponse);
        return;
    }

    // Email-relay consent buttons: tapped Yes → answer the original email
    // question over WhatsApp; tapped No → polite ack, notify forwarder, end.
    // Branch must run before the menu canonicalization below so we don't try
    // to map relay_* into a client-menu canonical question.
    if (interactiveId === RELAY_BUTTON_PAYLOAD.YES || interactiveId === RELAY_BUTTON_PAYLOAD.NO) {
        const payload = interactiveId === RELAY_BUTTON_PAYLOAD.YES ? 'relay_yes' : 'relay_no';
        const outcome = await handleClientRelayResponse(from, payload as 'relay_yes' | 'relay_no');
        if (outcome.kind !== 'accepted') return;

        // Re-enter processMessage with the email body as the inbound text and
        // a "Looking at your email..." prefix on the outbound. Clearing
        // interactiveId on the synthetic so this branch doesn't recurse.
        const subject = outcome.pending.subject;
        const prefix = subject
            ? `Looking at your email about ${subject},\n\n`
            : `Looking at your email,\n\n`;

        const synthetic: IncomingMessage = { from, text: outcome.pending.relay_body };
        await processMessage(synthetic, prefix);
        return;
    }

    // LEGACY: pre-post-LoE-activation flow (2026-05-28). The signup template
    // no longer renders these two quick-reply buttons — the new pre-LoE copy
    // is a single text message. These handlers stay in place for ~3 months
    // to absorb taps from clients who still have the old buttons in their
    // chat history. Safe to delete after 2026-08-28.
    if (interactiveId === LOE_BUTTON_PAYLOAD.SIGNED) {
        await metaWhatsAppService.sendMessage(
            from,
            "Awesome, thank you! 🙌 Once we have your LoE on file, the last step is the SARS eFiling OTP. A TTT consultant will reach out here on WhatsApp during working hours (Mon-Fri, 8am-4pm SAST) to walk you through it — expect either a message or a call."
        );
        // Run the IRP5 ask in parallel with the OTP wait. The lead won't be
        // a client yet so we can't write a riivo_irp5s row for them, but
        // we can pre-stage the request so the cert is ready the moment
        // they're converted to a contact.
        await metaWhatsAppService.sendMessage(
            from,
            "While we wait on the OTP step, the next thing I'll need from you is your latest IRP5. That's the tax certificate your employer issues every season. Just send through the PDF here whenever you have it."
        );
        return;
    }

    if (interactiveId === LOE_BUTTON_PAYLOAD.LATER) {
        await metaWhatsAppService.sendMessage(
            from,
            "No problem. Your link is valid for 72 hours. Just message us back here once you're done and we'll take it from there."
        );
        return;
    }

    // Buffer is hoisted so the deterministic client-document branch (below,
    // after sender resolution) can persist the file directly without going
    // back through the single-slot staging Map. We still stage so the staff
    // and lead Claude-tool paths keep working unchanged.
    let documentBuffer: Buffer | null = null;
    let documentMime = '';
    if (document) {
        try {
            const { buffer, mimeType } = await metaWhatsAppService.downloadMedia(document.id);
            documentBuffer = buffer;
            documentMime = mimeType || document.mimeType;
            stagePendingUpload(from, document.filename, documentMime, buffer);
        } catch (e) {
            console.error('[Processor] Failed to download Meta media:', (e as Error).message);
            await metaWhatsAppService.sendMessage(from, "Sorry, I couldn't download that file from WhatsApp. Please try sending it again.");
            return;
        }
    }

    let effectiveText = text || (document ? 'I just sent you a document.' : '');
    if (!effectiveText && !document) {
        console.log(`[Processor] ${from} sent an unsupported/empty message — ignoring`);
        return;
    }

    // Auto-reply / out-of-office filter. Email-forwarding setups occasionally
    // bounce another business's OOO body through the WhatsApp number; without
    // this, the bot would parse it as a real intent. Send one clarification
    // per phone per 24h, then silently drop further matches.
    if (!document && !interactiveId && looksLikeAutoReply(effectiveText)) {
        if (shouldSendAutoReplyClarification(from)) {
            await metaWhatsAppService.sendMessage(from, AUTO_REPLY_CLARIFICATION);
            console.log(`[Processor] ${from} inbound matched auto-reply patterns — sent clarification`);
        } else {
            console.log(`[Processor] ${from} inbound matched auto-reply patterns — silently dropped (clarification already sent)`);
        }
        return;
    }

    // Client menu taps: rewrite the tap's title into a canonical question so the
    // existing AI + tools path routes to the right handler without bespoke
    // dispatch. OTHER is handled separately after session resolution.
    if (interactiveId && CLIENT_MENU_CANONICAL_TEXT[interactiveId]) {
        effectiveText = CLIENT_MENU_CANONICAL_TEXT[interactiveId];
        console.log(`[Processor] ${from} tapped ${interactiveId} → "${effectiveText}"`);
    }

    const { crmEntity, staffRoleId: initialStaffRoleId, permittedTools: initialTools } = await resolveSender(from);

    if (!crmEntity) {
        const codeMatch = effectiveText.match(REFERRAL_CODE_PATTERN);
        const code = codeMatch ? codeMatch[1] : null;
        const isReferralInbound = !!code || REFERRAL_KEYWORD_PATTERN.test(effectiveText);

        if (isReferralInbound) {
            let referrerFirstName: string | null = null;
            if (code) {
                try {
                    const referrer = await dynamicsService.getContactByReferralCode(code);
                    if (referrer) {
                        referrerFirstName = (referrer.firstname || '').trim() || null;
                        console.log(`[Processor] Referral inbound from ${from} matched code ${code} → ${referrer.fullname}`);
                    } else {
                        console.warn(`[Processor] Referral inbound from ${from} had code ${code} but no contact match`);
                    }
                } catch (e) {
                    console.warn('[Processor] Referral code lookup failed:', (e as Error).message);
                }
            } else {
                console.log(`[Processor] Referral inbound from ${from} with no code in text`);
            }

            if (REFERRAL_TEMPLATE_NAME) {
                const referrerName = referrerFirstName || 'A friend';
                const result = await metaWhatsAppService.sendTemplate(from, {
                    name: REFERRAL_TEMPLATE_NAME,
                    languageCode: REFERRAL_TEMPLATE_LANG,
                    headerImageLink: REFERRAL_TEMPLATE_HEADER_URL,
                    bodyNamedVariables: { '1': referrerName, '2': referrerName },
                    flowButton: {
                        index: 0,
                        ...(code ? { flowActionData: { referral_code: code } } : {}),
                    },
                });
                if (result.delivered) {
                    console.log(`[Processor] ${from} → referral template "${REFERRAL_TEMPLATE_NAME}" (referrer=${referrerFirstName || 'A friend'}, code=${code || 'none'})`);
                    return;
                }
                console.warn(`[Processor] sendTemplate "${REFERRAL_TEMPLATE_NAME}" failed (${result.error}), falling back to text`);
            }

            await metaWhatsAppService.sendMessage(from, buildReferralFallback(referrerFirstName, code));
            return;
        }

        // Generic (cold) first-contact path
        if (SIGNUP_TEMPLATE_NAME) {
            const result = await metaWhatsAppService.sendTemplate(from, {
                name: SIGNUP_TEMPLATE_NAME,
                languageCode: SIGNUP_TEMPLATE_LANG,
                headerImageLink: SIGNUP_TEMPLATE_HEADER_URL,
                flowButton: { index: 0 },
            });
            if (result.delivered) {
                console.log(`[Processor] ${from} not found — sent sign-up template "${SIGNUP_TEMPLATE_NAME}"`);
                return;
            }
            console.warn(`[Processor] sendTemplate "${SIGNUP_TEMPLATE_NAME}" failed (${result.error}), falling back to text`);
        }
        console.log(`[Processor] ${from} not found — sending sign-up fallback text`);
        await metaWhatsAppService.sendMessage(from, SIGN_UP_GREETING);
        return;
    }

    if (interactiveId === OTP_BUTTON_PAYLOAD.DONE || interactiveId === OTP_BUTTON_PAYLOAD.HELP) {
        await handleOtpTemplateResponse(from, interactiveId, crmEntity);
        return;
    }

    // Lazy deferred-write: if this sender now resolves to a Contact, drain any
    // IRP5s the lead staged in Supabase before conversion (State B fast-track).
    // Fire-and-forget — non-blocking on the inbound's response.
    if (crmEntity.type === 'client') {
        pendingIrp5Service
            .drainForPhone(from, crmEntity.id)
            .catch((e: any) => console.warn('[Processor] pending IRP5 drain failed:', e?.message || e));
    }

    let staffRoleId = initialStaffRoleId;
    let permittedTools = initialTools;

    const session = await supabaseService.getOrCreateSession(
        from,
        crmEntity.id,
        crmEntity.type,
        staffRoleId,
        permittedTools
    );

    if (crmEntity.type === 'user') {
        if (session.role_id) staffRoleId = session.role_id;
        if (session.permitted_tools && session.permitted_tools.length > 0) permittedTools = session.permitted_tools;
    }

    if (crmEntity.type === 'user' && permittedTools.length === 0) {
        const msg = `Hi ${crmEntity.fullname || 'there'} — you don't currently have access to any bot features. Please contact your administrator to request access.`;
        await supabaseService.saveMessage(session.id, 'user', effectiveText);
        await supabaseService.saveMessage(session.id, 'assistant', msg);
        await metaWhatsAppService.sendMessage(from, msg);
        console.log(`[Processor] No-access staff user "${crmEntity.fullname}" — declined.`);
        return;
    }

    if (crmEntity.type === 'client' && !crmEntity.optIn) {
        try {
            await dynamicsService.updateWhatsAppOptIn(crmEntity.id, true);
        } catch (e) {
            console.warn('[Processor] Opt-in update failed:', (e as Error).message);
        }
    }

    // Return-flow tagging for filled-in tax form templates. A client uploading
    // a PDF whose filename matches one of the catalog prefixes (or, as a 48h
    // context fallback, whose recent history shows we sent them a form)
    // bypasses the normal save_document path: rename → SharePoint → timeline
    // entry → ack. See PRD-tax-forms.md §3.7.
    if (crmEntity.type === 'client' && document) {
        const filenameMatch = matchFormByFilename(document.filename);
        if (filenameMatch) {
            await handleTaxFormReturn(
                { id: crmEntity.id, fullname: crmEntity.fullname || '', type: crmEntity.type },
                from,
                session.id,
                effectiveText,
                null,
                filenameMatch,
                'filename',
            );
            return;
        }
        const isKnownNonFormDoc = /irp5|it3|payslip|medical|bank statement|ra |retirement annuity|tax certificate/i.test(document.filename);
        if (!isKnownNonFormDoc) {
            const contextMatch = await getRecentTaxFormSendForClient(crmEntity.id, 48);
            if (contextMatch) {
                await handleTaxFormReturn(
                    { id: crmEntity.id, fullname: crmEntity.fullname || '', type: crmEntity.type },
                    from,
                    session.id,
                    effectiveText,
                    null,
                    contextMatch,
                    'context',
                );
                return;
            }
        }
    }

    // Client document upload — file it immediately, no classification round-trip.
    // IRP5s (detected by filename) run the full OCR/parse + onboarding flow;
    // every other doc is filed under a filename-inferred type. We reuse the
    // session's open case if there is one, else open ONE case for the upload —
    // never a fresh case per document, so a burst of files doesn't fan out into
    // a pile of REQs. The locally-held buffer is persisted directly, so
    // back-to-back uploads can't clobber each other in the staging Map. Any
    // caption is preserved on the CRM row as notes; the ack invites a follow-up
    // so a question sent alongside a file still gets answered on the next turn.
    if (crmEntity.type === 'client' && document && documentBuffer) {
        const docType = inferDocTypeFromFilename(document.filename);
        const caption = (text || '').trim();

        let docCase = await supabaseService.findOpenCaseForSession(session.id);
        if (!docCase) {
            docCase = await caseService.createCase({
                sessionId: session.id,
                contactId: crmEntity.id,
                contactType: 'client',
                phoneNumber: from,
                queryText: `Document upload: ${document.filename}`,
            });
        }
        const docCrmRequestId = docCase?.crm_case_id || null;

        await supabaseService.saveMessage(session.id, 'user', effectiveText);
        try {
            await dynamicsService.logMessage(crmEntity, effectiveText, 'Incoming', from, docCrmRequestId);
        } catch (e) {
            console.warn('[Processor] Doc incoming log failed:', (e as Error).message);
        }

        let ack: string;
        let docFiled = false;
        if (docType === 'IRP5') {
            const result = await processClientIrp5Upload({
                contactId: crmEntity.id,
                contactFullName: crmEntity.fullname || '',
                fileName: document.filename,
                mimeType: documentMime || document.mimeType,
                buffer: documentBuffer,
            });
            if (result.status === 'error') {
                ack = "Got your IRP5 but I hit a snag filing it. Please try resending in a few minutes — your consultant will follow up if it keeps failing.";
            } else if (result.missingDocs.length === 0) {
                docFiled = true;
                ack = `Got your IRP5${result.employerName ? ` from ${result.employerName}` : ''} for the ${result.assessmentYear} tax year ✅. Looks like that's everything we need — your consultant will be in touch if anything else comes up.`;
            } else {
                docFiled = true;
                const next = result.missingDocs[0];
                ack = `Got your IRP5${result.employerName ? ` from ${result.employerName}` : ''} for the ${result.assessmentYear} tax year ✅.${result.wrongYearWarning ? ` One thing — ${result.wrongYearWarning}` : ''} Next I'll need your ${next.label}${next.notes ? ` (${next.notes})` : ''}.`;
            }
        } else {
            const saved = await saveClientDocumentDirect({
                contactId: crmEntity.id,
                docType,
                fileName: document.filename,
                mimeType: documentMime || document.mimeType,
                buffer: documentBuffer,
                notes: caption || undefined,
            });
            docFiled = saved.success;
            const label = docType === 'Other' ? 'document' : docType.toLowerCase();
            ack = saved.success
                ? `Got it — saved your ${label} ✅. Anything else I can help with?`
                : "I got the file but hit a snag filing it. Please try resending shortly — your consultant will follow up if it keeps failing.";
        }

        // Mark the session noteworthy so its close emails the consultant a summary.
        if (docFiled) await supabaseService.flagSessionDocUpload(session.id);

        clearPendingUpload(from);

        await supabaseService.saveMessage(session.id, 'assistant', ack);
        await metaWhatsAppService.sendMessage(from, ack);
        try {
            await dynamicsService.logMessage(crmEntity, ack, 'Outgoing', from, docCrmRequestId);
        } catch (e) {
            console.warn('[Processor] Doc outgoing log failed:', (e as Error).message);
        }

        // Mark the doc case as answered so the 12h timeout sweep eventually
        // closes it — that close fires the consultant summary even when the
        // client uploads and then goes quiet (the headline doc-drop case).
        if (docFiled && docCase?.id) {
            await caseService.recordBotResponse(docCase.id, 'document_upload_ack', ack, docCrmRequestId);
        }

        console.log(`[Processor] doc_saved phone=${from} type=${docType} case=${docCrmRequestId || 'none'} caption=${caption ? 'yes' : 'no'}`);
        return;
    }

    // Client-only: "Something else" tap → short ack and return. No case, no AI.
    // The next inbound flows through the normal AI path with full freedom.
    if (crmEntity.type === 'client' && interactiveId === CLIENT_MENU_IDS.OTHER) {
        await supabaseService.saveMessage(session.id, 'user', effectiveText);
        await supabaseService.saveMessage(session.id, 'assistant', CLIENT_MENU_OTHER_ACK);
        await metaWhatsAppService.sendMessage(from, CLIENT_MENU_OTHER_ACK);
        try {
            await dynamicsService.logMessage(crmEntity, effectiveText, 'Incoming', from, null);
            await dynamicsService.logMessage(crmEntity, CLIENT_MENU_OTHER_ACK, 'Outgoing', from, null);
        } catch (e) {
            console.warn('[Processor] Menu-other log failed:', (e as Error).message);
        }
        console.log(`[Processor] ${from} chose "${CLIENT_MENU_IDS.OTHER}" — freeform mode`);
        return;
    }

    // Client first-message interactive menu. Only fires on a fresh session
    // (no prior messages) for an organic text inbound AND only when the
    // inbound looks like a bare greeting. Substantive first messages
    // ("I'd like to know more about the referral", "what's your new number?")
    // fall through to the AI path so they actually get answered.
    if (
        crmEntity.type === 'client' &&
        !document &&
        !interactiveId &&
        looksLikeGreetingOnly(effectiveText)
    ) {
        const existingHistory = await supabaseService.getHistory(session.id);
        if (existingHistory.length === 0) {
            await supabaseService.saveMessage(session.id, 'user', effectiveText);
            try {
                await dynamicsService.logMessage(crmEntity, effectiveText, 'Incoming', from, null);
            } catch (e) {
                console.warn('[Processor] Incoming log failed:', (e as Error).message);
            }

            const firstName = (crmEntity.fullname || '').trim().split(/\s+/)[0] || '';
            const menuBody = await sendClientWelcomeMenu(from, firstName);
            await supabaseService.saveMessage(session.id, 'assistant', menuBody);
            try {
                await dynamicsService.logMessage(crmEntity, menuBody, 'Outgoing', from, null);
            } catch (e) {
                console.warn('[Processor] Outgoing log failed:', (e as Error).message);
            }

            console.log(`[Processor] Sent client welcome menu to ${from}`);
            return;
        }
    }

    // Conversation caps — short-circuit before invoking Claude for non-staff
    // users who've blown through the per-session or per-day limits. Staff are
    // exempt; their tool flows are bounded by permissions instead.
    if (crmEntity.type !== 'user') {
        if (session.cap_blocked_at) {
            await supabaseService.saveMessage(session.id, 'user', effectiveText);
            await supabaseService.saveMessage(session.id, 'assistant', CAP_BLOCKED_REPLY);
            await metaWhatsAppService.sendMessage(from, CAP_BLOCKED_REPLY);
            console.log(`[Processor] ${from} session ${session.id} cap-blocked — short-circuit`);
            return;
        }

        const sessionMessages = session.message_count || 0;
        const sessionTokens = session.token_count || 0;
        const overSession = sessionMessages >= CAP_MESSAGES_PER_SESSION || sessionTokens >= CAP_TOKENS_PER_SESSION;
        const dailyCount = await supabaseService.countMessagesLast24h(from);
        const overDaily = dailyCount >= CAP_MESSAGES_PER_DAY;

        if (overSession || overDaily) {
            await supabaseService.saveMessage(session.id, 'user', effectiveText);
            await supabaseService.saveMessage(session.id, 'assistant', CAP_HIT_REPLY);
            await metaWhatsAppService.sendMessage(from, CAP_HIT_REPLY);
            await supabaseService.markSessionCapBlocked(session.id);

            const openCase = await supabaseService.findOpenCaseForSession(session.id);
            if (openCase) {
                const reason = overDaily ? 'Daily message cap reached' : 'Session message cap reached';
                try {
                    await caseService.markEscalated(openCase.id, reason, openCase.crm_case_id);
                } catch (e) {
                    console.warn('[Processor] cap-hit escalation failed:', (e as Error).message);
                }
            }

            console.log(`[Processor] ${from} hit cap — sessionMsgs=${sessionMessages} sessionTokens=${sessionTokens} dailyMsgs=${dailyCount} escalated=${openCase ? openCase.crm_case_id : 'none'}`);
            return;
        }
    }

    // Resolve the Dynamics request id for this inbound BEFORE logging it, so
    // the riivo_whatsappcommunicationses record threads under the right
    // riivo_request via regardingobjectid. Scope to the current session —
    // a new session means a new conversation, which means a new request.
    // Priority:
    //   1. Existing open request for THIS session (continuation messages,
    //      pending-feedback replies, follow-ups within the session).
    //   2. New request created synchronously for a qualifying question.
    //   3. null — falls back to contact/lead binding in logMessage.
    // Case routing — three possibilities each turn:
    //   1. Topic shift: prior case is in bot_responded and this inbound qualifies
    //      as a new question → implicitly resolve the prior case as
    //      resolved_by_bot (the client moved on rather than pushing back) and
    //      open a new case for the new topic.
    //   2. Continuation: a prior case exists (still 'open' while the bot drafts,
    //      OR 'bot_responded' but this inbound is a short ack like "yes") →
    //      reuse its Dynamics request; no new case.
    //   3. Fresh: no prior case in the session and the inbound qualifies → open
    //      the first case.
    let crmRequestId: string | null = null;
    let newCaseId: string | null = null;
    let respondingCaseId: string | null = null;
    // Set when the latest case is escalated and we'll attempt to re-classify it
    // as L1 based on the fuller conversation context. If recovery succeeds, the
    // post-response block flips respondingCaseId to this id so the normal L1
    // feedback flow takes over.
    let reclassifyCaseId: string | null = null;
    if (crmEntity.type === 'client' || crmEntity.type === 'lead') {
        const latestCase = await supabaseService.findOpenCaseForSession(session.id);
        const qualifies = caseService.qualifyMessage(effectiveText);

        // A feedback reply or closing ack belongs to the existing case — it is
        // NOT a new topic. Without this guard a "Yes, thanks" button tap (which
        // Meta delivers as the literal title text) reads as a fresh qualifying
        // question, closing the prior case and spawning a duplicate REQ that
        // resolves in the same turn. Button taps are unambiguous; a yes/no while
        // a feedback prompt is outstanding, or any wrap-up ack, is treated the
        // same way. These all fall through to the continuation branch below and
        // are then closed properly (as confirmed) by the feedback/wrap-up paths.
        const looksLikeFeedbackOrAck =
            interactiveId === CASE_FEEDBACK_BUTTON_YES ||
            interactiveId === CASE_FEEDBACK_BUTTON_NO ||
            caseService.detectWrapUp(effectiveText) ||
            ((session as any).pending_case_id != null && caseService.detectFeedback(effectiveText) !== null);

        // Topic-shift relaxation (see docs/topic-shift-relaxation.md). Not every
        // qualifying follow-up is a new topic. A new message only opens a NEW
        // case when it lands well after the open case's last activity; within a
        // short window it's almost always the same client continuing the same
        // thread (especially in a campaign reply burst), so we reuse the open
        // case via the continuation branch below instead of fanning out a fresh
        // REQ per message. 30 min matches the session-timeout grain. Reversible:
        // delete `&& !withinContinuationWindow` to restore the old behaviour.
        const TOPIC_SHIFT_MIN_GAP_MS = 30 * 60 * 1000;
        const withinContinuationWindow = !!latestCase &&
            (Date.now() - new Date(latestCase.updated_at).getTime()) < TOPIC_SHIFT_MIN_GAP_MS;

        if (latestCase && latestCase.status === 'bot_responded' && qualifies && !looksLikeFeedbackOrAck && !withinContinuationWindow) {
            // Topic shift — close the prior thread before opening a new one.
            try {
                await caseService.markResolvedByBot(latestCase.id, 'topic_shift', latestCase.crm_case_id);
                console.log(`[Processor] topic_shift closed caseId=${latestCase.id} sessionId=${session.id}`);
            } catch (e: any) {
                console.warn(`[Processor] topic_shift close failed caseId=${latestCase.id} err=${e?.message || e}`);
            }
            const created = await caseService.createCase({
                sessionId: session.id,
                contactId: crmEntity.id,
                contactType: crmEntity.type,
                phoneNumber: from,
                queryText: effectiveText,
            });
            if (created) {
                newCaseId = created.id;
                respondingCaseId = created.id;
                crmRequestId = created.crm_case_id;
            }
        } else if (latestCase) {
            // Continuation — reuse the existing case + Dynamics request.
            crmRequestId = latestCase.crm_case_id;
            if (latestCase.status === 'escalated' && (qualifies || caseService.detectWrapUp(effectiveText))) {
                // Vague openers ("To do my tax") sometimes get flagged escalation
                // on the first turn; once the client clarifies, the case is
                // clearly L1. Attempt recovery — if successful, the post-response
                // block sets respondingCaseId so the L1 feedback flow runs.
                // A closing ack ("thanks") after an escalation is also strong
                // evidence the bot actually answered fine; let it run the same
                // recovery path so the wrap-up close below can pick the case up.
                reclassifyCaseId = latestCase.id;
            } else if (latestCase.status !== 'escalated') {
                respondingCaseId = latestCase.id;
            }
        } else if (qualifies) {
            // Fresh — first qualifying message in the session.
            const created = await caseService.createCase({
                sessionId: session.id,
                contactId: crmEntity.id,
                contactType: crmEntity.type,
                phoneNumber: from,
                queryText: effectiveText,
            });
            if (created) {
                newCaseId = created.id;
                respondingCaseId = created.id;
                crmRequestId = created.crm_case_id;
            }
        }
    }

    try {
        await dynamicsService.logMessage(crmEntity, effectiveText, 'Incoming', from, crmRequestId);
    } catch (e) {
        console.warn('[Processor] Incoming log failed:', (e as Error).message);
    }

    await supabaseService.saveMessage(session.id, 'user', effectiveText);

    // Fire-and-forget timeout sweep on every client inbound. Safety net between
    // daily cron runs — cheap UPDATE, idempotent.
    if (crmEntity.type === 'client') {
        caseService.handleTimeout().catch(e => console.warn('[Processor] timeout sweep:', e.message));
    }

    const history = await supabaseService.getHistory(session.id);
    const historyWithoutCurrent = history.slice(0, -1);

    // Feedback routing: if this session is waiting on feedback for a bot answer,
    // and the inbound looks like yes/no, close the loop without invoking the AI.
    //
    // Gate: free-text yes/no only counts as feedback when the PREVIOUS bot turn
    // was the resolution prompt itself. Otherwise a casual "yes" mid-conversation
    // (e.g. answering "want me to list typical docs?") would close the case
    // instead of being routed through Claude. Explicit button taps bypass the
    // gate — clicking the prompt's button is unambiguous.
    const pendingCaseId = (session as any).pending_case_id || null;
    if (crmEntity.type === 'client' && pendingCaseId) {
        const isExplicitButtonTap =
            interactiveId === CASE_FEEDBACK_BUTTON_YES ||
            interactiveId === CASE_FEEDBACK_BUTTON_NO;
        let previousWasPrompt = isExplicitButtonTap;
        if (!isExplicitButtonTap) {
            for (let i = historyWithoutCurrent.length - 1; i >= 0; i--) {
                if (historyWithoutCurrent[i].role === 'assistant') {
                    previousWasPrompt = historyWithoutCurrent[i].content.startsWith(CASE_FEEDBACK_PROMPT_TEXT);
                    break;
                }
            }
        }

        const feedback = previousWasPrompt ? caseService.detectFeedback(effectiveText) : null;
        if (feedback) {
            await caseService.handleFeedback(pendingCaseId, feedback);
            await supabaseService.setSessionPendingCase(session.id, null);

            const ack = feedback === 'confirmed'
                ? "Great, glad that helped. 🙌 Message me again any time."
                : "Thanks for letting me know. I've flagged this for a consultant to follow up.";
            await supabaseService.saveMessage(session.id, 'assistant', ack);
            await metaWhatsAppService.sendMessage(from, ack);
            try {
                await dynamicsService.logMessage(crmEntity, ack, 'Outgoing', from, crmRequestId);
            } catch (e) {
                console.warn('[Processor] Outgoing log failed:', (e as Error).message);
            }
            console.log(`[Processor] Case ${pendingCaseId} feedback=${feedback}`);
            return;
        }
        // Not a feedback reply — treat as a new query and clear the pending pointer.
        await supabaseService.setSessionPendingCase(session.id, null);
    }

    // Wrap-up short-circuit: an explicit "thanks"-style inbound closes every
    // open case in the session as confirmed and sends the canned notification
    // in place of a Claude-generated answer. Falls through to the normal AI
    // path if no open case was actually closed (so a freestanding "thanks"
    // doesn't drop the rest of the bot's behaviour).
    if (crmEntity.type === 'client' && caseService.detectWrapUp(effectiveText)) {
        // If the latest case was escalated, try to recover it first — a
        // wrap-up ack is strong evidence the bot actually answered, so we
        // re-classify with the full conversation. On a recovery flip, the
        // case becomes status='classified' and the wrap-up close below
        // picks it up like any other open case.
        if (reclassifyCaseId) {
            try {
                const r = await caseService.reclassifyCase(
                    reclassifyCaseId,
                    historyWithoutCurrent,
                    effectiveText,
                    crmRequestId,
                );
                if (r.recovered) {
                    console.log(`[Processor] wrap-up recovered escalation caseId=${reclassifyCaseId}`);
                }
            } catch (e: any) {
                console.warn('[Processor] wrap-up reclassify failed:', e?.message || e);
            }
            // Done with recovery — null the id so the parallel reclassify
            // promise below short-circuits and the post-response block
            // doesn't try to re-promote the same case.
            reclassifyCaseId = null;
        }
        const closed = await caseService.resolveAllOpenCasesAsConfirmed(session.id)
            .catch(e => {
                console.warn('[Processor] wrap-up close failed:', e.message);
                return 0;
            });
        if (closed > 0) {
            await supabaseService.setSessionPendingCase(session.id, null);
            await supabaseService.saveMessage(session.id, 'assistant', WRAP_UP_NOTIFICATION);
            await metaWhatsAppService.sendMessage(from, WRAP_UP_NOTIFICATION);
            try {
                await dynamicsService.logMessage(crmEntity, WRAP_UP_NOTIFICATION, 'Outgoing', from, crmRequestId);
            } catch (e) {
                console.warn('[Processor] Wrap-up outgoing log failed:', (e as Error).message);
            }
            console.log(`[FeedbackPrompt] wrap_up_close sessionId=${session.id} cases_closed_count=${closed}`);
            return;
        }
    }

    console.log(`[Processor] ${from} (${session.crm_type}) session=${session.id} history=${history.length} request=${crmRequestId || 'none'}`);

    // Knowledge-base retrieval. Skip for non-question turns: documents,
    // menu taps, very short messages (acks like "ok"/"thanks"), and staff —
    // staff rely on tools, not KB grounding. Runs in parallel with case
    // classification so its ~200ms doesn't add to user-visible latency.
    const shouldRetrieve = !document
        && !interactiveId
        && effectiveText.trim().length > 10
        && (crmEntity.type === 'client' || crmEntity.type === 'lead');
    const retrievalPromise: Promise<KbChunkHit[]> = shouldRetrieve
        ? knowledgeBaseService.retrieveContext(effectiveText)
        : Promise.resolve([]);

    // Classification runs in parallel with the AI call so user-visible latency
    // isn't doubled. The case itself was already created synchronously above.
    let classifyPromise: Promise<{ level: 'L1' | 'escalation' | null }> = Promise.resolve({ level: null });
    if (newCaseId) {
        classifyPromise = caseService.classifyCase(newCaseId, effectiveText)
            .then(r => ({ level: r.level }))
            .catch(e => {
                console.warn('[Processor] classifyCase failed:', e.message);
                return { level: null };
            });
    }

    // Recovery path: case is currently escalated but this turn may have
    // clarified the intent. Re-classify with the full conversation as context,
    // in parallel with the AI reply. If it flips to L1, recoverFromEscalation
    // clears the Dynamics escalation footprint inside the service call.
    let reclassifyPromise: Promise<{ recovered: boolean }> = Promise.resolve({ recovered: false });
    if (reclassifyCaseId) {
        reclassifyPromise = caseService
            .reclassifyCase(reclassifyCaseId, historyWithoutCurrent, effectiveText, crmRequestId)
            .then(r => ({ recovered: r.recovered }))
            .catch(e => {
                console.warn('[Processor] reclassifyCase failed:', e.message);
                return { recovered: false };
            });
    }

    const leadOnboarding = crmEntity.type === 'lead'
        ? {
            loeReceived: crmEntity.loeReceived === true,
            otpCompleted: crmEntity.otpCompleted === true,
            leadType: typeof crmEntity.leadType === 'number' ? crmEntity.leadType : null,
        }
        : undefined;

    const retrievedContext = await retrievalPromise;
    if (retrievedContext.length > 0) {
        const summary = retrievedContext
            .map(c => `${c.title}@${c.similarity.toFixed(2)}`)
            .join(', ');
        console.log(`[Processor] KB hits for ${from}: ${summary}`);
    }

    const [responseText, classifyOutcome, reclassifyOutcome] = await Promise.all([
        claudeService.generateResponse(
            effectiveText,
            crmEntity.id,
            from,
            historyWithoutCurrent,
            crmEntity.type,
            permittedTools,
            crmEntity.fullname,
            session.id,
            leadOnboarding,
            retrievedContext,
        ),
        classifyPromise,
        reclassifyPromise,
    ]);

    // Escalation recovery: if the re-classifier flipped the case back to L1,
    // join the normal L1 post-response flow (recordBotResponse + feedback prompt)
    // by promoting the recovered case to respondingCaseId.
    if (reclassifyCaseId && reclassifyOutcome.recovered) {
        respondingCaseId = reclassifyCaseId;
    }

    const finalResponseText = outboundPrefix ? outboundPrefix + responseText : responseText;
    await supabaseService.saveMessage(session.id, 'assistant', finalResponseText);

    await metaWhatsAppService.sendMessage(from, finalResponseText);

    // For leads with LoE still outstanding, follow the first-message AI reply
    // with a tiny buttoned prompt so the action is one tap away. Gated on
    // first-message-in-session so subsequent turns don't keep nagging.
    if (
        crmEntity.type === 'lead'
        && leadOnboarding?.loeReceived === false
        && historyWithoutCurrent.length === 0
    ) {
        try {
            await metaWhatsAppService.sendReplyButtons(
                from,
                "Once you've signed, let me know here:",
                [
                    { id: LOE_BUTTON_PAYLOAD.SIGNED, title: "I've signed it" },
                    { id: LOE_BUTTON_PAYLOAD.LATER, title: "I'll do it later" },
                ]
            );
        } catch (e) {
            console.warn('[Processor] LoE button follow-up failed:', (e as Error).message);
        }
    }

    // After the main answer lands, close the case loop.
    //   - Escalations (only meaningful for newly-created cases) skip the
    //     feedback prompt — straight to a human.
    //   - Newly-created L1 cases transition to bot_responded.
    //   - Continuation turns (respondingCaseId set, but newCaseId null) ride on
    //     an existing case that's already bot_responded; no status write needed.
    // Every non-escalated path enqueues a feedback prompt against the responding
    // case. The worker dedups at fire time via session.pending_case_id so
    // multiple enqueues across the conversation collapse to one prompt.
    if (newCaseId && classifyOutcome.level === 'escalation') {
        await caseService.markEscalated(newCaseId, 'Bot classified as escalation', crmRequestId);
    } else if (respondingCaseId) {
        const botAnswerSentAt = new Date().toISOString();
        // Idempotent on continuations: case is already in bot_responded, the
        // call refreshes riivo_botanswers in Dynamics with the latest reply.
        await caseService.recordBotResponse(respondingCaseId, 'direct_answer', finalResponseText, crmRequestId);
        try {
            await enqueueFeedbackPrompt({
                caseId: respondingCaseId,
                sessionId: session.id,
                phoneNumber: from,
                crmRequestId: crmRequestId,
                botAnswerSentAt,
            });
            console.log(`[FeedbackPrompt] scheduled caseId=${respondingCaseId} sessionId=${session.id} new=${newCaseId ? 'yes' : 'no'}`);
        } catch (e: any) {
            console.warn(`[FeedbackPrompt] enqueue_failed caseId=${respondingCaseId} sessionId=${session.id} err=${e?.message || e}`);
        }
    }

    claudeService.classifyIntent(effectiveText, responseText, session.current_intent, session.id, from, crmEntity.type)
        .then(intent => {
            console.log(`[Processor] Intent: ${intent}`);
            return supabaseService.updateSessionState(session.id, intent, null);
        })
        .catch(e => console.warn('[Processor] Intent classification failed:', e.message));

    try {
        await dynamicsService.logMessage(crmEntity, finalResponseText, 'Outgoing', from, crmRequestId);
    } catch (e) {
        console.warn('[Processor] Outgoing log failed:', (e as Error).message);
    }

    console.log(`[Processor] Bot → ${from}: ${responseText.slice(0, 80)}...`);
}

/**
 * Top-level job handler called by the BullMQ worker. Re-parses the raw Meta
 * message (the raw payload is shipped through the queue so the worker can
 * pick up new IncomingMessage parse logic without a queue drain) and runs
 * the existing processMessage flow inside the same AsyncLocalStorage scope
 * the controller used to set up.
 */
export async function processInboundJob(payload: WhatsAppJobPayload): Promise<void> {
    const incoming = extractIncoming(payload.rawMessage);
    if (!incoming) {
        console.log(`[Processor] Unsupported message type after dequeue: ${payload.rawMessage?.type}`);
        return;
    }

    const ctx = { phoneNumberId: payload.phoneNumberId || '' };
    await messageContextStorage.run(ctx, async () => {
        await processMessage(incoming);
    });
}
