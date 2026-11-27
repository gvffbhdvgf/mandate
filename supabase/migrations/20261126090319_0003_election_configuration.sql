create type public.voting_mode as enum ('registered_single','registered_weighted','public_paid');
create type public.election_status as enum ('draft','scheduled','open','paused','closed','tallying','results_published','cancelled','archived');
create type public.contest_type as enum ('single_choice');
create type public.option_status as enum ('active','withdrawn');
create type public.tie_policy as enum ('runoff','declared_tie','external_resolution');
create table public.elections (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete restrict,
 title text not null check (char_length(btrim(title)) between 2 and 160),
 description text check (description is null or char_length(description) <= 5000),
 public_slug text unique check (public_slug is null or public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 voting_mode public.voting_mode not null default 'registered_single', status public.election_status not null default 'draft',
 starts_at timestamptz not null, ends_at timestamptz not null, timezone text not null default 'Africa/Nairobi',
 result_visibility text not null default 'private' check (result_visibility in ('private','members','public')),
 rules_version integer not null default 1 check (rules_version > 0), rules_snapshot jsonb, rules_hash text, candidate_snapshot jsonb,
 currency char(3), price_per_credit_minor bigint, max_credits_per_participant integer,
 contact_verification_required boolean not null default true, paid_voting_authorized_at timestamptz,
 paid_voting_authorized_by uuid references auth.users(id), opened_at timestamptz, closed_at timestamptz, published_at timestamptz,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check (starts_at < ends_at),
 check (voting_mode <> 'public_paid' or (currency = 'KES' and price_per_credit_minor > 0 and max_credits_per_participant > 0)),
 unique (id,organization_id)
);
create table public.contests (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, election_id uuid not null,
 title text not null check (char_length(btrim(title)) between 2 and 160),
 description text check (description is null or char_length(description) <= 5000),
 contest_type public.contest_type not null default 'single_choice', is_required boolean not null default true,
 display_order integer not null default 0, tie_policy public.tie_policy not null default 'declared_tie',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (id,election_id,organization_id),
 foreign key (election_id,organization_id) references public.elections(id,organization_id) on delete restrict
);
create table public.options (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, election_id uuid not null, contest_id uuid not null,
 display_name text not null check (char_length(btrim(display_name)) between 1 and 160),
 profile text check (profile is null or char_length(profile) <= 5000), photo_path text,
 status public.option_status not null default 'active', display_order integer not null default 0,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key (contest_id,election_id,organization_id) references public.contests(id,election_id,organization_id) on delete restrict
);
create index elections_org_status_created_idx on public.elections(organization_id,status,created_at desc);
create index elections_status_starts_idx on public.elections(status,starts_at);
create index contests_election_order_idx on public.contests(election_id,display_order);
create index options_contest_order_idx on public.options(contest_id,display_order);
create index contests_org_idx on public.contests(organization_id);
create index options_org_idx on public.options(organization_id);
create trigger elections_set_updated_at before update on public.elections for each row execute function mandate_private.set_updated_at();
create trigger contests_set_updated_at before update on public.contests for each row execute function mandate_private.set_updated_at();
create trigger options_set_updated_at before update on public.options for each row execute function mandate_private.set_updated_at();
alter table public.elections enable row level security;
alter table public.contests enable row level security;
alter table public.options enable row level security;
revoke all on public.elections,public.contests,public.options from anon,authenticated;
