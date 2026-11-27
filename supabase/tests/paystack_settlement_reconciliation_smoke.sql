-- Rollback-only acceptance: settlement rows match provider facts and suspense receipts.
begin;

insert into public.payment_intents(
  id, purpose, provider, provider_reference, amount_minor, currency, status,
  provider_transaction_id, idempotency_key
) values (
  '11111111-1111-4111-8111-111111111144',
  'platform_fee', 'paystack', 'mandate-settlement-recon-smoke-20261127',
  12500, 'KES', 'pending', null, 'mandate-settlement-recon-smoke-20261127'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

insert into public.payment_events(
  id, provider, provider_event_key, provider_reference, event_type,
  signature_verified, redacted_payload, processing_status
) values (
  '22222222-2222-4222-8222-222222222244',
  'paystack', 'paystack:charge.success:settlement-recon-smoke',
  'mandate-settlement-recon-smoke-20261127', 'charge.success',
  true, '{"status":"success","amount":"12500","currency":"KES","transaction_id":"paystack-settlement-recon-transaction"}'::jsonb,
  'received'
);

select public.apply_verified_paystack_webhook_event(
  '22222222-2222-4222-8222-222222222244',
  'mandate-settlement-recon-smoke-20261127',
  'paystack-settlement-recon-transaction',
  'success',
  12500,
  'KES'
);

with settlement as (
  insert into public.paystack_settlements(
    environment, provider_settlement_id, status, currency,
    provider_total_amount_minor, provider_effective_amount_minor,
    provider_total_processed_minor, provider_total_fees_minor, settled_at
  ) values (
    'test', 'mandate-settlement-recon-smoke-20261127', 'success', 'KES',
    12138, 12138, 12500, 362, now()
  )
  returning id
)
insert into public.paystack_settlement_transactions(
  settlement_id, environment, provider_transaction_id, provider_reference, provider_status,
  amount_minor, currency, fee_minor, paid_at
)
select id, 'test', 'paystack-settlement-recon-transaction',
  'mandate-settlement-recon-smoke-20261127', 'success',
  12500, 'KES', 362, now()
from settlement;

reset role;

do $$
declare
  v_status text;
begin
  select reconciliation_status into v_status
  from public.paystack_settlement_reconciliation
  where provider_reference = 'mandate-settlement-recon-smoke-20261127';

  if v_status is distinct from 'matched_to_receipt' then
    raise exception 'PAYSTACK_SETTLEMENT_RECEIPT_MATCH_FAILED: %', v_status;
  end if;

  if not exists (
    select 1 from public.payment_intents
    where id = '11111111-1111-4111-8111-111111111144'
      and provider_status = 'success'
      and provider_amount_minor = 12500
      and provider_currency = 'KES'
      and provider_transaction_id = 'paystack-settlement-recon-transaction'
  ) then
    raise exception 'PAYSTACK_WEBHOOK_MUST_PERSIST_VERIFIED_PROVIDER_FACTS';
  end if;

  if has_table_privilege('authenticated', 'public.paystack_settlements', 'select')
    or has_table_privilege('anon', 'public.paystack_settlement_transactions', 'insert')
    or has_table_privilege('authenticated', 'public.paystack_settlement_reconciliation', 'select') then
    raise exception 'PAYSTACK_SETTLEMENT_RECONCILIATION_MUST_REMAIN_SERVER_ONLY';
  end if;

  if not has_table_privilege('service_role', 'public.paystack_settlements', 'insert')
    or not has_table_privilege('service_role', 'public.paystack_settlement_transactions', 'insert')
    or not has_table_privilege('service_role', 'public.paystack_settlement_reconciliation', 'select') then
    raise exception 'PAYSTACK_SETTLEMENT_SERVICE_ROLE_GRANTS_MISSING';
  end if;
end;
$$;

rollback;
