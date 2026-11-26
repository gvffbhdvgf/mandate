create or replace function mandate_private.get_registered_ballot_context(p_access_token text)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_voter public.election_voters%rowtype; v_e public.elections%rowtype; v_contests jsonb;
begin
 if p_access_token is null or char_length(p_access_token)<32 or char_length(p_access_token)>128 then raise exception 'INVALID_ACCESS_TOKEN' using errcode='22023'; end if;
 select * into v_voter from public.election_voters where access_token_hash=encode(extensions.digest(convert_to(p_access_token,'UTF8'),'sha256'),'hex')
 and eligibility_status='eligible' and invited_at is not null;
 if not found then raise exception 'VOTER_ACCESS_INVALID' using errcode='42501'; end if;
 select * into v_e from public.elections where id=v_voter.election_id;
 if not found or v_e.status<>'open' or now()<v_e.starts_at or now()>=v_e.ends_at then raise exception 'ELECTION_NOT_OPEN' using errcode='55000'; end if;
 select jsonb_agg(jsonb_build_object(
  'id',(item.contest->>'contestId')::uuid,'title',item.contest->>'title',
  'required',coalesce((item.contest->>'required')::boolean,true),
  'tiePolicy',item.contest->>'tiePolicy','options',coalesce(item.contest->'options','[]'::jsonb),
  'alreadyVoted',exists(select 1 from public.ballot_submission_controls x where x.voter_id=v_voter.id and x.contest_id=(item.contest->>'contestId')::uuid)
 ) order by item.ordinality) into v_contests
 from jsonb_array_elements(coalesce(v_e.candidate_snapshot,'[]'::jsonb)) with ordinality as item(contest,ordinality);
 return jsonb_build_object('election',jsonb_build_object('id',v_e.id,'title',v_e.title,'endsAt',v_e.ends_at,'timezone',v_e.timezone,'votingMode',v_e.voting_mode),
  'voteUnits',case when v_e.voting_mode='registered_weighted' then v_voter.weight_units else 1 end,'contests',coalesce(v_contests,'[]'::jsonb));
end;
$$;
