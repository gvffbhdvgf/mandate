-- Require provider-confirmed split evidence before public voting credits can be fulfilled.
-- Provider split facts and successful payment state are committed atomically.

-- Validate the immutable policy/profile snapshot only when it is attached.
-- Later settlement-state transitions remain valid if the policy is retired.
drop trigger if exists payment_intents_validate_split_profile on public.payment_intents;
create trigger payment_intents_validate_split_profile
before insert or update of split_policy_version, split_subaccount_profile_id,
  split_fee_type, split_fixed_fee_minor, split_percentage_basis_points, split_fee_bearer,
  split_snapshot_at, amount_minor, currency, purpose, election_id
on public.payment_intents
for each row
when (new.split_status <> 'not_configured')
execute function mandate_private.validate_payment_intent_split_profile();

create or replace function mandate_private.require_verified_public_vote_split()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.purpose = 'public_vote_credits' and new.status = 'success' then
    if new.split_status <> 'verified'
      or new.provider_split_verified_at is null
      or new.provider_split_shares is null
      or new.provider_platform_share_minor is null
      or new.provider_organizer_share_minor is null
      or new.provider_processing_fee_minor is null then
      raise exception 'PUBLIC_VOTE_SPLIT_VERIFICATION_REQUIRED' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function mandate_private.require_verified_public_vote_split()
  from public, anon, authenticated;
create trigger payment_intents_require_verified_public_vote_split
before insert or update of status, split_status, provider_split_verified_at
on public.payment_intents
for each row
execute function mandate_private.require_verified_public_vote_split();

create or replace function mandate_private.apply_verified_paystack_public_vote_split(
  p_event_id uuid,
  p_provider_reference text,
  p_provider_transaction_id text,
  p_provider_status text,
  p_amount_minor bigint,
  p_currency text,
  p_fees_split jsonb,
  p_subaccount_code text,
  p_subaccount_percentage_charge numeric
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_event public.payment_events%rowtype;
  v_intent public.payment_intents%rowtype;
  v_profile public.organization_paystack_subaccounts%rowtype;
  v_paystack_numeric numeric;
  v_integration_numeric numeric;
  v_subaccount_numeric numeric;
  v_paystack_fee bigint;
  v_integration_net bigint;
  v_subaccount_net bigint;
  v_platform_gross bigint;
  v_organizer_gross bigint;
  v_expected_platform_gross bigint;
  v_provider_shares jsonb;
begin
  if p_provider_status is distinct from 'success'
    or p_provider_transaction_id is null
    or p_provider_reference is null
    or p_amount_minor is null or p_amount_minor <= 0
    or p_currency is null
    or jsonb_typeof(p_fees_split) is distinct from 'object'
    or p_subaccount_code is null then
    raise exception 'PAYSTACK_SPLIT_VERIFICATION_FACTS_MISSING' using errcode = '22023';
  end if;

  if p_event_id is not null then
    select * into v_event
    from public.payment_events
    where id = p_event_id
    for update;

    if not found
      or v_event.provider <> 'paystack'
      or v_event.signature_verified is distinct from true
      or v_event.event_type <> 'charge.success'
      or v_event.provider_reference is distinct from p_provider_reference then
      raise exception 'INVALID_VERIFIED_PAYSTACK_EVENT' using errcode = '22023';
    end if;

    if v_event.processing_status = 'processed' then
      return jsonb_build_object('duplicate', true, 'processed', true, 'status', 'success');
    end if;
  end if;

  select * into v_intent
  from public.payment_intents
  where provider = 'paystack'
    and provider_reference = p_provider_reference
  for update;

  if not found
    or v_intent.purpose <> 'public_vote_credits'
    or v_intent.split_status not in ('pending','verified')
    or v_intent.split_snapshot_at is null then
    raise exception 'PUBLIC_VOTE_SPLIT_INTENT_NOT_CONFIGURED' using errcode = '23514';
  end if;

  if v_intent.status = 'success' then
    if v_intent.provider_transaction_id = p_provider_transaction_id
      and v_intent.split_status = 'verified'
      and v_intent.provider_split_verified_at is not null then
      if p_event_id is not null then
        update public.payment_events
        set processing_status = 'processed', processed_at = pg_catalog.now()
        where id = p_event_id;
      end if;
      return jsonb_build_object('duplicate', true, 'processed', true, 'matched', true, 'status', 'success');
    end if;
    raise exception 'PAYMENT_STATE_TERMINAL' using errcode = '23514';
  end if;

  if v_intent.status not in ('initialized','pending') then
    raise exception 'PAYMENT_STATE_TERMINAL' using errcode = '23514';
  end if;

  if p_amount_minor is distinct from v_intent.amount_minor
    or p_currency is distinct from v_intent.currency then
    update public.payment_intents
    set status = 'exception',
        provider_transaction_id = p_provider_transaction_id,
        provider_status = p_provider_status,
        provider_amount_minor = p_amount_minor,
        provider_currency = p_currency,
        split_status = 'exception',
        verified_at = pg_catalog.now()
    where id = v_intent.id;
    if p_event_id is not null then
      update public.payment_events
      set processing_status = 'processed', processed_at = pg_catalog.now()
      where id = p_event_id;
    end if;
    return jsonb_build_object('processed', true, 'matched', false, 'status', 'exception', 'reason', 'PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH');
  end if;

  select * into v_profile
  from public.organization_paystack_subaccounts
  where id = v_intent.split_subaccount_profile_id
  for share;

  if not found
    or v_profile.status <> 'verified'
    or v_profile.provider_subaccount_code is distinct from p_subaccount_code
    or v_profile.currency is distinct from v_intent.currency then
    update public.payment_intents
    set status = 'exception',
        provider_transaction_id = p_provider_transaction_id,
        provider_status = p_provider_status,
        provider_amount_minor = p_amount_minor,
        provider_currency = p_currency,
        split_status = 'exception',
        verified_at = pg_catalog.now()
    where id = v_intent.id;
    if p_event_id is not null then
      update public.payment_events
      set processing_status = 'processed', processed_at = pg_catalog.now()
      where id = p_event_id;
    end if;
    return jsonb_build_object('processed', true, 'matched', false, 'status', 'exception', 'reason', 'PAYSTACK_SUBACCOUNT_MISMATCH');
  end if;

  if v_intent.split_fee_type <> 'fixed' then
    update public.payment_intents
    set status = 'exception',
        provider_transaction_id = p_provider_transaction_id,
        provider_status = p_provider_status,
        provider_amount_minor = p_amount_minor,
        provider_currency = p_currency,
        split_status = 'exception',
        verified_at = pg_catalog.now()
    where id = v_intent.id;
    if p_event_id is not null then
      update public.payment_events
      set processing_status = 'processed', processed_at = pg_catalog.now()
      where id = p_event_id;
    end if;
    return jsonb_build_object('processed', true, 'matched', false, 'status', 'exception', 'reason', 'PERCENTAGE_SPLIT_ROUNDING_NOT_YET_APPROVED');
  end if;

  if jsonb_typeof(p_fees_split->'paystack') is distinct from 'number'
    or jsonb_typeof(p_fees_split->'integration') is distinct from 'number'
    or jsonb_typeof(p_fees_split->'subaccount') is distinct from 'number'
    or (p_fees_split->>'paystack') !~ '^[0-9]+$'
    or (p_fees_split->>'integration') !~ '^[0-9]+$'
    or (p_fees_split->>'subaccount') !~ '^[0-9]+$' then
    update public.payment_intents
    set status = 'exception',
        provider_transaction_id = p_provider_transaction_id,
        provider_status = p_provider_status,
        provider_amount_minor = p_amount_minor,
        provider_currency = p_currency,
        split_status = 'exception',
        verified_at = pg_catalog.now()
    where id = v_intent.id;
    if p_event_id is not null then
      update public.payment_events
      set processing_status = 'processed', processed_at = pg_catalog.now()
      where id = p_event_id;
    end if;
    return jsonb_build_object('processed', true, 'matched', false, 'status', 'exception', 'reason', 'PAYSTACK_SPLIT_SHARES_INVALID');
  end if;

  v_paystack_numeric := (p_fees_split->>'paystack')::numeric;
  v_integration_numeric := (p_fees_split->>'integration')::numeric;
  v_subaccount_numeric := (p_fees_split->>'subaccount')::numeric;

  if v_paystack_numeric > 9223372036854775807
    or v_integration_numeric > 9223372036854775807
    or v_subaccount_numeric > 9223372036854775807
    or v_paystack_numeric + v_integration_numeric + v_subaccount_numeric <> p_amount_minor::numeric then
    update public.payment_intents
    set status = 'exception',
        provider_transaction_id = p_provider_transaction_id,
        provider_status = p_provider_status,
        provider_amount_minor = p_amount_minor,
        provider_currency = p_currency,
        split_status = 'exception',
        verified_at = pg_catalog.now()
    where id = v_intent.id;
    if p_event_id is not null then
      update public.payment_events
      set processing_status = 'processed', processed_at = pg_catalog.now()
      where id = p_event_id;
    end if;
    return jsonb_build_object('processed', true, 'matched', false, 'status', 'exception', 'reason', 'PAYSTACK_SPLIT_TOTAL_MISMATCH');
  end if;

  v_paystack_fee := v_paystack_numeric::bigint;
  v_integration_net := v_integration_numeric::bigint;
  v_subaccount_net := v_subaccount_numeric::bigint;

  if v_intent.split_fee_bearer = 'mandate' then
    v_platform_gross := v_integration_net + v_paystack_fee;
    v_organizer_gross := v_subaccount_net;
  else
    v_platform_gross := v_integration_net;
    v_organizer_gross := v_subaccount_net + v_paystack_fee;
  end if;

  v_expected_platform_gross := v_intent.split_fixed_fee_minor;

  if v_platform_gross <> v_expected_platform_gross
    or v_platform_gross::numeric + v_organizer_gross::numeric <> p_amount_minor::numeric then
    update public.payment_intents
    set status = 'exception',
        provider_transaction_id = p_provider_transaction_id,
        provider_status = p_provider_status,
        provider_amount_minor = p_amount_minor,
        provider_currency = p_currency,
        split_status = 'exception',
        verified_at = pg_catalog.now()
    where id = v_intent.id;
    if p_event_id is not null then
      update public.payment_events
      set processing_status = 'processed', processed_at = pg_catalog.now()
      where id = p_event_id;
    end if;
    return jsonb_build_object('processed', true, 'matched', false, 'status', 'exception', 'reason', 'PAYSTACK_SPLIT_AMOUNT_MISMATCH');
  end if;

  v_provider_shares := jsonb_build_object(
    'paystack', v_paystack_fee,
    'integration', v_integration_net,
    'subaccount', v_subaccount_net,
    'subaccount_code', p_subaccount_code,
    'subaccount_percentage_charge', p_subaccount_percentage_charge
  );

  update public.payment_intents
  set split_status = 'verified',
      provider_split_shares = v_provider_shares,
      provider_platform_share_minor = v_platform_gross,
      provider_organizer_share_minor = v_organizer_gross,
      provider_processing_fee_minor = v_paystack_fee,
      provider_split_verified_at = pg_catalog.now(),
      status = 'success',
      provider_transaction_id = p_provider_transaction_id,
      provider_status = p_provider_status,
      provider_amount_minor = p_amount_minor,
      provider_currency = p_currency,
      verified_at = pg_catalog.now()
  where id = v_intent.id;

  if p_event_id is not null then
    update public.payment_events
    set processing_status = 'processed', processed_at = pg_catalog.now()
    where id = p_event_id;
  end if;

  return jsonb_build_object('duplicate', false, 'processed', true, 'matched', true, 'status', 'success');
end;
$$;

revoke all on function mandate_private.apply_verified_paystack_public_vote_split(uuid,text,text,text,bigint,text,jsonb,text,numeric)
  from public, anon, authenticated;
grant execute on function mandate_private.apply_verified_paystack_public_vote_split(uuid,text,text,text,bigint,text,jsonb,text,numeric)
  to service_role;

create or replace function public.apply_verified_paystack_public_vote_split(
  p_event_id uuid,
  p_provider_reference text,
  p_provider_transaction_id text,
  p_provider_status text,
  p_amount_minor bigint,
  p_currency text,
  p_fees_split jsonb,
  p_subaccount_code text,
  p_subaccount_percentage_charge numeric
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $$
  select mandate_private.apply_verified_paystack_public_vote_split(
    $1,$2,$3,$4,$5,$6,$7,$8,$9
  );
$$;

revoke all on function public.apply_verified_paystack_public_vote_split(uuid,text,text,text,bigint,text,jsonb,text,numeric)
  from public, anon, authenticated;
grant execute on function public.apply_verified_paystack_public_vote_split(uuid,text,text,text,bigint,text,jsonb,text,numeric)
  to service_role;

comment on function mandate_private.apply_verified_paystack_public_vote_split(uuid,text,text,text,bigint,text,jsonb,text,numeric)
  is 'Atomically validates Paystack split shares against a fixed public-voting fee snapshot, records provider facts, marks payment success, and allows the credit-issuance trigger to run. Percentage policies fail closed until provider rounding semantics are approved.';
