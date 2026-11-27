-- Paystack split-settlement foundations for public paid voting.
-- No policy is seeded or activated. All tables remain server-only.
-- This migration is additive and does not enable checkout or alter production by itself.

create table public.organization_paystack_subaccounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  provider public.payment_provider not null default 'paystack' check (provider = 'paystack'),
  provider_subaccount_code text not null unique
    check (provider_subaccount_code ~ '^[A-Za-z0-9_-]{4,128}$'),
  currency character(3) not null default 'KES' check (currency = 'KES'),
  provider_percentage_charge_basis_points integer not null default 0
    check (provider_percentage_charge_basis_points between 0 and 9999),
  status text not null default 'pending'
    check (status in ('pending','verified','suspended','revoked')),
  provider_verified_at timestamptz,
  verified_by uuid references auth.users(id) on delete restrict,
  created_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'pending' and provider_verified_at is null and verified_by is null)
    or (status in ('verified','suspended','revoked')
      and provider_verified_at is not null and verified_by is not null)
  )
);

create unique index organization_paystack_subaccounts_one_verified_uq
  on public.organization_paystack_subaccounts(organization_id)
  where status = 'verified';

create index organization_paystack_subaccounts_org_status_idx
  on public.organization_paystack_subaccounts(organization_id, status, created_at desc);

comment on table public.organization_paystack_subaccounts is
  'Server-only Paystack organizer subaccount references. Stores provider code and the verified main-account percentage charge in basis points, never bank-account details. A verified profile must be supported by provider KYC/beneficiary verification.';

create table public.public_vote_platform_fee_policies (
  version integer primary key check (version > 0),
  currency character(3) not null default 'KES' check (currency = 'KES'),
  fee_type text not null check (fee_type in ('fixed','percentage')),
  fixed_fee_minor bigint,
  percentage_basis_points integer,
  fee_bearer text not null check (fee_bearer in ('mandate','organizer')),
  status text not null default 'draft'
    check (status in ('draft','approved','active','retired')),
  effective_from timestamptz,
  effective_until timestamptz,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete restrict,
  approval_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (fee_type = 'fixed'
      and fixed_fee_minor is not null and fixed_fee_minor > 0
      and fixed_fee_minor <= 1000000000
      and percentage_basis_points is null)
    or
    (fee_type = 'percentage'
      and percentage_basis_points between 1 and 9999
      and fixed_fee_minor is null)
  ),
  check (effective_until is null or (effective_from is not null and effective_until > effective_from)),
  check (
    (status in ('draft') and approved_at is null and approved_by is null and approval_reference is null)
    or
    (status in ('approved','active','retired')
      and approved_at is not null and approved_by is not null
      and approval_reference is not null
      and char_length(btrim(approval_reference)) between 1 and 200)
  )
);

create unique index public_vote_platform_fee_policies_one_active_uq
  on public.public_vote_platform_fee_policies(status)
  where status = 'active';

create index public_vote_platform_fee_policies_effective_idx
  on public.public_vote_platform_fee_policies(status, effective_from desc);

comment on table public.public_vote_platform_fee_policies is
  'Versioned public paid-voting platform fee policy. No row is seeded or active by this migration; activation requires a separately approved commercial policy and Paystack eligibility.';

alter table public.payment_intents
  add column split_status text not null default 'not_configured'
    check (split_status in ('not_configured','pending','verified','exception')),
  add column split_policy_version integer
    references public.public_vote_platform_fee_policies(version) on delete restrict,
  add column split_subaccount_profile_id uuid
    references public.organization_paystack_subaccounts(id) on delete restrict,
  add column split_fee_type text check (split_fee_type in ('fixed','percentage')),
  add column split_fixed_fee_minor bigint,
  add column split_percentage_basis_points integer,
  add column split_fee_bearer text check (split_fee_bearer in ('mandate','organizer')),
  add column split_snapshot_at timestamptz,
  add column provider_split_code text,
  add column provider_split_shares jsonb,
  add column provider_platform_share_minor bigint,
  add column provider_organizer_share_minor bigint,
  add column provider_processing_fee_minor bigint,
  add column provider_split_verified_at timestamptz;

alter table public.payment_intents
  add constraint payment_intents_split_snapshot_complete check (
    (
      split_status = 'not_configured'
      and split_policy_version is null
      and split_subaccount_profile_id is null
      and split_fee_type is null
      and split_fixed_fee_minor is null
      and split_percentage_basis_points is null
      and split_fee_bearer is null
      and split_snapshot_at is null
      and provider_split_code is null
      and provider_split_shares is null
      and provider_platform_share_minor is null
      and provider_organizer_share_minor is null
      and provider_processing_fee_minor is null
      and provider_split_verified_at is null
    )
    or
    (
      split_status in ('pending','verified','exception')
      and purpose = 'public_vote_credits'
      and election_id is not null
      and split_policy_version is not null
      and split_subaccount_profile_id is not null
      and split_fee_type is not null
      and split_fee_bearer is not null
      and split_snapshot_at is not null
      and (
        (split_fee_type = 'fixed' and split_fixed_fee_minor > 0
          and split_percentage_basis_points is null)
        or
        (split_fee_type = 'percentage' and split_percentage_basis_points between 1 and 9999
          and split_fixed_fee_minor is null)
      )
      and (
        split_status <> 'verified'
        or (
          provider_split_shares is not null
          and jsonb_typeof(provider_split_shares) = 'object'
          and provider_platform_share_minor is not null and provider_platform_share_minor >= 0
          and provider_organizer_share_minor is not null and provider_organizer_share_minor >= 0
          and provider_processing_fee_minor is not null and provider_processing_fee_minor >= 0
          and provider_split_verified_at is not null
        )
      )
      and (
        provider_split_shares is null
        or jsonb_typeof(provider_split_shares) = 'object'
      )
      and (provider_platform_share_minor is null or provider_platform_share_minor >= 0)
      and (provider_organizer_share_minor is null or provider_organizer_share_minor >= 0)
      and (provider_processing_fee_minor is null or provider_processing_fee_minor >= 0)
    )
  );

create or replace function mandate_private.validate_payment_intent_split_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_election_organization_id uuid;
  v_profile public.organization_paystack_subaccounts%rowtype;
  v_policy public.public_vote_platform_fee_policies%rowtype;
begin
  if new.split_status = 'not_configured' then
    return new;
  end if;

  if new.purpose <> 'public_vote_credits' or new.election_id is null then
    raise exception 'PAYSTACK_SPLIT_ONLY_SUPPORTED_FOR_PUBLIC_VOTE_CREDITS' using errcode = '23514';
  end if;

  select e.organization_id into v_election_organization_id
  from public.elections e
  where e.id = new.election_id and e.voting_mode = 'public_paid';

  if not found then
    raise exception 'PUBLIC_PAID_ELECTION_REQUIRED_FOR_SPLIT' using errcode = '23514';
  end if;

  select * into v_profile
  from public.organization_paystack_subaccounts
  where id = new.split_subaccount_profile_id
  for share;

  if not found
    or v_profile.organization_id is distinct from v_election_organization_id
    or v_profile.status <> 'verified'
    or v_profile.currency <> new.currency then
    raise exception 'VERIFIED_ORGANIZER_SUBACCOUNT_REQUIRED' using errcode = '23514';
  end if;

  select * into v_policy
  from public.public_vote_platform_fee_policies
  where version = new.split_policy_version
  for share;

  if not found
    or v_policy.status not in ('approved','active')
    or v_policy.currency <> new.currency
    or v_policy.fee_type <> new.split_fee_type
    or v_policy.fee_bearer <> new.split_fee_bearer
    or v_policy.fixed_fee_minor is distinct from new.split_fixed_fee_minor
    or v_policy.percentage_basis_points is distinct from new.split_percentage_basis_points then
    raise exception 'APPROVED_PUBLIC_VOTE_FEE_POLICY_REQUIRED' using errcode = '23514';
  end if;

  if v_policy.effective_from is null or v_policy.effective_from > new.split_snapshot_at
    or (v_policy.effective_until is not null and v_policy.effective_until <= new.split_snapshot_at) then
    raise exception 'PUBLIC_VOTE_FEE_POLICY_NOT_EFFECTIVE' using errcode = '23514';
  end if;

  if new.split_fee_type = 'fixed' and new.split_fixed_fee_minor >= new.amount_minor then
    raise exception 'PUBLIC_VOTE_PLATFORM_FEE_EXCEEDS_PAYMENT' using errcode = '23514';
  end if;

  if new.split_fee_type = 'percentage'
    and v_profile.provider_percentage_charge_basis_points is distinct from new.split_percentage_basis_points then
    raise exception 'SUBACCOUNT_PERCENTAGE_DOES_NOT_MATCH_FEE_POLICY' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function mandate_private.validate_payment_intent_split_profile() from public, anon, authenticated;

create trigger payment_intents_validate_split_profile
before insert or update of split_status, split_policy_version, split_subaccount_profile_id,
  split_fee_type, split_fixed_fee_minor, split_percentage_basis_points, split_fee_bearer,
  split_snapshot_at, amount_minor, currency, purpose, election_id
on public.payment_intents
for each row
when (new.split_status <> 'not_configured')
execute function mandate_private.validate_payment_intent_split_profile();

create or replace function mandate_private.guard_payment_intent_split_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.split_snapshot_at is not null and (
    new.split_policy_version is distinct from old.split_policy_version
    or new.split_subaccount_profile_id is distinct from old.split_subaccount_profile_id
    or new.split_fee_type is distinct from old.split_fee_type
    or new.split_fixed_fee_minor is distinct from old.split_fixed_fee_minor
    or new.split_percentage_basis_points is distinct from old.split_percentage_basis_points
    or new.split_fee_bearer is distinct from old.split_fee_bearer
    or new.split_snapshot_at is distinct from old.split_snapshot_at
  ) then
    raise exception 'PAYMENT_SPLIT_SNAPSHOT_IMMUTABLE' using errcode = '23514';
  end if;

  if old.provider_split_verified_at is not null and (
    new.provider_split_code is distinct from old.provider_split_code
    or new.provider_split_shares is distinct from old.provider_split_shares
    or new.provider_platform_share_minor is distinct from old.provider_platform_share_minor
    or new.provider_organizer_share_minor is distinct from old.provider_organizer_share_minor
    or new.provider_processing_fee_minor is distinct from old.provider_processing_fee_minor
    or new.provider_split_verified_at is distinct from old.provider_split_verified_at
  ) then
    raise exception 'PROVIDER_SPLIT_FACTS_IMMUTABLE' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function mandate_private.guard_payment_intent_split_snapshot() from public, anon, authenticated;

create trigger payment_intents_guard_split_snapshot
before update of split_policy_version, split_subaccount_profile_id, split_fee_type,
  split_fixed_fee_minor, split_percentage_basis_points, split_fee_bearer, split_snapshot_at,
  provider_split_code, provider_split_shares, provider_platform_share_minor,
  provider_organizer_share_minor, provider_processing_fee_minor, provider_split_verified_at
on public.payment_intents
for each row
execute function mandate_private.guard_payment_intent_split_snapshot();

alter table public.organization_paystack_subaccounts enable row level security;
alter table public.public_vote_platform_fee_policies enable row level security;

revoke all on public.organization_paystack_subaccounts, public.public_vote_platform_fee_policies
  from public, anon, authenticated;
grant select, insert, update on public.organization_paystack_subaccounts,
  public.public_vote_platform_fee_policies to service_role;

grant usage on schema mandate_private to service_role;
grant execute on function mandate_private.validate_payment_intent_split_profile() to service_role;
grant execute on function mandate_private.guard_payment_intent_split_snapshot() to service_role;

create or replace function mandate_private.guard_paystack_subaccount_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $
begin
  if old.provider_verified_at is not null and (
    new.organization_id is distinct from old.organization_id
    or new.provider is distinct from old.provider
    or new.provider_subaccount_code is distinct from old.provider_subaccount_code
    or new.currency is distinct from old.currency
    or new.provider_percentage_charge_basis_points is distinct from old.provider_percentage_charge_basis_points
    or new.provider_verified_at is distinct from old.provider_verified_at
    or new.verified_by is distinct from old.verified_by
    or new.created_by is distinct from old.created_by
  ) then
    raise exception 'VERIFIED_PAYSTACK_SUBACCOUNT_PROFILE_IMMUTABLE' using errcode = '23514';
  end if;
  return new;
end;
$;

create or replace function mandate_private.guard_public_vote_fee_policy()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $
begin
  if old.status <> 'draft' and (
    new.version is distinct from old.version
    or new.currency is distinct from old.currency
    or new.fee_type is distinct from old.fee_type
    or new.fixed_fee_minor is distinct from old.fixed_fee_minor
    or new.percentage_basis_points is distinct from old.percentage_basis_points
    or new.fee_bearer is distinct from old.fee_bearer
    or new.effective_from is distinct from old.effective_from
    or new.effective_until is distinct from old.effective_until
    or new.approved_at is distinct from old.approved_at
    or new.approved_by is distinct from old.approved_by
    or new.approval_reference is distinct from old.approval_reference
  ) then
    raise exception 'APPROVED_PUBLIC_VOTE_FEE_POLICY_IMMUTABLE' using errcode = '23514';
  end if;

  if old.status = 'approved' and new.status not in ('approved','active','retired') then
    raise exception 'INVALID_PUBLIC_VOTE_FEE_POLICY_TRANSITION' using errcode = '23514';
  end if;
  if old.status = 'active' and new.status not in ('active','retired') then
    raise exception 'INVALID_PUBLIC_VOTE_FEE_POLICY_TRANSITION' using errcode = '23514';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'RETIRED_PUBLIC_VOTE_FEE_POLICY_IMMUTABLE' using errcode = '23514';
  end if;
  return new;
end;
$;

revoke all on function mandate_private.guard_paystack_subaccount_profile() from public, anon, authenticated;
revoke all on function mandate_private.guard_public_vote_fee_policy() from public, anon, authenticated;

create trigger organization_paystack_subaccounts_guard
before update on public.organization_paystack_subaccounts
for each row execute function mandate_private.guard_paystack_subaccount_profile();

create trigger public_vote_platform_fee_policies_guard
before update on public.public_vote_platform_fee_policies
for each row execute function mandate_private.guard_public_vote_fee_policy();

create trigger organization_paystack_subaccounts_set_updated_at
before update on public.organization_paystack_subaccounts
for each row execute function mandate_private.set_updated_at();

create trigger public_vote_platform_fee_policies_set_updated_at
before update on public.public_vote_platform_fee_policies
for each row execute function mandate_private.set_updated_at();

grant execute on function mandate_private.guard_paystack_subaccount_profile() to service_role;
grant execute on function mandate_private.guard_public_vote_fee_policy() to service_role;

comment on column public.payment_intents.split_status is
  'Split state is not_configured by default. Public paid voting must not initialize checkout until a verified organizer subaccount and approved fee-policy snapshot are attached.';
comment on column public.payment_intents.provider_split_shares is
  'Redacted, normalized provider-reported split share facts only; never store raw webhook payloads or bank details.';
