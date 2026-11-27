create or replace function mandate_private.create_election(
 p_organization_id uuid,p_title text,p_description text,p_voting_mode public.voting_mode,
 p_starts_at timestamptz,p_ends_at timestamptz,p_timezone text,p_result_visibility text
) returns uuid language plpgsql security definer set search_path=pg_catalog
as $$
declare v_user uuid:=auth.uid(); v_election uuid;
begin
 if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if p_title is null or char_length(btrim(p_title)) not between 2 and 160 then raise exception 'INVALID_ELECTION_TITLE' using errcode='22023'; end if;
 if p_description is not null and char_length(p_description)>5000 then raise exception 'ELECTION_DESCRIPTION_TOO_LONG' using errcode='22023'; end if;
 if p_voting_mode not in ('registered_single','registered_weighted') then raise exception 'PAID_VOTING_FEATURE_GATED' using errcode='55000'; end if;
 if p_starts_at is null or p_ends_at is null or p_starts_at>=p_ends_at or p_ends_at<=now() then raise exception 'INVALID_ELECTION_WINDOW' using errcode='22023'; end if;
 if p_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then raise exception 'INVALID_TIMEZONE' using errcode='22023'; end if;
 if p_result_visibility not in ('private','members','public') then raise exception 'INVALID_RESULT_VISIBILITY' using errcode='22023'; end if;
 if not mandate_private.has_org_role(p_organization_id,array['owner','admin','election_manager']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if not exists(select 1 from public.organizations o where o.id=p_organization_id and o.status='active') then raise exception 'ORGANIZATION_NOT_ACTIVE' using errcode='55000'; end if;
 insert into public.elections(organization_id,title,description,voting_mode,status,starts_at,ends_at,timezone,result_visibility,created_by)
 values(p_organization_id,btrim(p_title),nullif(btrim(coalesce(p_description,'')),''),p_voting_mode,'draft',p_starts_at,p_ends_at,p_timezone,p_result_visibility,v_user)
 returning id into v_election;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
 values(p_organization_id,v_election,v_user,'user','election.created','election',v_election,jsonb_build_object('votingMode',p_voting_mode,'startsAt',p_starts_at,'endsAt',p_ends_at));
 return v_election;
end; $$;

create or replace function mandate_private.create_contest(
 p_election_id uuid,p_title text,p_description text,p_is_required boolean,p_display_order integer,p_tie_policy public.tie_policy
) returns uuid language plpgsql security definer set search_path=pg_catalog
as $$
declare v_user uuid:=auth.uid(); v_e public.elections%rowtype; v_contest uuid;
begin
 if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if p_title is null or char_length(btrim(p_title)) not between 2 and 160 then raise exception 'INVALID_CONTEST_TITLE' using errcode='22023'; end if;
 if p_description is not null and char_length(p_description)>5000 then raise exception 'CONTEST_DESCRIPTION_TOO_LONG' using errcode='22023'; end if;
 if p_display_order is null or p_display_order not between 0 and 10000 then raise exception 'INVALID_DISPLAY_ORDER' using errcode='22023'; end if;
 select * into v_e from public.elections where id=p_election_id for update;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if v_e.status<>'draft' then raise exception 'ELECTION_CONFIGURATION_FROZEN' using errcode='55000'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 insert into public.contests(organization_id,election_id,title,description,is_required,display_order,tie_policy)
 values(v_e.organization_id,v_e.id,btrim(p_title),nullif(btrim(coalesce(p_description,'')),''),coalesce(p_is_required,true),p_display_order,coalesce(p_tie_policy,'declared_tie'))
 returning id into v_contest;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id)
 values(v_e.organization_id,v_e.id,v_user,'user','contest.created','contest',v_contest);
 return v_contest;
end; $$;

create or replace function mandate_private.create_option(
 p_election_id uuid,p_contest_id uuid,p_display_name text,p_profile text,p_display_order integer
) returns uuid language plpgsql security definer set search_path=pg_catalog
as $$
declare v_user uuid:=auth.uid(); v_e public.elections%rowtype; v_c public.contests%rowtype; v_option uuid;
begin
 if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if p_display_name is null or char_length(btrim(p_display_name)) not between 1 and 160 then raise exception 'INVALID_OPTION_NAME' using errcode='22023'; end if;
 if p_profile is not null and char_length(p_profile)>5000 then raise exception 'OPTION_PROFILE_TOO_LONG' using errcode='22023'; end if;
 if p_display_order is null or p_display_order not between 0 and 10000 then raise exception 'INVALID_DISPLAY_ORDER' using errcode='22023'; end if;
 select * into v_e from public.elections where id=p_election_id for update;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if v_e.status<>'draft' then raise exception 'ELECTION_CONFIGURATION_FROZEN' using errcode='55000'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into v_c from public.contests where id=p_contest_id and election_id=v_e.id;
 if not found then raise exception 'CONTEST_NOT_FOUND' using errcode='P0002'; end if;
 insert into public.options(organization_id,election_id,contest_id,display_name,profile,display_order)
 values(v_e.organization_id,v_e.id,v_c.id,btrim(p_display_name),nullif(btrim(coalesce(p_profile,'')),''),p_display_order)
 returning id into v_option;
 insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,entity_type,entity_id)
 values(v_e.organization_id,v_e.id,v_user,'user','option.created','option',v_option);
 return v_option;
end; $$;

revoke all on function mandate_private.create_election(uuid,text,text,public.voting_mode,timestamptz,timestamptz,text,text) from public,anon;
revoke all on function mandate_private.create_contest(uuid,text,text,boolean,integer,public.tie_policy) from public,anon;
revoke all on function mandate_private.create_option(uuid,uuid,text,text,integer) from public,anon;
grant execute on function mandate_private.create_election(uuid,text,text,public.voting_mode,timestamptz,timestamptz,text,text) to authenticated;
grant execute on function mandate_private.create_contest(uuid,text,text,boolean,integer,public.tie_policy) to authenticated;
grant execute on function mandate_private.create_option(uuid,uuid,text,text,integer) to authenticated;

create function public.create_election(p_organization_id uuid,p_title text,p_description text,p_voting_mode public.voting_mode,p_starts_at timestamptz,p_ends_at timestamptz,p_timezone text,p_result_visibility text)
returns uuid language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.create_election($1,$2,$3,$4,$5,$6,$7,$8); $$;
create function public.create_contest(p_election_id uuid,p_title text,p_description text,p_is_required boolean,p_display_order integer,p_tie_policy public.tie_policy)
returns uuid language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.create_contest($1,$2,$3,$4,$5,$6); $$;
create function public.create_option(p_election_id uuid,p_contest_id uuid,p_display_name text,p_profile text,p_display_order integer)
returns uuid language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.create_option($1,$2,$3,$4,$5); $$;
revoke all on function public.create_election(uuid,text,text,public.voting_mode,timestamptz,timestamptz,text,text) from public,anon;
revoke all on function public.create_contest(uuid,text,text,boolean,integer,public.tie_policy) from public,anon;
revoke all on function public.create_option(uuid,uuid,text,text,integer) from public,anon;
grant execute on function public.create_election(uuid,text,text,public.voting_mode,timestamptz,timestamptz,text,text) to authenticated;
grant execute on function public.create_contest(uuid,text,text,boolean,integer,public.tie_policy) to authenticated;
grant execute on function public.create_option(uuid,uuid,text,text,integer) to authenticated;
