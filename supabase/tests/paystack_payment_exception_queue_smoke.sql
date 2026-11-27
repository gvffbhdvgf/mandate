-- Rollback-only acceptance: exception queue exposes evidence without PII or mutations.
begin;

insert into public.payment_intents(
  id, purpose, provider, provider_reference, amount_minor, currency, status, idempotency_key
) values (
  '11111111-1111-4111-8111-111111111145',
  'platform_fee', 'paystack', 'mandate-exception-queue-smoke-20261127',
  8400, 'KES', 'initialized', 'mandate-exception-queue-smoke-20261127'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

update public.payment_intents
set status = 'exception',
    provider_transaction_id = 'paystack-exception-queue-transaction',
    provider_status = 'success',
    provider_amount_minor = 8400,
    provider_currency = 'KES',
    verified_at = now()
where id = '11111111-1111-4111-8111-111111111145';

insert into public.payment_events(
  provider, provider_event_key, provider_reference, event_type,
  signature_verified, redacted_payload, processing_status
) values (
  'paystack', 'paystack:refund.processed:exception-queue-smoke',
  'mandate-exception-queue-smoke-20261127', 'refund.processed',
  true, '{"status":"processed","amount":"8400","currency":"KES"}'::jsonb, 'processed'
);

reset role;

do $$
declare
  v_row record;
begin
  select * into v_row
  from public.paystack_payment_exception_queue
  where provider_reference = 'mandate-exception-queue-smoke-20261127';

  if not found
    or v_row.payment_intent_status <> 'exception'
    or v_row.event_count <> 1
    or not ('refund.processed' = any(v_row.event_types))
    or v_row.receipt_posted is distinct from true
    or v_row.settlement_row_count <> 0 then
    raise exception 'PAYSTACK_EXCEPTION_QUEUE_EVIDENCE_MISSING';
  end if;

  if has_table_privilege('authenticated', 'public.paystack_payment_exception_queue', 'select')
    or has_table_privilege('anon', 'public.paystack_payment_exception_queue', 'select') then
    raise exception 'PAYSTACK_EXCEPTION_QUEUE_MUST_REMAIN_SERVER_ONLY';
  end if;

  if not has_table_privilege('service_role', 'public.paystack_payment_exception_queue', 'select') then
    raise exception 'PAYSTACK_EXCEPTION_QUEUE_SERVICE_ROLE_GRANT_MISSING';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'paystack_payment_exception_queue'
      and column_name in ('email','phone','contact_hash','redacted_payload')
  ) then
    raise exception 'PAYSTACK_EXCEPTION_QUEUE_MUST_NOT_EXPOSE_CONTACT_OR_RAW_EVENT_PAYLOAD';
  end if;
end;
$$;

rollback;
