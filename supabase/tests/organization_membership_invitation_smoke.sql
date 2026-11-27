-- Run only against disposable local Supabase/Postgres; every fixture is rolled back.
begin;

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_user_meta_data,created_at,updated_at)
values
 ('11111111-1111-4111-8111-111111111111','authenticated','authenticated','org-owner@example.invalid','test-only',now(),'{"display_name":"Org Owner"}',now(),now()),
 ('22222222-2222-4222-8222-222222222222','authenticated','authenticated','org-manager@example.invalid','test-only',now(),'{"display_name":"Org Manager"}',now(),now()),
 ('33333333-3333-4333-8333-333333333333','authenticated','authenticated','org-finance@example.invalid','test-only',now(),'{"display_name":"Org Finance"}',now(),now()),
 ('44444444-4444-4444-8444-444444444444','authenticated','authenticated','org-wrong@example.invalid','test-only',now(),'{"display_name":"Wrong Email"}',now(),now()),
 ('55555555-5555-4555-8555-555555555555','authenticated','authenticated','org-unverified@example.invalid','test-only',null,'{"display_name":"Unverified Email"}',now(),now());

set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","email":"org-owner@example.invalid"}',true);
select public.create_organization('Invitation Test Organization','invitation-test-org',null,'Africa/Nairobi');

-- Owner creates a role-scoped, expiring, hashed-token invitation.
select public.create_organization_invitation(
  (select id from public.organizations where slug='invitation-test-org'),
  'org-manager@example.invalid','election_manager',repeat('a',64)
);

do $$ begin
  if (select count(*) from public.organization_invitations where email='org-manager@example.invalid' and status='pending') <> 1 then
    raise exception 'INVITATION_NOT_CREATED';
  end if;
  if (select count(*) from public.organization_invitations where token_hash=repeat('a',64)) <> 1 then
    raise exception 'TOKEN_HASH_NOT_STORED';
  end if;
end $$;

-- A different signed-in email cannot consume the invitation.
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
select set_config('request.jwt.claims','{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated","email":"org-wrong@example.invalid"}',true);
do $$ begin
  begin
    perform public.accept_organization_invitation(repeat('a',64));
    raise exception 'EXPECTED_INVITATION_EMAIL_MISMATCH';
  exception when insufficient_privilege then
    if sqlerrm <> 'INVITATION_EMAIL_MISMATCH' then raise; end if;
  end;
end $$;

-- The intended user accepts; membership is active with exactly the invited role.
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","email":"org-manager@example.invalid"}',true);
select public.accept_organization_invitation(repeat('a',64));
do $$ begin
  if not exists(select 1 from public.organization_members where user_id=auth.uid() and role='election_manager' and status='active') then
    raise exception 'ACCEPTED_MEMBERSHIP_NOT_ACTIVE';
  end if;
  if (select status from public.organization_invitations where token_hash=repeat('a',64)) <> 'accepted' then
    raise exception 'INVITATION_NOT_MARKED_ACCEPTED';
  end if;
  if (select count(*) from public.organization_members) <> 1 then
    raise exception 'MEMBERSHIP_RLS_LEAK_OR_MISSING';
  end if;
end $$;
do $$ begin
  begin
    perform public.accept_organization_invitation(repeat('a',64));
    raise exception 'EXPECTED_SINGLE_USE_REJECTION';
  exception when sqlstate '55000' then
    if sqlerrm <> 'INVITATION_NOT_AVAILABLE' then raise; end if;
  end;
end $$;

-- A manager cannot invite anyone or grant organization roles.
do $$ begin
  begin
    perform public.create_organization_invitation(
      (select id from public.organizations where slug='invitation-test-org'),
      'org-finance@example.invalid','viewer',repeat('b',64)
    );
    raise exception 'EXPECTED_MANAGER_INVITE_FORBIDDEN';
  exception when insufficient_privilege then
    if sqlerrm <> 'FORBIDDEN' then raise; end if;
  end;
end $$;

-- Owner promotes the manager to admin. Admin cannot assign finance/admin roles.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","email":"org-owner@example.invalid"}',true);
select public.change_organization_member_role(
  (select id from public.organization_members where user_id='22222222-2222-4222-8222-222222222222'), 'admin'
);
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","email":"org-manager@example.invalid"}',true);
do $$ begin
  begin
    perform public.create_organization_invitation(
      (select id from public.organizations where slug='invitation-test-org'),
      'org-finance@example.invalid','finance_manager',repeat('c',64)
    );
    raise exception 'EXPECTED_OWNER_ONLY_ROLE_ASSIGNMENT';
  exception when insufficient_privilege then
    if sqlerrm <> 'ROLE_ASSIGNMENT_REQUIRES_OWNER' then raise; end if;
  end;
  if (select count(*) from public.organization_members) <> 2 then raise exception 'ADMIN_MEMBERSHIP_VISIBILITY_FAILED'; end if;
end $$;

-- Owner can invite finance; only the matching email can accept; non-admin cannot see other memberships.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","email":"org-owner@example.invalid"}',true);
select public.create_organization_invitation(
  (select id from public.organizations where slug='invitation-test-org'),
  'org-finance@example.invalid','finance_manager',repeat('c',64)
);
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","email":"org-finance@example.invalid"}',true);
select public.accept_organization_invitation(repeat('c',64));
do $$ begin
  if (select count(*) from public.organization_members) <> 1 then raise exception 'NON_ADMIN_MEMBERSHIP_VISIBILITY_FAILED'; end if;
  if (select count(*) from public.organization_invitations) <> 0 then raise exception 'NON_ADMIN_INVITATION_VISIBILITY_FAILED'; end if;
end $$;

-- Revoke the finance member; access is immediately lost and the action is audited.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","email":"org-owner@example.invalid"}',true);
select public.revoke_organization_member((select id from public.organization_members where user_id='33333333-3333-4333-8333-333333333333'));
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","email":"org-finance@example.invalid"}',true);
do $$ begin
  if exists(select 1 from public.organizations where slug='invitation-test-org') then raise exception 'REVOKED_MEMBER_RETAINED_ORG_ACCESS'; end if;
end $$;

-- Expired invitations cannot be accepted even with the matching email.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","email":"org-owner@example.invalid"}',true);
select public.create_organization_invitation(
  (select id from public.organizations where slug='invitation-test-org'),
  'org-wrong@example.invalid','viewer',repeat('f',64)
);
reset role;
update public.organization_invitations set expires_at=now()-interval '1 minute' where token_hash=repeat('f',64);
set local role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
select set_config('request.jwt.claims','{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated","email":"org-wrong@example.invalid"}',true);
do $$ begin
  begin
    perform public.accept_organization_invitation(repeat('f',64));
    raise exception 'EXPECTED_EXPIRED_INVITATION_REJECTION';
  exception when sqlstate '55000' then
    if sqlerrm <> 'INVITATION_EXPIRED' then raise; end if;
  end;
end $$;

-- An unverified Auth email must never be allowed to accept an organization invitation.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","email":"org-owner@example.invalid"}',true);
select public.create_organization_invitation(
  (select id from public.organizations where slug='invitation-test-org'),
  'org-unverified@example.invalid','viewer',repeat('9',64)
);
select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',true);
select set_config('request.jwt.claims','{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated","email":"org-unverified@example.invalid"}',true);
do $$ begin
  begin
    perform public.accept_organization_invitation(repeat('9',64));
    raise exception 'EXPECTED_UNVERIFIED_EMAIL_REJECTION';
  exception when insufficient_privilege then
    if sqlerrm <> 'INVITATION_EMAIL_NOT_VERIFIED' then raise; end if;
  end;
end $$;

-- An invitation can be revoked before acceptance and cannot then be consumed.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","email":"org-owner@example.invalid"}',true);
select public.create_organization_invitation(
  (select id from public.organizations where slug='invitation-test-org'),
  'org-wrong@example.invalid','viewer',repeat('d',64)
);
select public.revoke_organization_invitation((select id from public.organization_invitations where token_hash=repeat('d',64)));
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
select set_config('request.jwt.claims','{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated","email":"org-wrong@example.invalid"}',true);
do $$ begin
  begin
    perform public.accept_organization_invitation(repeat('d',64));
    raise exception 'EXPECTED_REVOKED_INVITATION_REJECTION';
  exception when sqlstate '55000' then
    if sqlerrm <> 'INVITATION_NOT_AVAILABLE' then raise; end if;
  end;
end $$;

-- Membership and invitation writes remain RPC-only for browser roles.
do $$ begin
  if has_table_privilege('authenticated','public.organization_members','INSERT')
    or has_table_privilege('authenticated','public.organization_members','UPDATE')
    or has_table_privilege('authenticated','public.organization_members','DELETE') then
    raise exception 'DIRECT_MEMBERSHIP_WRITE_GRANT_UNEXPECTED';
  end if;
  if has_table_privilege('authenticated','public.organization_invitations','INSERT')
    or has_table_privilege('authenticated','public.organization_invitations','UPDATE')
    or has_table_privilege('authenticated','public.organization_invitations','DELETE') then
    raise exception 'DIRECT_INVITATION_WRITE_GRANT_UNEXPECTED';
  end if;
end $$;

-- No invitation can grant owner; the last active owner cannot be revoked or demoted.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","email":"org-owner@example.invalid"}',true);
do $$ begin
  begin
    perform public.create_organization_invitation(
      (select id from public.organizations where slug='invitation-test-org'),
      'org-wrong@example.invalid','owner',repeat('e',64)
    );
    raise exception 'EXPECTED_OWNER_ROLE_REJECTION';
  exception when invalid_parameter_value then
    if sqlerrm <> 'INVALID_INVITATION_ROLE' then raise; end if;
  end;
  begin
    perform public.revoke_organization_member((select id from public.organization_members where user_id=auth.uid()));
    raise exception 'EXPECTED_OWNER_TRANSFER_GUARD';
  exception when sqlstate '55000' then
    if sqlerrm <> 'OWNER_TRANSFER_REQUIRED' then raise; end if;
  end;
end $$;

rollback;
