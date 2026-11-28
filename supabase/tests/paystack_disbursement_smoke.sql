begin;

do $$
declare
  v_rls boolean;
begin
  if to_regclass('public.organization_payout_recipients') is null
    or to_regclass('public.paystack_transfer_events') is null then
    raise exception 'DISBURSEMENT_TABLES_MISSING';
  end if;

  select c.relrowsecurity into v_rls
  from pg_class c where c.oid='public.organization_payout_recipients'::regclass;
  if v_rls is distinct from true then raise exception 'RECIPIENT_RLS_NOT_ENABLED'; end if;

  select c.relrowsecurity into v_rls
  from pg_class c where c.oid='public.paystack_transfer_events'::regclass;
  if v_rls is distinct from true then raise exception 'TRANSFER_EVENT_RLS_NOT_ENABLED'; end if;

  if has_table_privilege('anon','public.organization_payout_recipients','select')
    or has_table_privilege('authenticated','public.organization_payout_recipients','select')
    or has_table_privilege('authenticated','public.paystack_transfer_events','select') then
    raise exception 'PRIVATE_DISBURSEMENT_TABLE_EXPOSED';
  end if;
  if not has_table_privilege('service_role','public.organization_payout_recipients','select')
    or not has_table_privilege('service_role','public.organization_payout_recipients','insert')
    or not has_table_privilege('service_role','public.paystack_transfer_events','insert') then
    raise exception 'SERVICE_ROLE_DISBURSEMENT_GRANTS_MISSING';
  end if;

  if not has_function_privilege('authenticated','public.request_organization_payout(uuid,uuid,bigint)','execute')
    or not has_function_privilege('authenticated','public.approve_organization_payout(uuid)','execute') then
    raise exception 'AUTHENTICATED_PAYOUT_RPCS_MISSING';
  end if;
  if has_function_privilege('anon','public.request_organization_payout(uuid,uuid,bigint)','execute')
    or has_function_privilege('authenticated','mandate_private.claim_organization_payout(uuid)','execute')
    or has_function_privilege('authenticated','mandate_private.apply_paystack_transfer_status(uuid,text,text,text,bigint,text,bigint)','execute') then
    raise exception 'PRIVILEGED_PAYOUT_RPC_EXPOSED';
  end if;
  if not has_function_privilege('service_role','mandate_private.claim_organization_payout(uuid)','execute')
    or not has_function_privilege('service_role','mandate_private.apply_paystack_transfer_status(uuid,text,text,text,bigint,text,bigint)','execute') then
    raise exception 'SERVICE_ROLE_PAYOUT_RPCS_MISSING';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='organization_payout_recipients'
      and column_name in ('account_number','phone_number','bank_account_number')
  ) then raise exception 'RAW_BENEFICIARY_DATA_COLUMN_PRESENT'; end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='organization_payout_recipients'
      and column_name='destination_confirmed_by'
  ) then raise exception 'BENEFICIARY_CONFIRMATION_EVIDENCE_MISSING'; end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.payout_requests'::regclass
      and conname='payout_requests_recipient_required'
  ) then raise exception 'PAYOUT_RECIPIENT_CONSTRAINT_MISSING'; end if;
end;
$$;

rollback;
