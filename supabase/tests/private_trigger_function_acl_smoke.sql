-- Run only against the disposable local Supabase database.
-- Verify API roles cannot call private trigger functions directly, while existing
-- triggers still execute their functions under an ordinary application role.
begin;

do $$
declare
  v_function regprocedure;
  v_functions regprocedure[] := array[
    'mandate_private.set_updated_at()'::regprocedure,
    'mandate_private.prevent_append_only_mutation()'::regprocedure,
    'mandate_private.guard_election_snapshot()'::regprocedure,
    'mandate_private.guard_ledger_posting()'::regprocedure
  ];
begin
  foreach v_function in array v_functions loop
    if has_function_privilege('anon', v_function, 'EXECUTE')
      or has_function_privilege('authenticated', v_function, 'EXECUTE')
      or has_function_privilege('service_role', v_function, 'EXECUTE') then
      raise exception 'TRIGGER_FUNCTION_EXECUTE_STILL_GRANTED: %', v_function;
    end if;
  end loop;
end;
$$;

create temporary table trigger_acl_updated_at_probe(updated_at timestamptz);
create trigger trigger_acl_updated_at_probe_before_update
before update on trigger_acl_updated_at_probe
for each row execute function mandate_private.set_updated_at();
insert into trigger_acl_updated_at_probe values ('2000-01-01T00:00:00Z');
grant usage on schema pg_temp to authenticated;
grant select, update on trigger_acl_updated_at_probe to authenticated;

create temporary table trigger_acl_append_only_probe(id integer);
create trigger trigger_acl_append_only_probe_before_update
before update on trigger_acl_append_only_probe
for each row execute function mandate_private.prevent_append_only_mutation();
insert into trigger_acl_append_only_probe values (1);
grant select, update on trigger_acl_append_only_probe to authenticated;

create temporary table trigger_acl_election_snapshot_probe(
  status text, rules_snapshot jsonb, candidate_snapshot jsonb, rules_hash text,
  voting_mode text, starts_at timestamptz, ends_at timestamptz
);
create trigger trigger_acl_election_snapshot_probe_before_update
before update on trigger_acl_election_snapshot_probe
for each row execute function mandate_private.guard_election_snapshot();
insert into trigger_acl_election_snapshot_probe values ('open','{}','{}','old','registered_single',now(),now()+interval '1 hour');
grant select, update on trigger_acl_election_snapshot_probe to authenticated;

create temporary table trigger_acl_ledger_probe(id uuid, status text);
create trigger trigger_acl_ledger_probe_before_update
before update of status on trigger_acl_ledger_probe
for each row execute function mandate_private.guard_ledger_posting();
insert into trigger_acl_ledger_probe values (gen_random_uuid(),'pending');
grant select, update on trigger_acl_ledger_probe to authenticated;
-- The guard queries ledger_entries; grant SELECT only inside this rollback-only test.
grant select on public.ledger_entries to authenticated;

set local role authenticated;

update trigger_acl_updated_at_probe set updated_at='2001-01-01T00:00:00Z';
do $$
begin
  if not exists (select 1 from trigger_acl_updated_at_probe where updated_at > '2025-01-01T00:00:00Z') then
    raise exception 'SET_UPDATED_AT_TRIGGER_DID_NOT_RUN';
  end if;
end;
$$;

do $$
begin
  begin
    update trigger_acl_append_only_probe set id=2;
    raise exception 'APPEND_ONLY_TRIGGER_DID_NOT_RUN';
  exception when sqlstate '55000' then
    if sqlerrm <> 'APPEND_ONLY_RECORD' then raise; end if;
  end;
end;
$$;

do $$
begin
  begin
    update trigger_acl_election_snapshot_probe set rules_hash='new';
    raise exception 'ELECTION_SNAPSHOT_TRIGGER_DID_NOT_RUN';
  exception when sqlstate '55000' then
    if sqlerrm <> 'ELECTION_RULES_FROZEN' then raise; end if;
  end;
end;
$$;

do $$
begin
  begin
    update trigger_acl_ledger_probe set status='posted';
    raise exception 'LEDGER_GUARD_TRIGGER_DID_NOT_RUN';
  exception when sqlstate '23514' then
    if sqlerrm <> 'LEDGER_TRANSACTION_UNBALANCED' then raise; end if;
  end;
end;
$$;

reset role;
rollback;
