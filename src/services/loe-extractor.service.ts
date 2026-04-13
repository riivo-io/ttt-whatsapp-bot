import OpenAI from 'openai';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Extracts structured banking-detail fields from a signed Letter of Engagement.
 *
 * Input is the markdown produced by Mistral OCR. Output is a partial set of
 * Lead-record fields ready to merge into a Dynamics PATCH payload. Any field
 * the model can't confidently extract is omitted (rather than guessed) so we
 * don't overwrite real CRM data with an OCR hallucination.
 *
 * Why OpenAI here (not Mistral or Claude)?
 *   - OpenAI is already in the stack; no new SDK / billing.
 *   - gpt-4o-mini with response_format json_object is a few-thousandths-of-a-cent call.
 *   - Mistral OCR produces text; another model interprets it. Splitting the two
 *     concerns means we can swap the OCR provider or the extractor independently.
 */

export interface LoeExtractedFields {
    bankName?: string;          // → riivo_bankname
    accountName?: string;       // → riivo_accountname
    accountNumber?: string;     // → riivo_accountnumber (kept as string to preserve leading zeros)
    accountType?: string;       // → riivo_accounttype
    branchNameCode?: string;    // → riivo_branchnamecode
}

class LoeExtractorService {
    private openai: OpenAI | null = null;

    constructor() {
        if (process.env.OPENAI_API_KEY) {
            this.openai = new OpenAI({
                apiKey: process.env.OPENAI_API_KEY,
                fetch: fetch as unknown as typeof globalThis.fetch,
            });
        }
    }

    isConfigured(): boolean {
        return Boolean(this.openai);
    }

    /**
     * Pull banking details out of OCR'd LOE markdown. Returns an empty object
     * if the model can't find the section or OpenAI is unavailable — never
     * throws, because LOE upload should not fail just because extraction did.
     */
    async extractBankingDetails(ocrMarkdown: string): Promise<LoeExtractedFields> {
        if (!this.openai) {
            console.warn('[LoeExtractor] OpenAI not configured — skipping extraction');
            return {};
        }
        if (!ocrMarkdown || ocrMarkdown.trim().length === 0) {
            return {};
        }

        const systemPrompt = `You extract banking details from a signed South African Letter of Engagement (LOE).
Return ONLY a JSON object with these exact keys (omit any key you cannot find with high confidence):
- bankName            (e.g. "FNB", "Standard Bank", "Capitec")
- accountName         (the account holder's name as written on the LOE)
- accountNumber       (digits only, kept as a string to preserve leading zeros)
- accountType         (e.g. "Cheque", "Savings", "Transmission", "Current")
- branchNameCode      (the branch name and/or universal/specific branch code as a single string, e.g. "Sandton 250655")

Rules:
- Never guess. If a field is missing, ambiguous, or unreadable, OMIT it.
- Strip currency symbols, labels, and formatting. Return raw values only.
- Account number must be the bank account number, not a customer/reference/ID number.
- Output JSON only. No prose, no markdown.`;

        try {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                response_format: { type: 'json_object' },
                temperature: 0,
                max_tokens: 400,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Extract banking details from this LOE:\n\n${ocrMarkdown}` },
                ],
            });

            const raw = response.choices[0]?.message?.content || '{}';
            const parsed = JSON.parse(raw);

            // Whitelist keys + coerce to strings, drop empties. Defends against
            // the model returning unexpected shapes (numbers for accountNumber,
            // null for unknowns, extra fields, etc).
            const out: LoeExtractedFields = {};
            const cleanString = (v: any): string | undefined => {
                if (v === null || v === undefined) return undefined;
                const s = String(v).trim();
                return s.length > 0 ? s : undefined;
            };
            const bankName = cleanString(parsed.bankName);
            const accountName = cleanString(parsed.accountName);
            const accountNumber = cleanString(parsed.accountNumber);
            const accountType = cleanString(parsed.accountType);
            const branchNameCode = cleanString(parsed.branchNameCode);
            if (bankName) out.bankName = bankName;
            if (accountName) out.accountName = accountName;
            if (accountNumber) out.accountNumber = accountNumber;
            if (accountType) out.accountType = accountType;
            if (branchNameCode) out.branchNameCode = branchNameCode;

            console.log(`[LoeExtractor] Extracted ${Object.keys(out).length} banking fields:`, Object.keys(out).join(', ') || '(none)');
            return out;
        } catch (err: any) {
            console.warn(`[LoeExtractor] Extraction failed (proceeding without it): ${err?.message || err}`);
            return {};
        }
    }
}

export const loeExtractorService = new LoeExtractorService();
