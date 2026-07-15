import { dynamicsService } from './dynamics.service';
import { sharePointService } from './sharepoint.service';
import { mistralService } from './mistral.service';
import { irp5ExtractorService, inferSourceCodesFromIrp5Row } from './irp5-extractor.service';
import { computeAssociatedDocsForClient, getCurrentSaTaxYear } from './requiredDocuments.service';
import { supabaseService } from './supabase.service';
import type { DocRecommendationItem } from '../domain/docRecommendation';
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
        /**
         * Full tailored list of documents associated with the return (forms +
         * docs, reason-annotated, the just-uploaded IRP5 filtered out) for the
         * list-once presentation (Issue 26). Pure ADVICE (ADR 0004) — NOT a diff
         * against what's on file.
         */
        associatedDocs: DocRecommendationItem[];
        /**
         * True when OCR/extraction yielded no source codes off the cert, so the
         * list degraded to the generic profile/baseline fallback. INTERNAL ONLY
         * — for staff logging; never surfaced to the client (we have the file).
         */
        extractionDegraded: boolean;
    };

/**
 * Full IRP5 ingestion for a client-uploaded cert: SharePoint file →
 * riivo_taxsubmissionsdocuments row → OCR → structured extraction →
 * riivo_irp5s row (cert-number deduped) → source-code union across the
 * client's other IRP5s for the year → associated-docs advice computation.
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

    // Graceful OCR/extraction failure (Issue 26): no source codes off this cert
    // means we couldn't read it (or it carried none). The file is already on
    // file, so we still confirm receipt and fall back to the generic
    // profile/baseline list inside computeAssociatedDocsForClient — we NEVER
    // tell the client we couldn't read it. Log it so staff can follow up.
    const extractionDegraded = extracted.sourceCodes.length === 0;
    if (extractionDegraded) {
        console.warn(`[IRP5] No source codes extracted from ${fileName} for ${contactId} — degrading to generic profile/baseline doc list. Cert is on file at ${webUrl}.`);
    }

    // Step 7: compute the full associated-docs advice list (forms + docs),
    // minus the IRP5 they just sent this turn. ADR 0004 (advice-only): this is
    // NOT a diff against on-file records — we just drop the cert we know they
    // sent in THIS upload from the "what else helps" advice.
    const associated = await computeAssociatedDocsForClient(contactId, allCodes, new Date());
    const associatedForClient = associated.documents.filter(d => !/^irp5\b/i.test(d.label));

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
        associatedDocs: associatedForClient,
        extractionDegraded,
    };
}

/**
 * State-B lead IRP5 fast-track: a lead who has signed their LoE but hasn't yet
 * completed the SARS OTP can send their IRP5 early. We can't write a
 * Contact-scoped riivo_irp5s/taxsubmissionsdocuments row yet (they're still a
 * Lead), so we stage the cert in Supabase (pending_irp5s) keyed on the lead and
 * apply it once they convert to a Contact. SharePoint stores under
 * leads/{leadId}/{year}/; a Lead annotation records the extraction for staff.
 *
 * Lifted verbatim out of the claude.service upload_irp5 closure (Issue 4) so the
 * Tool handler reaches it through the Irp5Port instead of capturing it from
 * enclosing scope. Clears the staged buffer on success.
 */
export async function processStateBLeadIrp5Upload(
    leadId: string,
    phone: string,
    staged: { fileName: string; mimeType: string; buffer: Buffer },
): Promise<string> {
    const currentTaxYear = getCurrentSaTaxYear();

    // Step 1: SharePoint upload under leads/{leadId}/{year}/.
    let webUrl: string;
    try {
        const spResult = await sharePointService.uploadLeadDocumentFile({
            leadId,
            uploadYear: new Date().getFullYear(),
            fileName: staged.fileName,
            mimeType: staged.mimeType,
            buffer: staged.buffer,
        });
        webUrl = spResult.webUrl;
    } catch (err: any) {
        const msg = err?.response?.data?.error?.message || err?.message || 'unknown error';
        console.error(`[upload_irp5 lead] SharePoint upload failed for lead ${leadId}/${staged.fileName}:`, msg);
        return JSON.stringify({ status: 'error', error: 'sharepoint_failed', message: `Couldn't store the file in SharePoint: ${msg}. Ask the client to resend in a moment.` });
    }

    // Step 2 + 3: OCR + extraction (best-effort).
    let ocrMarkdown: string | null = null;
    if (mistralService.isConfigured()) {
        try {
            const ocr = await mistralService.ocrDocument(staged.fileName, staged.buffer, staged.mimeType || 'application/pdf');
            ocrMarkdown = ocr.fullMarkdown;
            console.log(`[upload_irp5 lead] OCR'd ${staged.fileName} → ${ocr.pageCount} pages, ${ocrMarkdown.length} chars`);
        } catch (err: any) {
            console.warn(`[upload_irp5 lead] OCR failed: ${err?.message || err}`);
        }
    }
    const extracted = ocrMarkdown
        ? await irp5ExtractorService.extractIrp5Fields(ocrMarkdown)
        : { riivoFields: {} as Record<string, any>, sourceCodes: [] as string[] };

    let wrongYearWarning: string | undefined;
    if (typeof extracted.assessmentYear === 'number' && extracted.assessmentYear !== currentTaxYear.label) {
        wrongYearWarning = `The cert reads as the ${extracted.assessmentYear} assessment year, but we're collecting docs for ${currentTaxYear.label} (${currentTaxYear.rangeText}). Ask the client to confirm whether they meant to send this older one.`;
    }

    // Step 4: stage in Supabase.
    const inserted = await supabaseService.insertPendingIrp5({
        leadId,
        phoneNumber: phone,
        sharepointUrl: webUrl,
        fileName: staged.fileName,
        certificateNumber: extracted.certificateNumber || null,
        assessmentYear: typeof extracted.assessmentYear === 'number' ? extracted.assessmentYear : null,
        employerName: extracted.employerName || null,
        sourceCodes: extracted.sourceCodes || [],
        extractedFields: extracted.riivoFields || null,
    });

    // Step 5: Lead annotation (best-effort — we don't roll back
    // SharePoint or Supabase if this fails).
    await dynamicsService.createIrp5AnnotationOnLead(leadId, {
        employerName: extracted.employerName || null,
        assessmentYear: typeof extracted.assessmentYear === 'number' ? extracted.assessmentYear : null,
        certificateNumber: extracted.certificateNumber || null,
        sourceCodes: extracted.sourceCodes || [],
        sharepointUrl: webUrl,
    });

    clearPendingUpload(phone);

    const targetYear = (typeof extracted.assessmentYear === 'number' && extracted.assessmentYear === currentTaxYear.label)
        ? extracted.assessmentYear
        : currentTaxYear.label;

    return JSON.stringify({
        status: 'irp5_staged_for_lead',
        employer_name: extracted.employerName || null,
        assessment_year: extracted.assessmentYear || targetYear,
        certificate_number: extracted.certificateNumber || null,
        sharepoint_url: webUrl,
        pending_id: inserted?.id || null,
        wrong_year_warning: wrongYearWarning,
        message: `IRP5${extracted.employerName ? ` from ${extracted.employerName}` : ''} for the ${targetYear} tax year is staged on our side. Compose a short warm confirmation: thank the client by name if you know it, mention the employer + year, and tell them the consultant will pick it up when they're set up on eFiling.${wrongYearWarning ? ' But first: ' + wrongYearWarning : ''}`,
    });
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
