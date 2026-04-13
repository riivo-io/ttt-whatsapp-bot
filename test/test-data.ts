import dotenv from 'dotenv';
import { dynamicsService } from '../src/services/dynamics.service';
dotenv.config();

async function testDataRetrieval() {
    console.log('Testing CRM Data Retrieval...');

    // 1. Get Contact ID for Jules Test
    const contact = await dynamicsService.getContactByPhone('0787133880');
    if (!contact) {
        console.error('Contact not found. Ensure Jules Test exists from previous test.');
        return;
    }
    console.log(`Found Contact: ${contact.fullname} (${contact.id})`);

    // 2. Test Invoices
    console.log('\n--- Invoices ---');
    const invoices = await dynamicsService.getClientInvoices(contact.id);
    console.log(`Found ${invoices.length} invoices.`);
    if (invoices.length > 0) console.log(invoices[0]);

    // 3. Test Cases
    console.log('\n--- Cases ---');
    const cases = await dynamicsService.getClientCases(contact.id);
    console.log(`Found ${cases.length} cases.`);
    if (cases.length > 0) console.log(cases[0]);
}

testDataRetrieval();
