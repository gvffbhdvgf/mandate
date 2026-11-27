# Mandate Human-Centred UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the existing Mandate routes into a coherent, accessible, task-led experience without changing domain behavior.

**Architecture:** Retain the current Next-compatible React App Router and server actions. Add small shared presentation helpers and reusable workspace navigation/feedback components, then apply one consistent responsive Civic Forest design system across existing pages. No database or provider changes.

**Tech Stack:** React 19, TypeScript, Next-compatible App Router via vinext, CSS, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-27-mandate-human-centered-ui-design.md`

## Global Constraints

- Preserve all existing server-side authorization and transactional behavior.
- Do not change database schema, RLS, eligibility, election rules, payment policy, secrets or production settings.
- Do not deploy or merge to main in this task.
- WCAG 2.2 AA target; minimum touch target 44px; support 360px minimum width and reduced motion.
- Preserve Civic Forest palette and neutral election presentation.

## Review Focus

- Narrow mobile viewport with long election/organization names and dense controls.
- Long audit metadata values, null values and unfamiliar action names.
- Failed or pending server actions, rapid repeated submits and stale server state.
- A draft election with no voters, voters without invitations, and a confirmed setup whose configuration later changes.
- Voters using keyboard/screen reader or a ballot with many contests/options.

---

### Task 1: Shared presentation foundation

**Files:**
- Create: `lib/ui/presentation.ts`
- Create: `tests/ui-presentation.test.mjs`
- Modify: `app/globals.css`
- Modify: `app/layout.tsx`
- Create: `app/components/workspace-shell.tsx`
- Modify: `app/page.tsx`, `app/dashboard/page.tsx`, `app/organizations/[organizationId]/page.tsx`, `app/organizations/[organizationId]/elections/[electionId]/page.tsx`

**Interfaces:**
- Produces `formatStatusLabel(value: string): string`, `formatVotingMode(value: string): string`, `formatAuditAction(value: string): string` and `formatAuditMetadata(metadata: Record<string, unknown>): Array<{label: string; value: string}>`.
- Produces a reusable `WorkspaceShell` server component accepting `children`, `section`, `organizationName?`, `organizationHref?`, and `actions?`.

- [x] Write tests for status labels, voting mode labels, audit action labels, metadata allowlisting and empty/unknown values.
- [x] Run `node --test tests/ui-presentation.test.mjs`; confirm expected failures.
- [x] Implement presentation helpers with a strict allowlist; unknown values must not leak arbitrary objects or serialized payloads.
- [x] Add shared semantic workspace navigation and responsive shell; apply to authenticated workspace pages.
- [x] Add tokenized typography, spacing, surface, navigation, form, card, button, status, focus and responsive patterns.
- [x] Run focused tests, `npm test`, `npm run typecheck`, `npm run check:compat`; final full run passed 44 tests and 100% compatibility.

### Task 2: Election operations and voter import clarity

**Files:**
- Modify: `app/organizations/[organizationId]/elections/[electionId]/page.tsx`
- Modify: `app/organizations/[organizationId]/elections/[electionId]/audit-timeline.tsx`
- Modify: `app/organizations/[organizationId]/elections/[electionId]/voter-import-form.tsx`
- Modify: `app/organizations/[organizationId]/elections/[electionId]/commit-import-form.tsx`
- Modify: `app/organizations/[organizationId]/elections/[electionId]/dispatch-invitations-form.tsx`
- Modify: `app/organizations/[organizationId]/elections/[electionId]/setup-confirmation.tsx`
- Modify: `app/organizations/[organizationId]/elections/[electionId]/lifecycle-controls.tsx`
- Modify: `tests/contracts.test.mjs`

**Interfaces:**
- Consumes presentation helpers from Task 1.
- No database schema/RPC or domain-contract changes. Add server-validated confirmation fields only for existing consequential actions.

- [x] Add regression tests that the audit timeline uses human-readable event labels and does not serialize metadata as JSON in the default UI.
- [x] Run tests and confirm the regression test fails against current timeline.
- [x] Render audit metadata as allowlisted label/value rows with an optional event-detail disclosure.
- [x] Present the election readiness state with visible completed/pending items derived only from existing trusted page data; never claim invitations are complete unless issued.
- [x] Make the voter CSV template the first visible action; explain required/optional columns, E.164 format, uniqueness, size and row limits; separate validation from commit and prevent duplicate submits.
- [x] Improve action feedback and destructive-action clarity while preserving domain rules and database contracts; add only explicit server-side confirmation checks to existing consequential actions.
- [x] Run focused tests and full project checks; final full run passed 44 tests and 100% compatibility.

### Task 3: Remaining user journeys and accessibility polish

**Files:**
- Modify: `app/login/page.tsx`, `app/login/login-form.tsx`, `app/signup/page.tsx`, `app/signup/signup-form.tsx`
- Modify: `app/dashboard/create-organization-form.tsx`, `app/organizations/[organizationId]/members-panel.tsx`
- Modify: `app/vote/page.tsx`, `app/vote/contest-ballot-form.tsx`, `app/results/[electionId]/page.tsx`
- Modify: `app/invitations/accept/page.tsx`, `app/invitations/accept/invitation-token-capture.tsx`
- Modify: `app/organizations/[organizationId]/create-election-form.tsx`
- Modify: `tests/contracts.test.mjs`

**Interfaces:**
- Consumes shared tokens, shell and presentation helpers from Task 1.
- Preserves existing actions and server-side domain contracts.

- [x] Add tests for human-readable presentation, accessible status/focus defaults, neutral ballot and responsive accessibility tokens.
- [x] Run focused tests and confirm they fail on missing contracts.
- [x] Apply consistent page headers, form grouping, progress, empty states, member management, invitation states, ballot confirmation and result hierarchy.
- [x] Add visible focus, keyboard affordances, reduced-motion support, 44px interactive targets and responsive layouts.
- [x] Run all tests, typecheck, compatibility check and production build; final full run passed 44 tests and build completed.
- [ ] Inspect local preview at 360, 390, 768, 1024 and 1440px; fix visible defects.

### Task 4: Final quality review and handoff

**Files:**
- Review all changed UI files and tests.
- Update: `docs/superpowers/specs/2026-11-27-mandate-human-centered-ui-design.md` with verification results.

- [x] Run `npm run check` and `npm run build:vinext`; 44 tests pass, TypeScript passes, compatibility is 100%, build completes.
- [x] Inspect local browser preview for landing, sign-in and sign-up; smoke-check public routes and unauthenticated redirects. Full authenticated workflow and actual 360px/390px/768px browser captures remain open because no authenticated preview session or viewport control was available.
- [x] Review the diff for domain, auth, security, privacy and payment changes; no schema/RLS, eligibility, payment or production changes were introduced. Manual review completed; no independent code-review subagent is exposed in this chat.
- [ ] Commit/push changes and open a draft pull request against `main` after the user approves repository sharing.
- [x] Do not merge or deploy to production.
