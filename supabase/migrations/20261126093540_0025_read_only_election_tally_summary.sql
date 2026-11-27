create or replace function mandate_private.get_tally_summary(p_election_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_e public.elections%rowtype; v_t public.election_tallies%rowtype;
begin
 if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 select * into v_e from public.elections where id=p_election_id;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager','returning_officer']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into v_t from public.election_tallies where election_id=v_e.id;
 if not found then return jsonb_build_object('status','not_tallied','electionStatus',v_e.status); end if;
 return jsonb_build_object('status','reconciled','electionStatus',v_e.status,'tallyId',v_t.id,
  'eligibleVoters',v_t.eligible_voter_count,'participatingVoters',v_t.participating_voter_count,
  'acceptedBallots',v_t.accepted_ballot_count,'invalidatedBallots',v_t.invalidated_ballot_count,
  'totalVoteUnits',v_t.total_vote_units,'requiresResolution',v_t.requires_resolution,'reconciledAt',v_t.reconciled_at);
end; $$;
revoke all on function mandate_private.get_tally_summary(uuid) from public,anon;
grant execute on function mandate_private.get_tally_summary(uuid) to authenticated;
create function public.get_tally_summary(p_election_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.get_tally_summary($1); $$;
revoke all on function public.get_tally_summary(uuid) from public,anon;
grant execute on function public.get_tally_summary(uuid) to authenticated;
