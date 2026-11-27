-- Versioned platform service-fee policy and server-priced registered-election invoices.
-- KES 20 per eligible voter, KES 500 minimum; client never supplies the amount.

create table public.platform_fee_policies (
  version integer primary key check (version > 0),
  currency character(3) not null check (currency = 'KES'),
  amount_per_eligible_voter_minor bigint not null check (amount_per_eligible_voter_minor > 0),
  minimum_fee_minor bigint not null check (minimum_fee_minor > 0),
  effective_from timestamptz not null default now(),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  check (amount_per_eligible_voter_minor <= 1000000000 and minimum_fee_minor <= 1000000000)
);

create unique index platform_fee_policies_one_active_uq on public.platform_fee_policies(active) where active=true;

insert into public.platform_fee_policies(
  version,currency,amount_per_eligible_voter_minor,minimum_fee_minor,active
) values (1,'KES',2000,50000,true);

alter table public.platform_fee_policies enable row level security;
revoke all on public.platform_fee_policies from public,anon,authenticated;
grant select on public.platform_fee_policies to service_role;

alter table public.elections
  add column platform_fee_policy_version integer references public.platform_fee_policies(version),
  add column platform_fee_eligible_voter_count integer check (platform_fee_eligible_voter_count is null or platform_fee_eligible_voter_count > 0),
  add column platform_fee_amount_minor bigint check (platform_fee_amount_minor is null or platform_fee_amount_minor > 0),
  add column platform_fee_quoted_at timestamptz,
  add column platform_fee_payment_intent_id uuid references public.payment_intents(id) on delete restrict,
  add column platform_fee_payment_attempt integer not null default 0 check (platform_fee_payment_attempt >= 0),
  add column platform_fee_status text not null default 'not_quoted'
    check (platform_fee_status in ('not_quoted','unpaid','pending','paid','exception'));

create unique index elections_platform_fee_intent_uq
  on public.elections(platform_fee_payment_intent_id)
  where platform_fee_payment_intent_id is not null;

alter table public.elections
  add constraint elections_platform_fee_quote_complete
  check (
    (platform_fee_policy_version is null
      and platform_fee_eligible_voter_count is null
      and platform_fee_amount_minor is null
      and platform_fee_quoted_at is null
      and platform_fee_payment_intent_id is null
      and platform_fee_payment_attempt = 0
      and platform_fee_status = 'not_quoted')
    or
    (platform_fee_policy_version is not null
      and platform_fee_eligible_voter_count is not null
      and platform_fee_amount_minor is not null
      and platform_fee_quoted_at is not null
      and platform_fee_payment_intent_id is not null
      and platform_fee_payment_attempt > 0
      and platform_fee_status <> 'not_quoted')
  );

create or replace function mandate_private.get_platform_fee_quote(p_election_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $
declare
  v_user uuid := auth.uid();
  v_e public.elections%rowtype;
  v_policy public.platform_fee_policies%rowtype;
  v_count integer;
  v_amount bigint;
begin
  if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  select * into v_e from public.elections where id=p_election_id;
  if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id=v_e.organization_id and m.user_id=v_user
      and m.status='active' and m.role in ('owner','admin','finance_manager')
  ) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_e.voting_mode not in ('registered_single','registered_weighted') then
    raise exception 'PLATFORM_FEE_NOT_APPLICABLE_TO_PUBLIC_PAID_ELECTION' using errcode='22023';
  end if;
  select count(*)::integer into v_count from public.election_voters
  where election_id=v_e.id and eligibility_status='eligible';
  if v_e.platform_fee_quoted_at is not null then
    return jsonb_build_object(
      'eligibleVoterCount',v_e.platform_fee_eligible_voter_count,
      'amountMinor',v_e.platform_fee_amount_minor,'currency','KES',
      'policyVersion',v_e.platform_fee_policy_version,
      'status',v_e.platform_fee_status,'quotedAt',v_e.platform_fee_quoted_at
    );
  end if;
  select * into v_policy from public.platform_fee_policies
  where active=true and effective_from<=now() order by version desc limit 1;
  if not found then raise exception 'PLATFORM_FEE_POLICY_UNAVAILABLE' using errcode='55000'; end if;
  v_amount := greatest(v_count::bigint * v_policy.amount_per_eligible_voter_minor,v_policy.minimum_fee_minor);
  return jsonb_build_object(
    'eligibleVoterCount',v_count,'amountMinor',v_amount,'currency',v_policy.currency,
    'policyVersion',v_policy.version,'status',case when v_count=0 then 'awaiting_voter_register' else 'quote_available' end
  );
end;
$;

revoke all on function mandate_private.get_platform_fee_quote(uuid) from public,anon;
grant execute on function mandate_private.get_platform_fee_quote(uuid) to authenticated;
create or replace function public.get_platform_fee_quote(p_election_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.get_platform_fee_quote($1); $$;
revoke all on function public.get_platform_fee_quote(uuid) from public,anon;
grant execute on function public.get_platform_fee_quote(uuid) to authenticated;

create or replace function mandate_private.create_platform_fee_payment_intent(
  p_election_id uuid,p_expected_voter_count integer,p_expected_amount_minor bigint,p_expected_policy_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_e public.elections%rowtype;
  v_policy public.platform_fee_policies%rowtype;
  v_count integer;
  v_amount bigint;
  v_intent public.payment_intents%rowtype;
  v_attempt integer;
  v_reference text;
  v_idempotency text;
  v_duplicate boolean := false;
begin
  if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;

  select * into v_e from public.elections where id=p_election_id for update;
  if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
  if v_e.voting_mode not in ('registered_single','registered_weighted') then
    raise exception 'PLATFORM_FEE_NOT_APPLICABLE_TO_PUBLIC_PAID_ELECTION' using errcode='22023';
  end if;
  if v_e.status not in ('draft','scheduled') then raise exception 'ELECTION_BILLING_FROZEN' using errcode='55000'; end if;

  if not exists (
    select 1 from public.organization_members m
    where m.organization_id=v_e.organization_id
      and m.user_id=v_user
      and m.status='active'
      and m.role in ('owner','admin','finance_manager')
  ) then raise exception 'FORBIDDEN' using errcode='42501'; end if;

  select * into v_policy
  from public.platform_fee_policies
  where active=true and effective_from<=now()
  order by version desc
  limit 1;
  if not found then raise exception 'PLATFORM_FEE_POLICY_UNAVAILABLE' using errcode='55000'; end if;

  select count(*)::integer into v_count
  from public.election_voters
  where election_id=v_e.id and eligibility_status='eligible';
  if v_count<1 then raise exception 'ELIGIBLE_VOTERS_REQUIRED' using errcode='23514'; end if;

  if v_e.platform_fee_quoted_at is not null then
    if p_expected_voter_count is distinct from v_e.platform_fee_eligible_voter_count
      or p_expected_amount_minor is distinct from v_e.platform_fee_amount_minor
      or p_expected_policy_version is distinct from v_e.platform_fee_policy_version then
      raise exception 'PLATFORM_FEE_QUOTE_CHANGED' using errcode='40001';
    end if;
  else
    v_amount := greatest(v_count::bigint * v_policy.amount_per_eligible_voter_minor,v_policy.minimum_fee_minor);
    if p_expected_voter_count is distinct from v_count
      or p_expected_amount_minor is distinct from v_amount
      or p_expected_policy_version is distinct from v_policy.version then
      raise exception 'PLATFORM_FEE_QUOTE_CHANGED' using errcode='40001';
    end if;
  end if;

  if v_e.platform_fee_payment_intent_id is not null then
    select * into v_intent from public.payment_intents
    where id=v_e.platform_fee_payment_intent_id;
    if not found then raise exception 'PLATFORM_FEE_INTENT_STATE_MISSING' using errcode='55000'; end if;

    if v_intent.status='success' then
      return jsonb_build_object(
        'paymentIntentId',v_intent.id,'reference',v_intent.provider_reference,
        'amountMinor',v_intent.amount_minor,'currency',v_intent.currency,
        'eligibleVoterCount',v_e.platform_fee_eligible_voter_count,
        'policyVersion',v_e.platform_fee_policy_version,'status','paid','duplicate',true
      );
    elsif v_intent.status not in ('failed','abandoned') then
      v_duplicate := true;
      return jsonb_build_object(
        'paymentIntentId',v_intent.id,'reference',v_intent.provider_reference,
        'amountMinor',v_intent.amount_minor,'currency',v_intent.currency,
        'eligibleVoterCount',v_e.platform_fee_eligible_voter_count,
        'policyVersion',v_e.platform_fee_policy_version,'status',v_e.platform_fee_status,'duplicate',true
      );
    end if;

    -- A failed/abandoned provider attempt may be retried with a fresh unique reference.
    -- An exception, reversal or refund is deliberately not retryable here.
    if v_intent.status in ('failed','abandoned') then
      select * into v_policy from public.platform_fee_policies where version=v_e.platform_fee_policy_version;
      if not found then raise exception 'PLATFORM_FEE_POLICY_SNAPSHOT_MISSING' using errcode='55000'; end if;
      v_count := v_e.platform_fee_eligible_voter_count;
      v_amount := v_e.platform_fee_amount_minor;
      v_attempt := v_e.platform_fee_payment_attempt + 1;
    end if;
  else
    v_amount := greatest(v_count::bigint * v_policy.amount_per_eligible_voter_minor, v_policy.minimum_fee_minor);
    v_attempt := 1;
  end if;

  if v_e.platform_fee_payment_intent_id is not null
     and v_intent.status in ('failed','abandoned') then
    -- The quoted voter count and policy are immutable once the first invoice is created.
    v_amount := v_e.platform_fee_amount_minor;
  end if;

  v_reference := 'mandate-fee-' || replace(gen_random_uuid()::text,'-','');
  v_idempotency := 'platform-fee:' || v_e.id::text || ':v' || v_policy.version::text || ':attempt:' || v_attempt::text;

  insert into public.payment_intents(
    organization_id,election_id,purpose,provider,provider_reference,
    amount_minor,currency,status,idempotency_key
  ) values (
    v_e.organization_id,v_e.id,'platform_fee','paystack',v_reference,
    v_amount,v_policy.currency,'initialized',v_idempotency
  ) returning * into v_intent;

  update public.elections
  set platform_fee_policy_version=coalesce(platform_fee_policy_version,v_policy.version),
      platform_fee_eligible_voter_count=coalesce(platform_fee_eligible_voter_count,v_count),
      platform_fee_amount_minor=coalesce(platform_fee_amount_minor,v_amount),
      platform_fee_quoted_at=coalesce(platform_fee_quoted_at,now()),
      platform_fee_payment_intent_id=v_intent.id,
      platform_fee_payment_attempt=v_attempt,
      platform_fee_status='unpaid'
  where id=v_e.id;

  insert into public.audit_events(
    organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata
  ) values (
    v_e.organization_id,v_e.id,v_user,'user','platform_fee.invoice_created',
    'payment_intent',v_intent.id,
    jsonb_build_object(
      'policyVersion',v_policy.version,
      'eligibleVoterCount',v_count,
      'amountMinor',v_amount,
      'currency',v_policy.currency,
      'attempt',v_attempt
    )
  );

  return jsonb_build_object(
    'paymentIntentId',v_intent.id,'reference',v_intent.provider_reference,
    'amountMinor',v_intent.amount_minor,'currency',v_intent.currency,
    'eligibleVoterCount',v_count,'policyVersion',v_policy.version,
    'status','unpaid','duplicate',v_duplicate
  );
end;
$$;

revoke all on function mandate_private.create_platform_fee_payment_intent(uuid,integer,bigint,integer) from public,anon;
grant execute on function mandate_private.create_platform_fee_payment_intent(uuid,integer,bigint,integer) to authenticated;

create or replace function public.create_platform_fee_payment_intent(
  p_election_id uuid,p_expected_voter_count integer,p_expected_amount_minor bigint,p_expected_policy_version integer
)
returns jsonb language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.create_platform_fee_payment_intent($1,$2,$3,$4); $$;
revoke all on function public.create_platform_fee_payment_intent(uuid,integer,bigint,integer) from public,anon;
grant execute on function public.create_platform_fee_payment_intent(uuid,integer,bigint,integer) to authenticated;

create or replace function mandate_private.sync_platform_fee_payment_status()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,pg_temp
as $$
begin
  if new.purpose='platform_fee' and new.election_id is not null
     and new.status is distinct from old.status then
    update public.elections
    set platform_fee_status=case
          when new.status='success' then 'paid'
          when new.status in ('exception','reversed','refunded') then 'exception'
          when new.status in ('pending') then 'pending'
          when new.status in ('failed','abandoned','initialized') then 'unpaid'
          else platform_fee_status
        end
    where id=new.election_id
      and platform_fee_payment_intent_id=new.id;
  end if;
  return new;
end;
$$;

revoke all on function mandate_private.sync_platform_fee_payment_status() from public,anon,authenticated;
create trigger payment_intents_sync_platform_fee_status
after update of status on public.payment_intents
for each row execute function mandate_private.sync_platform_fee_payment_status();

create or replace function mandate_private.guard_platform_fee_before_election_open()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,pg_temp
as $$
begin
  if new.status='open' and old.status is distinct from new.status
     and new.voting_mode in ('registered_single','registered_weighted')
     and new.platform_fee_status is distinct from 'paid' then
    raise exception 'PLATFORM_FEE_PAYMENT_REQUIRED' using errcode='55000';
  end if;
  return new;
end;
$$;

revoke all on function mandate_private.guard_platform_fee_before_election_open() from public,anon,authenticated;
create trigger elections_require_platform_fee_before_open
before update of status on public.elections
for each row execute function mandate_private.guard_platform_fee_before_election_open();

create or replace function mandate_private.guard_voter_register_after_platform_fee_quote()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,pg_temp
as $$
declare
  v_election_id uuid;
  v_locked boolean;
begin
  if tg_op='DELETE' then v_election_id := old.election_id; else v_election_id := new.election_id; end if;
  select platform_fee_quoted_at is not null into v_locked
  from public.elections where id=v_election_id;
  if coalesce(v_locked,false) then
    if tg_op='INSERT' or tg_op='DELETE'
      or (tg_op='UPDATE' and (new.election_id is distinct from old.election_id
        or 
        new.external_voter_ref is distinct from old.external_voter_ref
        or new.display_name is distinct from old.display_name
        or new.normalized_email is distinct from old.normalized_email
        or new.phone_e164 is distinct from old.phone_e164
        or new.eligibility_status is distinct from old.eligibility_status
        or new.weight_units is distinct from old.weight_units
      )) then
      raise exception 'VOTER_REGISTER_FROZEN_BY_PLATFORM_FEE_QUOTE' using errcode='55000';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function mandate_private.guard_voter_register_after_platform_fee_quote() from public,anon,authenticated;
create trigger election_voters_platform_fee_quote_guard
before insert or update or delete on public.election_voters
for each row execute function mandate_private.guard_voter_register_after_platform_fee_quote();

comment on table public.platform_fee_policies is
  'Versioned server-controlled platform service-fee policies. Amounts are integer KES minor units; no browser write access.';
comment on column public.elections.platform_fee_amount_minor is
  'Immutable quoted platform service fee based on the eligible-voter count and policy version captured at invoice creation.';
