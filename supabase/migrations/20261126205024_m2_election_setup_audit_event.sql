-- Expose the new authority confirmation event through the existing strict audit allowlist.
create or replace function mandate_private.get_election_audit_trail(p_election_id uuid,p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare v_e public.elections%rowtype; v_events jsonb;
begin
 if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 select * into v_e from public.elections where id=p_election_id;
 if not found then raise exception 'ELECTION_NOT_FOUND' using errcode='P0002'; end if;
 if not mandate_private.has_org_role(v_e.organization_id,array['owner','admin','election_manager','returning_officer']::public.organization_role[]) then
   raise exception 'FORBIDDEN' using errcode='42501';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object(
   'action',x.action,'actorType',x.actor_type,'entityType',x.entity_type,'createdAt',x.created_at,
   'metadata',case
     when x.action in ('election.paused','election.resumed','election.closed')
       then coalesce(x.redacted_metadata,'{}'::jsonb)-'reason'
     when x.action in ('voter_import.staged','voter_import.committed')
       then coalesce(x.redacted_metadata,'{}'::jsonb)-array['filename','originalFilename','privateObjectPath']
     else coalesce(x.redacted_metadata,'{}'::jsonb)
   end
 ) order by x.created_at desc),'[]'::jsonb)
 into v_events
 from (
   select action,actor_type,entity_type,created_at,redacted_metadata
   from public.audit_events where election_id=v_e.id
     and action=any(array[
       'election.created','election.setup_confirmed','election.opened','election.paused','election.resumed',
       'election.closed','election.tallied','election.results_published','voter_import.staged',
       'voter_import.committed','voter_invitation.batch_dispatched'
     ])
   order by created_at desc limit greatest(1,least(coalesce(p_limit,50),100))
 ) x;
 return jsonb_build_object('electionId',v_e.id,'events',v_events);
end;
$$;
revoke all on function mandate_private.get_election_audit_trail(uuid,integer) from public,anon;
grant execute on function mandate_private.get_election_audit_trail(uuid,integer) to authenticated;
