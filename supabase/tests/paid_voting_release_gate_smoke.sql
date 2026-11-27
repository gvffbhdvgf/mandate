-- Rollback-only acceptance for paid voting's fail-closed global release switch.
begin;

do $$
declare
  v_enabled boolean;
  v_rejected boolean := false;
begin
  select public_vote_credits_enabled into v_enabled
  from public.platform_payment_feature_flags
  where singleton;

  if v_enabled is distinct from false then
    raise exception 'PUBLIC_VOTE_CREDITS_MUST_DEFAULT_DISABLED';
  end if;

  begin
    insert into public.payment_intents(
      election_id,participant_id,purpose,provider,provider_reference,
      amount_minor,currency,expected_credits,status,idempotency_key
    ) values (
      '33333333-3333-4333-8333-333333333399',
      '66666666-6666-4666-8666-666666666699',
      'public_vote_credits','paystack','mandate_99999999999949998999999999999999',
      100,'KES',1,'initialized','public-paid-release-gate-test-001'
    );
  exception when sqlstate '55000' then
    v_rejected := true;
  end;

  if not v_rejected then
    raise exception 'DATABASE_MUST_REJECT_PUBLIC_CREDIT_INTENTS_WHILE_RELEASE_DISABLED';
  end if;

  if has_table_privilege('authenticated','public.platform_payment_feature_flags','select')
    or has_table_privilege('authenticated','public.platform_payment_feature_flags','update')
    or has_table_privilege('anon','public.platform_payment_feature_flags','select')
    or has_table_privilege('anon','public.platform_payment_feature_flags','update') then
    raise exception 'PAYMENT_RELEASE_FLAGS_MUST_BE_SERVER_ONLY';
  end if;

  if not has_table_privilege('service_role','public.platform_payment_feature_flags','select')
    or not has_table_privilege('service_role','public.platform_payment_feature_flags','update') then
    raise exception 'SERVICE_ROLE_MUST_CONTROL_PAYMENT_RELEASE_FLAGS';
  end if;

  if position('pricePerCreditMinor' in pg_get_functiondef('mandate_private.compute_election_setup_hash(uuid)'::regprocedure))=0
    or position('maxCreditsPerParticipant' in pg_get_functiondef('mandate_private.compute_election_setup_hash(uuid)'::regprocedure))=0 then
    raise exception 'PUBLIC_PAID_PRICE_AND_CAP_MUST_BE_FROZEN_IN_SETUP_HASH';
  end if;

  if position('participant_id' in pg_get_functiondef('mandate_private.tally_and_reconcile(uuid)'::regprocedure))=0
    or position('PAID_VOTING_FEATURE_GATED' in pg_get_functiondef('mandate_private.tally_and_reconcile(uuid)'::regprocedure))>0 then
    raise exception 'PUBLIC_PAID_TALLY_MUST_RECONCILE_PARTICIPANT_CONTROLS';
  end if;
end;
$$;

rollback;
