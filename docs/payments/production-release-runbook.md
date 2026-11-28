# Mandate payment release runbook

**Status:** Production payment code and database foundation are deployed. Real-money checkout remains fail-closed. This runbook records the current single-merchant model; it is not authorization to process a real charge.

## Current production baseline — 28 November 2026

- **Repository:** gvffbhdvgf/mandate, main commit 2b84791f5e92b61887def3324252670e68fbd934.
- **Cloudflare Worker:** https://mandate.markmachukhu97.workers.dev, deployed version 012b96e8-5d3f-4349-93ea-a07694bcff2e.
- **Supabase:** project yhdosrhtzcsfqfuuqhsk, region eu-central-1; migrations applied through 0049_single_merchant_public_vote_payments.
- **Paystack Edge Functions:** paystack-initialize v13 (JWT required), paystack-verify v13 (JWT required), paystack-webhook v13 (JWT disabled; signature verification in function), public-vote-credit-intent v2, public-participant-session v2, public-election-details v2 and paystack-settlement-import v2.
- **Production purpose flags:** public_vote_credits_enabled=false, platform_fee_enabled=false, organization_topup_enabled=false.
- **Election state:** tracked election 6e9f142d-4522-47f8-8282-ee210793c06a remains draft, registered_single, with no paid-voting authorization and no opening timestamp.
- **Merged payment/product work:** PR #19 payment foundation; PR #23 single-merchant public vote credits; PR #24 manual voter registration; PR #26 email-confirmation UX; PR #27 human-centred workflows and shared Paystack checkout. All are merged.
- **Deployment evidence:** PR #23 worker deployment [46082507806](https://github.com/gvffbhdvgf/mandate/actions/runs/46082507806); manual-voter deployment [46084078836](https://github.com/gvffbhdvgf/mandate/actions/runs/46084078836); auth deployment [46084417647](https://github.com/gvffbhdvgf/mandate/actions/runs/46084417647); current UX/payment-hardening deployment [46085988206](https://github.com/gvffbhdvgf/mandate/actions/runs/46085988206).
- **Post-deploy verification:** read-only Supabase queries after PR #27 reconfirmed all three purpose flags remain false and the tracked election remains draft. No payment, refund, transfer, payout, invitation or election lifecycle action was initiated by these releases.

## Accepted payment architecture

### One shared Paystack checkout

- Registered-election platform fees and public vote-credit purchases both call the same paystack-initialize Edge Function.
- Both receive the same Paystack-hosted authorizationUrl, then return through /payments/paystack/callback, which calls paystack-verify.
- Both server actions use validatePaystackAuthorizationUrl, which accepts only HTTPS Paystack-hosted URLs.
- The browser callback is an untrusted navigation signal. Payment status, amount, currency, reference and fulfilment are verified server-side; the signed webhook is the independent provider notification path.
- Payment purposes remain distinct internally:
  - platform_fee: organization pays Mandate for the registered-election service.
  - public_vote_credits: participant pays Mandate for election-scoped vote credits.
  - organization_topup: not enabled; no custody or withdrawal feature is released.
- **Single merchant:** Mandate is the merchant and revenue owner for public vote-credit sales. The current model does not split proceeds, hold organizer liabilities, or pay organizers. No organizer subaccount or Paystack Transfer is part of this accepted design. Migration 0049 supersedes the earlier split/subaccount design in migrations 0047–0048.
- The payout_requests table is a dormant legacy artifact from earlier settlement planning. Hosted inspection found no payout RPC or payout Edge Function, no RLS policy and no anon/authenticated table grants. It is service-role-only and is not a payout mechanism. Do not delete it without a separate decision.

### Pricing boundaries

- Registered-election platform fee policy v1: KES 20 per eligible voter, KES 500 minimum. This is a direct organization-to-Mandate service fee.
- Public vote-credit price and participant cap are configured on the public-paid election. They are a separate product and must not reuse the registered-election platform fee.
- Under the current single-merchant model, public vote-credit payments are Mandate revenue. There is no organizer share or split percentage in the current implementation.

## Paystack merchant account and provider boundaries

- The project decision register records Poptra (Paystack merchant ID 1730854) as Mandate's designated merchant account. Previously recorded dashboard evidence shows Live / Pre-Approved, Owner Verified, Service Agreement Accepted, Starter Business. This status was not independently rechecked on 28 November because the connected dashboard browser was signed out.
- Paystack's published guidance says Pre-Approved merchants may accept real customer payments after initial checks, while further review may continue and payouts may be paused. This is not blanket approval for every activity or election category.
- Paystack's official Kenya guidance says Starter Business accounts have a KES 600,000 lifetime collection limit and cannot use Transfers. The lack of Transfers does not block the current single-merchant model because Mandate retains the revenue and does not pay organizers. The lifetime collection limit still applies.
- **Remaining provider question:** confirm that paid vote-credit sales are permitted under Mandate's actual merchant category and supported election types, particularly where political parties or non-profits are customers/beneficiaries. General Pre-Approved status is not proof of approval for every business activity. Do not misdescribe the transaction or merchant activity.
- The previously exposed live secret is compromised and must be rotated before any real-money operation. The connected Paystack dashboard was not authenticated during this verification; live keys, webhook signing secrets, callback/webhook URLs and event subscriptions were not independently inspected.
- Official sources: [Paystack Pre-Approved status](https://support.paystack.com/en/articles/6543554), [Paystack business types and limits](https://support.paystack.com/en/articles/2128898), [Paystack Kenya Merchant Services Agreement](https://paystack.com/ke/terms), [Paystack webhook signing](https://paystack.com/docs/payments/webhooks/).

## Required mode-specific Supabase secrets and switches

The Edge Functions reject the legacy shared PAYSTACK_SECRET_KEY and PAYSTACK_WEBHOOK_SECRET names. Do not print secret values in logs, chat, GitHub or Notion.

| Secret / variable | Required form / purpose |
|---|---|
| PAYSTACK_MODE | Exactly test or live; any other value fails closed |
| PAYSTACK_TEST_SECRET_KEY | Test API secret beginning sk_test_ |
| PAYSTACK_TEST_WEBHOOK_SECRET | Test webhook signing secret beginning whsec_ |
| PAYSTACK_LIVE_SECRET_KEY | Live API secret beginning sk_live_; must be newly rotated because the former live secret was exposed |
| PAYSTACK_LIVE_WEBHOOK_SECRET | Live webhook signing secret beginning whsec_ |
| PAYSTACK_LIVE_TRANSACTIONS_ENABLED | Live transaction master switch; exactly true only after approval |
| PAYSTACK_LIVE_SETTLEMENT_PIPELINE_ENABLED | Additional live settlement-readiness switch; must remain false until the complete payment-to-bank reconciliation path is implemented and verified |
| PAYSTACK_TEST_PLATFORM_FEE_ENABLED / PAYSTACK_LIVE_PLATFORM_FEE_ENABLED | Purpose-specific platform-fee gates |
| PAYSTACK_TEST_PUBLIC_VOTE_CREDITS_ENABLED / PAYSTACK_LIVE_PUBLIC_VOTE_CREDITS_ENABLED | Purpose-specific public vote-credit gates |
| PAYSTACK_TEST_ORGANIZATION_TOPUP_ENABLED / PAYSTACK_LIVE_ORGANIZATION_TOPUP_ENABLED | Organization top-up gates; keep false |
| MANDATE_SITE_URL | Public Mandate origin |
| MANDATE_ALLOWED_ORIGINS | Comma-separated allowed browser/callback origins |
| MANDATE_PAYMENT_CALLBACK_URL | Optional HTTPS callback; exact path /payments/paystack/callback and origin must be allowlisted |

A purpose is enabled only when its mode-specific environment flag and the corresponding database purpose flag are enabled. Live mode also requires a valid live key, webhook signing secret, live master switch and settlement-readiness switch. Missing or malformed values fail closed. Do not enable any live switch merely because the Worker or Edge Function has deployed.

## Settlement, ledger and exception readiness

- Verified Paystack receipts post to provider clearing and unallocated suspense. This is a balanced interim receipt, not final revenue recognition or bank reconciliation.
- Migration 0044 stores settlement batches and provider transaction facts. The paystack-settlement-import Edge Function imports a bounded settlement and one transaction page per call, using idempotent upserts.
- The paystack_settlement_reconciliation view compares provider settlement rows with verified payment intents and interim receipt postings. matched_to_receipt means the provider row matches the verified receipt; it does not prove the bank credit arrived or reconcile gross, fees and net bank credit.
- Migration 0045 provides a service-role-only exception evidence view. It does not resolve exceptions or authorize refunds, credits, allocations or payouts.
- The settlement importer has no operator UI or scheduled dispatch workflow. Aggregate gross/fees/net-to-bank reconciliation against actual bank evidence, reviewed exception resolution, operator approval/audit, and final revenue/processor-fee/tax accounting are not complete.
- Refund and dispute webhooks are verified and freeze affected payments for reconciliation. They do not automatically reverse ledger postings or revoke already-consumed vote credits; partial refunds and dispute outcomes require a reviewed decision.
- **Therefore PAYSTACK_LIVE_SETTLEMENT_PIPELINE_ENABLED must remain false and live mode must remain fail-closed.** A successful Paystack settlement status is not proof of bank credit, and a ledger balance is not withdrawable cash.

## Release prerequisites

Do not enable a live purpose until all applicable items are evidenced:

- [ ] Confirm the actual merchant category and obtain Paystack confirmation that public paid vote-credit sales are permitted for the supported election types. Distinguish private organizational elections from statutory/public elections and political-party/non-profit use.
- [ ] Rotate/revoke the previously exposed live secret; install the new live key in Supabase Edge Function secrets. Verify mode-specific secret names without printing values.
- [ ] Generate/verify separate test and live whsec_ webhook signing secrets in Paystack Dashboard > Developers > API configuration.
- [ ] Verify the expected callback URL https://mandate.markmachukhu97.workers.dev/payments/paystack/callback and webhook endpoint https://yhdosrhtzcsfqfuuqhsk.supabase.co/functions/v1/paystack-webhook in the correct Paystack environment. These are target endpoints, not dashboard-verified settings.
- [ ] Verify webhook event subscriptions include charge.success, refund events and dispute events used by the handler; confirm signed delivery and HTTP 200 behavior for processed and ignored events.
- [ ] Confirm Supabase Auth OTP email template uses {{ .Token }}, SMTP delivery, expiry and rate limits with synthetic users.
- [ ] Complete test-mode checkout, callback verification, signed webhook, duplicate delivery, refund/dispute exception and settlement import tests using test credentials only.
- [ ] Complete the operator settlement workflow, bank evidence reconciliation, reviewed exception resolution and final accounting policy before setting settlement readiness true.
- [ ] Confirm backup/PITR, restore procedure, incident owner, support contact and rollback owner.
- [ ] For statutory/public elections or political-party/non-profit use, obtain the relevant jurisdictional legal/privacy review, disclosures, controller/processor allocation and any required registration/DPIA.
- [ ] Keep all live and database purpose switches false until the separate live go/no-go. User authorization to proceed if verified does not waive these gates.

## Required release order

1. Record the exact main SHA, current production Worker version, migration history, Edge Function versions and current flag values.
2. Confirm a recoverable production backup/PITR point and restore owner.
3. Verify the mode-specific test credentials and test webhook signing secret without exposing values.
4. Verify Paystack test callback/webhook configuration; run controlled test checkout, verification, signed webhook, duplicate delivery, refund/dispute exception and settlement import.
5. Complete and test the settlement operator/bank-reconciliation workflow and accounting controls before declaring settlement ready.
6. Obtain Paystack confirmation for paid vote-credit sales under the actual merchant category/election types; obtain risk-based legal/privacy review where applicable.
7. Rotate the compromised live secret, install mode-specific live credentials and webhook signing secret, and verify dashboard callback/webhook settings.
8. Only after all applicable gates pass, consider enabling the direct Mandate platform-fee purpose separately from public vote credits. Do not enable public vote credits until provider use-case confirmation is recorded.
9. Any real-money test requires explicit approval of the exact KES amount, payer, purpose and expected outcome. Reconcile provider and bank evidence immediately.
10. After each release, read back feature flags, election state, payment intent, provider event, ledger and settlement evidence. Keep rollback fail-closed.

## Rollback and incident rules

- Prefer rolling back the Cloudflare Worker to the last known-good deployment while leaving additive database migrations in place. Do not blindly reverse payment/ledger migrations after real events exist.
- Keep live mode and all purpose flags disabled during rollback.
- Never delete provider events, payment intents, ledger postings or ballot/credit evidence to make reconciliation appear clean.
- For amount/reference/currency mismatch, refund/dispute, duplicate fulfilment or ledger imbalance: stop new checkout/credit issuance for the affected purpose, preserve evidence, keep credits held, and route to an authorized reviewer.
- Do not initiate transfers or payouts as a rollback action.
- Record incident timeline, owner, redacted provider references, affected elections and corrective action in the implementation register.

## Historical implementation notes

- PR #19 introduced the payment intent, provider verification, webhook, ledger receipt and settlement reconciliation foundation. PR #23 then replaced the earlier split/subaccount public-voting approach with the current single-merchant Mandate-revenue model and migration 0049.
- Earlier migration 0047/0048 split-settlement design notes and the former shared-revenue-accounting.md are historical and superseded for the current product model. They are not release instructions.
- No organizer subaccounts, organizer proceeds, organizer payout or Paystack Transfer are part of the current accepted design. Any future change to that model requires a new decision and provider approval.
