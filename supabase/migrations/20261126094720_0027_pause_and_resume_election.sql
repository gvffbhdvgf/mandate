create or replace function mandate_private.pause_election(p_election_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_user uuid:=auth.uid(); v_e public.elections%rowtype;
begin
 if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if p_reason is null or char_length(trim(p_reason))<10 or char_length(p_reason)>1000 then raise exception 'PAUSE_REASON_REQUIRED' using errcode='22023'; end if;
 select * into v_e from public.elections where id=p_election_id for update;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager','returning_officer']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if v_e.status<>'open' then raise exception 'ELECTION_NOT_OPEN' using errcode='55000'; end if;
 update public.elections set status='paused' where id=v_e.id;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(v_e.organization_id,v_e.id,v_user,'user','election.paused','election',v_e.id,jsonb_build_object('reason',trim(p_reason)));
 return jsonb_build_object('electionId',v_e.id,'status','paused');
end; $$;
create or replace function mandate_private.resume_election(p_election_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_user uuid:=auth.uid(); v_e public.elections%rowtype;
begin
 if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if p_reason is null or char_length(trim(p_reason))<10 or char_length(p_reason)>1000 then raise exception 'RESUME_REASON_REQUIRED' using errcode='22023'; end if;
 select * into v_e from public.elections where id=p_election_id for update;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager','returning_officer']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if v_e.status<>'paused' then raise exception 'ELECTION_NOT_PAUSED' using errcode='55000'; end if;
 if now()>=v_e.ends_at then raise exception 'ELECTION_WINDOW_ENDED' using errcode='55000'; end if;
 update public.elections set status='open' where id=v_e.id;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(v_e.organization_id,v_e.id,v_user,'user','election.resumed','election',v_e.id,jsonb_build_object('reason',trim(p_reason)));
 return jsonb_build_object('electionId',v_e.id,'status','open');
end; $$;
revoke all on function mandate_private.pause_election(uuid,text) from public,anon;
revoke all on function mandate_private.resume_election(uuid,text) from public,anon;
grant execute on function mandate_private.pause_election(uuid,text) to authenticated;
grant execute on function mandate_private.resume_election(uuid,text) to authenticated;
create function public.pause_election(p_election_id uuid,p_reason text)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.pause_election($1,$2); $$;
create function public.resume_election(p_election_id uuid,p_reason text)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.resume_election($1,$2); $$;
revoke all on function public.pause_election(uuid,text) from public,anon;
revoke all on function public.resume_election(uuid,text) from public,anon;
grant execute on function public.pause_election(uuid,text) to authenticated;
grant execute on function public.resume_election(uuid,text) to authenticated;
