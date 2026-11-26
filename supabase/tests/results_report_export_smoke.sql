-- These checks run inside the disposable migration acceptance stack.
begin;
do $$
begin
  if (select prosecdef from pg_proc where oid='public.get_organization_members(uuid)'::regprocedure) then
    raise exception 'PUBLIC_MEMBER_READER_MUST_BE_SECURITY_INVOKER';
  end if;
  if (select prosecdef from pg_proc where oid='public.revoke_organization_invitation(uuid)'::regprocedure) then
    raise exception 'PUBLIC_INVITATION_REVOKE_MUST_BE_SECURITY_INVOKER';
  end if;
  if (select prosecdef from pg_proc where oid='public.change_organization_member_role(uuid,public.organization_role)'::regprocedure) then
    raise exception 'PUBLIC_ROLE_CHANGE_MUST_BE_SECURITY_INVOKER';
  end if;
  if (select prosecdef from pg_proc where oid='public.revoke_organization_member(uuid)'::regprocedure) then
    raise exception 'PUBLIC_MEMBER_REVOKE_MUST_BE_SECURITY_INVOKER';
  end if;
  if not (select prosecdef from pg_proc where oid='mandate_private.record_results_export(uuid,text)'::regprocedure) then
    raise exception 'REPORT_AUDIT_IMPLEMENTATION_MUST_BE_SECURITY_DEFINER';
  end if;
  if not (select prosecdef from pg_proc where oid='mandate_private.get_election_audit_trail(uuid,integer)'::regprocedure) then
    raise exception 'PRIVATE_AUDIT_READER_MUST_REMAIN_SECURITY_DEFINER';
  end if;
  if not has_function_privilege('authenticated','public.record_results_export(uuid,text)','EXECUTE') then
    raise exception 'AUTHENTICATED_REPORT_AUDIT_RPC_MUST_BE_GRANTABLE';
  end if;
  if has_function_privilege('anon','public.record_results_export(uuid,text)','EXECUTE') then
    raise exception 'ANON_REPORT_AUDIT_RPC_MUST_BE_REVOKED';
  end if;
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='organization_invitations_accepted_by_idx') then
    raise exception 'INVITATION_ACCEPTED_BY_FK_INDEX_MISSING';
  end if;
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='organization_invitations_invited_by_idx') then
    raise exception 'INVITATION_INVITED_BY_FK_INDEX_MISSING';
  end if;
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='elections_setup_confirmed_by_idx') then
    raise exception 'ELECTION_SETUP_CONFIRMATION_FK_INDEX_MISSING';
  end if;
  if exists (select 1 from pg_policies where schemaname='public' and tablename='organization_members'
      and policyname='members_select_self_or_admin') then
    raise exception 'DUPLICATE_MEMBERSHIP_READ_POLICY_REMAINS';
  end if;
end;
$$;
rollback;
