# Mandate

**Organizational elections, made clear.**

Mandate is an organizational election management platform for associations, churches, cooperatives, schools, professional bodies, and other member-based organizations.

## Product direction

- Configure organization-specific election rules and workflows.
- Manage organizations, members, voter registers, nominations, contests, and election lifecycle.
- Support auditable, privacy-conscious election operations.
- Keep voter eligibility and payment identity separate from anonymous ballot choices.
- Provide clear reports and operational records.

## Technology

- **Application:** Next.js App Router API surface through [vinext](https://vinext.dev/) on Vite 8.
- **Runtime:** Cloudflare Workers with Workers Cache, Workers KV and Cloudflare Images optimization.
- **Backend:** Supabase PostgreSQL 17 and Supabase Auth.
- **Payments:** Paystack; paid voting and payouts remain disabled pending documented release gates.

vinext is actively developed and is not a drop-in replacement for every Next.js workload. The project keeps runtime compatibility checks and a production build in CI.

## Repository status

- Development foundation: [`feat/m0-vinext-foundation`](https://github.com/gvffbhdvgf/mandate/tree/feat/m0-vinext-foundation). Current M2 work: [`feat/m2-election-setup-lifecycle-next`](https://github.com/gvffbhdvgf/mandate/tree/feat/m2-election-setup-lifecycle-next).
- The application includes the public landing page, Supabase email/password sign-up/sign-in, auth callback, protected organization dashboard, organization creation, organization member administration/invitations (M1 code merged to the development branch; delivery gated), resumable six-step election setup (identity, voting mode, participation rules, contests/options, schedule/results visibility, and authority review), election detail view, private CSV voter-register import/commit, secure registered-voter ballot page, election open/pause/resume/close/tally/publish controls, visibility-aware results pages, and a redacted election activity timeline.
- Supabase migrations `0001`–`0030` are applied to the dedicated Mandate project. M1 organization membership migration `0031` and the M2 draft/editor/listing/audit migrations are committed to the development branch but have not been applied to hosted Supabase. A JWT-protected `send-voter-invitations` Edge Function is deployed (version 5).
- CI runs contract tests, TypeScript checks, vinext compatibility scanning, production builds, and preview smoke tests. The shared M1+M2 database-acceptance workflow resets a disposable local Supabase database, applies the full migration history, and runs all transactional SQL smoke tests. The M2 application workflow separately verifies contracts, types, compatibility and the Worker build; the M2 SQL acceptance rerun is pending on PR #10.
- GitHub Actions [run #117](https://github.com/gvffbhdvgf/mandate/actions/runs/45795597035) passed the contract tests, TypeScript, vinext compatibility scan, Worker bundle build, Cloudflare Workers runtime smoke test, and production preview HTTP smoke test. Remote Supabase transaction tests for tenant isolation, election setup, voter import and secret ballot context also passed and were rolled back. No actual election ballot has been cast; tally logic is not yet verified against live election data.
- No production Worker has been deployed. Cloudflare Images account authorization is still unresolved. The invitation Edge Function is deployed but cannot issue tokens or send emails until a verified Resend sender, API key and HTTPS site URL are configured. The connected Resend account has no sending domain. Election opening remains blocked until each eligible voter has an invitation issued.

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
```

The Cloudflare runtime configuration is in `cloudflare.config.ts`. The Supabase project URL and publishable key are public client configuration, not service credentials. Never put Supabase secret/service-role keys, Paystack secret keys, or webhook secrets in browser code or source control.

## Database

The migration history is the source of truth for schema changes. Apply new DDL through reviewed migrations, then verify the remote migration list and run Supabase security/performance advisors. All public tables must retain RLS. Ballot choices remain separated from voter identity and payment records.

## Security and release gates

- Enforce tenant isolation and role/resource authorization server-side and with database RLS.
- Election setup drafts are server-persisted and role-scoped. Election opening requires a recorded authority confirmation bound to a SHA-256 hash of the reviewed rules and candidate configuration; configuration drift invalidates that confirmation.
- Do not expose voter registers, ballot choices, payment intents, participant identity, or ledger writes to browser roles.
- Do not expose service-role or provider secret keys in browser bundles.
- Paid public voting, payment settlement and wallet payouts stay feature-gated pending legal, provider, product, and operational approvals.
- Do not describe online elections as tamper-proof, coercion-proof, or equivalent to supervised secret paper ballots.

## Product documentation

The implementation specifications, decisions, risks, and delivery state are maintained in the [Mandate Notion workspace](https://app.notion.com/p/424d7d0ea58d8102a07cc5096b44b0cf). The MagicPath prototype is a visual reference only; its demo data and client-side voting logic are not production election processing.
