-- Rollback-only acceptance: signed refund/dispute events freeze payment intents.
begin;

insert into public.payment_intents(
  id, purpose, provider, provider_reference, amount_minor, currency, status,
  idempotency_key
) values (
  '11111111-1111-4111-8111-111111111139',
  'platform_fee', 'paystack', 'mandate-refund-exception-smoke-20261127',
  8400, 'KES', 'pending', 'mandate-refund-exception-smoke-20261127'
);

update public.payment_intents
set status = 'success',
    provider_transaction_id = 'paystack-refund-exception-transaction',
    verified_at = now()
where id = '11111111-1111-4111-8111-111111111139';

insert into public.payment_events(
  id, provider, provider_event_key, provider_reference, event_type,
  signature_verified, redacted_payload, processing_status
) values (
  '22222222-2222-4222-8222-222222222239',
  'paystack', 'paystack:refund.pending:refund-exception-smoke',
  'mandate-refund-exception-smoke-20261127', 'refund.pending',
  true, '{"status":"pending","amount":"8400","currency":"KES","resource_id":"refund-exception-smoke"}'::jsonb,
  'received'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select public.apply_paystack_payment_exception_event(
  '22222222-2222-4222-8222-222222222239',
  'mandate-refund-exception-smoke-20261127'
);

select public.apply_paystack_payment_exception_event(
  '22222222-2222-4222-8222-222222222239',
  'mandate-refund-exception-smoke-20261127'
);

reset role;

do $$
declare
  v_status public.payment_status;
  v_event_status public.payment_event_status;
  v_receipt_count bigint;
begin
  select status into v_status
  from public.payment_intents
  where id = '11111111-1111-4111-8111-111111111139';

  select processing_status into v_event_status
  from public.payment_events
  where id = '22222222-2222-4222-8222-222222222239';

  if v_status <> 'exception' then
    raise exception 'REFUND_EVENT_MUST_FREEZE_PAYMENT';
  end if;

  if v_event_status <> 'processed' then
    raise exception 'REFUND_EVENT_MUST_BE_ACKNOWLEDGED';
  end if;

  select count(*) into v_receipt_count
  from public.ledger_transactions
  where source_type = 'payment_intent'
    and source_id = '11111111-1111-4111-8111-111111111139'
    and transaction_type = 'payment_receipt_pending_allocation';

  if v_receipt_count <> 1 then
    raise exception 'REFUND_EVENT_MUST_NOT_AUTO_REVERSE_LEDGER';
  end if;

  if not has_function_privilege('service_role', 'public.apply_paystack_payment_exception_event(uuid,text)', 'execute')
    or has_function_privilege('authenticated', 'public.apply_paystack_payment_exception_event(uuid,text)', 'execute')
    or has_function_privilege('anon', 'public.apply_paystack_payment_exception_event(uuid,text)', 'execute') then
    raise exception 'PAYSTACK_EXCEPTION_RPC_GRANTS_INVALID';
  end if;
end;
$$;

rollback;
