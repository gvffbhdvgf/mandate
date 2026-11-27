-- Rollback-only acceptance for the KES 20-per-eligible-voter / KES 500 minimum policy.
begin;

insert into auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '11111111-1111-4111-8111-111111111146',
  'authenticated','authenticated','mandate-platform-fee-smoke@example.invalid','',
  now(),'{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Finance acceptance"}'::jsonb,now(),now()
);

insert into public.organizations(id,name,slug,created_by)
values (
  '22222222-2222-4222-8222-222222222246',
  'Platform Fee Acceptance','platform-fee-acceptance',
  '11111111-1111-4111-8111-111111111146'
);

insert into public.organization_members(organization_id,user_id,role,status)
values (
  '22222222-2222-4222-8222-222222222246',
  '11111111-1111-4111-8111-111111111146',
  'finance_manager','active'
);

insert into public.elections(
  id,organization_id,title,voting_mode,status,starts_at,ends_at,created_by
) values
  ('33333333-3333-4333-8333-333333333346','22222222-2222-4222-8222-222222222246',
   'Minimum Fee Election','registered_single','draft',now()-interval '1 hour',now()+interval '1 day',
   '11111111-1111-4111-8111-111111111146'),
  ('33333333-3333-4333-8333-333333333347','22222222-2222-4222-8222-222222222246',
   'Per Voter Fee Election','registered_weighted','draft',now()-interval '1 hour',now()+interval '1 day',
   '11111111-1111-4111-8111-111111111146');

insert into public.election_voters(organization_id,election_id,external_voter_ref,display_name,eligibility_status,weight_units)
select '22222222-2222-4222-8222-222222222246','33333333-3333-4333-8333-333333333346',
       'minimum-'||n,'Minimum voter '||n,'eligible',1
from generate_series(1,10) n;

insert into public.election_voters(organization_id,election_id,external_voter_ref,display_name,eligibility_status,weight_units)
select '22222222-2222-4222-8222-222222222246','33333333-3333-4333-8333-333333333347',
       'scale-'||n,'Scale voter '||n,'eligible',1
from generate_series(1,30) n;

insert into public.election_voters(organization_id,election_id,external_voter_ref,display_name,eligibility_status,weight_units)
values (
  '22222222-2222-4222-8222-222222222246','33333333-3333-4333-8333-333333333347',
  'revoked-1','Revoked voter','revoked',1
);

set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111146',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111146","role":"authenticated"}',true);

do $$
declare
  v_min_quote jsonb;
  v_scale_quote jsonb;
  v_min jsonb;
  v_scale jsonb;
  v_duplicate jsonb;
  v_rejected boolean := false;
begin
  v_min_quote := public.get_platform_fee_quote('33333333-3333-4333-8333-333333333346');
  v_scale_quote := public.get_platform_fee_quote('33333333-3333-4333-8333-333333333347');
  v_min := public.create_platform_fee_payment_intent(
    '33333333-3333-4333-8333-333333333346',
    (v_min_quote->>'eligibleVoterCount')::integer,
    (v_min_quote->>'amountMinor')::bigint,
    (v_min_quote->>'policyVersion')::integer
  );
  v_scale := public.create_platform_fee_payment_intent(
    '33333333-3333-4333-8333-333333333347',
    (v_scale_quote->>'eligibleVoterCount')::integer,
    (v_scale_quote->>'amountMinor')::bigint,
    (v_scale_quote->>'policyVersion')::integer
  );
  v_duplicate := public.create_platform_fee_payment_intent(
    '33333333-3333-4333-8333-333333333346',
    (v_min_quote->>'eligibleVoterCount')::integer,
    (v_min_quote->>'amountMinor')::bigint,
    (v_min_quote->>'policyVersion')::integer
  );

  if (v_min->>'amountMinor')::bigint <> 50000
    or (v_min->>'eligibleVoterCount')::integer <> 10
    or (v_scale->>'amountMinor')::bigint <> 60000
    or (v_scale->>'eligibleVoterCount')::integer <> 30
    or v_min->>'policyVersion' <> '1'
    or v_min->>'paymentIntentId' <> v_duplicate->>'paymentIntentId'
    or v_duplicate->>'duplicate' <> 'true' then
    raise exception 'PLATFORM_FEE_SERVER_PRICING_OR_IDEMPOTENCY_FAILED';
  end if;

  perform set_config('test.platform_fee_paid_intent',v_min->>'paymentIntentId',true);
  perform set_config('test.platform_fee_unpaid_election','33333333-3333-4333-8333-333333333347',true);

  begin
    insert into public.election_voters(
      organization_id,election_id,external_voter_ref,display_name,weight_units
    ) values (
      '22222222-2222-4222-8222-222222222246',
      '33333333-3333-4333-8333-333333333346',
      'late-voter','Late voter',1
    );
  exception when sqlstate '55000' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'VOTER_REGISTER_MUST_FREEZE_AFTER_FEE_QUOTE'; end if;
end;
$$;

reset role;

do $$
declare v_rejected boolean := false;
begin
  begin
    update public.elections set status='open'
    where id='33333333-3333-4333-8333-333333333347';
  exception when sqlstate '55000' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'ELECTION_OPEN_MUST_REQUIRE_PAID_PLATFORM_FEE'; end if;
end;
$$;

set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

update public.payment_intents
set status='success',
    provider_transaction_id='paystack-platform-fee-smoke-transaction',
    provider_status='success',
    provider_amount_minor=50000,
    provider_currency='KES',
    verified_at=now()
where id=current_setting('test.platform_fee_paid_intent')::uuid;

reset role;

do $$
declare v_status text;
begin
  select platform_fee_status into v_status
  from public.elections
  where id='33333333-3333-4333-8333-333333333346';
  if v_status <> 'paid' then
    raise exception 'VERIFIED_PLATFORM_FEE_PAYMENT_MUST_MARK_ELECTION_PAID';
  end if;
end;
$$;

rollback;
