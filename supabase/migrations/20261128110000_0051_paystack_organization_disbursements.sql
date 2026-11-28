-- Organization payout beneficiaries and Paystack transfer lifecycle.
-- Uses the existing double-entry organization_payable ledger; never stores wallet balances
-- or raw beneficiary account details in Mandate.

create table public.organization_payout_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  provider public.payment_provider not null default 'paystack' check (provider = 'paystack'),
  recipient_code text not null unique check (recipient_code ~ '^RCP_[A-Za-z0-9_-]{4,128}$'),
  recipient_type text not null check (recipient_type in ('mobile_money','mobile_money_business','kepss')),
  currency character(3) not null default 'KES' check (currency = 'KES'),
  beneficiary_name text not null check (length(btrim(beneficiary_name)) between 2 and 160),
  bank_code text not null check (length(btrim(bank_code)) between 2 and 32),
  masked_account text not null check (length(masked_account) between 3 and 32),
  active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  destination_confirmed_by uuid not null references auth.users(id) on delete restrict,
  destination_confirmed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index organization_payout_recipients_org_idx
  on public.organization_payout_recipients(organization_id, active, created_at desc);

alter table public.payout_requests
  alter column encrypted_destination_reference drop not null,
  add column recipient_id uuid references public.organization_payout_recipients(id) on delete restrict,
  add column provider_reference text unique,
  add column provider_transfer_code text,
  add column provider_status text,
  add column provider_fee_minor bigint check (provider_fee_minor is null or provider_fee_minor >= 0),
  add column failure_code text,
  add column failure_message text,
  add column initiated_at timestamptz,
  add column paid_at timestamptz,
  add constraint payout_requests_recipient_required
    check (recipient_id is not null or encrypted_destination_reference is not null);

create index payout_requests_organization_status_created_idx
  on public.payout_requests(organization_id, status, created_at desc);

create unique index payout_requests_provider_transfer_code_uq
  on public.payout_requests(provider_transfer_code)
  where provider_transfer_code is not null;

create table public.paystack_transfer_events (
  id uuid primary key default gen_random_uuid(),
  provider_event_key text not null unique,
  transfer_reference text not null,
  event_type text not null check (event_type in ('transfer.success','transfer.failed','transfer.reversed')),
  provider_transfer_code text,
  provider_status text,
  amount_minor bigint,
  currency character(3),
  signature_verified boolean not null default false,
  verification_source text not null default 'webhook' check (verification_source in ('webhook','api_verify')),
  redacted_payload jsonb not null default '{}'::jsonb,
  processing_status public.payment_event_status not null default 'received',
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index paystack_transfer_events_reference_idx
  on public.paystack_transfer_events(transfer_reference, received_at desc);

alter table public.organization_payout_recipients enable row level security;
alter table public.paystack_transfer_events enable row level security;
revoke all on public.organization_payout_recipients, public.paystack_transfer_events from public, anon, authenticated;
grant select, insert, update on public.organization_payout_recipients to service_role;
grant select, insert, update on public.paystack_transfer_events to service_role;

create trigger organization_payout_recipients_set_updated_at
before update on public.organization_payout_recipients
for each row execute function mandate_private.set_updated_at();

create or replace function mandate_private.request_organization_payout(
  p_organization_id uuid,
  p_recipient_id uuid,
  p_amount_minor bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_recipient public.organization_payout_recipients%rowtype;
  v_balance numeric;
  v_reserved numeric;
  v_request public.payout_requests%rowtype;
  v_reference text;
begin
  if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > 100000000000 then
    raise exception 'PAYOUT_AMOUNT_INVALID' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id=p_organization_id and m.user_id=v_user
      and m.status='active' and m.role in ('owner','admin','finance_manager')
  ) then raise exception 'FORBIDDEN' using errcode='42501'; end if;

  perform 1 from public.organizations where id=p_organization_id for update;
  if not found then raise exception 'ORGANIZATION_NOT_FOUND' using errcode='P0002'; end if;

  select * into v_recipient
  from public.organization_payout_recipients
  where id=p_recipient_id and organization_id=p_organization_id and active=true
  for share;
  if not found or v_recipient.currency <> 'KES' then
    raise exception 'PAYOUT_RECIPIENT_UNAVAILABLE' using errcode='23514';
  end if;

  select coalesce(sum(case when le.direction='credit' then le.amount_minor else -le.amount_minor end),0)
    into v_balance
  from public.ledger_accounts la
  join public.ledger_entries le on le.account_id=la.id
  join public.ledger_transactions lt on lt.id=le.transaction_id and lt.status='posted'
  where la.owner_type='organization_payable'
    and la.organization_id=p_organization_id
    and la.currency='KES';

  select coalesce(sum(amount_minor),0) into v_reserved
  from public.payout_requests
  where organization_id=p_organization_id
    and status in ('requested','under_review','approved','processing');

  if p_amount_minor > v_balance - v_reserved then
    raise exception 'INSUFFICIENT_RECONCILED_ORGANIZATION_FUNDS' using errcode='23514';
  end if;

  v_reference := 'mandate-payout-' || replace(gen_random_uuid()::text,'-','');
  insert into public.payout_requests(
    organization_id, amount_minor, currency, status, encrypted_destination_reference,
    recipient_id, provider_reference, requested_by
  ) values (
    p_organization_id, p_amount_minor, 'KES', 'requested', null,
    p_recipient_id, v_reference, v_user
  ) returning * into v_request;

  insert into public.audit_events(
    organization_id, actor_id, actor_type, action, entity_type, entity_id, redacted_metadata
  ) values (
    p_organization_id, v_user, 'user', 'organization.payout_requested',
    'payout_request', v_request.id,
    jsonb_build_object('amountMinor',p_amount_minor,'currency','KES','recipientId',p_recipient_id,'reference',v_reference)
  );

  return jsonb_build_object(
    'payoutRequestId',v_request.id,'reference',v_reference,'amountMinor',v_request.amount_minor,
    'currency',v_request.currency,'status',v_request.status
  );
end;
$$;

create or replace function public.request_organization_payout(
  p_organization_id uuid, p_recipient_id uuid, p_amount_minor bigint
)
returns jsonb language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.request_organization_payout($1,$2,$3); $$;

revoke all on function mandate_private.request_organization_payout(uuid,uuid,bigint) from public,anon;
revoke all on function public.request_organization_payout(uuid,uuid,bigint) from public,anon;
grant execute on function mandate_private.request_organization_payout(uuid,uuid,bigint) to authenticated;
grant execute on function public.request_organization_payout(uuid,uuid,bigint) to authenticated;

create or replace function mandate_private.approve_organization_payout(p_payout_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_request public.payout_requests%rowtype;
begin
  if v_user is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  select * into v_request from public.payout_requests where id=p_payout_request_id for update;
  if not found then raise exception 'PAYOUT_REQUEST_NOT_FOUND' using errcode='P0002'; end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id=v_request.organization_id and m.user_id=v_user
      and m.status='active' and m.role in ('owner','admin','finance_manager')
  ) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_request.requested_by=v_user then raise exception 'PAYOUT_DUAL_CONTROL_REQUIRED' using errcode='42501'; end if;
  if v_request.status not in ('requested','under_review') then
    raise exception 'PAYOUT_REQUEST_NOT_APPROVABLE' using errcode='55000';
  end if;

  update public.payout_requests
  set status='approved', approved_by=v_user
  where id=v_request.id;

  insert into public.audit_events(
    organization_id, actor_id, actor_type, action, entity_type, entity_id, redacted_metadata
  ) values (
    v_request.organization_id, v_user, 'user', 'organization.payout_approved',
    'payout_request', v_request.id,
    jsonb_build_object('amountMinor',v_request.amount_minor,'currency',v_request.currency,'reference',v_request.provider_reference)
  );

  return jsonb_build_object('payoutRequestId',v_request.id,'status','approved');
end;
$$;

create or replace function public.approve_organization_payout(p_payout_request_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog
as $$ select mandate_private.approve_organization_payout($1); $$;

revoke all on function mandate_private.approve_organization_payout(uuid) from public,anon;
revoke all on function public.approve_organization_payout(uuid) from public,anon;
grant execute on function mandate_private.approve_organization_payout(uuid) to authenticated;
grant execute on function public.approve_organization_payout(uuid) to authenticated;

create or replace function mandate_private.claim_organization_payout(p_payout_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_request public.payout_requests%rowtype;
  v_recipient public.organization_payout_recipients%rowtype;
  v_balance numeric;
  v_reserved numeric;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501';
  end if;

  select * into v_request from public.payout_requests where id=p_payout_request_id for update;
  if not found then raise exception 'PAYOUT_REQUEST_NOT_FOUND' using errcode='P0002'; end if;
  if v_request.status='processing' then
    select * into v_recipient from public.organization_payout_recipients where id=v_request.recipient_id;
    return jsonb_build_object(
      'payoutRequestId',v_request.id,'reference',v_request.provider_reference,
      'amountMinor',v_request.amount_minor,'currency',v_request.currency,
      'recipientCode',v_recipient.recipient_code,'status','processing','duplicate',true
    );
  end if;
  if v_request.status <> 'approved' or v_request.approved_by is null
    or v_request.approved_by=v_request.requested_by then
    raise exception 'PAYOUT_REQUEST_NOT_APPROVED' using errcode='55000';
  end if;

  select * into v_recipient from public.organization_payout_recipients
  where id=v_request.recipient_id and organization_id=v_request.organization_id and active=true
  for share;
  if not found then raise exception 'PAYOUT_RECIPIENT_UNAVAILABLE' using errcode='23514'; end if;

  perform 1 from public.organizations where id=v_request.organization_id for update;
  if not found then raise exception 'ORGANIZATION_NOT_FOUND' using errcode='P0002'; end if;
  select coalesce(sum(case when le.direction='credit' then le.amount_minor else -le.amount_minor end),0)
    into v_balance
  from public.ledger_accounts la
  join public.ledger_entries le on le.account_id=la.id
  join public.ledger_transactions lt on lt.id=le.transaction_id and lt.status='posted'
  where la.owner_type='organization_payable'
    and la.organization_id=v_request.organization_id and la.currency='KES';
  select coalesce(sum(amount_minor),0) into v_reserved
  from public.payout_requests
  where organization_id=v_request.organization_id
    and status in ('requested','under_review','approved','processing');
  if v_balance < v_reserved then
    raise exception 'ORGANIZATION_PAYOUT_RESERVATION_EXCEEDS_LEDGER_BALANCE' using errcode='23514';
  end if;

  update public.payout_requests
  set status='processing', initiated_at=coalesce(initiated_at,now())
  where id=v_request.id returning * into v_request;

  return jsonb_build_object(
    'payoutRequestId',v_request.id,'reference',v_request.provider_reference,
    'amountMinor',v_request.amount_minor,'currency',v_request.currency,
    'recipientCode',v_recipient.recipient_code,'status','processing','duplicate',false
  );
end;
$$;

revoke all on function mandate_private.claim_organization_payout(uuid) from public,anon,authenticated;
grant execute on function mandate_private.claim_organization_payout(uuid) to service_role;

create or replace function mandate_private.apply_paystack_transfer_status(
  p_event_id uuid,
  p_transfer_reference text,
  p_provider_transfer_code text,
  p_provider_status text,
  p_amount_minor bigint,
  p_currency text,
  p_provider_fee_minor bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_event public.paystack_transfer_events%rowtype;
  v_request public.payout_requests%rowtype;
  v_payable uuid;
  v_clearing uuid;
  v_fee uuid;
  v_posting jsonb;
  v_reversal_posting jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501';
  end if;
  if p_transfer_reference is null or p_provider_transfer_code is null
    or p_provider_status not in ('success','failed','reversed','abandoned','blocked','rejected')
    or p_amount_minor is null or p_amount_minor <= 0 or p_currency <> 'KES'
    or (p_provider_fee_minor is not null and p_provider_fee_minor < 0) then
    raise exception 'TRANSFER_VERIFICATION_FACTS_INVALID' using errcode='22023';
  end if;

  select * into v_event from public.paystack_transfer_events where id=p_event_id for update;
  if not found or (v_event.signature_verified is distinct from true and v_event.verification_source <> 'api_verify')
    or v_event.transfer_reference is distinct from p_transfer_reference
    or v_event.event_type not in ('transfer.success','transfer.failed','transfer.reversed') then
    raise exception 'INVALID_VERIFIED_TRANSFER_EVENT' using errcode='22023';
  end if;
  if v_event.processing_status='processed' then
    return jsonb_build_object('duplicate',true,'processed',true);
  end if;

  select * into v_request from public.payout_requests
  where provider_reference=p_transfer_reference for update;
  if not found then
    update public.paystack_transfer_events set processing_status='failed'
    where id=v_event.id;
    return jsonb_build_object('processed',false,'reason','PAYOUT_REQUEST_NOT_FOUND');
  end if;
  if v_request.amount_minor <> p_amount_minor or v_request.currency <> p_currency then
    update public.paystack_transfer_events set processing_status='failed'
    where id=v_event.id;
    return jsonb_build_object('processed',false,'reason','TRANSFER_AMOUNT_OR_CURRENCY_MISMATCH');
  end if;

  if p_provider_status='success' then
    if p_provider_fee_minor is null then
      update public.paystack_transfer_events set processing_status='failed'
      where id=v_event.id;
      return jsonb_build_object('processed',false,'reason','TRANSFER_FEE_FACT_REQUIRED');
    end if;
    if v_request.status='paid' and v_request.provider_transfer_code=p_provider_transfer_code then
      update public.paystack_transfer_events set processing_status='processed',processed_at=now()
      where id=v_event.id;
      return jsonb_build_object('duplicate',true,'processed',true,'status','paid');
    end if;
    if v_request.status not in ('processing','failed') then
      raise exception 'PAYOUT_STATE_NOT_SETTLEABLE' using errcode='55000';
    end if;

    insert into public.ledger_accounts(owner_type,organization_id,currency,account_code)
    values ('organization_payable',v_request.organization_id,'KES','organization-payouts-payable')
    on conflict (owner_type,organization_id,currency,account_code) do nothing;
    insert into public.ledger_accounts(owner_type,organization_id,currency,account_code)
    values ('provider_clearing',null,'KES','paystack-transfer-balance')
    on conflict (owner_type,currency,account_code) where organization_id is null do nothing;
    insert into public.ledger_accounts(owner_type,organization_id,currency,account_code)
    values ('processor_fee',null,'KES','paystack-transfer-fees')
    on conflict (owner_type,currency,account_code) where organization_id is null do nothing;

    select id into strict v_payable from public.ledger_accounts
    where owner_type='organization_payable' and organization_id=v_request.organization_id
      and currency='KES' and account_code='organization-payouts-payable';
    select id into strict v_clearing from public.ledger_accounts
    where owner_type='provider_clearing' and organization_id is null
      and currency='KES' and account_code='paystack-transfer-balance';
    select id into strict v_fee from public.ledger_accounts
    where owner_type='processor_fee' and organization_id is null
      and currency='KES' and account_code='paystack-transfer-fees';

    v_posting := mandate_private.post_ledger_transaction(
      'organization_payout_paid','payout_request',v_request.id,
      'paystack-transfer-settlement:'||v_request.id::text,
      'Verified Paystack transfer paid to organization beneficiary',
      case when p_provider_fee_minor=0 then
        jsonb_build_array(
          jsonb_build_object('account_id',v_payable,'direction','debit','amount_minor',v_request.amount_minor,'currency','KES'),
          jsonb_build_object('account_id',v_clearing,'direction','credit','amount_minor',v_request.amount_minor,'currency','KES')
        )
      else
        jsonb_build_array(
          jsonb_build_object('account_id',v_payable,'direction','debit','amount_minor',v_request.amount_minor,'currency','KES'),
          jsonb_build_object('account_id',v_fee,'direction','debit','amount_minor',p_provider_fee_minor,'currency','KES'),
          jsonb_build_object('account_id',v_clearing,'direction','credit','amount_minor',v_request.amount_minor+p_provider_fee_minor,'currency','KES')
        )
      end
    );
    if v_posting->>'status'<>'posted' then raise exception 'PAYOUT_LEDGER_POST_FAILED' using errcode='23514'; end if;

    update public.payout_requests set status='paid',provider_transfer_code=p_provider_transfer_code,
      provider_status='success',provider_fee_minor=p_provider_fee_minor,paid_at=now(),
      failure_code=null,failure_message=null
    where id=v_request.id;
    insert into public.audit_events(
      organization_id,actor_type,action,entity_type,entity_id,redacted_metadata
    ) values (
      v_request.organization_id,'provider','organization.payout_paid','payout_request',v_request.id,
      jsonb_build_object('amountMinor',v_request.amount_minor,'currency','KES',
        'transferCode',p_provider_transfer_code,'providerFeeMinor',p_provider_fee_minor)
    );
  elsif p_provider_status='reversed' and v_request.status='paid' then
    select id into strict v_payable from public.ledger_accounts
    where owner_type='organization_payable' and organization_id=v_request.organization_id
      and currency='KES' and account_code='organization-payouts-payable';
    select id into strict v_clearing from public.ledger_accounts
    where owner_type='provider_clearing' and organization_id is null
      and currency='KES' and account_code='paystack-transfer-balance';

    v_reversal_posting := mandate_private.post_ledger_transaction(
      'organization_payout_reversed','payout_request',v_request.id,
      'paystack-transfer-reversal:'||v_request.id::text,
      'Verified Paystack transfer reversal restored organization payable principal',
      jsonb_build_array(
        jsonb_build_object('account_id',v_clearing,'direction','debit','amount_minor',v_request.amount_minor,'currency','KES'),
        jsonb_build_object('account_id',v_payable,'direction','credit','amount_minor',v_request.amount_minor,'currency','KES')
      )
    );
    if v_reversal_posting->>'status'<>'posted' then raise exception 'PAYOUT_REVERSAL_LEDGER_POST_FAILED' using errcode='23514'; end if;
    update public.payout_requests set status='failed',provider_transfer_code=p_provider_transfer_code,
      provider_status='reversed',failure_code='TRANSFER_REVERSED',
      failure_message='Paystack reversed the transfer; the organization payable principal was restored.'
    where id=v_request.id;
    insert into public.audit_events(
      organization_id,actor_type,action,entity_type,entity_id,redacted_metadata
    ) values (
      v_request.organization_id,'provider','organization.payout_reversed','payout_request',v_request.id,
      jsonb_build_object('amountMinor',v_request.amount_minor,'currency','KES','transferCode',p_provider_transfer_code)
    );
  else
    if v_request.status='paid' then
      raise exception 'PAID_PAYOUT_REQUIRES_TRANSFER_REVERSAL' using errcode='55000';
    end if;
    update public.payout_requests set status='failed',provider_transfer_code=p_provider_transfer_code,
      provider_status=p_provider_status,failure_code='TRANSFER_'||upper(p_provider_status),
      failure_message='Paystack did not complete this transfer; review the provider status before requesting another payout.'
    where id=v_request.id;
    insert into public.audit_events(
      organization_id,actor_type,action,entity_type,entity_id,redacted_metadata
    ) values (
      v_request.organization_id,'provider','organization.payout_failed','payout_request',v_request.id,
      jsonb_build_object('amountMinor',v_request.amount_minor,'currency','KES',
        'transferCode',p_provider_transfer_code,'providerStatus',p_provider_status)
    );
  end if;

  update public.paystack_transfer_events set processing_status='processed',processed_at=now()
  where id=v_event.id;
  return jsonb_build_object('processed',true,'status',case when p_provider_status='success' then 'paid' else 'failed' end);
end;
$$;

revoke all on function mandate_private.apply_paystack_transfer_status(uuid,text,text,text,bigint,text,bigint)
  from public,anon,authenticated;
grant execute on function mandate_private.apply_paystack_transfer_status(uuid,text,text,text,bigint,text,bigint)
  to service_role;

comment on table public.organization_payout_recipients is
  'Server-only Paystack beneficiaries. Mandate stores provider recipient code and masked destination only; raw account details remain with Paystack.';
comment on table public.paystack_transfer_events is
  'Signed, redacted Paystack transfer webhook events; final statuses are verified with Paystack before ledger posting.';
comment on table public.payout_requests is
  'Organization payout requests require separate requester and approver identities; only verified Paystack transfer success posts ledger settlement.';
