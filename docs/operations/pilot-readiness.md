# Mandate pilot readiness and operations

**Status:** production registered-election application deployed; pilot authorization remains pending.  
**Last verified:** 2026-11-27.

This runbook is an operator checklist. A checkbox is complete only when the linked system or evidence confirms it.

## Current known state

- M0–M5 registered-election release was consolidated in [PR #10](https://github.com/gvffbhdvgf/mandate/pull/10), merged to `main` at merge commit `47523f85435e46a15316940052827f38d1bd2465`. The PR head `4b0d8d5d2e293161c2ff02a8fd9b9195bb146097` passed the application, disposable database migration/invariant/concurrency and Paystack Edge Function workflows.
- Production Cloudflare Worker `mandate` is deployed at [https://mandate.markmachukhu97.workers.dev](https://mandate.markmachukhu97.workers.dev). Production deployment run [#4](https://github.com/gvffbhdvgf/mandate/actions/runs/45924589936) passed contract/type/compatibility checks, Worker build and smoke checks for home, login and signup. The deployed source commit is `3858cbb950fc439178efd932ef197b76af98c314`; Cloudflare reports the Worker script is present and modified on 2026-11-27.
- Supabase project `yhdosrhtzcsfqfuuqhsk` (Mandate, `eu-central-1`) is `ACTIVE_HEALTHY`, with hosted migrations through `0033_election_setup_confirmation_index`.
- Supabase security advisors have no WARN findings. Sixteen RLS-enabled tables without policies are intentional private/default-deny tables; access must be through approved RPCs. Forty-eight unused-index notices are INFO findings and should not be removed without production workload evidence.
- Active hosted Edge Functions include Paystack initialize v3, verify v3 and webhook v4, voter invitations v10, and organization invitations v2. Paystack remains test-gated; payment functions do not issue vote credits, settle funds or initiate payouts.
- Supabase Auth Site URL is `https://mandate.markmachukhu97.workers.dev`; the callback allowlist includes `https://mandate.markmachukhu97.workers.dev/auth/callback?next=*`. Edge Function secret `MANDATE_SITE_URL` matches the production origin.
- Organization invitation delivery remains fail-closed. `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are not configured. The Resend domain entry `poptraworld.digital` is unverified, its DNS is unconfigured, and the provider reports it is in use by another Resend team. Do not claim or verify it without explicit ownership and transfer authorization.
- No real voter invitation, ballot, live provider charge, transfer or payout is represented as verified. Paid voting and wallet payouts remain disabled.

## Release and production verification

### Completed

- [x] PR #10 reviewed, merged to `main`, and required application/database/Edge Function checks passed on the recorded PR head.
- [x] Production Worker deployed from `main`.
- [x] Production deployment workflow passed home, login and signup route smoke checks.
- [x] Supabase Auth production Site URL and callback allowlist configured.
- [x] Hosted Supabase migration history verified through `0033_election_setup_confirmation_index`.
- [x] Supabase security advisors checked; no WARN findings.

### Still required before real pilot use

- [ ] From an independent browser/network, verify unauthenticated `/dashboard` redirects to sign-in.
- [ ] Using a designated test account, verify signup, email confirmation, callback, login and password reset on the production origin.
- [ ] Confirm a project-controlled sending domain. Configure and verify its DNS in Resend, then set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in Supabase function secrets. Use only an explicitly authorized test mailbox before real invitations. Do not transfer or claim `poptraworld.digital` without explicit authorization.
- [ ] Test organization invitation creation, delivery, acceptance, expiry, revocation and assigned-role boundaries after sender setup.
- [ ] Test the election setup and lifecycle on non-production test data: create/resume draft, confirm authority, import a test voter list, run registered voting, close/tally/publish, and verify audited aggregate CSV/PDF exports.
- [ ] Verify lower-privilege members cannot perform operator actions or export results, and unpublished results remain private.
- [ ] Rotate the previously exposed Paystack test secret. Confirm the provider account is in test mode and perform signed test-mode payment validation only. Do not enable live mode.
- [ ] Confirm GitHub branch protection/review policy and deployment credential ownership. Never paste credential values into issues, logs or this document.
- [ ] Keep paid voting, settlements and payouts disabled until separate legal, provider, custody and operational approvals are recorded.

## Rollback and recovery

### Application

1. Stop promotion of the faulty release; capture the failing deployment and logs without copying secrets or personal voter data.
2. Roll back to the previous known-good Worker version using Cloudflare's deployment history, or revert the release commit and let the main-only workflow build and deploy the revert.
3. Verify `/`, `/login`, `/signup`, and the authenticated dashboard redirect/flow.
4. Record the incident, affected release, rollback, data impact and follow-up owner in Notion.

### Database

- Do not assume an application rollback reverses database changes.
- Production schema changes are forward-only. Assess whether the deployed application remains compatible with the latest schema; if not, deploy a reviewed forward-fix migration and compatible application build.
- Before any restore, establish the recovery point and expected data loss with the responsible database operator. No backup restore drill is recorded as complete yet.

### Edge Functions and secrets

- Redeploy the last known-good function revision through the approved deployment pipeline or provider deployment tooling.
- If a credential may be exposed, rotate it in the provider, update the secret store, deploy the dependent function, and verify with non-production/test credentials. Never re-enable Paystack live mode to recover service.

## Incident response

1. **Election integrity/privacy concern:** immediately pause the affected election where safe, restrict access to results and exports, preserve audit records, and notify the designated election authority through the organization's approved incident process.
2. **Authentication or organization-access concern:** disable affected invitation/signup flows if needed, revoke compromised sessions/invitations, inspect authorization and audit records, and rotate affected credentials.
3. **Payment/provider concern:** keep paid voting and payouts disabled; stop provider-side testing, reconcile provider events against idempotent internal records, and involve the provider contact. Do not attempt an unreviewed refund, transfer or manual ledger edit.
4. Preserve the minimum evidence needed for investigation. Avoid storing raw ballot choices alongside voter identities or exporting unnecessary voter data.
5. Assign an incident owner and communications lead before any pilot begins. Those named roles and contact paths are still to be supplied.

## M7 pilot checklist — evidence still required

- [ ] Independent application and database security review, including a scoped penetration test and remediation evidence.
- [ ] Load/performance test at an agreed pilot peak with measured latency, error rate and database headroom.
- [ ] Backup and restore exercise with verified recovery point, recovery time and election/audit integrity checks.
- [ ] Accessibility review of setup, voter access, ballot submission, results and exports, followed by fixes.
- [ ] Onboarding, operator training, support ownership, escalation contacts and incident communications process.
- [ ] Signed deployment, rollback and go/no-go checklist, including decision authority and pilot scope.
- [ ] Privacy, retention and deletion rules reviewed for organization invitations, voter registers, ballots, exports, audit records and payment metadata.

No pilot is approved by this document alone. Do not use the system for a real election until the organization has documented the threat model, election rules, access roles, privacy notices, incident contacts and signed go/no-go decision.
