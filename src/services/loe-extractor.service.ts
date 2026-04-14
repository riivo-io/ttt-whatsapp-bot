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
    // Banking details
    bankName?: string;              // → riivo_bankname
    accountName?: string;           // → riivo_accountname
    accountNumber?: string;         // → riivo_accountnumber (kept as string to preserve leading zeros)
    accountType?: string;           // → riivo_accounttype
    branchNameCode?: string;        // → riivo_branchnamecode
    // Signing details
    signedAt?: string;              // → riivo_signedat (where the client signed, e.g. "Cape Town")
    signedAtConsultant?: string;    // → riivo_signedatconsultant (where the consultant signed)
    signedDate?: string;            // → riivo_loesubmissiondate (ISO date string, e.g. "2026-01-01")
    // Client details from the LOE form
    clientFirstName?: string;       // → ttt_firstname
    clientLastName?: string;        // → ttt_lastname
    idNumber?: string;              // → ttt_idnumber
    incomeTaxNumber?: string;       // → riivo_incometaxnumber
    physicalAddress?: string;       // → riivo_address1street1
    emailAddress?: string;          // → ttt_email
    contactNumber?: string;         // → ttt_mobilephone
    industry?: string;              // → riivo_industry (plain text, not the lookup)
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

        const systemPrompt = `You extract ALL visible details from a signed South African Letter of Engagement (LOE) for TTT Tax Services.

Return ONLY a JSON object with these exact keys (omit any key you cannot find with high confidence):

CLIENT DETAILS (from the "Client details" section at the top):
- clientFirstName     (the client's first name only)
- clientLastName      (the client's last name / surname only)
- idNumber            (13-digit South African ID number, as a string)
- incomeTaxNumber     (income tax / SARS tax reference number, as a string)
- physicalAddress     (full physical address as a single string)
- emailAddress        (email address)
- contactNumber       (phone / mobile number, as a string)
- industry            (the industry/occupation written on the form)

BANKING DETAILS (from the "Client banking details" section):
- bankName            (e.g. "FNB", "Standard Bank", "Capitec", "Discovery")
- accountName         (the account holder's name as written on the LOE)
- accountNumber       (digits only, kept as a string to preserve leading zeros)
- accountType         (e.g. "Cheque", "Savings", "Transmission", "Current")
- branchNameCode      (the branch name and/or universal/specific branch code as a single string, e.g. "679000")

SIGNING DETAILS (from the "Acceptance of Engagement" section at the bottom):
- signedAt            (the location/city where the CLIENT signed, e.g. "Roosevelt Park, Johannesburg". Usually after "Signed at:")
- signedAtConsultant  (the location/city where the CONSULTANT signed, if present)
- signedDate          (the date the LOE was signed, in ISO format YYYY-MM-DD. Parse from "On this ___ day of ___ 20___")

Rules:
- Never guess. If a field is missing, ambiguous, or unreadable, OMIT it.
- Strip currency symbols, labels, and formatting. Return raw values only.
- Account number must be the bank account number, not a customer/reference/ID number.
- signedAt and signedAtConsultant are LOCATIONS (city names), NOT dates.
- signedDate is a DATE in ISO format (e.g. "2026-01-01"), NOT a location.
- For handwritten text that is hard to read, do your best but omit if truly illegible.
- Output JSON only. No prose, no markdown.`;

        try {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                response_format: { type: 'json_object' },
                temperature: 0,
                max_tokens: 1000,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Extract ALL details (client, banking, and signing) from this LOE. Return a FLAT JSON object — do NOT nest fields under category keys. Every key must be at the top level.\n\n${ocrMarkdown}` },
                ],
            });

            const raw = response.choices[0]?.message?.content || '{}';
            console.log(`[LoeExtractor] Raw LLM response: ${raw.slice(0, 1000)}${raw.length > 1000 ? '...' : ''}`);
            let parsed = JSON.parse(raw);

            // The model sometimes nests fields under category keys like
            // "BANKING DETAILS": { bankName: ... }. Flatten one level deep
            // so our key lookup works regardless of nesting structure.
            const flat: Record<string, any> = {};
            for (const [key, val] of Object.entries(parsed)) {
                if (val && typeof val === 'object' && !Array.isArray(val)) {
                    for (const [innerKey, innerVal] of Object.entries(val as Record<string, any>)) {
                        flat[innerKey] = innerVal;
                    }
                } else {
                    flat[key] = val;
                }
            }
            parsed = flat;

            const out: LoeExtractedFields = {};
            const cleanString = (v: any): string | undefined => {
                if (v === null || v === undefined) return undefined;
                const s = String(v).trim();
                return s.length > 0 ? s : undefined;
            };
            // Map every known key, coerce to string, drop empties.
            const fieldKeys: (keyof LoeExtractedFields)[] = [
                'bankName', 'accountName', 'accountNumber', 'accountType',
                'branchNameCode', 'signedAt', 'signedAtConsultant', 'signedDate',
                'clientFirstName', 'clientLastName', 'idNumber', 'incomeTaxNumber',
                'physicalAddress', 'emailAddress', 'contactNumber', 'industry',
            ];
            for (const key of fieldKeys) {
                const val = cleanString(parsed[key]);
                if (val) (out as any)[key] = val;
            }

            console.log(`[LoeExtractor] Extracted ${Object.keys(out).length} fields:`, Object.keys(out).join(', ') || '(none)');
            return out;
        } catch (err: any) {
            console.warn(`[LoeExtractor] Extraction failed (proceeding without it): ${err?.message || err}`);
            return {};
        }
    }
}

export const loeExtractorService = new LoeExtractorService();
