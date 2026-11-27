-- Serialize Paystack initialization per payment intent and preserve uncertain outcomes.
-- An interrupted or failed provider request is never retried automatically: reconcile the
-- existing provider reference before any new initialization attempt.

create table public.payment_initialization_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_intent_id uuid not null unique
    references public.payment_intents(id) on delete restrict,
  status text not null default 'initializing'
    check (status in ('initializing', 'unknown', 'initialized')),
  authorization_url text,
  access_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    (status = 'initialized' and authorization_url is not null and access_code is not null and completed_at is not null)
    or status <> 'initialized'
  )
);

alter table public.payment_initialization_attempts enable row level security;
revoke all on public.payment_initialization_attempts from public, anon, authenticated;
grant all on public.payment_initialization_attempts to service_role;

comment on table public.payment_initialization_attempts is
  'Service-managed, one-shot Paystack initialization claims. Unknown/in-flight outcomes require reconciliation and must not be retried blindly.';
