# Paystack integration

Mandate uses a server-side Paystack adapter. Provider credentials are supplied through Supabase Edge Function secrets and are never exposed to the browser.

## Edge Functions

- `paystack-initialize`: initializes a transaction for an existing payment intent after authenticating the user and checking active organization-manager membership.
- `paystack-verify`: verifies a reference server-side and compares the provider reference, amount and currency with the stored intent.
- `paystack-webhook`: verifies the timestamped `Paystack-Signature` HMAC over the exact raw request body, deduplicates events and stores only redacted event metadata.

## Required secrets

| Secret | Purpose |
|---|---|
| `PAYSTACK_SECRET_KEY` | Server-side Paystack API key |
| `PAYSTACK_PUBLIC_KEY` | Public checkout key; never grants API access |
| `PAYSTACK_WEBHOOK_SECRET` | Webhook signing secret beginning with `whsec_` |
| `PAYSTACK_MODE` | Must be `test` to enable transaction initialization |
| `PAYSTACK_LIVE_TRANSACTIONS_ENABLED` | Keep unset or `false`; setting it to `true` disables initialization in this development adapter |
| `MANDATE_PAYMENT_CALLBACK_URL` | Optional HTTPS callback URL when the application domain is established |
| `MANDATE_ALLOWED_ORIGINS` | Optional comma-separated browser origins |

The initialization function fails closed unless `PAYSTACK_MODE=test` and the secret key begins with `sk_test_`. A live key cannot initialize transactions through this function. The temporary live credential supplied during development is stored server-side but must be rotated before any real-money use.

## Important boundaries

- The client supplies a payment-intent ID, never an amount or provider reference.
- Amount and currency come from the stored payment intent.
- Public paid-vote credits remain gated.
- Successful payment verification updates payment state only. It does not itself create vote credits, settle an organization wallet or post ledger entries.
- Webhook processing requires the new `PAYSTACK_WEBHOOK_SECRET` and `Paystack-Signature` header. Legacy `X-Paystack-Signature` is deliberately not accepted by this implementation.
- Webhook payloads are not stored raw; only redacted transaction metadata is persisted.
- Payouts and transfers are outside this integration slice and remain disabled.

## Activation checklist

1. Create a Paystack test restricted key and set it as `PAYSTACK_SECRET_KEY`.
2. Set `PAYSTACK_MODE=test`.
3. Generate the matching test webhook signing secret and set `PAYSTACK_WEBHOOK_SECRET`.
4. Deploy the Edge Functions and register the public webhook URL in Paystack.
5. Test initialization, callback verification, webhook signature, duplicate delivery and amount/currency mismatch.
6. Complete ledger settlement and reconciliation before granting any paid value.
7. Only after security, legal and operational review should a separate live configuration be considered.
