-- =============================================================================
-- The user (9 Nov 2026): the client signs at the end of the guided form
-- =============================================================================
-- The signature the client drew on the form's last screen waits here until Tina has
-- filled the claim form: the signing step then signs it with this signature (the
-- signing page's own signing: hash check, stamp, audit, callback) instead of sending
-- a link, and clears these columns. Null on every link that wasn't signed on the form.
--   signature             the drawing, a PNG data URL (at most about 1 MB)
--   signature_ip          the address the form was submitted from
--   signature_user_agent  the browser it was submitted from
--   signed_at             when the client confirmed
-- Without these columns the form still submits; the client gets a signing link as before.
-- Safe to run again.
-- =============================================================================

alter table guided_form_links add column if not exists signature text;
alter table guided_form_links add column if not exists signature_ip text;
alter table guided_form_links add column if not exists signature_user_agent text;
alter table guided_form_links add column if not exists signed_at timestamptz;

create index if not exists guided_form_links_signed_by_claim
    on guided_form_links (claim_id) where signature is not null;
