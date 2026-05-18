import { dynamicsService } from './dynamics.service';
import { sharePointService } from './sharepoint.service';
import { mapDocTypeToCanonical } from '../utils/docTypeMapping';
console.log('[boot] pendingUpload.service: imports done');

type PendingUpload = {
    fileName: string;
    mimeType: string;
    buffer: Buffer;
    uploadedAt: number;
};

const pendingUploads = new Map<string, PendingUpload>();

setInterval(() => {
    const now = Date.now();
    for (const [key, val] of pendingUploads) {
        if (now - val.uploadedAt > 10 * 60 * 1000) pendingUploads.delete(key);
    }
}, 60 * 1000);

export function stagePendingUpload(
    phoneNumber: string,
    fileName: string,
    mimeType: string,
    buffer: Buffer
): void {
    pendingUploads.set(phoneNumber, { fileName, mimeType, buffer, uploadedAt: Date.now() });
    console.log(`[PendingUpload] Staged "${fileName}" (${buffer.length} bytes) for ${phoneNumber}`);
}

/**
 * Persist a staged WhatsApp upload across three destinations:
 *   1. SharePoint — file lands in the same per-client/per-upload-year folder
 *      tree that the email→Power Automate flow uses, so consultants find
 *      WhatsApp uploads exactly where they find emailed ones.
 *   2. riivo_taxsubmissionsdocuments — one row referencing the SharePoint
 *      webUrl, the canonical doc-type label, the inferred tax year, and
 *      (where possible) the active case and preseason record.
 *   3. annotations — kept as a safety net during migration so legacy
 *      consultant workflows still see something on the contact timeline.
 *      Drop later once dual-write is proven.
 *
 * Failure semantics: if SharePoint or the dynamics row fails we still write
 * the annotation, so the file is never silently lost. Each step's outcome is
 * logged so go-live triage can see which leg of the dual-write tripped.
 */
export async function savePendingUpload(
    phoneNumber: string,
    docType: string,
    entity: any,
    notes?: string
): Promise<{ success: boolean; fileName?: string }> {
    const pending = pendingUploads.get(phoneNumber);
    if (!pending) return { success: false };

    const classifiedName = `[${docType}] ${pending.fileName}`;

    if (entity.type === 'client') {
        await dualWriteClientDocument({
            contactId: entity.id,
            docType,
            notes,
            fileName: pending.fileName,
            mimeType: pending.mimeType,
            buffer: pending.buffer,
        });
    }

    await dynamicsService.uploadDocument(entity, classifiedName, pending.mimeType, pending.buffer);

    pendingUploads.delete(phoneNumber);
    console.log(`[PendingUpload] Saved "${classifiedName}" to ${entity.type} ${entity.id}`);
    return { success: true, fileName: pending.fileName };
}

/**
 * SharePoint + riivo_taxsubmissionsdocuments leg of the dual-write. Only
 * runs for client-type entities — lead and staff uploads still take the
 * annotation-only path until the CRM admin extends the schema to cover
 * them. Errors are caught and logged; the outer caller always proceeds to
 * the annotation safety net regardless of what fails here.
 */
async function dualWriteClientDocument(params: {
    contactId: string;
    docType: string;
    notes?: string;
    fileName: string;
    mimeType: string;
    buffer: Buffer;
}): Promise<void> {
    try {
        const contact = await dynamicsService.getContactDetails(params.contactId);
        if (!contact?.fullname) {
            console.warn(`[PendingUpload] No fullname found for contact ${params.contactId} — skipping SharePoint upload, falling back to annotation only`);
            return;
        }

        const uploadYear = new Date().getFullYear();
        let sharePointResult;
        try {
            sharePointResult = await sharePointService.uploadDocumentFile({
                contactFullName: contact.fullname,
                contactId: params.contactId,
                uploadYear,
                fileName: params.fileName,
                mimeType: params.mimeType,
                buffer: params.buffer,
            });
        } catch (err: any) {
            console.error(`[PendingUpload] SharePoint upload failed for ${params.contactId}/${params.fileName}:`, err?.response?.data?.error?.message || err.message);
            return;
        }

        const canonicalDocType = mapDocTypeToCanonical(params.docType);
        const today = new Date().toISOString().slice(0, 10);
        const noteParts = [
            params.notes?.trim() || null,
            `Uploaded via WhatsApp Bot on ${today}.`,
            `Bot doc type: ${params.docType}.`,
            `File: ${sharePointResult.finalName}.`,
        ].filter((p): p is string => !!p);
        const documentNotes = noteParts.join(' ');

        const result = await dynamicsService.createTaxSubmissionDocument({
            contactId: params.contactId,
            canonicalDocType,
            fileReferenceUrl: sharePointResult.webUrl,
            documentNotes,
            triggeredBy: params.contactId,
        });

        if (!result.success) {
            console.warn(`[PendingUpload] taxsubmissionsdocuments row create failed but SharePoint upload succeeded — file is at ${sharePointResult.webUrl}`);
        }
    } catch (err: any) {
        console.error(`[PendingUpload] Dual-write leg threw for ${params.contactId}:`, err?.message || err);
    }
}

export function hasPendingUpload(phoneNumber: string): boolean {
    return pendingUploads.has(phoneNumber);
}

export function peekPendingUpload(
    phoneNumber: string
): { fileName: string; mimeType: string; buffer: Buffer } | null {
    const pending = pendingUploads.get(phoneNumber);
    if (!pending) return null;
    return { fileName: pending.fileName, mimeType: pending.mimeType, buffer: pending.buffer };
}

export function clearPendingUpload(phoneNumber: string): void {
    pendingUploads.delete(phoneNumber);
}
