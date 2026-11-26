drop function public.create_organization(text,text,extensions.citext,text);
create function public.create_organization(
 p_name text,p_slug text,p_contact_email text default null,p_timezone text default 'Africa/Nairobi'
) returns uuid
language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.create_organization($1,$2,$3::extensions.citext,$4); $$;
revoke all on function public.create_organization(text,text,text,text) from public,anon;
grant execute on function public.create_organization(text,text,text,text) to authenticated;

create or replace function mandate_private.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
begin
 insert into public.profiles(id,display_name)
 values (
  new.id,
  coalesce(
   nullif(btrim(new.raw_user_meta_data->>'display_name'),''),
   nullif(split_part(coalesce(new.email,''),'@',1),''),
   'New member'
  )
 );
 return new;
end;
$$;
revoke all on function mandate_private.handle_new_auth_user() from public,anon,authenticated;
drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute function mandate_private.handle_new_auth_user();
