alter table public.options add constraint options_id_election_org_unique unique (id,election_id,organization_id);
create type public.participant_verification_status as enum ('unverified','verified','blocked');
create type public.ballot_status as enum ('accepted','invalidated');
create table public.public_participants (
 id uuid primary key default gen_random_uuid(), election_id uuid not null references public.elections(id) on delete restrict,
 contact_hash text not null, encrypted_contact bytea, verification_status public.participant_verification_status not null default 'unverified',
 created_at timestamptz not null default now(), unique (election_id,contact_hash), unique (id,election_id)
);
create table public.participant_access_tokens (
 id uuid primary key default gen_random_uuid(), participant_id uuid not null references public.public_participants(id) on delete cascade,
 token_hash text not null unique, expires_at timestamptz not null, used_at timestamptz, created_at timestamptz not null default now()
);
create table public.ballots (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, election_id uuid not null, contest_id uuid not null, option_id uuid not null,
 receipt_code text not null unique, vote_units bigint not null default 1 check (vote_units > 0), cast_at timestamptz not null default now(),
 status public.ballot_status not null default 'accepted', invalidated_at timestamptz, invalidation_reason text,
 foreign key (election_id,organization_id) references public.elections(id,organization_id) on delete restrict,
 foreign key (contest_id,election_id,organization_id) references public.contests(id,election_id,organization_id) on delete restrict,
 foreign key (option_id,election_id,organization_id) references public.options(id,election_id,organization_id) on delete restrict
);
create table public.ballot_submission_controls (
 id uuid primary key default gen_random_uuid(), election_id uuid not null references public.elections(id) on delete restrict,
 contest_id uuid not null references public.contests(id) on delete restrict, voter_id uuid references public.election_voters(id) on delete restrict,
 participant_id uuid references public.public_participants(id) on delete restrict, ballot_id uuid not null unique references public.ballots(id) on delete restrict,
 created_at timestamptz not null default now(),
 check ((voter_id is not null)::integer + (participant_id is not null)::integer = 1),
 unique (election_id,contest_id,voter_id)
);
create index ballot_controls_participant_idx on public.ballot_submission_controls(election_id,contest_id,participant_id) where participant_id is not null;
create table public.vote_credit_lots (
 id uuid primary key default gen_random_uuid(), election_id uuid not null references public.elections(id) on delete restrict,
 participant_id uuid not null references public.public_participants(id) on delete restrict, payment_id uuid not null unique,
 credits_issued integer not null check (credits_issued > 0),
 credits_remaining integer not null check (credits_remaining >= 0 and credits_remaining <= credits_issued),
 created_at timestamptz not null default now(), unique (id,election_id,participant_id)
);
create table public.vote_credit_consumptions (
 id uuid primary key default gen_random_uuid(), credit_lot_id uuid not null references public.vote_credit_lots(id) on delete restrict,
 ballot_id uuid not null references public.ballots(id) on delete restrict, credits_consumed integer not null check (credits_consumed > 0),
 created_at timestamptz not null default now(), unique (credit_lot_id,ballot_id)
);
create index ballots_election_contest_idx on public.ballots(election_id,contest_id,status,cast_at);
create index public_participants_election_idx on public.public_participants(election_id);
create index credit_lots_participant_idx on public.vote_credit_lots(participant_id,election_id);
alter table public.public_participants enable row level security;
alter table public.participant_access_tokens enable row level security;
alter table public.ballots enable row level security;
alter table public.ballot_submission_controls enable row level security;
alter table public.vote_credit_lots enable row level security;
alter table public.vote_credit_consumptions enable row level security;
revoke all on public.public_participants,public.participant_access_tokens,public.ballots,public.ballot_submission_controls,public.vote_credit_lots,public.vote_credit_consumptions from anon,authenticated;
comment on table public.ballots is 'Anonymous ballot choices. No voter, participant, contact, payment or token identifiers are stored here.';
comment on table public.ballot_submission_controls is 'Restricted anti-duplication mapping. Never exposed to organization users.';
comment on table public.public_participants is 'Restricted participant identity/contact record, separate from anonymous ballot choices.';
