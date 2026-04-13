import PDFDocument from 'pdfkit';

export interface InvoiceData {
    // Invoice Header
    invoiceNumber: string;
    invoiceDate: string;
    consultantName: string;

    // Customer Details
    customerFullname: string;
    customerStreet: string;
    customerSuburb: string;
    customerProvince: string;
    customerCity: string;
    customerCountry: string;
    customerPostalCode: string;
    customerVatNumber: string;

    // Consultant Details
    consultantCompany: string;
    consultantStreet: string;
    consultantSuburb: string;
    consultantProvince: string;
    consultantCity: string;
    consultantCountry: string;
    consultantPostalCode: string;
    consultantVatNumber: string;

    // Line Items
    sarsReimbursement: number;

    // Totals
    subtotal: number;
    vatAmount: number;
    totalInclVat: number;

    // Banking Details
    accountHolderName: string;
    bankName: string;
    accountNumber: string;
    accountType: string;
    branchNumber: string;
}

export class PDFService {
    private readonly PRIMARY_COLOR = '#0077B6'; // TTT Blue
    private readonly PAGE_WIDTH = 595;
    private readonly MARGIN = 50;

    /**
     * Generate an invoice PDF and return as a Buffer
     */
    generateInvoicePDF(invoice: InvoiceData): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            try {
                const doc = new PDFDocument({ size: 'A4', margin: this.MARGIN });
                const chunks: Buffer[] = [];

                doc.on('data', (chunk) => chunks.push(chunk));
                doc.on('end', () => resolve(Buffer.concat(chunks)));
                doc.on('error', reject);

                // Generate content
                this.drawHeader(doc, invoice);
                this.drawCustomerConsultantSection(doc, invoice);
                this.drawLineItemsTable(doc, invoice);
                this.drawTotalsSection(doc, invoice);
                this.drawLatePaymentNotice(doc, invoice);
                this.drawBankingDetails(doc, invoice);
                this.drawFooter(doc);

                doc.end();
            } catch (error) {
                reject(error);
            }
        });
    }

    private drawHeader(doc: PDFKit.PDFDocument, invoice: InvoiceData): void {
        // Blue header bar
        doc.rect(0, 0, this.PAGE_WIDTH, 20).fill(this.PRIMARY_COLOR);

        doc.moveDown(2);

        // Title
        doc.fontSize(20).fillColor('#000').font('Helvetica-Bold')
            .text('TAX INVOICE', this.MARGIN, 50);

        // TTT Association text
        doc.fontSize(10).fillColor('#666').font('Helvetica')
            .text('in association with TTT Financial Group', this.PAGE_WIDTH - 200, 50, { width: 150, align: 'right' });

        // Invoice details
        doc.fontSize(10).fillColor('#000').font('Helvetica');
        doc.text(`Invoice number: ${invoice.invoiceNumber}`, this.MARGIN, 80);
        doc.text(`Invoice date: ${invoice.invoiceDate}`, this.MARGIN, 95);
        doc.text(`Consultant: ${invoice.consultantName}`, this.MARGIN, 110);
    }

    private drawCustomerConsultantSection(doc: PDFKit.PDFDocument, invoice: InvoiceData): void {
        const y = 150;

        // Customer Details
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#000')
            .text('CUSTOMER DETAILS', this.MARGIN, y);

        doc.fontSize(10).font('Helvetica').fillColor('#333');
        let customerY = y + 20;
        doc.text(invoice.customerFullname, this.MARGIN, customerY);
        if (invoice.customerStreet) { customerY += 15; doc.text(invoice.customerStreet, this.MARGIN, customerY); }
        if (invoice.customerSuburb) { customerY += 15; doc.text(invoice.customerSuburb, this.MARGIN, customerY); }
        if (invoice.customerProvince) { customerY += 15; doc.text(invoice.customerProvince, this.MARGIN, customerY); }
        if (invoice.customerCity) { customerY += 15; doc.text(invoice.customerCity, this.MARGIN, customerY); }
        if (invoice.customerCountry) { customerY += 15; doc.text(invoice.customerCountry, this.MARGIN, customerY); }
        if (invoice.customerPostalCode) { customerY += 15; doc.text(invoice.customerPostalCode, this.MARGIN, customerY); }

        // Consultant Details (right side)
        const rightX = 350;
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#000')
            .text('CONSULTANT DETAILS', rightX, y, { width: 200, align: 'right' });

        doc.fontSize(10).font('Helvetica').fillColor('#333');
        let consultantY = y + 20;
        doc.text(invoice.consultantCompany || '', rightX, consultantY, { width: 200, align: 'right' });
        if (invoice.consultantStreet) { consultantY += 15; doc.text(invoice.consultantStreet, rightX, consultantY, { width: 200, align: 'right' }); }
        if (invoice.consultantSuburb) { consultantY += 15; doc.text(invoice.consultantSuburb, rightX, consultantY, { width: 200, align: 'right' }); }
        if (invoice.consultantProvince) { consultantY += 15; doc.text(invoice.consultantProvince, rightX, consultantY, { width: 200, align: 'right' }); }
        if (invoice.consultantCity) { consultantY += 15; doc.text(invoice.consultantCity, rightX, consultantY, { width: 200, align: 'right' }); }
        if (invoice.consultantCountry) { consultantY += 15; doc.text(invoice.consultantCountry, rightX, consultantY, { width: 200, align: 'right' }); }
        if (invoice.consultantVatNumber) { consultantY += 15; doc.text(invoice.consultantVatNumber, rightX, consultantY, { width: 200, align: 'right' }); }
    }

    private drawLineItemsTable(doc: PDFKit.PDFDocument, invoice: InvoiceData): void {
        const y = 320;

        // Payment reference note
        doc.fontSize(10).fillColor(this.PRIMARY_COLOR).font('Helvetica')
            .text('Please use your name as a reference when paying.', this.MARGIN, y - 20);

        // Table header
        const tableY = y + 10;
        doc.rect(this.MARGIN, tableY, this.PAGE_WIDTH - 2 * this.MARGIN, 25).fill(this.PRIMARY_COLOR);

        doc.fontSize(10).font('Helvetica-Bold').fillColor('#fff');
        doc.text('Product', this.MARGIN + 10, tableY + 7);
        doc.text('Unit Price', 280, tableY + 7);
        doc.text('Quantity', 380, tableY + 7);
        doc.text('Total', 480, tableY + 7);

        // Line items
        let itemY = tableY + 35;
        doc.fillColor('#000').font('Helvetica');

        // SARS Reimbursement line item (10% of value)
        if (invoice.sarsReimbursement > 0) {
            const sarsLineValue = invoice.sarsReimbursement * 0.1;
            doc.text('SARS Reimbursement (10%)', this.MARGIN + 10, itemY);
            doc.text(`R${sarsLineValue.toFixed(2)}`, 280, itemY);
            doc.text('1', 400, itemY);
            doc.text(`R${sarsLineValue.toFixed(2)}`, 480, itemY);
            itemY += 30;
        }

        // Divider line
        doc.strokeColor('#ccc').lineWidth(0.5)
            .moveTo(this.MARGIN, itemY + 10).lineTo(this.PAGE_WIDTH - this.MARGIN, itemY + 10).stroke();
    }

    private drawTotalsSection(doc: PDFKit.PDFDocument, invoice: InvoiceData): void {
        const y = 450;
        const rightX = 400;

        doc.fontSize(10).font('Helvetica').fillColor('#000');
        doc.text('Subtotal', rightX, y);
        doc.text(`R${invoice.subtotal.toFixed(2)}`, 480, y);

        doc.text('VAT (15%)', rightX, y + 20);
        doc.text(`R${invoice.vatAmount.toFixed(2)}`, 480, y + 20);

        doc.font('Helvetica-Bold');
        doc.text('Total Owing', rightX, y + 45);
        doc.text(`R${invoice.totalInclVat.toFixed(2)}`, 480, y + 45);
    }

    private drawLatePaymentNotice(doc: PDFKit.PDFDocument, invoice: InvoiceData): void {
        const y = 520;

        doc.fontSize(9).font('Helvetica').fillColor('#666')
            .text('Please note that this invoice is now due, and that interest may be charged as indicated below should timeous payment not be made', this.MARGIN, y, { width: 500 });

        // Late payment table
        const tableY = y + 25;
        doc.rect(this.MARGIN, tableY, 150, 25).fill(this.PRIMARY_COLOR);
        doc.rect(this.MARGIN + 150, tableY, 150, 25).fill('#C62828');
        doc.rect(this.MARGIN + 300, tableY, 150, 25).fill('#B71C1C');

        doc.fontSize(10).font('Helvetica-Bold').fillColor('#fff');
        doc.text('>30 days', this.MARGIN + 50, tableY + 7);
        doc.text('>60 days', this.MARGIN + 200, tableY + 7);
        doc.text('>90 days', this.MARGIN + 350, tableY + 7);

        // Interest amounts (2% per 30 days)
        const interest30 = invoice.totalInclVat * 1.02;
        const interest60 = invoice.totalInclVat * 1.04;
        const interest90 = invoice.totalInclVat * 1.06;

        doc.fillColor('#000').font('Helvetica');
        doc.text(`R${interest30.toFixed(2)}`, this.MARGIN + 50, tableY + 35);
        doc.text(`R${interest60.toFixed(2)}`, this.MARGIN + 200, tableY + 35);
        doc.text(`R${interest90.toFixed(2)}`, this.MARGIN + 350, tableY + 35);
    }

    private drawBankingDetails(doc: PDFKit.PDFDocument, invoice: InvoiceData): void {
        const y = 620;

        doc.fontSize(11).font('Helvetica-Bold').fillColor('#000')
            .text('ADDITIONAL NOTES', this.MARGIN, y);

        doc.fontSize(11).font('Helvetica-Bold')
            .text('BANKING DETAILS', this.MARGIN, y + 30);

        doc.fontSize(10).font('Helvetica').fillColor('#333');
        const details = [
            ['Account holder name', invoice.accountHolderName],
            ['Bank name', invoice.bankName],
            ['Account number', invoice.accountNumber],
            ['Branch code', invoice.branchNumber],
            ['Account type', invoice.accountType]
        ];

        let detailY = y + 50;
        details.forEach(([label, value]) => {
            doc.text(label, this.MARGIN, detailY);
            doc.text(value || '', 400, detailY, { width: 150, align: 'right' });
            detailY += 18;
        });
    }

    private drawFooter(doc: PDFKit.PDFDocument): void {
        const y = 780;

        // Blue footer bar
        doc.rect(0, y, this.PAGE_WIDTH, 40).fill('#f5f5f5');

        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000')
            .text('THANK YOU FOR YOUR BUSINESS!', 0, y + 12, { width: this.PAGE_WIDTH, align: 'center' });
    }
}

export const pdfService = new PDFService();
