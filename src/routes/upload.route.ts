import { Request, Response, Router } from 'express';
import multer from 'multer';
import { dynamicsService } from '../services/dynamics.service';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Temporary store for uploaded files waiting for classification
const pendingUploads: Map<string, { fileName: string; mimeType: string; buffer: Buffer; uploadedAt: number }> = new Map();

// Clean up old pending uploads (older than 10 min)
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of pendingUploads) {
        if (now - val.uploadedAt > 10 * 60 * 1000) pendingUploads.delete(key);
    }
}, 60 * 1000);

/**
 * Upload a file. Stores it temporarily until the AI classifies it via the chat flow.
 */
router.post('/', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
    try {
        if (!req.file) {
            res.status(400).json({ error: 'No file uploaded' });
            return;
        }

        const phoneNumber = req.body.phoneNumber || '0787133880';

        // Store file temporarily — the chat flow will handle classification
        pendingUploads.set(phoneNumber, {
            fileName: req.file.originalname,
            mimeType: req.file.mimetype,
            buffer: req.file.buffer,
            uploadedAt: Date.now(),
        });

        console.log(`[Upload] File "${req.file.originalname}" stored pending classification for ${phoneNumber}`);

        res.json({
            message: 'File received. Please classify the document type in the chat.',
            fileName: req.file.originalname,
            pendingClassification: true,
        });
    } catch (error: any) {
        console.error('Upload Error:', error);
        res.status(500).json({ error: 'Failed to upload file' });
    }
});

/**
 * Save a pending upload to CRM after classification.
 * Called internally by the AI tool handler.
 */
export async function savePendingUpload(
    phoneNumber: string,
    docType: string,
    entity: any
): Promise<{ success: boolean; fileName?: string }> {
    const pending = pendingUploads.get(phoneNumber);
    if (!pending) {
        return { success: false };
    }

    // Prefix filename with doc type for CRM clarity
    const classifiedName = `[${docType}] ${pending.fileName}`;

    await dynamicsService.uploadDocument(
        entity,
        classifiedName,
        pending.mimeType,
        pending.buffer
    );

    pendingUploads.delete(phoneNumber);
    console.log(`[Upload] Saved "${classifiedName}" to ${entity.type} ${entity.id}`);
    return { success: true, fileName: pending.fileName };
}

/**
 * Check if there's a pending upload for a phone number.
 */
export function hasPendingUpload(phoneNumber: string): boolean {
    return pendingUploads.has(phoneNumber);
}

/**
 * Read a staged upload without consuming it. Lets a tool inspect the mime type
 * (e.g. to enforce PDF-only) before deciding whether to commit it to CRM.
 */
export function peekPendingUpload(
    phoneNumber: string
): { fileName: string; mimeType: string; buffer: Buffer } | null {
    const pending = pendingUploads.get(phoneNumber);
    if (!pending) return null;
    return { fileName: pending.fileName, mimeType: pending.mimeType, buffer: pending.buffer };
}

/**
 * Explicitly clear a staged upload after it has been successfully committed.
 */
export function clearPendingUpload(phoneNumber: string): void {
    pendingUploads.delete(phoneNumber);
}

export default router;
