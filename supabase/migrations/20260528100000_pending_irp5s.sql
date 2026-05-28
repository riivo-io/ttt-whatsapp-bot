-- =============================================================================
-- Staging table for IRP5 uploads from leads (pre-conversion)
-- =============================================================================
-- State B leads (LoE signed, OTP outstanding) can fast-track by sending their
-- IRP5 before they're a Contact. The file is parsed and staged here keyed by
-- phone number. When the lead converts to a Contact (driven by OTP completion
-- + the existing Power Automate flow), the lazy deferred-write hook in
-- whatsappProcessor drains pending rows for that phone into riivo_irp5s +
-- riivo_taxsubmissionsdocuments against the new Contact.
-- =============================================================================

create table if not exists pending_irp5s (
    id                      uuid primary key default gen_random_uuid(),
    lead_id                 text not null,
    phone_number            text not null,
    sharepoint_url          text not null,
    file_name               text not null,
    certificate_number      text,
    assessment_year         integer,
    employer_name           text,
    source_codes            text[] default array[]::text[],
    extracted_fields        jsonb,
    received_at             timestamptz not null default now(),
    applied_to_contact_id   text,
    applied_at              timestamptz,
    apply_error             text
);

create index if not exists pending_irp5s_phone_pending_idx
    on pending_irp5s (phone_number)
    where applied_to_contact_id is null;

create index if not exists pending_irp5s_lead_idx on pending_irp5s (lead_id);
