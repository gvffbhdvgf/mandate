create or replace function mandate_private.is_org_member(p_organization_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select exists(select 1 from public.organization_members m where m.organization_id=p_organization_id and m.user_id=auth.uid() and m.status='active'); $$;
create or replace function mandate_private.has_org_role(p_organization_id uuid,p_roles public.organization_role[])
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select exists(select 1 from public.organization_members m where m.organization_id=p_organization_id and m.user_id=auth.uid() and m.status='active' and m.role=any(p_roles)); $$;
create or replace function mandate_private.can_manage_election(p_election_id uuid,p_roles public.organization_role[])
returns boolean language sql stable security definer set search_path=pg_catalog
as $$ select exists(select 1 from public.elections e join public.organization_members m on m.organization_id=e.organization_id where e.id=p_election_id and m.user_id=auth.uid() and m.status='active' and m.role=any(p_roles)); $$;
revoke all on function mandate_private.is_org_member(uuid) from public,anon;
revoke all on function mandate_private.has_org_role(uuid,public.organization_role[]) from public,anon;
revoke all on function mandate_private.can_manage_election(uuid,public.organization_role[]) from public,anon;
grant usage on schema mandate_private to authenticated;
grant execute on function mandate_private.is_org_member(uuid) to authenticated;
grant execute on function mandate_private.has_org_role(uuid,public.organization_role[]) to authenticated;
grant execute on function mandate_private.can_manage_election(uuid,public.organization_role[]) to authenticated;
create policy organizations_select_member on public.organizations for select to authenticated using (mandate_private.is_org_member(id));
create policy organizations_update_admin on public.organizations for update to authenticated
using (mandate_private.has_org_role(id,array['owner','admin']::public.organization_role[]))
with check (mandate_private.has_org_role(id,array['owner','admin']::public.organization_role[]));
create policy members_select_self_or_admin on public.organization_members for select to authenticated
using (user_id=(select auth.uid()) or mandate_private.has_org_role(organization_id,array['owner','admin']::public.organization_role[]));
create policy elections_select_member on public.elections for select to authenticated using (mandate_private.is_org_member(organization_id));
create policy elections_insert_manager on public.elections for insert to authenticated
with check (created_by=(select auth.uid()) and mandate_private.has_org_role(organization_id,array['owner','admin','election_manager']::public.organization_role[]) and status='draft');
create policy elections_update_draft_manager on public.elections for update to authenticated
using (status='draft' and mandate_private.has_org_role(organization_id,array['owner','admin','election_manager']::public.organization_role[]))
with check (status='draft' and mandate_private.has_org_role(organization_id,array['owner','admin','election_manager']::public.organization_role[]));
create policy contests_select_member on public.contests for select to authenticated using (mandate_private.is_org_member(organization_id));
create policy contests_manage_draft on public.contests for all to authenticated
using (mandate_private.can_manage_election(election_id,array['owner','admin','election_manager']::public.organization_role[]) and exists(select 1 from public.elections e where e.id=election_id and e.status='draft'))
with check (mandate_private.can_manage_election(election_id,array['owner','admin','election_manager']::public.organization_role[]) and exists(select 1 from public.elections e where e.id=election_id and e.status='draft'));
create policy options_select_member on public.options for select to authenticated using (mandate_private.is_org_member(organization_id));
create policy options_manage_draft on public.options for all to authenticated
using (mandate_private.can_manage_election(election_id,array['owner','admin','election_manager']::public.organization_role[]) and exists(select 1 from public.elections e where e.id=election_id and e.status='draft'))
with check (mandate_private.can_manage_election(election_id,array['owner','admin','election_manager']::public.organization_role[]) and exists(select 1 from public.elections e where e.id=election_id and e.status='draft'));
create policy voters_read_managers on public.election_voters for select to authenticated
using (mandate_private.can_manage_election(election_id,array['owner','admin','election_manager','returning_officer']::public.organization_role[]));
create policy voters_manage_draft on public.election_voters for all to authenticated
using (mandate_private.can_manage_election(election_id,array['owner','admin','election_manager']::public.organization_role[]) and exists(select 1 from public.elections e where e.id=election_id and e.status='draft'))
with check (mandate_private.can_manage_election(election_id,array['owner','admin','election_manager']::public.organization_role[]) and exists(select 1 from public.elections e where e.id=election_id and e.status='draft'));
create policy import_batches_manage on public.import_batches for all to authenticated
using (mandate_private.can_manage_election(election_id,array['owner','admin','election_manager','returning_officer']::public.organization_role[]))
with check (mandate_private.can_manage_election(election_id,array['owner','admin','election_manager']::public.organization_role[]));
create policy import_rows_manage on public.import_rows for all to authenticated
using (exists(select 1 from public.import_batches b where b.id=batch_id and mandate_private.can_manage_election(b.election_id,array['owner','admin','election_manager','returning_officer']::public.organization_role[])))
with check (exists(select 1 from public.import_batches b where b.id=batch_id and mandate_private.can_manage_election(b.election_id,array['owner','admin','election_manager']::public.organization_role[])));
create policy audit_read_org_admin on public.audit_events for select to authenticated
using (organization_id is not null and mandate_private.has_org_role(organization_id,array['owner','admin','election_manager','returning_officer','finance_manager']::public.organization_role[]));
grant select,update on public.profiles to authenticated;
grant select,update on public.organizations to authenticated;
grant select on public.organization_members to authenticated;
grant select,insert,update on public.elections to authenticated;
grant select,insert,update,delete on public.contests,public.options to authenticated;
grant select,insert,update on public.election_voters,public.import_batches,public.import_rows to authenticated;
grant select on public.audit_events to authenticated;
revoke all on public.public_participants,public.participant_access_tokens,public.ballots,public.ballot_submission_controls,public.vote_credit_lots,public.vote_credit_consumptions,public.payment_intents,public.payment_events,public.ledger_accounts,public.ledger_transactions,public.ledger_entries,public.payout_requests,public.outbox_jobs from anon,authenticated;
