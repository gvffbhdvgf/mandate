-- Cover the optional setup-confirmation actor foreign key.
create index if not exists elections_setup_confirmed_by_idx
  on public.elections(setup_confirmed_by);
