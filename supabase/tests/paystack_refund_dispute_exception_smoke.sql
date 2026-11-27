-- Rollback-only acceptance: signed refund/dispute events freeze payment intents.
-- Model the real provider sequence: capture the verified charge receipt once,
-- then process the signed refund event with independently verified provider facts.
begin;

insert into public.payment_intents(
  id, purpose, provider, provider_reference, amount_minor, currency, status,
  idempotency_key
) values (
  '11111111-1111-4111-8111-111111111139',
  'platform_fee', 'paystack', 'mandate-refund-exception-smoke-20261127',
  8400, 'KES', 'pending', 'mandate-refund-exception-smoke-20261127'
);

insert into public.payment_events(
  id, provider, provider_event_key, provider_reference, event_type,
  signature_verified, redacted_payload, processing_status
) values (
  '22222222-2222-4222-8222-222222222238',
  'paystack', 'paystack:charge.success:refund-exception-smoke',
  'mandate-refund-exception-smoke-20261127', 'charge.success',
  true, '{"status":"success","amount":"8400","currency":"KES"}'::jsonb,
  'received'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select public.apply_verified_paystack_webhook_event(
  '22222222-2222-4222-8222-222222222238',
  'mandate-refund-exception-smoke-20261127',
  'paystack-refund-exception-transaction',
  'success',
  8400,
  'KES'
);

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

select public.apply_verified_paystack_payment_exception_event(
  '22222222-2222-4222-8222-222222222239',
  'mandate-refund-exception-smoke-20261127',
  'paystack-refund-exception-transaction',
  'reversal pending',
  8400,
  'KES'
);

-- Re-delivery must remain idempotent and must not duplicate the receipt.
select public.apply_verified_paystack_payment_exception_event(
  '22222222-2222-4222-8222-222222222239',
  'mandate-refund-exception-smoke-20261127',
  'paystack-refund-exception-transaction',
  'reversal pending',
  8400,
  'KES'
);

reset role;

do $$
declare
  v_status public.payment_status;
  v_event_status public.payment_event_status;
  v_receipt_count bigint;
  v_debits bigint;
  v_credits bigint;
  v_provider_status text;
  v_provider_amount bigint;
begin
  select status, provider_status, provider_amount_minor
  into v_status, v_provider_status, v_provider_amount
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

  if v_provider_status <> 'reversal pending' or v_provider_amount <> 8400 then
    raise exception 'REFUND_EVENT_MUST_PERSIST_VERIFIED_PROVIDER_FACTS';
  end if;

  select count(*),
         coalesce(sum(e.amount_minor) filter (where e.direction = 'debit'), 0),
         coalesce(sum(e.amount_minor) filter (where e.direction = 'credit'), 0)
  into v_receipt_count, v_debits, v_credits
  from public.ledger_transactions t
  join public.ledger_entries e on e.transaction_id = t.id
  where t.source_type = 'payment_intent'
    and t.source_id = '11111111-1111-4111-8111-111111111139'
    and t.transaction_type = 'payment_receipt_pending_allocation';

  if v_receipt_count <> 2 or v_debits <> 8400 or v_credits <> 8400 then
    raise exception 'REFUND_EVENT_FIRST_MUST_CAPTURE_ORIGINAL_RECEIPT_ONCE';
  end if;

  if not has_function_privilege('service_role', 'public.apply_verified_paystack_payment_exception_event(uuid,text,text,text,bigint,text)', 'execute')
    or has_function_privilege('authenticated', 'public.apply_verified_paystack_payment_exception_event(uuid,text,text,text,bigint,text)', 'execute')
    or has_function_privilege('anon', 'public.apply_verified_paystack_payment_exception_event(uuid,text,text,text,bigint,text)', 'execute') then
    raise exception 'PAYSTACK_EXCEPTION_RPC_GRANTS_INVALID';
  end if;
end;
$$;

rollback;
