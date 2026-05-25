import { claudeService } from '../services/claude.service';
import { metaWhatsAppService } from '../services/meta.service';
import { dynamicsService, REQUEST_STATUSCODE } from '../services/dynamics.service';
import { supabaseService } from '../services/supabase.service';
import { stagePendingUpload } from '../services/pendingUpload.service';
import {
    caseService,
    CASE_FEEDBACK_BUTTON_YES,
    CASE_FEEDBACK_BUTTON_NO,
} from '../services/case.service';
import { handleClientRelayResponse, RELAY_BUTTON_PAYLOAD } from '../controllers/emailRelay.controller';
import { knowledgeBaseService, KbChunkHit } from '../services/knowledgeBase.service';
import { graphMailService } from '../services/graphMail.service';
import { messageContextStorage } from '../utils/messageContext';
import { WhatsAppJobPayload } from '../queue/whatsappQueue';
import { enqueueFeedbackPrompt } from '../queue/feedbackPromptQueue';
import { buildLoeMagicLink } from '../utils/loeMagicLink';

// Idle-vs-immediate feedback prompt mode. `immediate` (default) preserves
// the pre-PRD behavior: buttons go out right after the bot's L1 answer.
// `idle` schedules a 2.5-min delayed job that only fires if the client has
// gone silent — set by env var, single check at the enqueue site below.
function getFeedbackPromptMode(): 'immediate' | 'idle' {
    return (process.env.FEEDBACK_PROMPT_MODE || 'immediate') === 'idle' ? 'idle' : 'immediate';
}

const WRAP_UP_NOTIFICATION = "Glad I could help! 🙌 I've marked this as resolved. Message me any time if anything else comes up.";

const SIGN_UP_GREETING = `👋 Welcome to TTT Financial Group!\n\nLooks like you're new here. Tap Sign up to register in under a minute, or use the web form if you'd rather. Once you're in, we'll handle your tax, accounting and insurance right here on WhatsApp. 💬`;
const SIGN_UP_LINK = `https://www.ttt-tax.co.za/client-onboarding`;

const SIGNUP_TEMPLATE_NAME = process.env.WHATSAPP_SIGNUP_TEMPLATE_NAME || '';
const SIGNUP_TEMPLATE_LANG = process.env.WHATSAPP_SIGNUP_TEMPLATE_LANG || 'en';

// Stable ids for the client first-message interactive menu. Kept namespaced
// (`menu:client:*`) so future lead/staff menus can coexist without colliding.
const CLIENT_MENU_IDS = {
    INVOICES: 'menu:client:invoices',
    CASES: 'menu:client:cases',
    UPLOAD: 'menu:client:upload',
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

async function resolveSender(phoneNumber: string): Promise<ResolvedEntity> {
    let crmEntity: any = null;
    let staffRoleId: string | null = null;
    let permittedTools: string[] = [];

    const staff = await supabaseService.findStaffByPhone(phoneNumber);
    if (staff) {
        crmEntity = { id: staff.dynamics_user_id, type: 'user', fullname: staff.full_name };
        staffRoleId = staff.role_id;
        permittedTools = staff.role_id ? await supabaseService.getPermittedTools(staff.role_id) : [];
        console.log(`[Processor] ${phoneNumber} matched staff "${staff.full_name}" role_id=${staff.role_id || 'NONE'} tools=${permittedTools.length}`);
        return { crmEntity, staffRoleId, permittedTools };
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

    const created = await dynamicsService.createLead({
        firstName,
        lastName,
        phone: from,
        email,
        notes: combinedNotes,
        clientType: typeof clientType === 'number' && !Number.isNaN(clientType) ? clientType : undefined,
        leadType: typeof leadType === 'number' && !Number.isNaN(leadType) ? leadType : undefined,
        referredByContactId,
        ownerSystemUserId,
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

    const loeLink = buildLoeMagicLink(created.new_leadid);
    if (loeLink) {
        const welcome = `Thanks, ${firstName}! You're signed up with TTT Financial Group. 🎉\n\nNext step: sign your Letter of Engagement using your unique link (valid for 72 hours):\n\n${loeLink}\n\nOnce that's signed, let us know below.`;
        await metaWhatsAppService.sendReplyButtons(from, welcome, [
            { id: LOE_BUTTON_PAYLOAD.SIGNED, title: "I've signed it" },
            { id: LOE_BUTTON_PAYLOAD.LATER, title: "I'll do it later" },
        ]);
    } else {
        await metaWhatsAppService.sendMessage(
            from,
            `Thanks, ${firstName}! You're all signed up with TTT Financial Group. A consultant will be in touch shortly. In the meantime, feel free to message any questions.`
        );
    }
}

// Tap on the OTP template's two quick-reply buttons. DONE flags the lead for
// auto-conversion in Dynamics (a Power Automate flow converts the lead to a
// contact once icon_converttoclient flips). HELP creates and escalates a
// riivo_request, and emails taxcrew@ttt-tax.co.za from the tina-bot mailbox
// so a human picks it up.
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
        await metaWhatsAppService.sendMessage(
            from,
            "Amazing, thank you! 🎉 You're all set. We'll finalise your account on our side and a TTT consultant will be in touch shortly to welcome you in properly."
        );
        return;
    }

    // HELP path: create + escalate a request so the consultant has a tracked
    // record, then email taxcrew so a human picks it up.
    const description = `Lead "${leadName}" tapped "Need help" on the SARS eFiling OTP template. They need a consultant to walk them through the OTP step.`;
    const created = await dynamicsService.createRequest({
        leadId,
        contactType: 'lead',
        phoneNumber: from,
        description,
    });
    if (created?.riivo_requestid) {
        await dynamicsService.updateRequest(created.riivo_requestid, {
            statuscode: REQUEST_STATUSCODE.ESCALATED,
            riivo_escalationreason: 'Lead requested help with SARS eFiling OTP',
            riivo_escalatedon: new Date().toISOString(),
        });
    }

    const emailSubject = `Lead needs help with SARS OTP — ${leadName}`;
    const emailBody = [
        `Lead "${leadName}" (${from}) has tapped the "Need help" button on the SARS eFiling OTP template.`,
        '',
        'They need a consultant to walk them through the OTP step on https://secure.sarsefiling.co.za/app/profileTaxType/taxTypeActivation.',
        '',
        created?.riivo_requestid
            ? `An escalated riivo_request has been created for tracking: ${created.riivo_requestid}.`
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

    if (interactiveId === LOE_BUTTON_PAYLOAD.SIGNED) {
        await metaWhatsAppService.sendMessage(
            from,
            "Awesome, thank you! 🙌 Once we have your LoE on file, the last step is the SARS eFiling OTP. A TTT consultant will reach out here on WhatsApp during working hours (Mon-Fri, 8am-4pm SAST) to walk you through it — expect either a message or a call."
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

    if (document) {
        try {
            const { buffer, mimeType } = await metaWhatsAppService.downloadMedia(document.id);
            stagePendingUpload(from, document.filename, mimeType || document.mimeType, buffer);
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

    // Client menu taps: rewrite the tap's title into a canonical question so the
    // existing AI + tools path routes to the right handler without bespoke
    // dispatch. OTHER is handled separately after session resolution.
    if (interactiveId && CLIENT_MENU_CANONICAL_TEXT[interactiveId]) {
        effectiveText = CLIENT_MENU_CANONICAL_TEXT[interactiveId];
        console.log(`[Processor] ${from} tapped ${interactiveId} → "${effectiveText}"`);
    }

    const { crmEntity, staffRoleId: initialStaffRoleId, permittedTools: initialTools } = await resolveSender(from);

    if (!crmEntity) {
        if (SIGNUP_TEMPLATE_NAME) {
            const result = await metaWhatsAppService.sendTemplate(from, {
                name: SIGNUP_TEMPLATE_NAME,
                languageCode: SIGNUP_TEMPLATE_LANG,
                flowButton: { index: 0 },
            });
            if (result.delivered) {
                console.log(`[Processor] ${from} not found — sent sign-up template "${SIGNUP_TEMPLATE_NAME}"`);
                return;
            }
            console.warn(`[Processor] sendTemplate "${SIGNUP_TEMPLATE_NAME}" failed (${result.error}), falling back to link`);
        }
        console.log(`[Processor] ${from} not found — sending sign-up link`);
        await metaWhatsAppService.sendMessage(from, SIGN_UP_GREETING);
        await metaWhatsAppService.sendMessage(from, SIGN_UP_LINK);
        return;
    }

    if (interactiveId === OTP_BUTTON_PAYLOAD.DONE || interactiveId === OTP_BUTTON_PAYLOAD.HELP) {
        await handleOtpTemplateResponse(from, interactiveId, crmEntity);
        return;
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
    // (no prior messages) for an organic text inbound — skip for documents,
    // menu taps, and L1 feedback button replies so those flows aren't broken.
    if (
        crmEntity.type === 'client' &&
        !document &&
        !interactiveId
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
    let crmRequestId: string | null = null;
    let newCaseId: string | null = null;
    if (crmEntity.type === 'client' || crmEntity.type === 'lead') {
        crmRequestId = await supabaseService.findOpenRequestForSession(session.id);
        if (!crmRequestId && caseService.qualifyMessage(effectiveText)) {
            const created = await caseService.createCase({
                sessionId: session.id,
                contactId: crmEntity.id,
                contactType: crmEntity.type,
                phoneNumber: from,
                queryText: effectiveText,
            });
            if (created) {
                newCaseId = created.id;
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

    // Feedback routing: if this session is waiting on feedback for a bot answer,
    // and the inbound looks like yes/no, close the loop without invoking the AI.
    const pendingCaseId = (session as any).pending_case_id || null;
    if (crmEntity.type === 'client' && pendingCaseId) {
        const feedback = caseService.detectFeedback(effectiveText);
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

    const history = await supabaseService.getHistory(session.id);
    const historyWithoutCurrent = history.slice(0, -1);

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

    const [responseText, classifyOutcome] = await Promise.all([
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
    ]);

    const finalResponseText = outboundPrefix ? outboundPrefix + responseText : responseText;
    await supabaseService.saveMessage(session.id, 'assistant', finalResponseText);

    await metaWhatsAppService.sendMessage(from, finalResponseText);

    // After the main answer lands, close the case loop.
    if (newCaseId) {
        if (classifyOutcome.level === 'L1') {
            const botAnswerSentAt = new Date().toISOString();
            await caseService.recordBotResponse(newCaseId, 'direct_answer', finalResponseText, crmRequestId);

            if (getFeedbackPromptMode() === 'idle') {
                // Delay the buttons by 2.5 minutes and only fire them if the
                // client has gone silent (state check happens at job fire time).
                try {
                    await enqueueFeedbackPrompt({
                        caseId: newCaseId,
                        sessionId: session.id,
                        phoneNumber: from,
                        crmRequestId: crmRequestId,
                        botAnswerSentAt,
                    });
                    console.log(`[FeedbackPrompt] scheduled caseId=${newCaseId} sessionId=${session.id}`);
                } catch (e: any) {
                    console.warn(`[FeedbackPrompt] enqueue_failed caseId=${newCaseId} sessionId=${session.id} err=${e?.message || e}`);
                }
            } else {
                // Immediate-mode: pre-PRD behavior. Buttons go out now.
                try {
                    await metaWhatsAppService.sendReplyButtons(
                        from,
                        'Did that answer your question?',
                        [
                            { id: CASE_FEEDBACK_BUTTON_YES, title: 'Yes, thanks' },
                            { id: CASE_FEEDBACK_BUTTON_NO, title: 'Still need help' },
                        ]
                    );
                    await supabaseService.setSessionPendingCase(session.id, newCaseId);
                    if (crmRequestId) {
                        await dynamicsService.updateRequest(crmRequestId, {
                            statuscode: REQUEST_STATUSCODE.AWAITING_FEEDBACK,
                        });
                    }
                } catch (e: any) {
                    console.warn('[Processor] feedback buttons failed:', e?.message || e);
                }
            }
        } else if (classifyOutcome.level === 'escalation') {
            await caseService.markEscalated(newCaseId, 'Bot classified as escalation', crmRequestId);
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
