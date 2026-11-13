-- =============================================================================
-- Service routing (docs/PLAN-service-routing.md): tax or insurance, per session
-- =============================================================================
-- Tina routes each client message to her tax path or to the insurance side
-- (src/domain/serviceRoute.ts). What a conversation settled on lives on its
-- session, so it ends with the session (30 minutes idle):
--
-- service_side:       'tax' or 'insurance', once the client tapped a side or
--                     the model was sure. Null: not settled.
-- route_pending:      a message waiting on the client's tap: the Insurance/Tax
--                     question (kind 'ask') or the insurance offer to a tax
--                     client (kind 'offer'). { kind, text, at }.
-- insurance_handover: the insurance hand-over this session opened (the
--                     riivo_request later messages go on). { requestId,
--                     ownerKind, contactId }.
--
-- Nullable, no default: existing sessions and code are unchanged.
-- =============================================================================

alter table sessions add column if not exists service_side text
    check (service_side in ('tax', 'insurance'));
alter table sessions add column if not exists route_pending jsonb;
alter table sessions add column if not exists insurance_handover jsonb;
