revoke all on public.profiles from anon;
revoke all on public.profiles from authenticated;
grant select,update on public.profiles to authenticated;
