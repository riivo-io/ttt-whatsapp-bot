-- =============================================================================
-- Add role and permitted tools to sessions
-- =============================================================================
-- Adds role_id and permitted_tools to the sessions table so that a staff
-- member's role and the list of tools their role is allowed to use is cached
-- on the session record. Subsequent messages in the same session reuse these
-- values instead of re-querying users and role_tools every time.
--
-- role_id          — FK to roles.id. NULL for non-staff sessions.
-- permitted_tools  — array of tool permission names from role_tools.tool_name
--                    that are enabled for this user's role at session creation.
--                    Empty array = no tools permitted (No Access).
-- =============================================================================

alter table sessions
    add column if not exists role_id uuid references roles(id) on delete set null,
    add column if not exists permitted_tools text[] not null default '{}';

create index if not exists sessions_role_id_idx on sessions (role_id);
