-- =============================================================================
-- messages.external_id — idempotency key for externally-sent template seeds
-- =============================================================================
-- Backs the /webhook/outbound-notify path. External senders (campaign app,
-- Power Automate flows) post here after sending a WhatsApp template; we seed
-- the body into history so Tina's next reply has context. The unique partial
-- index makes the insert idempotent against PA's at-least-once retries — same
-- sender_message_id (Meta's wamid, typically) collapses to a no-op.
--
-- Existing rows have external_id NULL and stay that way; the WHERE clause on
-- the index lets multiple NULLs coexist without violating uniqueness.
-- =============================================================================

alter table messages
    add column external_id text;

create unique index messages_external_id_unique_idx
    on messages (external_id)
    where external_id is not null;
