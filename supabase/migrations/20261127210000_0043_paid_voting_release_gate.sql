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
    'publicSlug',v_e.public_slug,
    'currency',v_e.currency,
    'pricePerCreditMinor',v_e.price_per_credit_minor,
    'maxCreditsPerParticipant',v_e.max_credits_per_participant,
    'contactVerificationRequired',v_e.contact_verification_required,
    'paidVotingAuthorizedAt',v_e.paid_voting_authorized_at,
    'paidVotingAuthorizedBy',v_e.paid_voting_authorized_by
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
    'publicSlug',v_e.public_slug,
    'currency',v_e.currency,
    'pricePerCreditMinor',v_e.price_per_credit_minor,
    'maxCreditsPerParticipant',v_e.max_credits_per_participant,
    'contactVerificationRequired',v_e.contact_verification_required,
    'paidVotingAuthorizedAt',v_e.paid_voting_authorized_at,
    'paidVotingAuthorizedBy',v_e.paid_voting_authorized_by
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


-- Public-paid election setup uses the existing setup draft flow, but accepts only
-- owner-configured KES pricing/caps and requires platform authorization before
-- setup confirmation/opening. Registered election setup remains unchanged.
create or replace function mandate_private.create_election_setup(
  p_organization_id uuid,
  p_election jsonb,
  p_contests jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user uuid := auth.uid();
  v_mode public.voting_mode;
  v_election_id uuid;
  v_contest_id uuid;
  v_contest jsonb;
  v_option jsonb;
  v_contest_order integer := 0;
  v_option_order integer;
  v_title text;
  v_description text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_timezone text;
  v_result_visibility text;
  v_public_slug text;
  v_price bigint;
  v_cap integer;
begin
  if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  if jsonb_typeof(p_election) is distinct from 'object' then
    raise exception 'INVALID_ELECTION_PAYLOAD' using errcode = '22023';
  end if;
  if jsonb_typeof(p_contests) is distinct from 'array'
    or jsonb_array_length(p_contests) < 1
    or jsonb_array_length(p_contests) > 10 then
    raise exception 'INVALID_CONTESTS_PAYLOAD' using errcode = '22023';
  end if;

  v_mode := coalesce(nullif(p_election->>'voting_mode',''),'registered_single')::public.voting_mode;
  v_title := btrim(coalesce(p_election->>'title',''));
  v_description := nullif(btrim(coalesce(p_election->>'description','')),'');
  v_starts_at := (p_election->>'starts_at')::timestamptz;
  v_ends_at := (p_election->>'ends_at')::timestamptz;
  v_timezone := coalesce(nullif(p_election->>'timezone',''),'Africa/Nairobi');
  v_result_visibility := coalesce(nullif(p_election->>'result_visibility',''),'private');

  if v_mode <> 'public_paid' then
    v_election_id := mandate_private.create_election(
      p_organization_id,v_title,v_description,v_mode,
      v_starts_at,v_ends_at,v_timezone,v_result_visibility
    );
  else
    -- Draft configuration may be prepared while the platform release switch is off.
    -- Setup confirmation and opening remain blocked until platform approval.
    if not mandate_private.has_org_role(
      p_organization_id,
      array['owner','admin','election_manager']::public.organization_role[]
    ) then
      raise exception 'FORBIDDEN' using errcode = '42501';
    end if;
    if not exists(select 1 from public.organizations o where o.id=p_organization_id and o.status='active') then
      raise exception 'ORGANIZATION_NOT_ACTIVE' using errcode = '55000';
    end if;
    if char_length(v_title) not between 2 and 160 then
      raise exception 'INVALID_ELECTION_TITLE' using errcode = '22023';
    end if;
    if v_description is not null and char_length(v_description)>5000 then
      raise exception 'ELECTION_DESCRIPTION_TOO_LONG' using errcode = '22023';
    end if;
    if v_starts_at is null or v_ends_at is null or v_starts_at>=v_ends_at or v_ends_at<=now() then
      raise exception 'INVALID_ELECTION_WINDOW' using errcode = '22023';
    end if;
    if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
      raise exception 'INVALID_TIMEZONE' using errcode = '22023';
    end if;
    if v_result_visibility not in ('private','members','public') then
      raise exception 'INVALID_RESULT_VISIBILITY' using errcode = '22023';
    end if;

    v_public_slug := lower(btrim(coalesce(p_election->>'public_slug','')));
    v_price := (p_election->>'price_per_credit_minor')::bigint;
    v_cap := (p_election->>'max_credits_per_participant')::integer;

    if v_public_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      or char_length(v_public_slug)>80
      or coalesce(p_election->>'currency','') <> 'KES'
      or v_price is null or v_price <= 0
      or v_cap is null or v_cap < 1
      or coalesce((p_election->>'contact_verification_required')::boolean,true) is distinct from true then
      raise exception 'INVALID_PUBLIC_PAID_ELECTION_CONFIGURATION' using errcode = '22023';
    end if;

    insert into public.elections(
      organization_id,title,description,public_slug,voting_mode,status,
      starts_at,ends_at,timezone,result_visibility,currency,price_per_credit_minor,
      max_credits_per_participant,contact_verification_required,created_by
    ) values (
      p_organization_id,v_title,v_description,v_public_slug,'public_paid','draft',
      v_starts_at,v_ends_at,v_timezone,v_result_visibility,'KES',v_price,
      v_cap,true,v_user
    ) returning id into v_election_id;

    insert into public.audit_events(
      organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata
    ) values (
      p_organization_id,v_election_id,v_user,'user','election.created','election',v_election_id,
      jsonb_build_object('votingMode',v_mode,'startsAt',v_starts_at,'endsAt',v_ends_at,
        'currency','KES','pricePerCreditMinor',v_price,'maxCreditsPerParticipant',v_cap)
    );
  end if;

  for v_contest in select value from jsonb_array_elements(p_contests)
  loop
    if jsonb_typeof(v_contest) is distinct from 'object'
      or jsonb_typeof(v_contest->'options') is distinct from 'array'
      or jsonb_array_length(v_contest->'options') < 2
      or jsonb_array_length(v_contest->'options') > 50 then
      raise exception 'INVALID_CONTEST_OPTIONS' using errcode = '22023';
    end if;

    if exists (
      select 1 from jsonb_array_elements(v_contest->'options') as item(value)
      where jsonb_typeof(item.value) is distinct from 'object'
        or nullif(btrim(item.value->>'display_name'),'') is null
    ) then
      raise exception 'INVALID_OPTION_PAYLOAD' using errcode = '22023';
    end if;

    if (
      select count(*) <> count(distinct lower(btrim(item.value->>'display_name')))
      from jsonb_array_elements(v_contest->'options') as item(value)
    ) then
      raise exception 'DUPLICATE_OPTION_NAME' using errcode = '22023';
    end if;

    v_contest_id := mandate_private.create_contest(
      v_election_id,v_contest->>'title',v_contest->>'description',
      coalesce((v_contest->>'is_required')::boolean,true),v_contest_order,
      coalesce(nullif(v_contest->>'tie_policy',''),'declared_tie')::public.tie_policy
    );

    v_option_order := 0;
    for v_option in select value from jsonb_array_elements(v_contest->'options')
    loop
      perform mandate_private.create_option(
        v_election_id,v_contest_id,v_option->>'display_name',v_option->>'profile',v_option_order
      );
      v_option_order := v_option_order + 1;
    end loop;
    v_contest_order := v_contest_order + 1;
  end loop;

  return v_election_id;
end;
$$;

create or replace function mandate_private.guard_election_snapshot()
returns trigger
language plpgsql
set search_path = pg_catalog
as $
begin
  if old.status <> 'draft' and (
    new.rules_snapshot is distinct from old.rules_snapshot
    or new.candidate_snapshot is distinct from old.candidate_snapshot
    or new.rules_hash is distinct from old.rules_hash
    or new.voting_mode is distinct from old.voting_mode
    or new.starts_at is distinct from old.starts_at
    or new.ends_at is distinct from old.ends_at
    or new.public_slug is distinct from old.public_slug
    or new.currency is distinct from old.currency
    or new.price_per_credit_minor is distinct from old.price_per_credit_minor
    or new.max_credits_per_participant is distinct from old.max_credits_per_participant
    or new.contact_verification_required is distinct from old.contact_verification_required
    or new.paid_voting_authorized_at is distinct from old.paid_voting_authorized_at
    or new.paid_voting_authorized_by is distinct from old.paid_voting_authorized_by
  ) then
    raise exception 'ELECTION_RULES_FROZEN' using errcode='55000';
  end if;
  return new;
end;
$;

-- Public-paid tallies count verified participant records as the available participant
-- base and distinct participants who submitted ballots as turnout. Ballot choices remain
-- unlinked to participant identities; only the restricted control table carries that link.
create or replace function mandate_private.tally_and_reconcile(p_election_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user uuid := auth.uid();
  v_e public.elections%rowtype;
  v_existing public.election_tallies%rowtype;
  v_tally_id uuid;
  v_hash text;
  v_eligible bigint;
  v_participating bigint;
  v_controls bigint;
  v_ballots bigint;
  v_accepted bigint;
  v_invalidated bigint;
  v_vote_units bigint;
  v_requires boolean;
begin
  if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  select * into v_e from public.elections where id=p_election_id for update;
  if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
  if not mandate_private.has_org_role(
    v_e.organization_id,
    array['owner','admin','election_manager','returning_officer']::public.organization_role[]
  ) then raise exception 'FORBIDDEN' using errcode='42501'; end if;

  select * into v_existing from public.election_tallies where election_id=v_e.id for update;
  if found then
    return jsonb_build_object(
      'tallyId',v_existing.id,'status','reconciled',
      'eligibleVoters',v_existing.eligible_voter_count,
      'participatingVoters',v_existing.participating_voter_count,
      'acceptedBallots',v_existing.accepted_ballot_count,
      'invalidatedBallots',v_existing.invalidated_ballot_count,
      'requiresResolution',v_existing.requires_resolution
    );
  end if;

  if v_e.status<>'closed' then raise exception 'ELECTION_MUST_BE_CLOSED' using errcode='55000'; end if;
  if v_e.rules_snapshot is null or v_e.candidate_snapshot is null or v_e.rules_hash is null then
    raise exception 'ELECTION_SNAPSHOT_MISSING' using errcode='23514';
  end if;

  v_hash := encode(extensions.digest(
    convert_to(v_e.rules_snapshot::text||coalesce(v_e.candidate_snapshot::text,''),'UTF8'),
    'sha256'
  ),'hex');
  if v_hash<>v_e.rules_hash then raise exception 'ELECTION_SNAPSHOT_HASH_MISMATCH' using errcode='23514'; end if;

  if v_e.voting_mode='public_paid' then
    select count(*) into v_eligible
    from public.public_participants
    where election_id=v_e.id and verification_status in ('verified','blocked');

    select count(distinct participant_id) into v_participating
    from public.ballot_submission_controls
    where election_id=v_e.id and participant_id is not null;
  else
    select count(*) into v_eligible
    from public.election_voters
    where election_id=v_e.id and eligibility_status='eligible';

    select count(distinct voter_id) into v_participating
    from public.ballot_submission_controls
    where election_id=v_e.id and voter_id is not null;
  end if;

  select count(*) into v_controls from public.ballot_submission_controls where election_id=v_e.id;
  select count(*) into v_ballots from public.ballots where election_id=v_e.id;
  select count(*) into v_accepted from public.ballots where election_id=v_e.id and status='accepted';
  select count(*) into v_invalidated from public.ballots where election_id=v_e.id and status='invalidated';
  select coalesce(sum(vote_units),0) into v_vote_units from public.ballots where election_id=v_e.id and status='accepted';

  if v_controls<>v_ballots then raise exception 'BALLOT_CONTROL_RECONCILIATION_FAILED' using errcode='23514'; end if;

  if exists(
    select 1 from public.ballot_submission_controls c
    left join public.ballots b on b.id=c.ballot_id
    where c.election_id=v_e.id
      and (
        b.id is null or b.election_id<>c.election_id or b.contest_id<>c.contest_id
        or (v_e.voting_mode='public_paid' and (
          c.participant_id is null
          or c.voter_id is not null
          or not exists(
            select 1 from public.public_participants participant
            where participant.id=c.participant_id
              and participant.election_id=c.election_id
          )
          or (select coalesce(sum(consumption.credits_consumed),0)
              from public.vote_credit_consumptions consumption
              where consumption.ballot_id=b.id) <> b.vote_units
        ))
        or (v_e.voting_mode<>'public_paid' and (c.voter_id is null or c.participant_id is not null))
      )
  ) then
    raise exception 'BALLOT_CONTROL_MAPPING_INVALID' using errcode='23514';
  end if;

  if exists(
    select 1 from public.ballots b
    left join public.ballot_submission_controls c on c.ballot_id=b.id
    where b.election_id=v_e.id and c.id is null
  ) then
    raise exception 'ORPHAN_BALLOT_DETECTED' using errcode='23514';
  end if;

  if v_participating>v_eligible then raise exception 'TURNOUT_EXCEEDS_ELIGIBLE_REGISTER' using errcode='23514'; end if;

  insert into public.election_tallies(
    organization_id,election_id,snapshot_hash,eligible_voter_count,participating_voter_count,
    accepted_ballot_count,invalidated_ballot_count,total_vote_units,created_by
  ) values (
    v_e.organization_id,v_e.id,v_hash,v_eligible,v_participating,v_accepted,v_invalidated,v_vote_units,v_user
  ) returning id into v_tally_id;

  with raw as (
    select c.id contest_id,c.tie_policy,o.id option_id,
      count(b.id) filter(where b.status='accepted')::bigint ballot_count,
      coalesce(sum(b.vote_units) filter(where b.status='accepted'),0)::bigint vote_units
    from public.contests c
    join public.options o on o.contest_id=c.id and o.status='active'
    left join public.ballots b on b.election_id=v_e.id and b.contest_id=c.id and b.option_id=o.id
    where c.election_id=v_e.id
    group by c.id,c.tie_policy,o.id
  ), ranked as (
    select raw.*,
      dense_rank() over(partition by contest_id order by vote_units desc) result_rank,
      sum(vote_units) over(partition by contest_id) contest_vote_units,
      max(vote_units) over(partition by contest_id) top_vote_units
    from raw
  ), top_counts as (
    select contest_id,count(*) filter(where vote_units=top_vote_units) top_count
    from ranked group by contest_id
  )
  insert into public.election_tally_results(
    tally_id,organization_id,election_id,contest_id,option_id,ballot_count,vote_units,
    share_basis_points,result_rank,tie_policy,is_tied,is_winner,requires_resolution
  )
  select v_tally_id,v_e.organization_id,v_e.id,r.contest_id,r.option_id,r.ballot_count,r.vote_units,
    case when r.contest_vote_units=0 then 0 else round(r.vote_units*10000.0/r.contest_vote_units)::integer end,
    r.result_rank,r.tie_policy,
    (r.result_rank=1 and tc.top_count>1 and r.contest_vote_units>0),
    (r.result_rank=1 and r.contest_vote_units>0 and (tc.top_count=1 or r.tie_policy='declared_tie')),
    (r.result_rank=1 and tc.top_count>1 and r.contest_vote_units>0 and r.tie_policy<>'declared_tie')
  from ranked r join top_counts tc on tc.contest_id=r.contest_id;

  select exists(
    select 1 from public.election_tally_results
    where tally_id=v_tally_id and requires_resolution
  ) into v_requires;

  update public.election_tallies set requires_resolution=v_requires where id=v_tally_id;
  update public.elections set status='tallying' where id=v_e.id;

  insert into public.audit_events(
    organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata
  ) values (
    v_e.organization_id,v_e.id,v_user,'user','election.tallied','election_tally',v_tally_id,
    jsonb_build_object(
      'eligibleParticipantsOrVoters',v_eligible,
      'participatingParticipantsOrVoters',v_participating,
      'acceptedBallots',v_accepted,
      'invalidatedBallots',v_invalidated,
      'requiresResolution',v_requires,
      'snapshotHash',v_hash
    )
  );

  return jsonb_build_object(
    'tallyId',v_tally_id,'status','reconciled',
    'eligibleVoters',v_eligible,'participatingVoters',v_participating,
    'acceptedBallots',v_accepted,'invalidatedBallots',v_invalidated,
    'requiresResolution',v_requires,
    'participantBasis',case when v_e.voting_mode='public_paid' then 'verified_participants' else 'eligible_voter_register' end
  );
end;
$$;

-- Even if an Edge Function is misconfigured, a server-only database flag prevents
-- creating new public-credit payment intents and inserting paid ballots while disabled.
create or replace function mandate_private.guard_public_vote_credit_feature_flag()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_mode public.voting_mode;
begin
  if tg_table_name = 'payment_intents' then
    if new.purpose <> 'public_vote_credits' then return new; end if;
  elsif tg_table_name = 'ballots' then
    select voting_mode into v_mode
    from public.elections
    where id = new.election_id;
    if v_mode is distinct from 'public_paid' then return new; end if;
  else
    return new;
  end if;

  if not exists (
    select 1 from public.platform_payment_feature_flags
    where singleton and public_vote_credits_enabled
  ) then
    raise exception 'PAID_VOTING_FEATURE_GATED' using errcode='55000';
  end if;
  return new;
end;
$$;

revoke all on function mandate_private.guard_public_vote_credit_feature_flag()
  from public, anon, authenticated;

drop trigger if exists payment_intents_public_vote_credit_feature_guard on public.payment_intents;
create trigger payment_intents_public_vote_credit_feature_guard
before insert on public.payment_intents
for each row
when (new.purpose='public_vote_credits')
execute function mandate_private.guard_public_vote_credit_feature_flag();

drop trigger if exists ballots_public_paid_feature_guard on public.ballots;
create trigger ballots_public_paid_feature_guard
before insert on public.ballots
for each row
execute function mandate_private.guard_public_vote_credit_feature_flag();

comment on function mandate_private.tally_and_reconcile(uuid)
  is 'Reconciles registered elections by eligible voter register and public-paid elections by verified participant base while preserving anonymous ballot rows.';
