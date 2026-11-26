create type public.payment_purpose as enum ('platform_fee','public_vote_credits','organization_topup');
create type public.payment_provider as enum ('paystack');
create type public.payment_status as enum ('initialized','pending','success','failed','abandoned','reversed','refunded','exception');
create type public.payment_event_status as enum ('received','processing','processed','failed');
create type public.ledger_owner_type as enum ('platform','organization','provider_clearing','platform_revenue','organization_payable','processor_fee','refund_payable','payouts_payable','suspense');
create type public.ledger_transaction_status as enum ('pending','posted','reversed');
create type public.ledger_direction as enum ('debit','credit');
create type public.payout_status as enum ('requested','under_review','approved','processing','paid','failed','cancelled');
create table public.payment_intents (
 id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id) on delete restrict,
 election_id uuid references public.elections(id) on delete restrict, participant_id uuid references public.public_participants(id) on delete restrict,
 purpose public.payment_purpose not null, provider public.payment_provider not null default 'paystack',
 provider_reference text not null unique, amount_minor bigint not null check (amount_minor > 0), currency char(3) not null check (currency = 'KES'),
 expected_credits integer check (expected_credits is null or expected_credits > 0),
 status public.payment_status not null default 'initialized', provider_transaction_id text, idempotency_key text not null unique,
 verified_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check ((purpose = 'public_vote_credits' and election_id is not null and participant_id is not null and expected_credits is not null) or purpose <> 'public_vote_credits')
);
create table public.payment_events (
 id uuid primary key default gen_random_uuid(), provider public.payment_provider not null, provider_event_key text not null unique,
 provider_reference text, event_type text not null, signature_verified boolean not null default false,
 redacted_payload jsonb not null default '{}'::jsonb, processing_status public.payment_event_status not null default 'received',
 received_at timestamptz not null default now(), processed_at timestamptz
);
alter table public.vote_credit_lots add constraint vote_credit_lots_payment_fk foreign key (payment_id) references public.payment_intents(id) on delete restrict;
create table public.ledger_accounts (
 id uuid primary key default gen_random_uuid(), owner_type public.ledger_owner_type not null,
 organization_id uuid references public.organizations(id) on delete restrict, currency char(3) not null check (currency = 'KES'),
 account_code text not null, created_at timestamptz not null default now(),
 unique (owner_type,organization_id,currency,account_code)
);
create table public.ledger_transactions (
 id uuid primary key default gen_random_uuid(), transaction_type text not null, source_type text not null, source_id uuid,
 idempotency_key text not null unique, status public.ledger_transaction_status not null default 'pending',
 effective_at timestamptz not null default now(), created_at timestamptz not null default now(), description text
);
create table public.ledger_entries (
 id uuid primary key default gen_random_uuid(), transaction_id uuid not null references public.ledger_transactions(id) on delete restrict,
 account_id uuid not null references public.ledger_accounts(id) on delete restrict, direction public.ledger_direction not null,
 amount_minor bigint not null check (amount_minor > 0), currency char(3) not null check (currency = 'KES'),
 created_at timestamptz not null default now()
);
create index ledger_entries_txn_idx on public.ledger_entries(transaction_id);
create index ledger_entries_account_idx on public.ledger_entries(account_id,created_at desc);
create index payment_intents_election_idx on public.payment_intents(election_id,status,created_at desc);
create table public.payout_requests (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete restrict,
 amount_minor bigint not null check (amount_minor > 0), currency char(3) not null check (currency = 'KES'),
 status public.payout_status not null default 'requested', encrypted_destination_reference bytea not null,
 requested_by uuid not null references auth.users(id), approved_by uuid references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check (approved_by is null or approved_by <> requested_by)
);
create trigger payment_intents_set_updated_at before update on public.payment_intents for each row execute function mandate_private.set_updated_at();
create trigger payout_requests_set_updated_at before update on public.payout_requests for each row execute function mandate_private.set_updated_at();
alter table public.payment_intents enable row level security;
alter table public.payment_events enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.payout_requests enable row level security;
revoke all on public.payment_intents,public.payment_events,public.ledger_accounts,public.ledger_transactions,public.ledger_entries,public.payout_requests from anon,authenticated;
comment on table public.payment_intents is 'Server-managed payment state. No client direct writes or reads.';
comment on table public.payment_events is 'Verified, redacted provider events only; raw webhook bodies must not be retained.';
comment on table public.ledger_entries is 'Append-only financial postings; no direct client write access.';
comment on table public.payout_requests is 'Feature-gated; payout processing remains disabled pending legal/provider/product approval.';
