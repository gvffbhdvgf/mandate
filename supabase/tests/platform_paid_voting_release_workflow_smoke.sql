-- Platform paid-voting release workflow acceptance smoke test.
-- Run against a disposable database; all test rows are rolled back.
begin;

-- The release readiness assertion below exercises the approval checklist with
-- the independent global feature flag enabled. The enclosing transaction rolls
-- this fixture setting back.
update public.platform_payment_feature_flags
set public_vote_credits_enabled=true
where singleton;

do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000050';
  v_other uuid := '00000000-0000-4000-8000-000000000051';
  v_status jsonb;
  v_count integer;
  v_key text;
begin
  if has_table_privilege('anon','mandate_private.platform_operators','select')
    or has_table_privilege('authenticated','mandate_private.platform_operators','select') then
    raise exception 'PLATFORM_OPERATOR_TABLE_EXPOSED';
  end if;
  if has_table_privilege('anon','mandate_private.platform_authorization_guard','select')
    or has_table_privilege('authenticated','mandate_private.platform_authorization_guard','select')
    or has_table_privilege('service_role','mandate_private.platform_authorization_guard','select') then
    raise exception 'PLATFORM_AUTHORIZATION_GUARD_TOKEN_EXPOSED';
  end if;
  if has_table_privilege('authenticated','mandate_private.platform_paid_voting_release_audit','insert') then
    raise exception 'PLATFORM_AUDIT_DIRECT_INSERT_GRANTED';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid='public.elections'::regclass
      and tgname='elections_guard_public_paid_release' and not tgisinternal
  ) then raise exception 'PUBLIC_PAID_RELEASE_TRIGGER_MISSING'; end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid='public.elections'::regclass
      and tgname='elections_guard_public_paid_release_insert' and not tgisinternal
  ) then raise exception 'PUBLIC_PAID_RELEASE_INSERT_TRIGGER_MISSING'; end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid='public.payment_intents'::regclass
      and tgname='payment_intents_public_paid_release_guard' and not tgisinternal
  ) then raise exception 'PUBLIC_PAID_PAYMENT_RELEASE_TRIGGER_MISSING'; end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid='public.ballots'::regclass
      and tgname='ballots_public_paid_release_guard' and not tgisinternal
  ) then raise exception 'PUBLIC_PAID_BALLOT_RELEASE_TRIGGER_MISSING'; end if;
  if position('PLATFORM_AUTHORIZATION_SERVER_MANAGED' in
    pg_get_functiondef('mandate_private.guard_public_paid_release()'::regprocedure))=0
    or position('platform_authorization_guard' in
    pg_get_functiondef('mandate_private.guard_public_paid_release()'::regprocedure))=0 then
    raise exception 'PUBLIC_PAID_AUTHORIZATION_FIELDS_NOT_PROTECTED';
  end if;
  if position('has_current_public_paid_voting_release' in
    pg_get_functiondef('mandate_private.guard_public_paid_payment_intent_release()'::regprocedure))=0
    or position('has_current_public_paid_voting_approvals' in
    pg_get_functiondef('mandate_private.guard_public_paid_ballot_release()'::regprocedure))=0 then
    raise exception 'PUBLIC_PAID_TRANSACTIONS_NOT_BOUND_TO_CURRENT_RELEASE';
  end if;

  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
  values
    (v_user,'authenticated','authenticated','release-operator-test@example.com','',now(),now(),now()),
    (v_other,'authenticated','authenticated','other-user-test@example.com','',now(),now(),now())
  on conflict (id) do nothing;
  delete from mandate_private.platform_operators;
  delete from mandate_private.platform_operator_bootstrap_allowlist;
  insert into mandate_private.platform_operator_bootstrap_allowlist(user_id)
  values (v_user);
  
  perform set_config('request.jwt.claim.sub',v_user::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_user,'role','authenticated','email','release-operator-test@example.com','email_verified',true)::text,true);
  perform public.bootstrap_platform_operator();
  v_status := public.get_platform_paid_voting_status();
  if (v_status->>'isOperator')::boolean is not true then raise exception 'BOOTSTRAP_FAILED'; end if;
  if (v_status->>'releaseReady')::boolean is not false then raise exception 'RELEASE_MUST_START_CLOSED'; end if;

  begin
    perform public.record_platform_paid_voting_requirement(
      'provider_use_case','approved','short evidence','https://example.com/evidence',null
    );
    raise exception 'SHORT_APPROVAL_EVIDENCE_ACCEPTED';
  exception when sqlstate '22023' then
    if sqlerrm <> 'APPROVAL_EVIDENCE_REQUIRED' then raise; end if;
  end;

  for v_key in select requirement_key from mandate_private.platform_paid_voting_release_requirements loop
    perform public.record_platform_paid_voting_requirement(
      v_key,'approved',
      'Verified evidence for this requirement with documented scope, reviewer checks and a recorded supporting decision.',
      'https://example.com/release-evidence/'||v_key,null
    );
  end loop;
  v_status := public.get_platform_paid_voting_status();
  if (v_status->>'releaseReady')::boolean is not true then raise exception 'COMPLETE_RELEASE_NOT_RECOGNIZED'; end if;

  perform set_config('request.jwt.claim.sub',v_other::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other,'role','authenticated','email','other-user-test@example.com','email_verified',true)::text,true);
  begin
    perform public.record_platform_paid_voting_requirement(
      'provider_use_case','pending','reset','',null
    );
    raise exception 'NON_OPERATOR_UPDATED_RELEASE';
  exception when insufficient_privilege then
    null;
  end;

  begin
    update mandate_private.platform_paid_voting_release_audit
    set after_state='{}'::jsonb where actor_id=v_user;
    raise exception 'PLATFORM_AUDIT_MUTATION_ALLOWED';
  exception when sqlstate '55000' then
    if sqlerrm <> 'PLATFORM_RELEASE_AUDIT_APPEND_ONLY' then raise; end if;
  end;

  select count(*) into v_count from mandate_private.platform_paid_voting_release_audit
  where actor_id=v_user;
  if v_count < 8 then raise exception 'PLATFORM_AUDIT_HISTORY_MISSING'; end if;
end;
$$;

rollback;
