/**
 * TTTFG-5340 AC 5: the WhatsApp sign-up form and the lead Tina already made for the number.
 *
 * An unknown number that asked about tax already has a lead (src/domain/unknownNumber.ts). When the same person then fills in
 * the WhatsApp sign-up form, the form updates that lead with what they typed instead of making a second one, so one lead
 * remains. The online sign-up is the same rule on the LOE app's side, matched on phone number (subtask TTTFG-5581).
 *
 * Pure apart from the injected ports: tested without Dynamics. The processor wires the real ones.
 */

/** What the person typed on the form. */
export interface SignUpFormLead {
    firstName: string;
    lastName: string;
    email: string;
    notes?: string;
    /** riivo_clienttype (Individual, Business, ...). */
    clientType?: number;
    /** riivo_leadtype (Tax, Accounting, ...). */
    leadType?: number;
}

export interface SignUpLeadPorts {
    /** The active lead on this number, or null. A CRM error must throw: it is not "no lead", or a second one is made. */
    findByPhone(phone: string): Promise<{ id: string; notes: string | null } | null>;
    /** Updates the lead. False when the CRM refuses. */
    update(leadId: string, changes: SignUpLeadChanges): Promise<boolean>;
    /** Makes a new lead. Null when the CRM refuses. */
    create(): Promise<string | null>;
}

/** The columns the form sets on an existing lead. The owner, the lead source and the other columns stay as they are. */
export interface SignUpLeadChanges {
    firstName: string;
    lastName: string;
    email: string;
    notes?: string;
    clientType?: number;
    leadType?: number;
}

/** What the form changes on a lead that exists: what was typed, with the notes added to the notes already there. */
export function signUpLeadChanges(form: SignUpFormLead, existingNotes: string | null): SignUpLeadChanges {
    // A worker retry after the update must not add the same text twice.
    const formNotes = form.notes?.trim();
    const already = !!formNotes && !!existingNotes && existingNotes.includes(formNotes);
    const notes = [existingNotes?.trim(), already ? undefined : formNotes].filter(Boolean).join('\n') || undefined;
    return {
        firstName: form.firstName, lastName: form.lastName, email: form.email,
        ...(notes ? { notes } : {}),
        ...(typeof form.clientType === 'number' ? { clientType: form.clientType } : {}),
        ...(typeof form.leadType === 'number' ? { leadType: form.leadType } : {}),
    };
}

/** The lead the sign-up form's person ends up with: the one already on the number, updated, else a new one. Null: the CRM refused. */
export async function saveSignUpLead(
    p: SignUpLeadPorts, phone: string, form: SignUpFormLead,
): Promise<{ leadId: string; how: 'updated' | 'created' } | null> {
    const existing = await p.findByPhone(phone);
    if (existing) {
        return (await p.update(existing.id, signUpLeadChanges(form, existing.notes))) ? { leadId: existing.id, how: 'updated' } : null;
    }
    const leadId = await p.create();
    return leadId ? { leadId, how: 'created' } : null;
}
