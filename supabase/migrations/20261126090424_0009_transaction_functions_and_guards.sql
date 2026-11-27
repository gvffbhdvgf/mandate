create or replace function public.create_organization(p_name text,p_slug text,p_contact_email citext default null,p_timezone text default 'Africa/Nairobi')
returns uuid language plpgsql security definer set search_path=pg_catalog
as $$
declare v_user uuid:=auth.uid(); v_org uuid;
begin
 if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if p_name is null or char_length(btrim(p_name)) not between 2 and 160 then raise exception 'INVALID_ORGANIZATION_NAME' using errcode='22023'; end if;
 if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p_slug) not between 3 and 60 then raise exception 'INVALID_ORGANIZATION_SLUG' using errcode='22023'; end if;
 if p_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then raise exception 'INVALID_TIMEZONE' using errcode='22023'; end if;
 insert into public.organizations(name,slug,contact_email,timezone,created_by) values(btrim(p_name),p_slug,p_contact_email,p_timezone,v_user) returning id into v_org;
 insert into public.organization_members(organization_id,user_id,role,status,accepted_at) values(v_org,v_user,'owner','active',now());
 insert into public.audit_events(organization_id,actor_id,actor_type,action,entity_type,entity_id) values(v_org,v_user,'user','organization.created','organization',v_org);
 return v_org;
exception when unique_violation then raise exception 'ORGANIZATION_SLUG_TAKEN' using errcode='23505';
end; $$;

create or replace function public.open_election(p_election_id uuid,p_confirm_rules_snapshot boolean)
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
 select count(*) into v_contest_count from public.contests where election_id=v_e.id;
 if v_contest_count=0 then raise exception 'CONTEST_REQUIRED' using errcode='23514'; end if;
 select count(*) into v_bad_contests from public.contests c where c.election_id=v_e.id and (select count(*) from public.options o where o.contest_id=c.id and o.status='active')<2;
 if v_bad_contests>0 then raise exception 'EACH_CONTEST_REQUIRES_TWO_ACTIVE_OPTIONS' using errcode='23514'; end if;
 if v_e.voting_mode in ('registered_single','registered_weighted') then
  select count(*) into v_voter_count from public.election_voters where election_id=v_e.id and eligibility_status='eligible';
  if v_voter_count=0 then raise exception 'ELIGIBLE_VOTERS_REQUIRED' using errcode='23514'; end if;
 end if;
 if v_e.voting_mode='registered_single' and exists(select 1 from public.election_voters where election_id=v_e.id and weight_units<>1) then raise exception 'SINGLE_VOTE_WEIGHT_MUST_BE_ONE' using errcode='23514'; end if;
 select jsonb_build_object('votingMode',v_e.voting_mode,'startsAt',v_e.starts_at,'endsAt',v_e.ends_at,'timezone',v_e.timezone,'resultVisibility',v_e.result_visibility,'rulesVersion',v_e.rules_version) into v_rules;
 select jsonb_agg(jsonb_build_object('contestId',c.id,'title',c.title,'required',c.is_required,'tiePolicy',c.tie_policy,'options',(select jsonb_agg(jsonb_build_object('id',o.id,'displayName',o.display_name) order by o.display_order) from public.options o where o.contest_id=c.id and o.status='active')) order by c.display_order) into v_candidates from public.contests c where c.election_id=v_e.id;
 v_hash:=encode(extensions.digest(convert_to(v_rules::text||coalesce(v_candidates::text,''),'UTF8'),'sha256'),'hex');
 update public.elections set status='open',rules_snapshot=v_rules,candidate_snapshot=v_candidates,rules_hash=v_hash,opened_at=now() where id=v_e.id;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(v_e.organization_id,v_e.id,v_user,'user','election.opened','election',v_e.id,jsonb_build_object('rulesHash',v_hash));
 return jsonb_build_object('id',v_e.id,'status','open','rulesHash',v_hash,'openedAt',now());
end; $$;

create or replace function public.close_election(p_election_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_user uuid:=auth.uid(); v_e public.elections%rowtype;
begin
 if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if p_reason is null or char_length(btrim(p_reason)) not between 10 and 1000 then raise exception 'CLOSURE_REASON_REQUIRED' using errcode='22023'; end if;
 select * into v_e from public.elections where id=p_election_id for update;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager','returning_officer']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if v_e.status not in ('open','paused') then raise exception 'INVALID_ELECTION_STATE' using errcode='55000'; end if;
 update public.elections set status='closed',closed_at=now() where id=v_e.id;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,reason)
 values(v_e.organization_id,v_e.id,v_user,'user','election.closed','election',v_e.id,btrim(p_reason));
 return jsonb_build_object('id',v_e.id,'status','closed','closedAt',now());
end; $$;

create or replace function public.cast_registered_ballot(p_access_token text,p_contest_id uuid,p_option_id uuid,p_confirmation boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_voter public.election_voters%rowtype; v_e public.elections%rowtype; v_c public.contests%rowtype; v_o public.options%rowtype; v_ballot uuid; v_receipt text;
begin
 if p_access_token is null or char_length(p_access_token)<32 then raise exception 'INVALID_ACCESS_TOKEN' using errcode='22023'; end if;
 if p_confirmation is distinct from true then raise exception 'BALLOT_CONFIRMATION_REQUIRED' using errcode='22023'; end if;
 select * into v_voter from public.election_voters where access_token_hash=encode(extensions.digest(convert_to(p_access_token,'UTF8'),'sha256'),'hex') for update;
 if not found or v_voter.eligibility_status<>'eligible' then raise exception 'VOTER_NOT_ELIGIBLE' using errcode='42501'; end if;
 select * into v_e from public.elections where id=v_voter.election_id for update;
 if not found or v_e.status<>'open' or now()<v_e.starts_at or now()>=v_e.ends_at then raise exception 'ELECTION_NOT_OPEN' using errcode='55000'; end if;
 select * into v_c from public.contests where id=p_contest_id and election_id=v_e.id;
 if not found then raise exception 'CONTEST_NOT_FOUND' using errcode='P0002'; end if;
 select * into v_o from public.options where id=p_option_id and contest_id=v_c.id and status='active';
 if not found then raise exception 'OPTION_NOT_AVAILABLE' using errcode='P0002'; end if;
 v_receipt:=encode(extensions.gen_random_bytes(24),'hex');
 insert into public.ballots(organization_id,election_id,contest_id,option_id,receipt_code,vote_units)
 values(v_e.organization_id,v_e.id,v_c.id,v_o.id,v_receipt,case when v_e.voting_mode='registered_weighted' then v_voter.weight_units else 1 end) returning id into v_ballot;
 insert into public.ballot_submission_controls(election_id,contest_id,voter_id,ballot_id) values(v_e.id,v_c.id,v_voter.id,v_ballot);
 insert into public.audit_events(organization_id,election_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(v_e.organization_id,v_e.id,'system','ballot.accepted','ballot',v_ballot,jsonb_build_object('receiptCode',v_receipt));
 return jsonb_build_object('status','accepted','receiptCode',v_receipt,'castAt',now());
exception when unique_violation then raise exception 'BALLOT_ALREADY_CAST' using errcode='23505';
end; $$;

create or replace function mandate_private.guard_election_snapshot()
returns trigger language plpgsql set search_path=pg_catalog
as $$ begin
 if old.status<>'draft' and (new.rules_snapshot is distinct from old.rules_snapshot or new.candidate_snapshot is distinct from old.candidate_snapshot or new.rules_hash is distinct from old.rules_hash or new.voting_mode is distinct from old.voting_mode or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at) then
  raise exception 'ELECTION_RULES_FROZEN' using errcode='55000';
 end if; return new;
end; $$;
create trigger elections_snapshot_immutable before update on public.elections for each row execute function mandate_private.guard_election_snapshot();
create or replace function mandate_private.guard_ledger_posting()
returns trigger language plpgsql set search_path=pg_catalog
as $$
declare v_debits bigint; v_credits bigint; v_currencies integer;
begin
 if old.status<>'posted' and new.status='posted' then
  select coalesce(sum(amount_minor) filter(where direction='debit'),0),coalesce(sum(amount_minor) filter(where direction='credit'),0),count(distinct currency)
  into v_debits,v_credits,v_currencies from public.ledger_entries where transaction_id=new.id;
  if v_debits<=0 or v_debits<>v_credits or v_currencies<>1 then raise exception 'LEDGER_TRANSACTION_UNBALANCED' using errcode='23514'; end if;
 end if; return new;
end; $$;
create trigger ledger_transactions_balance_before_post before update of status on public.ledger_transactions for each row execute function mandate_private.guard_ledger_posting();
revoke all on function public.create_organization(text,text,extensions.citext,text) from public,anon;
revoke all on function public.open_election(uuid,boolean) from public,anon;
revoke all on function public.close_election(uuid,text) from public,anon;
revoke all on function public.cast_registered_ballot(text,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.create_organization(text,text,extensions.citext,text) to authenticated;
grant execute on function public.open_election(uuid,boolean) to authenticated;
grant execute on function public.close_election(uuid,text) to authenticated;
grant execute on function public.cast_registered_ballot(text,uuid,uuid,boolean) to service_role;
