create or replace function mandate_private.open_election(p_election_id uuid,p_confirm_rules_snapshot boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_user uuid:=auth.uid(); v_e public.elections%rowtype; v_contest_count integer; v_bad_contests integer; v_voter_count integer; v_rules jsonb; v_candidates jsonb; v_hash text;
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
 select count(*) into v_contest_count from public.contests c where c.election_id=v_e.id;
 if v_contest_count=0 then raise exception 'CONTEST_REQUIRED' using errcode='23514'; end if;
 select count(*) into v_bad_contests from public.contests c where c.election_id=v_e.id and (select count(*) from public.options o where o.contest_id=c.id and o.status='active')<2;
 if v_bad_contests>0 then raise exception 'EACH_CONTEST_REQUIRES_TWO_ACTIVE_OPTIONS' using errcode='23514'; end if;
 if v_e.voting_mode in ('registered_single','registered_weighted') then
  select count(*) into v_voter_count from public.election_voters v where v.election_id=v_e.id and v.eligibility_status='eligible';
  if v_voter_count=0 then raise exception 'ELIGIBLE_VOTERS_REQUIRED' using errcode='23514'; end if;
  if exists(select 1 from public.election_voters v where v.election_id=v_e.id and v.eligibility_status='eligible' and (v.access_token_hash is null or v.invited_at is null)) then
   raise exception 'VOTER_ACCESS_NOT_ISSUED' using errcode='55000';
  end if;
 end if;
 if v_e.voting_mode='registered_single' and exists(select 1 from public.election_voters v where v.election_id=v_e.id and v.weight_units<>1) then raise exception 'SINGLE_VOTE_WEIGHT_MUST_BE_ONE' using errcode='23514'; end if;
 select jsonb_build_object('votingMode',v_e.voting_mode,'startsAt',v_e.starts_at,'endsAt',v_e.ends_at,'timezone',v_e.timezone,'resultVisibility',v_e.result_visibility,'rulesVersion',v_e.rules_version) into v_rules;
 select jsonb_agg(jsonb_build_object('contestId',c.id,'title',c.title,'required',c.is_required,'tiePolicy',c.tie_policy,
  'options',(select jsonb_agg(jsonb_build_object('id',o.id,'displayName',o.display_name) order by o.display_order) from public.options o where o.contest_id=c.id and o.status='active')) order by c.display_order)
 into v_candidates from public.contests c where c.election_id=v_e.id;
 v_hash:=encode(extensions.digest(convert_to(v_rules::text||coalesce(v_candidates::text,''),'UTF8'),'sha256'),'hex');
 update public.elections set status='open',rules_snapshot=v_rules,candidate_snapshot=v_candidates,rules_hash=v_hash,opened_at=now() where id=v_e.id;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(v_e.organization_id,v_e.id,v_user,'user','election.opened','election',v_e.id,jsonb_build_object('rulesHash',v_hash));
 return jsonb_build_object('id',v_e.id,'status','open','rulesHash',v_hash,'openedAt',now());
end;
$$;
