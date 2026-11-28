-- Organization-controlled public paid-voting release workflow acceptance smoke test.
-- Run against a disposable database; all fixture changes are rolled back.
begin;

update public.platform_payment_feature_flags
set public_vote_credits_enabled=true
where singleton;

do $$
declare
  v_guard text;
  v_payment_guard text;
  v_ballot_guard text;
  v_approval_helper text;
  v_release_helper text;
  v_trigger_count integer;
begin
  -- The election guard must preserve organization authorization and real
  -- operational restrictions without requiring a platform-operator token.
  v_guard := pg_get_functiondef(
    'mandate_private.guard_public_paid_release()'::regprocedure
  );

  if position('ORGANIZATION_ELECTION_AUTHORITY_REQUIRED' in v_guard)=0
    or position('has_org_role' in v_guard)=0 then
    raise exception 'ORGANIZATION_AUTHORITY_NOT_ENFORCED';
  end if;
  if position('PAID_VOTING_FEATURE_GATED' in v_guard)=0
    or position('JURISDICTION_NOT_RELEASED' in v_guard)=0 then
    raise exception 'PAID_VOTING_OPERATIONAL_GUARDS_MISSING';
  end if;
  if position('platform_authorization_guard' in v_guard)>0
    or position('PLATFORM_AUTHORIZATION_SERVER_MANAGED' in v_guard)>0 then
    raise exception 'PLATFORM_OPERATOR_GATE_STILL_REQUIRED';
  end if;

  v_approval_helper := pg_get_functiondef(
    'mandate_private.has_current_public_paid_voting_approvals()'::regprocedure
  );
  if position('select true' in lower(v_approval_helper))=0 then
    raise exception 'LEGACY_PLATFORM_APPROVAL_HELPER_STILL_GATES_RELEASE';
  end if;

  v_release_helper := pg_get_functiondef(
    'mandate_private.has_current_public_paid_voting_release()'::regprocedure
  );
  if position('public_vote_credits_enabled' in v_release_helper)=0 then
    raise exception 'PUBLIC_VOTE_CREDIT_FEATURE_FLAG_NOT_ENFORCED';
  end if;

  v_payment_guard := pg_get_functiondef(
    'mandate_private.guard_public_paid_payment_intent_release()'::regprocedure
  );
  if position('has_current_public_paid_voting_release' in v_payment_guard)=0
    or position('paid_voting_authorized_by' in v_payment_guard)=0 then
    raise exception 'PUBLIC_PAID_PAYMENT_GUARD_MISSING';
  end if;

  v_ballot_guard := pg_get_functiondef(
    'mandate_private.guard_public_paid_ballot_release()'::regprocedure
  );
  if position('has_current_public_paid_voting_release' in v_ballot_guard)>0
    or position('paid_voting_authorized_by' in v_ballot_guard)=0 then
    raise exception 'PUBLIC_PAID_BALLOT_MUST_NOT_DEPEND_ON_NEW_PURCHASE_SWITCH';
  end if;

  select count(*) into v_trigger_count
  from pg_trigger
  where not tgisinternal
    and (
      (tgrelid='public.elections'::regclass and tgname in (
        'elections_guard_public_paid_release',
        'elections_guard_public_paid_release_insert'
      ))
      or (tgrelid='public.payment_intents'::regclass
        and tgname='payment_intents_public_paid_release_guard')
      or (tgrelid='public.ballots'::regclass
        and tgname='ballots_public_paid_release_guard')
    );
  if v_trigger_count <> 4 then
    raise exception 'PUBLIC_PAID_RELEASE_TRIGGERS_MISSING';
  end if;
end;
$$;

rollback;
