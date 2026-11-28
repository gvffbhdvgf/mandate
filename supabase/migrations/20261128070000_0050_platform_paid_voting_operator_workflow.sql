-- Audited platform-operator workflow for public paid-voting release.
-- This adds the missing approval workflow without granting blanket approval.
create table mandate_private.platform_operators (
  user_id uuid primary key references auth.users(id) on delete restrict,
  is_active boolean not null default true,
  granted_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check ((is_active and revoked_at is null) or (not is_active and revoked_at is not null))
);

-- A private random capability prevents callers from forging the trigger bypass
-- by setting an arbitrary custom GUC themselves.
create table mandate_private.platform_authorization_guard (
  singleton boolean primary key default true check (singleton),
  guard_token text not null
);
insert into mandate_private.platform_authorization_guard(singleton,guard_token)
values (true,gen_random_uuid()::text || gen_random_uuid()::text);

create table mandate_private.platform_operator_bootstrap_allowlist (
  user_id uuid primary key references auth.users(id) on delete restrict,
  consumed_at timestamptz,
  consumed_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check ((consumed_at is null and consumed_by is null) or (consumed_at is not null and consumed_by is not null))
);

create table mandate_private.platform_paid_voting_release_requirements (
  requirement_key text primary key,
  title text not null,
  description text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  evidence text,
  evidence_reference text,
  reviewed_by uuid references auth.users(id) on delete restrict,
  reviewed_at timestamptz,
  valid_until timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null)
    or (status in ('approved','rejected') and reviewed_by is not null and reviewed_at is not null)
  ),
  check (status <> 'approved' or (length(btrim(coalesce(evidence,''))) >= 40 and length(btrim(coalesce(evidence_reference,''))) >= 8))
);

create table mandate_private.platform_paid_voting_release_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  event_type text not null check (event_type in ('operator_bootstrapped','requirement_reviewed','election_authorized')),
  requirement_key text references mandate_private.platform_paid_voting_release_requirements(requirement_key),
  election_id uuid references public.elections(id) on delete restrict,
  before_state jsonb,
  after_state jsonb not null,
  created_at timestamptz not null default now()
);

create or replace function mandate_private.prevent_platform_release_audit_mutation()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
begin
  raise exception 'PLATFORM_RELEASE_AUDIT_APPEND_ONLY' using errcode='55000';
end;
$$;
revoke all on function mandate_private.prevent_platform_release_audit_mutation() from public,anon,authenticated;
create trigger platform_paid_voting_release_audit_immutable
before update or delete on mandate_private.platform_paid_voting_release_audit
for each row execute function mandate_private.prevent_platform_release_audit_mutation();

alter table mandate_private.platform_operators enable row level security;
alter table mandate_private.platform_authorization_guard enable row level security;
alter table mandate_private.platform_operator_bootstrap_allowlist enable row level security;
alter table mandate_private.platform_paid_voting_release_requirements enable row level security;
alter table mandate_private.platform_paid_voting_release_audit enable row level security;
revoke all on mandate_private.platform_operators,
  mandate_private.platform_authorization_guard,
  mandate_private.platform_operator_bootstrap_allowlist,
  mandate_private.platform_paid_voting_release_requirements,
  mandate_private.platform_paid_voting_release_audit
from public, anon, authenticated;
grant select, insert, update, delete on mandate_private.platform_operators,
  mandate_private.platform_operator_bootstrap_allowlist,
  mandate_private.platform_paid_voting_release_requirements,
  mandate_private.platform_paid_voting_release_audit to service_role;

insert into mandate_private.platform_paid_voting_release_requirements(requirement_key,title,description)
values
 ('merchant_identity','Merchant identity and account standing','Verify Poptra is the designated Mandate merchant, account identity and current account standing using current dashboard or provider evidence.'),
 ('provider_use_case','Paystack permission for paid voting credits','Obtain written Paystack confirmation that Mandate may sell KES voting credits for the supported customer segments and election use cases. General pre-approval is not sufficient.'),
 ('legal_scope','Legal and jurisdiction scope','Record a documented legal assessment for the supported private organizational election use case and its jurisdiction. Statutory/public elections and unreviewed political or non-profit use cases remain excluded.'),
 ('pricing_terms','Pricing, participant terms and refunds','Approve the actual per-credit pricing, participant limits, disclosures, participant terms, refund and dispute rules.'),
 ('accounting_controls','Accounting and reconciliation controls','Verify the single-merchant revenue model, clearing/suspense accounting, provider fee treatment, settlement reconciliation and exception handling. Organizer payouts are not part of the accepted model.'),
 ('live_payment_operations','Live payment operations and credentials','Verify rotated live credentials, live/test mode separation, callback/webhook registration, signed webhook processing and an end-to-end controlled payment test before live charges.'),
 ('security_privacy','Security, privacy and election safeguards','Complete the security/privacy review for participant identity separation, ballot secrecy, access control, audit logging and operational monitoring.')
on conflict (requirement_key) do nothing;

create or replace function mandate_private.is_platform_operator()
returns boolean
language sql stable security definer
set search_path = pg_catalog
as $$
  select auth.uid() is not null and exists (
    select 1 from mandate_private.platform_operators o
    where o.user_id = auth.uid() and o.is_active
  );
$$;
revoke all on function mandate_private.is_platform_operator() from public, anon, authenticated;
grant execute on function mandate_private.is_platform_operator() to authenticated, service_role;

create or replace function mandate_private.has_current_public_paid_voting_approvals()
returns boolean
language sql stable security definer
set search_path = pg_catalog
as $$
  select not exists (
    select 1 from mandate_private.platform_paid_voting_release_requirements r
    where r.status <> 'approved'
       or (r.valid_until is not null and r.valid_until <= now())
  )
  and exists (select 1 from mandate_private.platform_paid_voting_release_requirements);
$$;
revoke all on function mandate_private.has_current_public_paid_voting_approvals() from public, anon, authenticated;
grant execute on function mandate_private.has_current_public_paid_voting_approvals() to service_role;

create or replace function mandate_private.has_current_public_paid_voting_release()
returns boolean
language sql stable security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1 from public.platform_payment_feature_flags f
    where f.singleton and f.public_vote_credits_enabled
  )
  and mandate_private.has_current_public_paid_voting_approvals();
$$;
revoke all on function mandate_private.has_current_public_paid_voting_release() from public, anon, authenticated;
grant execute on function mandate_private.has_current_public_paid_voting_release() to service_role;

create or replace function mandate_private.bootstrap_platform_operator()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  if exists(select 1 from mandate_private.platform_operators) then
    raise exception 'PLATFORM_OPERATOR_ALREADY_BOOTSTRAPPED' using errcode='55000';
  end if;
  if not exists(select 1 from auth.users u where u.id=v_user and u.email_confirmed_at is not null) then
    raise exception 'CONFIRMED_ACCOUNT_REQUIRED' using errcode='42501';
  end if;
  perform 1 from mandate_private.platform_operator_bootstrap_allowlist a
  where a.user_id=v_user and a.consumed_at is null for update;
  if not found then raise exception 'PLATFORM_OPERATOR_BOOTSTRAP_NOT_ALLOWED' using errcode='42501'; end if;

  insert into mandate_private.platform_operators(user_id,granted_by)
  values (v_user,v_user);
  update mandate_private.platform_operator_bootstrap_allowlist
  set consumed_at=now(),consumed_by=v_user
  where user_id=v_user and consumed_at is null;
  insert into mandate_private.platform_paid_voting_release_audit(actor_id,event_type,after_state)
  values (v_user,'operator_bootstrapped',jsonb_build_object('userId',v_user));
  return jsonb_build_object('isOperator',true);
end;
$$;
revoke all on function mandate_private.bootstrap_platform_operator() from public, anon, authenticated;
grant execute on function mandate_private.bootstrap_platform_operator() to authenticated;

create or replace function mandate_private.get_platform_paid_voting_status()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_user uuid := auth.uid();
  v_operator boolean;
  v_can_bootstrap boolean;
begin
  if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  v_operator := mandate_private.is_platform_operator();
  select (not exists(select 1 from mandate_private.platform_operators))
      and exists(select 1 from mandate_private.platform_operator_bootstrap_allowlist a where a.user_id=v_user and a.consumed_at is null)
    into v_can_bootstrap;
  return jsonb_build_object(
    'isOperator',v_operator,
    'canBootstrap',v_can_bootstrap,
    'requirements',case when v_operator then coalesce((
      select jsonb_agg(jsonb_build_object(
        'key',r.requirement_key,'title',r.title,'description',r.description,
        'status',r.status,'evidence',r.evidence,'evidenceReference',r.evidence_reference,
        'reviewedAt',r.reviewed_at,'reviewedBy',p.display_name,'validUntil',r.valid_until
      ) order by r.requirement_key)
      from mandate_private.platform_paid_voting_release_requirements r
      left join public.profiles p on p.id=r.reviewed_by
    ),'[]'::jsonb) else '[]'::jsonb end,
    'releaseReady',case when v_operator then mandate_private.has_current_public_paid_voting_release() else false end,
    'elections',case when v_operator then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',e.id,'title',e.title,'organization',o.name,'countryCode',o.country_code,
        'status',e.status,'startsAt',e.starts_at,'endsAt',e.ends_at,'timezone',e.timezone,
        'currency',e.currency,'pricePerCreditMinor',e.price_per_credit_minor,
        'maxCreditsPerParticipant',e.max_credits_per_participant,
        'authorized',e.paid_voting_authorized_at is not null,
        'createdAt',e.created_at
      ) order by e.created_at desc)
      from (
        select * from public.elections
        where voting_mode='public_paid' and status in ('draft','scheduled')
        order by created_at desc limit 50
      ) e
      join public.organizations o on o.id=e.organization_id
    ),'[]'::jsonb) else '[]'::jsonb end,
    'audit',case when v_operator then coalesce((
      select jsonb_agg(x.entry order by x.created_at desc)
      from (
        select jsonb_build_object(
          'eventType',a.event_type,'requirementKey',a.requirement_key,
          'electionId',a.election_id,'actor',p.display_name,
          'beforeState',a.before_state,'afterState',a.after_state,'createdAt',a.created_at
        ) as entry,a.created_at
        from mandate_private.platform_paid_voting_release_audit a
        left join public.profiles p on p.id=a.actor_id
        order by a.created_at desc limit 100
      ) x
    ),'[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;
revoke all on function mandate_private.get_platform_paid_voting_status() from public, anon, authenticated;
grant execute on function mandate_private.get_platform_paid_voting_status() to authenticated;

create or replace function mandate_private.record_platform_paid_voting_requirement(
  p_requirement_key text,
  p_status text,
  p_evidence text,
  p_evidence_reference text,
  p_valid_until timestamptz default null
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_before jsonb;
  v_after jsonb;
begin
  if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  if not mandate_private.is_platform_operator() then raise exception 'PLATFORM_OPERATOR_REQUIRED' using errcode='42501'; end if;
  if p_status not in ('pending','approved','rejected') then raise exception 'INVALID_RELEASE_STATUS' using errcode='22023'; end if;
  if p_status = 'approved' and (
    length(btrim(coalesce(p_evidence,''))) < 40
    or length(btrim(coalesce(p_evidence_reference,''))) < 8
    or (p_valid_until is not null and p_valid_until <= now())
  ) then raise exception 'APPROVAL_EVIDENCE_REQUIRED' using errcode='22023'; end if;
  if p_status = 'rejected' and length(btrim(coalesce(p_evidence,''))) < 20 then
    raise exception 'REJECTION_REASON_REQUIRED' using errcode='22023';
  end if;

  select to_jsonb(r) into v_before from mandate_private.platform_paid_voting_release_requirements r
  where r.requirement_key=p_requirement_key for update;
  if not found then raise exception 'RELEASE_REQUIREMENT_NOT_FOUND' using errcode='P0002'; end if;

  update mandate_private.platform_paid_voting_release_requirements as req
  set status=p_status,
      evidence=nullif(btrim(p_evidence),''),
      evidence_reference=nullif(btrim(p_evidence_reference),''),
      reviewed_by=case when p_status='pending' then null else v_actor end,
      reviewed_at=case when p_status='pending' then null else now() end,
      valid_until=case when p_status='approved' then p_valid_until else null end,
      updated_at=now()
  where req.requirement_key=p_requirement_key
  returning to_jsonb(req) into v_after;

  insert into mandate_private.platform_paid_voting_release_audit(
    actor_id,event_type,requirement_key,before_state,after_state
  ) values (v_actor,'requirement_reviewed',p_requirement_key,v_before,v_after);
  return v_after;
end;
$$;
revoke all on function mandate_private.record_platform_paid_voting_requirement(text,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function mandate_private.record_platform_paid_voting_requirement(text,text,text,text,timestamptz) to authenticated;

create or replace function mandate_private.authorize_public_paid_election(
  p_election_id uuid,
  p_scope_acknowledged boolean
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_e public.elections%rowtype;
  v_country char(2);
  v_guard_token text;
begin
  if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  if not mandate_private.is_platform_operator() then raise exception 'PLATFORM_OPERATOR_REQUIRED' using errcode='42501'; end if;
  if p_scope_acknowledged is distinct from true then raise exception 'SUPPORTED_USE_CASE_ACKNOWLEDGEMENT_REQUIRED' using errcode='22023'; end if;
  if not mandate_private.has_current_public_paid_voting_release() then
    raise exception 'PAID_VOTING_RELEASE_REQUIREMENTS_PENDING' using errcode='55000';
  end if;

  select * into v_e from public.elections where id=p_election_id for update;
  if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
  if v_e.status <> 'draft' or v_e.voting_mode <> 'public_paid' then
    raise exception 'PUBLIC_PAID_DRAFT_REQUIRED' using errcode='55000';
  end if;
  select country_code into v_country from public.organizations where id=v_e.organization_id;
  if v_country is distinct from 'KE' then raise exception 'JURISDICTION_NOT_RELEASED' using errcode='55000'; end if;
  if v_e.currency <> 'KES' or v_e.price_per_credit_minor is null or v_e.price_per_credit_minor <= 0
    or v_e.max_credits_per_participant is null or v_e.max_credits_per_participant < 1
    or not v_e.contact_verification_required or v_e.public_slug is null
    or v_e.starts_at is null or v_e.ends_at is null or v_e.ends_at <= now() or v_e.ends_at <= v_e.starts_at then
    raise exception 'PUBLIC_PAID_ELECTION_CONFIGURATION_INVALID' using errcode='23514';
  end if;

  select guard_token into v_guard_token
  from mandate_private.platform_authorization_guard where singleton;
  if v_guard_token is null then raise exception 'PLATFORM_AUTHORIZATION_GUARD_MISSING' using errcode='55000'; end if;
  perform set_config('mandate.platform_paid_voting_internal',v_guard_token,true);
  update public.elections
  set paid_voting_authorized_at=now(),paid_voting_authorized_by=v_actor,
      setup_confirmed_at=null,setup_confirmed_by=null,setup_confirmation_hash=null
  where id=v_e.id;

  insert into mandate_private.platform_paid_voting_release_audit(
    actor_id,event_type,election_id,after_state
  ) values (v_actor,'election_authorized',v_e.id,jsonb_build_object(
    'organizationId',v_e.organization_id,'currency',v_e.currency,
    'pricePerCreditMinor',v_e.price_per_credit_minor,
    'maxCreditsPerParticipant',v_e.max_credits_per_participant,
    'startsAt',v_e.starts_at,'endsAt',v_e.ends_at,
    'scope','Kenya private organizational elections only'
  ));
  insert into public.audit_events(
    organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata
  ) values (
    v_e.organization_id,v_e.id,v_actor,'platform_operator','election.public_paid_platform_authorized',
    'election',v_e.id,jsonb_build_object('scope','Kenya private organizational elections only')
  );
  return jsonb_build_object('electionId',v_e.id,'authorizedAt',now(),'authorizedBy',v_actor);
end;
$$;
revoke all on function mandate_private.authorize_public_paid_election(uuid,boolean) from public, anon, authenticated;
grant execute on function mandate_private.authorize_public_paid_election(uuid,boolean) to authenticated;

create or replace function mandate_private.guard_public_paid_release()
returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
begin
  if tg_op='INSERT' then
    if new.voting_mode='public_paid' and (
      new.paid_voting_authorized_at is not null or new.paid_voting_authorized_by is not null
    ) and current_setting('mandate.platform_paid_voting_internal',true) is distinct from
      (select guard_token from mandate_private.platform_authorization_guard where singleton) then
      raise exception 'PLATFORM_AUTHORIZATION_SERVER_MANAGED' using errcode='55000';
    end if;
    if new.voting_mode='public_paid' and (
      new.status='open' or new.setup_confirmed_at is not null
    ) then
      if not mandate_private.has_current_public_paid_voting_release() then
        raise exception 'PAID_VOTING_RELEASE_REQUIREMENTS_PENDING' using errcode='55000';
      end if;
      if new.paid_voting_authorized_at is null or new.paid_voting_authorized_by is null then
        raise exception 'PAID_VOTING_AUTHORIZATION_REQUIRED' using errcode='55000';
      end if;
    end if;
    return new;
  end if;

  if new.voting_mode='public_paid' and (
    new.paid_voting_authorized_at is distinct from old.paid_voting_authorized_at
    or new.paid_voting_authorized_by is distinct from old.paid_voting_authorized_by
  ) and current_setting('mandate.platform_paid_voting_internal',true) is distinct from
      (select guard_token from mandate_private.platform_authorization_guard where singleton) then
    raise exception 'PLATFORM_AUTHORIZATION_SERVER_MANAGED' using errcode='55000';
  end if;

  if new.voting_mode='public_paid' and (
    new.status='open'
    or new.setup_confirmed_at is distinct from old.setup_confirmed_at
  ) then
    if not mandate_private.has_current_public_paid_voting_release() then
      raise exception 'PAID_VOTING_RELEASE_REQUIREMENTS_PENDING' using errcode='55000';
    end if;
    if new.paid_voting_authorized_at is null or new.paid_voting_authorized_by is null then
      raise exception 'PAID_VOTING_AUTHORIZATION_REQUIRED' using errcode='55000';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function mandate_private.guard_public_paid_release() from public, anon, authenticated;
create trigger elections_guard_public_paid_release
before update of status,setup_confirmed_at,paid_voting_authorized_at,paid_voting_authorized_by
on public.elections
for each row execute function mandate_private.guard_public_paid_release();
create trigger elections_guard_public_paid_release_insert
before insert on public.elections
for each row execute function mandate_private.guard_public_paid_release();

-- Re-check the active release gate at the last safe database boundary for every
-- new public vote-credit purchase and every newly inserted public-paid ballot.
-- Payment verification/fulfillment of an already-created intent is intentionally
-- not blocked: a participant who has already paid must not lose their entitlement.
create or replace function mandate_private.guard_public_paid_payment_intent_release()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_e public.elections%rowtype;
begin
  if new.purpose <> 'public_vote_credits' then return new; end if;
  select * into v_e from public.elections where id=new.election_id;
  if not found or v_e.voting_mode <> 'public_paid' then
    raise exception 'PUBLIC_PAID_ELECTION_NOT_READY' using errcode='55000';
  end if;
  if not mandate_private.has_current_public_paid_voting_release() then
    raise exception 'PAID_VOTING_RELEASE_REQUIREMENTS_PENDING' using errcode='55000';
  end if;
  if v_e.status <> 'open' or v_e.paid_voting_authorized_at is null
    or v_e.paid_voting_authorized_by is null
    or v_e.currency <> 'KES' or v_e.price_per_credit_minor is null
    or v_e.price_per_credit_minor <= 0 or not v_e.contact_verification_required
    or pg_catalog.now() < v_e.starts_at or pg_catalog.now() >= v_e.ends_at then
    raise exception 'PUBLIC_PAID_ELECTION_NOT_READY' using errcode='55000';
  end if;
  return new;
end;
$$;
revoke all on function mandate_private.guard_public_paid_payment_intent_release() from public,anon,authenticated;
create trigger payment_intents_public_paid_release_guard
before insert on public.payment_intents
for each row execute function mandate_private.guard_public_paid_payment_intent_release();

create or replace function mandate_private.guard_public_paid_ballot_release()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_e public.elections%rowtype;
begin
  select * into v_e from public.elections where id=new.election_id;
  if found and v_e.voting_mode='public_paid' then
    if not mandate_private.has_current_public_paid_voting_approvals() then
      raise exception 'PAID_VOTING_RELEASE_REQUIREMENTS_PENDING' using errcode='55000';
    end if;
    if v_e.status <> 'open' or v_e.paid_voting_authorized_at is null
      or v_e.paid_voting_authorized_by is null
      or pg_catalog.now() < v_e.starts_at or pg_catalog.now() >= v_e.ends_at then
      raise exception 'PUBLIC_PAID_ELECTION_NOT_READY' using errcode='55000';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function mandate_private.guard_public_paid_ballot_release() from public,anon,authenticated;
create trigger ballots_public_paid_release_guard
before insert on public.ballots
for each row execute function mandate_private.guard_public_paid_ballot_release();

create or replace function public.get_platform_paid_voting_status()
returns jsonb language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.get_platform_paid_voting_status(); $$;
create or replace function public.bootstrap_platform_operator()
returns jsonb language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.bootstrap_platform_operator(); $$;
create or replace function public.record_platform_paid_voting_requirement(
  p_requirement_key text,p_status text,p_evidence text,p_evidence_reference text,p_valid_until timestamptz default null
)
returns jsonb language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.record_platform_paid_voting_requirement($1,$2,$3,$4,$5); $$;
create or replace function public.authorize_public_paid_election(p_election_id uuid,p_scope_acknowledged boolean)
returns jsonb language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.authorize_public_paid_election($1,$2); $$;

revoke all on function public.get_platform_paid_voting_status() from public,anon;
revoke all on function public.bootstrap_platform_operator() from public,anon;
revoke all on function public.record_platform_paid_voting_requirement(text,text,text,text,timestamptz) from public,anon;
revoke all on function public.authorize_public_paid_election(uuid,boolean) from public,anon;
grant execute on function public.get_platform_paid_voting_status() to authenticated;
grant execute on function public.bootstrap_platform_operator() to authenticated;
grant execute on function public.record_platform_paid_voting_requirement(text,text,text,text,timestamptz) to authenticated;
grant execute on function public.authorize_public_paid_election(uuid,boolean) to authenticated;

comment on table mandate_private.platform_paid_voting_release_requirements is
  'Private, evidence-backed release checklist for the public paid-voting capability. Every requirement must be approved and unexpired.';
comment on table mandate_private.platform_paid_voting_release_audit is
  'Append-only audit history for platform operator bootstrap, release requirement reviews and election authorizations.';
