-- Store Paystack settlement exports as immutable provider evidence for reconciliation.
-- This is read-only matching against verified receipts; it does not book fees,
-- move balances, allocate purpose liabilities, or authorize payouts.

create table public.paystack_settlements (
  id uuid primary key default gen_random_uuid(),
  environment text not null check (environment in ('test', 'live')),
  provider_settlement_id text not null,
  status text not null check (status in ('pending', 'processing', 'success', 'failed')),
  currency character(3) not null,
  provider_total_amount_minor bigint,
  provider_effective_amount_minor bigint,
  provider_total_processed_minor bigint,
  provider_total_fees_minor bigint,
  settlement_reference text,
  settled_at timestamptz,
  imported_at timestamptz not null default now(),
  unique (environment, provider_settlement_id),
  unique (id, environment),
  check (provider_total_amount_minor is null or provider_total_amount_minor >= 0),
  check (provider_effective_amount_minor is null or provider_effective_amount_minor >= 0),
  check (provider_total_processed_minor is null or provider_total_processed_minor >= 0),
  check (provider_total_fees_minor is null or provider_total_fees_minor >= 0)
);

create table public.paystack_settlement_transactions (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null,
  environment text not null check (environment in ('test', 'live')),
  foreign key (settlement_id, environment) references public.paystack_settlements(id, environment) on delete restrict,
  provider_transaction_id text not null,
  provider_reference text not null,
  provider_status text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency character(3) not null,
  fee_minor bigint check (fee_minor is null or fee_minor >= 0),
  paid_at timestamptz,
  imported_at timestamptz not null default now(),
  unique (settlement_id, provider_transaction_id),
  unique (environment, provider_transaction_id)
);

create index paystack_settlement_transactions_reference_idx
  on public.paystack_settlement_transactions(provider_reference);
alter table public.paystack_settlements enable row level security;
alter table public.paystack_settlement_transactions enable row level security;
revoke all on public.paystack_settlements, public.paystack_settlement_transactions
  from public, anon, authenticated;
grant select, insert, update on public.paystack_settlements to service_role;
grant select, insert, update on public.paystack_settlement_transactions to service_role;

create or replace view public.paystack_settlement_reconciliation
with (security_invoker = true)
as
select
  s.id as settlement_id,
  s.environment,
  s.provider_settlement_id,
  s.status as settlement_status,
  s.currency as settlement_currency,
  s.provider_total_amount_minor,
  s.provider_effective_amount_minor,
  s.provider_total_processed_minor,
  s.provider_total_fees_minor,
  s.settled_at,
  st.id as settlement_transaction_id,
  st.provider_transaction_id,
  st.provider_reference,
  st.provider_status,
  st.amount_minor as settled_transaction_amount_minor,
  st.currency as transaction_currency,
  st.fee_minor,
  st.paid_at,
  matched.intent_id as payment_intent_id,
  pi.purpose as payment_purpose,
  pi.status as payment_intent_status,
  pi.provider_amount_minor as verified_provider_amount_minor,
  pi.provider_currency as verified_provider_currency,
  case
    when s.status <> 'success' then 'settlement_not_successful'
    when matched.intent_count = 0 then 'payment_intent_not_found'
    when matched.intent_count > 1 then 'ambiguous_payment_reference'
    when st.provider_status <> 'success' then 'provider_transaction_not_successful'
    when pi.provider_transaction_id is distinct from st.provider_transaction_id then 'provider_transaction_id_mismatch'
    when pi.provider_amount_minor is distinct from st.amount_minor then 'provider_amount_mismatch'
    when pi.provider_currency is distinct from st.currency then 'provider_currency_mismatch'
    when not exists (
      select 1 from public.ledger_transactions lt
      where lt.idempotency_key = 'paystack-payment-receipt:' || pi.id::text
        and lt.status = 'posted'
    ) then 'ledger_receipt_missing'
    else 'matched_to_receipt'
  end as reconciliation_status
from public.paystack_settlement_transactions st
join public.paystack_settlements s on s.id = st.settlement_id
left join lateral (
  select count(*)::integer as intent_count, (array_agg(p.id order by p.created_at))[1] as intent_id
  from public.payment_intents p
  where p.provider = 'paystack'
    and p.provider_reference = st.provider_reference
) matched on true
left join public.payment_intents pi on pi.id = matched.intent_id;

revoke all on public.paystack_settlement_reconciliation from public, anon, authenticated;
grant select on public.paystack_settlement_reconciliation to service_role;

comment on table public.paystack_settlements is
  'Imported Paystack settlement metadata. Provider evidence only; no ledger or payout action.';
comment on table public.paystack_settlement_transactions is
  'Imported Paystack settlement transaction rows used for matching verified payment receipts.';
comment on view public.paystack_settlement_reconciliation is
  'Read-only comparison of Paystack settlement transactions to verified payment facts and suspense receipt postings. matched_to_receipt is not final bank reconciliation or purpose allocation.';
