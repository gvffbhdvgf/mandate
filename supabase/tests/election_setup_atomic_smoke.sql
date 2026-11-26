-- Transactional smoke test for the atomic election + contest + options RPC.
begin;
insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_user_meta_data,created_at,updated_at)
values ('66666666-6666-4666-8666-666666666666','authenticated','authenticated','mandate-atomic-election@example.invalid','test-only',now(),'{"display_name":"Atomic Election Test"}',now(),now());
set local role authenticated;
select set_config('request.jwt.claim.sub','66666666-6666-4666-8666-666666666666',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare v_org uuid; v_election uuid;
begin
 v_org:=public.create_organization('Atomic Election Organization','atomic-election-org',null,'Africa/Nairobi');
 v_election:=public.create_election_setup(
  v_org,
  jsonb_build_object('title','Atomic Setup Test','description','Transaction test','voting_mode','registered_single','starts_at',now()+interval '1 hour','ends_at',now()+interval '2 hours','timezone','Africa/Nairobi','result_visibility','private'),
  jsonb_build_array(jsonb_build_object('title','Chairperson','is_required',true,'tie_policy','declared_tie','options',jsonb_build_array(jsonb_build_object('display_name','Candidate A'),jsonb_build_object('display_name','Candidate B'))))
 );
 if (select count(*) from public.elections where id=v_election and status='draft')<>1 then raise exception 'ATOMIC_ELECTION_CREATE_FAILED'; end if;
 if (select count(*) from public.contests where election_id=v_election)<>1 then raise exception 'ATOMIC_CONTEST_CREATE_FAILED'; end if;
 if (select count(*) from public.options where election_id=v_election)<>2 then raise exception 'ATOMIC_OPTION_CREATE_FAILED'; end if;
 if (select count(*) from public.audit_events where election_id=v_election and action in ('election.created','contest.created','option.created'))<>4 then raise exception 'ATOMIC_AUDIT_FAILED'; end if;
 begin
  perform public.create_election_setup(v_org,jsonb_build_object('title','Invalid Atomic Setup','voting_mode','registered_single','starts_at',now()+interval '1 hour','ends_at',now()+interval '2 hours','timezone','Africa/Nairobi','result_visibility','private'),jsonb_build_array(jsonb_build_object('title','Empty Contest','options','[]'::jsonb)));
  raise exception 'EMPTY_CONTEST_OPTIONS_SHOULD_FAIL';
 exception when SQLSTATE '22023' then null;
 end;
 if exists(select 1 from public.elections where title='Invalid Atomic Setup') then raise exception 'FAILED_ATOMIC_ROLLBACK_FOR_INVALID_SETUP'; end if;
 begin
  perform public.create_election_setup(v_org,jsonb_build_object('title','Invalid Empty Contests','voting_mode','registered_single','starts_at',now()+interval '1 hour','ends_at',now()+interval '2 hours','timezone','Africa/Nairobi','result_visibility','private'),'null'::jsonb);
  raise exception 'NULL_CONTESTS_SHOULD_FAIL';
 exception when SQLSTATE '22023' then null;
 end;
end $$;
rollback;
