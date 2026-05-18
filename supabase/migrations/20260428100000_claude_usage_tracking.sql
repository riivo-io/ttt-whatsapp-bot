-- =============================================================================
-- Claude API usage + cost tracking
-- =============================================================================
-- One row per Anthropic messages.create call. Cost is computed at insert time
-- from the pricing tier passed in by the application, so historical rows stay
-- correct when Anthropic changes prices later.
--
-- Per-session message and token totals are separately tracked on the sessions
-- table for cheap cap enforcement (no aggregate query on every turn).
-- =============================================================================

create table if not exists claude_usage (
    id uuid primary key default gen_random_uuid(),
    session_id uuid references sessions(id) on delete set null,
    phone_number text,
    role text,                                  -- 'client' | 'staff' | 'unknown'
    model text not null,
    call_purpose text not null,                 -- 'main' | 'tool_loop' | 'intent_classify'
    input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    cache_creation_tokens integer not null default 0,
    cache_read_tokens integer not null default 0,
    cost_usd numeric(12, 8) not null default 0,
    created_at timestamptz not null default now()
);

create index if not exists claude_usage_session_id_idx on claude_usage (session_id);
create index if not exists claude_usage_phone_number_idx on claude_usage (phone_number);
create index if not exists claude_usage_created_at_idx on claude_usage (created_at);
create index if not exists claude_usage_model_idx on claude_usage (model);

-- Daily roll-up view for dashboards. Keeps the per-call detail intact while
-- giving cheap reads for "how much did we spend yesterday".
create or replace view claude_usage_daily as
select
    date_trunc('day', created_at) as day,
    phone_number,
    role,
    model,
    count(*) as call_count,
    sum(input_tokens) as input_tokens,
    sum(output_tokens) as output_tokens,
    sum(cache_creation_tokens) as cache_creation_tokens,
    sum(cache_read_tokens) as cache_read_tokens,
    sum(cost_usd) as cost_usd
from claude_usage
group by 1, 2, 3, 4;

-- Cheap cap counters on the session itself. Avoids a sum() per turn just to
-- decide whether the user has hit the message/token limit.
alter table sessions
    add column if not exists message_count integer not null default 0,
    add column if not exists token_count bigint not null default 0,
    add column if not exists cap_blocked_at timestamptz;

-- Atomic counter bump. Called from logClaudeUsage so concurrent turns from
-- the same session can't lose a write under read-modify-write.
create or replace function increment_session_usage(p_session_id uuid, p_tokens integer)
returns void
language sql
as $$
    update sessions
       set message_count = coalesce(message_count, 0) + 1,
           token_count   = coalesce(token_count, 0) + p_tokens
     where id = p_session_id;
$$;
