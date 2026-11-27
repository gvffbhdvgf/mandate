-- Rollback-only end-to-end acceptance for participant-scoped public vote credits.
begin;

-- Enable only inside this rollback-only fixture; the platform release flag defaults off.
update public.platform_payment_feature_flags
set public_vote_credits_enabled=true
where singleton;

insert into auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '11111111-1111-4111-8111-111111111141',
  'authenticated','authenticated','mandate-public-credit-smoke@example.invalid','',
  now(),'{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Acceptance participant"}'::jsonb,now(),now()
);

insert into public.organizations(id,name,slug,created_by)
values (
  '22222222-2222-4222-8222-222222222241',
  'Public Credit Acceptance','public-credit-acceptance',
  '11111111-1111-4111-8111-111111111141'
);

insert into public.elections(
  id,organization_id,title,public_slug,voting_mode,status,starts_at,ends_at,
  currency,price_per_credit_minor,max_credits_per_participant,
  contact_verification_required,paid_voting_authorized_at,paid_voting_authorized_by,
  created_by
) values (
  '33333333-3333-4333-8333-333333333341',
  '22222222-2222-4222-8222-222222222241',
  'Public Credit Acceptance Election','public-credit-acceptance',
  'public_paid','draft',now()-interval '1 hour',now()+interval '1 day',
  'KES',250,10,true,now(),'11111111-1111-4111-8111-111111111141',
  '11111111-1111-4111-8111-111111111141'
);

insert into public.contests(id,organization_id,election_id,title,display_order)
values (
  '44444444-4444-4444-8444-444444444441',
  '22222222-2222-4222-8222-222222222241',
  '33333333-3333-4333-8333-333333333341',
  'Acceptance Contest',1
);

insert into public.options(id,organization_id,election_id,contest_id,display_name,display_order)
values
  ('55555555-5555-4555-8555-555555555541','22222222-2222-4222-8222-222222222241','33333333-3333-4333-8333-333333333341','44444444-4444-4444-8444-444444444441','Option One',1),
  ('55555555-5555-4555-8555-555555555542','22222222-2222-4222-8222-222222222241','33333333-3333-4333-8333-333333333341','44444444-4444-4444-8444-444444444441','Option Two',2);

update public.elections
set status='open',
    opened_at=now(),
    candidate_snapshot=jsonb_build_array(jsonb_build_object(
      'contestId','44444444-4444-4444-8444-444444444441',
      'title','Acceptance Contest',
      'required',true,
      'options',jsonb_build_array(
        jsonb_build_object('id','55555555-5555-4555-8555-555555555541','displayName','Option One'),
        jsonb_build_object('id','55555555-5555-4555-8555-555555555542','displayName','Option Two')
      )
    ))
where id='33333333-3333-4333-8333-333333333341';

insert into public.public_participants(
  id,election_id,auth_user_id,contact_hash,verification_status
) values (
  '66666666-6666-4666-8666-666666666641',
  '33333333-3333-4333-8333-333333333341',
  '11111111-1111-4111-8111-111111111141',
  encode(extensions.digest(convert_to('acceptance-auth-user-141','UTF8'),'sha256'),'hex'),
  'verified'
);

set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

insert into public.organization_paystack_subaccounts(
  id,organization_id,provider_subaccount_code,currency,
  provider_percentage_charge_basis_points,status,provider_verified_at,verified_by,created_by
) values (
  '77777777-7777-4777-8777-777777777741',
  '22222222-2222-4222-8222-222222222241',
  'ACCT_TEST_PUBLIC_CREDIT','KES',0,'verified',now(),
  '11111111-1111-4111-8111-111111111141',
  '11111111-1111-4111-8111-111111111141'
);

insert into public.public_vote_platform_fee_policies(
  version,currency,fee_type,fixed_fee_minor,fee_bearer,status,
  effective_from,approved_at,approved_by,approval_reference
) values (
  9001,'KES','fixed',50,'mandate','approved',now()-interval '1 minute',now(),
  '11111111-1111-4111-8111-111111111141','acceptance-fixture-only'
);

select public.create_public_vote_credit_payment_intent(
  '11111111-1111-4111-8111-111111111141',
  'public-credit-acceptance',
  2,
  'public-credit-acceptance-idempotency-001',
  'mandate_11111111111141118111111111111141'
);

do $$
declare
  v_first jsonb;
  v_duplicate jsonb;
  v_rejected boolean := false;
begin
  v_first := public.create_public_vote_credit_payment_intent(
    '11111111-1111-4111-8111-111111111141',
    'public-credit-acceptance',
    2,
    'public-credit-acceptance-idempotency-001',
    'mandate_22222222222242228222222222222242'
  );
  v_duplicate := public.create_public_vote_credit_payment_intent(
    '11111111-1111-4111-8111-111111111141',
    'public-credit-acceptance',
    2,
    'public-credit-acceptance-idempotency-001',
    'mandate_33333333333343338333333333333343'
  );
  if v_first->>'paymentIntentId' <> v_duplicate->>'paymentIntentId'
    or v_first->>'reference' <> v_duplicate->>'reference'
    or v_duplicate->>'duplicate' <> 'true'
    or (v_first->>'amountMinor')::bigint <> 500 then
    raise exception 'PUBLIC_CREDIT_INTENT_RETRY_MUST_BE_IDEMPOTENT_AND_SERVER_PRICED';
  end if;

  begin
    perform public.create_public_vote_credit_payment_intent(
      '11111111-1111-4111-8111-111111111141',
      'public-credit-acceptance',
      9,
      'public-credit-acceptance-idempotency-002',
      'mandate_44444444444444448444444444444444'
    );
  exception when check_violation then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'ACTIVE_CREDIT_RESERVATIONS_MUST_ENFORCE_PARTICIPANT_CAP'; end if;

  update public.payment_intents
  set split_status='pending',
      split_policy_version=9001,
      split_subaccount_profile_id='77777777-7777-4777-8777-777777777741',
      split_fee_type='fixed',
      split_fixed_fee_minor=50,
      split_fee_bearer='mandate',
      split_snapshot_at=now()
  where id=(v_first->>'paymentIntentId')::uuid;
  perform set_config('test.public_credit_intent_id',v_first->>'paymentIntentId',true);
end;
$$;

do $$
declare
  v_reference text;
begin
  select provider_reference into v_reference
  from public.payment_intents
  where id=current_setting('test.public_credit_intent_id')::uuid;
  perform public.apply_verified_paystack_public_vote_split(
    null,v_reference,'paystack-public-credit-transaction-141','success',500,'KES',
    '{"paystack":15,"integration":35,"subaccount":450}'::jsonb,
    'ACCT_TEST_PUBLIC_CREDIT',null
  );
end;
$$;

-- A repeated verified success cannot issue a second lot or receipt posting.
update public.payment_intents
set verified_at=verified_at+interval '1 second'
where id=current_setting('test.public_credit_intent_id')::uuid;

reset role;

do $$
declare
  v_lots bigint;
  v_issued bigint;
  v_reservation_status text;
  v_ledger_count bigint;
begin
  select count(*),coalesce(sum(credits_issued),0)
  into v_lots,v_issued
  from public.vote_credit_lots
  where payment_id=current_setting('test.public_credit_intent_id')::uuid;

  select status into v_reservation_status
  from public.vote_credit_reservations
  where payment_intent_id=current_setting('test.public_credit_intent_id')::uuid;

  select count(*) into v_ledger_count
  from public.ledger_transactions
  where source_type='payment_intent'
    and source_id=current_setting('test.public_credit_intent_id')::uuid
    and transaction_type='payment_receipt_pending_allocation';

  if v_lots <> 1 or v_issued <> 2 or v_reservation_status <> 'fulfilled' or v_ledger_count <> 1 then
    raise exception 'VERIFIED_PUBLIC_PAYMENT_MUST_FULFILL_ONE_CREDIT_LOT_AND_ONE_RECEIPT';
  end if;
end;
$$;

-- A failed verified payment releases its reservation; an exception keeps it held.
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $$
declare
  v_failed jsonb;
  v_exception jsonb;
  v_mismatch jsonb;
begin
  v_failed := public.create_public_vote_credit_payment_intent(
    '11111111-1111-4111-8111-111111111141',
    'public-credit-acceptance',
    1,
    'public-credit-acceptance-idempotency-003',
    'mandate_55555555555545558555555555555555'
  );
  perform set_config('test.public_credit_failed_intent_id',v_failed->>'paymentIntentId',true);

  begin
    update public.payment_intents
    set status='success',
        provider_status='success',
        provider_transaction_id='paystack-public-credit-unverified-141',
        provider_amount_minor=250,
        provider_currency='KES',
        verified_at=now()
    where id=(v_failed->>'paymentIntentId')::uuid;
    raise exception 'UNVERIFIED_PUBLIC_VOTE_PAYMENT_MUST_NOT_SUCCEED';
  exception when check_violation then
    null;
  end;

  v_exception := public.create_public_vote_credit_payment_intent(
    '11111111-1111-4111-8111-111111111141',
    'public-credit-acceptance',
    1,
    'public-credit-acceptance-idempotency-004',
    'mandate_66666666666646668666666666666666'
  );
  update public.payment_intents
  set split_status='pending',
      split_policy_version=9001,
      split_subaccount_profile_id='77777777-7777-4777-8777-777777777741',
      split_fee_type='fixed',
      split_fixed_fee_minor=50,
      split_fee_bearer='mandate',
      split_snapshot_at=now()
  where id=(v_exception->>'paymentIntentId')::uuid;
  perform set_config('test.public_credit_exception_intent_id',v_exception->>'paymentIntentId',true);

  v_mismatch := public.create_public_vote_credit_payment_intent(
    '11111111-1111-4111-8111-111111111141',
    'public-credit-acceptance',
    1,
    'public-credit-acceptance-idempotency-005',
    'mandate_77777777777747778777777777777777'
  );
  update public.payment_intents
  set split_status='pending',
      split_policy_version=9001,
      split_subaccount_profile_id='77777777-7777-4777-8777-777777777741',
      split_fee_type='fixed',
      split_fixed_fee_minor=50,
      split_fee_bearer='mandate',
      split_snapshot_at=now()
  where id=(v_mismatch->>'paymentIntentId')::uuid;
  perform set_config('test.public_credit_mismatch_intent_id',v_mismatch->>'paymentIntentId',true);
end;
$;

update public.payment_intents
set status='failed',
    provider_status='failed',
    provider_transaction_id='paystack-public-credit-failed-141',
    provider_amount_minor=250,
    provider_currency='KES',
    verified_at=now()
where id=current_setting('test.public_credit_failed_intent_id')::uuid;

do $$
declare
  v_reference text;
begin
  select provider_reference into v_reference
  from public.payment_intents
  where id=current_setting('test.public_credit_exception_intent_id')::uuid;
  perform public.apply_verified_paystack_public_vote_split(
    null,v_reference,'paystack-public-credit-exception-141','success',250,'KES',
    '{"paystack":15,"integration":35,"subaccount":200}'::jsonb,
    'ACCT_TEST_PUBLIC_CREDIT',null
  );
end;
$$;

update public.payment_intents
set status='exception',
    provider_status='reversal pending',
    verified_at=verified_at+interval '1 second'
where id=current_setting('test.public_credit_exception_intent_id')::uuid;

do $
declare
  v_reference text;
  v_result jsonb;
begin
  select provider_reference into v_reference
  from public.payment_intents
  where id=current_setting('test.public_credit_mismatch_intent_id')::uuid;
  v_result := public.apply_verified_paystack_public_vote_split(
    null,v_reference,'paystack-public-credit-mismatch-141','success',250,'KES',
    '{"paystack":15,"integration":45,"subaccount":190}'::jsonb,
    'ACCT_TEST_PUBLIC_CREDIT',null
  );
  if v_result->>'status' <> 'exception'
    or v_result->>'reason' <> 'PAYSTACK_SPLIT_AMOUNT_MISMATCH' then
    raise exception 'MISMATCHED_PROVIDER_SPLIT_MUST_BE_QUARANTINED';
  end if;
end;
$;

reset role;

do $$
declare
  v_failed_status text;
  v_exception_status text;
  v_entitlement text;
  v_mismatch_status text;
  v_mismatch_lots bigint;
begin
  select status into v_failed_status
  from public.vote_credit_reservations
  where payment_intent_id=current_setting('test.public_credit_failed_intent_id')::uuid;

  select r.status,l.entitlement_status
  into v_exception_status,v_entitlement
  from public.vote_credit_reservations r
  join public.vote_credit_lots l on l.payment_id=r.payment_intent_id
  where r.payment_intent_id=current_setting('test.public_credit_exception_intent_id')::uuid;

  if v_failed_status <> 'released' then
    raise exception 'VERIFIED_FAILED_PAYMENT_MUST_RELEASE_RESERVATION';
  end if;
  if v_exception_status <> 'exception' or v_entitlement <> 'suspended' then
    raise exception 'REVERSAL_EXCEPTION_MUST_HOLD_RESERVATION_AND_SUSPEND_UNSPENT_CREDITS';
  end if;

  select status into v_mismatch_status
  from public.vote_credit_reservations
  where payment_intent_id=current_setting('test.public_credit_mismatch_intent_id')::uuid;
  select count(*) into v_mismatch_lots
  from public.vote_credit_lots
  where payment_id=current_setting('test.public_credit_mismatch_intent_id')::uuid;
  if v_mismatch_status <> 'exception' or v_mismatch_lots <> 0 then
    raise exception 'MISMATCHED_SPLIT_MUST_NOT_ISSUE_VOTE_CREDITS';
  end if;
end;
$;

-- Pause new public-credit checkout after purchase. Existing holders must still
-- be able to cast their paid credits.
update public.platform_payment_feature_flags
set public_vote_credits_enabled=false
where singleton;

-- Authenticated participant context and casting: no participant identifier enters ballot rows.
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111141',true);

do $$
declare
  v_context jsonb;
  v_first jsonb;
  v_duplicate jsonb;
begin
  v_context := public.get_public_paid_ballot_context('public-credit-acceptance');
  if (v_context->>'creditsRemaining')::bigint <> 2 then
    raise exception 'PUBLIC_PARTICIPANT_CONTEXT_MUST_SHOW_VERIFIED_CREDITS';
  end if;

  v_first := public.cast_public_paid_ballot(
    'public-credit-acceptance',
    '44444444-4444-4444-8444-444444444441',
    '55555555-5555-4555-8555-555555555541',
    2,
    true,
    'public-paid-ballot-idempotency-001'
  );
  v_duplicate := public.cast_public_paid_ballot(
    'public-credit-acceptance',
    '44444444-4444-4444-8444-444444444441',
    '55555555-5555-4555-8555-555555555541',
    2,
    true,
    'public-paid-ballot-idempotency-001'
  );

  if v_first->>'receiptCode' <> v_duplicate->>'receiptCode'
    or v_duplicate->>'duplicate' <> 'true' then
    raise exception 'PUBLIC_PAID_BALLOT_RETRY_MUST_RETURN_SAME_RECEIPT';
  end if;
end;
$$;

reset role;

do $$
declare
  v_ballots bigint;
  v_controls bigint;
  v_consumed bigint;
  v_remaining bigint;
begin
  select count(*) into v_ballots
  from public.ballots
  where election_id='33333333-3333-4333-8333-333333333341';

  select count(*) into v_controls
  from public.ballot_submission_controls
  where participant_id='66666666-6666-4666-8666-666666666641';

  select coalesce(sum(credits_consumed),0) into v_consumed
  from public.vote_credit_consumptions consumption
  join public.vote_credit_lots lot on lot.id=consumption.credit_lot_id
  where lot.payment_id=current_setting('test.public_credit_intent_id')::uuid;

  select credits_remaining into v_remaining
  from public.vote_credit_lots
  where payment_id=current_setting('test.public_credit_intent_id')::uuid;

  if v_ballots <> 1 or v_controls <> 1 or v_consumed <> 2 or v_remaining <> 0 then
    raise exception 'PUBLIC_PAID_BALLOT_MUST_CONSUME_CREDITS_ONCE_AND_KEEP_BALLOT_ANONYMOUS';
  end if;

  if has_table_privilege('authenticated','public.vote_credit_reservations','select')
    or has_table_privilege('anon','public.vote_credit_reservations','select')
    or has_table_privilege('authenticated','public.public_participants','select')
    or has_table_privilege('anon','public.public_participants','select') then
    raise exception 'PARTICIPANT_AND_RESERVATION_TABLES_MUST_REMAIN_PRIVATE';
  end if;

  if not has_function_privilege('authenticated','public.get_public_paid_ballot_context(text)','execute')
    or not has_function_privilege('authenticated','public.cast_public_paid_ballot(text,uuid,uuid,integer,boolean,text)','execute')
    or has_function_privilege('anon','public.cast_public_paid_ballot(text,uuid,uuid,integer,boolean,text)','execute') then
    raise exception 'PUBLIC_PAID_BALLOT_RPC_GRANTS_INVALID';
  end if;
end;
$$;

rollback;
