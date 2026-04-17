/**
 * Unit tests for the case lifecycle service.
 *
 * These cover the pure functions (qualifyMessage, detectFeedback). The
 * database-touching and LLM-touching functions (createCase, classifyCase,
 * handleFeedback, handleTimeout) are exercised end-to-end via the webhook
 * against a real Supabase + Dynamics test environment — run the server and
 * use `npm run test:webhook` + manual WhatsApp to verify those.
 *
 * Run: ts-node test/test-case-lifecycle.ts
 */

// Stub env vars so importing the service graph doesn't try to connect to
// Supabase. The service constructs a Supabase client at module load, but the
// pure functions we're testing never call it.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';
process.env.DYNAMICS_URL = process.env.DYNAMICS_URL || 'https://test.crm4.dynamics.com/';
process.env.DYNAMICS_TENANT_ID = process.env.DYNAMICS_TENANT_ID || 'test';
process.env.DYNAMICS_CLIENT_ID = process.env.DYNAMICS_CLIENT_ID || 'test';
process.env.DYNAMICS_CLIENT_SECRET = process.env.DYNAMICS_CLIENT_SECRET || 'test';

import { caseService } from '../src/services/case.service';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
    if (condition) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.error(`  ✗ ${label}`);
    }
}

console.log('\nqualifyMessage');
assert(caseService.qualifyMessage('What are the tax deadlines?') === true, 'real question qualifies');
assert(caseService.qualifyMessage('How do I upload my LOE?') === true, 'how-to qualifies');
assert(caseService.qualifyMessage('thanks') === false, '"thanks" does not qualify');
assert(caseService.qualifyMessage('ok') === false, '"ok" does not qualify');
assert(caseService.qualifyMessage('hi') === false, '"hi" does not qualify');
assert(caseService.qualifyMessage('👍') === false, 'emoji-only does not qualify');
assert(caseService.qualifyMessage('👍👏🙌') === false, 'multi-emoji does not qualify');
assert(caseService.qualifyMessage('  ') === false, 'whitespace does not qualify');
assert(caseService.qualifyMessage('hi!') === false, 'short greeting with punctuation does not qualify');
assert(caseService.qualifyMessage('') === false, 'empty string does not qualify');
assert(caseService.qualifyMessage('ab') === false, '2-char does not qualify');
assert(caseService.qualifyMessage('test') === false, '"test" does not qualify');

console.log('\ndetectFeedback');
assert(caseService.detectFeedback('Yes, thanks') === 'confirmed', '"Yes, thanks" → confirmed');
assert(caseService.detectFeedback('yes') === 'confirmed', '"yes" → confirmed');
assert(caseService.detectFeedback('Y') === 'confirmed', '"Y" → confirmed');
assert(caseService.detectFeedback('resolved') === 'confirmed', '"resolved" → confirmed');
assert(caseService.detectFeedback('sorted') === 'confirmed', '"sorted" → confirmed');
assert(caseService.detectFeedback('No, I still need help') === 'rejected', '"No, I still need help" → rejected');
assert(caseService.detectFeedback('no') === 'rejected', '"no" → rejected');
assert(caseService.detectFeedback('not really') === 'rejected', '"not really" → rejected');
assert(caseService.detectFeedback('what are the tax deadlines') === null, 'real query → null (not feedback)');
assert(caseService.detectFeedback('') === null, 'empty → null');

console.log('\n' + (failed === 0 ? `✅ All ${passed} assertions passed.` : `❌ ${failed} of ${passed + failed} assertions failed.`));
process.exit(failed === 0 ? 0 : 1);
