create type public.organization_status as enum ('active','suspended','closed');
create type public.organization_role as enum ('owner','admin','election_manager','returning_officer','finance_manager','viewer');
create type public.membership_status as enum ('invited','active','suspended','revoked');
create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null check (char_length(btrim(display_name)) between 1 and 160),
 phone_e164 text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table public.organizations (
 id uuid primary key default gen_random_uuid(),
 name text not null check (char_length(btrim(name)) between 2 and 160),
 slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 60),
 country_code char(2) not null default 'KE',
 timezone text not null default 'Africa/Nairobi',
 contact_email citext,
 status public.organization_status not null default 'active',
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (id)
);
create table public.organization_members (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete restrict,
 user_id uuid not null references auth.users(id) on delete restrict,
 role public.organization_role not null,
 status public.membership_status not null default 'invited',
 invited_by uuid references auth.users(id) on delete set null,
 invitation_expires_at timestamptz,
 accepted_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (organization_id,user_id)
);
create index organization_members_user_status_idx on public.organization_members(user_id,status);
create index organization_members_org_status_role_idx on public.organization_members(organization_id,status,role);
create index organizations_created_by_idx on public.organizations(created_by);
create or replace function mandate_private.set_updated_at()
returns trigger language plpgsql set search_path = pg_catalog
as $$ begin new.updated_at := now(); return new; end; $$;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function mandate_private.set_updated_at();
create trigger organizations_set_updated_at before update on public.organizations for each row execute function mandate_private.set_updated_at();
create trigger organization_members_set_updated_at before update on public.organization_members for each row execute function mandate_private.set_updated_at();
alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
create policy profiles_select_own on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
grant select, update on public.profiles to authenticated;
revoke all on public.organizations, public.organization_members from anon, authenticated;
