-- Rollback-only acceptance for one-shot Paystack initialization claims.
begin;

insert into public.payment_intents(
  id, purpose, provider, provider_reference, amount_minor, currency, status, idempotency_key
) values (
  '11111111-1111-4111-8111-111111111137',
  'platform_fee', 'paystack', 'mandate-init-claim-smoke-20261127',
  2500, 'KES', 'initialized', 'mandate-init-claim-smoke-20261127'
);

set local role service_role;
insert into public.payment_initialization_attempts(payment_intent_id, status)
values ('11111111-1111-4111-8111-111111111137', 'initializing');

do $$
declare
  v_duplicate_rejected boolean := false;
begin
  begin
    insert into public.payment_initialization_attempts(payment_intent_id, status)
    values ('11111111-1111-4111-8111-111111111137', 'initializing');
  exception when unique_violation then
    v_duplicate_rejected := true;
  end;
  if not v_duplicate_rejected then
    raise exception 'DUPLICATE_INITIALIZATION_CLAIM_MUST_FAIL';
  end if;
end;
$$;
reset role;

do $$
begin
  if (select status from public.payment_initialization_attempts
      where payment_intent_id='11111111-1111-4111-8111-111111111137') <> 'initializing' then
    raise exception 'INITIALIZATION_CLAIM_STATE_NOT_PRESERVED';
  end if;
  if has_table_privilege('authenticated', 'public.payment_initialization_attempts', 'select')
    or has_table_privilege('authenticated', 'public.payment_initialization_attempts', 'insert')
    or has_table_privilege('anon', 'public.payment_initialization_attempts', 'select') then
    raise exception 'INITIALIZATION_ATTEMPTS_MUST_BE_PRIVATE';
  end if;
end;
$$;

rollback;
