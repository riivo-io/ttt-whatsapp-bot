/**
 * Domain types for the invoice records that cross the Dynamics seam.
 *
 * The DynamicsService read methods (getInvoiceById, getInvoiceByNumber,
 * getInvoiceLineItems) return these shapes. All OData specifics — option-set
 * integers (riivo_invoicetype === 100000000), `_value` lookup fields
 * (_ownerid_value), and `@OData.Community.Display.V1.FormattedValue`
 * annotations — are resolved inside the pure mappers below, so consumers
 * (invoiceGen.service, invoicePdf.service, whatsappProcessor) never see a raw
 * field name.
 *
 * This module has NO side-effecting imports (no axios / msal / env), so the
 * mappers are unit-testable in isolation.
 */

export type InvoiceType = 'tax' | 'accounting';

export interface InvoiceParty {
    fullName: string;
    company: string;   // consultant only; '' for the customer block
    street: string;
    suburb: string;
    province: string;
    city: string;
    country: string;
    poNumber: string;
    vatNumber: string;
}

export interface InvoiceBanking {
    accountHolder: string;
    /**
     * On the byNumber (PDF) path this is the raw icon_bank value; on the byId
     * (billing) path it is the resolved option-set label. The seam owns which —
     * the difference is a pre-existing quirk of which read fetches annotations.
     */
    bankName: string;
    accountNumber: string;
    accountType: string;
    branchNumber: string;
}

export interface InvoiceTotals {
    sarsReimbursement: number;
    totalWithInterest: number;
    vatTotal: number;
    totalInclVat: number;
}

export interface InvoiceInterestTerms {
    days30: string;
    days60: string;
    days90: string;
}

export interface InvoiceLineItem {
    description: string;
    qty: number;
    price: number;
    totalInclVat: number;
}

export interface Invoice {
    recordId: string;            // new_invoicesid (byId + byNumber paths)
    invoiceNumber: string;       // new_name
    invoiceId: string;           // ttt_invoiceid (byId path only)
    createdOn: string | null;    // createdon
    type: InvoiceType | null;    // riivo_invoicetype (byId path only)
    ownerId: string | null;      // _ownerid_value (byId path only)
    description: string;         // ttt_description (byId path only)
    discountAmount: number;      // ttt_discountamount (byId path only)
    customer: InvoiceParty;
    consultant: InvoiceParty;
    banking: InvoiceBanking;
    totals: InvoiceTotals;       // populated on the byNumber (PDF) path
    interestTerms: InvoiceInterestTerms; // populated on the byId (billing) path
}

// --- internal helpers (mirror the defaulting the old consumers applied) ----

function str(v: any): string {
    return v == null ? '' : String(v);
}

function num(v: any): number {
    if (typeof v === 'number') return v;
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : 0;
}

// Read an option-set's display label from its Dataverse formatted-value
// annotation (e.g. icon_bank -> "Capitec").
function label(row: any, field: string): string {
    return str(row?.[`${field}@OData.Community.Display.V1.FormattedValue`]);
}

const TAX_INVOICE_OPTION = 100000000; // riivo_invoicetype: 100000000=Tax, 100000001=Accounting

const EMPTY_TOTALS: InvoiceTotals = { sarsReimbursement: 0, totalWithInterest: 0, vatTotal: 0, totalInclVat: 0 };
const EMPTY_TERMS: InvoiceInterestTerms = { days30: '', days60: '', days90: '' };

// --- raw OData row -> domain mappers ---------------------------------------

/**
 * Map a getInvoiceByNumber row (no annotation header — icon_* are raw values)
 * into a domain Invoice. Keeps the `|| ''` / `|| 0` defaulting and the raw
 * numeric option-set values on the banking block.
 */
export function invoiceFromByNumberRow(row: any): Invoice {
    return {
        recordId: str(row.new_invoicesid),
        invoiceNumber: row.new_name,
        invoiceId: '',
        createdOn: row.createdon ?? null,
        type: null,
        ownerId: null,
        description: '',
        discountAmount: 0,
        customer: {
            fullName: row.riivo_customerfullname || '',
            company: '',
            street: row.riivo_customerstreet || '',
            suburb: row.riivo_customersuburb || '',
            province: row.riivo_customerprovince || '',
            city: row.riivo_customercity || '',
            country: row.riivo_customercountry || '',
            poNumber: row.riivo_customerponumber || '',
            vatNumber: row.riivo_customervatnumber || '',
        },
        consultant: {
            fullName: row.riivo_consultantfullname || '',
            company: row.riivo_consultantcompany || '',
            street: row.riivo_consultantstreet || '',
            suburb: row.riivo_consultantsuburb || '',
            province: row.riivo_consultantprovince || '',
            city: row.riivo_consultantcity || '',
            country: row.riivo_consultantcountry || '',
            poNumber: row.riivo_consultantponumber || '',
            vatNumber: row.riivo_consultantvatnumber || '',
        },
        banking: {
            accountHolder: row.icon_accountholdername || '',
            bankName: row.icon_bank || '',
            accountNumber: row.icon_accountnumber || '',
            accountType: row.icon_accounttype || '',
            branchNumber: row.icon_branchnumber || '',
        },
        totals: {
            sarsReimbursement: row.ttt_sarsreimbursement || 0,
            totalWithInterest: row.ttt_totalwithinterest || 0,
            vatTotal: row.riivo_vattotal || 0,
            totalInclVat: row.riivo_totalinclvat || 0,
        },
        interestTerms: { ...EMPTY_TERMS },
    };
}

/**
 * Map a getInvoiceById row (annotation header on — option sets carry
 * @FormattedValue) into a domain Invoice. Resolves the invoice type from the
 * option-set integer and the bank / account-type labels from their
 * annotations, matching what the old invoiceGen mapper read.
 */
export function invoiceFromByIdRow(row: any): Invoice {
    return {
        recordId: str(row.new_invoicesid),
        invoiceNumber: str(row.new_name),
        invoiceId: str(row.ttt_invoiceid),
        createdOn: row.createdon ?? null,
        type: num(row.riivo_invoicetype) === TAX_INVOICE_OPTION ? 'tax' : 'accounting',
        ownerId: row._ownerid_value ?? null,
        description: str(row.ttt_description),
        discountAmount: num(row.ttt_discountamount),
        customer: {
            fullName: str(row.riivo_customerfullname),
            company: '',
            street: str(row.riivo_customerstreet),
            suburb: str(row.riivo_customersuburb),
            province: str(row.riivo_customerprovince),
            city: str(row.riivo_customercity),
            country: str(row.riivo_customercountry),
            poNumber: str(row.riivo_customerponumber),
            vatNumber: str(row.riivo_customervatnumber),
        },
        consultant: {
            fullName: str(row.riivo_consultantfullname),
            company: str(row.riivo_consultantcompany),
            street: str(row.riivo_consultantstreet),
            suburb: str(row.riivo_consultantsuburb),
            province: str(row.riivo_consultantprovince),
            city: str(row.riivo_consultantcity),
            country: str(row.riivo_consultantcountry),
            poNumber: '',
            vatNumber: str(row.riivo_consultantvatnumber),
        },
        banking: {
            accountHolder: str(row.icon_accountholdername),
            bankName: label(row, 'icon_bank'),
            accountNumber: str(row.icon_accountnumber),
            accountType: label(row, 'icon_accounttype'),
            branchNumber: str(row.icon_branchnumber),
        },
        totals: { ...EMPTY_TOTALS },
        interestTerms: {
            days30: str(row.riivo_dayinterestamounttest),
            days60: str(row.riivo_dayinterestamount),
            days90: str(row.riivo_dayinterestamountnew),
        },
    };
}

/** Map a riivo_invoicelineitems row into a domain line item. */
export function lineItemFromRow(row: any): InvoiceLineItem {
    return {
        description: str(row.riivo_itemdescriptionfx),
        qty: num(row.riivo_qty),
        price: num(row.riivo_price),
        totalInclVat: num(row.riivo_totalinclvat),
    };
}
