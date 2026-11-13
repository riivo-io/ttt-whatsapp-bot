/**
 * Service routing (docs/PLAN-service-routing.md): the real dependencies for src/domain/serviceRoute.ts and
 * src/domain/insuranceHost.ts, and the one call the processor makes for a client's message.
 *
 * Off unless SERVICE_ROUTING_ENABLED=true. SERVICE_ROUTING_NUMBERS (comma-separated, optional) limits it to those
 * numbers, so it can be tried on PROD with our own phones first. Tina's main deploys to PROD on every push.
 * Off, Tina behaves as before: every client message goes through handleClientClaimMessage, then the tax path.
 *
 * Every client message logs one line: `[Route] <phone> lines=… side=… verdict=… why=…`.
 */
import { DEPARTMENT, type Owner } from '../departments/insurance/claim';
import { dataverseClaimPorts } from '../departments/insurance/dataverse';
import { ABANDONED_AFTER_MS } from '../domain/claimsHost';
import { insuranceTurn, offerAccepted, type Handover, type HandoverTopic, type InsurancePorts } from '../domain/insuranceHost';
import { describeLines, serviceLinesFrom, type PhoneContact, type ServiceLines } from '../domain/serviceLines';
import { decideServiceRoute, ROUTE_IDS, type PendingRoute, type RouteVerdict, type Side, type SideAnswer } from '../domain/serviceRoute';
import { sideRoute, type SideModel } from '../domain/sideIntent';
import type { CrmEntity } from '../types/crm.types';
import { RateLimitError } from '../utils/anthropicRateLimit';
import { looksLikeGreetingOnly } from '../utils/greeting';
import { claimsEnabled, contactFirstName, handleInsuranceClaimMessage, toolModel } from './claims.service';
import { dynamicsService } from './dynamics.service';
import { metaWhatsAppService } from './meta.service';
import { supabaseService } from './supabase.service';

const SIDE_MODEL = process.env.SERVICE_ROUTING_MODEL || process.env.CLAIMS_INTENT_MODEL || 'claude-haiku-4-5-20251001';
const REQUEST_CATEGORY_INSURANCE = 1; // riivo_request.riivo_category: 0 Tax, 1 Insurance, 2 Accounting
const POLICY_ACTIVE = 463630000;

const ASK_TEXT = 'Is this about your insurance or your tax?';
const ASK_BUTTONS = [{ id: ROUTE_IDS.INSURANCE, title: '🛡️ Insurance' }, { id: ROUTE_IDS.TAX, title: '🧾 Tax' }];
const OFFER_TEXT = "TTT Financial Group also does insurance, but I can't see an insurance policy for you with us. Would you like our insurance team to contact you?";
const OFFER_BUTTONS = [{ id: ROUTE_IDS.OFFER_YES, title: 'Yes, contact me' }, { id: ROUTE_IDS.OFFER_NO, title: "No, it's about tax" }];
const ACK_TEXT: Record<Side, string> = { insurance: 'Sure. What can I help with on your insurance?', tax: "Sure. What's your tax question?" };

export { serviceRoutingOn } from '../utils/serviceRoutingSwitch';

export interface RouteResult {
    /** True: answered here. False: Tina's tax path answers, with `text` instead of the message when it is set. */
    handled: boolean;
    text?: string;
    /** The tap was a routing tap: the tax path must not read it as a menu tap. */
    tapConsumed?: boolean;
    lines: ServiceLines;
}

export interface RouteArgs {
    from: string;
    entity: CrmEntity;
    session: { id: string; service_side?: Side | null; route_pending?: PendingRoute | null; insurance_handover?: Handover | null };
    text: string;
    tapId?: string;
    wamid?: string;
    file?: { name: string; mimeType: string; bytes: Buffer } | null;
}

const ROUTE_TAPS = new Set<string>(Object.values(ROUTE_IDS));

async function readLines(from: string, entity: CrmEntity): Promise<ServiceLines> {
    let contacts: PhoneContact[] | null = null;
    try {
        contacts = await dynamicsService.getRoutingContactsForPhone(from, entity.id);
    } catch (e) {
        console.warn(`[Route] ${from} contact read failed, treating as both sides:`, (e as Error).message);
    }
    return serviceLinesFrom(entity.id, contacts);
}

/** The claim walkthrough or roadside conversation in progress for this number, as claimFromClient would see it. */
async function walkthroughContact(from: string): Promise<string | null> {
    if (!claimsEnabled()) return null;
    const row = await supabaseService.getClaimWalkthrough(from);
    if (!row || !row.contact_id) return null;
    if (Date.now() - Date.parse(row.updated_at) > ABANDONED_AFTER_MS) return null;
    return row.contact_id;
}

/** The client's broker: main broker, else the one owner of their active policies, else the Insurance and Advice team. */
async function ownerFor(contactId: string, team: boolean): Promise<Owner> {
    const ports = claimPorts();
    const fallback = async (): Promise<Owner> => {
        const t = await ports.insuranceTeam();
        return { kind: 'team', id: t.id, name: t.name };
    };
    if (team) return fallback();
    try {
        const c = await dynamicsService.webApi<{ riivo_MainBroker?: { systemuserid: string; firstname?: string; isdisabled?: boolean } | null }>('GET',
            `contacts(${contactId})?$select=contactid&$expand=riivo_MainBroker($select=systemuserid,firstname,isdisabled)`);
        const b = c.riivo_MainBroker;
        if (b?.systemuserid && !b.isdisabled) return { kind: 'user', id: b.systemuserid, name: b.firstname ?? 'Broker' };

        const p = await dynamicsService.webApi<{ value: { riivo_policyid: string }[] }>('GET',
            `riivo_policies?$select=riivo_policyid&$top=20&$filter=_riivo_policyholderid_value eq ${contactId} and riivo_policy_status eq ${POLICY_ACTIVE}`);
        const owners = await Promise.all((p.value ?? []).map((x) => ports.policyOwner(x.riivo_policyid)));
        const users = new Map(owners.filter((o) => o?.kind === 'user' && o.enabled).map((o) => [o!.id, o!]));
        const all = owners.length > 0 && owners.every((o) => o?.kind === 'user' && o.enabled) && users.size === 1;
        if (all) {
            const u = [...users.values()][0] as { id: string; firstName: string };
            return { kind: 'user', id: u.id, name: u.firstName };
        }
    } catch (e) {
        console.warn(`[Route] broker lookup for ${contactId} failed, using the Insurance and Advice team:`, (e as Error).message);
    }
    return fallback();
}

function claimPorts() {
    return dataverseClaimPorts({
        dv: (method, path, body, opts) => dynamicsService.webApi(method, path, body, opts),
        send: async () => { throw new Error('service routing sends its own messages'); },
    });
}

function insurancePorts(a: RouteArgs, handover: { current: Handover | null }): InsurancePorts {
    const { from, entity, session } = a;
    let wamid = a.wamid;
    return {
        claimsEnabled: claimsEnabled(),
        claim: async (contact, text, { force }) => {
            const fullname = contact.id === entity.id ? entity.fullname : contact.firstName;
            return handleInsuranceClaimMessage(from, text, { id: contact.id, fullname }, session.id, { force });
        },
        owner: (contactId, { team }) => ownerFor(contactId, team),
        async openRequest(contactId, text, topic: HandoverTopic) {
            try {
                // As the claim request (claims.service.ts openRequest): owned by Tina's app user, because the insurance
                // roles can't own riivo_request. The Follow-up carries the broker.
                const r = await dynamicsService.webApi<{ riivo_requestid: string }>('POST', 'riivo_requests?$select=riivo_requestid', {
                    riivo_clientmobilenumber: from, riivo_channel: 1, riivo_category: REQUEST_CATEGORY_INSURANCE, riivo_priority: 1,
                    riivo_description: text.slice(0, 100), riivo_classificationtopic: topic, statecode: 0, statuscode: 1,
                    'riivo_Client@odata.bind': `/contacts(${contactId})`,
                }, { returnRow: true });
                return r.riivo_requestid;
            } catch (e) {
                console.error(`[Route] ${from} could not open the insurance request:`, (e as Error).message);
                return null;
            }
        },
        async followUp(row) {
            try {
                const r = await claimPorts().createAgentAction({
                    kind: 'Follow-up', department: DEPARTMENT, owner: row.owner, regarding: { table: 'riivo_request', id: row.requestId },
                    contactId: row.contactId, detail: row.detail, at: new Date().toISOString(),
                });
                return { dueOn: r.dueOn };
            } catch (e) {
                console.error(`[Route] ${from} could not write the Follow-up for ${row.owner.kind} ${row.owner.id}:`, (e as Error).message);
                return null;
            }
        },
        async logIncoming(requestId, text) {
            await supabaseService.saveMessage(session.id, 'user', text);
            try {
                await dynamicsService.logMessage(entity, text, 'Incoming', from, requestId, wamid);
            } catch (e) {
                console.warn('[Route] incoming log failed:', (e as Error).message);
            }
            wamid = undefined;
        },
        async send(text, o) {
            let sentId: string | null = null;
            if (o?.buttons?.length) await metaWhatsAppService.sendReplyButtons(from, text, o.buttons);
            else sentId = await metaWhatsAppService.sendMessage(from, text);
            await supabaseService.saveMessage(session.id, 'assistant', text);
            try {
                await dynamicsService.logMessage(entity, text, 'Outgoing', from, o?.requestId ?? null, sentId);
            } catch (e) {
                console.warn('[Route] outgoing log failed:', (e as Error).message);
            }
        },
        async saveFile(contactId, f) {
            try {
                await dynamicsService.webApi('POST', 'annotations', {
                    subject: 'File sent on WhatsApp (insurance)',
                    notetext: 'The client sent this file to Tina on WhatsApp. Tina passed it to the broker.',
                    filename: f.name, mimetype: f.mimeType, documentbody: f.bytes.toString('base64'),
                    'objectid_contact@odata.bind': `/contacts(${contactId})`,
                });
                return true;
            } catch (e) {
                console.error(`[Route] ${from} could not save ${f.name} on contact ${contactId}:`, (e as Error).message);
                return false;
            }
        },
        loadHandover: async () => handover.current,
        async saveHandover(h) {
            await supabaseService.setSessionRoute(session.id, { insurance_handover: h });
            handover.current = h;
        },
    };
}

/** A fixed reply that isn't the insurance host's (the ask, the offer, an ack), logged like the host's. */
async function say(a: RouteArgs, incoming: string, text: string, buttons?: { id: string; title: string }[]) {
    const ports = insurancePorts(a, { current: null });
    await ports.logIncoming(null, incoming);
    await ports.send(text, buttons ? { buttons } : undefined);
}

/**
 * A client's message: decided, logged and, unless it is the tax path's, answered. Throws a RateLimitError to
 * re-enqueue the message (as claims do); throws when the session can't be written, so the worker retries.
 */
export async function routeClientMessage(a: RouteArgs): Promise<RouteResult> {
    const { from, session } = a;
    const lines = await readLines(from, a.entity);
    const walkContact = await walkthroughContact(from);
    const fresh = !a.tapId && !a.file && looksLikeGreetingOnly(a.text)
        && (await supabaseService.getHistory(session.id)).length === 0;

    const input = {
        lines, side: session.service_side ?? null, pending: session.route_pending ?? null, tapId: a.tapId,
        document: !!a.file, text: a.text, freshGreeting: fresh, walkthrough: !!walkContact,
    };
    let verdict: RouteVerdict = decideServiceRoute(input);
    let model: SideAnswer | undefined;
    if (verdict.kind === 'needs-model') {
        const limits: RateLimitError[] = [];
        model = await sideRoute(toolModel(SIDE_MODEL, 'record_side', limits) as SideModel, a.text);
        if (limits.length) throw limits[0];
        verdict = decideServiceRoute(input, model);
    }

    // The walkthrough: the claims package, on the contact the walkthrough is for. If it lets the message go (roadside
    // switched off mid-conversation, say), the message is routed as if there were none.
    if (verdict.kind === 'walkthrough') {
        const handled = await handleInsuranceClaimMessage(from, a.text, { id: walkContact!, fullname: walkContact === a.entity.id ? a.entity.fullname : '' }, session.id);
        log(a, lines, input.side, verdict, model, handled ? 'claims' : 'let go');
        if (handled) return { handled: true, lines };
        verdict = decideServiceRoute({ ...input, walkthrough: false });
        if (verdict.kind === 'needs-model') {
            const limits: RateLimitError[] = [];
            model = await sideRoute(toolModel(SIDE_MODEL, 'record_side', limits) as SideModel, a.text);
            if (limits.length) throw limits[0];
            verdict = decideServiceRoute({ ...input, walkthrough: false }, model);
        }
    }

    // Remember first, then act: a side or a waiting message that isn't saved would send the next message the wrong way.
    const patch: { service_side?: Side; route_pending?: PendingRoute | null } = {};
    if ('setSide' in verdict && verdict.setSide && verdict.setSide !== session.service_side) patch.service_side = verdict.setSide;
    if (verdict.kind === 'ask' || verdict.kind === 'offer') patch.route_pending = { kind: verdict.kind, text: verdict.text, at: new Date().toISOString() };
    else if (session.route_pending) patch.route_pending = null;
    await supabaseService.setSessionRoute(session.id, patch);

    const tapConsumed = !!a.tapId && ROUTE_TAPS.has(a.tapId);
    const firstName = await contactFirstName(a.entity);
    const handover = { current: session.insurance_handover ?? null };
    let outcome: string = verdict.kind;

    switch (verdict.kind) {
        case 'tax':
            log(a, lines, input.side, verdict, model, verdict.text !== undefined ? 'tax (replayed)' : 'tax');
            return { handled: false, ...(verdict.text !== undefined ? { text: verdict.text } : {}), tapConsumed, lines };
        case 'insurance': {
            outcome = await insuranceTurn(insurancePorts(a, handover), {
                contact: { id: a.entity.id, firstName }, lines, text: verdict.text ?? a.text,
                ...(verdict.menu ? { menu: true, greeting: fresh } : {}), ...(verdict.claim ? { claim: true } : {}),
                ...(a.file && verdict.text === undefined ? { file: a.file } : {}),
            });
            break;
        }
        case 'offer-accepted':
            outcome = await offerAccepted(insurancePorts(a, handover), { contact: { id: a.entity.id, firstName }, text: verdict.text });
            break;
        case 'ask':
            await say(a, a.text, ASK_TEXT, ASK_BUTTONS);
            break;
        case 'offer':
            await say(a, a.text, OFFER_TEXT, OFFER_BUTTONS);
            break;
        case 'ack':
            await say(a, a.text, ACK_TEXT[verdict.setSide]);
            break;
        case 'needs-model':
        case 'walkthrough':
            // Unreachable: the model answered above, and the walkthrough was handled or let go.
            throw new Error(`[Route] unexpected verdict ${verdict.kind}`);
    }
    log(a, lines, input.side, verdict, model, outcome);
    return { handled: true, tapConsumed, lines };
}

function log(a: RouteArgs, lines: ServiceLines, side: Side | null, v: RouteVerdict, model: SideAnswer | undefined, outcome: string) {
    console.log(`[Route] ${a.from} lines=${describeLines(lines)} side=${side ?? '-'} ${a.tapId ? `tap=${a.tapId} ` : ''}${a.file ? 'file ' : ''}`
        + `model=${model ?? '-'} verdict=${v.kind}${'setSide' in v && v.setSide ? `→${v.setSide}` : ''} outcome=${outcome} why="${v.why}"`);
}
