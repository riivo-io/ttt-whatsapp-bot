/**
 * Which TTT Financial Group services a WhatsApp number is a client for: tax (with accounting) or insurance or both.
 *
 * Read from every active contact on the number, not only the one Tina resolved: in PROD (13 Nov 2026) 29 numbers are
 * shared by an insurance contact and a non-insurance contact, and getContactByPhone returns whichever comes first.
 *
 *  - insurance: a contact whose Client Type (riivo_clienttypenew) has Long or Short Term Insurance, or who holds an
 *    active policy (riivo_policy, status Active). 677 PROD contacts hold a policy and only 1 isn't typed insurance.
 *  - tax: a contact whose Client Type has Tax or Accounting. Accounting rides on Tina's tax side, as it always has.
 *  - a contact with no Client Type and no active policy says nothing, so the number counts as both: Tina asks when she
 *    isn't sure instead of guessing a side.
 *  - the CRM read failed: both, for the same reason. Never "tax only" by default.
 *
 * Pure. src/services/serviceRouting.service.ts reads the contacts.
 */

/** riivo_clienttypenew values (contact). */
export const CLIENT_TYPE = { TAX: 0, ACCOUNTING: 1, LONG_TERM_INSURANCE: 2, SHORT_TERM_INSURANCE: 3, FINANCIAL_ADVISORY: 4 } as const;

/** One active contact on the number, as the router needs it. */
export interface PhoneContact {
    id: string;
    /** riivo_clienttypenew values. Empty: no Client Type. */
    clientTypes: number[];
    /** How many active riivo_policy rows the contact holds. */
    activePolicies: number;
}

export interface ServiceLines {
    tax: boolean;
    insurance: boolean;
    /** False when the sides are a guess (the CRM read failed, or a contact on the number has no Client Type). */
    known: boolean;
    /**
     * The contact an insurance claim or hand-over is for: the only insurance contact on the number. Null when there is
     * none, or when several are (`insuranceAmbiguous`): Tina never picks one of two people's policies.
     */
    insuranceContactId: string | null;
    insuranceAmbiguous: boolean;
}

const isInsurance = (c: PhoneContact) =>
    c.activePolicies > 0
    || c.clientTypes.includes(CLIENT_TYPE.LONG_TERM_INSURANCE)
    || c.clientTypes.includes(CLIENT_TYPE.SHORT_TERM_INSURANCE);

const isTax = (c: PhoneContact) => c.clientTypes.includes(CLIENT_TYPE.TAX) || c.clientTypes.includes(CLIENT_TYPE.ACCOUNTING);

/** Says nothing about either side: no Client Type we route on, and no active policy. */
const isBlank = (c: PhoneContact) => !isInsurance(c) && !isTax(c);

/**
 * The sides for a number. `contacts` null: the read failed. The resolved contact is always among `contacts` when the
 * read worked (the service reads it by id as well as by number).
 */
export function serviceLinesFrom(resolvedContactId: string, contacts: PhoneContact[] | null): ServiceLines {
    if (!contacts || contacts.length === 0) {
        // Nothing known: both sides, and the resolved contact for a claim (the claims package checks its policies and
        // passes a contact with none to the Insurance and Advice team).
        return { tax: true, insurance: true, known: false, insuranceContactId: resolvedContactId, insuranceAmbiguous: false };
    }
    const insured = contacts.filter(isInsurance);
    const blank = contacts.some(isBlank);
    const tax = contacts.some(isTax) || blank;
    const insurance = insured.length > 0 || blank;
    const insuranceAmbiguous = insured.length > 1;
    const insuranceContactId = insured.length === 1
        ? insured[0].id
        // No insurance contact, but a blank one may be: the resolved contact, so a claim reaches the package's own
        // no-policy hand-over rather than nobody.
        : insured.length === 0 && blank ? resolvedContactId : null;
    return { tax, insurance, known: !blank, insuranceContactId, insuranceAmbiguous };
}

/** For the log line: "tax", "insurance", "tax+insurance", with "?" when the sides are a guess. */
export function describeLines(l: ServiceLines): string {
    const sides = [l.tax ? 'tax' : '', l.insurance ? 'insurance' : ''].filter(Boolean).join('+') || 'none';
    return `${sides}${l.known ? '' : '?'}${l.insuranceAmbiguous ? ' (several insurance contacts)' : ''}`;
}
