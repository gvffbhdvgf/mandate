-- Transactional M2 acceptance: resumable drafts, tenant authorization, authority confirmation and immutable opening.
begin;

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_user_meta_data,created_at,updated_at)
values
 ('77777777-7777-4777-8777-777777777777','authenticated','authenticated','mandate-m2-owner@example.invalid','test-only',now(),'{"display_name":"M2 Owner"}',now(),now()),
 ('88888888-8888-4888-8888-888888888888','authenticated','authenticated','mandate-m2-outsider@example.invalid','test-only',now(),'{"display_name":"M2 Outsider"}',now(),now());

create temporary table m2_test_ids(election_id uuid);
grant select,insert,update,delete on m2_test_ids to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',true);
select set_config('request.jwt.claim.role','authenticated',true);

do $$
declare
  v_org uuid;
  v_draft uuid;
  v_invalid_draft uuid;
  v_election uuid;
  v_record jsonb;
  v_audit jsonb;
  v_payload jsonb;
begin
  perform public.create_organization('M2 Draft Organization','m2-draft-org',null,'Africa/Nairobi');
  select id into v_org from public.organizations where slug='m2-draft-org';
  if v_org is null then raise exception 'ORGANIZATION_FIXTURE_NOT_CREATED'; end if;

  -- Duplicate option names are rejected by the atomic setup function.
  begin
    perform public.create_election_setup(v_org,
      jsonb_build_object('title','Duplicate Options','voting_mode','registered_single',
        'starts_at',now()+interval '2 hours','ends_at',now()+interval '3 hours',
        'timezone','Africa/Nairobi','result_visibility','private'),
      jsonb_build_array(jsonb_build_object('title','Contest','options',
        jsonb_build_array(jsonb_build_object('display_name','Candidate A'),jsonb_build_object('display_name','candidate a')))));
    raise exception 'DUPLICATE_OPTION_SHOULD_FAIL';
  exception when SQLSTATE '22023' then
    if sqlerrm<>'DUPLICATE_OPTION_NAME' then raise; end if;
  end;

  -- An incomplete draft cannot be finalized.
  v_invalid_draft:=public.save_election_setup_draft(null,v_org,'{}'::jsonb,1);
  begin
    perform public.finalize_election_setup_draft(v_invalid_draft);
    raise exception 'INCOMPLETE_DRAFT_SHOULD_FAIL';
  exception when SQLSTATE '22023' then
    if sqlerrm<>'ELECTION_DRAFT_INCOMPLETE' then raise; end if;
  end;

  v_payload:=jsonb_build_object(
    'election',jsonb_build_object(
      'title','M2 Resumable Election','description','Draft lifecycle smoke test',
      'voting_mode','registered_single','starts_at',now()-interval '1 minute',
      'ends_at',now()+interval '1 hour','timezone','Africa/Nairobi','result_visibility','private'
    ),
    'participation',jsonb_build_object('eligibility','registered'),
    'contests',jsonb_build_array(jsonb_build_object(
      'title','Chairperson','description','Candidate choice','is_required',true,'tie_policy','declared_tie',
      'options',jsonb_build_array(
        jsonb_build_object('display_name','Candidate A','profile','Profile A'),
        jsonb_build_object('display_name','Candidate B','profile','Profile B')
      )
    ))
  );

  v_draft:=public.save_election_setup_draft(null,v_org,v_payload,2);
  v_record:=public.get_election_setup_draft(v_draft);
  if v_record->>'currentStep'<>'2' or v_record->>'status'<>'draft' then
    raise exception 'DRAFT_NOT_RESUMABLE';
  end if;
  if (select count(*) from public.list_election_setup_drafts(v_org) where id=v_draft)<>1 then
    raise exception 'DRAFT_NOT_LISTED';
  end if;

  begin
    perform public.save_election_setup_draft(v_draft,v_org,'[]'::jsonb,3);
    raise exception 'NON_OBJECT_DRAFT_SHOULD_FAIL';
  exception when SQLSTATE '22023' then
    if sqlerrm<>'INVALID_ELECTION_DRAFT' then raise; end if;
  end;

  perform set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',true);
  begin
    perform public.save_election_setup_draft(v_draft,v_org,v_payload,3);
    raise exception 'UNAUTHORIZED_DRAFT_EDIT_SHOULD_FAIL';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',true);

  v_election:=public.finalize_election_setup_draft(v_draft);
  if (select status from public.election_setup_drafts where id=v_draft)<>'finalized' then
    raise exception 'DRAFT_FINALIZATION_FAILED';
  end if;
  if (select count(*) from public.contests where election_id=v_election)<>1
    or (select count(*) from public.options where election_id=v_election)<>2 then
    raise exception 'FINALIZED_CONFIGURATION_INCOMPLETE';
  end if;

  begin
    perform public.open_election(v_election,true);
    raise exception 'UNCONFIRMED_SETUP_MUST_NOT_OPEN';
  exception when SQLSTATE '55000' then
    if sqlerrm<>'ELECTION_SETUP_NOT_CONFIRMED' then raise; end if;
  end;

  perform public.confirm_election_setup(v_election);
  if not exists(select 1 from public.elections where id=v_election
    and setup_confirmed_at is not null
    and setup_confirmed_by='77777777-7777-4777-8777-777777777777'
    and setup_confirmation_hash ~ '^[0-9a-f]{64}$') then
    raise exception 'AUTHORITY_CONFIRMATION_NOT_RECORDED';
  end if;
  v_audit:=public.get_election_audit_trail(v_election,50);
  if not exists(select 1 from jsonb_array_elements(v_audit->'events') as event_row(event_data)
    where event_data->>'action'='election.setup_confirmed') then
    raise exception 'AUTHORITY_CONFIRMATION_NOT_AUDITED';
  end if;
  insert into m2_test_ids(election_id) values(v_election);
end $$;

reset role;
-- A candidate-profile change after confirmation invalidates the stored hash and requires a fresh authority check.
update public.options set profile='Profile A revised'
where election_id=(select election_id from m2_test_ids) and display_name='Candidate A';
set local role authenticated;
select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',true);
do $$
declare v_election uuid;
begin
  select election_id into v_election from m2_test_ids;
  begin
    perform public.open_election(v_election,true);
    raise exception 'CONFIGURATION_DRIFT_MUST_REQUIRE_RECONFIRMATION';
  exception when SQLSTATE '55000' then
    if sqlerrm<>'ELECTION_SETUP_CHANGED_RECONFIRM' then raise; end if;
  end;
  perform public.confirm_election_setup(v_election);
end $$;

reset role;
update public.elections set status='open' where id=(select election_id from m2_test_ids);
set local role authenticated;
select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',true);
do $$
declare v_election uuid;
begin
  select election_id into v_election from m2_test_ids;
  begin
    perform public.create_contest(v_election,'Late Contest',null,true,1,'declared_tie'::public.tie_policy);
    raise exception 'CONFIGURATION_FREEZE_SHOULD_FAIL';
  exception when SQLSTATE '55000' then
    if sqlerrm<>'ELECTION_CONFIGURATION_FROZEN' then raise; end if;
  end;

  if (select prosecdef from pg_proc where oid='public.save_election_setup_draft(uuid,uuid,jsonb,integer)'::regprocedure)
    or (select prosecdef from pg_proc where oid='public.get_election_setup_draft(uuid)'::regprocedure)
    or (select prosecdef from pg_proc where oid='public.finalize_election_setup_draft(uuid)'::regprocedure)
    or (select prosecdef from pg_proc where oid='public.confirm_election_setup(uuid)'::regprocedure)
    or (select prosecdef from pg_proc where oid='public.list_election_setup_drafts(uuid)'::regprocedure) then
    raise exception 'PUBLIC_RPC_WRAPPER_MUST_BE_SECURITY_INVOKER';
  end if;
  if not (select prosecdef from pg_proc where oid='mandate_private.get_election_setup_draft(uuid)'::regprocedure)
    or not (select prosecdef from pg_proc where oid='mandate_private.finalize_election_setup_draft(uuid)'::regprocedure)
    or not (select prosecdef from pg_proc where oid='mandate_private.confirm_election_setup(uuid)'::regprocedure)
    or not (select prosecdef from pg_proc where oid='mandate_private.list_election_setup_drafts(uuid)'::regprocedure) then
    raise exception 'PRIVATE_RPC_IMPLEMENTATION_MUST_BE_SECURITY_DEFINER';
  end if;
  if has_table_privilege('anon','public.election_setup_drafts','SELECT')
    or has_table_privilege('authenticated','public.election_setup_drafts','SELECT') then
    raise exception 'DRAFT_TABLE_MUST_NOT_BE_DIRECTLY_READABLE';
  end if;
  if has_function_privilege('anon','public.finalize_election_setup_draft(uuid)','EXECUTE') then
    raise exception 'ANON_MUST_NOT_FINALIZE_ELECTION_DRAFTS';
  end if;
end $$;

rollback;
