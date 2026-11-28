# Mandate pilot readiness and operations

**Status:** production registered-election application deployed; pilot authorization remains pending.  
**Last verified:** 2026-11-28 08:04 EAT.

Production remains deployed, but pilot authorization is still pending. The current main branch and live Worker are verified separately below; a clean route smoke test is not evidence of an authenticated election workflow.

This runbook is an operator checklist. A checkbox is complete only when the linked system or evidence confirms it.

## Current known state

- M0–M5 registered-election release was consolidated in [PR #10](https://github.com/gvffbhdvgf/mandate/pull/10), merged to `main` at merge commit `47523f85435e46a15316940052827f38d1bd2465`. The PR head `4b0d8d5d2e293161c2ff02a8fd9b9195bb146097` passed the application, disposable database migration/invariant/concurrency and Paystack Edge Function workflows.
- Production Cloudflare Worker `mandate` is deployed at [https://mandate.markmachukhu97.workers.dev](https://mandate.markmachukhu97.workers.dev). Cloudflare deployment history confirms the latest 100% deployment is version `1c225df6-de2d-465b-9dc0-7e590b96b621`, deployed 2026-11-28 00:28 UTC from main commit `90ed75c9cae98d997d1f4cdfcbe2f6699c49c16e` (settlement reconciliation report). Production `/`, `/login` and `/signup` return HTTP 200. `/forgot-password` and `/reset-password` currently return 404; the completed password-recovery implementation is under review in [draft PR #31](https://github.com/gvffbhdvgf/mandate/pull/31), not yet deployed.
- A read-only independent Chrome smoke check on 2026-11-27 confirmed the homepage, `/login` and `/signup` render expected Mandate content; unauthenticated `/dashboard` redirects to `/login`. Login/signup fields have accessible labels and expected input types; signup keyboard focus traversed name, email, password and submit. No form was submitted and no account or application data was changed. The same inspection found `/forgot-password` returns 404 and login has no recovery link; proposed fix is open in [PR #16](https://github.com/gvffbhdvgf/mandate/pull/16), not merged or deployed.
- Supabase project `yhdosrhtzcsfqfuuqhsk` (Mandate, `eu-central-1`) is `ACTIVE_HEALTHY`, with hosted migrations through `0049_single_merchant_public_vote_payments`.
- Read-only schema review confirmed 27 public application tables have RLS enabled. Sixteen have no direct client policies and are protected by default-deny grants/RPC boundaries; the remaining tables have explicit organization/role policies. Sensitive election, ballot, payment and ledger tables do not grant direct anon/authenticated access. Token-based registered-ballot context/casting RPCs intentionally allow anon execution; the functions validate high-entropy access tokens, election window, frozen snapshots and duplicate-vote constraints.
- Security-definer private functions inspected in the hosted database set a fixed `search_path=pg_catalog`; the exposed public wrappers are security-invoker functions. Invitation acceptance requires a signed-in user with a confirmed email matching the invitation, checks expiry/status, locks the invitation row and writes an audit event.
- Supabase security advisors currently report one WARN: leaked-password protection is disabled. The project is on the Free plan; do not upgrade or incur cost without explicit approval. Latest read-only advisor findings: 24 RLS-enabled/no-policy INFO notices, 8 unindexed-FK INFO notices and 50 unused-index INFO notices. A separate privilege audit found no direct table grants to `PUBLIC`, `anon` or `authenticated` for the 24 server-only tables, and no exposed `SECURITY DEFINER` functions in `public`. Do not add broad policies or remove indexes merely to silence informational findings.
- Latest read-only production counts: four elections, all in `draft`; one pending `platform_fee` payment intent for KES 500 with no provider transaction ID or provider status; zero payment events and zero posted ledger transactions. The pending intent was not changed. No real end-to-end paid checkout is thereby verified. Use isolated test data for lifecycle tests.
- Active hosted Edge Functions read back on 2026-11-28: `paystack-initialize` v13, `paystack-verify` v13, `paystack-webhook` v13, `paystack-settlement-import` v3, `public-vote-credit-intent` v2, `public-participant-session` v2, `public-election-details` v2, `send-voter-invitations` v18 and `send-organization-invitation` v9. All payment-purpose flags remain false: public vote credits, platform fees and organization top-ups. Settlement readiness and live transactions remain fail-closed.
- Supabase Auth Site URL is `https://mandate.markmachukhu97.workers.dev`; the callback allowlist includes `https://mandate.markmachukhu97.workers.dev/auth/callback?next=*`. Edge Function secret `MANDATE_SITE_URL` matches the production origin.
- Resend domain `poptraworld.digital` is verified in region `eu-west-1`; sending and receiving are enabled, and current Resend read-back confirms DKIM, SPF and receiving DNS records are verified. The replacement API key `Mandate production email sender replacement` remains active; it is restricted to sending access for `poptraworld.digital`. The earlier key `Mandate production email sender` was revoked and is absent from the active key list. Never copy API-key values into source control or documentation.
- Supabase Edge Function Secrets was reloaded after save: both `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are present; `RESEND_FROM_EMAIL` was explicitly saved as `noreply@poptraworld.digital`. Secret values remain redacted. `MANDATE_SITE_URL` is configured. One provider-level Resend test message was delivered to the user-confirmed controlled mailbox; the Supabase Edge Function's stored API-key path has not yet been tested. No real voter/organization invitation, ballot, live provider charge, transfer or payout is represented as verified.
- Resend usage read-back before testing was 0/100 daily and 0/3,000 monthly, consistent with the $0 Free transactional allowance. After the user confirmed the sender and controlled recipient, one isolated provider-level test was sent and Resend `get_email` confirmed `delivered` for `noreply@poptraworld.digital` → the confirmed test mailbox (email ID `01a21be0-0f7b-74cc-9842-f6e0bd587f22`). No invitation function was called. This does not prove the Supabase Edge Function can use its stored API key; application-level isolated verification remains open.
- Supabase Auth email is a separate delivery path from the Resend Edge Function sender. The Resend domain `poptraworld.digital` is verified and an API key named `Mandate Supabase Auth SMTP` exists, but custom SMTP host/port/sender/password and Auth confirmation/recovery templates have not been read back as configured. A read-only browser check could not proceed because the connected Supabase dashboard session was signed out. Configure SMTP (`smtp.resend.com`, port `465`, username `resend`) with the already-created domain-scoped sending key, then test confirmation and password recovery to a controlled mailbox. The provider-level Resend test does not verify Supabase Auth SMTP.
- Supabase Free does not include automatic daily database backups or downloadable automatic backups; Supabase documents manual logical backups with `supabase db dump` as the Free-plan path. No manual export or independent restore drill is evidenced. Keep recovery readiness open until an off-site manual backup and successful restore test are verified. No paid upgrade or PITR add-on is required for the manual path.

## Release and production verification

### Completed

- [x] PR #10 reviewed, merged to `main`, and required application/database/Edge Function checks passed on the recorded PR head.
- [x] Production Worker deployed from `main`.
- [x] Production deployment workflow passed home, login and signup route smoke checks.
- [x] Independent read-only browser smoke check confirmed homepage, login and signup render and unauthenticated `/dashboard` redirects to `/login`.
- [x] Supabase Auth production Site URL and callback allowlist configured.
- [x] Hosted Supabase migration history verified through `0049_single_merchant_public_vote_payments`.
- [x] Supabase security advisors checked; one Auth leaked-password-protection WARN remains open.
- [x] Read-only database review of RLS coverage, sensitive table grants, security-definer function search paths, ballot token checks, invitation acceptance rules and core constraints completed.
- [x] Paystack payment-mode guard inspected in deployed shared Edge Function source; it requires test-mode credentials and rejects live-mode enablement.

### Still required before real pilot use

- [ ] Merge and deploy [PR #31](https://github.com/gvffbhdvgf/mandate/pull/31) after its database acceptance workflow completes; then use a designated test account and controlled mailbox to verify reset request, callback, password update, sign-in and expired-link recovery. PR #31 currently passes Mandate CI and Paystack Edge integration; all SQL and concurrency acceptance steps passed and disposable-stack cleanup is finishing.
- [x] Verify the project sender domain `poptraworld.digital` in Resend and confirm sending/receiving DNS checks; use only the designated Mandate sending identity.
- [x] Confirm `RESEND_API_KEY` and `RESEND_FROM_EMAIL` persist in Supabase Edge Function secrets after reload. Use the restricted sending-only key; secret values remain redacted.
- [x] Send and verify one isolated provider-level test message through Resend to the user-confirmed controlled mailbox; Resend read-back confirms `delivered`. This verifies Resend delivery from the domain, not the Supabase Edge Function's stored key; a separate application-level test remains required. No voter/organization invitation function was invoked.
- [ ] Confirm the saved Supabase Auth minimum-length and character-requirement settings match the app's 10-character minimum. Resolve the leaked-password-protection WARN only if the project is moved to Pro with explicit cost approval; until then document the residual WARN.
- [ ] Send and verify one isolated transactional test message through the Supabase Edge Function's stored Resend API key without invoking voter/organization invitation flows.
- [ ] Configure and verify Supabase Auth custom SMTP with Resend, then test signup confirmation and password recovery to a controlled mailbox.
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
