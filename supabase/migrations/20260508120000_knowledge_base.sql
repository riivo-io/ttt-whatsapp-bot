-- =============================================================================
-- Knowledge base — pgvector tables + similarity search RPC
-- =============================================================================
-- Stores chunked, embedded markdown sourced from TTT's SharePoint KB so the
-- bot can ground client answers in TTT's own documentation.
--
-- One row per source doc in kb_documents, many chunks per doc in kb_chunks.
-- Chunks carry a 1536-dim embedding (OpenAI text-embedding-3-small). Lookup
-- is done via the match_kb_chunks() RPC, which returns the top-k chunks
-- above a cosine-similarity threshold.
-- =============================================================================

create extension if not exists vector;

create table if not exists kb_documents (
    id uuid primary key default gen_random_uuid(),
    source_id text unique not null,
    source_url text not null,
    title text not null,
    path text,
    etag text,
    last_modified timestamptz,
    ingested_at timestamptz not null default now()
);

create index if not exists kb_documents_source_id_idx on kb_documents (source_id);

create table if not exists kb_chunks (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references kb_documents(id) on delete cascade,
    chunk_index integer not null,
    content text not null,
    heading_path text,
    embedding vector(1536) not null,
    token_count integer
);

create index if not exists kb_chunks_document_id_idx on kb_chunks (document_id);

-- HNSW index for cosine similarity. m=16 / ef_construction=64 are pgvector
-- defaults — fine for our scale. Switch to ivfflat if we ever exceed the
-- HNSW build-memory budget on Supabase.
create index if not exists kb_chunks_embedding_hnsw_idx
    on kb_chunks
    using hnsw (embedding vector_cosine_ops);

-- Returns the top match_count chunks whose cosine similarity to the query
-- embedding clears match_threshold. Similarity is reported as 1 - distance
-- so callers can apply an intuitive ">= 0.7" check.
create or replace function match_kb_chunks(
    query_embedding vector(1536),
    match_threshold float,
    match_count integer
)
returns table (
    chunk_id uuid,
    document_id uuid,
    content text,
    heading_path text,
    title text,
    source_url text,
    similarity float
)
language sql
stable
as $$
    select
        c.id as chunk_id,
        c.document_id,
        c.content,
        c.heading_path,
        d.title,
        d.source_url,
        1 - (c.embedding <=> query_embedding) as similarity
    from kb_chunks c
    join kb_documents d on d.id = c.document_id
    where 1 - (c.embedding <=> query_embedding) >= match_threshold
    order by c.embedding <=> query_embedding
    limit match_count;
$$;
