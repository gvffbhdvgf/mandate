-- Rollback-only acceptance for the retired split schema and single-merchant defaults.
begin;

do $$
declare
  v_active_policy_count bigint;
  v_subaccount_count bigint;
  v_rls_enabled boolean;
begin
  select count(*) into v_active_policy_count
  from public.public_vote_platform_fee_policies
  where status = 'active';

  select count(*) into v_subaccount_count
  from public.organization_paystack_subaccounts
  where status = 'verified';

  if v_active_policy_count <> 0 then
    raise exception 'PUBLIC_VOTE_FEE_POLICY_MUST_NOT_BE_ACTIVATED_BY_MIGRATION';
  end if;

  if v_subaccount_count <> 0 then
    raise exception 'MIGRATION_MUST_NOT_CREATE_OR_VERIFY_ORGANIZER_SUBACCOUNTS';
  end if;

  select c.relrowsecurity into v_rls_enabled
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'organization_paystack_subaccounts';
  if v_rls_enabled is distinct from true then
    raise exception 'ORGANIZER_SUBACCOUNT_TABLE_MUST_HAVE_RLS';
  end if;

  select c.relrowsecurity into v_rls_enabled
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'public_vote_platform_fee_policies';
  if v_rls_enabled is distinct from true then
    raise exception 'PUBLIC_VOTE_FEE_POLICY_TABLE_MUST_HAVE_RLS';
  end if;

  if has_table_privilege('anon','public.organization_paystack_subaccounts','select')
    or has_table_privilege('authenticated','public.organization_paystack_subaccounts','select')
    or has_table_privilege('anon','public.public_vote_platform_fee_policies','select')
    or has_table_privilege('authenticated','public.public_vote_platform_fee_policies','select') then
    raise exception 'RETIRED_SPLIT_CONFIGURATION_MUST_NOT_BE_CLIENT_READABLE';
  end if;

  if not has_table_privilege('service_role','public.organization_paystack_subaccounts','select')
    or not has_table_privilege('service_role','public.public_vote_platform_fee_policies','select') then
    raise exception 'SERVICE_ROLE_MUST_RETAIN_CONTROLLED_SPLIT_CONFIGURATION_ACCESS';
  end if;

  if exists (
    select 1 from pg_trigger
    where tgrelid = 'public.payment_intents'::regclass
      and tgname = 'payment_intents_require_verified_public_vote_split'
      and not tgisinternal
  ) then
    raise exception 'SINGLE_MERCHANT_PUBLIC_VOTE_MUST_NOT_REQUIRE_SPLIT_SETTLEMENT';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'apply_verified_paystack_public_vote_payment'
      and pg_get_function_identity_arguments(p.oid) =
        'p_event_id uuid, p_provider_reference text, p_provider_transaction_id text, p_provider_status text, p_amount_minor bigint, p_currency text, p_provider_fee_minor bigint'
  ) then
    raise exception 'SINGLE_MERCHANT_VERIFIED_PAYMENT_RPC_MUST_EXIST';
  end if;

  if has_function_privilege('anon',
      'public.apply_verified_paystack_public_vote_payment(uuid,text,text,text,bigint,text,bigint)','execute')
    or has_function_privilege('authenticated',
      'public.apply_verified_paystack_public_vote_payment(uuid,text,text,text,bigint,text,bigint)','execute')
    or not has_function_privilege('service_role',
      'public.apply_verified_paystack_public_vote_payment(uuid,text,text,text,bigint,text,bigint)','execute') then
    raise exception 'SINGLE_MERCHANT_PAYMENT_RPC_MUST_BE_SERVICE_ROLE_ONLY';
  end if;
end;
$$;

insert into public.payment_intents(
  id,purpose,provider,provider_reference,amount_minor,currency,status,idempotency_key
) values (
  '11111111-1111-4111-8111-111111111247',
  'platform_fee','paystack','mandate-single-merchant-schema-default-0049',
  1000,'KES','initialized','mandate-single-merchant-schema-default-0049'
);

do $$
declare
  v_status text;
  v_rejected boolean := false;
begin
  select split_status into v_status
  from public.payment_intents
  where id = '11111111-1111-4111-8111-111111111247';

  if v_status <> 'not_configured' then
    raise exception 'PAYMENT_SPLIT_MUST_DEFAULT_TO_NOT_CONFIGURED';
  end if;

  begin
    update public.payment_intents
    set split_status = 'pending'
    where id = '11111111-1111-4111-8111-111111111247';
  exception when check_violation then
    v_rejected := true;
  end;

  if not v_rejected then
    raise exception 'PARTIAL_SPLIT_SNAPSHOT_MUST_BE_REJECTED';
  end if;
end;
$$;

rollback;
