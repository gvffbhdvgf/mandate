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

- Working branch: [`feat/m0-vinext-foundation`](https://github.com/gvffbhdvgf/mandate/tree/feat/m0-vinext-foundation).
- The first application vertical slice includes the public landing page, Supabase email/password sign-up and sign-in actions, auth callback, organization creation, and a protected organization dashboard.
- Supabase migrations `0001`–`0014` are applied to the dedicated Mandate project and mirrored in `supabase/migrations`.
- CI runs contract tests, TypeScript checks, vinext compatibility scanning, production build, and a preview smoke test.
- The initial M0 build passed. The expanded validation pipeline is being exercised; check the [GitHub Actions history](https://github.com/gvffbhdvgf/mandate/actions).
- No production Worker has been deployed. Cloudflare Images account authorization is still unresolved.

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
- Do not expose voter registers, ballot choices, payment intents, participant identity, or ledger writes to browser roles.
- Do not expose service-role or provider secret keys in browser bundles.
- Paid public voting, payment settlement and wallet payouts stay feature-gated pending legal, provider, product, and operational approvals.
- Do not describe online elections as tamper-proof, coercion-proof, or equivalent to supervised secret paper ballots.

## Product documentation

The implementation specifications, decisions, risks, and delivery state are maintained in the [Mandate Notion workspace](https://app.notion.com/p/424d7d0ea58d8102a07cc5096b44b0cf). The MagicPath prototype is a visual reference only; its demo data and client-side voting logic are not production election processing.
