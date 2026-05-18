import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

console.log('[boot] loe-extractor.service: imports done');
dotenv.config();
console.log('[boot] loe-extractor.service: dotenv configured');

/**
 * Extracts structured banking-detail fields from a signed Letter of Engagement.
 *
 * Input is the markdown produced by Mistral OCR. Output is a partial set of
 * Lead-record fields ready to merge into a Dynamics PATCH payload. Any field
 * the model can't confidently extract is omitted (rather than guessed) so we
 * don't overwrite real CRM data with an OCR hallucination.
 *
 * Implementation: the extractor runs on Claude with a single forced tool —
 * Anthropic's recommended pattern for reliable JSON output (no
 * `response_format: json_object` equivalent; forcing a specific tool
 * guarantees schema-validated input in the response).
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

const EXTRACTOR_MODEL = 'claude-haiku-4-5-20251001';

const EXTRACT_TOOL: Anthropic.Tool = {
    name: 'record_loe_fields',
    description: 'Record the fields extracted from a signed Letter of Engagement. Only populate a field if you can read its value with high confidence — omit any field that is missing, ambiguous, or illegible. Never guess.',
    input_schema: {
        type: 'object',
        properties: {
            // Client details
            clientFirstName: { type: 'string', description: "The client's first name only." },
            clientLastName: { type: 'string', description: "The client's last name / surname only." },
            idNumber: { type: 'string', description: '13-digit South African ID number, as a string.' },
            incomeTaxNumber: { type: 'string', description: 'Income tax / SARS tax reference number, as a string.' },
            physicalAddress: { type: 'string', description: 'Full physical address as a single string.' },
            emailAddress: { type: 'string', description: 'Email address.' },
            contactNumber: { type: 'string', description: 'Phone / mobile number, as a string.' },
            industry: { type: 'string', description: 'The industry/occupation written on the form.' },
            // Banking details
            bankName: { type: 'string', description: 'E.g. "FNB", "Standard Bank", "Capitec", "Discovery".' },
            accountName: { type: 'string', description: "The account holder's name as written on the LOE." },
            accountNumber: { type: 'string', description: 'Digits only, kept as a string to preserve leading zeros. Must be the bank account number, not a customer/reference/ID number.' },
            accountType: { type: 'string', description: 'E.g. "Cheque", "Savings", "Transmission", "Current".' },
            branchNameCode: { type: 'string', description: 'The branch name and/or universal/specific branch code as a single string, e.g. "679000".' },
            // Signing details
            signedAt: { type: 'string', description: 'The location/city where the CLIENT signed, e.g. "Roosevelt Park, Johannesburg" (NOT a date).' },
            signedAtConsultant: { type: 'string', description: 'The location/city where the CONSULTANT signed (NOT a date).' },
            signedDate: { type: 'string', description: 'The date the LOE was signed, in ISO format YYYY-MM-DD (e.g. "2026-01-01"). Parse from "On this ___ day of ___ 20___".' },
        },
    },
};

class LoeExtractorService {
    private anthropic: Anthropic | null = null;

    constructor() {
        if (process.env.ANTHROPIC_API_KEY) {
            this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        }
    }

    isConfigured(): boolean {
        return Boolean(this.anthropic);
    }

    /**
     * Pull structured details out of OCR'd LOE markdown. Returns an empty
     * object if the model can't find the section or Claude is unavailable —
     * never throws, because LOE upload should not fail just because
     * extraction did.
     */
    async extractBankingDetails(ocrMarkdown: string): Promise<LoeExtractedFields> {
        if (!this.anthropic) {
            console.warn('[LoeExtractor] Claude not configured — skipping extraction');
            return {};
        }
        if (!ocrMarkdown || ocrMarkdown.trim().length === 0) {
            return {};
        }

        const systemPrompt = `You extract details from a signed South African Letter of Engagement (LOE) for TTT Tax Services. Call the record_loe_fields tool exactly once with every field you can read with high confidence. Omit any field that is missing, ambiguous, or unreadable — never guess. Strip currency symbols, labels, and formatting. signedAt / signedAtConsultant are CITY NAMES, not dates. signedDate is an ISO date string (YYYY-MM-DD), not a location. accountNumber must be the bank account number, not a reference/ID number.`;

        try {
            const response = await this.anthropic.messages.create({
                model: EXTRACTOR_MODEL,
                max_tokens: 1000,
                system: systemPrompt,
                messages: [
                    { role: 'user', content: `Extract all details from this LOE and record them via the tool:\n\n${ocrMarkdown}` },
                ],
                tools: [EXTRACT_TOOL],
                tool_choice: { type: 'tool', name: 'record_loe_fields' },
            });

            const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
            const parsed: any = toolUse?.input ?? {};
            console.log(`[LoeExtractor] Tool input keys: ${Object.keys(parsed).join(', ') || '(none)'}`);

            const out: LoeExtractedFields = {};
            const cleanString = (v: any): string | undefined => {
                if (v === null || v === undefined) return undefined;
                const s = String(v).trim();
                return s.length > 0 ? s : undefined;
            };
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
