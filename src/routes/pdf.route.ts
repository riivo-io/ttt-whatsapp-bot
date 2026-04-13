import { Router, Request, Response } from 'express';
import { dynamicsService } from '../services/dynamics.service';
import { pdfService, InvoiceData, mapInvoiceToInvoiceData } from '../services/pdf.service';

const router = Router();

// Generate and serve invoice PDF
router.get('/invoice/:invoiceNumber', async (req: Request, res: Response): Promise<void> => {
    try {
        const { invoiceNumber } = req.params;

        if (!invoiceNumber) {
            res.status(400).json({ error: 'Invoice number is required' });
            return;
        }

        console.log(`[PDF Route] Generating PDF for invoice: ${invoiceNumber}`);

        // Fetch invoice from Dynamics
        const invoice = await dynamicsService.getInvoiceByNumber(invoiceNumber);

        if (!invoice) {
            res.status(404).json({ error: `Invoice ${invoiceNumber} not found` });
            return;
        }

        // Map Dynamics data to InvoiceData via the shared helper so /api/pdf
        // and the OpenAI tool handlers can't drift apart when fields change.
        const invoiceData: InvoiceData = mapInvoiceToInvoiceData(invoice);

        // Generate PDF
        const pdfBuffer = await pdfService.generateInvoicePDF(invoiceData);

        console.log(`[PDF Route] Generated PDF for ${invoiceNumber} (${pdfBuffer.length} bytes)`);

        // Send PDF as download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${invoiceNumber}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);

    } catch (error: any) {
        console.error('[PDF Route] Error:', error.message);
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

export default router;
