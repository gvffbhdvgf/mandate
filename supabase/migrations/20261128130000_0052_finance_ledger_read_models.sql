-- Read-only finance views for organization finance roles and Mandate platform operators.
-- Balances are derived from posted ledger entries; no stored-value wallet balance is created.

create or replace function mandate_private.get_organization_finance_summary(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_balance numeric := 0;
  v_reserved numeric := 0;
  v_paid numeric := 0;
begin
  if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id=p_organization_id and m.user_id=v_user
      and m.status='active' and m.role in ('owner','admin','finance_manager')
  ) then raise exception 'FORBIDDEN' using errcode='42501'; end if;

  select coalesce(sum(case when le.direction='credit' then le.amount_minor else -le.amount_minor end),0)
    into v_balance
  from public.ledger_accounts la
  join public.ledger_entries le on le.account_id=la.id
  join public.ledger_transactions lt on lt.id=le.transaction_id and lt.status='posted'
  where la.owner_type='organization_payable'
    and la.organization_id=p_organization_id and la.currency='KES';

  select coalesce(sum(amount_minor),0) into v_reserved
  from public.payout_requests
  where organization_id=p_organization_id
    and status in ('requested','under_review','approved','processing');

  select coalesce(sum(amount_minor),0) into v_paid
  from public.payout_requests
  where organization_id=p_organization_id and status='paid';

  return jsonb_build_object(
    'organizationId',p_organization_id,
    'currency','KES',
    'ledgerBalanceMinor',v_balance,
    'reservedMinor',v_reserved,
    'availableMinor',greatest(v_balance-v_reserved,0),
    'overReserved',v_balance<v_reserved,
    'paidOutMinor',v_paid,
    'accounts',coalesce((
      select jsonb_agg(jsonb_build_object(
        'ownerType',x.owner_type,'accountCode',x.account_code,
        'currency',x.currency,'normalBalance',x.normal_balance,
        'debitMinor',x.debit_minor,'creditMinor',x.credit_minor,'balanceMinor',x.balance_minor
      ) order by x.owner_type,x.account_code)
      from (
        select la.owner_type::text as owner_type,la.account_code,la.currency,
          b.debit_minor,b.credit_minor,
          case when la.owner_type='organization_payable' then 'credit' else 'debit' end as normal_balance,
          case when la.owner_type='organization_payable'
            then b.credit_minor-b.debit_minor else b.debit_minor-b.credit_minor end as balance_minor
        from public.ledger_accounts la
        left join lateral (
          select
            coalesce(sum(le.amount_minor) filter (where le.direction='debit'),0) as debit_minor,
            coalesce(sum(le.amount_minor) filter (where le.direction='credit'),0) as credit_minor
          from public.ledger_entries le
          join public.ledger_transactions lt on lt.id=le.transaction_id and lt.status='posted'
          where le.account_id=la.id
        ) b on true
        where la.organization_id=p_organization_id
          and la.owner_type in ('organization','organization_payable')
      ) x
    ),'[]'::jsonb),
    'recipients',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',r.id,'type',r.recipient_type,'name',r.beneficiary_name,
        'bankCode',r.bank_code,'maskedAccount',r.masked_account,
        'active',r.active,'createdAt',r.created_at
      ) order by r.created_at desc)
      from public.organization_payout_recipients r
      where r.organization_id=p_organization_id and r.active
    ),'[]'::jsonb),
    'payouts',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'amountMinor',p.amount_minor,'currency',p.currency,
        'status',p.status,'reference',p.provider_reference,
        'providerStatus',p.provider_status,'providerFeeMinor',p.provider_fee_minor,
        'failureCode',p.failure_code,'failureMessage',p.failure_message,
        'recipientName',r.beneficiary_name,'maskedAccount',r.masked_account,
        'requestedBy',rq.display_name,'approvedBy',ap.display_name,
        'createdAt',p.created_at,'paidAt',p.paid_at
      ) order by p.created_at desc)
      from (
        select * from public.payout_requests
        where organization_id=p_organization_id
        order by created_at desc limit 100
      ) p
      left join public.organization_payout_recipients r on r.id=p.recipient_id
      left join public.profiles rq on rq.id=p.requested_by
      left join public.profiles ap on ap.id=p.approved_by
    ),'[]'::jsonb),
    'ledgerEntries',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',x.id,'transactionId',x.transaction_id,
        'transactionType',x.transaction_type,'description',x.description,
        'accountCode',x.account_code,'ownerType',x.owner_type,
        'direction',x.direction,'amountMinor',x.amount_minor,
        'currency',x.currency,'createdAt',x.created_at
      ) order by x.created_at desc)
      from (
        select le.id,le.transaction_id,lt.transaction_type,lt.description,
          la.account_code,la.owner_type::text as owner_type,
          le.direction,le.amount_minor,le.currency,le.created_at
        from public.ledger_accounts la
        join public.ledger_entries le on le.account_id=la.id
        join public.ledger_transactions lt on lt.id=le.transaction_id and lt.status='posted'
        where la.organization_id=p_organization_id
          and la.owner_type in ('organization','organization_payable')
        order by le.created_at desc limit 100
      ) x
    ),'[]'::jsonb)
  );
end;
$$;

revoke all on function mandate_private.get_organization_finance_summary(uuid) from public,anon,authenticated;
grant execute on function mandate_private.get_organization_finance_summary(uuid) to authenticated;

create or replace function public.get_organization_finance_summary(p_organization_id uuid)
returns jsonb
language sql
security invoker
set search_path=pg_catalog
as $$ select mandate_private.get_organization_finance_summary($1); $$;

revoke all on function public.get_organization_finance_summary(uuid) from public,anon;
grant execute on function public.get_organization_finance_summary(uuid) to authenticated;

create or replace function mandate_private.get_platform_finance_summary()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_revenue numeric := 0;
  v_processor_fees numeric := 0;
  v_provider_clearing numeric := 0;
  v_org_payables numeric := 0;
  v_reserved numeric := 0;
  v_paid numeric := 0;
begin
  if not mandate_private.is_platform_operator() then
    raise exception 'PLATFORM_OPERATOR_REQUIRED' using errcode='42501';
  end if;

  select coalesce(sum(case when le.direction='credit' then le.amount_minor else -le.amount_minor end),0)
    into v_revenue
  from public.ledger_accounts la
  join public.ledger_entries le on le.account_id=la.id
  join public.ledger_transactions lt on lt.id=le.transaction_id and lt.status='posted'
  where la.owner_type='platform_revenue' and la.currency='KES';

  select coalesce(sum(case when le.direction='debit' then le.amount_minor else -le.amount_minor end),0)
    into v_processor_fees
  from public.ledger_accounts la
  join public.ledger_entries le on le.account_id=la.id
  join public.ledger_transactions lt on lt.id=le.transaction_id and lt.status='posted'
  where la.owner_type='processor_fee' and la.currency='KES';

  select coalesce(sum(case when le.direction='debit' then le.amount_minor else -le.amount_minor end),0)
    into v_provider_clearing
  from public.ledger_accounts la
  join public.ledger_entries le on le.account_id=la.id
  join public.ledger_transactions lt on lt.id=le.transaction_id and lt.status='posted'
  where la.owner_type='provider_clearing' and la.currency='KES';

  select coalesce(sum(case when le.direction='credit' then le.amount_minor else -le.amount_minor end),0)
    into v_org_payables
  from public.ledger_accounts la
  join public.ledger_entries le on le.account_id=la.id
  join public.ledger_transactions lt on lt.id=le.transaction_id and lt.status='posted'
  where la.owner_type='organization_payable' and la.currency='KES';

  select coalesce(sum(amount_minor),0) into v_reserved
  from public.payout_requests where status in ('requested','under_review','approved','processing');

  select coalesce(sum(amount_minor),0) into v_paid
  from public.payout_requests where status='paid';

  return jsonb_build_object(
    'currency','KES',
    'mandateRevenueMinor',v_revenue,
    'processorFeesMinor',v_processor_fees,
    'providerClearingMinor',v_provider_clearing,
    'organizationPayablesMinor',v_org_payables,
    'reservedPayoutsMinor',v_reserved,
    'paidOutMinor',v_paid,
    'accounts',coalesce((
      select jsonb_agg(jsonb_build_object(
        'ownerType',x.owner_type,'organizationId',x.organization_id,
        'organizationName',x.organization_name,'accountCode',x.account_code,
        'currency',x.currency,'normalBalance',x.normal_balance,
        'debitMinor',x.debit_minor,'creditMinor',x.credit_minor,'balanceMinor',x.balance_minor
      ) order by x.owner_type,x.organization_name,x.account_code)
      from (
        select la.owner_type::text as owner_type,la.organization_id,o.name as organization_name,
          la.account_code,la.currency,b.debit_minor,b.credit_minor,
          case when la.owner_type::text in ('platform_revenue','organization_payable','refund_payable','payouts_payable')
            then 'credit' else 'debit' end as normal_balance,
          case when la.owner_type::text in ('platform_revenue','organization_payable','refund_payable','payouts_payable')
            then b.credit_minor-b.debit_minor else b.debit_minor-b.credit_minor end as balance_minor
        from public.ledger_accounts la
        left join public.organizations o on o.id=la.organization_id
        left join lateral (
          select
            coalesce(sum(le.amount_minor) filter (where le.direction='debit'),0) as debit_minor,
            coalesce(sum(le.amount_minor) filter (where le.direction='credit'),0) as credit_minor
          from public.ledger_entries le
          join public.ledger_transactions lt on lt.id=le.transaction_id and lt.status='posted'
          where le.account_id=la.id
        ) b on true
      ) x
    ),'[]'::jsonb),
    'organizationPayables',coalesce((
      select jsonb_agg(jsonb_build_object(
        'organizationId',x.organization_id,'organizationName',x.organization_name,
        'balanceMinor',x.balance_minor
      ) order by x.organization_name)
      from (
        select la.organization_id,o.name as organization_name,
          sum(b.balance_minor) as balance_minor
        from public.ledger_accounts la
        join public.organizations o on o.id=la.organization_id
        left join lateral (
          select coalesce(sum(case when le.direction='credit' then le.amount_minor else -le.amount_minor end),0) as balance_minor
          from public.ledger_entries le
          join public.ledger_transactions lt on lt.id=le.transaction_id and lt.status='posted'
          where le.account_id=la.id
        ) b on true
        where la.owner_type='organization_payable' and la.currency='KES'
        group by la.organization_id,o.name
      ) x
    ),'[]'::jsonb),
    'payouts',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'organizationId',p.organization_id,'organizationName',o.name,
        'amountMinor',p.amount_minor,'currency',p.currency,'status',p.status,
        'reference',p.provider_reference,'providerStatus',p.provider_status,
        'providerFeeMinor',p.provider_fee_minor,'failureCode',p.failure_code,
        'recipientName',r.beneficiary_name,'maskedAccount',r.masked_account,
        'requestedBy',rq.display_name,'approvedBy',ap.display_name,
        'createdAt',p.created_at,'paidAt',p.paid_at
      ) order by p.created_at desc)
      from (
        select * from public.payout_requests order by created_at desc limit 100
      ) p
      join public.organizations o on o.id=p.organization_id
      left join public.organization_payout_recipients r on r.id=p.recipient_id
      left join public.profiles rq on rq.id=p.requested_by
      left join public.profiles ap on ap.id=p.approved_by
    ),'[]'::jsonb),
    'recentTransactions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',x.id,'type',x.transaction_type,'sourceType',x.source_type,
        'description',x.description,'createdAt',x.created_at,'entries',x.entries
      ) order by x.created_at desc)
      from (
        select lt.id,lt.transaction_type,lt.source_type,lt.description,lt.created_at,
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'ownerType',la.owner_type,'accountCode',la.account_code,
              'organizationId',la.organization_id,'direction',le.direction,
              'amountMinor',le.amount_minor,'currency',le.currency
            ) order by la.account_code)
            from public.ledger_entries le
            join public.ledger_accounts la on la.id=le.account_id
            where le.transaction_id=lt.id
          ),'[]'::jsonb) as entries
        from public.ledger_transactions lt
        where lt.status='posted'
        order by lt.created_at desc limit 50
      ) x
    ),'[]'::jsonb)
  );
end;
$$;

revoke all on function mandate_private.get_platform_finance_summary() from public,anon,authenticated;
grant execute on function mandate_private.get_platform_finance_summary() to authenticated;

create or replace function public.get_platform_finance_summary()
returns jsonb
language sql
security invoker
set search_path=pg_catalog
as $$ select mandate_private.get_platform_finance_summary(); $$;

revoke all on function public.get_platform_finance_summary() from public,anon;
grant execute on function public.get_platform_finance_summary() to authenticated;

comment on function public.get_organization_finance_summary(uuid) is
  'Returns the authenticated organization finance team ledger, reserved payout and beneficiary view. Balances derive from posted double-entry ledger transactions.';
comment on function public.get_platform_finance_summary() is
  'Returns the platform-operator central ledger and organization payout monitoring view. Not a stored-value wallet.';
