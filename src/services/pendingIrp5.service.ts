import { supabaseService, PendingIrp5Row } from './supabase.service';
import { dynamicsService } from './dynamics.service';
console.log('[boot] pendingIrp5.service: imports done');

/**
 * Drain any IRP5 rows staged in Supabase for the given phone number into
 * Contact-side Dynamics records. Called from the WhatsApp inbound hook
 * once `resolveSender` resolves the entity to a Contact — that's the
 * signal that the lead has been converted by the Power Automate flow.
 *
 * Each row:
 *   1. creates a riivo_irp5s record under the new Contact (with cert-number
 *      dedupe against any IRP5 the Contact already has on file).
 *   2. creates a riivo_taxsubmissionsdocuments row pointing at the SharePoint
 *      URL stashed during staging.
 *   3. is marked applied_to_contact_id / applied_at on success, or
 *      apply_error on failure (so the next drain can either retry or skip).
 *
 * Fire-and-forget — never throws, never gates the inbound's response.
 */
async function drainForPhone(phoneNumber: string, contactId: string): Promise<number> {
    const rows = await supabaseService.findPendingIrp5sForPhone(phoneNumber);
    if (rows.length === 0) return 0;

    let applied = 0;
    for (const row of rows) {
        await applyRowToContact(row, contactId).then(ok => { if (ok) applied += 1; });
    }
    if (applied > 0) {
        console.log(`[PendingIrp5] Drained ${applied}/${rows.length} pending IRP5(s) for contact ${contactId} (phone ${phoneNumber})`);
    }
    return applied;
}

/**
 * Drain by lead id. Used by the safety-net cron when the LoE-activation
 * sweep re-checks pending IRP5s for leads that have converted since the
 * last sweep. Slightly redundant with drainForPhone — kept because the
 * cron has a leadId in hand, not a phone, and the phone lookup adds an
 * extra round-trip.
 */
async function drainForLead(leadId: string, contactId: string): Promise<number> {
    const rows = await supabaseService.findPendingIrp5sForLead(leadId);
    if (rows.length === 0) return 0;

    let applied = 0;
    for (const row of rows) {
        await applyRowToContact(row, contactId).then(ok => { if (ok) applied += 1; });
    }
    if (applied > 0) {
        console.log(`[PendingIrp5] Drained ${applied}/${rows.length} pending IRP5(s) for contact ${contactId} (lead ${leadId})`);
    }
    return applied;
}

async function applyRowToContact(row: PendingIrp5Row, contactId: string): Promise<boolean> {
    try {
        // Step 1: riivo_irp5s row (cert-number dedupe handled by createIrp5Record).
        const extracted = (row.extracted_fields || {}) as Record<string, any>;
        const irp5Result = Object.keys(extracted).length > 0
            ? await dynamicsService.createIrp5Record({
                contactId,
                filename: row.file_name,
                sharepointUrl: row.sharepoint_url,
                fields: extracted,
            })
            : { success: true, recordId: undefined, updated: false };

        if (!irp5Result.success) {
            await supabaseService.markPendingIrp5Failed(row.id, `riivo_irp5s create failed: ${irp5Result.error || 'unknown'}`);
            return false;
        }

        // Step 2: riivo_taxsubmissionsdocuments row.
        const tsdNotes = `Uploaded via WhatsApp Bot pre-conversion (lead ${row.lead_id}). File: ${row.file_name}.`;
        const tsdResult = await dynamicsService.createTaxSubmissionDocument({
            contactId,
            canonicalDocType: 'IRP5',
            fileReferenceUrl: row.sharepoint_url,
            documentNotes: tsdNotes,
            triggeredBy: contactId,
        });
        if (!tsdResult.success) {
            console.warn(`[PendingIrp5] taxsubmissionsdocuments row create failed for ${contactId} — file at ${row.sharepoint_url} but irp5s row was written`);
            // Don't treat this as a hard failure — the cert + file are already in CRM.
        }

        await supabaseService.markPendingIrp5Applied(row.id, contactId);
        return true;
    } catch (err: any) {
        const msg = err?.message || String(err);
        console.error(`[PendingIrp5] applyRowToContact threw for row ${row.id}: ${msg}`);
        await supabaseService.markPendingIrp5Failed(row.id, msg);
        return false;
    }
}

export const pendingIrp5Service = {
    drainForPhone,
    drainForLead,
};
