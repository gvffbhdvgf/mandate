-- Atomic reservation and fulfillment for public vote-credit purchases.
-- Amounts come only from the immutable election price and server-calculated quantity.
-- Reservations remain held through ambiguous/exception states until reconciled.

create table public.vote_credit_reservations (
  id uuid primary key default gen_random_uuid(),
  payment_intent_id uuid not null unique references public.payment_intents(id) on delete restrict,
  election_id uuid not null,
  participant_id uuid not null,
  credits_reserved integer not null check (credits_reserved > 0),
  status text not null default 'reserved'
    check (status in ('reserved','fulfilled','released','exception')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (participant_id,election_id)
    references public.public_participants(id,election_id) on delete restrict
);

create index vote_credit_reservations_cap_idx
  on public.vote_credit_reservations(election_id,participant_id,status);

create trigger vote_credit_reservations_set_updated_at
before update on public.vote_credit_reservations
for each row execute function mandate_private.set_updated_at();

alter table public.vote_credit_reservations enable row level security;
revoke all on public.vote_credit_reservations from public, anon, authenticated;

alter table public.vote_credit_lots
  add column entitlement_status text not null default 'active'
  check (entitlement_status in ('active','suspended','revoked'));

comment on table public.vote_credit_reservations
  is 'Server-managed quantity reservations. Unknown and exception payments continue to count against the participant cap until reconciled.';
comment on column public.vote_credit_lots.entitlement_status
  is 'Active credits may be consumed. Refund, reversal or dispute exceptions suspend remaining credits pending reconciliation.';

create or replace function mandate_private.create_public_vote_credit_payment_intent(
  p_auth_user_id uuid,
  p_election_slug text,
  p_quantity integer,
  p_idempotency_key text,
  p_provider_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_election public.elections%rowtype;
  v_participant public.public_participants%rowtype;
  v_existing public.payment_intents%rowtype;
  v_intent public.payment_intents%rowtype;
  v_issued bigint;
  v_reserved bigint;
  v_amount numeric;
begin
  if p_auth_user_id is null
    or p_election_slug is null
    or p_election_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or char_length(p_election_slug) > 80
    or p_quantity is null
    or p_quantity < 1
    or p_idempotency_key is null
    or char_length(p_idempotency_key) not between 16 and 200
    or p_provider_reference is null
    or p_provider_reference !~ '^mandate_[0-9a-f]{32}$' then
    raise exception 'INVALID_PUBLIC_VOTE_CREDIT_INTENT' using errcode = '22023';
  end if;

  select * into v_existing
  from public.payment_intents
  where idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing.purpose <> 'public_vote_credits'
      or v_existing.provider <> 'paystack'
      or v_existing.expected_credits <> p_quantity
      or not exists (
        select 1 from public.elections
        where id = v_existing.election_id
          and public_slug = p_election_slug
      ) then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;

    if not exists (
      select 1 from public.public_participants p
      where p.id = v_existing.participant_id
        and p.election_id = v_existing.election_id
        and p.auth_user_id = p_auth_user_id
        and p.verification_status = 'verified'
    ) then
      raise exception 'FORBIDDEN' using errcode = '42501';
    end if;

    return jsonb_build_object(
      'paymentIntentId', v_existing.id,
      'reference', v_existing.provider_reference,
      'amountMinor', v_existing.amount_minor,
      'credits', v_existing.expected_credits,
      'duplicate', true
    );
  end if;

  select * into v_election
  from public.elections
  where public_slug = p_election_slug
  for update;

  if not found then raise exception 'PUBLIC_ELECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_election.voting_mode <> 'public_paid'
    or v_election.status <> 'open'
    or not v_election.contact_verification_required
    or v_election.paid_voting_authorized_at is null
    or v_election.paid_voting_authorized_by is null
    or v_election.currency <> 'KES'
    or v_election.price_per_credit_minor is null
    or v_election.price_per_credit_minor <= 0
    or v_election.max_credits_per_participant is null
    or v_election.max_credits_per_participant < 1
    or pg_catalog.now() < v_election.starts_at
    or pg_catalog.now() >= v_election.ends_at then
    raise exception 'PUBLIC_PAID_ELECTION_NOT_READY' using errcode = '55000';
  end if;

  select * into v_participant
  from public.public_participants
  where election_id = v_election.id
    and auth_user_id = p_auth_user_id
  for update;

  if not found or v_participant.verification_status <> 'verified' then
    raise exception 'VERIFIED_PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;

  if p_quantity > v_election.max_credits_per_participant then
    raise exception 'PARTICIPANT_CREDIT_CAP_EXCEEDED' using errcode = '23514';
  end if;

  select coalesce(sum(credits_issued),0)::bigint into v_issued
  from public.vote_credit_lots
  where election_id = v_election.id
    and participant_id = v_participant.id;

  select coalesce(sum(credits_reserved),0)::bigint into v_reserved
  from public.vote_credit_reservations
  where election_id = v_election.id
    and participant_id = v_participant.id
    and status in ('reserved','exception');

  if v_issued + v_reserved + p_quantity > v_election.max_credits_per_participant then
    raise exception 'PARTICIPANT_CREDIT_CAP_EXCEEDED' using errcode = '23514';
  end if;

  v_amount := v_election.price_per_credit_minor::numeric * p_quantity::numeric;
  if v_amount <= 0 or v_amount > 9223372036854775807 then
    raise exception 'PAYMENT_AMOUNT_OUT_OF_RANGE' using errcode = '22003';
  end if;

  insert into public.payment_intents(
    organization_id,election_id,participant_id,purpose,provider,
    provider_reference,amount_minor,currency,expected_credits,status,idempotency_key
  ) values (
    null,v_election.id,v_participant.id,'public_vote_credits','paystack',
    p_provider_reference,v_amount::bigint,'KES',p_quantity,'initialized',p_idempotency_key
  ) returning * into v_intent;

  insert into public.vote_credit_reservations(
    payment_intent_id,election_id,participant_id,credits_reserved,status
  ) values (
    v_intent.id,v_election.id,v_participant.id,p_quantity,'reserved'
  );

  insert into public.audit_events(
    organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata
  ) values (
    v_election.organization_id,v_election.id,p_auth_user_id,'user',
    'payment.public_vote_credits.intent_created','payment_intent',v_intent.id,
    jsonb_build_object('credits',p_quantity,'amountMinor',v_amount::bigint,'currency','KES')
  );

  return jsonb_build_object(
    'paymentIntentId',v_intent.id,
    'reference',v_intent.provider_reference,
    'amountMinor',v_intent.amount_minor,
    'credits',v_intent.expected_credits,
    'duplicate',false
  );
end;
$$;

revoke all on function mandate_private.create_public_vote_credit_payment_intent(uuid,text,integer,text,text)
  from public, anon, authenticated;
grant execute on function mandate_private.create_public_vote_credit_payment_intent(uuid,text,integer,text,text)
  to service_role;

create or replace function public.create_public_vote_credit_payment_intent(
  p_auth_user_id uuid,
  p_election_slug text,
  p_quantity integer,
  p_idempotency_key text,
  p_provider_reference text
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $$
  select mandate_private.create_public_vote_credit_payment_intent($1,$2,$3,$4,$5);
$$;

revoke all on function public.create_public_vote_credit_payment_intent(uuid,text,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.create_public_vote_credit_payment_intent(uuid,text,integer,text,text)
  to service_role;

create or replace function mandate_private.handle_public_vote_credit_payment_state()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_reservation public.vote_credit_reservations%rowtype;
  v_lot public.vote_credit_lots%rowtype;
begin
  if new.purpose <> 'public_vote_credits' then return new; end if;

  select * into v_reservation
  from public.vote_credit_reservations
  where payment_intent_id = new.id
  for update;

  if not found then
    if new.status = 'success' then
      raise exception 'PUBLIC_VOTE_CREDIT_RESERVATION_MISSING' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.status = 'success' then
    if new.provider_status <> 'success'
      or new.provider_transaction_id is null
      or new.provider_amount_minor is distinct from new.amount_minor
      or new.provider_currency is distinct from new.currency
      or new.verified_at is null
      or v_reservation.credits_reserved is distinct from new.expected_credits
      or v_reservation.participant_id is distinct from new.participant_id
      or v_reservation.election_id is distinct from new.election_id
      or v_reservation.status not in ('reserved','fulfilled') then
      raise exception 'PUBLIC_VOTE_CREDIT_FULFILLMENT_MISMATCH' using errcode = '23514';
    end if;

    if v_reservation.status = 'fulfilled' then
      return new;
    end if;

    insert into public.vote_credit_lots(
      election_id,participant_id,payment_id,credits_issued,credits_remaining,entitlement_status
    ) values (
      new.election_id,new.participant_id,new.id,new.expected_credits,new.expected_credits,'active'
    )
    on conflict (payment_id) do nothing;

    select * into v_lot
    from public.vote_credit_lots
    where payment_id = new.id
    for update;

    if not found
      or v_lot.election_id is distinct from new.election_id
      or v_lot.participant_id is distinct from new.participant_id
      or v_lot.credits_issued is distinct from new.expected_credits then
      raise exception 'PUBLIC_VOTE_CREDIT_LOT_CONFLICT' using errcode = '23514';
    end if;

    update public.vote_credit_reservations
    set status = 'fulfilled'
    where id = v_reservation.id
      and status = 'reserved';

    insert into public.audit_events(
      organization_id,election_id,actor_type,action,entity_type,entity_id,redacted_metadata
    ) values (
      null,new.election_id,'system','payment.public_vote_credits.issued',
      'payment_intent',new.id,
      jsonb_build_object('creditsIssued',new.expected_credits,'amountMinor',new.amount_minor,'currency',new.currency)
    );

  elsif new.status in ('failed','abandoned')
    and new.provider_status in ('failed','abandoned')
    and new.verified_at is not null then
    update public.vote_credit_reservations
    set status = 'released'
    where id = v_reservation.id
      and status = 'reserved';

  elsif new.status in ('exception','refunded','reversed') then
    update public.vote_credit_reservations
    set status = 'exception'
    where id = v_reservation.id
      and status in ('reserved','fulfilled');

    update public.vote_credit_lots
    set entitlement_status = 'suspended'
    where payment_id = new.id
      and entitlement_status = 'active';
  end if;

  return new;
end;
$$;

revoke all on function mandate_private.handle_public_vote_credit_payment_state()
  from public, anon, authenticated;

drop trigger if exists payment_intents_public_vote_credit_state on public.payment_intents;

create trigger payment_intents_public_vote_credit_state
after update of status, provider_status, provider_transaction_id, provider_amount_minor, provider_currency, verified_at
on public.payment_intents
for each row
when (new.purpose = 'public_vote_credits')
execute function mandate_private.handle_public_vote_credit_payment_state();

comment on function mandate_private.create_public_vote_credit_payment_intent(uuid,text,integer,text,text)
  is 'Creates a participant-scoped Paystack intent and reserves quantity atomically under election/participant locks. Amount is derived only from the stored election price.';
comment on function mandate_private.handle_public_vote_credit_payment_state()
  is 'Issues one credit lot only after exact verified success, releases verified failed/abandoned reservations, and suspends credits on refund/reversal/exception.';
