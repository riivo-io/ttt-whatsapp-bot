import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { RateLimitError } from '../utils/anthropicRateLimit';

console.log('[boot] irp5-extractor.service: imports done');
dotenv.config();
console.log('[boot] irp5-extractor.service: dotenv configured');

/**
 * Extracts structured fields from an OCR'd South African IRP5 / IT3(a).
 *
 * Companion to the LOE extractor (src/services/loe-extractor.service.ts).
 * Same pattern: Mistral OCR's markdown is passed to Claude with a single
 * forced tool whose schema mirrors the field-mapping doc
 * (docs/irp5-ocr-field-mapping.md). The output is shaped to write directly
 * onto a `riivo_irp5s` row plus the SARS source codes seen on the cert,
 * which drive the downstream "what else do I need?" advice engine.
 *
 * Aggregation rules (e.g. 3702 + 3703 → riivo_reimbursedtravelallowance)
 * are applied deterministically in TS rather than asked of the model — the
 * model just reads off per-code amounts so any rule change is a one-line
 * code edit, not a prompt rev.
 */

/** Per-SARS-code amount as the model reads it off the cert. */
type CodeAmounts = Partial<Record<string, number>>;

export interface Irp5ExtractedFields {
    // Fields ready to PATCH onto a riivo_irp5s row. Keys match the
    // Dataverse logical column names so the caller can spread them straight
    // into the create payload. Banking fields are deliberately NOT included
    // — those live on the contact via the LOE flow.
    riivoFields: Record<string, any>;
    /**
     * Every 4-digit SARS code spotted on the certificate, deduped. Drives
     * `requiredDocuments.computeMissingDocsForClient`. Includes codes that
     * don't have a dedicated riivo_irp5s field (e.g. 3696, 3697) — the
     * advice engine cares about them even when the CRM doesn't store them.
     */
    sourceCodes: string[];
    /** Employer trading name, for the WhatsApp acknowledgement copy. */
    employerName?: string;
    /** Assessment year integer as written on the cert (e.g. 2026). */
    assessmentYear?: number;
    /** Certificate number — used for dedupe by the caller. */
    certificateNumber?: string;
}

const EXTRACTOR_MODEL = 'claude-haiku-4-5-20251001';

const EXTRACT_TOOL: Anthropic.Tool = {
    name: 'record_irp5_fields',
    description: 'Record the fields extracted from a South African IRP5 / IT3(a) employee tax certificate. Only populate a field if you can read its value with high confidence — omit any field that is missing, ambiguous, or illegible. Never guess. Amounts must be parsed as numbers (strip "R", commas, and spaces). Dates must be ISO YYYY-MM-DD.',
    input_schema: {
        type: 'object',
        properties: {
            // ----- Header / identity -----
            certificateNumber: { type: 'string', description: 'IRP5 "Certificate Number" exactly as printed.' },
            employerTradingName: { type: 'string', description: "Employer's Trading or Other Name." },
            idNumber: { type: 'string', description: '13-digit SA employee ID number, as a string.' },
            dateOfBirth: { type: 'string', description: 'Employee date of birth, ISO YYYY-MM-DD.' },
            incomeTaxRefNo: { type: 'string', description: "Employee's Income Tax Reference Number as a string." },
            cityTown: { type: 'string', description: "Employer's address — city/town." },
            suburbDistrict: { type: 'string', description: "Employer's address — suburb/district." },
            typeOfCertificate: { type: 'string', description: '"IRP5", "IT3(a)", or similar verbatim from the cert.' },
            reconciliationPeriod: { type: 'string', description: 'Reconciliation period code as a string, e.g. "02" or "08".' },
            assessmentYear: { type: 'integer', description: 'Year of assessment as an integer, e.g. 2026 for 1 Mar 2025–28 Feb 2026.' },
            taxPeriodStartDate: { type: 'string', description: '"Period of Reconciliation: From" as ISO YYYY-MM-DD.' },
            taxPeriodEndDate: { type: 'string', description: '"Period of Reconciliation: To" as ISO YYYY-MM-DD.' },
            noOfPeriodsWorked: { type: 'number', description: '"Number of Periods Worked" as a decimal number.' },
            reasonForNonDeductionOfTax: { type: 'string', description: 'Value next to code 4150 (reason for no PAYE), if present.' },

            // ----- Per-SARS-code amounts -----
            // Names are deliberately the 4-digit codes so the schema is easy
            // to extend when SARS adds a new line. Aggregation into the
            // riivo_irp5s columns happens deterministically below.
            codeAmounts: {
                type: 'object',
                description: 'Map of 4-digit SARS code → amount in Rands (as a number). Include every code that appears on the cert with a value, regardless of whether it has a dedicated field. Example: { "3601": 350000, "3606": 120000, "4102": 84500 }.',
                additionalProperties: { type: 'number' },
            },
            grossTaxableIncome: { type: 'number', description: 'Total of all taxable income codes, as printed (the cert usually shows this explicitly).' },
            grossNonTaxableIncome: { type: 'number', description: 'Total of all non-taxable income codes, if shown on the cert.' },
            totalDeductionsContributions: { type: 'number', description: 'Total of all deduction / contribution codes, as printed on the cert.' },

            // ----- Source codes seen -----
            sourceCodes: {
                type: 'array',
                items: { type: 'string' },
                description: 'Every 4-digit SARS code visible on the certificate, deduped. Include codes that appear without amounts (e.g. a line that prints "3696 0.00" still counts as 3696 being present).',
            },
        },
    },
};

/**
 * Source-code → riivo_irp5s column mapping per docs/irp5-ocr-field-mapping.md.
 * Multiple codes can target the same column — the values are summed.
 */
const CODE_TO_COLUMN: Record<string, string> = {
    '3601': 'riivo_incomepaye',
    '3605': 'riivo_annualpaymentpaye',
    '3606': 'riivo_commissionpaye',
    '3615': 'riivo_incomepaye',
    '3701': 'riivo_taxabletravelremuneration',
    '3702': 'riivo_reimbursedtravelallowance',
    '3703': 'riivo_reimbursedtravelallowance',
    '3704': 'riivo_nontaxablesubsistenceallowance',
    '3713': 'riivo_otherallowancespaye',
    '3715': 'riivo_nontaxablesubsistenceallowance',
    '3721': 'riivo_employeedebt',
    '3801': 'riivo_generalbenefits',
    '3802': 'riivo_useofmotorvehiclepaye',
    '3816': 'riivo_useofmotorvehiclepaye',
    '3810': 'riivo_medicalaidemployercontributions',
    '3817': 'riivo_employerpensioncontributionpaye',
    '3825': 'riivo_employerprovidentfundcontributions',
    // Lump-sum codes all roll into the single lump-sum column.
    '3907': 'riivo_payeonlumpsumbenefit',
    '3908': 'riivo_payeonlumpsumbenefit',
    '3915': 'riivo_payeonlumpsumbenefit',
    '3920': 'riivo_payeonlumpsumbenefit',
    '3921': 'riivo_payeonlumpsumbenefit',
    '3922': 'riivo_payeonlumpsumbenefit',
    // Deductions
    '4001': 'riivo_totalpensionfundcontributions',
    '4003': 'riivo_totalprovidentfundcontributions',
    '4005': 'riivo_medicalaidcontributions',
    '4006': 'riivo_racontributions',
    '4030': 'riivo_currentarrearprovidentfundcontributions',
    '4102': 'riivo_payeamount',
    '4116': 'riivo_medicalschemetaxcredit',
    '4141': 'riivo_uifcontribution',
    '4142': 'riivo_sdlcontribution',
    '4149': 'riivo_totaltaxsdlanduif',
    '4584': 'riivo_bargainingcouncilcontributionpaye',
    // 4474 is the deduction-side mirror of 3810; per the mapping doc we only
    // populate via 3810 to avoid double-counting.
};

/**
 * "Generic taxable fringe benefit" bucket — any 38xx code we don't map to
 * a dedicated column lands in riivo_generalfringebenefitspaye.
 */
function isGenericFringeBenefitCode(code: string): boolean {
    return /^38\d{2}$/.test(code) && !CODE_TO_COLUMN[code];
}

class Irp5ExtractorService {
    private anthropic: Anthropic | null = null;

    constructor() {
        if (process.env.ANTHROPIC_API_KEY) {
            this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
        }
    }

    isConfigured(): boolean {
        return Boolean(this.anthropic);
    }

    /**
     * Pull structured details out of OCR'd IRP5 markdown. Returns empty
     * fields (and an empty sourceCodes list) if Claude is unavailable or
     * the OCR is blank — never throws (other than RateLimitError, which
     * propagates so the worker can re-enqueue).
     */
    async extractIrp5Fields(ocrMarkdown: string): Promise<Irp5ExtractedFields> {
        const empty: Irp5ExtractedFields = { riivoFields: {}, sourceCodes: [] };

        if (!this.anthropic) {
            console.warn('[Irp5Extractor] Claude not configured — skipping extraction');
            return empty;
        }
        if (!ocrMarkdown || ocrMarkdown.trim().length === 0) {
            return empty;
        }

        const systemPrompt = `You extract fields from a South African IRP5 or IT3(a) tax certificate for TTT Tax Services. Call record_irp5_fields exactly once. Read amounts as numbers in Rands (strip "R", commas, spaces). Dates are ISO YYYY-MM-DD. Omit any field you cannot read with high confidence — never guess. Populate codeAmounts with every 4-digit SARS code that has a number on the cert, and list every visible 4-digit code in sourceCodes (whether it had an amount or not).`;

        try {
            const response = await this.anthropic.messages.create({
                model: EXTRACTOR_MODEL,
                max_tokens: 2000,
                system: systemPrompt,
                messages: [
                    { role: 'user', content: `Extract all fields from this IRP5 and record them via the tool:\n\n${ocrMarkdown}` },
                ],
                tools: [EXTRACT_TOOL],
                tool_choice: { type: 'tool', name: 'record_irp5_fields' },
            });

            const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
            const parsed: any = toolUse?.input ?? {};
            console.log(`[Irp5Extractor] Tool input keys: ${Object.keys(parsed).join(', ') || '(none)'}`);

            return this.shapeResult(parsed);
        } catch (err: any) {
            const status = err?.status ?? err?.response?.status;
            if (status === 429) {
                const retryAfterHeader = err?.headers?.['retry-after'] ?? err?.response?.headers?.['retry-after'];
                const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : 60;
                const retryAfterMs = Math.max(1, Math.floor((Number.isFinite(retryAfterSec) ? retryAfterSec : 60) * 1000));
                throw new RateLimitError(retryAfterMs, 1, err);
            }
            console.warn(`[Irp5Extractor] Extraction failed (proceeding without it): ${err?.message || err}`);
            return empty;
        }
    }

    /**
     * Translate the model's raw tool input into a riivo_irp5s-shaped payload
     * plus the source-code list. Header fields map 1:1; per-code amounts
     * roll up per CODE_TO_COLUMN with same-column codes summed.
     */
    private shapeResult(parsed: any): Irp5ExtractedFields {
        const fields: Record<string, any> = {};

        const setString = (col: string, val: any): void => {
            if (val === null || val === undefined) return;
            const s = String(val).trim();
            if (s.length > 0) fields[col] = s;
        };
        const setNumber = (col: string, val: any): void => {
            const n = typeof val === 'number' ? val : parseFloat(String(val ?? '').replace(/[, ]/g, ''));
            if (Number.isFinite(n)) fields[col] = n;
        };

        // ----- Header -----
        setString('riivo_certificatenumber', parsed.certificateNumber);
        setString('riivo_name', parsed.employerTradingName);
        setString('riivo_employertradingothername', parsed.employerTradingName);
        setString('riivo_idnumber', parsed.idNumber);
        if (parsed.dateOfBirth) setString('riivo_dateofbirth', parsed.dateOfBirth);
        setString('riivo_incometaxrefno', parsed.incomeTaxRefNo);
        setString('riivo_citytown', parsed.cityTown);
        setString('riivo_suburbdistrict', parsed.suburbDistrict);
        // Per the mapping doc, irp5type + typeofcertificate are populated
        // from the same source until we learn whether one of them is an
        // optionset; keep them in sync here.
        if (parsed.typeOfCertificate) {
            setString('riivo_typeofcertificate', parsed.typeOfCertificate);
            setString('riivo_irp5type', parsed.typeOfCertificate);
        }
        setString('riivo_reconciliationperiod', parsed.reconciliationPeriod);
        if (Number.isInteger(parsed.assessmentYear)) {
            fields['riivo_assessmentyearint'] = parsed.assessmentYear;
            fields['riivo_assessmentyearstring'] = String(parsed.assessmentYear);
        }
        if (parsed.taxPeriodStartDate) setString('riivo_taxperiodstartdate', parsed.taxPeriodStartDate);
        if (parsed.taxPeriodEndDate) setString('riivo_taxperiodenddate', parsed.taxPeriodEndDate);
        setNumber('riivo_noofperiodsworked', parsed.noOfPeriodsWorked);
        setString('riivo_reasonfornondeductionoftax', parsed.reasonForNonDeductionOfTax);

        // ----- Roll up per-code amounts -----
        const codeAmounts: CodeAmounts = (parsed.codeAmounts && typeof parsed.codeAmounts === 'object')
            ? parsed.codeAmounts
            : {};
        const seenCodes = new Set<string>();
        for (const [rawCode, rawAmount] of Object.entries(codeAmounts)) {
            const code = String(rawCode).trim();
            if (!/^\d{4}$/.test(code)) continue;
            seenCodes.add(code);
            const amount = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount).replace(/[, ]/g, ''));
            if (!Number.isFinite(amount)) continue;
            const col = CODE_TO_COLUMN[code] ?? (isGenericFringeBenefitCode(code) ? 'riivo_generalfringebenefitspaye' : null);
            if (!col) continue;
            fields[col] = ((fields[col] as number) || 0) + amount;
        }

        // ----- Roll-up totals printed on the cert -----
        setNumber('riivo_grosstaxableincome', parsed.grossTaxableIncome);
        setNumber('riivo_grossnontaxableincome', parsed.grossNonTaxableIncome);
        setNumber('riivo_totaldeductionscontributions', parsed.totalDeductionsContributions);

        // ----- Source-code list -----
        const declared: string[] = Array.isArray(parsed.sourceCodes) ? parsed.sourceCodes.map(String) : [];
        const sourceCodes = Array.from(new Set([...declared, ...Array.from(seenCodes)].filter(c => /^\d{4}$/.test(c))));

        console.log(`[Irp5Extractor] Mapped ${Object.keys(fields).length} riivo fields, ${sourceCodes.length} source codes: ${sourceCodes.join(', ') || '(none)'}`);

        return {
            riivoFields: fields,
            sourceCodes,
            employerName: typeof parsed.employerTradingName === 'string' ? parsed.employerTradingName.trim() || undefined : undefined,
            assessmentYear: Number.isInteger(parsed.assessmentYear) ? parsed.assessmentYear : undefined,
            certificateNumber: typeof parsed.certificateNumber === 'string' ? parsed.certificateNumber.trim() || undefined : undefined,
        };
    }
}

export const irp5ExtractorService = new Irp5ExtractorService();

/**
 * Inverse of CODE_TO_COLUMN — reads a stored `riivo_irp5s` row back to a
 * list of source codes that must have been present on the original cert.
 * Used by the upload tool to union the just-extracted codes with prior
 * IRP5s for the same year (multi-employer flow). Approximate: codes that
 * share a column all "claim" presence when that column is non-zero, but
 * the advice map keys all share docs (e.g. 3702/3703 both → logbook +
 * fuel slips) so the over-claim is harmless.
 */
export function inferSourceCodesFromIrp5Row(row: Record<string, any>): string[] {
    const codes = new Set<string>();
    for (const [code, col] of Object.entries(CODE_TO_COLUMN)) {
        const v = row?.[col];
        if (typeof v === 'number' && v !== 0) codes.add(code);
    }
    return Array.from(codes);
}
