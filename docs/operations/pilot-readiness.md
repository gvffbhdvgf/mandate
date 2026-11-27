# Mandate pilot readiness and operations

**Status:** release candidate; production deployment and pilot authorization are pending.  
**Last verified:** 2026-11-27.

This runbook is an operator checklist. A checkbox is complete only when the linked system or evidence confirms it.

## Current known state

- Release work is on [PR #10](https://github.com/gvffbhdvgf/mandate/pull/10), branch `feat/m2-election-setup-lifecycle-next`. The application, database acceptance/concurrency and Edge Function workflows passed on head `ad4db2897d30fe8623bcb1a8f03946cf443472c0`; rerun them for any subsequent branch update.
- Hosted Supabase migrations are applied through `0033_election_setup_confirmation_index`.
- Supabase security advisors have no WARN findings. RLS-enabled tables without policies are intentional private/default-deny tables; verify their access only through approved RPCs. Performance INFO findings currently include unused indexes because there is no production workload.
- Paystack initialize/verify/webhook functions are active with test-only checks. Paid voting and payouts are disabled.
- Organization invitation delivery is deployed fail-closed. The Supabase Edge Function secret `MANDATE_SITE_URL` is set to `https://mandate.markmachukhu97.workers.dev`; `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are not set.
- Resend has one domain entry, `poptraworld.digital`, in `not_started` status with its DNS records unconfigured. It is not referenced in Mandate project records. The Resend dashboard reports it is in use by another Resend team; verifying ownership would transfer it and revoke that team's access. Cloudflare currently has no DNS zones, so this domain has not been attached to Mandate.
- Cloudflare account has an active workers.dev subdomain but no production Worker or Pages project.
- Supabase Auth Site URL and signup callback allowlist have been verified in the hosted dashboard. Production signup, confirmation, login and password-reset flows are still untested because no Worker is deployed.

## Release sequence

### 1. Close readiness gates before merge

- [x] Set Supabase Auth Site URL to `https://mandate.markmachukhu97.workers.dev`.
- [x] Confirm the signup callback allowlist includes `https://mandate.markmachukhu97.workers.dev/auth/callback?next=*`. Email confirmation remains enabled.
- [ ] Confirm a project-controlled sending domain. Configure and verify its DNS in Resend, then set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in Supabase function secrets. The current Resend domain is unverified, is not confirmed as project-controlled, and is reported in use by another Resend team. Do not claim or verify it without explicit ownership and transfer authorization.
- [ ] Rotate the Paystack test secret previously exposed. Confirm Paystack mode remains test-only and live transactions remain disabled.
- [ ] Confirm required GitHub branch protection/review policy and deployment credentials are available. Never paste credential values into issues, logs or this document.
- [ ] Obtain the external legal, provider, custody and operational approvals required before enabling any paid-voting or payout feature. Those features remain off.
- [ ] Complete the M7 evidence in the pilot checklist below, or explicitly defer the pilot.

### 2. Review and merge

- [ ] Confirm PR #10 targets `main`, includes the current migration and docs, and all required checks passed on its exact head revision.
- [ ] Review the complete PR diff and migration sequence.
- [ ] Merge only after the Auth, email, security and pilot-scope gates above are resolved.
- [ ] Confirm the main-branch production workflow succeeds. The workflow builds and deploys the `mandate` Worker, then checks the homepage, sign-in and sign-up routes.

### 3. Production smoke checks

After deployment, from an independent network/session:

- [ ] `/` returns the Mandate landing page.
- [ ] `/login` and `/signup` return their expected pages.
- [ ] Unauthenticated access to `/dashboard` redirects to sign-in.
- [ ] A test account can sign up, receive confirmation, follow the callback, log in and reset its password.
- [ ] An owner can create an organization and invite an operator using a designated test mailbox; the invitee can accept it and receives only the assigned role.
- [ ] An authorized operator can create and resume a draft, confirm authority, configure an election, import a non-production test voter list, complete the registered-election lifecycle and publish the test results.
- [ ] CSV and PDF exports contain only published aggregates, are readable, and create `election.results.exported` audit events.
- [ ] A lower-privilege member cannot perform operator actions or export results. Unpublished results remain private.
- [ ] No real voter data, live election, real provider charge, transfer or payout is used during these checks.

Record the date, release commit, operator, test accounts (never passwords), outcomes and any defects in the Notion decision/state register.

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
