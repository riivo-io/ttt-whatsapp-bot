/**
 * Lead / unknown-caller onboarding Tools, migrated into the Tool registry (slice 6).
 *
 * The lead-State-B onboarding Tools (`upload_irp5`, `save_document`,
 * `escalate_to_taxcrew`) already carry the `lead` role and live in
 * `clientTools.ts` (slice 4). This module is the home for the front-door
 * identity Tool offered to a caller whose phone isn't yet in our system:
 * `verify_identity`. It carries `roles: ['unknown']` — the new entity role added
 * in slice 6 so the unknown-caller surface is derived by `deriveOfferedTools`
 * like every other role, rather than special-cased inline. The handler runs
 * without a `contactId` (that's the whole point — the caller is unidentified)
 * and reaches Dynamics only through `ctx.deps.dynamics`. Output strings are
 * byte-for-byte the legacy first-round dispatch.
 */

import { register, type ToolContext, type ToolEntry } from './registry';

const verifyIdentity: ToolEntry = {
    name: 'verify_identity',
    description: "Look up a person by their South African ID number to find their account. Use when an unknown caller provides their ID number.",
    input_schema: {
        type: 'object',
        properties: {
            id_number: { type: 'string', description: 'The 13-digit SA ID number' },
        },
        required: ['id_number'],
    },
    roles: ['unknown'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { id_number?: string };
        const contact = await ctx.deps.dynamics.searchContactByIdNumber(a.id_number as string);
        if (contact) {
            // Found — link their phone and return their info
            if (ctx.phoneNumber) {
                await ctx.deps.dynamics.linkPhoneToContact(contact.contactid, ctx.phoneNumber);
            }
            return JSON.stringify({
                status: 'found',
                fullname: contact.fullname,
                contactid: contact.contactid,
                message: `Account found! Welcome back, ${contact.fullname}. Your WhatsApp number has been linked to your profile.`,
            });
        }
        return JSON.stringify({
            status: 'not_found',
            message: "No account found with that ID number. I've noted your details and a consultant will be in touch.",
        });
    },
};

export const leadToolEntries: ToolEntry[] = [
    verifyIdentity,
];

register(leadToolEntries);
