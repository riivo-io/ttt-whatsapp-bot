/**
 * Smoke-test KB ingest. Embeds a hand-pasted markdown doc and runs a couple
 * of retrieval queries against it so we can verify the end-to-end pipeline
 * before plugging in the real SharePoint sync.
 *
 *   npm run kb:ingest-test
 */
import 'dotenv/config';
import { knowledgeBaseService } from '../services/knowledgeBase.service';

const TEST_DOC = `# TTT Knowledge Base — Smoke Test

This is a synthetic document used to verify the knowledge-base retrieval pipeline. The content here mirrors the kind of guidance the real KB will hold once SharePoint sync is wired up.

## SARS eFiling OTP Process

To complete the SARS One-Time Pin so TTT can access your eFiling profile:

1. Go to https://www.sarsefiling.co.za/
2. Click on "Manage Access requests".
3. Click "Yes" to South African Citizen, then fill in your ID Number and Income Tax Number. Click Submit.
4. Click on "Cellphone/Email". The OTP will be sent to you via SMS or Email.
5. Fill in the last 6 digits of the number you receive, then click Accept.

The whole process takes about two minutes. Once you've accepted, TTT will be attached as your tax practitioner and we can file on your behalf.

## Required Documents for Salaried Tax Returns

For salaried individuals, TTT typically requires the following supporting documents:

- IRP5 / IT3(a) certificates from your employer for the tax year
- IT3(b) certificates for any investment income (interest, dividends)
- Medical aid contribution certificate
- Retirement annuity contribution certificate
- Bank statements covering 1 March to end of February
- Logbook if claiming travel allowance against a company car

If you have additional income sources (rental, freelance, sole proprietor) we'll request the relevant supporting docs separately.

## Tax Return Submission Deadlines

The standard deadline for non-provisional taxpayers (most salaried individuals) is the end of October each year. Provisional taxpayers — including company directors and most self-employed people — have until late January of the following year.

Late submissions attract penalties from SARS, calculated as a percentage of the outstanding tax. Even if you can't pay, file on time to avoid the late-submission penalty.
`;

async function main() {
    console.log('Ingesting smoke-test doc...');
    const result = await knowledgeBaseService.ingestMarkdown({
        sourceId: 'smoke-test-doc-v1',
        sourceUrl: 'https://example.com/kb/smoke-test',
        title: 'TTT Smoke Test Doc',
        path: '/smoke-test',
        etag: 'smoke-test-v1',
        lastModified: new Date().toISOString(),
        markdown: TEST_DOC,
    });
    console.log('Ingest result:', result);

    const queries = [
        'How do I do the SARS OTP?',
        'What documents do I need to send for my tax return?',
        'When is the tax deadline?',
        'What is the meaning of life?',
    ];

    // For each query: print top-4 raw scores (threshold 0) so calibration is
    // visible, then show which would pass the production threshold. If the real
    // KB scores drift far from the smoke-test corpus, this surfaces it loudly.
    for (const q of queries) {
        console.log(`\nQuery: "${q}"`);
        const all = await knowledgeBaseService.retrieveContext(q, 4, 0);
        if (all.length === 0) {
            console.log('  no hits at all (RPC returned empty)');
            continue;
        }
        const prod = await knowledgeBaseService.retrieveContext(q);
        const passingIds = new Set(prod.map(h => `${h.title}|${h.heading_path}`));
        for (const h of all) {
            const passes = passingIds.has(`${h.title}|${h.heading_path}`) ? '✓' : ' ';
            console.log(`  ${passes} [${h.similarity.toFixed(3)}] ${h.heading_path || h.title}`);
        }
    }
}

main().catch(e => {
    console.error('Ingest test failed:', e);
    process.exit(1);
});
