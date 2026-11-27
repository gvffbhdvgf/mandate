-- Signed Paystack refund/dispute notifications must freeze the affected payment
-- for reconciliation. They do not prove final refund settlement and must not
-- automatically reverse funds or revoke already-consumed voting entitlements.

create or replace function mandate_private.apply_paystack_payment_exception_event(
  p_event_id uuid,
  p_provider_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_event public.payment_events%rowtype;
  v_intent public.payment_intents%rowtype;
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

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
      or left(v_event.event_type, 14) = 'charge.dispute.'
    ) then
    raise exception 'INVALID_PAYSTACK_EXCEPTION_EVENT' using errcode = '22023';
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

  -- A refund/dispute event is a financial exception, not proof of final
  -- settlement. Freeze initialized/pending/success intents pending reconciliation.
  if v_intent.status in ('initialized', 'pending', 'success') then
    update public.payment_intents
    set status = 'exception'
    where id = v_intent.id;
  end if;

  update public.payment_events
  set processing_status = 'processed', processed_at = pg_catalog.now()
  where id = v_event.id;

  return jsonb_build_object(
    'duplicate', false,
    'processed', true,
    'status', case when v_intent.status in ('initialized', 'pending', 'success') then 'exception' else v_intent.status::text end
  );
end;
$$;

revoke all on function mandate_private.apply_paystack_payment_exception_event(uuid,text)
  from public, anon, authenticated;
grant execute on function mandate_private.apply_paystack_payment_exception_event(uuid,text)
  to service_role;

create or replace function public.apply_paystack_payment_exception_event(
  p_event_id uuid,
  p_provider_reference text
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $$
  select mandate_private.apply_paystack_payment_exception_event($1, $2);
$$;

revoke all on function public.apply_paystack_payment_exception_event(uuid,text)
  from public, anon, authenticated;
grant execute on function public.apply_paystack_payment_exception_event(uuid,text)
  to service_role;

comment on function mandate_private.apply_paystack_payment_exception_event(uuid,text)
  is 'Freezes a payment intent on signed Paystack refund/dispute events for explicit reconciliation. It does not infer final refund settlement, reverse ledger entries, or revoke vote credits.';
