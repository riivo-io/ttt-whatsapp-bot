import OpenAI from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS = 1536;

// Chunk size targets. Rough char→token estimate (4:1) is good enough for
// chunk-shape decisions; we don't need a tokenizer in the hot path.
const TARGET_CHUNK_TOKENS = 500;
const MIN_CHUNK_TOKENS = 50;

// Embeddings API per-request limits: 300k tokens and 2048 inputs. We budget a
// sub-batch on character count, not estimated tokens, because the real token
// count is always <= the character count — so capping chars under 300k is a
// provably safe bound, where a chars/4 token estimate could undershoot 4x.
const MAX_REQUEST_CHARS = 280000;
const MAX_REQUEST_INPUTS = 2048;

export type Chunk = {
    content: string;
    headingPath: string;
    tokenCount: number;
};

class EmbeddingsService {
    private client: OpenAI | null = null;

    private getClient(): OpenAI {
        if (!this.client) {
            if (!process.env.OPENAI_API_KEY) {
                throw new Error('Missing OPENAI_API_KEY in .env');
            }
            this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        }
        return this.client;
    }

    estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    async embed(text: string): Promise<number[]> {
        const client = this.getClient();
        const response = await client.embeddings.create({
            model: EMBEDDING_MODEL,
            input: text,
        });
        return response.data[0].embedding;
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const client = this.getClient();

        // The embeddings API caps a single request at 300k tokens and 2048
        // inputs. A large doc can exceed the token cap in one shot, so pack
        // inputs into sub-batches that stay under both limits, then flatten.
        const out: number[][] = [];
        let batch: string[] = [];
        let batchChars = 0;
        const flush = async () => {
            if (batch.length === 0) return;
            const response = await client.embeddings.create({
                model: EMBEDDING_MODEL,
                input: batch,
            });
            out.push(...response.data.map(d => d.embedding));
            batch = [];
            batchChars = 0;
        };
        for (const text of texts) {
            if (batch.length > 0 && (batchChars + text.length > MAX_REQUEST_CHARS || batch.length >= MAX_REQUEST_INPUTS)) {
                await flush();
            }
            batch.push(text);
            batchChars += text.length;
        }
        await flush();
        return out;
    }

    /**
     * Markdown-aware chunker. Splits by H2/H3 headings to preserve topical
     * coherence, then packs paragraphs into ~500-token chunks within each
     * section. Each chunk carries a heading_path crumb so retrieval results
     * can show the reader where the excerpt came from.
     */
    chunkMarkdown(markdown: string, docTitle: string): Chunk[] {
        const sections: { heading: string; body: string[] }[] = [];
        let currentH2 = '';
        let currentH3 = '';

        const startSection = (heading: string) => {
            sections.push({ heading, body: [] });
        };
        startSection(docTitle);

        for (const line of markdown.split('\n')) {
            const h2 = line.match(/^##\s+(.+)$/);
            const h3 = line.match(/^###\s+(.+)$/);
            if (h2) {
                currentH2 = h2[1].trim();
                currentH3 = '';
                startSection([docTitle, currentH2].filter(Boolean).join(' / '));
            } else if (h3) {
                currentH3 = h3[1].trim();
                startSection([docTitle, currentH2, currentH3].filter(Boolean).join(' / '));
            } else {
                sections[sections.length - 1].body.push(line);
            }
        }

        const chunks: Chunk[] = [];
        for (const section of sections) {
            const body = section.body.join('\n').trim();
            if (!body) continue;

            const sectionTokens = this.estimateTokens(body);
            if (sectionTokens <= TARGET_CHUNK_TOKENS) {
                if (sectionTokens >= MIN_CHUNK_TOKENS) {
                    chunks.push({ content: body, headingPath: section.heading, tokenCount: sectionTokens });
                }
                continue;
            }

            // Section too big — pack paragraphs into chunks. Use the previous
            // paragraph as overlap so chunk boundaries don't sever sentences
            // that span a paragraph break. A single paragraph can itself blow
            // past the target (and the embedding API's hard 8192-token limit)
            // when the source has no paragraph breaks — e.g. tables or letter
            // bodies — so split oversized paragraphs down first.
            const paragraphs = body
                .split(/\n\s*\n/)
                .map(p => p.trim())
                .filter(Boolean)
                .flatMap(p => this.splitOversizedParagraph(p));
            let buf: string[] = [];
            let bufTokens = 0;
            for (const p of paragraphs) {
                const pTokens = this.estimateTokens(p);
                if (bufTokens + pTokens > TARGET_CHUNK_TOKENS && buf.length > 0) {
                    chunks.push({
                        content: buf.join('\n\n'),
                        headingPath: section.heading,
                        tokenCount: bufTokens,
                    });
                    const overlap = buf[buf.length - 1];
                    buf = [overlap, p];
                    bufTokens = this.estimateTokens(overlap) + pTokens;
                } else {
                    buf.push(p);
                    bufTokens += pTokens;
                }
            }
            if (buf.length > 0 && bufTokens >= MIN_CHUNK_TOKENS) {
                chunks.push({
                    content: buf.join('\n\n'),
                    headingPath: section.heading,
                    tokenCount: bufTokens,
                });
            }
        }

        return chunks;
    }

    /**
     * Break a single paragraph that exceeds the target chunk size into smaller
     * pieces — first on sentence boundaries, then on a hard character cap as a
     * last resort. The char cap (TARGET_CHUNK_TOKENS * 4) guarantees each piece
     * is well under the embedding API's 8192-token limit, since a token is
     * always at least one character.
     */
    private splitOversizedParagraph(paragraph: string): string[] {
        if (this.estimateTokens(paragraph) <= TARGET_CHUNK_TOKENS) return [paragraph];

        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        const packed: string[] = [];
        let buf = '';
        for (const sentence of sentences) {
            const next = buf ? `${buf} ${sentence}` : sentence;
            if (buf && this.estimateTokens(next) > TARGET_CHUNK_TOKENS) {
                packed.push(buf);
                buf = sentence;
            } else {
                buf = next;
            }
        }
        if (buf) packed.push(buf);

        // Any single sentence still over the target (no sentence breaks at all)
        // gets sliced on a fixed character window.
        const maxChars = TARGET_CHUNK_TOKENS * 4;
        return packed.flatMap(piece => {
            if (this.estimateTokens(piece) <= TARGET_CHUNK_TOKENS) return [piece];
            const slices: string[] = [];
            for (let i = 0; i < piece.length; i += maxChars) {
                slices.push(piece.slice(i, i + maxChars));
            }
            return slices;
        });
    }
}

export const embeddingsService = new EmbeddingsService();
export { EMBEDDING_MODEL, EMBEDDING_DIMS };
