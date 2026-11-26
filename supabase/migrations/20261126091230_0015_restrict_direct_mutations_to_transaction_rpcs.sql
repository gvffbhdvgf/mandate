-- Restrict direct browser mutations until each resource has an audited transaction RPC.
revoke insert,update,delete on public.organizations from authenticated;
grant select on public.organizations to authenticated;

revoke insert,update,delete on public.elections from authenticated;
grant select on public.elections to authenticated;

revoke insert,update,delete on public.contests,public.options from authenticated;
grant select on public.contests,public.options to authenticated;

revoke insert,update,delete on public.election_voters,public.import_batches,public.import_rows from authenticated;
grant select on public.election_voters,public.import_batches,public.import_rows to authenticated;

-- Profile self-service is limited to profile fields; identity and timestamps are server-owned.
revoke update on public.profiles from authenticated;
grant update(display_name,phone_e164) on public.profiles to authenticated;
