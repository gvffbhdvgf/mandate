create table if not exists public.election_tallies (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 election_id uuid not null references public.elections(id), snapshot_hash text not null,
 eligible_voter_count bigint not null default 0 check(eligible_voter_count>=0),
 participating_voter_count bigint not null default 0 check(participating_voter_count>=0),
 accepted_ballot_count bigint not null default 0 check(accepted_ballot_count>=0),
 invalidated_ballot_count bigint not null default 0 check(invalidated_ballot_count>=0),
 total_vote_units bigint not null default 0 check(total_vote_units>=0),
 requires_resolution boolean not null default false,reconciled_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),
 constraint election_tallies_one_per_election unique(election_id)
);
create table if not exists public.election_tally_results (
 tally_id uuid not null references public.election_tallies(id) on delete cascade,
 organization_id uuid not null references public.organizations(id),election_id uuid not null references public.elections(id),
 contest_id uuid not null references public.contests(id),option_id uuid not null references public.options(id),
 ballot_count bigint not null check(ballot_count>=0),vote_units bigint not null check(vote_units>=0),
 share_basis_points integer not null check(share_basis_points between 0 and 10000),
 result_rank integer not null check(result_rank>=1),tie_policy public.tie_policy not null,
 is_tied boolean not null default false,is_winner boolean not null default false,
 requires_resolution boolean not null default false,primary key(tally_id,contest_id,option_id)
);
create index if not exists election_tally_results_election_idx on public.election_tally_results(election_id,contest_id,result_rank);
alter table public.election_tallies enable row level security;
alter table public.election_tally_results enable row level security;
revoke all on public.election_tallies,public.election_tally_results from public,anon,authenticated;
grant all on public.election_tallies,public.election_tally_results to service_role;

create or replace function mandate_private.tally_and_reconcile(p_election_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare
 v_user uuid:=auth.uid(); v_e public.elections%rowtype; v_existing public.election_tallies%rowtype;
 v_tally_id uuid; v_hash text; v_eligible bigint; v_participating bigint; v_controls bigint;
 v_ballots bigint; v_accepted bigint; v_invalidated bigint; v_vote_units bigint; v_requires boolean;
begin
 if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 select * into v_e from public.elections where id=p_election_id for update;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager','returning_officer']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into v_existing from public.election_tallies where election_id=v_e.id for update;
 if found then return jsonb_build_object('tallyId',v_existing.id,'status','reconciled','eligibleVoters',v_existing.eligible_voter_count,
  'participatingVoters',v_existing.participating_voter_count,'acceptedBallots',v_existing.accepted_ballot_count,
  'invalidatedBallots',v_existing.invalidated_ballot_count,'requiresResolution',v_existing.requires_resolution); end if;
 if v_e.status<>'closed' then raise exception 'ELECTION_MUST_BE_CLOSED' using errcode='55000'; end if;
 if v_e.voting_mode='public_paid' then raise exception 'PAID_VOTING_FEATURE_GATED' using errcode='55000'; end if;
 if v_e.rules_snapshot is null or v_e.candidate_snapshot is null or v_e.rules_hash is null then raise exception 'ELECTION_SNAPSHOT_MISSING' using errcode='23514'; end if;
 v_hash:=encode(extensions.digest(convert_to(v_e.rules_snapshot::text||coalesce(v_e.candidate_snapshot::text,''),'UTF8'),'sha256'),'hex');
 if v_hash<>v_e.rules_hash then raise exception 'ELECTION_SNAPSHOT_HASH_MISMATCH' using errcode='23514'; end if;
 select count(*) into v_eligible from public.election_voters where election_id=v_e.id and eligibility_status='eligible';
 select count(*) into v_controls from public.ballot_submission_controls where election_id=v_e.id;
 select count(distinct voter_id) into v_participating from public.ballot_submission_controls where election_id=v_e.id and voter_id is not null;
 select count(*) into v_ballots from public.ballots where election_id=v_e.id;
 select count(*) into v_accepted from public.ballots where election_id=v_e.id and status='accepted';
 select count(*) into v_invalidated from public.ballots where election_id=v_e.id and status='invalidated';
 select coalesce(sum(vote_units),0) into v_vote_units from public.ballots where election_id=v_e.id and status='accepted';
 if v_controls<>v_ballots then raise exception 'BALLOT_CONTROL_RECONCILIATION_FAILED' using errcode='23514'; end if;
 if exists(select 1 from public.ballot_submission_controls c left join public.ballots b on b.id=c.ballot_id
  where c.election_id=v_e.id and (c.voter_id is null or b.id is null or b.election_id<>c.election_id or b.contest_id<>c.contest_id)) then
  raise exception 'BALLOT_CONTROL_MAPPING_INVALID' using errcode='23514'; end if;
 if exists(select 1 from public.ballots b left join public.ballot_submission_controls c on c.ballot_id=b.id
  where b.election_id=v_e.id and c.id is null) then raise exception 'ORPHAN_BALLOT_DETECTED' using errcode='23514'; end if;
 if v_participating>v_eligible then raise exception 'TURNOUT_EXCEEDS_ELIGIBLE_REGISTER' using errcode='23514'; end if;
 insert into public.election_tallies(organization_id,election_id,snapshot_hash,eligible_voter_count,participating_voter_count,
  accepted_ballot_count,invalidated_ballot_count,total_vote_units,created_by)
 values(v_e.organization_id,v_e.id,v_hash,v_eligible,v_participating,v_accepted,v_invalidated,v_vote_units,v_user)
 returning id into v_tally_id;
 with raw as (
  select c.id contest_id,c.tie_policy,o.id option_id,
   count(b.id) filter(where b.status='accepted')::bigint ballot_count,
   coalesce(sum(b.vote_units) filter(where b.status='accepted'),0)::bigint vote_units
  from public.contests c join public.options o on o.contest_id=c.id and o.status='active'
  left join public.ballots b on b.election_id=v_e.id and b.contest_id=c.id and b.option_id=o.id
  where c.election_id=v_e.id group by c.id,c.tie_policy,o.id
 ), ranked as (
  select raw.*,dense_rank() over(partition by contest_id order by vote_units desc) result_rank,
   sum(vote_units) over(partition by contest_id) contest_vote_units,
   max(vote_units) over(partition by contest_id) top_vote_units from raw
 ), top_counts as (
  select contest_id,count(*) filter(where vote_units=top_vote_units) top_count from ranked group by contest_id
 )
 insert into public.election_tally_results(tally_id,organization_id,election_id,contest_id,option_id,ballot_count,vote_units,
  share_basis_points,result_rank,tie_policy,is_tied,is_winner,requires_resolution)
 select v_tally_id,v_e.organization_id,v_e.id,r.contest_id,r.option_id,r.ballot_count,r.vote_units,
  case when r.contest_vote_units=0 then 0 else round(r.vote_units*10000.0/r.contest_vote_units)::integer end,
  r.result_rank,r.tie_policy,
  (r.result_rank=1 and tc.top_count>1 and r.contest_vote_units>0),
  (r.result_rank=1 and r.contest_vote_units>0 and (tc.top_count=1 or r.tie_policy='declared_tie')),
  (r.result_rank=1 and tc.top_count>1 and r.contest_vote_units>0 and r.tie_policy<>'declared_tie')
 from ranked r join top_counts tc on tc.contest_id=r.contest_id;
 select exists(select 1 from public.election_tally_results where tally_id=v_tally_id and requires_resolution) into v_requires;
 update public.election_tallies set requires_resolution=v_requires where id=v_tally_id;
 update public.elections set status='tallying' where id=v_e.id;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(v_e.organization_id,v_e.id,v_user,'user','election.tallied','election_tally',v_tally_id,
  jsonb_build_object('eligibleVoters',v_eligible,'participatingVoters',v_participating,'acceptedBallots',v_accepted,
   'invalidatedBallots',v_invalidated,'requiresResolution',v_requires,'snapshotHash',v_hash));
 return jsonb_build_object('tallyId',v_tally_id,'status','reconciled','eligibleVoters',v_eligible,
  'participatingVoters',v_participating,'acceptedBallots',v_accepted,'invalidatedBallots',v_invalidated,'requiresResolution',v_requires);
end; $$;

create or replace function mandate_private.publish_results(p_election_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_user uuid:=auth.uid(); v_e public.elections%rowtype; v_t public.election_tallies%rowtype;
begin
 if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 select * into v_e from public.elections where id=p_election_id for update;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','returning_officer']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if v_e.status<>'tallying' then raise exception 'ELECTION_NOT_TALLIED' using errcode='55000'; end if;
 select * into v_t from public.election_tallies where election_id=v_e.id for update;
 if not found then raise exception 'TALLY_NOT_FOUND' using errcode='P0002'; end if;
 if v_t.requires_resolution then raise exception 'RESULT_RESOLUTION_REQUIRED' using errcode='55000'; end if;
 update public.elections set status='results_published',published_at=now() where id=v_e.id;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(v_e.organization_id,v_e.id,v_user,'user','election.results_published','election_tally',v_t.id,jsonb_build_object('snapshotHash',v_t.snapshot_hash));
 return jsonb_build_object('electionId',v_e.id,'status','results_published','publishedAt',now());
end; $$;

create or replace function mandate_private.get_published_results(p_election_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_e public.elections%rowtype; v_t public.election_tallies%rowtype; v_contests jsonb;
begin
 select * into v_e from public.elections where id=p_election_id;
 if not found or v_e.status<>'results_published' then raise exception 'RESULTS_NOT_PUBLISHED' using errcode='55000'; end if;
 if v_e.result_visibility<>'public' then
  if auth.uid() is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_e.result_visibility='members' then
   if not mandate_private.is_org_member(v_e.organization_id) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  elsif not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager','returning_officer']::public.organization_role[]) then
   raise exception 'FORBIDDEN' using errcode='42501';
  end if;
 end if;
 select * into v_t from public.election_tallies where election_id=v_e.id;
 select jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'tiePolicy',c.tie_policy,
  'options',(select jsonb_agg(jsonb_build_object('id',r.option_id,'name',o.display_name,'ballots',r.ballot_count,
   'voteUnits',r.vote_units,'shareBasisPoints',r.share_basis_points,'rank',r.result_rank,'isWinner',r.is_winner,
   'isTied',r.is_tied,'requiresResolution',r.requires_resolution) order by r.result_rank,o.display_order)
   from public.election_tally_results r join public.options o on o.id=r.option_id where r.tally_id=v_t.id and r.contest_id=c.id)
 ) order by c.display_order) into v_contests from public.contests c where c.election_id=v_e.id;
 return jsonb_build_object(
  'election',jsonb_build_object('id',v_e.id,'title',v_e.title,'publishedAt',v_e.published_at,'timezone',v_e.timezone),
  'tally',jsonb_build_object('eligibleVoters',v_t.eligible_voter_count,'participatingVoters',v_t.participating_voter_count,
   'turnoutBasisPoints',case when v_t.eligible_voter_count=0 then 0 else round(v_t.participating_voter_count*10000.0/v_t.eligible_voter_count)::integer end,
   'acceptedBallots',v_t.accepted_ballot_count,'invalidatedBallots',v_t.invalidated_ballot_count,
   'totalVoteUnits',v_t.total_vote_units,'requiresResolution',v_t.requires_resolution),
  'contests',coalesce(v_contests,'[]'::jsonb)
 );
end; $$;

revoke all on function mandate_private.tally_and_reconcile(uuid) from public,anon;
revoke all on function mandate_private.publish_results(uuid) from public,anon;
revoke all on function mandate_private.get_published_results(uuid) from public;
grant execute on function mandate_private.tally_and_reconcile(uuid) to authenticated;
grant execute on function mandate_private.publish_results(uuid) to authenticated;
grant execute on function mandate_private.get_published_results(uuid) to anon,authenticated;

create function public.tally_and_reconcile(p_election_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.tally_and_reconcile($1); $$;
create function public.publish_results(p_election_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.publish_results($1); $$;
create function public.get_published_results(p_election_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.get_published_results($1); $$;
revoke all on function public.tally_and_reconcile(uuid) from public,anon;
revoke all on function public.publish_results(uuid) from public,anon;
revoke all on function public.get_published_results(uuid) from public;
grant execute on function public.tally_and_reconcile(uuid) to authenticated;
grant execute on function public.publish_results(uuid) to authenticated;
grant execute on function public.get_published_results(uuid) to anon,authenticated;
