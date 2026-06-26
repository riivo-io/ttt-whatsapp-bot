/**
 * Produces the OFFICIAL client invoice PDF — the one rendered by the external
 * invoice-gen Azure Function (INVOICE_GEN_URL / INVOICE_GEN_CODE), identical to
 * what a client receives when their invoice is first issued and to what the
 * bad-debt reminder sends. This is the ONLY invoice PDF the bot should ever hand
 * out; the legacy pdfkit renderer produced a different (wrong) document.
 *
 * Orchestration mirrors the bad-debt path in whatsappProcessor.ts: fetch the
 * full invoice record + its line items (+ the owning consultant's banking for
 * Tax invoices), build the invoice-gen payload, and render. Reached via the
 * PdfPort by both get_invoice_pdf (client self-serve) and send_invoice_pdf
 * (staff), so the two share one code path and can't drift apart.
 */
import { dynamicsService } from './dynamics.service';
import { invoiceGenService, buildInvoiceGenPayload } from './invoiceGen.service';

/**
 * Render the official PDF for an invoice record GUID. Returns null when the
 * record can't be loaded or the generator fails (e.g. INVOICE_GEN_CODE missing,
 * non-2xx, non-PDF body) — callers surface that as an error rather than falling
 * back to a different document.
 */
export async function generateOfficialInvoicePdf(recordId: string): Promise<Buffer | null> {
    if (!recordId) return null;

    const [record, lineItems] = await Promise.all([
        dynamicsService.getInvoiceById(recordId),
        dynamicsService.getInvoiceLineItems(recordId),
    ]);
    if (!record) return null;

    // Tax invoices draw the bank account off the owning consultant.
    const consultantBanking = (record.type === 'tax' && record.ownerId)
        ? await dynamicsService.getConsultantBanking(record.ownerId)
        : null;

    const payload = buildInvoiceGenPayload(record, lineItems, consultantBanking);
    return invoiceGenService.generateInvoicePdf(payload);
}
