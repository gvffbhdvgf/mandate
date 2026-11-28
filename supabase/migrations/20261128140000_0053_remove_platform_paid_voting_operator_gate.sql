-- Public paid elections are controlled by the organization that owns them.
-- Keep the global payment-purpose feature switch and owner confirmation, but
-- remove platform-operator requirement approvals and per-election authorization.

create or replace function mandate_private.has_current_public_paid_voting_approvals()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  -- Legacy compatibility only. Platform operator approvals are no longer a
  -- prerequisite; the payment-purpose feature flag remains authoritative.
  select true;
$$;
revoke all on function mandate_private.has_current_public_paid_voting_approvals() from public, anon, authenticated;
grant execute on function mandate_private.has_current_public_paid_voting_approvals() to service_role;

create or replace function mandate_private.has_current_public_paid_voting_release()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1 from public.platform_payment_feature_flags f
    where f.singleton and f.public_vote_credits_enabled
  );
$$;
revoke all on function mandate_private.has_current_public_paid_voting_release() from public, anon, authenticated;
grant execute on function mandate_private.has_current_public_paid_voting_release() to service_role;

-- The configuration hash covers election rules and paid-voting terms, not the
-- actor/timestamp that records the owner's confirmation of those terms.
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
    'publicSlug',v_e.public_slug,
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
revoke all on function mandate_private.compute_election_setup_hash(uuid) from public, anon, authenticated;

-- The election owner/manager's setup confirmation is the authorization record.
-- No separate Mandate operator action is needed.
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
  v_country char(2);
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
    select country_code into v_country from public.organizations where id = v_e.organization_id;
    if v_country is distinct from 'KE' then
      raise exception 'JURISDICTION_NOT_RELEASED' using errcode = '55000';
    end if;
    if not mandate_private.has_current_public_paid_voting_release() then
      raise exception 'PAID_VOTING_FEATURE_GATED' using errcode = '55000';
    end if;
    if v_e.currency <> 'KES'
      or v_e.price_per_credit_minor is null
      or v_e.price_per_credit_minor <= 0
      or v_e.max_credits_per_participant is null
      or v_e.max_credits_per_participant < 1
      or not v_e.contact_verification_required
      or v_e.public_slug is null
      or v_e.starts_at is null
      or v_e.ends_at is null
      or v_e.ends_at <= v_e.starts_at then
      raise exception 'PUBLIC_PAID_ELECTION_CONFIGURATION_INVALID' using errcode = '23514';
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
      setup_confirmation_hash = v_hash,
      paid_voting_authorized_at = case when v_e.voting_mode = 'public_paid' then now() else null end,
      paid_voting_authorized_by = case when v_e.voting_mode = 'public_paid' then v_actor else null end
  where id = v_e.id;

  insert into public.audit_events(
    organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata
  ) values (
    v_e.organization_id,v_e.id,v_actor,'user','election.setup_confirmed','election',v_e.id,
    jsonb_build_object('configurationHash',v_hash,'authorization','organization_owner_confirmation','scope','Kenya private organizational election; owner attests applicable law and provider terms')
  );

  return jsonb_build_object('electionId',v_e.id,'confirmedAt',now(),'configurationHash',v_hash);
end;
$$;
revoke all on function mandate_private.confirm_election_setup(uuid) from public, anon;
grant execute on function mandate_private.confirm_election_setup(uuid) to authenticated;

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
  v_country char(2);
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
    select country_code into v_country from public.organizations where id = v_e.organization_id;
    if v_country is distinct from 'KE' then
      raise exception 'JURISDICTION_NOT_RELEASED' using errcode = '55000';
    end if;
    if not mandate_private.has_current_public_paid_voting_release() then
      raise exception 'PAID_VOTING_FEATURE_GATED' using errcode = '55000';
    end if;
    if v_e.paid_voting_authorized_at is null
      or v_e.paid_voting_authorized_by is null
      or v_e.paid_voting_authorized_by is distinct from v_e.setup_confirmed_by
      or v_e.currency <> 'KES'
      or v_e.price_per_credit_minor is null
      or v_e.price_per_credit_minor <= 0
      or v_e.max_credits_per_participant is null
      or v_e.max_credits_per_participant < 1
      or not v_e.contact_verification_required
      or v_e.public_slug is null then
      raise exception 'PUBLIC_PAID_ELECTION_OWNER_CONFIRMATION_REQUIRED' using errcode = '55000';
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
    'publicSlug',v_e.public_slug,
    'currency',v_e.currency,
    'pricePerCreditMinor',v_e.price_per_credit_minor,
    'maxCreditsPerParticipant',v_e.max_credits_per_participant,
    'contactVerificationRequired',v_e.contact_verification_required,
    'ownerConfirmedAt',v_e.paid_voting_authorized_at,
    'ownerConfirmedBy',v_e.paid_voting_authorized_by
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
revoke all on function mandate_private.open_election(uuid,boolean) from public, anon;
grant execute on function mandate_private.open_election(uuid,boolean) to authenticated;

-- Retain the database guard, but make it enforce owner confirmation and the
-- configured feature switch rather than platform-operator review.
create or replace function mandate_private.guard_public_paid_release()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if new.voting_mode = 'public_paid' and (
      new.status <> 'draft'
      or new.setup_confirmed_at is not null
      or new.paid_voting_authorized_at is not null
      or new.paid_voting_authorized_by is not null
    ) then
      raise exception 'PUBLIC_PAID_ELECTION_MUST_START_AS_DRAFT' using errcode = '55000';
    end if;
    return new;
  end if;

  if new.voting_mode = 'public_paid' then
    if new.setup_confirmed_at is distinct from old.setup_confirmed_at
      or new.paid_voting_authorized_at is distinct from old.paid_voting_authorized_at
      or new.paid_voting_authorized_by is distinct from old.paid_voting_authorized_by then
      if new.setup_confirmed_at is null then
        if new.setup_confirmed_by is not null
          or new.setup_confirmation_hash is not null
          or new.paid_voting_authorized_at is not null
          or new.paid_voting_authorized_by is not null then
          raise exception 'OWNER_CONFIRMATION_RESET_INVALID' using errcode = '55000';
        end if;
      else
        if auth.uid() is null
          or new.setup_confirmed_by is distinct from auth.uid()
          or new.paid_voting_authorized_by is distinct from auth.uid()
          or new.paid_voting_authorized_at is null
          or not mandate_private.has_org_role(
            new.organization_id,
            array['owner','admin','election_manager']::public.organization_role[]
          ) then
          raise exception 'ORGANIZATION_ELECTION_AUTHORITY_REQUIRED' using errcode = '42501';
        end if;
      end if;
    end if;

    if new.setup_confirmed_at is not null and (
      new.paid_voting_authorized_at is null
      or new.paid_voting_authorized_by is distinct from new.setup_confirmed_by
    ) then
      raise exception 'PUBLIC_PAID_ELECTION_OWNER_CONFIRMATION_REQUIRED' using errcode = '55000';
    end if;

    if new.setup_confirmed_at is not null or new.status = 'open' then
      if not mandate_private.has_current_public_paid_voting_release() then
        raise exception 'PAID_VOTING_FEATURE_GATED' using errcode = '55000';
      end if;
      if not exists (
        select 1 from public.organizations o
        where o.id = new.organization_id and o.country_code = 'KE'
      ) then
        raise exception 'JURISDICTION_NOT_RELEASED' using errcode = '55000';
      end if;
      if new.currency <> 'KES'
        or new.price_per_credit_minor is null
        or new.price_per_credit_minor <= 0
        or new.max_credits_per_participant is null
        or new.max_credits_per_participant < 1
        or not new.contact_verification_required
        or new.public_slug is null
        or new.starts_at is null
        or new.ends_at is null
        or new.ends_at <= new.starts_at then
        raise exception 'PUBLIC_PAID_ELECTION_CONFIGURATION_INVALID' using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function mandate_private.guard_public_paid_release() from public, anon, authenticated;

create or replace function mandate_private.guard_public_paid_payment_intent_release()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_e public.elections%rowtype;
begin
  if new.purpose <> 'public_vote_credits' then return new; end if;
  select * into v_e from public.elections where id = new.election_id;
  if not found or v_e.voting_mode <> 'public_paid' then
    raise exception 'PUBLIC_PAID_ELECTION_NOT_READY' using errcode = '55000';
  end if;
  if not mandate_private.has_current_public_paid_voting_release()
    or v_e.status <> 'open'
    or v_e.paid_voting_authorized_at is null
    or v_e.paid_voting_authorized_by is distinct from v_e.setup_confirmed_by
    or v_e.currency <> 'KES'
    or v_e.price_per_credit_minor is null
    or v_e.price_per_credit_minor <= 0
    or not v_e.contact_verification_required
    or pg_catalog.now() < v_e.starts_at
    or pg_catalog.now() >= v_e.ends_at then
    raise exception 'PUBLIC_PAID_ELECTION_NOT_READY' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function mandate_private.guard_public_paid_payment_intent_release() from public, anon, authenticated;

create or replace function mandate_private.guard_public_paid_ballot_release()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_e public.elections%rowtype;
begin
  select * into v_e from public.elections where id = new.election_id;
  if found and v_e.voting_mode = 'public_paid' then
    -- The feature switch blocks new credit purchases, not ballot submissions
    -- by participants who already hold verified credits.
    if v_e.status <> 'open'
      or v_e.paid_voting_authorized_at is null
      or v_e.paid_voting_authorized_by is distinct from v_e.setup_confirmed_by
      or pg_catalog.now() < v_e.starts_at
      or pg_catalog.now() >= v_e.ends_at then
      raise exception 'PUBLIC_PAID_ELECTION_NOT_READY' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function mandate_private.guard_public_paid_ballot_release() from public, anon, authenticated;

comment on column public.elections.paid_voting_authorized_at is
  'Legacy compatibility field: records the organization-authorized owner setup confirmation for public paid voting; no platform operator approval is required.';
comment on column public.elections.paid_voting_authorized_by is
  'Legacy compatibility field: organization owner/admin/election_manager who confirmed the public paid election setup.';
comment on function mandate_private.has_current_public_paid_voting_approvals() is
  'Legacy compatibility helper. Platform operator approvals are no longer a prerequisite; the public vote-credit feature flag remains enforced.';
