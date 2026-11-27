# Mandate pilot readiness and operations

**Status:** production registered-election application deployed; pilot authorization remains pending.  
**Last verified:** 2026-11-27.

This runbook is an operator checklist. A checkbox is complete only when the linked system or evidence confirms it.

## Current known state

- M0–M5 registered-election release was consolidated in [PR #10](https://github.com/gvffbhdvgf/mandate/pull/10), merged to `main` at merge commit `47523f85435e46a15316940052827f38d1bd2465`. The PR head `4b0d8d5d2e293161c2ff02a8fd9b9195bb146097` passed the application, disposable database migration/invariant/concurrency and Paystack Edge Function workflows.
- Production Cloudflare Worker `mandate` is deployed at [https://mandate.markmachukhu97.workers.dev](https://mandate.markmachukhu97.workers.dev). Production deployment run [#5](https://github.com/gvffbhdvgf/mandate/actions/runs/45952815407) passed contract/type/compatibility checks, Worker build, deployment and smoke checks for home, login and signup. The deployed source commit is `3858cbb950fc439178efd932ef197b76af98c314`; Cloudflare reports the Worker script is present and modified on 2026-11-27.
- A read-only independent Chrome smoke check on 2026-11-27 confirmed the homepage, `/login` and `/signup` render expected Mandate content; unauthenticated `/dashboard` redirects to `/login`. Login/signup fields have accessible labels and expected input types; signup keyboard focus traversed name, email, password and submit. No form was submitted and no account or application data was changed. The same inspection found `/forgot-password` returns 404 and login has no recovery link; proposed fix is open in [PR #16](https://github.com/gvffbhdvgf/mandate/pull/16), not merged or deployed.
- Supabase project `yhdosrhtzcsfqfuuqhsk` (Mandate, `eu-central-1`) is `ACTIVE_HEALTHY`, with hosted migrations through `0033_election_setup_confirmation_index`.
- Read-only schema review confirmed 27 public application tables have RLS enabled. Sixteen have no direct client policies and are protected by default-deny grants/RPC boundaries; the remaining tables have explicit organization/role policies. Sensitive election, ballot, payment and ledger tables do not grant direct anon/authenticated access. Token-based registered-ballot context/casting RPCs intentionally allow anon execution; the functions validate high-entropy access tokens, election window, frozen snapshots and duplicate-vote constraints.
- Security-definer private functions inspected in the hosted database set a fixed `search_path=pg_catalog`; the exposed public wrappers are security-invoker functions. Invitation acceptance requires a signed-in user with a confirmed email matching the invitation, checks expiry/status, locks the invitation row and writes an audit event.
- Supabase security advisors currently report one WARN: leaked-password protection is disabled. The project is visibly on the Free plan; Supabase documents this control as Pro-and-above only, so do not upgrade or incur cost without explicit approval. Use the free-tier minimum-length and character-requirement controls as a mitigation, then recheck the advisor. The 16 RLS-without-policy and 48 unused-index notices are INFO findings; do not add broad table policies or remove indexes without evidence.
- Production application tables currently contain no organizations, elections, voters, ballots, invitation records or payment events. This is a clean production database, not evidence of successful end-to-end workflows. Use an isolated test database/project for lifecycle tests.
- Active hosted Edge Functions observed on 2026-11-27: `send-voter-invitations` v14, `send-organization-invitation` v6, `paystack-initialize` v7, `paystack-verify` v7 and `paystack-webhook` v8. Paystack code explicitly requires `PAYSTACK_MODE=test`, a `sk_test_` secret, and a non-true live-transaction flag. Paid voting, ledger settlement and payouts remain disabled.
- Supabase Auth Site URL is `https://mandate.markmachukhu97.workers.dev`; the callback allowlist includes `https://mandate.markmachukhu97.workers.dev/auth/callback?next=*`. Edge Function secret `MANDATE_SITE_URL` matches the production origin.
- Resend domain `poptraworld.digital` is verified in region `eu-west-1`; sending and receiving are enabled, and current Resend read-back confirms DKIM, SPF and receiving DNS records are verified. The replacement API key `Mandate production email sender replacement` remains active; it is restricted to sending access for `poptraworld.digital`. The earlier key `Mandate production email sender` was revoked and is absent from the active key list. Never copy API-key values into source control or documentation.
- Supabase Edge Function Secrets was reloaded after save: both `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are present; `RESEND_FROM_EMAIL` was explicitly saved as `noreply@poptraworld.digital`. Secret values remain redacted. `MANDATE_SITE_URL` is configured. No test email has yet been sent through the application, and no real voter/organization invitation, ballot, live provider charge, transfer or payout is represented as verified.
- Resend usage read-back is 0/100 daily and 0/3,000 monthly, consistent with the $0 Free transactional allowance; one isolated provider test fits within the current allowance. No email has been sent; explicit sender and controlled-recipient confirmation is still required.

## Release and production verification

### Completed

- [x] PR #10 reviewed, merged to `main`, and required application/database/Edge Function checks passed on the recorded PR head.
- [x] Production Worker deployed from `main`.
- [x] Production deployment workflow passed home, login and signup route smoke checks.
- [x] Independent read-only browser smoke check confirmed homepage, login and signup render and unauthenticated `/dashboard` redirects to `/login`.
- [x] Supabase Auth production Site URL and callback allowlist configured.
- [x] Hosted Supabase migration history verified through `0033_election_setup_confirmation_index`.
- [x] Supabase security advisors checked; one Auth leaked-password-protection WARN remains open.
- [x] Read-only database review of RLS coverage, sensitive table grants, security-definer function search paths, ballot token checks, invitation acceptance rules and core constraints completed.
- [x] Paystack payment-mode guard inspected in deployed shared Edge Function source; it requires test-mode credentials and rejects live-mode enablement.

### Still required before real pilot use

- [ ] After PR #16 passes checks and is deployed, use a designated test account and isolated test environment to verify signup, email confirmation, callback, login and password reset. Production browser checks have not submitted forms; `/forgot-password` is currently a confirmed 404.
- [x] Verify the project sender domain `poptraworld.digital` in Resend and confirm sending/receiving DNS checks; use only the designated Mandate sending identity.
- [x] Confirm `RESEND_API_KEY` and `RESEND_FROM_EMAIL` persist in Supabase Edge Function secrets after reload. Use the restricted sending-only key; secret values remain redacted.
- [ ] After explicit sender/recipient confirmation, send and verify one isolated provider-level test message through Resend to a controlled mailbox. This verifies Resend delivery from the domain, not the Supabase Edge Function's stored key; a separate application-level test remains required. Do not invoke voter/organization invitation functions or enable invitations.
- [ ] Confirm the saved Supabase Auth minimum-length and character-requirement settings match the app's 10-character minimum. Resolve the leaked-password-protection WARN only if the project is moved to Pro with explicit cost approval; until then document the residual WARN.
- [ ] Test organization invitation creation, delivery, acceptance, expiry, revocation and assigned-role boundaries in isolated test data after sender setup.
- [ ] Test the election setup and lifecycle on non-production test data: create/resume draft, confirm authority, import a test voter list, run registered voting, close/tally/publish, and verify audited aggregate CSV/PDF exports.
- [ ] Verify lower-privilege members cannot perform operator actions or export results, and unpublished results remain private.
- [ ] Rotate the previously exposed Paystack test secret in the Paystack dashboard, update Supabase function secrets, and validate signed test-mode events only. Do not enable live mode.
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
