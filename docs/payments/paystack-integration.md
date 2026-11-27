# Paystack integration

Mandate uses server-side Paystack Edge Functions. Provider credentials are supplied through Supabase Edge Function secrets and are never exposed to the browser. Test and live credentials are separate; the legacy shared `PAYSTACK_SECRET_KEY` and `PAYSTACK_WEBHOOK_SECRET` names are not accepted by the mode-aware adapter.

## Payment purposes

The supported product scope is three distinct purposes:

- `platform_fee`: payment owed to Mandate under an approved fee policy.
- `organization_topup`: funds attributable to an organization under an approved custody, beneficial-ownership and settlement policy.
- `public_vote_credits`: election-specific credit purchases, requiring a scoped public-participant flow and separate legal/provider approval.

Each purpose has an independent mode-specific flag. A flag only permits the corresponding technical path to proceed; it does not establish pricing, accounting classification, legal eligibility, custody, settlement or payout authority. The current user-initiated initialize/verify routes remain organization-manager routes and explicitly reject public-vote-credit checkout until the participant-token purchase path is implemented. No purpose is live-enabled by default.

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
| `MANDATE_PAYMENT_CALLBACK_URL` | Optional HTTPS callback URL; callback is never proof of payment |
| `MANDATE_ALLOWED_ORIGINS` | Optional comma-separated browser origins |

A purpose flag is enabled only when its mode-specific value is exactly `true`; missing flags are disabled. Live mode additionally requires both live master switches, a matching live key prefix and a live webhook secret. The settlement-readiness switch must remain unset until payment-to-ledger posting and reconciliation are actually wired and tested. The adapter never falls back from a missing mode-specific key to a shared/other-mode key.

## Edge Function behavior

- `paystack-initialize`: loads an existing server-created intent; amount, currency and reference come from the database. Requires the matching mode and purpose gates. Public vote-credit initialization remains blocked until a scoped participant-token checkout path is implemented.
- `paystack-verify`: verifies the provider transaction server-side and compares exact reference, amount and KES currency. Organization intents require active organization-manager authorization.
- `paystack-webhook`: verifies the timestamped `Paystack-Signature` HMAC over the exact raw body, deduplicates provider events, checks the associated intent's purpose gate, verifies with Paystack and calls the row-locked database RPC. Webhook events for a disabled purpose are not applied. Public vote-credit webhook fulfillment is explicitly blocked until the atomic credit-issuance path is implemented, even if its purpose flag is accidentally enabled.

## Important boundaries

- Never accept client-supplied amount, fee, currency, purpose, payment status or provider reference as authoritative.
- A browser callback is an untrusted navigation signal, not proof of payment.
- Payment verification currently updates payment state only. It does not post ledger entries, issue vote credits or settle an organization balance.
- The existing webhook RPC atomically updates payment/event state but does not post ledger entries or fulfill credits.
- Migration `0034_idempotent_ledger_posting` adds a service-role-only, balanced, idempotent ledger posting primitive and append-only guards. It deliberately requires callers to supply policy-approved account allocations; it does not decide how gross receipts, processor fees, organization liabilities, taxes or refunds are classified, and it is not yet wired into Paystack settlement.
- Webhook payloads are not stored raw; only redacted transaction metadata is persisted.
- Payouts and transfers remain disabled.
- Do not put ballot choices, candidate IDs, participant contact details or other sensitive election data in Paystack metadata, references, logs or analytics.

## Implementation sequence and release gates

1. Provision separate test API and webhook signing secrets in Supabase Edge Function secrets; do not send them through chat or store them in Notion.
2. Enable only the required test-purpose flags and verify signed test delivery and provider test transactions.
3. Implement server-created purpose-specific intents, scoped authorization, callback handling, idempotent settlement postings, credit issuance/consumption, refunds/reversals, and reconciliation for all three purposes.
4. Obtain approved pricing, tax, fee allocation, merchant-of-record, custody, settlement, chargeback, paid-voting eligibility and payout policies. Do not infer these from the existence of database enums or accounts.
5. Only after legal/provider/security/operational approval, install separate live secrets and enable an individual live-purpose flag. Live mode also requires the master switch.
6. A controlled real-money payment requires separate explicit approval of the exact KES amount, payer and purpose. No configuration change or scope decision authorizes a real charge by itself.
