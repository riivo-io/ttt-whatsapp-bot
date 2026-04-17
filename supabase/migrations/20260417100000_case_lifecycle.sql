-- =============================================================================
-- WhatsApp case lifecycle
-- =============================================================================
-- Introduces the whatsapp_cases table that tracks every qualifying inbound
-- client query through its lifecycle: qualify → classify (L1/escalation) →
-- bot-respond → confirm/timeout/escalate. Powers the Q2 metrics (WhatsApp
-- Client Adoption and L1 Auto-Resolution).
--
-- Also adds sessions.pending_case_id so the next inbound message after a
-- feedback prompt can be routed straight to handleFeedback without re-query.
-- =============================================================================

create table if not exists whatsapp_cases (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references sessions(id) on delete cascade,
    crm_case_id text,                       -- Dynamics case GUID once mirrored
    contact_id text not null,               -- CRM contact/lead GUID
    phone_number text not null,
    query_text text not null,
    is_qualified boolean not null default true,
    level text,                             -- 'L1' | 'escalation'
    level_topic text,                       -- enum string (see case.service.ts)
    status text not null default 'created', -- created | classified | bot_responded | resolved_by_bot | resolved_by_bot_timeout | escalated
    resolution_method text,                 -- tool name or data source used to resolve
    feedback_received text,                 -- 'confirmed' | 'rejected' | 'timeout'
    resolved_at timestamptz,
    escalated_to text,                      -- consultant user id
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists whatsapp_cases_session_id_idx on whatsapp_cases (session_id);
create index if not exists whatsapp_cases_contact_id_idx on whatsapp_cases (contact_id);
create index if not exists whatsapp_cases_status_idx on whatsapp_cases (status);
create index if not exists whatsapp_cases_level_idx on whatsapp_cases (level);
create index if not exists whatsapp_cases_created_at_idx on whatsapp_cases (created_at);

-- Keep updated_at fresh on every row update
create or replace function set_updated_at_whatsapp_cases()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_whatsapp_cases_updated_at on whatsapp_cases;
create trigger trg_whatsapp_cases_updated_at
    before update on whatsapp_cases
    for each row execute function set_updated_at_whatsapp_cases();

-- sessions.pending_case_id — next inbound message from this session is feedback
alter table sessions
    add column if not exists pending_case_id uuid references whatsapp_cases(id) on delete set null;

create index if not exists sessions_pending_case_id_idx on sessions (pending_case_id);
