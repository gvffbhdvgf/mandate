# Paystack integration

Mandate uses server-side Paystack Edge Functions. Provider credentials are supplied through Supabase Edge Function secrets and are never exposed to the browser. Test and live credentials are separate; the legacy shared `PAYSTACK_SECRET_KEY` and `PAYSTACK_WEBHOOK_SECRET` names are not accepted by the mode-aware adapter.

## Payment purposes

The supported product scope is three distinct purposes:

- `platform_fee`: payment owed to Mandate under an approved fee policy.
- `organization_topup`: funds attributable to an organization under an approved custody, beneficial-ownership and settlement policy.
- `public_vote_credits`: election-specific credit purchases, requiring a scoped public-participant flow and separate legal/provider approval.

Each purpose has an independent mode-specific flag. A flag only permits the corresponding technical path to proceed; it does not establish pricing, accounting classification, legal eligibility, custody, settlement or payout authority. Organization payment intents require an active owner/admin/finance-manager; public-vote-credit intents use a separate verified, election-scoped participant-token path. No purpose is live-enabled by default.

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
- **Still outstanding:** secure operator authorization and ingestion workflow, pagination/retry/idempotency for provider imports, aggregate gross/fees/net-to-bank reconciliation, exception review and resolution workflow, and accounting-approved fee/refund/chargeback/purpose allocation. The settlement-ready live switch remains off.

## Important boundaries

- Never accept client-supplied amount, fee, currency, purpose, payment status or provider reference as authoritative.
- A browser callback is an untrusted navigation signal, not proof of payment. The callback route performs authenticated server-side verification; the signed webhook remains the independent provider notification path.
- On a server-verified Paystack success, the actual provider-reported amount and currency are stored separately from the expected intent amount. Migration `0039_verified_provider_amount_capture` posts the actual KES amount to provider clearing and unallocated suspense—even when the amount mismatches and the intent is set to `exception`. This prevents the ledger from recording an expected amount that was not actually received. Non-KES or invalid provider amounts remain exceptions and are not forced into the KES ledger. This is not purpose allocation, revenue recognition, processor-fee accounting, organization-balance settlement or vote-credit issuance.
- The webhook RPC atomically updates payment/event state; the payment-intent success trigger posts the interim suspense receipt in the same database transaction. Neither path performs final purpose allocation or vote-credit fulfillment. Migration `0035_paystack_terminal_state_guard` prevents late `charge.success` events from resurrecting terminal intents. Migration `0038_paystack_refund_dispute_exceptions` freezes signed refund/dispute notifications for explicit reconciliation without treating webhook status as final settlement.
- Migration `0034_idempotent_ledger_posting` adds a service-role-only, balanced, idempotent ledger posting primitive and append-only guards. Migrations `0037` and `0039` wire server-verified provider receipts to balanced, idempotent provider-clearing/suspense postings using the actual provider amount. They deliberately do not decide how gross receipts, processor fees, organization liabilities, vote-credit liabilities, taxes or refunds are finally classified.
- Webhook payloads are not stored raw; only redacted transaction metadata is persisted. Refund and dispute notifications are durably recorded and mark affected payments as exceptions until the provider resource, amount, refund completion and any entitlement/ledger consequences are reconciled. Paystack documents partial and full refunds, with `refund.processed` indicating processor completion and possible customer receipt delays; disputes have their own evidence and response workflow. See [Paystack refunds](https://paystack.com/docs/payments/refunds/) and [Paystack dispute management](https://paystack.com/docs/payments/manage-disputes/).
- Payouts and transfers remain disabled.
- Do not put ballot choices, candidate IDs, participant contact details or other sensitive election data in Paystack metadata, references, logs or analytics.

## Implementation sequence and release gates

1. Provision separate test API and webhook signing secrets in Supabase Edge Function secrets; do not send them through chat or store them in Notion.
2. Enable only the required test-purpose flags and verify signed test delivery and provider test transactions.
3. Complete server-created purpose-specific intents, scoped authorization, purpose-specific ledger allocation from suspense, credit issuance/consumption, processor-fee accounting, refunds/reversals, and reconciliation for all three purposes. The current suspense receipt is an interim balanced posting, not final settlement.
4. Obtain approved pricing, tax, fee allocation, merchant-of-record, custody, settlement, chargeback, paid-voting eligibility and payout policies. Do not infer these from the existence of database enums or accounts.
5. Only after legal/provider/security/operational approval, install separate live secrets and enable an individual live-purpose flag. Live mode also requires the master switch.
6. A controlled real-money payment requires separate explicit approval of the exact KES amount, payer and purpose. No configuration change or scope decision authorizes a real charge by itself.


## Public participant email verification — implementation in progress

- Public participant access uses Supabase Auth email OTP. The user requests a six-digit code, verifies it, then a server-side Edge Function links the verified Auth user to one election-scoped `public_participants` row.
- Migration `0040_public_participant_email_identity` adds a nullable Auth-user foreign key and a unique election/user constraint. The participant table remains server-only; the ballot schema has no participant, Auth-user, email, contact-hash or payment identifiers.
- The public election details Edge Function returns only approved public election fields by public slug. The participant session endpoint requires a verified email, an open `public_paid` election, KES price/cap configuration and an explicit election authorization timestamp.
- The Auth UUID is pseudonymous in the participant table; no email is copied to participant/payment/ballot tables. Payment references, provider metadata, ballot receipts and ballot rows remain free of participant contact information.
- Supabase Auth's **Magic link or OTP** email template must contain `{{ .Token }}` (and not `{{ .ConfirmationURL }}`) to deliver a code rather than a magic link. The existing custom SMTP sender should be reused. The dashboard template has not yet been changed; that setting must be inspected and validated before this flow is considered usable.
- The participant session is only the identity/verification slice. It does not yet create payment intents, reserve credits, initialize Paystack, fulfill credit lots or enable paid voting. Existing legal/provider/accounting gates remain in force.


## Public paid voting lifecycle — implementation in progress

- Migration `0041_public_vote_credit_reservations_and_fulfillment` creates a server-only credit reservation ledger. A participant's existing issued credits plus reserved/exception credits plus the requested quantity may not exceed the election cap. Election and participant rows are locked during intent creation, and the amount is calculated from the saved per-credit KES price.
- A verified Paystack success creates exactly one credit lot only when provider status, transaction ID, actual amount, currency and reservation all match the intent. Failed/abandoned payments release a reservation only after server verification. Unknown and exception outcomes continue to hold the cap.
- Refund, reversal or dispute exceptions suspend unspent credits and hold the reservation for reconciliation. Previously cast ballots are not silently deleted or altered. Partial refunds and chargebacks still require a separate, reviewed reconciliation decision; no automatic ledger reversal is inferred.
- Migration `0042_public_paid_ballot_casting` adds participant-authenticated ballot context and casting. Casting locks the election and participant, consumes active credits atomically across lots, stores a hash of a client idempotency key in the restricted submission-control table, and returns a receipt. Ballot rows contain no participant, Auth-user, email, contact hash or payment identifiers.
- Migration `0043_paid_voting_release_gate` creates server-only global release switches for all three purposes; all default to false. Public-paid election setup can be drafted with a public slug, KES price and participant cap. Setup confirmation/opening require the global public-vote-credit release flag and platform-set paid-voting authorization. Price and cap are included in the setup hash. Public-paid tallying uses verified/blocked participant records as the participant base and checks participant-to-control mapping and credit-consumption reconciliation.
- Public checkout uses the separate `PAYSTACK_*_PUBLIC_VOTE_CREDITS_ENABLED` environment gate and the database release flag. The database also rejects payment-intent creation and ballot insertion while the global flag is off. Verification/webhooks continue processing already-started payments even if new checkout is disabled.
- The public participant UI is `/public-vote/[slug]`. It uses the selected email OTP flow, then displays checkout and ballot controls when the session and active credit balance are available. After a verified Paystack callback, the participant can return to the election to cast ballots.
- The global public-credit release switch blocks creation of new credit-purchase intents, but does not block settlement/webhook verification of an existing intent or casting already-purchased credits. This avoids stranding a participant who has paid if new checkout is paused. Pausing an election remains the election lifecycle control for stopping ballots.
- A signed `charge.success` webhook is always verified against Paystack regardless of the current per-purpose checkout switch. The database only issues the reserved credit lot after exact provider facts are persisted; the same transaction rolls back receipt and entitlement writes together on mismatch.
- **Not released:** No payment feature flag has been enabled; no public-paid election has been opened; no production migrations or Edge Functions have been deployed; no Paystack credentials/configuration or live transaction settings have changed. The Auth OTP template still needs to be verified/configured to use `{{ .Token }}`.
- **Accounting boundary:** Verified receipts are still captured to provider clearing and unallocated suspense. Credit issuance is an entitlement event; final vote-credit liability/revenue classification, processor fees, taxes, custody, settlement, refunds and chargeback accounting remain unresolved and must be approved before live mode.


## Paystack Kenya commercial and settlement constraints — release research

These are published provider terms and pricing references, not confirmation of Mandate's account-specific agreement or written approval of Mandate's product use case.

- Paystack's public Kenya pricing lists 2.9% for local cards, 1.5% for M-PESA and 3.8% for international cards. Public guidance describes ordinary KES settlement as T+2 working days. Verify the actual account's negotiated fees and payout schedule in the dashboard/merchant agreement before booking processor fees or settlement dates.
- The Kenya Merchant Services Agreement says the standard payout account is a bank account in the merchant's name. The optional Payout Service may pay designated third-party recipients, but its stated restrictions require a direct business relationship and payments for services rendered, activities performed or refunds. Do not assume that organization top-ups can be held as a Mandate wallet balance or paid out to arbitrary organizations.
- Paystack supports subaccount/split payments; each beneficiary needs a subaccount, and the split configuration can determine who bears processing fees. This is a possible provider-supported route for organization proceeds, not evidence that Mandate's exact use case or account is approved.
- The Kenya Acceptable Use Policy restricts certain games of skill with entry fees and prizes unless prior approval is obtained. Public paid voting must receive written Paystack confirmation for the actual election types, prize arrangements and commercial model before launch.
- Paystack's published refund guidance says processing fees are non-refundable. Partial refunds are supported, and the customer refund timeline may be 3–10 working days. Refunds may be funded from pending payouts or an eligible Paystack balance; account type and available funds matter.
- The Kenya Merchant Services Agreement places tax determination/reporting/remittance responsibility on the merchant and makes the merchant liable for chargeback/dispute-related costs. Reserves and payout deductions may also apply.

Official references:
- https://paystack.com/ke/pricing
- https://paystack.com/ke/terms (Sections D and Acceptable Use Policy)
- https://paystack.com/docs/v2/ke/payments/split-payments
- https://support.paystack.com/en/articles/2132802
- https://support.paystack.com/en/articles/2127106
- https://support.paystack.com/en/articles/2125314

**Release consequence:** Do not enable `platform_fee`, `organization_topup` or `public_vote_credits` in live mode until the merchant-of-record, custody, fee bearer, settlement, tax, refund, chargeback and paid-voting eligibility model is documented and approved by the appropriate business/legal/provider owners. No dashboard setting, subaccount, payout destination, fee, secret or transaction was changed during this research.
