-- Private read-only evidence queue for Paystack payment exceptions.
-- It does not resolve refunds/disputes or move money/entitlements.

create or replace view public.paystack_payment_exception_queue
with (security_invoker = true)
as
select
  pi.id as payment_intent_id,
  pi.purpose as payment_purpose,
  pi.provider_reference,
  pi.status as payment_intent_status,
  pi.amount_minor as expected_amount_minor,
  pi.currency as expected_currency,
  pi.provider_transaction_id,
  pi.provider_status,
  pi.provider_amount_minor,
  pi.provider_currency,
  pi.verified_at,
  pi.created_at,
  exception_events.event_count,
  exception_events.event_types,
  exception_events.latest_event_at,
  settlement_rows.settlement_row_count,
  settlement_rows.reconciliation_statuses as settlement_reconciliation_statuses,
  exists (
    select 1
    from public.ledger_transactions lt
    where lt.idempotency_key = 'paystack-payment-receipt:' || pi.id::text
      and lt.status = 'posted'
  ) as receipt_posted
from public.payment_intents pi
left join lateral (
  select
    count(*)::integer as event_count,
    array_agg(distinct pe.event_type order by pe.event_type) as event_types,
    max(pe.received_at) as latest_event_at
  from public.payment_events pe
  where pe.provider = 'paystack'
    and pe.provider_reference = pi.provider_reference
    and (
      left(pe.event_type, 7) = 'refund.'
      or left(pe.event_type, 15) = 'charge.dispute.'
    )
) exception_events on true
left join lateral (
  select
    count(*)::integer as settlement_row_count,
    array_agg(distinct reconciliation.reconciliation_status order by reconciliation.reconciliation_status)
      as reconciliation_statuses
  from public.paystack_settlement_reconciliation reconciliation
  where reconciliation.provider_reference = pi.provider_reference
) settlement_rows on true
where pi.provider = 'paystack'
  and (pi.status = 'exception' or exception_events.event_count > 0);

revoke all on public.paystack_payment_exception_queue from public, anon, authenticated;
grant select on public.paystack_payment_exception_queue to service_role;

comment on view public.paystack_payment_exception_queue is
  'Server-only read-only evidence queue for Paystack payment exceptions. Does not automatically reverse ledger entries, revoke credits, settle disputes, allocate fees or authorize payouts.';
