# Mandate

**Organizational elections, made clear.**

Mandate is an organizational election management platform for associations, churches, cooperatives, schools, professional bodies, and other member-based organizations.

## Product scope

- Organization workspaces, role-scoped membership and invitations.
- Resumable six-step election setup with explicit authority confirmation.
- Voter-register import, validation, private staging and explicit commit.
- Token-based voter access and secret ballot submission with voter identity separated from ballot choices.
- Audited election opening, pause, resume, close, tally reconciliation and results publication.
- Redacted election activity timelines.
- Server-side Paystack initialization, verification and signed webhook processing; public paid voting remains disabled.

## Production architecture

- **Application:** Next.js App Router surface through vinext on Vite.
- **Hosting:** Cloudflare Workers.
- **Runtime services:** Workers Cache and the existing Workers KV namespace.
- **Backend:** Supabase PostgreSQL and Supabase Auth.
- **Payments:** Paystack Edge Functions, guarded to test mode only.
- **Email:** Supabase Auth confirmation plus Resend for organization invitations when a verified sender is configured.

The runtime deliberately does not bind Cloudflare Images. The application does not currently use image optimization, and removing that unused binding avoids an account authorization dependency and keeps the deployment on the existing free-tier services.

## Release contents

The consolidated M2 release branch includes:

- The M0 Cloudflare/Vinext foundation and registered-election lifecycle.
- M1 organization membership, invitation acceptance and role controls.
- M2 resumable election drafts and database-enforced authority confirmation.
- Private trigger-function ACL hardening.
- Full registered-election lifecycle acceptance coverage.
- Independent-session concurrency tests for duplicate ballots, election pause/close and tally races.
- Server-side Paystack integration with strict test-mode gates.
- Signup error classification and safe provider diagnostics.
- Read-only CI, consolidated database acceptance, Deno Edge Function checks, and a main-only production deployment workflow.

The production workflow is `.github/workflows/production-deploy.yml`. It validates and builds the application, deploys the Worker named `mandate` only from `main`, and smoke-tests the homepage, sign-in and sign-up routes. The intended workers.dev origin is:

`https://mandate.markmachukhu97.workers.dev`

A production deployment is not considered complete until the main-branch workflow and public route checks succeed.

## Database state and release gates

- The hosted Supabase project has migrations through `0030_atomic_paystack_webhook_processing`.
- The release includes the private trigger ACL revocation, M1 organization-membership invitation migration `0031`, and three M2 election-draft/audit migrations. These must pass the disposable database acceptance suite before being applied to the hosted project.
- `send-voter-invitations` and the Paystack Edge Functions are deployed. Organization-invitation delivery still requires a verified Resend sender domain, API key and the production HTTPS site URL.
- Supabase Auth must allow the production callback URL before email-confirmation signup can complete. Email confirmation must remain enabled.
- Paystack processing is restricted to test credentials. No live charges, transfers, payouts or paid-vote credits are enabled.
- No actual voter invitation or ballot has been issued/cast in a live election. Tally logic has not been verified against live election data.

## Local development

Requirements: Node.js 22.12+.

```bash
npm ci
npm run dev:vinext
```

Validation:

```bash
npm run check
npm run build:vinext
npm run test:concurrency
```

## Database and security

The migration history is the source of truth for schema changes. Apply reviewed migrations in timestamp order, then verify the remote migration list and run Supabase security/performance advisors. All public tables must retain RLS. Ballot choices remain separated from voter registers, participant identity and payment records.

Never put Supabase service-role keys, Paystack secret keys, webhook secrets, or Resend API keys in browser code or source control.

Paid public voting, payment settlement and wallet payouts remain feature-gated pending documented release, legal, provider and operational approval. Do not describe online elections as tamper-proof, coercion-proof, or equivalent to supervised secret paper ballots.

## Product documentation

Implementation specifications, decisions, risks and delivery state are maintained in the [Mandate Notion workspace](https://app.notion.com/p/424d7d0ea58d8102a07cc5096b44b0cf). The MagicPath prototype is a visual reference only; its demo data and client-side voting logic are not production election processing.
