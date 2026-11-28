-- Supporting indexes and explicit API-deny RLS policies for the platform release tables.
create index if not exists platform_operator_bootstrap_allowlist_consumed_by_idx
  on mandate_private.platform_operator_bootstrap_allowlist(consumed_by);

create index if not exists platform_operators_granted_by_idx
  on mandate_private.platform_operators(granted_by);

create index if not exists platform_paid_voting_release_audit_actor_idx
  on mandate_private.platform_paid_voting_release_audit(actor_id,created_at desc);

create index if not exists platform_paid_voting_release_audit_election_idx
  on mandate_private.platform_paid_voting_release_audit(election_id,created_at desc);

create index if not exists platform_paid_voting_release_audit_requirement_idx
  on mandate_private.platform_paid_voting_release_audit(requirement_key,created_at desc);

create index if not exists platform_paid_voting_release_audit_created_idx
  on mandate_private.platform_paid_voting_release_audit(created_at desc);

create index if not exists platform_paid_voting_release_requirements_reviewed_by_idx
  on mandate_private.platform_paid_voting_release_requirements(reviewed_by);

create policy platform_authorization_guard_deny_api
  on mandate_private.platform_authorization_guard
  for all to anon,authenticated using (false) with check (false);

create policy platform_operator_bootstrap_allowlist_deny_api
  on mandate_private.platform_operator_bootstrap_allowlist
  for all to anon,authenticated using (false) with check (false);

create policy platform_operators_deny_api
  on mandate_private.platform_operators
  for all to anon,authenticated using (false) with check (false);

create policy platform_paid_voting_release_requirements_deny_api
  on mandate_private.platform_paid_voting_release_requirements
  for all to anon,authenticated using (false) with check (false);

create policy platform_paid_voting_release_audit_deny_api
  on mandate_private.platform_paid_voting_release_audit
  for all to anon,authenticated using (false) with check (false);
