-- Context endpoint smoke test. This does not cast a ballot; all synthetic rows roll back.
begin;
insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_user_meta_data,created_at,updated_at)
values ('99999999-9999-4999-8999-999999999999','authenticated','authenticated','mandate-ballot-test@example.invalid','test-only',now(),'{"display_name":"Ballot Test"}',now(),now());
set local role authenticated;
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare v_org uuid; v_election uuid; v_contest uuid; v_option uuid;
begin
 v_org:=public.create_organization('Ballot Test Organization','ballot-test-org',null,'Africa/Nairobi');
 v_election:=public.create_election_setup(v_org,
  jsonb_build_object('title','Ballot Test Election','voting_mode','registered_single','starts_at',now()-interval '1 minute','ends_at',now()+interval '2 hours','timezone','Africa/Nairobi','result_visibility','private'),
  jsonb_build_array(jsonb_build_object('title','Chairperson','options',jsonb_build_array(jsonb_build_object('display_name','Candidate A'),jsonb_build_object('display_name','Candidate B')))));
 select id into v_contest from public.contests where election_id=v_election;
 select id into v_option from public.options where contest_id=v_contest and display_name='Candidate A';
 -- Opening now requires explicit authority confirmation bound to the setup hash.
 perform public.confirm_election_setup(v_election);
 perform set_config('test.org_id',v_org::text,true);
 perform set_config('test.election_id',v_election::text,true);
 perform set_config('test.contest_id',v_contest::text,true);
 perform set_config('test.option_id',v_option::text,true);
end $$;
reset role;
insert into public.election_voters(organization_id,election_id,external_voter_ref,display_name,normalized_email,phone_e164,access_token_hash,invited_at)
values(current_setting('test.org_id')::uuid,current_setting('test.election_id')::uuid,'VOTER-1','Ballot Test Voter','ballot-voter@example.invalid','+254712345678',
 encode(extensions.digest(convert_to('secret-test-token-1234567890-abcdefghijklmnopqrstuvwxyz','UTF8'),'sha256'),'hex'),now());
set local role authenticated;
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',true);
select public.open_election(current_setting('test.election_id')::uuid,true);
set local role anon;
do $$
declare v_context jsonb;
begin
 v_context:=public.get_registered_ballot_context('secret-test-token-1234567890-abcdefghijklmnopqrstuvwxyz');
 if v_context->'election'->>'title'<>'Ballot Test Election' then raise exception 'BALLOT_CONTEXT_ELECTION_MISSING'; end if;
 if v_context::text ilike '%email%' or v_context::text ilike '%external_voter_ref%' or v_context::text ilike '%voterId%' then raise exception 'BALLOT_CONTEXT_LEAKS_VOTER_IDENTITY'; end if;
 if jsonb_array_length(v_context->'contests')<>1 then raise exception 'BALLOT_CONTEXT_CONTEST_MISSING'; end if;
 if (v_context->'contests'->0->>'alreadyVoted')::boolean then raise exception 'BALLOT_ALREADY_VOTED_TOO_EARLY'; end if;
 if has_table_privilege('anon','public.ballots','SELECT') then raise exception 'ANON_BALLOT_READ_SHOULD_BE_DENIED'; end if;
end $$;
rollback;
