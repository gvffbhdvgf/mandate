-- Record every verified Paystack receipt in a balanced suspense ledger posting.
-- This is deliberately not purpose allocation or revenue recognition. Until approved
-- accounting/custody rules are implemented, receipts remain unallocated in suspense.

create unique index if not exists ledger_accounts_global_code_uq
  on public.ledger_accounts(owner_type, currency, account_code)
  where organization_id is null;

create or replace function mandate_private.capture_verified_payment_receipt()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_clearing_account uuid;
  v_suspense_account uuid;
  v_posting jsonb;
begin
  if new.status = 'success' and old.status is distinct from new.status then
    if new.provider <> 'paystack'
      or new.provider_transaction_id is null
      or new.verified_at is null
      or new.amount_minor <= 0
      or new.currency <> 'KES' then
      raise exception 'VERIFIED_PAYMENT_RECEIPT_FIELDS_REQUIRED' using errcode = '23514';
    end if;

    insert into public.ledger_accounts(owner_type, organization_id, currency, account_code)
    values ('provider_clearing', null, new.currency, 'paystack-receivable')
    on conflict (owner_type, currency, account_code) where organization_id is null do nothing;

    insert into public.ledger_accounts(owner_type, organization_id, currency, account_code)
    values ('suspense', null, new.currency, 'unallocated-payment-receipts')
    on conflict (owner_type, currency, account_code) where organization_id is null do nothing;

    select id into strict v_clearing_account
    from public.ledger_accounts
    where owner_type = 'provider_clearing'
      and organization_id is null
      and currency = new.currency
      and account_code = 'paystack-receivable';

    select id into strict v_suspense_account
    from public.ledger_accounts
    where owner_type = 'suspense'
      and organization_id is null
      and currency = new.currency
      and account_code = 'unallocated-payment-receipts';

    v_posting := mandate_private.post_ledger_transaction(
      'payment_receipt_pending_allocation',
      'payment_intent',
      new.id,
      'paystack-payment-receipt:' || new.id::text,
      'Verified Paystack receipt pending purpose allocation',
      jsonb_build_array(
        jsonb_build_object(
          'account_id', v_clearing_account,
          'direction', 'debit',
          'amount_minor', new.amount_minor,
          'currency', new.currency
        ),
        jsonb_build_object(
          'account_id', v_suspense_account,
          'direction', 'credit',
          'amount_minor', new.amount_minor,
          'currency', new.currency
        )
      )
    );

    if v_posting->>'status' <> 'posted' then
      raise exception 'VERIFIED_PAYMENT_RECEIPT_LEDGER_POST_FAILED' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function mandate_private.capture_verified_payment_receipt()
  from public, anon, authenticated;

create trigger payment_intents_capture_verified_receipt
after update of status on public.payment_intents
for each row
when (new.status = 'success' and old.status is distinct from new.status)
execute function mandate_private.capture_verified_payment_receipt();

comment on function mandate_private.capture_verified_payment_receipt()
  is 'Atomically posts verified Paystack receipts to provider clearing and unallocated suspense. Does not classify revenue, organization funds, vote-credit liabilities or processor fees.';
