-- Run only against a disposable Supabase database or inside a transaction as postgres.
-- All test users, profiles, organizations and memberships are rolled back at the end.
begin;

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_user_meta_data,created_at,updated_at)
values
 ('11111111-1111-4111-8111-111111111111','authenticated','authenticated','mandate-rls-one@example.invalid','test-only',now(),'{"display_name":"RLS Test One"}',now(),now()),
 ('22222222-2222-4222-8222-222222222222','authenticated','authenticated','mandate-rls-two@example.invalid','test-only',now(),'{"display_name":"RLS Test Two"}',now(),now());

set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);

do $$ begin
 if (select count(*) from public.profiles where id=auth.uid()) <> 1 then raise exception 'PROFILE_TRIGGER_FAILED_USER_ONE'; end if;
end $$;

select public.create_organization('RLS Test Organization One','rls-test-one',null,'Africa/Nairobi');

do $$ begin
 if (select count(*) from public.organizations) <> 1 then raise exception 'RLS_TEST_FAILED_USER_ONE_ORG_VISIBILITY'; end if;
 if exists(select 1 from public.organizations where slug='rls-test-two') then raise exception 'RLS_TEST_FAILED_CROSS_TENANT_READ_USER_ONE'; end if;
 if (select count(*) from public.organization_members where user_id=auth.uid() and role='owner' and status='active') <> 1 then raise exception 'OWNER_MEMBERSHIP_CREATION_FAILED_USER_ONE'; end if;
end $$;

select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select public.create_organization('RLS Test Organization Two','rls-test-two',null,'Africa/Nairobi');

do $$ begin
 if (select count(*) from public.profiles where id=auth.uid()) <> 1 then raise exception 'PROFILE_TRIGGER_FAILED_USER_TWO'; end if;
 if (select count(*) from public.organizations) <> 1 then raise exception 'RLS_TEST_FAILED_USER_TWO_ORG_VISIBILITY'; end if;
 if exists(select 1 from public.organizations where slug='rls-test-one') then raise exception 'RLS_TEST_FAILED_CROSS_TENANT_READ_USER_TWO'; end if;
 if has_table_privilege('authenticated','public.elections','INSERT') then raise exception 'DIRECT_ELECTION_INSERT_GRANT_UNEXPECTED'; end if;
 if has_table_privilege('authenticated','public.ballots','SELECT') then raise exception 'DIRECT_BALLOT_READ_GRANT_UNEXPECTED'; end if;
 if has_table_privilege('authenticated','public.organizations','INSERT') then raise exception 'DIRECT_ORGANIZATION_INSERT_GRANT_UNEXPECTED'; end if;
 if has_table_privilege('authenticated','public.profiles','UPDATE') then raise exception 'TABLE_WIDE_PROFILE_UPDATE_GRANT_UNEXPECTED'; end if;
 if not has_column_privilege('authenticated','public.profiles','display_name','UPDATE') then raise exception 'PROFILE_DISPLAY_NAME_UPDATE_NOT_GRANTED'; end if;
end $$;

rollback;
