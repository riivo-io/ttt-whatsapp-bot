-- =============================================================================
-- Permissions Infrastructure
-- =============================================================================
-- Creates the three tables that drive staff access control for the bot:
--   1. roles       — three default roles (No Access, Some Access, Full Access)
--   2. users       — mirrors Dynamics systemuser entity, assigns a role per staff member
--   3. role_tools  — maps each staff tool to each role with an enabled flag
--
-- Adding a new staff tool in the future requires only new rows in role_tools
-- (one per role). The users table is untouched.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- roles
-- -----------------------------------------------------------------------------
create table if not exists roles (
    id          uuid primary key default gen_random_uuid(),
    name        text not null unique,
    description text,
    created_at  timestamptz not null default now()
);

-- Seed the three default roles
insert into roles (name, description) values
    ('No Access',   'Staff member has no access to any bot tools.'),
    ('Some Access', 'Staff member has partial access. Specific tools to be confirmed with the business.'),
    ('Full Access', 'Staff member has access to all bot tools.')
on conflict (name) do nothing;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
-- Mirrors the Dynamics systemuser entity. Populated by the sync script
-- (src/scripts/sync-users-from-dynamics.ts). role_id is NOT overwritten by the
-- sync — it is managed in Supabase only.
create table if not exists users (
    id                uuid primary key default gen_random_uuid(),
    full_name         text not null,
    mobile_number     text,
    role_id           uuid references roles(id) on delete set null,
    dynamics_user_id  text not null unique,
    created_at        timestamptz not null default now(),
    last_synced_at    timestamptz
);

create index if not exists users_mobile_number_idx   on users (mobile_number);
create index if not exists users_role_id_idx         on users (role_id);

-- -----------------------------------------------------------------------------
-- role_tools
-- -----------------------------------------------------------------------------
-- One row per (role, tool). `enabled` controls whether that role can use that
-- tool. New tools are added by inserting one row per role.
create table if not exists role_tools (
    id         uuid primary key default gen_random_uuid(),
    role_id    uuid not null references roles(id) on delete cascade,
    tool_name  text not null,
    enabled    boolean not null default false,
    unique (role_id, tool_name)
);

create index if not exists role_tools_role_id_idx on role_tools (role_id);

-- Seed role_tools for the 10 staff tools across all three roles.
-- Full Access → all enabled.
-- No Access   → all disabled.
-- Some Access → all disabled for now, pending business sign-off (AC #5).
with tool_list(tool_name) as (
    values
        ('create_lead'),
        ('create_contact'),
        ('create_task'),
        ('create_case'),
        ('create_invoice'),
        ('lookup_client'),
        ('view_open_cases'),
        ('view_outstanding_invoices'),
        ('send_invoice_pdf'),
        ('upload_letter_of_engagement')
)
insert into role_tools (role_id, tool_name, enabled)
select r.id, t.tool_name,
       case r.name
           when 'Full Access' then true
           when 'Some Access' then false  -- TODO: update once business confirms
           when 'No Access'   then false
       end
from roles r
cross join tool_list t
on conflict (role_id, tool_name) do nothing;
