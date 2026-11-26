-- M2 resumable election setup drafts and database-enforced authority confirmation.
alter table public.elections
  add column setup_confirmed_at timestamptz,
  add column setup_confirmed_by uuid references auth.users(id),
  add column setup_confirmation_hash text check (setup_confirmation_hash is null or setup_confirmation_hash ~ '^[0-9a-f]{64}$'),
  add constraint elections_setup_confirmation_consistent check (
    (setup_confirmed_at is null) = (setup_confirmed_by is null)
    and (setup_confirmed_at is null) = (setup_confirmation_hash is null)
  );

create table public.election_setup_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload)='object'),
  current_step integer not null default 1 check (current_step between 1 and 6),
  status text not null default 'draft' check (status in ('draft','finalized','abandoned')),
  election_id uuid unique references public.elections(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status='finalized') = (election_id is not null)),
  unique (id,organization_id)
);
create index election_setup_drafts_org_updated_idx on public.election_setup_drafts(organization_id,updated_at desc);
create index election_setup_drafts_creator_updated_idx on public.election_setup_drafts(created_by,updated_at desc);
create trigger election_setup_drafts_set_updated_at before update on public.election_setup_drafts
for each row execute function mandate_private.set_updated_at();
alter table public.election_setup_drafts enable row level security;
revoke all on public.election_setup_drafts from anon,authenticated;

create or replace function mandate_private.save_election_setup_draft(
 p_draft_id uuid,p_organization_id uuid,p_payload jsonb,p_current_step integer
) returns uuid language plpgsql security definer set search_path=pg_catalog
as $$
declare v_actor uuid:=auth.uid(); v_id uuid;
begin
 if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if p_organization_id is null or not mandate_private.has_org_role(
   p_organization_id,array['owner','admin','election_manager']::public.organization_role[]
 ) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>131072 then
   raise exception 'INVALID_ELECTION_DRAFT' using errcode='22023';
 end if;
 if p_current_step is null or p_current_step not between 1 and 6 then
   raise exception 'INVALID_SETUP_STEP' using errcode='22023';
 end if;
 if p_draft_id is null then
   insert into public.election_setup_drafts(organization_id,created_by,payload,current_step)
   values(p_organization_id,v_actor,p_payload,p_current_step) returning id into v_id;
 else
   update public.election_setup_drafts set payload=p_payload,current_step=p_current_step
   where id=p_draft_id and organization_id=p_organization_id and status='draft';
   if not found then raise exception 'ELECTION_DRAFT_NOT_EDITABLE' using errcode='55000'; end if;
   v_id:=p_draft_id;
 end if;
 return v_id;
end;
$$;
revoke all on function mandate_private.save_election_setup_draft(uuid,uuid,jsonb,integer) from public,anon;
grant execute on function mandate_private.save_election_setup_draft(uuid,uuid,jsonb,integer) to authenticated;
create or replace function public.save_election_setup_draft(p_draft_id uuid,p_organization_id uuid,p_payload jsonb,p_current_step integer)
returns uuid language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.save_election_setup_draft($1,$2,$3,$4); $$;
revoke all on function public.save_election_setup_draft(uuid,uuid,jsonb,integer) from public,anon;
grant execute on function public.save_election_setup_draft(uuid,uuid,jsonb,integer) to authenticated;

create or replace function mandate_private.get_election_setup_draft(p_draft_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_d public.election_setup_drafts%rowtype;
begin
 if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 select * into v_d from public.election_setup_drafts where id=p_draft_id;
 if not found then raise exception 'ELECTION_DRAFT_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_d.organization_id,array['owner','admin','election_manager']::public.organization_role[]) then
   raise exception 'FORBIDDEN' using errcode='42501';
 end if;
 return jsonb_build_object('id',v_d.id,'organizationId',v_d.organization_id,'payload',v_d.payload,
   'currentStep',v_d.current_step,'status',v_d.status,'electionId',v_d.election_id,'updatedAt',v_d.updated_at);
end;
$$;
revoke all on function mandate_private.get_election_setup_draft(uuid) from public,anon;
grant execute on function mandate_private.get_election_setup_draft(uuid) to authenticated;

create or replace function mandate_private.finalize_election_setup_draft(p_draft_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog
as $$
declare v_d public.election_setup_drafts%rowtype; v_election_id uuid;
begin
 if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 select * into v_d from public.election_setup_drafts where id=p_draft_id for update;
 if not found then raise exception 'ELECTION_DRAFT_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_d.organization_id,array['owner','admin','election_manager']::public.organization_role[]) then
   raise exception 'FORBIDDEN' using errcode='42501';
 end if;
 if v_d.status<>'draft' then raise exception 'ELECTION_DRAFT_ALREADY_FINALIZED' using errcode='55000'; end if;
 if jsonb_typeof(v_d.payload->'election') is distinct from 'object' or jsonb_typeof(v_d.payload->'contests') is distinct from 'array' then
   raise exception 'ELECTION_DRAFT_INCOMPLETE' using errcode='22023';
 end if;
 v_election_id:=mandate_private.create_election_setup(v_d.organization_id,v_d.payload->'election',v_d.payload->'contests');
 update public.election_setup_drafts set status='finalized',election_id=v_election_id,current_step=6 where id=v_d.id;
 return v_election_id;
end;
$$;
revoke all on function mandate_private.finalize_election_setup_draft(uuid) from public,anon;
grant execute on function mandate_private.finalize_election_setup_draft(uuid) to authenticated;

create or replace function mandate_private.compute_election_setup_hash(p_election_id uuid)
returns text language plpgsql security definer set search_path=pg_catalog
as $$
declare v_e public.elections%rowtype; v_rules jsonb; v_candidates jsonb;
begin
 select * into v_e from public.elections where id=p_election_id;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 select jsonb_build_object('votingMode',v_e.voting_mode,'startsAt',v_e.starts_at,'endsAt',v_e.ends_at,
   'timezone',v_e.timezone,'resultVisibility',v_e.result_visibility,'rulesVersion',v_e.rules_version) into v_rules;
 select jsonb_agg(jsonb_build_object('contestId',c.id,'title',c.title,'required',c.is_required,'tiePolicy',c.tie_policy,
   'options',(select jsonb_agg(jsonb_build_object('id',o.id,'displayName',o.display_name) order by o.display_order)
     from public.options o where o.contest_id=c.id and o.status='active')) order by c.display_order)
 into v_candidates from public.contests c where c.election_id=v_e.id;
 return encode(extensions.digest(convert_to(v_rules::text||coalesce(v_candidates::text,''),'UTF8'),'sha256'),'hex');
end;
$$;
revoke all on function mandate_private.compute_election_setup_hash(uuid) from public,anon,authenticated;

create or replace function mandate_private.confirm_election_setup(p_election_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_e public.elections%rowtype; v_actor uuid:=auth.uid(); v_hash text;
begin
 if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 select * into v_e from public.elections where id=p_election_id for update;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager']::public.organization_role[]) then
   raise exception 'FORBIDDEN' using errcode='42501';
 end if;
 if v_e.status<>'draft' then raise exception 'ELECTION_CONFIGURATION_FROZEN' using errcode='55000'; end if;
 if v_e.voting_mode='public_paid' then raise exception 'PAID_VOTING_FEATURE_GATED' using errcode='55000'; end if;
 if not exists(select 1 from public.contests c where c.election_id=v_e.id) then raise exception 'CONTEST_REQUIRED' using errcode='23514'; end if;
 if exists(select 1 from public.contests c where c.election_id=v_e.id
   and (select count(*) from public.options o where o.contest_id=c.id and o.status='active')<2) then
   raise exception 'EACH_CONTEST_REQUIRES_TWO_ACTIVE_OPTIONS' using errcode='23514';
 end if;
 v_hash:=mandate_private.compute_election_setup_hash(v_e.id);
 update public.elections set setup_confirmed_at=now(),setup_confirmed_by=v_actor,setup_confirmation_hash=v_hash where id=v_e.id;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(v_e.organization_id,v_e.id,v_actor,'user','election.setup_confirmed','election',v_e.id,jsonb_build_object('configurationHash',v_hash));
 return jsonb_build_object('electionId',v_e.id,'confirmedAt',now(),'configurationHash',v_hash);
end;
$$;
revoke all on function mandate_private.confirm_election_setup(uuid) from public,anon;
grant execute on function mandate_private.confirm_election_setup(uuid) to authenticated;

-- Enforce authority confirmation and invalidate it whenever the frozen configuration drifts.
create or replace function mandate_private.open_election(p_election_id uuid,p_confirm_rules_snapshot boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare
 v_user uuid:=auth.uid(); v_e public.elections%rowtype; v_contest_count integer; v_bad_contests integer;
 v_voter_count integer; v_rules jsonb; v_candidates jsonb; v_hash text;
begin
 if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if p_confirm_rules_snapshot is distinct from true then raise exception 'RULES_CONFIRMATION_REQUIRED' using errcode='22023'; end if;
 select * into v_e from public.elections where id=p_election_id for update;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if v_e.status not in ('draft','scheduled') then raise exception 'INVALID_ELECTION_STATE' using errcode='55000'; end if;
 if v_e.voting_mode='public_paid' then raise exception 'PAID_VOTING_FEATURE_GATED' using errcode='55000'; end if;
 if v_e.starts_at>now() then raise exception 'ELECTION_NOT_STARTED' using errcode='55000'; end if;
 if v_e.ends_at<=now() then raise exception 'ELECTION_WINDOW_EXPIRED' using errcode='55000'; end if;
 if v_e.setup_confirmed_at is null or v_e.setup_confirmed_by is null or v_e.setup_confirmation_hash is null then
   raise exception 'ELECTION_SETUP_NOT_CONFIRMED' using errcode='55000';
 end if;
 select count(*) into v_contest_count from public.contests c where c.election_id=v_e.id;
 if v_contest_count=0 then raise exception 'CONTEST_REQUIRED' using errcode='23514'; end if;
 select count(*) into v_bad_contests from public.contests c where c.election_id=v_e.id
   and (select count(*) from public.options o where o.contest_id=c.id and o.status='active')<2;
 if v_bad_contests>0 then raise exception 'EACH_CONTEST_REQUIRES_TWO_ACTIVE_OPTIONS' using errcode='23514'; end if;
 if v_e.voting_mode in ('registered_single','registered_weighted') then
   select count(*) into v_voter_count from public.election_voters v where v.election_id=v_e.id and v.eligibility_status='eligible';
   if v_voter_count=0 then raise exception 'ELIGIBLE_VOTERS_REQUIRED' using errcode='23514'; end if;
   if exists(select 1 from public.election_voters v where v.election_id=v_e.id and v.eligibility_status='eligible'
     and (v.access_token_hash is null or v.invited_at is null)) then raise exception 'VOTER_ACCESS_NOT_ISSUED' using errcode='55000'; end if;
 end if;
 if v_e.voting_mode='registered_single' and exists(select 1 from public.election_voters v
   where v.election_id=v_e.id and v.weight_units<>1) then raise exception 'SINGLE_VOTE_WEIGHT_MUST_BE_ONE' using errcode='23514'; end if;
 select jsonb_build_object('votingMode',v_e.voting_mode,'startsAt',v_e.starts_at,'endsAt',v_e.ends_at,
   'timezone',v_e.timezone,'resultVisibility',v_e.result_visibility,'rulesVersion',v_e.rules_version) into v_rules;
 select jsonb_agg(jsonb_build_object('contestId',c.id,'title',c.title,'required',c.is_required,'tiePolicy',c.tie_policy,
   'options',(select jsonb_agg(jsonb_build_object('id',o.id,'displayName',o.display_name) order by o.display_order)
     from public.options o where o.contest_id=c.id and o.status='active')) order by c.display_order)
 into v_candidates from public.contests c where c.election_id=v_e.id;
 v_hash:=encode(extensions.digest(convert_to(v_rules::text||coalesce(v_candidates::text,''),'UTF8'),'sha256'),'hex');
 if v_hash is distinct from v_e.setup_confirmation_hash then raise exception 'ELECTION_SETUP_CHANGED_RECONFIRM' using errcode='55000'; end if;
 update public.elections set status='open',rules_snapshot=v_rules,candidate_snapshot=v_candidates,rules_hash=v_hash,opened_at=now()
 where id=v_e.id;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(v_e.organization_id,v_e.id,v_user,'user','election.opened','election',v_e.id,
   jsonb_build_object('rulesHash',v_hash,'setupConfirmedBy',v_e.setup_confirmed_by));
 return jsonb_build_object('id',v_e.id,'status','open','rulesHash',v_hash,'openedAt',now());
end;
$$;


-- Harden the original atomic setup RPC against SQL NULL/type edge cases and duplicate options.
create or replace function mandate_private.create_election_setup(
 p_organization_id uuid,p_election jsonb,p_contests jsonb
) returns uuid
language plpgsql security definer set search_path=pg_catalog
as $$
declare
 v_election_id uuid; v_contest_id uuid; v_contest jsonb; v_option jsonb;
 v_contest_order integer:=0; v_option_order integer;
begin
 if jsonb_typeof(p_election) is distinct from 'object' then
   raise exception 'INVALID_ELECTION_PAYLOAD' using errcode='22023';
 end if;
 if jsonb_typeof(p_contests) is distinct from 'array' then
   raise exception 'INVALID_CONTESTS_PAYLOAD' using errcode='22023';
 end if;
 if jsonb_array_length(p_contests)<1 or jsonb_array_length(p_contests)>10 then
   raise exception 'INVALID_CONTESTS_PAYLOAD' using errcode='22023';
 end if;
 v_election_id:=mandate_private.create_election(
   p_organization_id,p_election->>'title',p_election->>'description',
   coalesce(nullif(p_election->>'voting_mode',''),'registered_single')::public.voting_mode,
   (p_election->>'starts_at')::timestamptz,(p_election->>'ends_at')::timestamptz,
   coalesce(nullif(p_election->>'timezone',''),'Africa/Nairobi'),
   coalesce(nullif(p_election->>'result_visibility',''),'private')
 );
 for v_contest in select value from jsonb_array_elements(p_contests)
 loop
   if jsonb_typeof(v_contest) is distinct from 'object' then
     raise exception 'INVALID_CONTEST_OPTIONS' using errcode='22023';
   end if;
   if jsonb_typeof(v_contest->'options') is distinct from 'array' then
     raise exception 'INVALID_CONTEST_OPTIONS' using errcode='22023';
   end if;
   if jsonb_array_length(v_contest->'options')<2 or jsonb_array_length(v_contest->'options')>50 then
     raise exception 'INVALID_CONTEST_OPTIONS' using errcode='22023';
   end if;
   if exists (
     select 1 from jsonb_array_elements(v_contest->'options') as item(value)
     where jsonb_typeof(item.value) is distinct from 'object'
       or nullif(btrim(item.value->>'display_name'),'') is null
   ) then raise exception 'INVALID_OPTION_PAYLOAD' using errcode='22023'; end if;
   if (
     select count(*) <> count(distinct lower(btrim(item.value->>'display_name')))
     from jsonb_array_elements(v_contest->'options') as item(value)
   ) then raise exception 'DUPLICATE_OPTION_NAME' using errcode='22023'; end if;

   v_contest_id:=mandate_private.create_contest(
     v_election_id,v_contest->>'title',v_contest->>'description',
     coalesce((v_contest->>'is_required')::boolean,true),v_contest_order,
     coalesce(nullif(v_contest->>'tie_policy',''),'declared_tie')::public.tie_policy
   );
   v_option_order:=0;
   for v_option in select value from jsonb_array_elements(v_contest->'options')
   loop
     perform mandate_private.create_option(
       v_election_id,v_contest_id,v_option->>'display_name',v_option->>'profile',v_option_order
     );
     v_option_order:=v_option_order+1;
   end loop;
   v_contest_order:=v_contest_order+1;
 end loop;
 return v_election_id;
end;
$$;
revoke all on function mandate_private.create_election_setup(uuid,jsonb,jsonb) from public,anon;
grant execute on function mandate_private.create_election_setup(uuid,jsonb,jsonb) to authenticated;


-- PostgREST exposes only SECURITY INVOKER wrappers; privileged bodies stay private.
create or replace function public.get_election_setup_draft(p_draft_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.get_election_setup_draft($1); $$;
revoke all on function public.get_election_setup_draft(uuid) from public,anon;
grant execute on function public.get_election_setup_draft(uuid) to authenticated;

create or replace function public.finalize_election_setup_draft(p_draft_id uuid)
returns uuid language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.finalize_election_setup_draft($1); $$;
revoke all on function public.finalize_election_setup_draft(uuid) from public,anon;
grant execute on function public.finalize_election_setup_draft(uuid) to authenticated;

create or replace function public.confirm_election_setup(p_election_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.confirm_election_setup($1); $$;
revoke all on function public.confirm_election_setup(uuid) from public,anon;
grant execute on function public.confirm_election_setup(uuid) to authenticated;
