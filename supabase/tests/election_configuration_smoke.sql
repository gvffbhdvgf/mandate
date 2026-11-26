-- Transactional smoke test for election, contest and candidate setup RPCs.
begin;
insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_user_meta_data,created_at,updated_at)
values
 ('44444444-4444-4444-8444-444444444444','authenticated','authenticated','mandate-election-one@example.invalid','test-only',now(),'{"display_name":"Election Test One"}',now(),now()),
 ('55555555-5555-4555-8555-555555555555','authenticated','authenticated','mandate-election-two@example.invalid','test-only',now(),'{"display_name":"Election Test Two"}',now(),now());
set local role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare v_org uuid; v_election uuid; v_contest uuid;
begin
 v_org:=public.create_organization('Election Test Organization','election-test-org',null,'Africa/Nairobi');
 v_election:=public.create_election(v_org,'Test Election','Test description','registered_single'::public.voting_mode,now()+interval '1 hour',now()+interval '2 hours','Africa/Nairobi','private');
 v_contest:=public.create_contest(v_election,'Chairperson',null,true,0,'declared_tie'::public.tie_policy);
 perform public.create_option(v_election,v_contest,'Candidate One',null,0);
 perform public.create_option(v_election,v_contest,'Candidate Two',null,1);
 if (select count(*) from public.contests where election_id=v_election)<>1 then raise exception 'CONTEST_CREATION_FAILED'; end if;
 if (select count(*) from public.options where election_id=v_election)<>2 then raise exception 'OPTION_CREATION_FAILED'; end if;
 if (select count(*) from public.audit_events where election_id=v_election and action in ('election.created','contest.created','option.created'))<>4 then raise exception 'CONFIGURATION_AUDIT_FAILED'; end if;
 perform set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',true);
 begin
  perform public.create_election(v_org,'Cross Tenant Attempt',null,'registered_single'::public.voting_mode,now()+interval '1 hour',now()+interval '2 hours','Africa/Nairobi','private');
  raise exception 'CROSS_TENANT_CREATE_SHOULD_FAIL';
 exception when insufficient_privilege then null;
 end;
 begin
  perform public.create_election(v_org,'Paid Mode Attempt',null,'public_paid'::public.voting_mode,now()+interval '1 hour',now()+interval '2 hours','Africa/Nairobi','private');
  raise exception 'PAID_VOTING_SHOULD_BE_GATED';
 exception when SQLSTATE '55000' then null;
 end;
end $$;
rollback;
