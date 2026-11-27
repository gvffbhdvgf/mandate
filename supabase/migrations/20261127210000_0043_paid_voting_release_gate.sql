-- Global payment-purpose release flags. Every flag starts disabled and is changed only
-- by the trusted operations role after legal, provider and accounting release gates.
create table public.platform_payment_feature_flags (
  singleton boolean primary key default true check (singleton is true),
  platform_fee_enabled boolean not null default false,
  organization_topup_enabled boolean not null default false,
  public_vote_credits_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.platform_payment_feature_flags(singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.platform_payment_feature_flags enable row level security;
revoke all on public.platform_payment_feature_flags from public, anon, authenticated;
grant select,update on public.platform_payment_feature_flags to service_role;

create trigger platform_payment_feature_flags_set_updated_at
before update on public.platform_payment_feature_flags
for each row execute function mandate_private.set_updated_at();

comment on table public.platform_payment_feature_flags
  is 'Server-only global payment purpose release switches. All purposes default disabled; enabling requires explicit operational release approval.';

create or replace function mandate_private.compute_election_setup_hash(p_election_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_e public.elections%rowtype;
  v_rules jsonb;
  v_candidates jsonb;
begin
  select * into v_e from public.elections where id = p_election_id;
  if not found then raise exception 'ELECTION_NOT_FOUND' using errcode = 'P0002'; end if;

  select jsonb_build_object(
    'votingMode',v_e.voting_mode,
    'startsAt',v_e.starts_at,
    'endsAt',v_e.ends_at,
    'timezone',v_e.timezone,
    'resultVisibility',v_e.result_visibility,
    'rulesVersion',v_e.rules_version
  ) || case when v_e.voting_mode = 'public_paid' then jsonb_build_object(
    'currency',v_e.currency,
    'pricePerCreditMinor',v_e.price_per_credit_minor,
    'maxCreditsPerParticipant',v_e.max_credits_per_participant,
    'contactVerificationRequired',v_e.contact_verification_required
  ) else '{}'::jsonb end
  into v_rules;

  select jsonb_agg(jsonb_build_object(
    'contestId',c.id,
    'title',c.title,
    'required',c.is_required,
    'tiePolicy',c.tie_policy,
    'options',(
      select jsonb_agg(jsonb_build_object(
        'id',o.id,'displayName',o.display_name,'profile',o.profile
      ) order by o.display_order)
      from public.options o
      where o.contest_id = c.id and o.status = 'active'
    )
  ) order by c.display_order)
  into v_candidates
  from public.contests c
  where c.election_id = v_e.id;

  return encode(
    extensions.digest(convert_to(v_rules::text || coalesce(v_candidates::text,''),'UTF8'),'sha256'),
    'hex'
  );
end;
$$;

create or replace function mandate_private.confirm_election_setup(p_election_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_e public.elections%rowtype;
  v_actor uuid := auth.uid();
  v_hash text;
begin
  if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;

  select * into v_e from public.elections where id = p_election_id for update;
  if not found then raise exception 'ELECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not mandate_private.has_org_role(
    v_e.organization_id,
    array['owner','admin','election_manager']::public.organization_role[]
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_e.status <> 'draft' then raise exception 'ELECTION_CONFIGURATION_FROZEN' using errcode = '55000'; end if;

  if v_e.voting_mode = 'public_paid' then
    if not exists (
      select 1 from public.platform_payment_feature_flags
      where singleton and public_vote_credits_enabled
    ) then
      raise exception 'PAID_VOTING_FEATURE_GATED' using errcode = '55000';
    end if;
    if v_e.paid_voting_authorized_at is null
      or v_e.paid_voting_authorized_by is null
      or v_e.currency <> 'KES'
      or v_e.price_per_credit_minor is null
      or v_e.price_per_credit_minor <= 0
      or v_e.max_credits_per_participant is null
      or v_e.max_credits_per_participant < 1
      or not v_e.contact_verification_required then
      raise exception 'PAID_VOTING_AUTHORIZATION_REQUIRED' using errcode = '55000';
    end if;
  end if;

  if not exists(select 1 from public.contests c where c.election_id = v_e.id) then
    raise exception 'CONTEST_REQUIRED' using errcode = '23514';
  end if;
  if exists(
    select 1 from public.contests c
    where c.election_id = v_e.id
      and (select count(*) from public.options o where o.contest_id = c.id and o.status = 'active') < 2
  ) then
    raise exception 'EACH_CONTEST_REQUIRES_TWO_ACTIVE_OPTIONS' using errcode = '23514';
  end if;

  v_hash := mandate_private.compute_election_setup_hash(v_e.id);
  update public.elections
  set setup_confirmed_at = now(),
      setup_confirmed_by = v_actor,
      setup_confirmation_hash = v_hash
  where id = v_e.id;

  insert into public.audit_events(
    organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata
  ) values (
    v_e.organization_id,v_e.id,v_actor,'user','election.setup_confirmed','election',v_e.id,
    jsonb_build_object('configurationHash',v_hash)
  );

  return jsonb_build_object('electionId',v_e.id,'confirmedAt',now(),'configurationHash',v_hash);
end;
$$;

create or replace function mandate_private.open_election(
  p_election_id uuid,
  p_confirm_rules_snapshot boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user uuid := auth.uid();
  v_e public.elections%rowtype;
  v_contest_count integer;
  v_bad_contests integer;
  v_voter_count integer;
  v_rules jsonb;
  v_candidates jsonb;
  v_hash text;
begin
  if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  if p_confirm_rules_snapshot is distinct from true then
    raise exception 'RULES_CONFIRMATION_REQUIRED' using errcode = '22023';
  end if;

  select * into v_e from public.elections where id = p_election_id for update;
  if not found then raise exception 'ELECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not mandate_private.has_org_role(
    v_e.organization_id,
    array['owner','admin','election_manager']::public.organization_role[]
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_e.status not in ('draft','scheduled') then raise exception 'INVALID_ELECTION_STATE' using errcode = '55000'; end if;
  if v_e.starts_at > now() then raise exception 'ELECTION_NOT_STARTED' using errcode = '55000'; end if;
  if v_e.ends_at <= now() then raise exception 'ELECTION_WINDOW_EXPIRED' using errcode = '55000'; end if;

  if v_e.voting_mode = 'public_paid' then
    if not exists (
      select 1 from public.platform_payment_feature_flags
      where singleton and public_vote_credits_enabled
    ) then
      raise exception 'PAID_VOTING_FEATURE_GATED' using errcode = '55000';
    end if;
    if v_e.paid_voting_authorized_at is null
      or v_e.paid_voting_authorized_by is null
      or v_e.currency <> 'KES'
      or v_e.price_per_credit_minor is null
      or v_e.price_per_credit_minor <= 0
      or v_e.max_credits_per_participant is null
      or v_e.max_credits_per_participant < 1
      or not v_e.contact_verification_required then
      raise exception 'PAID_VOTING_AUTHORIZATION_REQUIRED' using errcode = '55000';
    end if;
  end if;

  if v_e.setup_confirmed_at is null
    or v_e.setup_confirmed_by is null
    or v_e.setup_confirmation_hash is null then
    raise exception 'ELECTION_SETUP_NOT_CONFIRMED' using errcode = '55000';
  end if;

  select count(*) into v_contest_count
  from public.contests c where c.election_id = v_e.id;
  if v_contest_count = 0 then raise exception 'CONTEST_REQUIRED' using errcode = '23514'; end if;

  select count(*) into v_bad_contests
  from public.contests c
  where c.election_id = v_e.id
    and (select count(*) from public.options o where o.contest_id = c.id and o.status = 'active') < 2;
  if v_bad_contests > 0 then
    raise exception 'EACH_CONTEST_REQUIRES_TWO_ACTIVE_OPTIONS' using errcode = '23514';
  end if;

  select jsonb_build_object(
    'votingMode',v_e.voting_mode,
    'startsAt',v_e.starts_at,
    'endsAt',v_e.ends_at,
    'timezone',v_e.timezone,
    'resultVisibility',v_e.result_visibility,
    'rulesVersion',v_e.rules_version
  ) || case when v_e.voting_mode = 'public_paid' then jsonb_build_object(
    'currency',v_e.currency,
    'pricePerCreditMinor',v_e.price_per_credit_minor,
    'maxCreditsPerParticipant',v_e.max_credits_per_participant,
    'contactVerificationRequired',v_e.contact_verification_required
  ) else '{}'::jsonb end
  into v_rules;

  select jsonb_agg(jsonb_build_object(
    'contestId',c.id,
    'title',c.title,
    'required',c.is_required,
    'tiePolicy',c.tie_policy,
    'options',(
      select jsonb_agg(jsonb_build_object(
        'id',o.id,'displayName',o.display_name,'profile',o.profile
      ) order by o.display_order)
      from public.options o
      where o.contest_id = c.id and o.status = 'active'
    )
  ) order by c.display_order)
  into v_candidates
  from public.contests c
  where c.election_id = v_e.id;

  v_hash := mandate_private.compute_election_setup_hash(v_e.id);
  if v_hash is distinct from v_e.setup_confirmation_hash then
    raise exception 'ELECTION_SETUP_CHANGED_RECONFIRM' using errcode = '55000';
  end if;

  if v_e.voting_mode in ('registered_single','registered_weighted') then
    select count(*) into v_voter_count
    from public.election_voters v
    where v.election_id = v_e.id and v.eligibility_status = 'eligible';
    if v_voter_count = 0 then raise exception 'ELIGIBLE_VOTERS_REQUIRED' using errcode = '23514'; end if;
    if exists(
      select 1 from public.election_voters v
      where v.election_id = v_e.id
        and v.eligibility_status = 'eligible'
        and (v.access_token_hash is null or v.invited_at is null)
    ) then
      raise exception 'VOTER_ACCESS_NOT_ISSUED' using errcode = '55000';
    end if;
  end if;

  if v_e.voting_mode = 'registered_single' and exists(
    select 1 from public.election_voters v
    where v.election_id = v_e.id and v.weight_units <> 1
  ) then
    raise exception 'SINGLE_VOTE_WEIGHT_MUST_BE_ONE' using errcode = '23514';
  end if;

  update public.elections
  set status = 'open',
      rules_snapshot = v_rules,
      candidate_snapshot = v_candidates,
      rules_hash = v_hash,
      opened_at = now()
  where id = v_e.id;

  insert into public.audit_events(
    organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata
  ) values (
    v_e.organization_id,v_e.id,v_user,'user','election.opened','election',v_e.id,
    jsonb_build_object('rulesHash',v_hash,'setupConfirmedBy',v_e.setup_confirmed_by)
  );

  return jsonb_build_object('id',v_e.id,'status','open','rulesHash',v_hash,'openedAt',now());
end;
$$;

comment on function mandate_private.compute_election_setup_hash(uuid)
  is 'Hashes all public paid voting price, cap and verification rules in addition to the normal election configuration.';
