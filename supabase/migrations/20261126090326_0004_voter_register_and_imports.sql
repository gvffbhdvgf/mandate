create type public.voter_eligibility_status as enum ('eligible','revoked');
create type public.import_batch_status as enum ('uploaded','validating','validated','committed','failed');
create type public.import_row_status as enum ('accepted','rejected','committed');
create table public.election_voters (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, election_id uuid not null,
 external_voter_ref text not null, display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
 normalized_email citext, phone_e164 text, eligibility_status public.voter_eligibility_status not null default 'eligible',
 weight_units bigint not null default 1 check (weight_units > 0 and weight_units <= 1000000),
 access_token_hash text, invited_at timestamptz, verified_at timestamptz, created_at timestamptz not null default now(),
 foreign key (election_id,organization_id) references public.elections(id,organization_id) on delete restrict,
 unique (election_id,external_voter_ref)
);
create unique index election_voters_email_unique on public.election_voters(election_id,normalized_email) where normalized_email is not null;
create index election_voters_org_election_idx on public.election_voters(organization_id,election_id);
create index election_voters_token_hash_idx on public.election_voters(access_token_hash) where access_token_hash is not null;
create table public.import_batches (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, election_id uuid not null,
 uploaded_by uuid not null references auth.users(id), private_object_path text not null, original_filename text not null,
 status public.import_batch_status not null default 'uploaded', total_rows integer not null default 0 check (total_rows >= 0),
 accepted_rows integer not null default 0 check (accepted_rows >= 0), rejected_rows integer not null default 0 check (rejected_rows >= 0),
 mapping jsonb not null default '{}'::jsonb, batch_version integer not null default 1,
 created_at timestamptz not null default now(), committed_at timestamptz,
 foreign key (election_id,organization_id) references public.elections(id,organization_id) on delete restrict
);
create index import_batches_org_election_idx on public.import_batches(organization_id,election_id,created_at desc);
create table public.import_rows (
 id uuid primary key default gen_random_uuid(), batch_id uuid not null references public.import_batches(id) on delete cascade,
 row_number integer not null check (row_number > 0), normalized_data jsonb not null,
 validation_errors jsonb not null default '[]'::jsonb, status public.import_row_status not null default 'accepted',
 unique (batch_id,row_number)
);
create index import_rows_batch_status_idx on public.import_rows(batch_id,status);
alter table public.election_voters enable row level security;
alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;
revoke all on public.election_voters,public.import_batches,public.import_rows from anon,authenticated;
comment on table public.election_voters is 'Restricted voter register; never directly exposed to voters or public roles.';
comment on column public.election_voters.access_token_hash is 'Hash only; raw voter access tokens are returned once and never stored.';
comment on table public.import_rows is 'Restricted import staging; raw data must be purged under the approved retention schedule.';
