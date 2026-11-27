-- Rollback-only acceptance: verified payments post atomically to unallocated suspense.
begin;

insert into public.payment_intents(
  id, purpose, provider, provider_reference, amount_minor, currency, status,
  provider_transaction_id, idempotency_key
) values (
  '11111111-1111-4111-8111-111111111138',
  'platform_fee', 'paystack', 'mandate-suspense-ledger-smoke-20261127',
  7200, 'KES', 'pending', null, 'mandate-suspense-ledger-smoke-20261127'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

update public.payment_intents
set status = 'success',
    provider_transaction_id = 'paystack-suspense-ledger-transaction',
    provider_status = 'success',
    provider_amount_minor = 7200,
    provider_currency = 'KES',
    verified_at = now()
where id = '11111111-1111-4111-8111-111111111138';

-- Repeating the same terminal state must not create another ledger posting.
update public.payment_intents
set status = 'success'
where id = '11111111-1111-4111-8111-111111111138';

reset role;

do $$
declare
  v_transaction_id uuid;
  v_entries bigint;
  v_debits bigint;
  v_credits bigint;
  v_duplicate_count bigint;
begin
  select id into v_transaction_id
  from public.ledger_transactions
  where source_type = 'payment_intent'
    and source_id = '11111111-1111-4111-8111-111111111138'
    and transaction_type = 'payment_receipt_pending_allocation';

  if v_transaction_id is null then
    raise exception 'VERIFIED_RECEIPT_LEDGER_TRANSACTION_MISSING';
  end if;

  select count(*),
         coalesce(sum(amount_minor) filter (where direction = 'debit'), 0),
         coalesce(sum(amount_minor) filter (where direction = 'credit'), 0)
  into v_entries, v_debits, v_credits
  from public.ledger_entries
  where transaction_id = v_transaction_id;

  if v_entries <> 2 or v_debits <> 7200 or v_credits <> 7200 then
    raise exception 'VERIFIED_RECEIPT_LEDGER_MUST_BE_BALANCED';
  end if;

  if not exists (
    select 1 from public.ledger_entries e
    join public.ledger_accounts a on a.id = e.account_id
    where e.transaction_id = v_transaction_id
      and e.direction = 'debit'
      and a.owner_type = 'provider_clearing'
      and a.account_code = 'paystack-receivable'
  ) then
    raise exception 'VERIFIED_RECEIPT_PROVIDER_CLEARING_DEBIT_MISSING';
  end if;

  if not exists (
    select 1 from public.ledger_entries e
    join public.ledger_accounts a on a.id = e.account_id
    where e.transaction_id = v_transaction_id
      and e.direction = 'credit'
      and a.owner_type = 'suspense'
      and a.account_code = 'unallocated-payment-receipts'
  ) then
    raise exception 'VERIFIED_RECEIPT_SUSPENSE_CREDIT_MISSING';
  end if;

  select count(*) into v_duplicate_count
  from public.ledger_transactions
  where source_type = 'payment_intent'
    and source_id = '11111111-1111-4111-8111-111111111138'
    and transaction_type = 'payment_receipt_pending_allocation';

  if v_duplicate_count <> 1 then
    raise exception 'VERIFIED_RECEIPT_LEDGER_POSTING_MUST_BE_IDEMPOTENT';
  end if;

  if not has_table_privilege('service_role', 'public.payment_intents', 'select')
    or not has_table_privilege('service_role', 'public.payment_intents', 'update')
    or not has_table_privilege('service_role', 'public.payment_events', 'select')
    or not has_table_privilege('service_role', 'public.payment_events', 'insert')
    or not has_table_privilege('service_role', 'public.payment_events', 'update') then
    raise exception 'PAYMENT_EDGE_SERVICE_ROLE_GRANTS_MISSING';
  end if;

  if has_table_privilege('authenticated', 'public.payment_intents', 'update')
    or has_table_privilege('anon', 'public.payment_events', 'insert') then
    raise exception 'PAYMENT_TABLES_MUST_REMAIN_PRIVATE_TO_BROWSER_ROLES';
  end if;
end;
$$;

rollback;
