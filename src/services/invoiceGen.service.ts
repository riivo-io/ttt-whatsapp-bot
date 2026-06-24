console.log('[boot] invoiceGen.service: before axios');
import axios from 'axios';
import dotenv from 'dotenv';
import { Invoice, InvoiceLineItem } from '../domain/invoice';

dotenv.config();

// External invoice-gen Azure Function (PRD-bad-debt-collection.md §7.1, §11.2).
// Renders the client's official invoice PDF from the Dynamics invoice record +
// its line items. The payload shape below mirrors the production Power Automate
// flow that drives the same function, so a bad-debt reminder produces the exact
// same PDF a client receives when their invoice is first issued. The function
// key is a secret supplied via env (Azure Functions auth, passed as ?code=).
const INVOICE_GEN_URL = process.env.INVOICE_GEN_URL
    || 'https://ttt-invoice-gen.azurewebsites.net/api/invoice-generator';
const INVOICE_GEN_CODE = process.env.INVOICE_GEN_CODE || '';

function str(v: any): string {
    return v == null ? '' : String(v);
}

// Match the flow's number formatting: round to 2dp and stringify (drops the
// trailing-zero noise so 650.0 -> "650", 97.5 -> "97.5").
function money(n: number): string {
    return String(Math.round(n * 100) / 100);
}

export interface ConsultantBanking {
    accountNumber: string;
    accountHolder: string;
    branchNumber: string;
}

/**
 * Build the invoice-gen API request body from a domain Invoice (getInvoiceById),
 * its line items (getInvoiceLineItems), and — for Tax invoices — the owning
 * consultant's banking (getConsultantBanking). Shape matches the production
 * Power Automate flow exactly. OData specifics (option-set type, formatted bank
 * labels) are already resolved by the seam; this reads domain fields only.
 */
export function buildInvoiceGenPayload(
    invoice: Invoice,
    lineItems: InvoiceLineItem[],
    consultantBanking: ConsultantBanking | null,
): Record<string, any> {
    const isTax = invoice.type === 'tax';

    // The flow excludes any line item literally described as "discount" and
    // applies the invoice discount to the totals instead.
    const items = (lineItems || []).filter(
        li => li.description.trim().toLowerCase() !== 'discount'
    );

    const grossSubtotal = items.reduce((s, li) => s + li.qty * li.price, 0);
    const discount = Math.trunc(invoice.discountAmount);
    const netBase = grossSubtotal - discount;
    const vat = netBase * 0.15;
    const total = netBase + vat;

    // Tax: account from consultant systemuser; Accounting: from the invoice.
    const banking = isTax
        ? {
            bank_name: invoice.banking.bankName,
            account_number: str(consultantBanking?.accountNumber),
            account_holder: str(consultantBanking?.accountHolder),
            branch_code: str(consultantBanking?.branchNumber),
            account_type: invoice.banking.accountType,
        }
        : {
            bank_name: invoice.banking.bankName,
            account_number: invoice.banking.accountNumber,
            account_holder: invoice.banking.accountHolder,
            branch_code: invoice.banking.branchNumber,
            account_type: invoice.banking.accountType,
        };

    return {
        header: {
            invoice_number: str(invoice.invoiceId || invoice.invoiceNumber),
            date: invoice.createdOn || null,
            type: isTax ? 'Tax' : 'Accounting',
        },
        customer: {
            name: invoice.customer.fullName,
            street: invoice.customer.street,
            city: invoice.customer.city,
            suburb: invoice.customer.suburb,
            province: invoice.customer.province,
            country: invoice.customer.country,
            po_number: invoice.customer.poNumber,
            vat_number: invoice.customer.vatNumber,
        },
        consultant: {
            name: invoice.consultant.fullName,
            company: invoice.consultant.company,
            street: invoice.consultant.street,
            city: invoice.consultant.city,
            suburb: invoice.consultant.suburb,
            province: invoice.consultant.province,
            country: invoice.consultant.country,
            vat_number: invoice.consultant.vatNumber,
        },
        totals: {
            subtotal: money(grossSubtotal),
            discount: String(discount),
            vat: money(vat),
            total: money(total),
        },
        terms: {
            days30: invoice.interestTerms.days30,
            days60: invoice.interestTerms.days60,
            days90: invoice.interestTerms.days90,
        },
        banking,
        notes: invoice.description,
        line_items: items.map(li => ({
            description: li.description,
            qty: li.qty,
            price: li.price,
            total: li.totalInclVat,
        })),
    };
}

export class InvoiceGenService {
    /** True when the function key is configured — gates the live send. */
    isConfigured(): boolean {
        return !!INVOICE_GEN_CODE;
    }

    /**
     * POST a prebuilt payload (buildInvoiceGenPayload) to the invoice-gen Azure
     * Function and return the rendered PDF as a Buffer, or null on any failure
     * (missing config, non-2xx, non-PDF body, network error). The caller treats
     * null as "fall back to the text payment ask" (§10) — this never throws.
     */
    async generateInvoicePdf(payload: Record<string, any>): Promise<Buffer | null> {
        const invoiceNumber = payload?.header?.invoice_number || 'unknown';
        if (!INVOICE_GEN_CODE) {
            console.warn('[InvoiceGen] INVOICE_GEN_CODE not configured — skipping PDF generation (text fallback will be used)');
            return null;
        }

        try {
            const url = `${INVOICE_GEN_URL}?code=${encodeURIComponent(INVOICE_GEN_CODE)}`;
            const response = await axios.post(url, payload, {
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/pdf' },
                responseType: 'arraybuffer',
                timeout: 30_000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });

            const buffer = Buffer.from(response.data);
            // Guard against a 200 that's actually a JSON error body, not a PDF.
            if (buffer.length < 100 || buffer.subarray(0, 4).toString('latin1') !== '%PDF') {
                const preview = buffer.subarray(0, 200).toString('utf8');
                console.error(`[InvoiceGen] response was not a PDF (len=${buffer.length}): ${preview}`);
                return null;
            }
            console.log(`[InvoiceGen] generated PDF for invoice ${invoiceNumber} (${buffer.length} bytes)`);
            return buffer;
        } catch (error: any) {
            const errMsg = error?.response?.status ? `HTTP ${error.response.status}` : (error?.message || 'unknown error');
            console.error(`[InvoiceGen] PDF generation failed for invoice ${invoiceNumber}: ${errMsg}`);
            return null;
        }
    }
}

export const invoiceGenService = new InvoiceGenService();
