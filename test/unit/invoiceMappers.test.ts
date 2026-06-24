/**
 * Characterization tests for the two invoice mappers that sit on the consumer
 * side of the Dynamics seam:
 *   - mapInvoiceToInvoiceData  (pdf.service)      — getInvoiceByNumber -> InvoiceData
 *   - buildInvoiceGenPayload   (invoiceGen.service) — getInvoiceById + line items -> API payload
 *
 * These lock the EXACT output of both mappers so the candidate-1 refactor
 * (raw OData rows -> domain Invoice type, mappers consume the domain type) can
 * be proven behaviour-preserving. The fixtures are representative raw OData
 * rows; the expected literals are the current production output.
 *
 * Post-refactor the inputs are routed through the pure raw->domain mappers in
 * src/domain/invoice.ts, but the expected literals stay byte-for-byte identical.
 *
 * Run: npm test
 */

// Determinism: mapInvoiceToInvoiceData formats createdon via toLocaleDateString,
// which is timezone-sensitive. Pin TZ before any Date use so the rendered date
// is stable regardless of where the suite runs.
process.env.TZ = 'Africa/Johannesburg';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapInvoiceToInvoiceData } from '../../src/services/pdf.service';
import { buildInvoiceGenPayload } from '../../src/services/invoiceGen.service';
import {
    invoiceFromByNumberRow,
    invoiceFromByIdRow,
    lineItemFromRow,
} from '../../src/domain/invoice';

// ---------------------------------------------------------------------------
// Fixtures — representative RAW OData rows
// ---------------------------------------------------------------------------

// getInvoiceByNumber shape (no annotation header — icon_* are raw values).
const rawByNumber = {
    new_name: 'Jules Test - INV522385182',
    createdon: '2026-06-11T12:00:00Z',
    riivo_consultantfullname: 'Sarah Consultant',
    riivo_customerfullname: 'Jules Customer',
    riivo_customerstreet: '12 Main Rd',
    riivo_customersuburb: 'Claremont',
    riivo_customerprovince: 'Western Cape',
    riivo_customercity: 'Cape Town',
    riivo_customercountry: 'South Africa',
    riivo_customerponumber: '7708',
    riivo_customervatnumber: 'VAT123',
    riivo_consultantcompany: 'TTT Financial Group',
    riivo_consultantstreet: '1 Office Park',
    riivo_consultantsuburb: 'Sandton',
    riivo_consultantprovince: 'Gauteng',
    riivo_consultantcity: 'Johannesburg',
    riivo_consultantcountry: 'South Africa',
    riivo_consultantponumber: '2196',
    riivo_consultantvatnumber: 'VAT999',
    ttt_sarsreimbursement: 1000,
    ttt_totalwithinterest: 1150,
    riivo_vattotal: 150,
    riivo_totalinclvat: 1150,
    icon_accountholdername: 'TTT Financial Group',
    icon_bank: 100000001,
    icon_accountnumber: '1234567890',
    icon_accounttype: 100000002,
    icon_branchnumber: '250655',
};

const expectedInvoiceData = {
    invoiceNumber: 'Jules Test - INV522385182',
    invoiceDate: '11 Jun 2026',
    consultantName: 'Sarah Consultant',
    customerFullname: 'Jules Customer',
    customerStreet: '12 Main Rd',
    customerSuburb: 'Claremont',
    customerProvince: 'Western Cape',
    customerCity: 'Cape Town',
    customerCountry: 'South Africa',
    customerPostalCode: '7708',
    customerVatNumber: 'VAT123',
    consultantCompany: 'TTT Financial Group',
    consultantStreet: '1 Office Park',
    consultantSuburb: 'Sandton',
    consultantProvince: 'Gauteng',
    consultantCity: 'Johannesburg',
    consultantCountry: 'South Africa',
    consultantPostalCode: '2196',
    consultantVatNumber: 'VAT999',
    sarsReimbursement: 1000,
    subtotal: 1150,
    vatAmount: 150,
    totalInclVat: 1150,
    accountHolderName: 'TTT Financial Group',
    bankName: 100000001,
    accountNumber: '1234567890',
    accountType: 100000002,
    branchNumber: '250655',
};

// getInvoiceById shape (annotation header on — option sets carry @FormattedValue).
const rawByIdTax = {
    new_invoicesid: 'inv-guid-1',
    new_name: 'Jules Test - INV522385182',
    ttt_invoiceid: 'INV522385182',
    createdon: '2026-06-11T12:00:00Z',
    _ownerid_value: 'owner-guid',
    riivo_invoicetype: 100000000,
    'riivo_invoicetype@OData.Community.Display.V1.FormattedValue': 'Tax',
    ttt_discountamount: 50,
    ttt_description: 'Tax services 2025',
    riivo_dayinterestamounttest: '1173',
    riivo_dayinterestamount: '1196',
    riivo_dayinterestamountnew: '1219',
    riivo_customerfullname: 'Jules Customer',
    riivo_customerstreet: '12 Main Rd',
    riivo_customercity: 'Cape Town',
    riivo_customersuburb: 'Claremont',
    riivo_customerprovince: 'Western Cape',
    riivo_customercountry: 'South Africa',
    riivo_customerponumber: '7708',
    riivo_customervatnumber: 'VAT123',
    riivo_consultantfullname: 'Sarah Consultant',
    riivo_consultantcompany: 'TTT Financial Group',
    riivo_consultantstreet: '1 Office Park',
    riivo_consultantcity: 'Johannesburg',
    riivo_consultantsuburb: 'Sandton',
    riivo_consultantprovince: 'Gauteng',
    riivo_consultantcountry: 'South Africa',
    riivo_consultantvatnumber: 'VAT999',
    icon_bank: 100000001,
    'icon_bank@OData.Community.Display.V1.FormattedValue': 'Capitec',
    icon_accountnumber: '1234567890',
    icon_accountholdername: 'TTT Financial Group',
    icon_accounttype: 100000002,
    'icon_accounttype@OData.Community.Display.V1.FormattedValue': 'Cheque',
    icon_branchnumber: '250655',
};

const rawLineItems = [
    { riivo_itemdescriptionfx: 'Tax return preparation', riivo_qty: 1, riivo_price: 1000, riivo_totalinclvat: 1150 },
    // Literal "Discount" line is excluded by the mapper; ttt_discountamount drives totals instead.
    { riivo_itemdescriptionfx: 'Discount', riivo_qty: 1, riivo_price: -100, riivo_totalinclvat: -115 },
];

const consultantBanking = { accountNumber: 'C-9999', accountHolder: 'Sarah Consultant', branchNumber: '470010' };

const expectedTaxPayload = {
    header: { invoice_number: 'INV522385182', date: '2026-06-11T12:00:00Z', type: 'Tax' },
    customer: {
        name: 'Jules Customer',
        street: '12 Main Rd',
        city: 'Cape Town',
        suburb: 'Claremont',
        province: 'Western Cape',
        country: 'South Africa',
        po_number: '7708',
        vat_number: 'VAT123',
    },
    consultant: {
        name: 'Sarah Consultant',
        company: 'TTT Financial Group',
        street: '1 Office Park',
        city: 'Johannesburg',
        suburb: 'Sandton',
        province: 'Gauteng',
        country: 'South Africa',
        vat_number: 'VAT999',
    },
    totals: { subtotal: '1000', discount: '50', vat: '142.5', total: '1092.5' },
    terms: { days30: '1173', days60: '1196', days90: '1219' },
    banking: {
        bank_name: 'Capitec',
        account_number: 'C-9999',
        account_holder: 'Sarah Consultant',
        branch_code: '470010',
        account_type: 'Cheque',
    },
    notes: 'Tax services 2025',
    line_items: [{ description: 'Tax return preparation', qty: 1, price: 1000, total: 1150 }],
};

// Accounting variant — exercises the non-tax banking branch (account drawn off
// the invoice's icon_* fields, not the consultant systemuser).
const rawByIdAccounting = {
    ...rawByIdTax,
    riivo_invoicetype: 100000001,
    'riivo_invoicetype@OData.Community.Display.V1.FormattedValue': 'Accounting',
};

const expectedAccountingBanking = {
    bank_name: 'Capitec',
    account_number: '1234567890',
    account_holder: 'TTT Financial Group',
    branch_code: '250655',
    account_type: 'Cheque',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('mapInvoiceToInvoiceData: raw byNumber row -> InvoiceData (via domain Invoice)', () => {
    const out = mapInvoiceToInvoiceData(invoiceFromByNumberRow(rawByNumber));
    assert.deepStrictEqual(out, expectedInvoiceData);
});

test('buildInvoiceGenPayload: tax invoice -> consultant banking + discounted totals', () => {
    const out = buildInvoiceGenPayload(
        invoiceFromByIdRow(rawByIdTax),
        rawLineItems.map(lineItemFromRow),
        consultantBanking,
    );
    assert.deepStrictEqual(out, expectedTaxPayload);
});

test('buildInvoiceGenPayload: accounting invoice -> banking off the invoice record', () => {
    const out = buildInvoiceGenPayload(
        invoiceFromByIdRow(rawByIdAccounting),
        rawLineItems.map(lineItemFromRow),
        null,
    );
    assert.deepStrictEqual(out.banking, expectedAccountingBanking);
    assert.equal(out.header.type, 'Accounting');
});
