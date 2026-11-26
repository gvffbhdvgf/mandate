create or replace function mandate_private.create_election_setup(
 p_organization_id uuid,p_election jsonb,p_contests jsonb
) returns uuid
language plpgsql security definer set search_path=pg_catalog
as $$
declare
 v_election_id uuid;
 v_contest_id uuid;
 v_contest jsonb;
 v_option jsonb;
 v_contest_order integer:=0;
 v_option_order integer;
begin
 if coalesce(jsonb_typeof(p_election),'null')<>'object' then raise exception 'INVALID_ELECTION_PAYLOAD' using errcode='22023'; end if;
 if coalesce(jsonb_typeof(p_contests),'null')<>'array' then raise exception 'INVALID_CONTESTS_PAYLOAD' using errcode='22023'; end if;
 if jsonb_array_length(p_contests)<1 or jsonb_array_length(p_contests)>10 then raise exception 'INVALID_CONTESTS_PAYLOAD' using errcode='22023'; end if;
 v_election_id:=mandate_private.create_election(
  p_organization_id,p_election->>'title',p_election->>'description',
  coalesce(nullif(p_election->>'voting_mode',''),'registered_single')::public.voting_mode,
  (p_election->>'starts_at')::timestamptz,(p_election->>'ends_at')::timestamptz,
  coalesce(nullif(p_election->>'timezone',''),'Africa/Nairobi'),
  coalesce(nullif(p_election->>'result_visibility',''),'private')
 );
 for v_contest in select value from jsonb_array_elements(p_contests)
 loop
  if coalesce(jsonb_typeof(v_contest),'null')<>'object' then raise exception 'INVALID_CONTEST_PAYLOAD' using errcode='22023'; end if;
  if coalesce(jsonb_typeof(v_contest->'options'),'null')<>'array' then raise exception 'INVALID_CONTEST_OPTIONS' using errcode='22023'; end if;
  if jsonb_array_length(v_contest->'options')<2 or jsonb_array_length(v_contest->'options')>50 then raise exception 'INVALID_CONTEST_OPTIONS' using errcode='22023'; end if;
  v_contest_id:=mandate_private.create_contest(
   v_election_id,v_contest->>'title',v_contest->>'description',
   coalesce((v_contest->>'is_required')::boolean,true),v_contest_order,
   coalesce(nullif(v_contest->>'tie_policy',''),'declared_tie')::public.tie_policy
  );
  v_option_order:=0;
  for v_option in select value from jsonb_array_elements(v_contest->'options')
  loop
   if coalesce(jsonb_typeof(v_option),'null')<>'object' then raise exception 'INVALID_OPTION_PAYLOAD' using errcode='22023'; end if;
   perform mandate_private.create_option(v_election_id,v_contest_id,v_option->>'display_name',v_option->>'profile',v_option_order);
   v_option_order:=v_option_order+1;
  end loop;
  v_contest_order:=v_contest_order+1;
 end loop;
 return v_election_id;
end;
$$;
