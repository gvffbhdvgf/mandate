-- Trigger functions are invoked by existing triggers, not called directly by API roles.
-- Their default PUBLIC EXECUTE ACLs are unnecessary, especially because anon has
-- USAGE on mandate_private for the registered-voter RPC wrappers.
revoke execute on function mandate_private.set_updated_at() from public, anon, authenticated;
revoke execute on function mandate_private.prevent_append_only_mutation() from public, anon, authenticated;
revoke execute on function mandate_private.guard_election_snapshot() from public, anon, authenticated;
revoke execute on function mandate_private.guard_ledger_posting() from public, anon, authenticated;
