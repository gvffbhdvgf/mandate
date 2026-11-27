begin;

-- Seed ledger accounts as the database owner. The API service role intentionally
-- has no direct table privileges; it may only call the controlled posting RPC.
do $$
declare
  v_clearing uuid;
  v_revenue uuid;
  v_source uuid := gen_random_uuid();
begin
  insert into public.ledger_accounts(owner_type, organization_id, currency, account_code)
  values ('provider_clearing', null, 'KES', 'acceptance-clearing')
  returning id into v_clearing;

  insert into public.ledger_accounts(owner_type, organization_id, currency, account_code)
  values ('platform_revenue', null, 'KES', 'acceptance-revenue')
  returning id into v_revenue;

  perform set_config('test.ledger_clearing', v_clearing::text, true);
  perform set_config('test.ledger_revenue', v_revenue::text, true);
  perform set_config('test.ledger_source', v_source::text, true);
end;
$$;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

-- The service role can post only through the controlled RPC.
do $$
declare
  v_clearing uuid := current_setting('test.ledger_clearing')::uuid;
  v_revenue uuid := current_setting('test.ledger_revenue')::uuid;
  v_source uuid := current_setting('test.ledger_source')::uuid;
  v_result jsonb;
  v_duplicate jsonb;
  v_rejected boolean := false;
begin
  v_result := public.post_ledger_transaction(
    'acceptance_payment',
    'acceptance_test',
    v_source,
    'ledger-acceptance-idempotency-0001',
    'Rollback-only ledger acceptance fixture',
    jsonb_build_array(
      jsonb_build_object('account_id', v_clearing, 'direction', 'debit', 'amount_minor', 12500, 'currency', 'KES'),
      jsonb_build_object('account_id', v_revenue, 'direction', 'credit', 'amount_minor', 12500, 'currency', 'KES')
    )
  );

  if v_result->>'status' <> 'posted' or (v_result->>'duplicate')::boolean then
    raise exception 'LEDGER_FIRST_POST_FAILED';
  end if;
  perform set_config('test.ledger_transaction', v_result->>'id', true);

  v_duplicate := public.post_ledger_transaction(
    'acceptance_payment',
    'acceptance_test',
    v_source,
    'ledger-acceptance-idempotency-0001',
    'Rollback-only ledger acceptance fixture',
    jsonb_build_array(
      jsonb_build_object('account_id', v_clearing, 'direction', 'debit', 'amount_minor', 12500, 'currency', 'KES'),
      jsonb_build_object('account_id', v_revenue, 'direction', 'credit', 'amount_minor', 12500, 'currency', 'KES')
    )
  );

  if v_duplicate->>'id' <> v_result->>'id' or not (v_duplicate->>'duplicate')::boolean then
    raise exception 'LEDGER_DUPLICATE_NOT_IDEMPOTENT';
  end if;

  begin
    perform public.post_ledger_transaction(
      'acceptance_payment',
      'acceptance_test',
      v_source,
      'ledger-acceptance-idempotency-0001',
      'Rollback-only ledger acceptance fixture',
      jsonb_build_array(
        jsonb_build_object('account_id', v_clearing, 'direction', 'debit', 'amount_minor', 12501, 'currency', 'KES'),
        jsonb_build_object('account_id', v_revenue, 'direction', 'credit', 'amount_minor', 12501, 'currency', 'KES')
      )
    );
  exception when unique_violation then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'LEDGER_IDEMPOTENCY_CONFLICT_MUST_FAIL'; end if;

  v_rejected := false;
  begin
    perform public.post_ledger_transaction(
      'acceptance_payment',
      'acceptance_test',
      gen_random_uuid(),
      'ledger-acceptance-unbalanced-0001',
      'Unbalanced fixture must roll back',
      jsonb_build_array(
        jsonb_build_object('account_id', v_clearing, 'direction', 'debit', 'amount_minor', 100, 'currency', 'KES'),
        jsonb_build_object('account_id', v_revenue, 'direction', 'credit', 'amount_minor', 99, 'currency', 'KES')
      )
    );
  exception when check_violation then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'UNBALANCED_LEDGER_POST_MUST_FAIL'; end if;
end;
$$;

reset role;

-- Owner-level checks verify the ledger remains append-only after posting.
do $$
declare
  v_clearing uuid := current_setting('test.ledger_clearing')::uuid;
  v_transaction uuid := current_setting('test.ledger_transaction')::uuid;
  v_entries bigint;
  v_rejected boolean := false;
begin
  select count(*) into v_entries
  from public.ledger_entries
  where transaction_id = v_transaction;
  if v_entries <> 2 then raise exception 'LEDGER_DUPLICATE_CREATED_ENTRIES'; end if;

  begin
    update public.ledger_entries set amount_minor = 12501
    where transaction_id = v_transaction;
  exception when sqlstate '55000' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'POSTED_LEDGER_ENTRY_MUTATION_MUST_FAIL'; end if;

  v_rejected := false;
  begin
    insert into public.ledger_entries(transaction_id, account_id, direction, amount_minor, currency)
    values (v_transaction, v_clearing, 'debit', 1, 'KES');
  exception when sqlstate '55000' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'POSTED_LEDGER_TRANSACTION_MUST_REJECT_NEW_ENTRIES'; end if;

  v_rejected := false;
  begin
    update public.ledger_transactions set description = 'tampered'
    where id = v_transaction;
  exception when sqlstate '55000' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'POSTED_LEDGER_TRANSACTION_MUTATION_MUST_FAIL'; end if;
end;
$$;

rollback;
