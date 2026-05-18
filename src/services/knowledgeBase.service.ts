console.log('[boot] knowledgeBase.service: before supabase');
import { supabaseService } from './supabase.service';
console.log('[boot] knowledgeBase.service: before embeddings');
import { embeddingsService } from './embeddings.service';
console.log('[boot] knowledgeBase.service: before sharepoint');
import { sharePointService } from './sharepoint.service';
console.log('[boot] knowledgeBase.service: before docExtractor');
import { docExtractorService } from './docExtractor.service';
console.log('[boot] knowledgeBase.service: imports done');

export type KbChunkHit = {
    content: string;
    heading_path: string | null;
    title: string;
    source_url: string;
    similarity: number;
};

export type IngestInput = {
    sourceId: string;
    sourceUrl: string;
    title: string;
    path?: string;
    etag?: string;
    lastModified?: string;
    markdown: string;
};

export type IngestResult = { skipped: boolean; chunksIngested: number };

export type SyncResult = {
    total: number;
    ingested: number;
    skipped: number;
    deleted: number;
    failed: { name: string; error: string }[];
};

class KnowledgeBaseService {
    /**
     * Embed the query and return the top-k chunks above the similarity
     * threshold. Returns [] when nothing clears the bar — callers should
     * treat that as "no grounding available, answer from base knowledge."
     * Errors are caught and logged so a KB outage never blocks a reply.
     *
     * Threshold default 0.42 calibrated against text-embedding-3-small on the
     * smoke-test corpus: real Q→passage matches landed at 0.51–0.61, off-topic
     * noise at 0.10, and the highest "wrong but related" secondary hit at 0.40.
     * 0.42 cleanly separates signal from noise without dropping real hits.
     */
    async retrieveContext(query: string, k: number = 3, threshold: number = 0.42): Promise<KbChunkHit[]> {
        try {
            const queryEmbedding = await embeddingsService.embed(query);
            const hits = await supabaseService.matchKbChunks(queryEmbedding, threshold, k);
            return hits;
        } catch (e: any) {
            console.warn('[KB] retrieveContext failed:', e?.message || e);
            return [];
        }
    }

    /**
     * Upsert a doc. If the etag matches the existing record we no-op,
     * otherwise the doc is re-chunked, re-embedded, and old chunks are
     * replaced atomically.
     */
    async ingestMarkdown(opts: IngestInput): Promise<IngestResult> {
        const existing = await supabaseService.findKbDocument(opts.sourceId);
        if (existing && opts.etag && existing.etag === opts.etag) {
            console.log(`[KB] Skipping "${opts.title}" — etag unchanged`);
            return { skipped: true, chunksIngested: 0 };
        }

        const chunks = embeddingsService.chunkMarkdown(opts.markdown, opts.title);
        if (chunks.length === 0) {
            console.warn(`[KB] No chunks produced for "${opts.title}"`);
            return { skipped: false, chunksIngested: 0 };
        }

        const embeddings = await embeddingsService.embedBatch(chunks.map(c => c.content));

        const documentId = await supabaseService.upsertKbDocument({
            source_id: opts.sourceId,
            source_url: opts.sourceUrl,
            title: opts.title,
            path: opts.path ?? null,
            etag: opts.etag ?? null,
            last_modified: opts.lastModified ?? null,
        });

        await supabaseService.replaceKbChunks(
            documentId,
            chunks.map((c, i) => ({
                chunk_index: i,
                content: c.content,
                heading_path: c.headingPath,
                embedding: embeddings[i],
                token_count: c.tokenCount,
            }))
        );

        console.log(`[KB] Ingested "${opts.title}": ${chunks.length} chunks`);
        return { skipped: false, chunksIngested: chunks.length };
    }

    /**
     * Pull every file from the configured SharePoint KB folder, extract
     * markdown from PDFs and Word docs, and reconcile the Supabase index.
     * One file's failure doesn't abort the run — failures are collected
     * and returned to the caller for display.
     *
     * Reconciliation: docs that disappeared from SharePoint between syncs
     * are deleted locally so the index stays clean. Cascading FK on
     * kb_chunks removes their embeddings.
     */
    async syncFromSharePoint(): Promise<SyncResult> {
        const files = await sharePointService.listKbFiles();
        const seenSourceIds = new Set(files.map(f => f.id));

        let ingested = 0;
        let skipped = 0;
        const failed: { name: string; error: string }[] = [];

        for (const file of files) {
            try {
                const buffer = await sharePointService.downloadFile(file.id);
                const extracted = await docExtractorService.extract({
                    buffer,
                    mimeType: file.mimeType,
                    filename: file.name,
                });

                if (!extracted) {
                    console.log(`[KB Sync] Skipping unsupported type: ${file.name} (${file.mimeType})`);
                    skipped++;
                    continue;
                }

                for (const w of extracted.warnings) {
                    console.warn(`[KB Sync] ${file.name}: ${w}`);
                }

                if (!extracted.markdown.trim()) {
                    console.warn(`[KB Sync] ${file.name}: extractor returned empty content — skipping`);
                    skipped++;
                    continue;
                }

                const titleNoExt = file.name.replace(/\.(pdf|docx|doc)$/i, '');

                const result = await this.ingestMarkdown({
                    sourceId: file.id,
                    sourceUrl: file.webUrl,
                    title: titleNoExt,
                    path: file.parentPath || undefined,
                    etag: file.etag,
                    lastModified: file.lastModified,
                    markdown: extracted.markdown,
                });

                if (result.skipped) {
                    skipped++;
                } else {
                    ingested++;
                }
            } catch (e: any) {
                console.error(`[KB Sync] Failed ${file.name}:`, e?.message || e);
                failed.push({ name: file.name, error: e?.message || String(e) });
            }
        }

        const existingIds = await supabaseService.listKbDocumentSourceIds();
        const removed = existingIds.filter(id => !seenSourceIds.has(id));
        let deleted = 0;
        for (const id of removed) {
            try {
                await supabaseService.deleteKbDocumentBySourceId(id);
                deleted++;
            } catch (e: any) {
                console.error(`[KB Sync] Failed to delete ${id}:`, e?.message || e);
            }
        }

        console.log(`[KB Sync] Done: ingested=${ingested} skipped=${skipped} deleted=${deleted} failed=${failed.length}`);
        return { total: files.length, ingested, skipped, deleted, failed };
    }
}

export const knowledgeBaseService = new KnowledgeBaseService();
