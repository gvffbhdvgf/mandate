-- Public paid voting is a Mandate single-merchant product.
-- Full participant charges are collected into Mandate's Paystack merchant account.
-- Processor fees are recorded separately when Paystack reports them. No organizer
-- subaccount, split settlement, organizer proceeds or later organizer payout is used.
-- This does not enable the feature or bypass platform/legal/provider release gates.

alter table public.payment_intents
  add column provider_fee_minor bigint check (provider_fee_minor is null or provider_fee_minor >= 0),
  add column provider_fee_verified_at timestamptz;

alter table public.payment_intents
  add constraint payment_intents_provider_fee_complete check (
    (provider_fee_minor is null and provider_fee_verified_at is null)
    or (provider_fee_minor is not null and provider_fee_verified_at is not null
      and provider_fee_minor <= amount_minor)
  );

create or replace function mandate_private.guard_provider_fee_facts()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if old.provider_fee_verified_at is not null and (
    new.provider_fee_minor is distinct from old.provider_fee_minor
    or new.provider_fee_verified_at is distinct from old.provider_fee_verified_at
  ) then
    raise exception 'VERIFIED_PROVIDER_FEE_FACTS_IMMUTABLE' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function mandate_private.guard_provider_fee_facts() from public, anon, authenticated;
create trigger payment_intents_guard_provider_fee_facts
before update of provider_fee_minor, provider_fee_verified_at on public.payment_intents
for each row execute function mandate_private.guard_provider_fee_facts();
grant execute on function mandate_private.guard_provider_fee_facts() to service_role;

drop trigger if exists payment_intents_require_verified_public_vote_split on public.payment_intents;

create or replace function mandate_private.apply_verified_paystack_public_vote_payment(
  p_event_id uuid, p_provider_reference text, p_provider_transaction_id text,
  p_provider_status text, p_amount_minor bigint, p_currency text, p_provider_fee_minor bigint
)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_event public.payment_events%rowtype;
  v_intent public.payment_intents%rowtype;
  v_matches boolean;
  v_next_status public.payment_status;
begin
  if p_provider_reference is null or p_provider_transaction_id is null or p_provider_status is null
    or p_amount_minor is null or p_amount_minor <= 0 or p_currency is null
    or (p_provider_fee_minor is not null and (p_provider_fee_minor < 0 or p_provider_fee_minor > p_amount_minor)) then
    raise exception 'PUBLIC_VOTE_PAYMENT_VERIFICATION_FACTS_INVALID' using errcode = '22023';
  end if;

  if p_event_id is not null then
    select * into v_event from public.payment_events where id = p_event_id for update;
    if not found or v_event.provider <> 'paystack'
      or v_event.signature_verified is distinct from true
      or v_event.event_type <> 'charge.success'
      or v_event.provider_reference is distinct from p_provider_reference then
      raise exception 'INVALID_VERIFIED_PAYSTACK_EVENT' using errcode = '22023';
    end if;
    if v_event.processing_status = 'processed' then
      return jsonb_build_object('duplicate', true, 'processed', true, 'status', 'success');
    end if;
  end if;

  select * into v_intent from public.payment_intents
  where provider = 'paystack' and provider_reference = p_provider_reference for update;

  if not found or v_intent.purpose <> 'public_vote_credits'
    or v_intent.election_id is null or v_intent.participant_id is null
    or v_intent.organization_id is not null or v_intent.split_status <> 'not_configured' then
    raise exception 'SINGLE_MERCHANT_PUBLIC_VOTE_INTENT_REQUIRED' using errcode = '23514';
  end if;

  if v_intent.status = 'success' and v_intent.provider_transaction_id = p_provider_transaction_id
    and v_intent.provider_status = 'success'
    and v_intent.provider_amount_minor = p_amount_minor
    and v_intent.provider_currency = p_currency then
    if p_provider_fee_minor is not null then
      if v_intent.provider_fee_verified_at is null then
        update public.payment_intents
        set provider_fee_minor = p_provider_fee_minor,
            provider_fee_verified_at = pg_catalog.now()
        where id = v_intent.id;
      elsif v_intent.provider_fee_minor is distinct from p_provider_fee_minor then
        raise exception 'PROVIDER_FEE_FACTS_MISMATCH' using errcode = '23514';
      end if;
    end if;
    if p_event_id is not null then
      update public.payment_events set processing_status = 'processed', processed_at = pg_catalog.now()
      where id = p_event_id;
    end if;
    return jsonb_build_object('duplicate', true, 'processed', true, 'matched', true, 'status', 'success');
  end if;

  if v_intent.status not in ('initialized','pending') then
    raise exception 'PAYMENT_STATE_TERMINAL' using errcode = '23514';
  end if;

  v_matches := p_provider_status = 'success'
    and p_provider_reference = v_intent.provider_reference
    and p_amount_minor = v_intent.amount_minor
    and p_currency = v_intent.currency;
  v_next_status := case when v_matches then 'success'::public.payment_status else 'exception'::public.payment_status end;

  update public.payment_intents
  set status = v_next_status, provider_transaction_id = p_provider_transaction_id,
      provider_status = p_provider_status, provider_amount_minor = p_amount_minor,
      provider_currency = p_currency,
      provider_fee_minor = case when v_matches then p_provider_fee_minor else null end,
      provider_fee_verified_at = case when v_matches and p_provider_fee_minor is not null
        then pg_catalog.now() else null end,
      verified_at = pg_catalog.now()
  where id = v_intent.id;

  if p_event_id is not null then
    update public.payment_events set processing_status = 'processed', processed_at = pg_catalog.now()
    where id = p_event_id;
  end if;

  return jsonb_build_object('duplicate', false, 'processed', true, 'matched', v_matches,
    'status', v_next_status,
    'reason', case when v_matches then null else 'PAYMENT_AMOUNT_CURRENCY_OR_STATUS_MISMATCH' end);
end;
$$;

revoke all on function mandate_private.apply_verified_paystack_public_vote_payment(uuid,text,text,text,bigint,text,bigint)
  from public, anon, authenticated;
grant execute on function mandate_private.apply_verified_paystack_public_vote_payment(uuid,text,text,text,bigint,text,bigint)
  to service_role;

create or replace function public.apply_verified_paystack_public_vote_payment(
  p_event_id uuid, p_provider_reference text, p_provider_transaction_id text,
  p_provider_status text, p_amount_minor bigint, p_currency text, p_provider_fee_minor bigint
)
returns jsonb language sql security invoker set search_path = pg_catalog
as $$ select mandate_private.apply_verified_paystack_public_vote_payment($1,$2,$3,$4,$5,$6,$7); $$;

revoke all on function public.apply_verified_paystack_public_vote_payment(uuid,text,text,text,bigint,text,bigint)
  from public, anon, authenticated;
grant execute on function public.apply_verified_paystack_public_vote_payment(uuid,text,text,text,bigint,text,bigint)
  to service_role;

comment on column public.payment_intents.provider_fee_minor is
  'Provider-reported processing fee in minor currency units, captured only from a server-verified Paystack transaction response; nullable when provider does not report it.';
comment on function mandate_private.apply_verified_paystack_public_vote_payment(uuid,text,text,text,bigint,text,bigint) is
  'Atomically verifies a single-merchant public vote-credit payment, records provider amount/currency/fee facts, posts the existing suspense receipt and triggers idempotent credit fulfillment. Does not allocate revenue or bypass the global feature release gate.';


-- Mandate is the merchant and revenue owner for public vote-credit purchases.
-- Registered-election receipts retain their existing suspense allocation workflow.
create or replace function mandate_private.capture_verified_payment_receipt()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_clearing_account uuid;
  v_destination_account uuid;
  v_destination_owner public.ledger_owner_type;
  v_destination_code text;
  v_receipt_amount bigint;
  v_transaction_type text;
  v_description text;
  v_posting jsonb;
begin
  if new.status = 'success' and old.status is distinct from new.status then
    if new.provider <> 'paystack'
      or new.provider_transaction_id is null
      or new.verified_at is null
      or new.amount_minor <= 0
      or new.currency <> 'KES' then
      raise exception 'VERIFIED_PAYMENT_RECEIPT_FIELDS_REQUIRED' using errcode = '23514';
    end if;

    v_receipt_amount := new.amount_minor;
    v_transaction_type := case when new.purpose = 'public_vote_credits'
      then 'mandate_public_vote_revenue' else 'payment_receipt_pending_allocation' end;
    v_description := case when new.purpose = 'public_vote_credits'
      then 'Mandate public vote-credit gross revenue'
      else 'Verified Paystack receipt pending purpose allocation' end;

    if new.purpose = 'public_vote_credits' then
      v_destination_owner := 'platform_revenue';
      v_destination_code := 'mandate-public-vote-revenue';
    else
      v_destination_owner := 'suspense';
      v_destination_code := 'unallocated-payment-receipts';
    end if;

  elsif new.status = 'exception'
    and old.status is distinct from new.status
    and new.provider = 'paystack'
    and new.provider_status = 'success'
    and new.provider_transaction_id is not null
    and new.provider_amount_minor > 0
    and new.provider_currency = new.currency
    and new.verified_at is not null then
    -- Provider confirmed receipt but the payment did not match the intent.
    -- Record the actual amount in suspense without recognizing revenue or
    -- fulfilling entitlements; reconciliation can resolve the exception.
    v_receipt_amount := new.provider_amount_minor;
    v_transaction_type := 'payment_receipt_pending_allocation';
    v_description := 'Verified Paystack amount mismatch held in suspense';
    v_destination_owner := 'suspense';
    v_destination_code := 'unallocated-payment-receipts';
  else
    return new;
  end if;

  insert into public.ledger_accounts(owner_type, organization_id, currency, account_code)
  values ('provider_clearing', null, new.currency, 'paystack-receivable')
  on conflict (owner_type, currency, account_code) where organization_id is null do nothing;

  select id into strict v_clearing_account
  from public.ledger_accounts
  where owner_type = 'provider_clearing' and organization_id is null
    and currency = new.currency and account_code = 'paystack-receivable';

  insert into public.ledger_accounts(owner_type, organization_id, currency, account_code)
  values (v_destination_owner, null, new.currency, v_destination_code)
  on conflict (owner_type, currency, account_code) where organization_id is null do nothing;

  select id into strict v_destination_account
  from public.ledger_accounts
  where owner_type = v_destination_owner and organization_id is null
    and currency = new.currency and account_code = v_destination_code;

  v_posting := mandate_private.post_ledger_transaction(
    v_transaction_type,
    'payment_intent',
    new.id,
    'paystack-payment-receipt:' || new.id::text,
    v_description,
    jsonb_build_array(
      jsonb_build_object('account_id', v_clearing_account, 'direction', 'debit',
        'amount_minor', v_receipt_amount, 'currency', new.currency),
      jsonb_build_object('account_id', v_destination_account, 'direction', 'credit',
        'amount_minor', v_receipt_amount, 'currency', new.currency)
    )
  );

  if v_posting->>'status' <> 'posted' then
    raise exception 'VERIFIED_PAYMENT_RECEIPT_LEDGER_POST_FAILED' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_intents_capture_verified_receipt on public.payment_intents;
create trigger payment_intents_capture_verified_receipt
after update of status on public.payment_intents
for each row
when (new.status in ('success','exception') and old.status is distinct from new.status)
execute function mandate_private.capture_verified_payment_receipt();

create or replace function mandate_private.capture_verified_public_vote_provider_fee()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_clearing_account uuid;
  v_fee_account uuid;
  v_posting jsonb;
begin
  if new.purpose <> 'public_vote_credits' or new.provider_fee_minor is null
    or new.provider_fee_minor = 0 then
    return new;
  end if;
  if new.status <> 'success' or new.provider_fee_verified_at is null
    or new.provider_fee_minor < 0 or new.currency <> 'KES' then
    raise exception 'VERIFIED_PUBLIC_VOTE_PROVIDER_FEE_FIELDS_REQUIRED' using errcode = '23514';
  end if;

  insert into public.ledger_accounts(owner_type, organization_id, currency, account_code)
  values ('provider_clearing', null, new.currency, 'paystack-receivable')
  on conflict (owner_type, currency, account_code) where organization_id is null do nothing;
  insert into public.ledger_accounts(owner_type, organization_id, currency, account_code)
  values ('processor_fee', null, new.currency, 'paystack-processing-fees')
  on conflict (owner_type, currency, account_code) where organization_id is null do nothing;

  select id into strict v_clearing_account from public.ledger_accounts
  where owner_type = 'provider_clearing' and organization_id is null
    and currency = new.currency and account_code = 'paystack-receivable';
  select id into strict v_fee_account from public.ledger_accounts
  where owner_type = 'processor_fee' and organization_id is null
    and currency = new.currency and account_code = 'paystack-processing-fees';

  v_posting := mandate_private.post_ledger_transaction(
    'public_vote_provider_processing_fee',
    'payment_intent',
    new.id,
    'paystack-public-vote-fee:' || new.id::text,
    'Verified Paystack processing fee for Mandate public vote-credit revenue',
    jsonb_build_array(
      jsonb_build_object('account_id', v_fee_account, 'direction', 'debit',
        'amount_minor', new.provider_fee_minor, 'currency', new.currency),
      jsonb_build_object('account_id', v_clearing_account, 'direction', 'credit',
        'amount_minor', new.provider_fee_minor, 'currency', new.currency)
    )
  );
  if v_posting->>'status' <> 'posted' then
    raise exception 'PUBLIC_VOTE_PROVIDER_FEE_LEDGER_POST_FAILED' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function mandate_private.capture_verified_public_vote_provider_fee()
  from public, anon, authenticated;
create trigger payment_intents_capture_public_vote_provider_fee
after update of provider_fee_minor, provider_fee_verified_at
on public.payment_intents
for each row
when (new.purpose = 'public_vote_credits'
  and new.provider_fee_verified_at is not null
  and old.provider_fee_verified_at is null)
execute function mandate_private.capture_verified_public_vote_provider_fee();

comment on function mandate_private.capture_verified_payment_receipt() is
  'Posts verified public vote-credit gross collections to Mandate platform revenue; other purposes remain in suspense pending allocation.';
comment on function mandate_private.capture_verified_public_vote_provider_fee() is
  'Posts a provider-verified Paystack fee as Mandate processing expense against provider clearing, once per payment intent.';
