# Paystack integration

Mandate uses server-side Paystack Edge Functions. Provider credentials are supplied through Supabase Edge Function secrets and are never exposed to the browser. Test and live credentials are separate; the legacy shared `PAYSTACK_SECRET_KEY` and `PAYSTACK_WEBHOOK_SECRET` names are not accepted by the mode-aware adapter.

## Current production baseline — 28 November 2026

- Production Supabase migrations are applied through 0049_single_merchant_public_vote_payments.
- paystack-initialize, paystack-verify and paystack-webhook are deployed at v13; public-vote-credit-intent, public-participant-session and public-election-details are deployed at v2; paystack-settlement-import is deployed at v2.
- Registered-election platform fees and public vote-credit purchases use the same paystack-initialize hosted checkout and /payments/paystack/callback → paystack-verify path. Both server actions validate the returned HTTPS Paystack URL through lib/payments/paystack.ts.
- Mandate is the merchant and revenue owner for public vote-credit sales. The current design has no organizer proceeds, organizer subaccounts, split settlement, organizer liabilities or organizer payouts.
- The hosted database flags public_vote_credits_enabled, platform_fee_enabled and organization_topup_enabled are all false. No public-paid election has been authorized/opened.
- The settlement importer and read-only reconciliation/exception views are deployed, but the operator UI, aggregate bank reconciliation, reviewed exception resolution and final revenue/processor-fee/tax accounting are not complete. Keep the live settlement-readiness switch false.
- The recorded Poptra merchant profile is Live / Pre-Approved, Owner Verified, Agreement Accepted, Starter Business. This was recorded from prior dashboard evidence and was not independently rechecked in this session. Paystack guidance says Starter Business in Kenya has a KES 600,000 lifetime collection limit and no Transfers; this does not block the current single-merchant model but the limit applies.
- The previously exposed live secret must be rotated before any real-money operation. Paystack dashboard callback/webhook configuration and paid-vote-credit activity approval remain unverified.

## Commercial-model boundary and disbursements

- Public paid vote-credit purchases are collected by Mandate as merchant and revenue owner; organizations do not receive a share or payout from those receipts.
- Organization-revenue elections are a separate product model. The participant payment source and commercial allocation policy remain to be finalized; no organization-revenue allocation is currently posted to the organization-payable ledger.
- Service-only elections charge the organization the versioned per-eligible-voter fee (currently KES 20 per voter, KES 500 minimum).
- Organization Paystack disbursement backend is being implemented in PR #35. It uses the existing organization-payable ledger, beneficiary records and separate requester/approver identities. It cannot release funds until an approved organization-revenue collection has posted reconciled payable funds.
- The transfer capability uses the live payment master switch but is independent of the settlement-import readiness flag. Paystack remains authoritative for merchant eligibility, payout holds, destination validity, amount limits and available Paystack balance.
- See [Paystack organization disbursements](./paystack-disbursements.md) for the workflow and controls.

## Payment purposes

The supported product scope is three distinct purposes:

- `platform_fee`: payment owed to Mandate under an approved fee policy.
- `organization_topup`: funds attributable to an organization under an approved custody, beneficial-ownership and settlement policy.
- `public_vote_credits`: election-specific credit purchases sold by Mandate as merchant and revenue owner, requiring a scoped public-participant flow and provider confirmation for the actual merchant category/election types.

Each purpose has an independent mode-specific flag. A flag only permits the corresponding technical path to proceed; it does not establish pricing, accounting classification, legal eligibility, custody, settlement or payout authority. Organization payment intents require an active owner/admin/finance-manager; public-vote-credit intents use a separate verified, election-scoped participant-token path. No purpose is live-enabled by default.

## Platform service-fee policy — version 1

- **Accepted initial price:** KSh 20 per eligible registered voter per election, with a KSh 500 minimum. Currency is KES; all database values use integer minor units (KES 2,000 per eligible voter and KES 50,000 minimum).
- **Scope:** Applies to registered single-vote and registered weighted elections. Public paid-voting credits are a separate purpose and are not charged this service fee by this policy.
- **Source of truth:** Migration `0046_platform_fee_pricing_policy` seeds immutable-by-client policy version 1 in `platform_fee_policies`. The active policy is versioned; application clients cannot read or write the policy table directly.
- **Quote:** Finance-authorized owner/admin/finance-manager requests a server quote. The server counts only rows with `eligibility_status = 'eligible'`, calculates `max(count × 2,000, 50,000)` in KES minor units, and returns count, amount and policy version. The checkout action sends the displayed quote back only as an expected-value comparison; the server recalculates and rejects stale quotes.
- **Invoice and freeze:** The server creates an idempotent `platform_fee` payment intent and snapshots policy version, eligible-voter count and amount on the election. A fresh provider reference is created only for a new/retryable attempt. Once quoted, the voter register's identity, eligibility, weight and membership rows are frozen; invitation delivery and election opening require verified payment.
- **Payment:** Checkout uses the existing mode-specific Paystack initialization and verification paths. Only exact server-verified successful payment marks the platform fee paid. Failed/abandoned attempts can be retried with a new reference; uncertain, reversed, refunded or exception states require reconciliation and are not blindly retried.
- **Accounting boundary:** Verified receipts still post to provider clearing and unallocated suspense under the existing receipt foundation. This pricing implementation does not claim final revenue recognition, processor-fee, tax or net-to-bank allocation. Those remain settlement/accounting release gates.
- **No live switch:** Adding this policy does not enable test or live Paystack flags, deploy migrations/functions, or authorize a real charge. Payment purpose gates remain fail-closed.

## Mode configuration

Set exactly one `PAYSTACK_MODE` value: `test` or `live`.

| Secret / variable | Purpose |
|---|---|
| `PAYSTACK_MODE` | Selects the active environment; any other value fails closed |
| `PAYSTACK_TEST_SECRET_KEY` | Test API key; must begin `sk_test_` |
| `PAYSTACK_TEST_WEBHOOK_SECRET` | Test webhook signing secret |
| `PAYSTACK_LIVE_SECRET_KEY` | Live API key; must begin `sk_live_` |
| `PAYSTACK_LIVE_WEBHOOK_SECRET` | Live webhook signing secret |
| `PAYSTACK_LIVE_TRANSACTIONS_ENABLED` | Live-mode transaction master switch; must be exactly `true` |
| `PAYSTACK_LIVE_SETTLEMENT_PIPELINE_ENABLED` | Additional live-mode settlement-readiness switch; must be exactly `true` only after the complete payment-to-ledger and reconciliation path is implemented and verified |
| `PAYSTACK_TEST_PLATFORM_FEE_ENABLED` | Test-mode platform fee gate |
| `PAYSTACK_TEST_ORGANIZATION_TOPUP_ENABLED` | Test-mode organization top-up gate |
| `PAYSTACK_TEST_PUBLIC_VOTE_CREDITS_ENABLED` | Test-mode public vote credits gate |
| `PAYSTACK_LIVE_PLATFORM_FEE_ENABLED` | Live-mode platform fee gate |
| `PAYSTACK_LIVE_ORGANIZATION_TOPUP_ENABLED` | Live-mode organization top-up gate |
| `PAYSTACK_LIVE_PUBLIC_VOTE_CREDITS_ENABLED` | Live-mode public vote credits gate |
| `MANDATE_PAYMENT_CALLBACK_URL` | Optional HTTPS callback URL; must use the exact `/payments/paystack/callback` path and an origin in `MANDATE_SITE_URL` or `MANDATE_ALLOWED_ORIGINS`. If omitted, the callback is derived from `MANDATE_SITE_URL` when configured. |
| `MANDATE_ALLOWED_ORIGINS` | Optional comma-separated browser origins and explicitly allowlisted callback origins |

A purpose flag is enabled only when its mode-specific value is exactly `true`; missing flags are disabled. Live mode additionally requires both live master switches, a matching live key prefix and a live webhook secret. The settlement-readiness switch must remain unset until payment-to-ledger posting and reconciliation are actually wired and tested. The adapter never falls back from a missing mode-specific key to a shared/other-mode key.

## Edge Function behavior

- `paystack-initialize`: loads an existing server-created intent; amount, currency and reference come from the database. Requires the matching mode and purpose gates plus an active owner, admin or finance-manager role. A unique database claim serializes initialization per intent; completed requests reuse the stored checkout response, while in-flight or unknown outcomes fail closed and require reconciliation before retry. It validates the returned provider reference and HTTPS authorization URL. Public vote-credit initialization uses the separate verified participant-token path and derives price from the frozen election configuration.
- `paystack-verify`: verifies the provider transaction server-side and compares exact reference, amount and KES currency. Organization payment intents require an active owner, admin or finance-manager membership; election-manager membership alone is not financial authority. Compare-and-set updates are restricted to initialized/pending intents; terminal states cannot be overwritten by a late manual verification response. Repeated verification of the same successful transaction is idempotent. A verified transition to `success` atomically triggers the unallocated suspense receipt posting described below.
- `paystack-webhook`: verifies the timestamped `Paystack-Signature` HMAC over the exact raw body and deduplicates provider events. `charge.success` is verified with Paystack and applied through the row-locked payment RPC. Signed `refund.*` and `charge.dispute.*` events trigger a server-side verification of the original Paystack transaction, persist its actual provider status/amount/currency, and freeze the related payment in `exception` for reconciliation. If a refund/dispute event arrives before `charge.success`, the verified original KES receipt is still captured to suspense. These events do not automatically reverse ledger entries or revoke credits because refunds may be partial and disputes may resolve without a refund. Public vote-credit fulfillment is atomic and participant-scoped; a verified success issues the reserved credit lot exactly once.
- `/payments/paystack/callback`: authenticates the returning user, invokes the server-side verification function and displays only a verified, pending or review-needed status. It does not trust the redirect query or issue credits/settle balances.\n- `paystack-settlement-import`: requires a Supabase service-role JWT and a valid Paystack mode configuration. It accepts one settlement ID and a bounded (maximum 31-day) date range, locates the settlement through the paginated List Settlements API, then imports one page of its transactions per call. Repeating the returned `nextTransactionPage` is safe because writes upsert by environment and provider transaction identity. It stores only settlement/transaction facts needed for reconciliation, not customer details or provider metadata. It is an internal backend endpoint; no browser UI or scheduled job invokes it yet.

## Settlement reconciliation foundation — migration 0044

- Migration `0044_paystack_settlement_reconciliation` adds server-only storage for Paystack settlement batches and their provider transaction rows. Imports are scoped to the explicit `test` or `live` environment; a provider transaction can appear only once per environment.
- The read-only `paystack_settlement_reconciliation` view compares each imported settlement transaction with the server-verified payment intent, provider transaction ID, actual provider amount/currency, and the idempotent suspense receipt posting.
- Reconciliation outcomes distinguish non-successful settlements, unknown or ambiguous references, unsuccessful provider transactions, transaction-ID/amount/currency mismatches, missing ledger receipts, and `matched_to_receipt`.
- `matched_to_receipt` means only that a successful Paystack settlement row agrees with the verified provider receipt and its interim clearing/suspense posting. It does **not** prove the bank payout arrived, validate net settlement totals, book processor fees, allocate payment purposes, or authorize a payout.
- Imported settlement batches and transaction rows are private to server-side service-role workflows. No browser role can read or write them. The migration/test add no production data or settings changes.
- Paystack exposes settlement listing and settlement transaction listing; large settlements must be paged until `meta.pageCount` is exhausted. The export URL is short-lived, so do not persist it as a durable import source. See [Settlement API](https://paystack.com/docs/api/settlement/) and [Settlement Transactions](https://paystack.com/docs/payments/settlement-transactions/).
- **Still outstanding:** an approved operator UI/dispatch workflow to drive all importer pages, monitoring, aggregate gross/fees/net-to-bank reconciliation against bank evidence, reviewed exception resolution/approval/audit, and accounting-approved fee/refund/chargeback/purpose allocation. The importer is page-by-page and idempotent; the operator workflow is not deployed. The settlement-ready live switch remains off.

## Payment exception queue — migration 0045

- Migration `0045_paystack_payment_exception_queue` adds the private, read-only `paystack_payment_exception_queue` view.
- It combines payment intent state and expected/provider-observed amount/currency with signed refund/dispute event types, receipt-posting presence, and imported settlement reconciliation statuses.
- The view omits customer contact details and raw provider payloads; it is `security_invoker = true` and SELECT is granted only to `service_role`.
- This is evidence for operator review, not an automatic resolution engine. It does not reverse ledger entries, revoke credits, decide partial-refund amounts, settle disputes, allocate fees, or authorize payouts. A reviewed operator resolution/approval/audit workflow remains outstanding.

## Important boundaries

- Never accept client-supplied amount, fee, currency, purpose, payment status or provider reference as authoritative. The platform-fee checkout's submitted quote fields are comparison-only; server policy and committed eligible-voter rows determine the amount.
- A browser callback is an untrusted navigation signal, not proof of payment. The callback route performs authenticated server-side verification; the signed webhook remains the independent provider notification path.
- On a server-verified Paystack success, the actual provider-reported amount and currency are stored separately from the expected intent amount. Migration `0039_verified_provider_amount_capture` posts the actual KES amount to provider clearing and unallocated suspense—even when the amount mismatches and the intent is set to `exception`. This prevents the ledger from recording an expected amount that was not actually received. Non-KES or invalid provider amounts remain exceptions and are not forced into the KES ledger. This is not purpose allocation, revenue recognition, processor-fee accounting, organization-balance settlement or vote-credit issuance.
- The webhook RPC atomically updates payment/event state; the payment-intent success trigger posts the interim suspense receipt in the same database transaction. Neither path performs final purpose allocation or vote-credit fulfillment. Migration `0035_paystack_terminal_state_guard` prevents late `charge.success` events from resurrecting terminal intents. Migration `0038_paystack_refund_dispute_exceptions` freezes signed refund/dispute notifications for explicit reconciliation without treating webhook status as final settlement.
- Migration `0034_idempotent_ledger_posting` adds a service-role-only, balanced, idempotent ledger posting primitive and append-only guards. Migrations `0037` and `0039` wire server-verified provider receipts to balanced, idempotent provider-clearing/suspense postings using the actual provider amount. They deliberately do not decide how gross receipts, processor fees, organization liabilities, vote-credit liabilities, taxes or refunds are finally classified.
- Webhook payloads are not stored raw; only redacted transaction metadata is persisted. Refund and dispute notifications are durably recorded and mark affected payments as exceptions until the provider resource, amount, refund completion and any entitlement/ledger consequences are reconciled. Paystack documents partial and full refunds, with `refund.processed` indicating processor completion and possible customer receipt delays; disputes have their own evidence and response workflow. See [Paystack refunds](https://paystack.com/docs/payments/refunds/) and [Paystack dispute management](https://paystack.com/docs/payments/manage-disputes/).
- Payouts and transfers remain disabled.
- Do not put ballot choices, candidate IDs, participant contact details or other sensitive election data in Paystack metadata, references, logs or analytics.

## Implementation sequence and release gates

1. Verify test-mode keys and the dedicated test webhook signing secret without exposing values. Run a controlled test checkout, callback verification, signed webhook, duplicate delivery, refund/dispute exception and settlement-import test.
2. Verify the Paystack dashboard callback URL, webhook URL, event subscriptions and separate test/live whsec_ signing secrets. The expected production callback is https://mandate.markmachukhu97.workers.dev/payments/paystack/callback; the expected webhook endpoint is https://yhdosrhtzcsfqfuuqhsk.supabase.co/functions/v1/paystack-webhook. These endpoints are targets to verify, not independently confirmed dashboard settings.
3. Rotate/revoke the live secret previously exposed in chat. Install the new PAYSTACK_LIVE_SECRET_KEY and PAYSTACK_LIVE_WEBHOOK_SECRET in Supabase Edge Function secrets; verify names and prefixes without printing values.
4. Confirm with Paystack that paid vote-credit sales are permitted under Mandate's actual merchant category and supported election types, especially political-party/non-profit use. Pre-Approved status is not blanket approval for every activity.
5. Complete the operator settlement workflow, aggregate gross/fees/net-to-bank reconciliation against bank evidence, reviewed exception resolution, operator approval/audit, and final revenue/processor-fee/tax accounting. The current importer is page-by-page and has no operator UI or scheduled dispatch workflow.
6. Confirm the Auth OTP template uses {{ .Token }}, SMTP delivery, expiry and rate limits with synthetic users.
7. Keep PAYSTACK_LIVE_TRANSACTIONS_ENABLED, PAYSTACK_LIVE_SETTLEMENT_PIPELINE_ENABLED, all PAYSTACK_LIVE_*_ENABLED purpose switches, and the three database purpose flags false until all applicable gates pass.
8. Only after settlement readiness is complete and provider/activity approval is recorded may the team consider enabling a direct Mandate platform-fee purpose. Public vote credits require their own provider-use-case confirmation and election authorization. Any real-money test requires separate explicit approval of the exact KES amount, payer and purpose.

No live purpose is enabled by default. The user has conditionally authorized live enablement if verified; that authorization does not waive provider, credential, settlement, legal or operational safeguards.

## Public participant email verification — implementation in progress

- Public participant access uses Supabase Auth email OTP. The user requests a six-digit code, verifies it, then a server-side Edge Function links the verified Auth user to one election-scoped `public_participants` row.
- Migration `0040_public_participant_email_identity` adds a nullable Auth-user foreign key and a unique election/user constraint. The participant table remains server-only; the ballot schema has no participant, Auth-user, email, contact-hash or payment identifiers.
- The public election details Edge Function returns only approved public election fields by public slug. The participant session endpoint requires a verified email, an open `public_paid` election, KES price/cap configuration and an explicit election authorization timestamp.
- The Auth UUID is pseudonymous in the participant table; no email is copied to participant/payment/ballot tables. Payment references, provider metadata, ballot receipts and ballot rows remain free of participant contact information.
- Supabase Auth's **Magic link or OTP** email template must contain `{{ .Token }}` (and not `{{ .ConfirmationURL }}`) to deliver a code rather than a magic link. The existing custom SMTP sender should be reused. The dashboard template has not yet been changed; that setting must be inspected and validated before this flow is considered usable.
- The participant session is only the identity/verification slice. It does not yet create payment intents, reserve credits, initialize Paystack, fulfill credit lots or enable paid voting. Existing legal/provider/accounting gates remain in force.


## Public paid voting lifecycle — deployed single-merchant model

- Migration 0049_single_merchant_public_vote_payments supersedes the earlier split/subaccount design in migrations 0047–0048. Mandate is the merchant and revenue owner for public vote-credit sales. The current model does not allocate organizer proceeds, create organizer liabilities, use subaccounts, or pay organizers.
- The public participant flow uses Supabase Auth email OTP and an election-scoped verified participant session. The public election details, participant session and credit-intent Edge Functions are deployed. The Supabase Auth OTP template still needs dashboard verification to ensure it renders {{ .Token }} rather than a magic link.
- The participant creates a server-priced credit intent through public-vote-credit-intent. Election price, participant cap, election status and participant identity are derived/validated server-side; the browser cannot supply the authoritative amount.
- Public vote-credit checkout calls the same paystack-initialize function used by registered-election platform fees. Both redirect to the same Paystack-hosted checkout and return through /payments/paystack/callback, which invokes paystack-verify. Both server actions use the same HTTPS Paystack redirect validator.
- A verified successful payment is applied atomically through apply_verified_paystack_public_vote_payment. The RPC validates the immutable intent, provider reference, transaction ID, actual amount, currency, participant/election scope and reserved credit quantity before issuing the credit lot exactly once.
- Credit reservations lock election and participant capacity. Unknown/exception payment outcomes retain the reservation; failed/abandoned payments release it only after server verification. Duplicate webhook/manual verification is idempotent.
- Ballot casting consumes active credits atomically across lots, stores only a hash of the client idempotency key in the restricted submission-control table, and keeps payment/participant identifiers out of ballot rows.
- Signed refund/dispute events verify the original provider transaction and freeze the payment for reconciliation. They do not automatically reverse ledger postings or revoke already-consumed credits; partial refunds and dispute outcomes require a reviewed decision.
- The global public-credit release flag blocks new credit-purchase intent creation while allowing verification/settlement of already-started intents and casting of already-purchased credits. Pausing an election remains the lifecycle control for stopping ballots.
- **Not released:** PAYSTACK_LIVE_PUBLIC_VOTE_CREDITS_ENABLED and the database public_vote_credits_enabled flag remain false. No public-paid election is authorized/opened. No live payment has been initiated.
- **Accounting boundary:** Verified receipts post to provider clearing and unallocated suspense. Mandate's revenue recognition/deferred-revenue policy for prepaid vote credits, processor fees, taxes, refunds, chargebacks and bank-net reconciliation remain to be completed before live settlement readiness. No organizer proceeds or payouts are in scope.


## Paystack Kenya commercial and settlement constraints — current interpretation

These are published provider terms and pricing references, not confirmation of Mandate's account-specific agreement or written approval of Mandate's paid-voting use case.

- Paystack's official status guide says Pre-Approved merchants may accept real customer payments after initial checks, while further review may continue and payouts may be temporarily paused.
- Paystack's official Kenya business-type guidance says Starter Business accounts have a KES 600,000 lifetime collection limit and cannot use Transfers. The recorded Poptra Starter Business account therefore has a collection ceiling, but no Transfers are needed for the current Mandate-revenue model.
- Paystack's Kenya Merchant Services Agreement requires accurate merchant/customer transaction descriptions and merchant responsibility for service delivery, refunds, tax and chargeback obligations. Restricted-business classification may depend on the actual election type and customer segment. Obtain written confirmation for paid vote-credit sales, especially where political parties or non-profits are involved.
- The current model is a direct customer-to-Mandate payment. Do not describe it as collecting funds for an organizer, and do not create organizer liabilities or payouts unless a future decision explicitly changes the model and Paystack approves the new fund flow.
- Public Kenya pricing lists provider fees by payment method, but the actual Poptra negotiated fee schedule and payout timing must be verified in the dashboard before accounting for processor fees or settlement dates.
- Paystack's published refund guidance says processing fees may be non-refundable; partial/full refund handling and chargeback responsibility must be reflected in the Mandate accounting policy.
- Legal/privacy review is risk-based for statutory/public elections, political-party/non-profit use and the relevant jurisdiction. A universal external legal approval for every private organizational election is not established.
- Ledger, reconciliation, refunds, reserves and financial statements are internal control/readiness requirements. A universal external accounting approval is not established unless required by the organization's governance, auditor, regulator or provider.

Official references:
- https://paystack.com/ke/pricing
- https://paystack.com/ke/terms
- https://support.paystack.com/en/articles/6543554
- https://support.paystack.com/en/articles/2128898
- https://paystack.com/docs/payments/webhooks/
- https://support.paystack.com/en/articles/2132802
