import { dynamicsService } from './dynamics.service';

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

export async function savePendingUpload(
    phoneNumber: string,
    docType: string,
    entity: any
): Promise<{ success: boolean; fileName?: string }> {
    const pending = pendingUploads.get(phoneNumber);
    if (!pending) return { success: false };

    const classifiedName = `[${docType}] ${pending.fileName}`;

    await dynamicsService.uploadDocument(entity, classifiedName, pending.mimeType, pending.buffer);

    pendingUploads.delete(phoneNumber);
    console.log(`[PendingUpload] Saved "${classifiedName}" to ${entity.type} ${entity.id}`);
    return { success: true, fileName: pending.fileName };
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
