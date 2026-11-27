create or replace function mandate_private.get_registered_ballot_context(p_access_token text)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_voter public.election_voters%rowtype; v_e public.elections%rowtype; v_contests jsonb;
begin
 if p_access_token is null or char_length(p_access_token)<32 or char_length(p_access_token)>128 then raise exception 'INVALID_ACCESS_TOKEN' using errcode='22023'; end if;
 select * into v_voter from public.election_voters
 where access_token_hash=encode(extensions.digest(convert_to(p_access_token,'UTF8'),'sha256'),'hex')
 and eligibility_status='eligible' and invited_at is not null;
 if not found then raise exception 'VOTER_ACCESS_INVALID' using errcode='42501'; end if;
 select * into v_e from public.elections where id=v_voter.election_id;
 if not found or v_e.status<>'open' or now()<v_e.starts_at or now()>=v_e.ends_at then raise exception 'ELECTION_NOT_OPEN' using errcode='55000'; end if;
 select jsonb_agg(jsonb_build_object(
  'id',(c->>'contestId')::uuid,'title',c->>'title','required',coalesce((c->>'required')::boolean,true),
  'tiePolicy',c->>'tiePolicy','options',coalesce(c->'options','[]'::jsonb),
  'alreadyVoted',exists(select 1 from public.ballot_submission_controls x where x.voter_id=v_voter.id and x.contest_id=(c->>'contestId')::uuid)
 ) order by (c->>'contestId')) into v_contests
 from jsonb_array_elements(coalesce(v_e.candidate_snapshot,'[]'::jsonb)) c;
 return jsonb_build_object(
  'election',jsonb_build_object('id',v_e.id,'title',v_e.title,'endsAt',v_e.ends_at,'timezone',v_e.timezone,'votingMode',v_e.voting_mode),
  'voteUnits',case when v_e.voting_mode='registered_weighted' then v_voter.weight_units else 1 end,
  'contests',coalesce(v_contests,'[]'::jsonb)
 );
end; $$;

create or replace function mandate_private.cast_registered_ballot(p_access_token text,p_contest_id uuid,p_option_id uuid,p_confirmation boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_voter public.election_voters%rowtype; v_e public.elections%rowtype; v_c public.contests%rowtype; v_o public.options%rowtype; v_ballot uuid; v_receipt text;
begin
 if p_access_token is null or char_length(p_access_token)<32 or char_length(p_access_token)>128 then raise exception 'INVALID_ACCESS_TOKEN' using errcode='22023'; end if;
 if p_confirmation is distinct from true then raise exception 'BALLOT_CONFIRMATION_REQUIRED' using errcode='22023'; end if;
 select * into v_voter from public.election_voters where access_token_hash=encode(extensions.digest(convert_to(p_access_token,'UTF8'),'sha256'),'hex') for update;
 if not found or v_voter.eligibility_status<>'eligible' or v_voter.invited_at is null then raise exception 'VOTER_NOT_ELIGIBLE' using errcode='42501'; end if;
 select * into v_e from public.elections where id=v_voter.election_id for update;
 if not found or v_e.status<>'open' or now()<v_e.starts_at or now()>=v_e.ends_at then raise exception 'ELECTION_NOT_OPEN' using errcode='55000'; end if;
 select * into v_c from public.contests where id=p_contest_id and election_id=v_e.id;
 if not found then raise exception 'CONTEST_NOT_FOUND' using errcode='P0002'; end if;
 if not exists(select 1 from jsonb_array_elements(coalesce(v_e.candidate_snapshot,'[]'::jsonb)) c where (c->>'contestId')::uuid=v_c.id) then raise exception 'CONTEST_NOT_IN_FROZEN_SNAPSHOT' using errcode='55000'; end if;
 select * into v_o from public.options where id=p_option_id and contest_id=v_c.id and status='active';
 if not found then raise exception 'OPTION_NOT_AVAILABLE' using errcode='P0002'; end if;
 if not exists(select 1 from jsonb_array_elements(coalesce(v_e.candidate_snapshot,'[]'::jsonb)) c cross join lateral jsonb_array_elements(coalesce(c->'options','[]'::jsonb)) o
  where (c->>'contestId')::uuid=v_c.id and (o->>'id')::uuid=v_o.id) then raise exception 'OPTION_NOT_IN_FROZEN_SNAPSHOT' using errcode='55000'; end if;
 v_receipt:=encode(extensions.gen_random_bytes(24),'hex');
 insert into public.ballots(organization_id,election_id,contest_id,option_id,receipt_code,vote_units)
 values(v_e.organization_id,v_e.id,v_c.id,v_o.id,v_receipt,case when v_e.voting_mode='registered_weighted' then v_voter.weight_units else 1 end)
 returning id into v_ballot;
 insert into public.ballot_submission_controls(election_id,contest_id,voter_id,ballot_id) values(v_e.id,v_c.id,v_voter.id,v_ballot);
 insert into public.audit_events(organization_id,election_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(v_e.organization_id,v_e.id,'system','ballot.accepted','ballot',v_ballot,jsonb_build_object('receiptCode',v_receipt));
 return jsonb_build_object('status','accepted','receiptCode',v_receipt,'castAt',now());
exception when unique_violation then raise exception 'BALLOT_ALREADY_CAST' using errcode='23505';
end; $$;

revoke all on function mandate_private.get_registered_ballot_context(text) from public;
revoke all on function mandate_private.cast_registered_ballot(text,uuid,uuid,boolean) from public;
grant usage on schema mandate_private to anon;
grant execute on function mandate_private.get_registered_ballot_context(text) to anon,authenticated;
grant execute on function mandate_private.cast_registered_ballot(text,uuid,uuid,boolean) to anon,authenticated,service_role;

create function public.get_registered_ballot_context(p_access_token text)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.get_registered_ballot_context($1); $$;
create function public.cast_registered_ballot(p_access_token text,p_contest_id uuid,p_option_id uuid,p_confirmation boolean)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.cast_registered_ballot($1,$2,$3,$4); $$;
revoke all on function public.get_registered_ballot_context(text) from public;
revoke all on function public.cast_registered_ballot(text,uuid,uuid,boolean) from public;
grant execute on function public.get_registered_ballot_context(text) to anon,authenticated;
grant execute on function public.cast_registered_ballot(text,uuid,uuid,boolean) to anon,authenticated;
