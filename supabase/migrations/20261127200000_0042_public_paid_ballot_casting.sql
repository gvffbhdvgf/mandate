-- Participant-scoped paid ballot context and casting.
-- Ballot rows remain anonymous; the restricted submission-control and credit-consumption
-- tables retain only the minimum mapping needed to prevent replay and account for credits.

alter table public.ballot_submission_controls
  add column submission_key_hash text
  check (submission_key_hash is null or submission_key_hash ~ '^[0-9a-f]{64}$');

create unique index ballot_submission_controls_participant_key
  on public.ballot_submission_controls(participant_id,submission_key_hash)
  where participant_id is not null and submission_key_hash is not null;

create or replace function mandate_private.get_public_paid_ballot_context(p_election_slug text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_election public.elections%rowtype;
  v_participant public.public_participants%rowtype;
  v_contests jsonb;
  v_credits bigint;
begin
  if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  if p_election_slug is null or p_election_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or char_length(p_election_slug) > 80 then
    raise exception 'INVALID_PUBLIC_ELECTION' using errcode = '22023';
  end if;

  select * into v_election
  from public.elections
  where public_slug = p_election_slug
  for share;

  if not found or v_election.voting_mode <> 'public_paid' then
    raise exception 'PUBLIC_ELECTION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_election.status <> 'open'
    or pg_catalog.now() < v_election.starts_at
    or pg_catalog.now() >= v_election.ends_at then
    raise exception 'ELECTION_NOT_OPEN' using errcode = '55000';
  end if;

  select * into v_participant
  from public.public_participants
  where election_id = v_election.id
    and auth_user_id = v_user
  for share;

  if not found or v_participant.verification_status <> 'verified' then
    raise exception 'VERIFIED_PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;

  select coalesce(sum(credits_remaining),0)::bigint into v_credits
  from public.vote_credit_lots
  where election_id = v_election.id
    and participant_id = v_participant.id
    and entitlement_status = 'active';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',(item.contest->>'contestId')::uuid,
    'title',item.contest->>'title',
    'required',coalesce((item.contest->>'required')::boolean,true),
    'options',coalesce(item.contest->'options','[]'::jsonb),
    'ballotsCast',(
      select count(*) from public.ballot_submission_controls control
      where control.election_id = v_election.id
        and control.contest_id = (item.contest->>'contestId')::uuid
        and control.participant_id = v_participant.id
    )
  ) order by item.ordinality),'[]'::jsonb) into v_contests
  from jsonb_array_elements(coalesce(v_election.candidate_snapshot,'[]'::jsonb))
    with ordinality as item(contest,ordinality);

  return jsonb_build_object(
    'election',jsonb_build_object(
      'title',v_election.title,
      'slug',v_election.public_slug,
      'endsAt',v_election.ends_at,
      'timezone',v_election.timezone
    ),
    'creditsRemaining',v_credits,
    'contests',v_contests
  );
end;
$$;

revoke all on function mandate_private.get_public_paid_ballot_context(text)
  from public, anon, authenticated;

create or replace function public.get_public_paid_ballot_context(p_election_slug text)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $$
  select mandate_private.get_public_paid_ballot_context($1);
$$;

revoke all on function public.get_public_paid_ballot_context(text) from public, anon;
grant execute on function public.get_public_paid_ballot_context(text) to authenticated;

create or replace function mandate_private.cast_public_paid_ballot(
  p_election_slug text,
  p_contest_id uuid,
  p_option_id uuid,
  p_credits integer,
  p_confirmation boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_election public.elections%rowtype;
  v_participant public.public_participants%rowtype;
  v_contest public.contests%rowtype;
  v_option public.options%rowtype;
  v_lot public.vote_credit_lots%rowtype;
  v_ballot uuid;
  v_receipt text;
  v_remaining integer;
  v_take integer;
  v_available bigint;
  v_key_hash text;
  v_existing_ballot public.ballots%rowtype;
begin
  if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  if p_confirmation is distinct from true then raise exception 'BALLOT_CONFIRMATION_REQUIRED' using errcode = '22023'; end if;
  if p_election_slug is null or p_election_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or char_length(p_election_slug) > 80
    or p_contest_id is null
    or p_option_id is null
    or p_credits is null
    or p_credits < 1
    or p_idempotency_key is null
    or char_length(p_idempotency_key) not between 16 and 200 then
    raise exception 'INVALID_PUBLIC_BALLOT_REQUEST' using errcode = '22023';
  end if;

  select * into v_election
  from public.elections
  where public_slug = p_election_slug
  for update;

  if not found or v_election.voting_mode <> 'public_paid' then
    raise exception 'PUBLIC_ELECTION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_election.status <> 'open'
    or pg_catalog.now() < v_election.starts_at
    or pg_catalog.now() >= v_election.ends_at then
    raise exception 'ELECTION_NOT_OPEN' using errcode = '55000';
  end if;
  if v_election.paid_voting_authorized_at is null
    or v_election.paid_voting_authorized_by is null
    or not v_election.contact_verification_required then
    raise exception 'PUBLIC_PAID_ELECTION_NOT_READY' using errcode = '55000';
  end if;

  select * into v_participant
  from public.public_participants
  where election_id = v_election.id
    and auth_user_id = v_user
  for update;

  if not found or v_participant.verification_status <> 'verified' then
    raise exception 'VERIFIED_PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;

  v_key_hash := encode(extensions.digest(convert_to(p_idempotency_key,'UTF8'),'sha256'),'hex');
  select b.* into v_existing_ballot
  from public.ballot_submission_controls control
  join public.ballots b on b.id = control.ballot_id
  where control.participant_id = v_participant.id
    and control.submission_key_hash = v_key_hash
  for update of control,b;

  if found then
    if v_existing_ballot.election_id is distinct from v_election.id
      or v_existing_ballot.contest_id is distinct from p_contest_id
      or v_existing_ballot.option_id is distinct from p_option_id
      or v_existing_ballot.vote_units is distinct from p_credits
      or v_existing_ballot.status <> 'accepted' then
      raise exception 'BALLOT_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'status','accepted',
      'receiptCode',v_existing_ballot.receipt_code,
      'creditsUsed',p_credits,
      'castAt',v_existing_ballot.cast_at,
      'duplicate',true
    );
  end if;

  select * into v_contest
  from public.contests
  where id = p_contest_id
    and election_id = v_election.id;

  if not found then raise exception 'CONTEST_NOT_FOUND' using errcode = 'P0002'; end if;

  if not exists (
    select 1 from jsonb_array_elements(coalesce(v_election.candidate_snapshot,'[]'::jsonb)) c
    where (c->>'contestId')::uuid = v_contest.id
  ) then
    raise exception 'CONTEST_NOT_IN_FROZEN_SNAPSHOT' using errcode = '55000';
  end if;

  select * into v_option
  from public.options
  where id = p_option_id
    and contest_id = v_contest.id
    and status = 'active';

  if not found then raise exception 'OPTION_NOT_AVAILABLE' using errcode = 'P0002'; end if;

  if not exists (
    select 1
    from jsonb_array_elements(coalesce(v_election.candidate_snapshot,'[]'::jsonb)) c
    cross join lateral jsonb_array_elements(coalesce(c->'options','[]'::jsonb)) o
    where (c->>'contestId')::uuid = v_contest.id
      and (o->>'id')::uuid = v_option.id
  ) then
    raise exception 'OPTION_NOT_IN_FROZEN_SNAPSHOT' using errcode = '55000';
  end if;

  select coalesce(sum(credits_remaining),0)::bigint into v_available
  from public.vote_credit_lots
  where election_id = v_election.id
    and participant_id = v_participant.id
    and entitlement_status = 'active';

  if v_available < p_credits then
    raise exception 'INSUFFICIENT_VOTE_CREDITS' using errcode = '23514';
  end if;

  v_receipt := encode(extensions.gen_random_bytes(24),'hex');
  insert into public.ballots(
    organization_id,election_id,contest_id,option_id,receipt_code,vote_units
  ) values (
    v_election.organization_id,v_election.id,v_contest.id,v_option.id,v_receipt,p_credits
  ) returning id into v_ballot;

  insert into public.ballot_submission_controls(
    election_id,contest_id,participant_id,ballot_id,submission_key_hash
  ) values (
    v_election.id,v_contest.id,v_participant.id,v_ballot,v_key_hash
  );

  v_remaining := p_credits;
  for v_lot in
    select * from public.vote_credit_lots
    where election_id = v_election.id
      and participant_id = v_participant.id
      and entitlement_status = 'active'
      and credits_remaining > 0
    order by created_at,id
    for update
  loop
    exit when v_remaining = 0;
    v_take := least(v_remaining,v_lot.credits_remaining);

    update public.vote_credit_lots
    set credits_remaining = credits_remaining - v_take
    where id = v_lot.id
      and entitlement_status = 'active'
      and credits_remaining >= v_take;

    if not found then
      raise exception 'VOTE_CREDIT_CONSUMPTION_RACE' using errcode = '40001';
    end if;

    insert into public.vote_credit_consumptions(credit_lot_id,ballot_id,credits_consumed)
    values (v_lot.id,v_ballot,v_take);

    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining <> 0 then
    raise exception 'INSUFFICIENT_VOTE_CREDITS' using errcode = '23514';
  end if;

  insert into public.audit_events(
    organization_id,election_id,actor_type,action,entity_type,entity_id,redacted_metadata
  ) values (
    v_election.organization_id,v_election.id,'system','ballot.accepted',
    'ballot',v_ballot,jsonb_build_object('receiptCode',v_receipt,'voteUnits',p_credits)
  );

  return jsonb_build_object(
    'status','accepted',
    'receiptCode',v_receipt,
    'creditsUsed',p_credits,
    'castAt',pg_catalog.now(),
    'duplicate',false
  );
exception when unique_violation then
  raise exception 'BALLOT_ALREADY_CAST' using errcode = '23505';
end;
$$;

revoke all on function mandate_private.cast_public_paid_ballot(text,uuid,uuid,integer,boolean,text)
  from public, anon, authenticated;

create or replace function public.cast_public_paid_ballot(
  p_election_slug text,
  p_contest_id uuid,
  p_option_id uuid,
  p_credits integer,
  p_confirmation boolean,
  p_idempotency_key text
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $$
  select mandate_private.cast_public_paid_ballot($1,$2,$3,$4,$5,$6);
$$;

revoke all on function public.cast_public_paid_ballot(text,uuid,uuid,integer,boolean,text) from public, anon;
grant execute on function public.cast_public_paid_ballot(text,uuid,uuid,integer,boolean,text) to authenticated;

comment on function mandate_private.cast_public_paid_ballot(text,uuid,uuid,integer,boolean,text)
  is 'Atomically consumes verified active vote credits and inserts an anonymous ballot; participant identity is written only to the restricted submission-control mapping.';
