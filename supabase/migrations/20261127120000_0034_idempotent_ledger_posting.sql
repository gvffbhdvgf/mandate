-- Add an append-only, idempotent balanced-posting primitive.
-- This is an accounting mechanism only; it does not choose payment-purpose allocations.

create or replace function mandate_private.guard_ledger_entry_immutability()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'LEDGER_ENTRIES_APPEND_ONLY' using errcode = '55000';
  end if;

  if not exists (
    select 1 from public.ledger_transactions t
    where t.id = new.transaction_id and t.status = 'pending'
  ) then
    raise exception 'LEDGER_ENTRIES_REQUIRE_PENDING_TRANSACTION' using errcode = '55000';
  end if;

  return new;
end;
$$;

-- Migration 0007 already protects posted ledger entries and transactions
-- against update/delete. This guard permits inserts only while pending.
create trigger ledger_entries_pending_insert_guard
before insert on public.ledger_entries
for each row execute function mandate_private.guard_ledger_entry_immutability();

revoke all on function mandate_private.guard_ledger_entry_immutability()
  from public, anon, authenticated;

create or replace function mandate_private.post_ledger_transaction(
  p_transaction_type text,
  p_source_type text,
  p_source_id uuid,
  p_idempotency_key text,
  p_description text,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_existing public.ledger_transactions%rowtype;
  v_transaction_id uuid;
  v_input_entries jsonb;
  v_existing_entries jsonb;
  v_entry_count integer;
  v_valid_account_count integer;
  v_debits numeric;
  v_credits numeric;
  v_currency_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  if p_transaction_type is null or length(btrim(p_transaction_type)) not between 2 and 80
    or p_source_type is null or length(btrim(p_source_type)) not between 2 and 80
    or p_source_id is null
    or p_idempotency_key is null or length(p_idempotency_key) not between 16 and 200 then
    raise exception 'INVALID_LEDGER_TRANSACTION_INPUT' using errcode = '22023';
  end if;

  if jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'LEDGER_ENTRIES_MUST_BE_ARRAY' using errcode = '22023';
  end if;

  v_entry_count := jsonb_array_length(p_entries);
  if v_entry_count < 2 or v_entry_count > 50 then
    raise exception 'LEDGER_ENTRY_COUNT_INVALID' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_entries) e(value)
    where jsonb_typeof(e.value) is distinct from 'object'
      or case when jsonb_typeof(e.value) = 'object' then jsonb_object_length(e.value) else -1 end <> 4
      or not (e.value ?& array['account_id','direction','amount_minor','currency'])
      or jsonb_typeof(e.value->'account_id') is distinct from 'string'
      or jsonb_typeof(e.value->'direction') is distinct from 'string'
      or jsonb_typeof(e.value->'amount_minor') is distinct from 'number'
      or (e.value->>'amount_minor') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(e.value->'currency') is distinct from 'string'
  ) then
    raise exception 'LEDGER_ENTRY_SHAPE_INVALID' using errcode = '22023';
  end if;

  select
    jsonb_agg(jsonb_build_object(
      'account_id', e.account_id,
      'direction', e.direction,
      'amount_minor', e.amount_minor,
      'currency', e.currency
    ) order by e.account_id, e.direction, e.amount_minor),
    coalesce(sum(e.amount_minor) filter (where e.direction = 'debit'), 0),
    coalesce(sum(e.amount_minor) filter (where e.direction = 'credit'), 0),
    count(distinct e.currency)
  into v_input_entries, v_debits, v_credits, v_currency_count
  from jsonb_to_recordset(p_entries) as e(
    account_id uuid,
    direction public.ledger_direction,
    amount_minor bigint,
    currency text
  );

  if v_debits <= 0 or v_debits <> v_credits or v_currency_count <> 1 then
    raise exception 'LEDGER_TRANSACTION_UNBALANCED' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_entries) as e(
      account_id uuid,
      direction public.ledger_direction,
      amount_minor bigint,
      currency text
    )
    where e.amount_minor is null or e.amount_minor <= 0 or e.currency <> 'KES'
  ) then
    raise exception 'LEDGER_ENTRY_AMOUNT_OR_CURRENCY_INVALID' using errcode = '23514';
  end if;

  select count(*) into v_valid_account_count
  from jsonb_to_recordset(p_entries) as e(
    account_id uuid,
    direction public.ledger_direction,
    amount_minor bigint,
    currency text
  )
  join public.ledger_accounts a on a.id = e.account_id and a.currency = e.currency;

  if v_valid_account_count <> v_entry_count then
    raise exception 'LEDGER_ACCOUNT_OR_CURRENCY_MISMATCH' using errcode = '23503';
  end if;

  insert into public.ledger_transactions(
    transaction_type, source_type, source_id, idempotency_key, status, description
  ) values (
    btrim(p_transaction_type), btrim(p_source_type), p_source_id, p_idempotency_key, 'pending', p_description
  )
  on conflict (idempotency_key) do nothing
  returning id into v_transaction_id;

  if v_transaction_id is null then
    select * into v_existing
    from public.ledger_transactions
    where idempotency_key = p_idempotency_key
    for update;

    if not found
      or v_existing.transaction_type <> p_transaction_type
      or v_existing.source_type <> p_source_type
      or v_existing.source_id is distinct from p_source_id then
      raise exception 'LEDGER_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;

    select jsonb_agg(jsonb_build_object(
      'account_id', e.account_id,
      'direction', e.direction,
      'amount_minor', e.amount_minor,
      'currency', e.currency
    ) order by e.account_id, e.direction, e.amount_minor)
    into v_existing_entries
    from public.ledger_entries e
    where e.transaction_id = v_existing.id;

    if v_existing_entries is distinct from v_input_entries or v_existing.status <> 'posted' then
      raise exception 'LEDGER_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;

    return jsonb_build_object('id', v_existing.id, 'status', v_existing.status, 'duplicate', true);
  end if;

  insert into public.ledger_entries(transaction_id, account_id, direction, amount_minor, currency)
  select v_transaction_id, e.account_id, e.direction, e.amount_minor, e.currency
  from jsonb_to_recordset(p_entries) as e(
    account_id uuid,
    direction public.ledger_direction,
    amount_minor bigint,
    currency text
  );

  update public.ledger_transactions
  set status = 'posted'
  where id = v_transaction_id;

  return jsonb_build_object('id', v_transaction_id, 'status', 'posted', 'duplicate', false);
end;
$$;

revoke all on function mandate_private.post_ledger_transaction(text,text,uuid,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function mandate_private.post_ledger_transaction(text,text,uuid,text,text,jsonb)
  to service_role;

create or replace function public.post_ledger_transaction(
  p_transaction_type text,
  p_source_type text,
  p_source_id uuid,
  p_idempotency_key text,
  p_description text,
  p_entries jsonb
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $$
  select mandate_private.post_ledger_transaction(
    p_transaction_type, p_source_type, p_source_id, p_idempotency_key, p_description, p_entries
  );
$$;

revoke all on function public.post_ledger_transaction(text,text,uuid,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.post_ledger_transaction(text,text,uuid,text,text,jsonb)
  to service_role;

comment on function mandate_private.post_ledger_transaction(text,text,uuid,text,text,jsonb)
  is 'Service-role-only idempotent balanced ledger posting primitive. Callers must supply policy-approved account allocations; this function does not infer payment-purpose accounting.';
