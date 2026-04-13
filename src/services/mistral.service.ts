import axios from 'axios';
import FormData from 'form-data';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Thin wrapper around Mistral's OCR API.
 *
 * Why it exists: when a staff member uploads a signed Letter of Engagement,
 * we want to extract the structured information from the PDF (client name,
 * ID number, signed date, etc.) so it can be written back to the Lead record
 * automatically. This service does the OCR step only — the field-mapping step
 * lives in the LOE handler so it can be unit-tested independently of Mistral.
 *
 * API flow:
 *   1. POST /v1/files (multipart) with purpose="ocr" → returns file_id
 *   2. GET  /v1/files/{file_id}/url → returns a short-lived signed URL
 *   3. POST /v1/ocr with document.document_url = signed URL → returns markdown
 *
 * Pricing (as of 2025): ~$1 per 1000 pages. A 2-3 page LOE = fractions of a cent.
 *
 * Required env: MISTRAL_API_KEY. Optional: MISTRAL_OCR_MODEL (default mistral-ocr-latest).
 */

const MISTRAL_BASE = 'https://api.mistral.ai/v1';

interface MistralOcrPage {
    index: number;
    markdown: string;
    images?: { id: string; image_base64?: string }[];
    dimensions?: { width: number; height: number; dpi: number };
}

export interface MistralOcrResult {
    pages: MistralOcrPage[];
    /** All pages joined into one markdown string for downstream LLM extraction. */
    fullMarkdown: string;
    model: string;
    /** Total page count from the Mistral response (useful for cost auditing). */
    pageCount: number;
}

class MistralService {
    private apiKey: string;
    private model: string;

    constructor() {
        this.apiKey = process.env.MISTRAL_API_KEY || '';
        this.model = process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest';

        if (!this.apiKey) {
            console.warn('[Mistral] MISTRAL_API_KEY missing — OCR calls will throw until it is set.');
        }
    }

    /**
     * True if the service is configured and ready to use. Lets callers
     * gracefully skip OCR (e.g. during local dev with no key) instead of
     * crashing the upload flow.
     */
    isConfigured(): boolean {
        return Boolean(this.apiKey);
    }

    /**
     * Run OCR on a PDF (or supported image) buffer. Returns the per-page
     * markdown plus a joined fullMarkdown for convenience.
     */
    async ocrDocument(fileName: string, fileBuffer: Buffer, mimeType: string = 'application/pdf'): Promise<MistralOcrResult> {
        if (!this.apiKey) {
            throw new Error('MISTRAL_API_KEY is not set');
        }

        // Step 1: upload the file to Mistral with purpose=ocr
        const uploadForm = new FormData();
        uploadForm.append('purpose', 'ocr');
        uploadForm.append('file', fileBuffer, { filename: fileName, contentType: mimeType });

        const uploadRes = await axios.post(`${MISTRAL_BASE}/files`, uploadForm, {
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                ...uploadForm.getHeaders(),
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        const fileId: string | undefined = uploadRes.data?.id;
        if (!fileId) {
            throw new Error('Mistral file upload returned no file id');
        }

        // Step 2: fetch a signed URL for the uploaded file. The OCR endpoint
        // can't read file_ids directly — it needs a URL it can fetch.
        const urlRes = await axios.get(`${MISTRAL_BASE}/files/${fileId}/url`, {
            headers: { 'Authorization': `Bearer ${this.apiKey}` },
            params: { expiry: 1 }, // 1 hour — plenty for the immediate OCR call
        });
        const signedUrl: string | undefined = urlRes.data?.url;
        if (!signedUrl) {
            throw new Error('Mistral signed URL fetch returned no url');
        }

        // Step 3: run OCR
        const ocrRes = await axios.post(
            `${MISTRAL_BASE}/ocr`,
            {
                model: this.model,
                document: {
                    type: 'document_url',
                    document_url: signedUrl,
                },
                include_image_base64: false, // we don't need rendered page images, only text
            },
            {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        const pages: MistralOcrPage[] = ocrRes.data?.pages || [];
        const fullMarkdown = pages.map(p => p.markdown || '').join('\n\n---\n\n');

        return {
            pages,
            fullMarkdown,
            model: this.model,
            pageCount: pages.length,
        };
    }
}

export const mistralService = new MistralService();
