-- =============================================================================
-- TTTFG-5196: the signing page keeps PDFs only until the caller has them
-- =============================================================================
-- The signing-sweep cron deletes a request's PDFs (bucket "signing", <id>/...)
-- 30 days after the link expired, once the link is closed: signed and its
-- callback delivered, expired, or superseded. The row and its audit stay;
-- files_purged_at says when the PDFs went. A signed form whose callback was
-- never taken is kept (it is the only copy). Safe to run again.
-- =============================================================================

alter table signing_requests add column if not exists files_purged_at timestamptz;

create index if not exists signing_requests_files_to_purge
    on signing_requests (expires_at) where files_purged_at is null and status <> 'open';
