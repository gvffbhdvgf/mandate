create or replace function mandate_private.get_election_audit_trail(p_election_id uuid,p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_e public.elections%rowtype; v_events jsonb;
begin
 if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 select * into v_e from public.elections where id=p_election_id;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager','returning_officer']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('action',x.action,'actorType',x.actor_type,'entityType',x.entity_type,
  'createdAt',x.created_at,'metadata',x.redacted_metadata) order by x.created_at desc),'[]'::jsonb)
 into v_events
 from (
  select action,actor_type,entity_type,created_at,redacted_metadata
  from public.audit_events where election_id=v_e.id
   and action not like 'ballot.%' and action not like 'payment.%' and action not like 'wallet.%'
  order by created_at desc limit greatest(1,least(coalesce(p_limit,50),100))
 ) x;
 return jsonb_build_object('electionId',v_e.id,'events',v_events);
end; $$;
revoke all on function mandate_private.get_election_audit_trail(uuid,integer) from public,anon;
grant execute on function mandate_private.get_election_audit_trail(uuid,integer) to authenticated;
create function public.get_election_audit_trail(p_election_id uuid,p_limit integer default 50)
returns jsonb language sql security invoker set search_path=pg_catalog as $$ select mandate_private.get_election_audit_trail($1,$2); $$;
revoke all on function public.get_election_audit_trail(uuid,integer) from public,anon;
grant execute on function public.get_election_audit_trail(uuid,integer) to authenticated;
