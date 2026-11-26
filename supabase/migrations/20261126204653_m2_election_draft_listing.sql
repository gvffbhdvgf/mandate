create or replace function mandate_private.list_election_setup_drafts(p_organization_id uuid)
returns table(id uuid,title text,current_step integer,status text,updated_at timestamptz,election_id uuid,payload jsonb)
language plpgsql security definer set search_path=pg_catalog
as $$
begin
 if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if not mandate_private.has_org_role(p_organization_id,array['owner','admin','election_manager']::public.organization_role[]) then
   raise exception 'FORBIDDEN' using errcode='42501';
 end if;
 return query
 select d.id,coalesce(nullif(d.payload#>>'{election,title}',''),'Untitled election'),
   d.current_step,d.status,d.updated_at,d.election_id,d.payload
 from public.election_setup_drafts d
 where d.organization_id=p_organization_id and d.status='draft'
 order by d.updated_at desc;
end;
$$;
revoke all on function mandate_private.list_election_setup_drafts(uuid) from public,anon;
grant execute on function mandate_private.list_election_setup_drafts(uuid) to authenticated;
create or replace function public.list_election_setup_drafts(p_organization_id uuid)
returns table(id uuid,title text,current_step integer,status text,updated_at timestamptz,election_id uuid,payload jsonb)
language sql security invoker set search_path=pg_catalog
as $$ select * from mandate_private.list_election_setup_drafts($1); $$;
revoke all on function public.list_election_setup_drafts(uuid) from public,anon;
grant execute on function public.list_election_setup_drafts(uuid) to authenticated;
