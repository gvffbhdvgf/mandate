-- Rollback-only acceptance for Paystack split-settlement schema and fail-closed defaults.
begin;

do $$
declare
  v_active_policy_count bigint;
  v_subaccount_count bigint;
  v_rls_enabled boolean;
  v_rejected boolean := false;
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
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'organization_paystack_subaccounts';

  if v_rls_enabled is distinct from true then
    raise exception 'ORGANIZER_SUBACCOUNT_TABLE_MUST_HAVE_RLS';
  end if;

  select c.relrowsecurity into v_rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'public_vote_platform_fee_policies';

  if v_rls_enabled is distinct from true then
    raise exception 'PUBLIC_VOTE_FEE_POLICY_TABLE_MUST_HAVE_RLS';
  end if;

  if has_table_privilege('anon','public.organization_paystack_subaccounts','select')
    or has_table_privilege('authenticated','public.organization_paystack_subaccounts','select')
    or has_table_privilege('anon','public.public_vote_platform_fee_policies','select')
    or has_table_privilege('authenticated','public.public_vote_platform_fee_policies','select') then
    raise exception 'SPLIT_CONFIGURATION_MUST_NOT_BE_CLIENT_READABLE';
  end if;

  if not has_table_privilege('service_role','public.organization_paystack_subaccounts','select')
    or not has_table_privilege('service_role','public.public_vote_platform_fee_policies','select') then
    raise exception 'SERVICE_ROLE_MUST_READ_SPLIT_CONFIGURATION';
  end if;
end;
$$;

insert into public.payment_intents(
  id,purpose,provider,provider_reference,amount_minor,currency,status,idempotency_key
) values (
  '11111111-1111-4111-8111-111111111247',
  'platform_fee','paystack','mandate-split-schema-default-0047',
  1000,'KES','initialized','mandate-split-schema-default-0047'
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
