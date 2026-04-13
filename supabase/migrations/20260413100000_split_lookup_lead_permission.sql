-- =============================================================================
-- Split lookup_lead permission out of lookup_client
-- =============================================================================
-- The original permissions migration only had `lookup_client`, which was used
-- to gate BOTH contact lookups (search_contact_by_name, get_my_clients) and
-- lead lookups (search_lead_by_name, get_my_leads). Operationally these are
-- different responsibilities — a staff role might be allowed to find their
-- prospects without seeing the full client book, or vice versa.
--
-- This migration adds a separate `lookup_lead` permission and seeds it with
-- the same defaults as `lookup_client`:
--   Full Access → enabled
--   Some Access → disabled (pending business sign-off)
--   No Access   → disabled
--
-- The application code (STAFF_TOOL_PERMISSIONS in openai.service.ts) is updated
-- in the same change to map lead-lookup tools to this new key.
-- =============================================================================

insert into role_tools (role_id, tool_name, enabled)
select r.id,
       'lookup_lead',
       case r.name
           when 'Full Access' then true
           when 'Some Access' then false
           when 'No Access'   then false
       end
from roles r
on conflict (role_id, tool_name) do nothing;
