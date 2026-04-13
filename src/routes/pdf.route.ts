import { Router, Request, Response } from 'express';
import { dynamicsService } from '../services/dynamics.service';
import { pdfService, InvoiceData } from '../services/pdf.service';

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

        // Map Dynamics data to InvoiceData
        const invoiceData: InvoiceData = {
            invoiceNumber: invoice.new_name,
            invoiceDate: new Date(invoice.createdon).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }),
            consultantName: invoice.riivo_consultantfullname || '',
            customerFullname: invoice.riivo_customerfullname || '',
            customerStreet: invoice.riivo_customerstreet || '',
            customerSuburb: invoice.riivo_customersuburb || '',
            customerProvince: invoice.riivo_customerprovince || '',
            customerCity: invoice.riivo_customercity || '',
            customerCountry: invoice.riivo_customercountry || '',
            customerPostalCode: invoice.riivo_customerponumber || '',
            customerVatNumber: invoice.riivo_customervatnumber || '',
            consultantCompany: invoice.riivo_consultantcompany || '',
            consultantStreet: invoice.riivo_consultantstreet || '',
            consultantSuburb: invoice.riivo_consultantsuburb || '',
            consultantProvince: invoice.riivo_consultantprovince || '',
            consultantCity: invoice.riivo_consultantcity || '',
            consultantCountry: invoice.riivo_consultantcountry || '',
            consultantPostalCode: invoice.riivo_consultantponumber || '',
            consultantVatNumber: invoice.riivo_consultantvatnumber || '',
            sarsReimbursement: invoice.ttt_sarsreimbursement || 0,
            subtotal: invoice.ttt_totalwithinterest || 0,
            vatAmount: invoice.riivo_vattotal || 0,
            totalInclVat: invoice.riivo_totalinclvat || 0,
            accountHolderName: invoice.icon_accountholdername || '',
            bankName: invoice.icon_bank || '',
            accountNumber: invoice.icon_accountnumber || '',
            accountType: invoice.icon_accounttype || '',
            branchNumber: invoice.icon_branchnumber || ''
        };

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
