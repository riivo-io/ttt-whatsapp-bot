/**
 * Sync TTT's SharePoint Tax Navigator folder into the Supabase knowledge base.
 * Diff-based: docs whose etag matches the cached value are skipped, changed
 * docs are re-embedded, and docs deleted from SharePoint are removed locally.
 *
 *   npm run sync:kb
 */
import 'dotenv/config';
import { knowledgeBaseService } from '../services/knowledgeBase.service';

async function main() {
    const startedAt = Date.now();
    console.log('Starting knowledge base sync from SharePoint...\n');
    const result = await knowledgeBaseService.syncFromSharePoint();

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\nSync complete in ${elapsed}s:`);
    console.log(`  Total files seen:           ${result.total}`);
    console.log(`  Newly ingested / changed:   ${result.ingested}`);
    console.log(`  Skipped (etag unchanged):   ${result.skipped}`);
    console.log(`  Deleted (gone from source): ${result.deleted}`);
    if (result.failed.length > 0) {
        console.log(`  FAILED: ${result.failed.length}`);
        for (const f of result.failed) {
            console.log(`    - ${f.name}: ${f.error}`);
        }
        process.exitCode = 1;
    }
}

main().catch(e => {
    console.error('Sync failed:', e?.message || e);
    process.exit(1);
});
