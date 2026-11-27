# Shared-revenue accounting and settlement design

**Status:** Design baseline from the accepted commercial decision dated 27 November 2026. This document does not authorize production schema changes, live checkout, fund custody, transfers or payouts.

## Accepted commercial model

Mandate receives an agreed platform fee for each public paid-voting election. The remaining proceeds attributable to that election belong to its organizer under a documented commercial agreement.

The platform-fee amount or percentage has **not** been selected. Do not infer a percentage, fixed fee, processor-fee allocation, tax treatment, or payment timing. The registered-election service fee (KES 20 per eligible voter, KES 500 minimum) is a separate product fee and must not be reused as the public-voting revenue split.

## Accounting invariants

- Use integer minor units and one currency per ledger transaction. Never use floating-point money.
- Preserve immutable provider facts separately from the expected payment intent.
- Every posting is balanced, append-only, and idempotent with a stable source identity.
- Keep each election's economics separable in the subledger, even where Paystack settles multiple elections in one merchant settlement.
- A ledger liability is not cash in a bank account. Organizer balances remain held/unsettled until provider settlement and bank evidence reconcile and all contractual release conditions are satisfied.
- Never expose held organizer proceeds as withdrawable or initiate a transfer before explicit provider, legal, KYC, tax and operational approval.
- Ballot choices, candidate IDs, voter contact details and participant identities must never enter payment metadata or accounting descriptions.

## Current implemented receipt stage

Migration 0037/0039 currently records a server-verified KES provider receipt as:

1. Debit Paystack provider clearing / receivable.
2. Credit unallocated payment-receipts suspense.

The posting uses the actual provider-reported amount, not the expected client-visible amount. This is intentionally an interim holding entry. It is not revenue recognition, organizer allocation, processor-fee accounting or proof of bank settlement.

Migration 0044 imports settlement and transaction evidence; its reconciliation view compares provider rows with verified payment facts and the interim receipt. A match to the receipt is not a bank reconciliation.

## Required accounting lifecycle

### 1. Verified collection

Accept a payment only after server-side provider verification, exact reference/amount/currency checks, and the existing idempotency and terminal-state protections. Any mismatch, refund, reversal or dispute remains an exception and must not be allocated automatically.

### 2. Election-level allocation (not yet implemented)

After an approved fee policy is recorded on the payment intent/election and the allocation is contractually authorized, the accounting service may move the verified gross receipt out of suspense into explicitly named balances:

- Mandate platform-fee revenue (or deferred revenue if the accounting policy requires deferral).
- Organizer proceeds payable (a liability, never Mandate revenue).

The allocation must sum exactly to the verified gross receipt. The platform fee must be server-derived from an active, versioned policy, snapshotted before checkout and immutable for that payment. The organizer remainder is calculated only after that approved fee is known. Reject a fee greater than the gross receipt; do not silently clamp or create a negative organizer balance.

**Unresolved accounting policy:** public vote credits are prepaid entitlements. The point at which Mandate's platform fee and organizer proceeds become earned/payable (purchase, credit consumption, election close, refund window expiry, or another defined event) needs accounting and commercial approval. Until decided, retain the receipt in suspense and do not claim earned revenue or organizer payable availability.

### 3. Processor fees and settlement-to-bank

Keep Paystack fees distinct from the gross receipt and from the Mandate/organizer split. The agreement must specify who bears those fees. Once provider settlement rows and actual bank credit evidence are available, reconcile gross transactions, provider fees, adjustments, and net bank credit at the batch level. A balanced settlement posting should reflect the actual bank net and provider fee amounts; do not infer the bank receipt from Paystack's settlement status alone.

No settlement-ready/live switch until the full importer pagination, operator review, aggregate reconciliation, bank evidence, exception handling and ledger posting path are implemented and tested.

### 4. Refunds, reversals and disputes

Do not auto-reverse on a webhook notification. Verify the provider resource and amount, distinguish partial from full refunds, and preserve the original posting. A reviewed adjustment must reference the original payment and allocate reversal amounts consistently across the original Mandate and organizer components, including any processor-fee treatment. Disputed amounts remain held; dispute resolution must not create duplicate credits or duplicate revenue.

### 5. Organizer settlement

No organizer transfer is allowed until all of the following are evidenced:

- Paystack written approval for the exact paid-voting use case and third-party recipient/payout structure.
- A direct, documented business relationship and signed agreement with each eligible organizer.
- Approved organizer identity/KYC, beneficiary ownership, sanctions/risk checks as applicable, and tax documentation.
- Clear ownership of refunds, chargebacks, disputes, processor fees and tax.
- Reconciled bank funds, a documented reserve/holdback policy, dual-control approval, limits, audit trail and idempotent payout references.
- A legal/privacy review of supported election types and the participant-data lifecycle.

A dashboard balance is informational until these controls are in place; it is not a promise of immediate payment.

## Required acceptance tests before allocation is enabled

- Gross receipt is captured exactly once, including duplicate webhook and callback delivery.
- Amount/currency/reference mismatch remains suspense/exception and cannot be allocated.
- Fee policy is versioned, server-only, immutable per intent and applied consistently on retries.
- For every allocation, Mandate fee + organizer entitlement equals verified gross (subject to separately approved fee/tax rules).
- No negative organizer entitlement; no cross-election netting.
- Processor fees reconcile to provider settlement evidence and the bank's net credit.
- Partial/full refund, reversal, chargeback and dispute cases cannot double-reverse, double-refund or release held funds.
- Organizer cannot view another organizer's ledger or trigger payout.
- Payout remains disabled by default and cannot be enabled by a browser role.
- Every operator action is authorized, dual-controlled where required, idempotent and audited.

## Dependencies and evidence

- Payment implementation: [PR #19](https://github.com/gvffbhdvgf/mandate/pull/19).
- Paystack Kenya Merchant Services Agreement: https://paystack.com/ke/terms
- Paystack settlement API: https://paystack.com/docs/api/settlement/
- Paystack settlement transactions: https://paystack.com/docs/payments/settlement-transactions/
- Paystack refund guidance: https://paystack.com/docs/payments/refunds/
- Paystack dispute guidance: https://paystack.com/docs/payments/manage-disputes/

**Release boundary:** PR #19 remains draft/unmerged. No production migrations, functions, flags, credentials, payments, refunds or payouts are changed by this design.
