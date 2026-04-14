-- =============================================================================
-- Staging table for LOE uploads awaiting staff confirmation
-- =============================================================================
-- When a staff member uploads a signed Letter of Engagement, the bot runs OCR
-- and extracts banking/signing details. Instead of writing straight to CRM
-- (where OCR errors become permanent), the extracted data is staged here for
-- the staff member to review, correct, and explicitly confirm.
--
-- Lifecycle:
--   pending_review → staff corrects fields → confirms → confirmed → CRM write → row deleted
--   pending_review → 30 min timeout → expired (auto-cleanup)
-- =============================================================================

create table if not exists pending_loe_data (
    id                    uuid primary key default gen_random_uuid(),
    session_id            text not null,
    lead_id               text not null,
    lead_name             text,
    file_name             text not null,
    file_buffer           bytea not null,
    -- Extracted fields (all nullable — OCR may not find everything)
    -- Banking
    bank_name             text,
    account_name          text,
    account_number        text,
    account_type          text,
    branch_name_code      text,
    -- Signing
    signed_at             text,
    signed_at_consultant  text,
    signed_date           text,           -- ISO date string e.g. "2026-01-01"
    -- Client details from the LOE form
    client_first_name     text,
    client_last_name      text,
    id_number             text,
    income_tax_number     text,
    physical_address      text,
    email_address         text,
    contact_number        text,
    industry              text,
    -- OCR metadata
    ocr_markdown          text,
    ocr_page_count        int,
    -- Lifecycle
    status                text not null default 'pending_review',
    created_at            timestamptz not null default now()
);

create index if not exists pending_loe_session_idx on pending_loe_data (session_id);
create index if not exists pending_loe_status_idx on pending_loe_data (status, created_at);
