import { dynamicsService } from './dynamics.service';
import { sharePointService } from './sharepoint.service';
import { mistralService } from './mistral.service';
import { irp5ExtractorService, inferSourceCodesFromIrp5Row } from './irp5-extractor.service';
import { computeMissingDocsForClient, getCurrentSaTaxYear } from './requiredDocuments.service';
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

/**
 * Persist a client document straight from an in-memory buffer — same triple
 * write as savePendingUpload but without going through the per-phone staging
 * Map. The WhatsApp processor uses this to file client uploads the moment they
 * arrive (no classification round-trip), so two documents sent back-to-back
 * can't clobber each other in the single-slot Map.
 *
 * "success" means the file landed somewhere durable (SharePoint and/or the
 * annotation safety net). The SharePoint + taxsubmissionsdocuments leg is
 * best-effort inside dualWriteClientDocument; the annotation is the net.
 */
export async function saveClientDocumentDirect(params: {
    contactId: string;
    docType: string;
    fileName: string;
    mimeType: string;
    buffer: Buffer;
    notes?: string;
}): Promise<{ success: boolean }> {
    const entity = { id: params.contactId, type: 'client' };
    const classifiedName = `[${params.docType}] ${params.fileName}`;
    try {
        await dualWriteClientDocument({
            contactId: params.contactId,
            docType: params.docType,
            notes: params.notes,
            fileName: params.fileName,
            mimeType: params.mimeType,
            buffer: params.buffer,
        });
        await dynamicsService.uploadDocument(entity, classifiedName, params.mimeType, params.buffer);
        console.log(`[PendingUpload] Direct-saved "${classifiedName}" to client ${params.contactId}`);
        return { success: true };
    } catch (err: any) {
        console.error(`[PendingUpload] Direct save failed for client ${params.contactId}/${params.fileName}:`, err?.message || err);
        return { success: false };
    }
}

export type ClientIrp5Result =
    | { status: 'error'; error: string; message: string }
    | {
        status: 'irp5_processed';
        employerName: string | null;
        assessmentYear: number;
        certificateNumber: string | null;
        sourceCodes: string[];
        irp5RecordId: string | null;
        irp5Updated: boolean;
        taxsubmissionsdocumentId: string | null;
        sharepointUrl: string | null;
        wrongYearWarning?: string;
        missingDocs: { label: string; notes?: string }[];
    };

/**
 * Full IRP5 ingestion for a client-uploaded cert: SharePoint file →
 * riivo_taxsubmissionsdocuments row → OCR → structured extraction →
 * riivo_irp5s row (cert-number deduped) → source-code union across the
 * client's other IRP5s for the year → outstanding-docs computation.
 *
 * Returns structured data; callers build their own user-facing message
 * (the Claude tool path composes one reply, the deterministic WhatsApp path
 * composes another). Does NOT touch the staging Map — caller owns the buffer
 * and any clearPendingUpload. Side effects mirror the original upload_irp5
 * tool handler exactly so the two call sites stay in lock-step.
 */
export async function processClientIrp5Upload(params: {
    contactId: string;
    contactFullName: string;
    fileName: string;
    mimeType: string;
    buffer: Buffer;
}): Promise<ClientIrp5Result> {
    const { contactId, contactFullName, fileName, mimeType, buffer } = params;
    const currentTaxYear = getCurrentSaTaxYear();

    // Step 1: SharePoint upload. Failure aborts (caller leaves the file staged
    // so the client can resend) — everything downstream depends on the URL.
    let webUrl: string | undefined;
    try {
        const spResult = await sharePointService.uploadDocumentFile({
            contactFullName,
            contactId,
            uploadYear: new Date().getFullYear(),
            fileName,
            mimeType,
            buffer,
        });
        webUrl = spResult.webUrl;
    } catch (err: any) {
        const msg = err?.response?.data?.error?.message || err?.message || 'unknown error';
        console.error(`[IRP5] SharePoint upload failed for ${contactId}/${fileName}:`, msg);
        return { status: 'error', error: 'sharepoint_failed', message: `Couldn't store the file in SharePoint: ${msg}. Ask the client to resend in a moment.` };
    }

    // Step 2: riivo_taxsubmissionsdocuments row (canonical IRP5 tag + link).
    const tsdResult = await dynamicsService.createTaxSubmissionDocument({
        contactId,
        canonicalDocType: 'IRP5',
        fileReferenceUrl: webUrl,
        documentNotes: `Uploaded via WhatsApp Bot on ${new Date().toISOString().slice(0, 10)}. Bot doc type: IRP5. File: ${fileName}.`,
        triggeredBy: contactId,
    });
    if (!tsdResult.success) {
        console.warn(`[IRP5] taxsubmissionsdocuments row create failed for ${contactId} — file is at ${webUrl}`);
    }

    // Step 3 + 4: OCR + structured extraction (best-effort).
    let ocrMarkdown: string | null = null;
    if (mistralService.isConfigured()) {
        try {
            const ocr = await mistralService.ocrDocument(fileName, buffer, mimeType || 'application/pdf');
            ocrMarkdown = ocr.fullMarkdown;
            console.log(`[IRP5] OCR'd ${fileName} → ${ocr.pageCount} pages, ${ocrMarkdown.length} chars`);
        } catch (err: any) {
            console.warn(`[IRP5] OCR failed: ${err?.message || err}`);
        }
    }

    const extracted = ocrMarkdown
        ? await irp5ExtractorService.extractIrp5Fields(ocrMarkdown)
        : { riivoFields: {}, sourceCodes: [] as string[] } as Awaited<ReturnType<typeof irp5ExtractorService.extractIrp5Fields>>;

    // Out-of-season detection: warn but proceed.
    let wrongYearWarning: string | undefined;
    if (typeof extracted.assessmentYear === 'number' && extracted.assessmentYear !== currentTaxYear.label) {
        wrongYearWarning = `The cert reads as the ${extracted.assessmentYear} assessment year, but we're collecting docs for ${currentTaxYear.label} (${currentTaxYear.rangeText}). Ask the client to confirm whether they meant to send this older one before you proceed asking for more docs.`;
    }

    // Step 5: riivo_irp5s row (with cert-number dedupe).
    let irp5RecordId: string | undefined;
    let irp5Updated = false;
    if (Object.keys(extracted.riivoFields).length > 0) {
        const irp5Result = await dynamicsService.createIrp5Record({
            contactId,
            filename: fileName,
            sharepointUrl: webUrl,
            fields: extracted.riivoFields,
        });
        if (irp5Result.success) {
            irp5RecordId = irp5Result.recordId;
            irp5Updated = Boolean(irp5Result.updated);
        } else {
            console.warn(`[IRP5] riivo_irp5s row create failed: ${irp5Result.error}`);
        }
    } else {
        console.warn(`[IRP5] No fields extracted — skipping riivo_irp5s row create (file + taxsubmissionsdocuments row already on file)`);
    }

    // Step 6: union source codes across this IRP5 + every other IRP5 on file
    // for the same assessment year (multi-employer flow).
    const targetYear = (typeof extracted.assessmentYear === 'number' && extracted.assessmentYear === currentTaxYear.label)
        ? extracted.assessmentYear
        : currentTaxYear.label;
    const priorIrp5s = await dynamicsService.getIrp5RecordsForClient(contactId, targetYear);
    const priorCodes = priorIrp5s
        .filter((r: any) => r?.riivo_irp5id !== irp5RecordId)
        .flatMap((r: any) => inferSourceCodesFromIrp5Row(r));
    const allCodes = Array.from(new Set([...extracted.sourceCodes, ...priorCodes]));

    // Step 7: compute outstanding docs, minus the IRP5 they just sent.
    const missing = await computeMissingDocsForClient(contactId, allCodes, new Date());
    const outstandingForClient = missing.outstanding.filter(d => !/^irp5\b/i.test(d.label));

    return {
        status: 'irp5_processed',
        employerName: extracted.employerName || null,
        assessmentYear: extracted.assessmentYear || targetYear,
        certificateNumber: extracted.certificateNumber || null,
        sourceCodes: extracted.sourceCodes,
        irp5RecordId: irp5RecordId || null,
        irp5Updated,
        taxsubmissionsdocumentId: tsdResult.recordId || null,
        sharepointUrl: webUrl || null,
        wrongYearWarning,
        missingDocs: outstandingForClient.map(d => ({ label: d.label, notes: d.notes })),
    };
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
