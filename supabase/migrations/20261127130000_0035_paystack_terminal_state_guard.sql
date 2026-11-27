-- Keep late or duplicate charge.success events from resurrecting terminal payments.
-- Refund/reversal and exception states require explicit reconciliation, not a success webhook.

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
    and p_provider_reference = v_intent.provider_reference
    and p_amount_minor = v_intent.amount_minor
    and p_currency = v_intent.currency;

  if v_intent.status = 'success'
    and v_intent.provider_transaction_id = p_provider_transaction_id then
    update public.payment_events
    set processing_status = 'processed', processed_at = pg_catalog.now()
    where id = v_event.id;
    return jsonb_build_object('duplicate', true, 'processed', true, 'matched', true, 'status', 'success');
  end if;

  -- Only an initialized or pending intent may transition from charge.success.
  -- Success with another transaction ID, refunds, reversals, failures and
  -- exception states are immutable here and require an explicit reconciliation.
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
