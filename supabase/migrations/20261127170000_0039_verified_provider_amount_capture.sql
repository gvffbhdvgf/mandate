-- Persist provider-observed transaction facts separately from the Mandate intent.
-- A real provider success with a mismatched amount must still be recorded in suspense
-- for reconciliation; never book the expected intent amount as if it were received.

alter table public.payment_intents
  add column provider_status text,
  add column provider_amount_minor bigint,
  add column provider_currency text;

alter table public.payment_intents
  add constraint payment_intents_provider_amount_positive
  check (provider_amount_minor is null or provider_amount_minor > 0);

comment on column public.payment_intents.provider_status
  is 'Provider-reported status from a server-side Paystack verification response; not client supplied.';
comment on column public.payment_intents.provider_amount_minor
  is 'Actual amount reported by Paystack in minor units, kept separately from the expected intent amount.';
comment on column public.payment_intents.provider_currency
  is 'Actual currency reported by Paystack, kept separately from the expected intent currency.';

create or replace function mandate_private.capture_verified_payment_receipt()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_clearing_account uuid;
  v_suspense_account uuid;
  v_posting jsonb;
begin
  if new.provider_status in ('success', 'reversal pending', 'reversed')
    and new.provider_transaction_id is not null
    and new.verified_at is not null
    and new.provider_amount_minor is not null
    and new.provider_amount_minor > 0
    and new.provider_currency = 'KES' then

    insert into public.ledger_accounts(owner_type, organization_id, currency, account_code)
    values ('provider_clearing', null, 'KES', 'paystack-receivable')
    on conflict (owner_type, currency, account_code) where organization_id is null do nothing;

    insert into public.ledger_accounts(owner_type, organization_id, currency, account_code)
    values ('suspense', null, 'KES', 'unallocated-payment-receipts')
    on conflict (owner_type, currency, account_code) where organization_id is null do nothing;

    select id into strict v_clearing_account
    from public.ledger_accounts
    where owner_type = 'provider_clearing'
      and organization_id is null
      and currency = 'KES'
      and account_code = 'paystack-receivable';

    select id into strict v_suspense_account
    from public.ledger_accounts
    where owner_type = 'suspense'
      and organization_id is null
      and currency = 'KES'
      and account_code = 'unallocated-payment-receipts';

    v_posting := mandate_private.post_ledger_transaction(
      'payment_receipt_pending_allocation',
      'payment_intent',
      new.id,
      'paystack-payment-receipt:' || new.id::text,
      'Verified Paystack receipt pending purpose allocation',
      jsonb_build_array(
        jsonb_build_object(
          'account_id', v_clearing_account,
          'direction', 'debit',
          'amount_minor', new.provider_amount_minor,
          'currency', 'KES'
        ),
        jsonb_build_object(
          'account_id', v_suspense_account,
          'direction', 'credit',
          'amount_minor', new.provider_amount_minor,
          'currency', 'KES'
        )
      )
    );

    if v_posting->>'status' <> 'posted' then
      raise exception 'VERIFIED_PAYMENT_RECEIPT_LEDGER_POST_FAILED' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists payment_intents_capture_verified_receipt on public.payment_intents;

create trigger payment_intents_capture_verified_receipt
after update of provider_status, provider_transaction_id, provider_amount_minor, provider_currency, verified_at
on public.payment_intents
for each row
when (
  new.provider_status in ('success', 'reversal pending', 'reversed')
  and (
    old.provider_status is distinct from new.provider_status
    or old.provider_transaction_id is distinct from new.provider_transaction_id
    or old.provider_amount_minor is distinct from new.provider_amount_minor
    or old.provider_currency is distinct from new.provider_currency
    or old.verified_at is distinct from new.verified_at
  )
)
execute function mandate_private.capture_verified_payment_receipt();

create or replace function mandate_private.apply_verified_paystack_webhook_event(
  p_event_id uuid,
  p_provider_reference text,
  p_provider_transaction_id text,
  p_provider_status text,
  p_amount_minor bigint,
  p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_event public.payment_events%rowtype;
  v_intent public.payment_intents%rowtype;
  v_matches boolean;
  v_next_status public.payment_status;
begin
  select * into v_event
  from public.payment_events
  where id = p_event_id
  for update;

  if not found
    or v_event.provider <> 'paystack'
    or v_event.signature_verified is distinct from true
    or v_event.event_type <> 'charge.success'
    or v_event.provider_reference is distinct from p_provider_reference then
    raise exception 'INVALID_VERIFIED_PAYSTACK_EVENT' using errcode = '22023';
  end if;

  if v_event.processing_status = 'processed' then
    return jsonb_build_object('duplicate', true, 'processed', true);
  end if;

  select * into v_intent
  from public.payment_intents
  where provider = 'paystack'
    and provider_reference = p_provider_reference
  for update;

  if not found then
    update public.payment_events
    set processing_status = 'failed', processed_at = null
    where id = v_event.id;
    return jsonb_build_object('duplicate', false, 'processed', false, 'reason', 'PAYMENT_INTENT_NOT_FOUND');
  end if;

  v_matches := p_provider_status = 'success'
    and p_provider_transaction_id is not null
    and p_amount_minor > 0
    and p_provider_reference = v_intent.provider_reference
    and p_amount_minor = v_intent.amount_minor
    and p_currency = v_intent.currency;

  if v_intent.status = 'success'
    and v_intent.provider_transaction_id = p_provider_transaction_id then
    update public.payment_intents
    set provider_status = p_provider_status,
        provider_amount_minor = p_amount_minor,
        provider_currency = p_currency,
        verified_at = pg_catalog.now()
    where id = v_intent.id;

    update public.payment_events
    set processing_status = 'processed', processed_at = pg_catalog.now()
    where id = v_event.id;

    return jsonb_build_object('duplicate', true, 'processed', true, 'matched', true, 'status', 'success');
  end if;

  -- Only an initialized or pending intent may transition from charge.success.
  -- Even when the provider reports a real success with mismatched amount/currency,
  -- persist provider facts and capture any KES receipt to suspense for reconciliation.
  if v_intent.status not in ('initialized', 'pending') then
    update public.payment_events
    set processing_status = 'processed', processed_at = pg_catalog.now()
    where id = v_event.id;
    return jsonb_build_object(
      'duplicate', false,
      'processed', true,
      'matched', false,
      'reason', 'PAYMENT_INTENT_TERMINAL',
      'status', v_intent.status
    );
  end if;

  v_next_status := case when v_matches then 'success'::public.payment_status else 'exception'::public.payment_status end;

  update public.payment_intents
  set status = v_next_status,
      provider_transaction_id = p_provider_transaction_id,
      provider_status = p_provider_status,
      provider_amount_minor = case when p_amount_minor > 0 then p_amount_minor else null end,
      provider_currency = p_currency,
      verified_at = pg_catalog.now()
  where id = v_intent.id;

  update public.payment_events
  set processing_status = 'processed', processed_at = pg_catalog.now()
  where id = v_event.id;

  return jsonb_build_object(
    'duplicate', false,
    'processed', true,
    'matched', v_matches,
    'status', v_next_status
  );
end;
$$;

revoke all on function mandate_private.apply_verified_paystack_webhook_event(uuid,text,text,text,bigint,text)
  from public, anon, authenticated;
grant execute on function mandate_private.apply_verified_paystack_webhook_event(uuid,text,text,text,bigint,text)
  to service_role;

create or replace function public.apply_verified_paystack_webhook_event(
  p_event_id uuid,
  p_provider_reference text,
  p_provider_transaction_id text,
  p_provider_status text,
  p_amount_minor bigint,
  p_currency text
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $$
  select mandate_private.apply_verified_paystack_webhook_event(
    p_event_id, p_provider_reference, p_provider_transaction_id, p_provider_status, p_amount_minor, p_currency
  );
$$;

revoke all on function public.apply_verified_paystack_webhook_event(uuid,text,text,text,bigint,text)
  from public, anon, authenticated;
grant execute on function public.apply_verified_paystack_webhook_event(uuid,text,text,text,bigint,text)
  to service_role;

create or replace function mandate_private.apply_verified_paystack_payment_exception_event(
  p_event_id uuid,
  p_provider_reference text,
  p_provider_transaction_id text,
  p_provider_status text,
  p_amount_minor bigint,
  p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $
declare
  v_event public.payment_events%rowtype;
  v_intent public.payment_intents%rowtype;
  v_next_status public.payment_status;
begin
  select * into v_event
  from public.payment_events
  where id = p_event_id
  for update;

  if not found
    or v_event.provider <> 'paystack'
    or v_event.signature_verified is distinct from true
    or v_event.provider_reference is distinct from p_provider_reference
    or not (
      left(v_event.event_type, 7) = 'refund.'
      or left(v_event.event_type, 15) = 'charge.dispute.'
    )
    or p_provider_transaction_id is null
    or p_provider_status is null
    or p_amount_minor <= 0
    or p_currency is null then
    raise exception 'INVALID_VERIFIED_PAYSTACK_EXCEPTION_EVENT' using errcode = '22023';
  end if;

  if v_event.processing_status = 'processed' then
    return jsonb_build_object('duplicate', true, 'processed', true);
  end if;

  select * into v_intent
  from public.payment_intents
  where provider = 'paystack'
    and provider_reference = p_provider_reference
  for update;

  if not found then
    update public.payment_events
    set processing_status = 'failed', processed_at = null
    where id = v_event.id;
    return jsonb_build_object('duplicate', false, 'processed', false, 'reason', 'PAYMENT_INTENT_NOT_FOUND');
  end if;

  v_next_status := case
    when v_intent.status in ('initialized', 'pending', 'success') then 'exception'::public.payment_status
    else v_intent.status
  end;

  update public.payment_intents
  set status = v_next_status,
      provider_transaction_id = p_provider_transaction_id,
      provider_status = p_provider_status,
      provider_amount_minor = p_amount_minor,
      provider_currency = p_currency,
      verified_at = pg_catalog.now()
  where id = v_intent.id;

  update public.payment_events
  set processing_status = 'processed', processed_at = pg_catalog.now()
  where id = v_event.id;

  return jsonb_build_object(
    'duplicate', false,
    'processed', true,
    'status', v_next_status,
    'provider_status', p_provider_status
  );
end;
$;

revoke all on function mandate_private.apply_verified_paystack_payment_exception_event(uuid,text,text,text,bigint,text)
  from public, anon, authenticated;
grant execute on function mandate_private.apply_verified_paystack_payment_exception_event(uuid,text,text,text,bigint,text)
  to service_role;

create or replace function public.apply_verified_paystack_payment_exception_event(
  p_event_id uuid,
  p_provider_reference text,
  p_provider_transaction_id text,
  p_provider_status text,
  p_amount_minor bigint,
  p_currency text
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $
  select mandate_private.apply_verified_paystack_payment_exception_event($1, $2, $3, $4, $5, $6);
$;

revoke all on function public.apply_verified_paystack_payment_exception_event(uuid,text,text,text,bigint,text)
  from public, anon, authenticated;
grant execute on function public.apply_verified_paystack_payment_exception_event(uuid,text,text,text,bigint,text)
  to service_role;

-- Remove the earlier unverified exception RPC so all refund/dispute state
-- transitions must carry a server-verified provider transaction response.
drop function if exists public.apply_paystack_payment_exception_event(uuid,text);
drop function if exists mandate_private.apply_paystack_payment_exception_event(uuid,text);

comment on function mandate_private.capture_verified_payment_receipt()
  is 'Captures actual provider-reported KES success and reversal-state amounts to clearing and suspense, including mismatched payments requiring reconciliation. Never books the expected intent amount as cash received.';
