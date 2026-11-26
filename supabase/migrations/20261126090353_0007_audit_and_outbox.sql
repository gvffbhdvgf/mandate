create table public.audit_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id) on delete restrict,
 election_id uuid references public.elections(id) on delete restrict, actor_id uuid references auth.users(id) on delete set null,
 actor_type text not null check (actor_type in ('user','system','provider','platform_operator')),
 action text not null, entity_type text not null, entity_id uuid, reason text, request_id uuid,
 redacted_metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index audit_events_org_created_idx on public.audit_events(organization_id,created_at desc);
create index audit_events_election_created_idx on public.audit_events(election_id,created_at desc);
create table public.outbox_jobs (
 id uuid primary key default gen_random_uuid(), job_type text not null, idempotency_key text not null unique,
 payload_redacted jsonb not null default '{}'::jsonb,
 status text not null default 'queued' check (status in ('queued','running','retry','dead','completed')),
 attempts integer not null default 0 check (attempts >= 0), next_run_at timestamptz not null default now(),
 last_error_redacted text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), completed_at timestamptz
);
create index outbox_jobs_ready_idx on public.outbox_jobs(status,next_run_at) where status in ('queued','retry');
create trigger outbox_jobs_set_updated_at before update on public.outbox_jobs for each row execute function mandate_private.set_updated_at();
alter table public.audit_events enable row level security;
alter table public.outbox_jobs enable row level security;
revoke all on public.audit_events,public.outbox_jobs from anon,authenticated;
create or replace function mandate_private.prevent_append_only_mutation()
returns trigger language plpgsql set search_path = pg_catalog
as $$ begin raise exception 'APPEND_ONLY_RECORD' using errcode = '55000'; end; $$;
create trigger audit_events_append_only before update or delete on public.audit_events for each row execute function mandate_private.prevent_append_only_mutation();
create trigger ledger_entries_append_only before update or delete on public.ledger_entries for each row execute function mandate_private.prevent_append_only_mutation();
create trigger ledger_transactions_posted_immutable before update or delete on public.ledger_transactions
for each row when (old.status = 'posted') execute function mandate_private.prevent_append_only_mutation();
