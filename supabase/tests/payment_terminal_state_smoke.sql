-- Rollback-only acceptance: a late charge.success webhook must not resurrect a refunded intent.
begin;

insert into public.payment_intents(
  id, purpose, provider, provider_reference, amount_minor, currency, status,
  provider_transaction_id, idempotency_key
) values (
  '11111111-1111-4111-8111-111111111135', 'platform_fee', 'paystack', 'mandate-terminal-state-smoke-20261127',
  2500, 'KES', 'refunded', 'paystack-original-transaction',
  'mandate-terminal-state-smoke-20261127'
);

insert into public.payment_events(
  id, provider, provider_event_key, provider_reference, event_type,
  signature_verified, processing_status
) values (
  '11111111-1111-4111-8111-111111111136', 'paystack', 'paystack:charge.success:terminal-smoke',
  'mandate-terminal-state-smoke-20261127', 'charge.success',
  true, 'received'
);

set local role service_role;
select public.apply_verified_paystack_webhook_event(
  '11111111-1111-4111-8111-111111111136',
  'mandate-terminal-state-smoke-20261127',
  'paystack-original-transaction',
  'success',
  2500,
  'KES'
);
reset role;

do $$
begin
  if (select status from public.payment_intents where provider_reference='mandate-terminal-state-smoke-20261127') <> 'refunded' then
    raise exception 'REFUNDED_PAYMENT_MUST_NOT_BE_RESURRECTED';
  end if;
  if (select processing_status from public.payment_events where provider_event_key='paystack:charge.success:terminal-smoke') <> 'processed' then
    raise exception 'TERMINAL_WEBHOOK_EVENT_MUST_BE_ACKNOWLEDGED';
  end if;
end;
$$;

rollback;
