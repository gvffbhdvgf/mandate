-- Transactional smoke test for private CSV object access and voter-register staging/commit.
begin;
insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_user_meta_data,created_at,updated_at)
values
 ('77777777-7777-4777-8777-777777777777','authenticated','authenticated','mandate-import-test@example.invalid','test-only',now(),'{"display_name":"Import Test"}',now(),now());
set local role authenticated;
select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',true);
select set_config('request.jwt.claim.role','authenticated',true);

do $$
declare v_org uuid; v_election uuid; v_batch uuid; v_path text; v_result jsonb; v_file uuid;
begin
 v_org:=public.create_organization('Import Test Organization','import-test-org',null,'Africa/Nairobi');
 v_election:=public.create_election_setup(v_org,
  jsonb_build_object('title','Import Test Election','voting_mode','registered_single','starts_at',now()-interval '1 minute','ends_at',now()+interval '2 hours','timezone','Africa/Nairobi','result_visibility','private'),
  jsonb_build_array(jsonb_build_object('title','Chairperson','options',jsonb_build_array(jsonb_build_object('display_name','A'),jsonb_build_object('display_name','B')))));
 v_batch:=gen_random_uuid();
 v_path:=v_org::text||'/'||v_election::text||'/'||v_batch::text||'.csv';
 insert into storage.objects(bucket_id,name,metadata) values('mandate-voter-imports',v_path,'{"mimetype":"text/csv","size":200}') returning id into v_file;
 v_result:=public.stage_voter_import(v_election,v_path,'voters.csv',jsonb_build_array(
  jsonb_build_object('external_voter_ref','V001','display_name','Voter One','normalized_email','one@example.com','phone_e164','+254712345678','weight_units',1),
  jsonb_build_object('external_voter_ref','V002','display_name','Voter Two','normalized_email','two@example.com','phone_e164','+254712345679','weight_units',1)
 ));
 if v_result->>'status'<>'validated' or (v_result->>'acceptedRows')::int<>2 then raise exception 'VOTER_IMPORT_STAGE_FAILED'; end if;
 v_batch:=(v_result->>'batchId')::uuid;
 v_result:=public.commit_voter_import(v_batch);
 if v_result->>'status'<>'committed' or (v_result->>'importedRows')::int<>2 then raise exception 'VOTER_IMPORT_COMMIT_FAILED'; end if;
 if (select count(*) from public.election_voters where election_id=v_election)<>2 then raise exception 'VOTER_REGISTER_COUNT_FAILED'; end if;
 if (select count(*) from public.import_batches where id=v_batch and status='committed')<>1 then raise exception 'IMPORT_BATCH_STATUS_FAILED'; end if;
 if (select count(*) from public.import_rows where batch_id=v_batch and status='committed')<>2 then raise exception 'IMPORT_ROWS_STATUS_FAILED'; end if;
 begin
  perform public.open_election(v_election,true);
  raise exception 'ELECTION_OPEN_WITHOUT_VOTER_ACCESS_SHOULD_FAIL';
 exception when SQLSTATE '55000' then
  if sqlerrm<>'VOTER_ACCESS_NOT_ISSUED' then raise; end if;
 end;
 if (select status from public.elections where id=v_election)<>'draft' then raise exception 'ELECTION_STATE_CHANGED_WITHOUT_VOTER_ACCESS'; end if;

end $$;
rollback;
