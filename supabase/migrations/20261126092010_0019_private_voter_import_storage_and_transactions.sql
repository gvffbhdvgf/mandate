insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('mandate-voter-imports','mandate-voter-imports',false,10485760,array['text/csv','application/vnd.ms-excel','application/csv'])
on conflict (id) do update set public=false,file_size_limit=10485760,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists mandate_voter_import_upload on storage.objects;
drop policy if exists mandate_voter_import_read on storage.objects;
drop policy if exists mandate_voter_import_delete on storage.objects;

create policy mandate_voter_import_upload on storage.objects for insert to authenticated
with check (
 bucket_id='mandate-voter-imports'
 and name ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.csv$'
 and split_part(name,'/',1)::uuid=(select e.organization_id from public.elections e where e.id=split_part(name,'/',2)::uuid)
 and mandate_private.can_manage_election(split_part(name,'/',2)::uuid,array['owner','admin','election_manager']::public.organization_role[])
);
create policy mandate_voter_import_read on storage.objects for select to authenticated
using (
 bucket_id='mandate-voter-imports'
 and name ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.csv$'
 and split_part(name,'/',1)::uuid=(select e.organization_id from public.elections e where e.id=split_part(name,'/',2)::uuid)
 and mandate_private.can_manage_election(split_part(name,'/',2)::uuid,array['owner','admin','election_manager','returning_officer']::public.organization_role[])
);
create policy mandate_voter_import_delete on storage.objects for delete to authenticated
using (
 bucket_id='mandate-voter-imports'
 and name ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.csv$'
 and split_part(name,'/',1)::uuid=(select e.organization_id from public.elections e where e.id=split_part(name,'/',2)::uuid)
 and mandate_private.can_manage_election(split_part(name,'/',2)::uuid,array['owner','admin','election_manager']::public.organization_role[])
);

create or replace function mandate_private.stage_voter_import(p_election_id uuid,p_private_object_path text,p_original_filename text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare
 v_user uuid:=auth.uid(); v_e public.elections%rowtype; v_batch uuid;
 v_row jsonb; v_ref text; v_name text; v_email text; v_phone text; v_weight bigint;
 v_count integer; v_i integer:=0;
begin
 if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if coalesce(jsonb_typeof(p_rows),'null')<>'array' then raise exception 'INVALID_IMPORT_ROWS' using errcode='22023'; end if;
 v_count:=jsonb_array_length(p_rows);
 if v_count<1 or v_count>25000 then raise exception 'IMPORT_ROW_LIMIT_EXCEEDED' using errcode='22023'; end if;
 if p_original_filename is null or char_length(p_original_filename)>255 or lower(p_original_filename) not like '%.csv' then raise exception 'INVALID_IMPORT_FILENAME' using errcode='22023'; end if;
 select * into v_e from public.elections where id=p_election_id for update;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if v_e.status<>'draft' then raise exception 'ELECTION_REGISTER_FROZEN' using errcode='55000'; end if;
 if v_e.voting_mode='public_paid' then raise exception 'PAID_VOTING_FEATURE_GATED' using errcode='55000'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_private_object_path is null or p_private_object_path !~* ('^'||v_e.organization_id::text||'/'||v_e.id::text||'/[0-9a-f-]{36}\.csv$') then raise exception 'INVALID_IMPORT_OBJECT_PATH' using errcode='22023'; end if;
 if not exists(select 1 from storage.objects where bucket_id='mandate-voter-imports' and name=p_private_object_path) then raise exception 'IMPORT_FILE_NOT_FOUND' using errcode='P0002'; end if;
 insert into public.import_batches(organization_id,election_id,uploaded_by,private_object_path,original_filename,status,total_rows)
 values(v_e.organization_id,v_e.id,v_user,p_private_object_path,p_original_filename,'validating',v_count) returning id into v_batch;
 for v_row in select value from jsonb_array_elements(p_rows)
 loop
  v_i:=v_i+1;
  if coalesce(jsonb_typeof(v_row),'null')<>'object' then raise exception 'INVALID_IMPORT_ROW_%',v_i using errcode='22023'; end if;
  v_ref:=nullif(btrim(v_row->>'external_voter_ref'),'');
  v_name:=nullif(btrim(v_row->>'display_name'),'');
  v_email:=nullif(lower(btrim(coalesce(v_row->>'normalized_email',''))),'');
  v_phone:=nullif(btrim(coalesce(v_row->>'phone_e164','')),'');
  v_weight:=coalesce(nullif(v_row->>'weight_units','')::bigint,1);
  if v_ref is null or char_length(v_ref)>200 then raise exception 'INVALID_VOTER_REFERENCE_ROW_%',v_i using errcode='22023'; end if;
  if v_name is null or char_length(v_name)>200 then raise exception 'INVALID_VOTER_NAME_ROW_%',v_i using errcode='22023'; end if;
  if v_email is not null and v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'INVALID_VOTER_EMAIL_ROW_%',v_i using errcode='22023'; end if;
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'INVALID_VOTER_PHONE_ROW_%',v_i using errcode='22023'; end if;
  if v_email is null and v_phone is null then raise exception 'VOTER_CONTACT_REQUIRED_ROW_%',v_i using errcode='22023'; end if;
  if v_weight<1 or v_weight>1000000 or (v_e.voting_mode='registered_single' and v_weight<>1) then raise exception 'INVALID_VOTER_WEIGHT_ROW_%',v_i using errcode='22023'; end if;
  if exists(select 1 from public.election_voters x where x.election_id=v_e.id and (x.external_voter_ref=v_ref or (v_email is not null and x.normalized_email=v_email))) then raise exception 'VOTER_ALREADY_REGISTERED_ROW_%',v_i using errcode='23505'; end if;
  if exists(select 1 from public.import_rows x where x.batch_id=v_batch and (x.normalized_data->>'external_voter_ref'=v_ref or (v_email is not null and x.normalized_data->>'normalized_email'=v_email))) then raise exception 'DUPLICATE_VOTER_IN_IMPORT_ROW_%',v_i using errcode='23505'; end if;
  insert into public.import_rows(batch_id,row_number,normalized_data,status)
  values(v_batch,v_i,jsonb_build_object('external_voter_ref',v_ref,'display_name',v_name,'normalized_email',v_email,'phone_e164',v_phone,'weight_units',v_weight),'accepted');
 end loop;
 update public.import_batches set status='validated',accepted_rows=v_count,rejected_rows=0 where id=v_batch;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(v_e.organization_id,v_e.id,v_user,'user','voter_import.validated','import_batch',v_batch,jsonb_build_object('totalRows',v_count));
 return jsonb_build_object('batchId',v_batch,'status','validated','totalRows',v_count,'acceptedRows',v_count,'rejectedRows',0);
end; $$;

create or replace function mandate_private.commit_voter_import(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_user uuid:=auth.uid(); v_b public.import_batches%rowtype; v_e public.elections%rowtype; v_inserted integer;
begin
 if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 select * into v_b from public.import_batches where id=p_batch_id for update;
 if not found then raise exception 'IMPORT_BATCH_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_b.organization_id,array['owner','admin','election_manager']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if v_b.status<>'validated' or v_b.rejected_rows<>0 or v_b.accepted_rows=0 then raise exception 'IMPORT_BATCH_NOT_COMMITTABLE' using errcode='55000'; end if;
 select * into v_e from public.elections where id=v_b.election_id for update;
 if not found or v_e.status<>'draft' then raise exception 'ELECTION_REGISTER_FROZEN' using errcode='55000'; end if;
 insert into public.election_voters(organization_id,election_id,external_voter_ref,display_name,normalized_email,phone_e164,weight_units)
 select v_b.organization_id,v_b.election_id,x.normalized_data->>'external_voter_ref',x.normalized_data->>'display_name',
  nullif(x.normalized_data->>'normalized_email','')::extensions.citext,nullif(x.normalized_data->>'phone_e164',''),
  (x.normalized_data->>'weight_units')::bigint
 from public.import_rows x where x.batch_id=v_b.id and x.status='accepted' order by x.row_number;
 get diagnostics v_inserted=row_count;
 if v_inserted<>v_b.accepted_rows then raise exception 'IMPORT_ROW_COUNT_MISMATCH' using errcode='23514'; end if;
 update public.import_rows set status='committed' where batch_id=v_b.id and status='accepted';
 update public.import_batches set status='committed',committed_at=now() where id=v_b.id;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(v_b.organization_id,v_b.election_id,v_user,'user','voter_import.committed','import_batch',v_b.id,jsonb_build_object('importedRows',v_inserted));
 return jsonb_build_object('batchId',v_b.id,'status','committed','importedRows',v_inserted);
end; $$;

revoke all on function mandate_private.stage_voter_import(uuid,text,text,jsonb) from public,anon;
revoke all on function mandate_private.commit_voter_import(uuid) from public,anon;
grant execute on function mandate_private.stage_voter_import(uuid,text,text,jsonb) to authenticated;
grant execute on function mandate_private.commit_voter_import(uuid) to authenticated;
create function public.stage_voter_import(p_election_id uuid,p_private_object_path text,p_original_filename text,p_rows jsonb)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.stage_voter_import($1,$2,$3,$4); $$;
create function public.commit_voter_import(p_batch_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.commit_voter_import($1); $$;
revoke all on function public.stage_voter_import(uuid,text,text,jsonb) from public,anon;
revoke all on function public.commit_voter_import(uuid) from public,anon;
grant execute on function public.stage_voter_import(uuid,text,text,jsonb) to authenticated;
grant execute on function public.commit_voter_import(uuid) to authenticated;
