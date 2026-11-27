create type public.organization_invitation_status as enum ('pending','accepted','revoked');

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  email extensions.citext not null,
  role public.organization_role not null check (role <> 'owner'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status public.organization_invitation_status not null default 'pending',
  invited_by uuid not null references auth.users(id) on delete restrict,
  expires_at timestamptz not null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((status = 'revoked') = (revoked_at is not null))
);
create index organization_invitations_org_status_idx
  on public.organization_invitations(organization_id,status,expires_at desc);
create index organization_invitations_email_idx
  on public.organization_invitations(email,created_at desc);
create trigger organization_invitations_set_updated_at
  before update on public.organization_invitations
  for each row execute function mandate_private.set_updated_at();

alter table public.organization_invitations enable row level security;
revoke all on public.organization_invitations from anon,authenticated;
grant select on public.organization_invitations to authenticated;
create policy organization_invitations_read_admin on public.organization_invitations
  for select to authenticated
  using (mandate_private.has_org_role(organization_id,array['owner','admin']::public.organization_role[]));

-- Memberships are visible to the member themselves and to organization administrators.
grant select on public.organization_members to authenticated;
create policy organization_members_read_self_or_admin on public.organization_members
  for select to authenticated
  using (user_id = (select auth.uid())
    or mandate_private.has_org_role(organization_id,array['owner','admin']::public.organization_role[]));

create or replace function mandate_private.create_organization_invitation(
  p_organization_id uuid,
  p_email text,
  p_role public.organization_role,
  p_token_hash text
) returns uuid
language plpgsql security definer set search_path=pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role public.organization_role;
  v_email extensions.citext;
  v_invitation_id uuid;
begin
  if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  if p_email is null or length(btrim(p_email)) > 254
    or length(btrim(p_email))-length(replace(btrim(p_email),'@','')) <> 1
    or position('@' in btrim(p_email)) <= 1
    or position('.' in split_part(btrim(p_email),'@',2)) <= 1
    or right(btrim(p_email),1)='.' then
    raise exception 'INVALID_INVITATION_EMAIL' using errcode='22023';
  end if;
  if p_role is null or p_role = 'owner' then raise exception 'INVALID_INVITATION_ROLE' using errcode='22023'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_INVITATION_TOKEN' using errcode='22023'; end if;

  select m.role into v_actor_role from public.organization_members m
  where m.organization_id=p_organization_id and m.user_id=v_actor and m.status='active';
  if v_actor_role is null or v_actor_role not in ('owner','admin') then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if v_actor_role <> 'owner' and p_role in ('admin','finance_manager') then
    raise exception 'ROLE_ASSIGNMENT_REQUIRES_OWNER' using errcode='42501';
  end if;

  v_email := lower(btrim(p_email))::extensions.citext;
  if exists (
    select 1 from public.organization_members m join auth.users u on u.id=m.user_id
    where m.organization_id=p_organization_id and lower(u.email)=lower(v_email::text)
      and m.status='active'
  ) then raise exception 'MEMBER_ALREADY_ACTIVE' using errcode='23505'; end if;

  update public.organization_invitations
    set status='revoked', revoked_at=now()
    where organization_id=p_organization_id and email=v_email and status='pending';

  insert into public.organization_invitations(
    organization_id,email,role,token_hash,invited_by,expires_at
  ) values (
    p_organization_id,v_email,p_role,p_token_hash,v_actor,now()+interval '7 days'
  ) returning id into v_invitation_id;

  insert into public.audit_events(
    organization_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata
  ) values (
    p_organization_id,v_actor,'user','organization.invitation.created','organization_invitation',
    v_invitation_id,jsonb_build_object('role',p_role,'emailDomain',split_part(v_email::text,'@',2))
  );
  return v_invitation_id;
end;
$$;

create or replace function public.create_organization_invitation(
  p_organization_id uuid,p_email text,p_role public.organization_role,p_token_hash text
) returns uuid language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.create_organization_invitation($1,$2,$3,$4); $$;
revoke all on function public.create_organization_invitation(uuid,text,public.organization_role,text) from public,anon;
grant execute on function public.create_organization_invitation(uuid,text,public.organization_role,text) to authenticated;
revoke all on function mandate_private.create_organization_invitation(uuid,text,public.organization_role,text) from public,anon;
grant execute on function mandate_private.create_organization_invitation(uuid,text,public.organization_role,text) to authenticated;

create or replace function mandate_private.accept_organization_invitation(p_token_hash text)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_email_confirmed_at timestamptz;
  v_inv public.organization_invitations%rowtype;
  v_member_id uuid;
begin
  if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  select lower(u.email),u.email_confirmed_at
    into v_email,v_email_confirmed_at
    from auth.users u where u.id=v_actor;
  if not found or v_email_confirmed_at is null then
    raise exception 'INVITATION_EMAIL_NOT_VERIFIED' using errcode='42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INVITATION' using errcode='22023';
  end if;
  select * into v_inv from public.organization_invitations i
  where i.token_hash=p_token_hash for update;
  if not found or v_inv.status <> 'pending' then raise exception 'INVITATION_NOT_AVAILABLE' using errcode='55000'; end if;
  if v_inv.expires_at <= now() then raise exception 'INVITATION_EXPIRED' using errcode='55000'; end if;
  if v_email = '' or v_email <> lower(v_inv.email::text) then raise exception 'INVITATION_EMAIL_MISMATCH' using errcode='42501'; end if;
  if exists(select 1 from public.organization_members m where m.organization_id=v_inv.organization_id and m.user_id=v_actor and m.status='active') then
    raise exception 'MEMBER_ALREADY_ACTIVE' using errcode='23505';
  end if;

  insert into public.organization_members as current_members(
    organization_id,user_id,role,status,invited_by,invitation_expires_at,accepted_at
  ) values (
    v_inv.organization_id,v_actor,v_inv.role,'active',v_inv.invited_by,v_inv.expires_at,now()
  )
  on conflict (organization_id,user_id) do update
    set role=excluded.role,status='active',invited_by=excluded.invited_by,
        invitation_expires_at=excluded.invitation_expires_at,accepted_at=excluded.accepted_at
    where current_members.status in ('revoked','suspended')
  returning id into v_member_id;
  if v_member_id is null then raise exception 'MEMBERSHIP_ALREADY_EXISTS' using errcode='23505'; end if;

  update public.organization_invitations
    set status='accepted',accepted_by=v_actor,accepted_at=now()
    where id=v_inv.id and status='pending';
  if not found then raise exception 'INVITATION_ALREADY_USED' using errcode='55000'; end if;

  insert into public.audit_events(
    organization_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata
  ) values (
    v_inv.organization_id,v_actor,'user','organization.member.joined','organization_member',
    v_member_id,jsonb_build_object('role',v_inv.role)
  );
  return jsonb_build_object('organizationId',v_inv.organization_id,'memberId',v_member_id,'role',v_inv.role);
end;
$$;

create or replace function public.accept_organization_invitation(p_token_hash text)
returns jsonb language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.accept_organization_invitation($1); $$;
revoke all on function public.accept_organization_invitation(text) from public,anon;
grant execute on function public.accept_organization_invitation(text) to authenticated;
revoke all on function mandate_private.accept_organization_invitation(text) from public,anon;
grant execute on function mandate_private.accept_organization_invitation(text) to authenticated;

create or replace function public.get_organization_members(p_organization_id uuid)
returns table(member_id uuid,user_id uuid,display_name text,email text,role public.organization_role,status public.membership_status,created_at timestamptz,accepted_at timestamptz)
language plpgsql security definer set search_path=pg_catalog
as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  if not mandate_private.has_org_role(p_organization_id,array['owner','admin']::public.organization_role[]) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  return query
    select m.id,m.user_id,p.display_name,u.email::text,m.role,m.status,m.created_at,m.accepted_at
    from public.organization_members m
    join auth.users u on u.id=m.user_id
    left join public.profiles p on p.id=m.user_id
    where m.organization_id=p_organization_id
    order by case when m.role='owner' then 0 else 1 end,m.created_at;
end;
$$;
revoke all on function public.get_organization_members(uuid) from public,anon;
grant execute on function public.get_organization_members(uuid) to authenticated;

create or replace function public.revoke_organization_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog
as $$
declare v_org uuid; v_actor uuid:=auth.uid();
begin
  select organization_id into v_org from public.organization_invitations where id=p_invitation_id and status='pending' for update;
  if not found then raise exception 'INVITATION_NOT_AVAILABLE' using errcode='55000'; end if;
  if not mandate_private.has_org_role(v_org,array['owner','admin']::public.organization_role[]) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  update public.organization_invitations set status='revoked',revoked_at=now() where id=p_invitation_id and status='pending';
  insert into public.audit_events(organization_id,actor_id,actor_type,action,entity_type,entity_id)
  values(v_org,v_actor,'user','organization.invitation.revoked','organization_invitation',p_invitation_id);
end;
$$;
revoke all on function public.revoke_organization_invitation(uuid) from public,anon;
grant execute on function public.revoke_organization_invitation(uuid) to authenticated;

create or replace function public.change_organization_member_role(p_member_id uuid,p_role public.organization_role)
returns void language plpgsql security definer set search_path=pg_catalog
as $$
declare v_member public.organization_members%rowtype; v_actor uuid:=auth.uid(); v_actor_role public.organization_role;
begin
  if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  if p_role is null or p_role='owner' then raise exception 'INVALID_MEMBER_ROLE' using errcode='22023'; end if;
  select * into v_member from public.organization_members where id=p_member_id for update;
  if not found then raise exception 'MEMBER_NOT_FOUND' using errcode='P0002'; end if;
  select role into v_actor_role from public.organization_members where organization_id=v_member.organization_id and user_id=v_actor and status='active';
  if v_actor_role is null or v_actor_role not in ('owner','admin') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_member.status<>'active' then raise exception 'MEMBER_NOT_ACTIVE' using errcode='55000'; end if;
  if v_member.role='owner' then raise exception 'OWNER_TRANSFER_REQUIRED' using errcode='55000'; end if;
  if v_actor_role<>'owner' and (v_member.role in ('admin','finance_manager') or p_role in ('admin','finance_manager')) then
    raise exception 'ROLE_ASSIGNMENT_REQUIRES_OWNER' using errcode='42501';
  end if;
  update public.organization_members set role=p_role where id=p_member_id;
  insert into public.audit_events(organization_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
  values(v_member.organization_id,v_actor,'user','organization.member.role_changed','organization_member',p_member_id,jsonb_build_object('from',v_member.role,'to',p_role));
end;
$$;
revoke all on function public.change_organization_member_role(uuid,public.organization_role) from public,anon;
grant execute on function public.change_organization_member_role(uuid,public.organization_role) to authenticated;

create or replace function public.revoke_organization_member(p_member_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog
as $$
declare v_member public.organization_members%rowtype; v_actor uuid:=auth.uid(); v_actor_role public.organization_role;
begin
  if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  select * into v_member from public.organization_members where id=p_member_id for update;
  if not found then raise exception 'MEMBER_NOT_FOUND' using errcode='P0002'; end if;
  select role into v_actor_role from public.organization_members where organization_id=v_member.organization_id and user_id=v_actor and status='active';
  if v_actor_role is null or v_actor_role not in ('owner','admin') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_member.status<>'active' then raise exception 'MEMBER_NOT_ACTIVE' using errcode='55000'; end if;
  if v_member.role='owner' then raise exception 'OWNER_TRANSFER_REQUIRED' using errcode='55000'; end if;
  if v_actor_role<>'owner' and v_member.role in ('admin','finance_manager') then raise exception 'ROLE_ASSIGNMENT_REQUIRES_OWNER' using errcode='42501'; end if;
  update public.organization_members set status='revoked' where id=p_member_id and status<>'revoked';
  insert into public.audit_events(organization_id,actor_id,actor_type,action,entity_type,entity_id,redacted_metadata)
  values(v_member.organization_id,v_actor,'user','organization.member.revoked','organization_member',p_member_id,jsonb_build_object('role',v_member.role));
end;
$$;
revoke all on function public.revoke_organization_member(uuid) from public,anon;
grant execute on function public.revoke_organization_member(uuid) to authenticated;
