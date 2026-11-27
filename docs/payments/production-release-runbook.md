# Mandate payment release runbook

**Status:** Prepared for a separately approved production release. This document is operational guidance, not authorization to merge, deploy, change production, or process real money.

## Release prerequisites

Do not start the production sequence until all are evidenced:

- [ ] PR #19 is approved, current with `main`, and all required CI, Paystack Edge and database acceptance workflows pass on the exact head.
- [ ] Written Paystack approval covers the precise Mandate public paid-voting product, merchant-of-record model, organizer proceeds arrangement, permitted election types, KYC and settlement mechanism. The published Kenya terms restrict merchants from acting as payment service providers or providing payment aggregation; generic API availability is not approval.
- [ ] Kenyan legal/privacy review approves supported election categories, organizer/controller/processor roles, lawful bases, notices, retention, DPIA/ODPC registration applicability, consumer disclosures, tax, refunds and chargeback allocation.
- [ ] Public paid-voting platform fee policy is explicitly approved and versioned. The registered-election service fee (KES 20 per eligible voter, KES 500 minimum) is separate and must not be reused as the public-voting split.
- [ ] Prepaid-credit revenue recognition, processor-fee allocation, merchant of record, tax and chargeback responsibility are documented.
- [ ] Settlement-to-bank reconciliation, reviewed exception resolution, partial/full refunds and reversal handling, operator authorization, dual control and audit trail are implemented and tested. No payout is enabled merely because a settlement row says success.
- [ ] Supabase Auth OTP template renders the six-digit token; SMTP delivery, expiry and rate limits are verified with synthetic users.
- [ ] Paystack test and live callback URLs, webhook URL, event subscriptions and dedicated `whsec_` signing secrets are verified in the dashboard without disclosing secrets.
- [ ] Production secret names and mode configuration are verified without printing secret values. Live mode and all purpose switches remain off until the separate go/no-go.
- [ ] Backup/PITR availability, restore procedure, incident owner, support contact and rollback owner are confirmed.

## Required release order

The repository's current `.github/workflows/production-deploy.yml` deploys the Cloudflare Worker automatically on every push to `main`. There is no automatic Supabase migration workflow. Therefore, never merge payment code before the database and required Edge Functions are ready.

1. **Freeze and verify.** Record the exact approved PR head, current `main` SHA, workflow URLs and production baseline. Keep all payment purpose flags and live mode disabled.
2. **Back up production.** Confirm a recent recoverable backup/PITR point and document the restore owner and recovery procedure. Do not rely on a database dump as the only backup.
3. **Review migration plan.** Confirm production migration history ends at `0033_election_setup_confirmation_index`. Review the exact pending migration list `0034–0048` (including the existing `0045` exception-queue migration and its `0044` dependency), dependency order, lock behavior, data impact, grants/RLS and rollback implications. Reconcile any migration-history mismatch before applying anything.
4. **Apply database migrations first.** In an approved maintenance window, apply the exact PR migrations to the production Supabase project in order. Verify every migration is recorded and run read-only schema/security assertions. Do not use ad hoc SQL to mark migrations applied.
5. **Deploy Edge Functions.** Deploy the exact tested function sources from the approved commit. Verify function versions, JWT settings and non-secret configuration. Do not enable settlement import or any payment purpose merely because the function is deployed.
6. **Verify Auth and provider configuration.** Complete the OTP delivery test and Paystack dashboard callback/webhook checks. Send a signed test event and run controlled test-mode checkout/verification/reconciliation. Do not use a real charge.
7. **Merge PR #19.** Only after steps 1–6 are verified and the production release is explicitly approved. The merge triggers the current automatic Cloudflare Worker deployment.
8. **Verify Worker deployment.** Confirm the deployed commit matches the approved merge commit; run home, login, signup, organization/election and payment callback smoke checks. Confirm no private response is cached and no secrets are exposed.
9. **Post-deploy verification.** Check migration history, Edge Function versions, webhook delivery/idempotency, payment exception queue, ledger balance and application error logs. Keep all live payment and purpose flags disabled pending the separately authorized live go/no-go.
10. **Live activation is a separate release.** Only after Paystack/legal/accounting/operations sign-off, enable the agreed purpose(s) in the correct order, run the controlled real-money transaction with explicit approval, reconcile provider and bank evidence, and then decide whether any organizer payout is allowed.

## Rollback and incident rules

- Prefer rolling back the Cloudflare Worker to the last known-good deployment while leaving additive database migrations in place. Do not blindly reverse payment/ledger migrations after real events exist.
- Keep live mode and all purpose flags disabled during rollback.
- Never delete provider events, payment intents, ledger postings or ballot/credit evidence to make reconciliation appear clean.
- For any amount/reference/currency mismatch, refund/dispute, duplicate fulfillment or ledger imbalance: stop new checkout/credit issuance for the affected purpose, preserve evidence, keep funds/credits held, and route to an authorized reviewer.
- Do not initiate transfers or payouts as a rollback action.
- Record incident timeline, owner, provider references (redacted), affected elections and corrective action in the implementation register.

## Current verified baseline (27 November 2026)

- Production Supabase project: `yhdosrhtzcsfqfuuqhsk`, status `ACTIVE_HEALTHY`, PostgreSQL 17.12, region `eu-central-1`.
- Read-only migration listing confirms production ends at version `20261127100000` (`0033_election_setup_confirmation_index`). PR #19 migrations `0034–0048` are not applied.
- Production Paystack Edge Functions: `paystack-initialize` v7 (JWT required), `paystack-verify` v7 (JWT required), and `paystack-webhook` v8 (public provider delivery with signature verification in the function). Settlement importer and public participant/credit functions are not deployed.
- PR #19 exact head `15641c5a1167ce3d654ecc58befb1c9566b650fc` includes migration 0048 and atomic split verification. All exact-head checks passed: [Mandate CI 46059819343](https://github.com/gvffbhdvgf/mandate/actions/runs/46059819343), [Paystack Edge integration 46059819329](https://github.com/gvffbhdvgf/mandate/actions/runs/46059819329), and [database acceptance 46059819351](https://github.com/gvffbhdvgf/mandate/actions/runs/46059819351). Database acceptance applied every repository migration to a disposable Supabase stack, passed every rollback-only SQL acceptance test, and passed independent-session concurrency tests.
- The prior database failure on `c7b509a` was a test-fixture expectation error: three credits were issued across two verified split purchases, two were consumed, and one correctly remained unspent. The assertion was corrected in `15641c5`; no payment or migration implementation code changed for that fix.
- Production Security Advisor currently reports one WARN for disabled leaked-password protection and 16 INFO default-deny RLS/no-policy notices. Performance Advisor reports 45 unused-index INFO notices. These were read-only checks; do not purchase a plan upgrade solely to clear the warning without confirming availability and cost.
- Read-only Paystack dashboard inspection reached the merchant login page; no authenticated session was available. Callback/webhook URLs and event subscriptions therefore remain unverified. No credentials were entered.
- PR #19 remains draft and unmerged. It is 0 commits behind main, 340 commits ahead by history, with 62 files in the net diff. A squash merge is preferred if it is later approved, to avoid importing noisy branch history.
- No production migration, function, secret, Auth template, Paystack setting, release flag, charge, refund, transfer or payout was changed during this verification.

## Evidence links

- [PR #19](https://github.com/gvffbhdvgf/mandate/pull/19)
- [Mandate CI](https://github.com/gvffbhdvgf/mandate/actions/runs/46056370314)
- [Paystack Edge integration](https://github.com/gvffbhdvgf/mandate/actions/runs/46056370332)
- [Database acceptance](https://github.com/gvffbhdvgf/mandate/actions/runs/46056370365)
- [Shared-revenue accounting design](./shared-revenue-accounting.md)
- [Paystack Kenya Merchant Services Agreement](https://paystack.com/ke/terms)
- [ODPC Guidance Notes for Electoral Purposes](https://www.odpc.go.ke/wp-content/uploads/2024/02/ODPC-Guidance-Notes-for-Electoral-Purposes.pdf)


## Split-settlement-specific release gates

- Public paid-voting organizer proceeds must use the accepted Paystack split-settlement target: an approved active KES organizer subaccount receives its share directly from Paystack; Mandate receives only its approved platform fee.
- Do not launch the prior model where Mandate collects all proceeds and later pays organizers unless Paystack expressly approves that model in writing.
- Do not create real organizer subaccounts until Paystack confirms the paid-voting use case and the organizer's identity/KYC and beneficiary details have been verified and authorized.
- A server-only organizer subaccount profile and versioned public-voting fee policy are implemented in migration `0047`; atomic provider split verification and the success guard are implemented in migration `0048`. Neither migration has been applied to production. No active policy or verified organizer subaccount is seeded.
- The platform fee amount/formula and Paystack fee bearer are still unresolved. The existing registered-election KES 20-per-voter / KES 500-minimum fee is not the public-voting fee.
- Fixed-fee single-subaccount split verification is implemented fail-closed: webhook and manual verification reconcile Paystack `fees_split` and subaccount identity to the immutable intent snapshot before credit fulfillment. Percentage split checkout remains disabled until exact KES rounding behavior is evidenced and tested. Before a test/live split is considered ready, also test partial/full refunds, reversals and disputes for split transactions.
- If Paystack does not approve this model, evaluate direct organizer merchant-of-record with a separately charged Mandate service fee; do not silently fall back to collecting all proceeds into Mandate.
