create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create schema if not exists mandate_private;
revoke all on schema mandate_private from public;
revoke all on schema mandate_private from anon, authenticated;
grant usage on schema mandate_private to service_role;
comment on schema mandate_private is 'Private implementation schema. No direct PostgREST exposure; privileged functions must validate caller and tenant scope.';
