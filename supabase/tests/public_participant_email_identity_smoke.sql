-- Rollback-only schema/security acceptance for email-backed participant identity.
begin;

do $$
declare
  v_rls boolean;
  v_constraint boolean;
  v_ballot_leak boolean;
begin
  select c.relrowsecurity into v_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'public_participants';

  if v_rls is distinct from true then
    raise exception 'PUBLIC_PARTICIPANTS_RLS_REQUIRED';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_participants'
      and column_name = 'auth_user_id'
      and data_type = 'uuid'
  ) then
    raise exception 'PARTICIPANT_AUTH_ID_COLUMN_MISSING';
  end if;

  select exists (
    select 1 from pg_constraint
    where conrelid = 'public.public_participants'::regclass
      and conname = 'public_participants_election_auth_user_key'
      and contype = 'u'
  ) into v_constraint;

  if not v_constraint then
    raise exception 'PARTICIPANT_ELECTION_AUTH_ID_UNIQUENESS_REQUIRED';
  end if;

  if has_table_privilege('anon', 'public.public_participants', 'SELECT')
    or has_table_privilege('authenticated', 'public.public_participants', 'SELECT')
    or has_table_privilege('anon', 'public.public_participants', 'INSERT')
    or has_table_privilege('authenticated', 'public.public_participants', 'INSERT') then
    raise exception 'PARTICIPANT_TABLE_MUST_REMAIN_SERVER_ONLY';
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ballots'
      and column_name in ('participant_id','auth_user_id','email','contact_hash','payment_id')
  ) into v_ballot_leak;

  if v_ballot_leak then
    raise exception 'BALLOT_MUST_NOT_CONTAIN_PARTICIPANT_OR_CONTACT_IDENTITY';
  end if;
end;
$$;

rollback;
