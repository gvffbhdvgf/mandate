begin;

do $$
begin
  if to_regprocedure('public.get_organization_finance_summary(uuid)') is null
    or to_regprocedure('public.get_platform_finance_summary()') is null then
    raise exception 'FINANCE_READ_MODEL_FUNCTIONS_MISSING';
  end if;

  if not has_function_privilege('authenticated','public.get_organization_finance_summary(uuid)','execute')
    or not has_function_privilege('authenticated','public.get_platform_finance_summary()','execute') then
    raise exception 'AUTHENTICATED_FINANCE_READ_GRANTS_MISSING';
  end if;

  if has_function_privilege('anon','public.get_organization_finance_summary(uuid)','execute')
    or has_function_privilege('anon','public.get_platform_finance_summary()','execute') then
    raise exception 'ANONYMOUS_FINANCE_READ_ACCESS_GRANTED';
  end if;

  if not exists (
    select 1 from pg_proc
    where oid='mandate_private.get_organization_finance_summary(uuid)'::regprocedure
      and prosecdef=true
  ) or not exists (
    select 1 from pg_proc
    where oid='mandate_private.get_platform_finance_summary()'::regprocedure
      and prosecdef=true
  ) then raise exception 'FINANCE_READ_MODELS_MUST_BE_SECURITY_DEFINER'; end if;

  if not exists (
    select 1 from pg_proc
    where oid='mandate_private.get_platform_finance_summary()'::regprocedure
      and pg_get_functiondef(oid) ilike '%is_platform_operator%'
  ) then raise exception 'PLATFORM_FINANCE_OPERATOR_GUARD_MISSING'; end if;
end;
$$;

rollback;
