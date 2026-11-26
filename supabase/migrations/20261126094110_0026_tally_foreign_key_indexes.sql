create index if not exists election_tallies_organization_idx on public.election_tallies(organization_id);
create index if not exists election_tallies_created_by_idx on public.election_tallies(created_by);
create index if not exists election_tally_results_organization_idx on public.election_tally_results(organization_id);
create index if not exists election_tally_results_contest_idx on public.election_tally_results(contest_id);
create index if not exists election_tally_results_option_idx on public.election_tally_results(option_id);
