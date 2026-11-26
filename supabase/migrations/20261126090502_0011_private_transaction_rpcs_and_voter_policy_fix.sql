alter function public.create_organization(text,text,extensions.citext,text) set schema mandate_private;
alter function public.open_election(uuid,boolean) set schema mandate_private;
alter function public.close_election(uuid,text) set schema mandate_private;
alter function public.cast_registered_ballot(text,uuid,uuid,boolean) set schema mandate_private;
revoke all on function mandate_private.create_organization(text,text,extensions.citext,text) from public,anon;
revoke all on function mandate_private.open_election(uuid,boolean) from public,anon;
revoke all on function mandate_private.close_election(uuid,text) from public,anon;
revoke all on function mandate_private.cast_registered_ballot(text,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function mandate_private.create_organization(text,text,extensions.citext,text) to authenticated;
grant execute on function mandate_private.open_election(uuid,boolean) to authenticated;
grant execute on function mandate_private.close_election(uuid,text) to authenticated;
grant execute on function mandate_private.cast_registered_ballot(text,uuid,uuid,boolean) to service_role;
create function public.create_organization(p_name text,p_slug text,p_contact_email extensions.citext default null,p_timezone text default 'Africa/Nairobi')
returns uuid language sql security invoker set search_path=pg_catalog as $$ select mandate_private.create_organization($1,$2,$3,$4); $$;
create function public.open_election(p_election_id uuid,p_confirm_rules_snapshot boolean)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.open_election($1,$2); $$;
create function public.close_election(p_election_id uuid,p_reason text)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.close_election($1,$2); $$;
revoke all on function public.create_organization(text,text,extensions.citext,text) from public,anon;
revoke all on function public.open_election(uuid,boolean) from public,anon;
revoke all on function public.close_election(uuid,text) from public,anon;
grant execute on function public.create_organization(text,text,extensions.citext,text) to authenticated;
grant execute on function public.open_election(uuid,boolean) to authenticated;
grant execute on function public.close_election(uuid,text) to authenticated;
drop policy voters_update_draft on public.election_voters;
create policy voters_update_draft on public.election_voters for update to authenticated
using (mandate_private.can_manage_election(election_id,array['owner','admin','election_manager']::public.organization_role[]) and exists(select 1 from public.elections e where e.id=election_id and e.status='draft'))
with check (mandate_private.can_manage_election(election_id,array['owner','admin','election_manager']::public.organization_role[]) and exists(select 1 from public.elections e where e.id=election_id and e.status='draft'));
