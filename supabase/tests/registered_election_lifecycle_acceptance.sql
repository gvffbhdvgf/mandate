-- Full registered-election lifecycle acceptance test.
-- Synthetic auth user and election only; transaction always rolls back.
-- Run in a rollback-only transaction; use only synthetic fixtures.
begin;

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_user_meta_data,created_at,updated_at)
values ('99999999-9999-4999-8999-999999999999','authenticated','authenticated',
        'mandate-lifecycle-test@example.invalid','test-only',now(),
        '{"display_name":"Lifecycle Test"}',now(),now());

set local role authenticated;
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',true);
select set_config('request.jwt.claim.role','authenticated',true);

do $$
declare
  v_org uuid;
  v_election uuid;
  v_contest uuid;
  v_option uuid;
  v_token constant text := 'lifecycle-test-token-1234567890-abcdefghijklmnopqrstuvwxyz';
  v_open jsonb;
  v_confirmed jsonb;
  v_paused jsonb;
  v_resumed jsonb;
  v_closed jsonb;
  v_tally jsonb;
  v_published jsonb;
  v_report_audit jsonb;
  v_duplicate_rejected boolean := false;
  v_paused_context_rejected boolean := false;
begin
  v_org := public.create_organization('Lifecycle Test Organization','lifecycle-test-org',null,'Africa/Nairobi');
  v_election := public.create_election_setup(
    v_org,
    jsonb_build_object(
      'title','Lifecycle Acceptance Election',
      'voting_mode','registered_single',
      'starts_at',now()-interval '1 minute',
      'ends_at',now()+interval '2 hours',
      'timezone','Africa/Nairobi',
      'result_visibility','public'
    ),
    jsonb_build_array(jsonb_build_object(
      'title','Chairperson',
      'options',jsonb_build_array(
        jsonb_build_object('display_name','Candidate A'),
        jsonb_build_object('display_name','Candidate B')
      )
    ))
  );
  select id into v_contest from public.contests where election_id=v_election;
  select id into v_option from public.options where contest_id=v_contest and display_name='Candidate A';

  -- Voter-register writes are service-controlled; switch out of the authenticated role
  -- only for this synthetic fixture, then restore the actor claims for lifecycle RPCs.
  reset role;
  insert into public.election_voters(
    organization_id,election_id,external_voter_ref,display_name,normalized_email,
    phone_e164,access_token_hash,invited_at
  ) values (
    v_org,v_election,'LIFECYCLE-1','Lifecycle Voter','lifecycle-voter@example.invalid',
    '+254700000001',
    encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex'),now()
  );

  set local role authenticated;
  v_confirmed := public.confirm_election_setup(v_election);
  if v_confirmed->>'electionId' <> v_election::text then
    raise exception 'SETUP_AUTHORITY_CONFIRMATION_FAILED: %', v_confirmed;
  end if;
  v_open := public.open_election(v_election,true);
  if v_open->>'status' <> 'open' then raise exception 'OPEN_TRANSITION_FAILED'; end if;

  -- Ballot context and cast are called with the same anonymous role as a voter.
  set local role anon;
  if public.get_registered_ballot_context(v_token)->'election'->>'title'
      <> 'Lifecycle Acceptance Election' then
    raise exception 'BALLOT_CONTEXT_FAILED';
  end if;
  if public.cast_registered_ballot(v_token,v_contest,v_option,true)->>'status' <> 'accepted' then
    raise exception 'BALLOT_CAST_FAILED';
  end if;

  begin
    perform public.cast_registered_ballot(v_token,v_contest,v_option,true);
  exception when unique_violation then
    v_duplicate_rejected := sqlerrm = 'BALLOT_ALREADY_CAST';
  end;
  if not v_duplicate_rejected then raise exception 'DUPLICATE_CAST_NOT_REJECTED'; end if;

  reset role;
  set local role authenticated;
  v_paused := public.pause_election(v_election,'Acceptance test pause reason');
  if v_paused->>'status' <> 'paused' then raise exception 'PAUSE_TRANSITION_FAILED'; end if;

  set local role anon;
  begin
    perform public.get_registered_ballot_context(v_token);
  exception when sqlstate '55000' then
    v_paused_context_rejected := sqlerrm = 'ELECTION_NOT_OPEN';
  end;
  if not v_paused_context_rejected then raise exception 'PAUSED_ELECTION_STILL_SERVES_BALLOT_CONTEXT'; end if;

  reset role;
  set local role authenticated;
  v_resumed := public.resume_election(v_election,'Acceptance test resume reason');
  if v_resumed->>'status' <> 'open' then raise exception 'RESUME_TRANSITION_FAILED'; end if;

  v_closed := public.close_election(v_election,'Acceptance test closure reason');
  if v_closed->>'status' <> 'closed' then raise exception 'CLOSE_TRANSITION_FAILED'; end if;

  v_tally := public.tally_and_reconcile(v_election);
  if v_tally->>'status' <> 'reconciled'
     or (v_tally->>'eligibleVoters')::integer <> 1
     or (v_tally->>'participatingVoters')::integer <> 1
     or (v_tally->>'acceptedBallots')::integer <> 1 then
    raise exception 'TALLY_RECONCILIATION_FAILED: %',v_tally;
  end if;

  v_published := public.publish_results(v_election);
  if v_published->>'status' <> 'results_published' then raise exception 'PUBLISH_TRANSITION_FAILED'; end if;

  set local role anon;
  v_published := public.get_published_results(v_election);
  if v_published->'tally'->>'acceptedBallots' <> '1'
     or v_published->'contests'->0->'options'->0->>'name' <> 'Candidate A'
     or (v_published->'contests'->0->'options'->0->>'isWinner')::boolean is not true then
    raise exception 'PUBLIC_RESULTS_ASSERTION_FAILED: %',v_published;
  end if;

  reset role;
  set local role authenticated;
  perform public.record_results_export(v_election,'csv');
  perform public.record_results_export(v_election,'pdf');
  v_report_audit := public.get_election_audit_trail(v_election,50);
  if not (v_report_audit->'events' @> '[{"action":"election.results.exported","metadata":{"format":"pdf"}}]'::jsonb) then
    raise exception 'RESULTS_EXPORT_AUDIT_NOT_VISIBLE: %',v_report_audit;
  end if;

  reset role;
  if (select count(*) from public.audit_events
      where election_id=v_election
        and action in ('election.opened','ballot.accepted','election.paused',
                       'election.resumed','election.closed','election.tallied',
                       'election.results_published','election.results.exported')) <> 9 then
    raise exception 'LIFECYCLE_AUDIT_TRAIL_INCOMPLETE';
  end if;
end $$;

rollback;
