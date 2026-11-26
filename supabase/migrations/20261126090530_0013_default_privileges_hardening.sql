alter default privileges for role postgres in schema public revoke all on tables from anon,authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon,authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public,anon,authenticated;
alter default privileges for role postgres in schema mandate_private revoke all on tables from public,anon,authenticated;
alter default privileges for role postgres in schema mandate_private revoke all on sequences from public,anon,authenticated;
alter default privileges for role postgres in schema mandate_private revoke execute on functions from public,anon,authenticated;
