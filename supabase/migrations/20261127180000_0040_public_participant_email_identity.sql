-- Link a verified Supabase Auth identity to an election-scoped public participant.
-- The Auth user owns the verified email; the participant table stores only a
-- pseudonymous identity hash and the Auth UUID. Ballots never reference either.

alter table public.public_participants
  add column auth_user_id uuid references auth.users(id) on delete restrict;

alter table public.public_participants
  add constraint public_participants_election_auth_user_key
  unique (election_id, auth_user_id);

comment on column public.public_participants.auth_user_id
  is 'Verified Supabase Auth identity for this election participant. Never copied to ballots, receipts, provider metadata or public results.';

comment on column public.public_participants.contact_hash
  is 'Pseudonymous SHA-256 identifier derived from the verified Supabase Auth user UUID; no email address or phone number is stored in this field.';

create index public_participants_auth_user_idx
  on public.public_participants(auth_user_id, election_id)
  where auth_user_id is not null;

revoke all on public.public_participants from anon, authenticated;
revoke all on public.participant_access_tokens from anon, authenticated;
