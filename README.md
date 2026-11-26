# Mandate

**Organizational elections, made clear.**

Mandate is an organizational election management platform designed for associations, churches, cooperatives, schools, professional bodies, and other member-based organizations.

## Product direction

- Configure organization-specific election rules and workflows.
- Manage voter registers, nominations, contests, and election lifecycle.
- Support auditable, privacy-conscious election operations.
- Keep voter eligibility and payment identity separate from ballot choices.
- Provide clear reports and operational records.

## Planned technology

- **Application:** Next.js
- **Backend:** Supabase (PostgreSQL, Auth, and supporting services)
- **Runtime and deployment:** Cloudflare Workers / OpenNext
- **Payments:** Paystack (feature-gated; not enabled by default)

## Engineering status

Product and engineering specifications are maintained in the Mandate Notion workspace. The current MagicPath prototype is a UI demonstration only; it is not a production voting system.

Implementation has not yet been certified. Do not treat planned capabilities as implemented until code, tests, and deployment evidence are available.

## Security principles

- Enforce tenant isolation and role-based authorization server-side.
- Protect voter registers and election administration data.
- Do not expose individual ballot choices to ordinary organization roles.
- Keep secrets out of source control and browser bundles.
- Gate paid voting and wallet payouts until legal, provider, product, and operational approvals are complete.

## Development

Project setup, environment requirements, migration workflow, and deployment instructions will be added as the implementation baseline is established. Never commit credentials or production secrets.