-- Reporting and M1 RPC boundary hardening.
-- Preserve authenticated behavior while keeping SECURITY DEFINER implementations out of the exposed schema.

create index if not exists organization_invitations_accepted_by_idx
  on public.organization_invitations(accepted_by);
create index if not exists organization_invitations_invited_by_idx
  on public.organization_invitations(invited_by);

drop policy if exists members_select_self_or_admin on public.organization_members;

alter function public.get_organization_members(uuid) set schema mandate_private;
alter function public.revoke_organization_invitation(uuid) set schema mandate_private;
alter function public.change_organization_member_role(uuid, public.organization_role) set schema mandate_private;
alter function public.revoke_organization_member(uuid) set schema mandate_private;

create or replace function mandate_private.revoke_organization_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog
as $$
declare v_org uuid; v_actor uuid:=auth.uid();
begin
  if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  select organization_id into v_org from public.organization_invitations
    where id=p_invitation_id and status='pending' for update;
  if not found then raise exception 'INVITATION_NOT_AVAILABLE' using errcode='55000'; end if;
  if not mandate_private.has_org_role(v_org,array['owner','admin']::public.organization_role[]) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  update public.organization_invitations set status='revoked',revoked_at=now()
    where id=p_invitation_id and status='pending';
  insert into public.audit_events(organization_id,actor_id,actor_type,action,entity_type,entity_id)
    values(v_org,v_actor,'user','organization.invitation.revoked','organization_invitation',p_invitation_id);
end;
$$;

create or replace function public.get_organization_members(p_organization_id uuid)
returns table(member_id uuid,user_id uuid,display_name text,email text,role public.organization_role,
  status public.membership_status,created_at timestamptz,accepted_at timestamptz)
language sql security invoker set search_path=pg_catalog
as $$ select * from mandate_private.get_organization_members($1); $$;

create or replace function public.revoke_organization_invitation(p_invitation_id uuid)
returns void language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.revoke_organization_invitation($1); $$;

create or replace function public.change_organization_member_role(p_member_id uuid,p_role public.organization_role)
returns void language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.change_organization_member_role($1,$2); $$;

create or replace function public.revoke_organization_member(p_member_id uuid)
returns void language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.revoke_organization_member($1); $$;

revoke all on function mandate_private.get_organization_members(uuid) from public,anon,authenticated;
revoke all on function mandate_private.revoke_organization_invitation(uuid) from public,anon,authenticated;
revoke all on function mandate_private.change_organization_member_role(uuid,public.organization_role) from public,anon,authenticated;
revoke all on function mandate_private.revoke_organization_member(uuid) from public,anon,authenticated;
grant execute on function mandate_private.get_organization_members(uuid) to authenticated;
grant execute on function mandate_private.revoke_organization_invitation(uuid) to authenticated;
grant execute on function mandate_private.change_organization_member_role(uuid,public.organization_role) to authenticated;
grant execute on function mandate_private.revoke_organization_member(uuid) to authenticated;

revoke all on function public.get_organization_members(uuid) from public,anon,authenticated;
revoke all on function public.revoke_organization_invitation(uuid) from public,anon,authenticated;
revoke all on function public.change_organization_member_role(uuid,public.organization_role) from public,anon,authenticated;
revoke all on function public.revoke_organization_member(uuid) from public,anon,authenticated;
grant execute on function public.get_organization_members(uuid) to authenticated;
grant execute on function public.revoke_organization_invitation(uuid) to authenticated;
grant execute on function public.change_organization_member_role(uuid,public.organization_role) to authenticated;
grant execute on function public.revoke_organization_member(uuid) to authenticated;

create or replace function mandate_private.record_results_export(p_election_id uuid,p_format text)
returns void language plpgsql security definer set search_path=pg_catalog
as $$
declare
  v_actor uuid:=auth.uid();
  v_e public.elections%rowtype;
  v_t public.election_tallies%rowtype;
begin
  if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  if p_format is null or p_format not in ('csv','pdf') then
    raise exception 'INVALID_REPORT_FORMAT' using errcode='22023';
  end if;
  select * into v_e from public.elections where id=p_election_id;
  if not found or v_e.status<>'results_published' then
    raise exception 'RESULTS_NOT_PUBLISHED' using errcode='55000';
  end if;
  if not mandate_private.has_org_role(v_e.organization_id,
    array['owner','admin','returning_officer']::public.organization_role[]) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  select * into v_t from public.election_tallies where election_id=v_e.id;
  if not found then raise exception 'TALLY_NOT_FOUND' using errcode='P0002'; end if;
  insert into public.audit_events(organization_id,election_id,actor_id,actor_type,action,
    entity_type,entity_id,redacted_metadata)
  values(v_e.organization_id,v_e.id,v_actor,'user','election.results.exported',
    'election_tally',v_t.id,jsonb_build_object('format',p_format,'snapshotHash',v_t.snapshot_hash));
end;
$$;
create or replace function public.record_results_export(p_election_id uuid,p_format text)
returns void language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.record_results_export($1,$2); $$;

revoke all on function mandate_private.record_results_export(uuid,text) from public,anon,authenticated;
grant execute on function mandate_private.record_results_export(uuid,text) to authenticated;
revoke all on function public.record_results_export(uuid,text) from public,anon,authenticated;
grant execute on function public.record_results_export(uuid,text) to authenticated;

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
 select coalesce(jsonb_agg(jsonb_build_object('action',x.action,'actorType',x.actor_type,
  'entityType',x.entity_type,'createdAt',x.created_at,
  'metadata',case
   when x.action in ('election.paused','election.resumed','election.closed') then coalesce(x.redacted_metadata,'{}'::jsonb)-'reason'
   when x.action in ('voter_import.staged','voter_import.committed') then coalesce(x.redacted_metadata,'{}'::jsonb)-array['filename','originalFilename','privateObjectPath']
   else coalesce(x.redacted_metadata,'{}'::jsonb)
  end) order by x.created_at desc),'[]'::jsonb)
 into v_events
 from (
  select action,actor_type,entity_type,created_at,redacted_metadata
  from public.audit_events where election_id=v_e.id
   and action=any(array['election.created','election.opened','election.paused','election.resumed','election.closed',
    'election.tallied','election.results_published','election.results.exported','election.setup_confirmed','voter_import.staged',
    'voter_import.committed','voter_invitation.batch_dispatched'])
  order by created_at desc limit greatest(1,least(coalesce(p_limit,50),100))
 ) x;
 return jsonb_build_object('electionId',v_e.id,'events',v_events);
end;
$$;

