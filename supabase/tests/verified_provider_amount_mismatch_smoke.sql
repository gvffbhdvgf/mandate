-- Rollback-only acceptance: a provider success with the wrong amount is captured at
-- the actual provider amount and remains in exception for reconciliation.
begin;

insert into public.payment_intents(
  id, purpose, provider, provider_reference, amount_minor, currency, status,
  idempotency_key
) values (
  '11111111-1111-4111-8111-111111111140',
  'platform_fee', 'paystack', 'mandate-provider-mismatch-smoke-20261127',
  8400, 'KES', 'pending', 'mandate-provider-mismatch-smoke-20261127'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

update public.payment_intents
set status = 'exception',
    provider_transaction_id = 'paystack-provider-mismatch-transaction',
    provider_status = 'success',
    provider_amount_minor = 7900,
    provider_currency = 'KES',
    verified_at = now()
where id = '11111111-1111-4111-8111-111111111140';

-- Repeated capture of the same provider transaction must be idempotent.
update public.payment_intents
set verified_at = verified_at + interval '1 second'
where id = '11111111-1111-4111-8111-111111111140';

reset role;

do $$
declare
  v_status public.payment_status;
  v_debits bigint;
  v_credits bigint;
  v_transactions bigint;
begin
  select status into v_status
  from public.payment_intents
  where id = '11111111-1111-4111-8111-111111111140';

  if v_status <> 'exception' then
    raise exception 'MISMATCHED_PROVIDER_SUCCESS_MUST_REMAIN_EXCEPTION';
  end if;

  select count(*),
         coalesce(sum(e.amount_minor) filter (where e.direction = 'debit'), 0),
         coalesce(sum(e.amount_minor) filter (where e.direction = 'credit'), 0)
  into v_transactions, v_debits, v_credits
  from public.ledger_transactions t
  join public.ledger_entries e on e.transaction_id = t.id
  where t.source_type = 'payment_intent'
    and t.source_id = '11111111-1111-4111-8111-111111111140'
    and t.transaction_type = 'payment_receipt_pending_allocation';

  if v_transactions <> 2 or v_debits <> 7900 or v_credits <> 7900 then
    raise exception 'MISMATCHED_PROVIDER_SUCCESS_MUST_CAPTURE_ACTUAL_AMOUNT_ONCE';
  end if;

  if not exists (
    select 1
    from public.ledger_transactions t
    join public.ledger_entries e on e.transaction_id = t.id
    join public.ledger_accounts a on a.id = e.account_id
    where t.source_id = '11111111-1111-4111-8111-111111111140'
      and e.direction = 'credit'
      and e.amount_minor = 7900
      and a.owner_type = 'suspense'
      and a.account_code = 'unallocated-payment-receipts'
  ) then
    raise exception 'MISMATCHED_PROVIDER_SUCCESS_SUSPENSE_CREDIT_MISSING';
  end if;
end;
$$;

rollback;
