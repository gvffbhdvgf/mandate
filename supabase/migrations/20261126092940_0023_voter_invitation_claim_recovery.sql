alter table public.election_voters
 add column if not exists invitation_attempted_at timestamptz;
create index if not exists election_voters_pending_invitation_idx
 on public.election_voters(election_id,invitation_attempted_at)
 where invited_at is null;
comment on column public.election_voters.invitation_attempted_at is
 'Server-side invitation claim timestamp. Stale claims can be retried; raw tokens are never stored.';
