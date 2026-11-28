# Paystack organization disbursements

## Scope

The disbursement workflow uses the existing Mandate double-entry ledger and Paystack's Kenya transfer API. It does not create stored-value wallets or editable balances. Organization balances are derived from posted ledger entries.

Supported Kenya destinations:
- Individual mobile-money recipient (mobile_money, e.g. M-Pesa MPESA).
- Kenya bank account (kepss).
- M-Pesa business Till (mobile_money_business, MPTILL).

Paybill recipients are not enabled in this first implementation because Paystack requires additional transfer details for that recipient type.

## Security and beneficiary data

- Only active organization owners, administrators and finance managers can register beneficiaries, request payouts, approve payouts or initiate/verify transfers.
- The requester and approver must be different users.
- Mandate stores the Paystack recipient code, beneficiary display name, bank code and masked account suffix. Raw account numbers are sent to Paystack over HTTPS and are not persisted in Mandate.
- A Paystack recipient code already linked to another organization cannot be reassigned.
- Browser roles have no direct access to recipient, payout or transfer-event tables. The Edge Function authenticates the user and uses service-role access only for server-side provider operations.
- Secrets remain in Supabase Edge Function secrets.

## Payout lifecycle

1. Organization finance registers a recipient through paystack-disbursements action create_recipient.
2. Finance requests a payout with request_payout. The database calculates the posted organization-payable ledger balance, subtracts all outstanding payout reservations, and rejects requests that exceed the available ledger liability.
3. A different active organization finance member approves the request using approve_payout.
4. An authorized organization finance member calls initiate_payout. The database claims the approved request and reserves it in processing; the Edge Function submits a transfer from the Mandate Paystack balance using the existing stable reference.
5. The API response is not final proof of payment. The function verifies immediately when the provider returns a terminal state; otherwise the signed Paystack webhook verifies the transfer and records the final state.
6. Only a provider-verified success posts the payout ledger transaction. failed releases the reservation. reversed after a prior success restores the organization-payable principal through a separate idempotent reversal posting.

If a transfer request times out, keep the request in processing and retry only with the same stored reference. Never create a new reference for an uncertain transfer.

## Accounting

A successful payout posts:
- Debit organization payable for the transfer principal.
- Debit Mandate processor-fee expense for the provider-reported transfer fee (when non-zero).
- Credit Paystack transfer balance for principal plus provider fee.

A verified reversal after a successful payout restores the principal to organization payable. Provider fee treatment on a reversal remains subject to Paystack's actual fee-return evidence and settlement reconciliation; do not assume fees are refunded.

The organization-payable ledger currently has no automatically generated organization-revenue allocations. Therefore this workflow cannot make funds withdrawable until a separately approved organization-revenue payment product posts verified, reconciled amounts to that account. Public paid vote-credit revenue remains Mandate-only.

## Environment and release

The Edge Function requires the existing mode-specific Paystack secret and webhook secret. Live transfers also require PAYSTACK_LIVE_TRANSACTIONS_ENABLED=true; the transfer path deliberately does not depend on the settlement-import readiness flag. Test mode uses the test key and webhook secret.

The webhook URL remains:
https://yhdosrhtzcsfqfuuqhsk.supabase.co/functions/v1/paystack-webhook

Paystack's final events are transfer.success, transfer.failed and transfer.reversed. The webhook verifies the raw request signature, then verifies the transfer against Paystack before applying any ledger changes.

## Provider references

- https://paystack.com/docs/v2/ke/disbursements
- https://paystack.com/docs/v2/ke/disbursements/transfers/recipients
- https://paystack.com/docs/v2/ke/disbursements/transfers/single-transfers
- https://paystack.com/docs/v2/ke/disbursements/transfers/how-transfers-work

A Paystack API response may still reject a transfer because of merchant eligibility, payout holds, recipient validity, amount limits or insufficient Paystack balance. Those are runtime provider outcomes, not hard-coded product prohibitions.
