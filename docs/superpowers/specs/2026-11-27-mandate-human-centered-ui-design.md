# Mandate Human-Centred UI Redesign

## Intent

Make Mandate understandable and dependable for organization owners, administrators, election managers, returning officers, finance staff, members and voters. People should be able to understand where they are, what has happened, what they can do next and what will happen after an action without needing technical knowledge.

## Goals

- Establish one coherent Civic Forest design system across all existing routes.
- Improve task hierarchy, navigation, page composition, readability and responsive behavior.
- Make every consequential interaction communicate idle, submitting, processing, success, failure or attention-required states.
- Replace technical payload dumps with plain-language summaries and optional, human-readable detail disclosure.
- Make voter CSV template, requirements, validation result and commit state discoverable and understandable.
- Make election readiness and lifecycle blockers visible before users attempt irreversible actions.
- Keep the voter ballot neutral, private, accessible and focused.
- Preserve existing server actions, database contracts, authorization boundaries, payment gates and election rules.
- Test keyboard use, focus visibility, contrast, responsive layouts and reduced-motion behavior.

## Users and contexts

- Organization owners/admins: establish a workspace, assign access, oversee elections and protect authority boundaries.
- Election managers: configure elections, import eligible voters, issue invitations, verify readiness and operate the lifecycle.
- Returning officers: oversee election integrity, close voting, reconcile and publish results.
- Finance managers: require clear, non-ambiguous payment state and separation of balances and settlement status when those screens exist.
- Members and voters: understand invitations, ballot instructions, privacy, submission status and published results.
- Contexts include desktop administration, small-screen/mobile access, assistive technology, intermittent connectivity and time-sensitive election operations.

## Design principles

1. Human-centred lifecycle: understand roles, tasks and environments; evaluate and iterate across the whole experience.
2. Visibility of system status: show what the system is doing and what has durably completed.
3. Match the real world: use familiar language, dates, statuses and task order; avoid internal jargon.
4. User control and error prevention: confirm irreversible actions, prevent duplicate submissions and preserve safe recovery paths.
5. Recognition over recall: keep requirements, progress, constraints and next steps visible in context.
6. Consistency: reuse navigation, controls, status language, spacing, typography and interaction behavior.
7. Visual hierarchy: use scale, contrast, balance, proximity and grouping to make primary tasks obvious.
8. Minimalism with purpose: remove noise, not necessary information; technical details are secondary and explicitly disclosed.
9. Accessibility: WCAG 2.2 AA target, semantic landmarks/headings, labels, keyboard operation, visible focus, screen-reader announcements, reduced motion and no color-only status.
10. Neutrality and trust: equal candidate prominence; no campaign-like styling, gamification or premature success states.

## Visual system

Retain Civic Forest tokens: Forest #1F3D32, Jade #3E735B, Heritage Gold #B58A4A, Warm Ivory #F7F6F1, White #FFFFFF, Ink #202B25, Muted Sage #65736A, Soft Stone #E3E8E1, Success #237A52, Warning #A15C12, Danger #B42318, Information #245EA8. Inter/system-ui typography. Use consistent type scale, 4px spacing base, restrained borders/shadows, clear focus states, touch targets >=44px and a readable content width. Retest actual color pairings against WCAG 2.2 AA.

## Scope

All existing user-facing routes: landing, sign-up, sign-in, invitation acceptance, dashboard, organization workspace, member management, election creation/editing, election detail and lifecycle, voter import/invitations, activity timeline, ballot, public results and report affordances. Shared styling/components must be reusable across these routes.

Do not invent unimplemented wallet, payout, finance, analytics or platform-operations screens as part of a visual-only task. Where those capabilities are not present in the current app, do not imply they are available.

## Constraints and non-goals

- No production deployment or direct changes to production data/settings.
- No schema, RLS, auth provider, eligibility, voting, ledger or payment-policy changes.
- No enabling paid voting or payment release flags.
- No changes to election business rules, role permissions, voter identity/ballot separation or privacy guarantees.
- Preserve existing server-side authorization and durable transaction contracts.
- No fake metrics, demo voters, sample election activity presented as real data, or misleading empty states.

## Implementation approach

A shared visual foundation and navigation first, then task-focused improvements to operational screens and user-facing flows. Prefer semantic HTML and existing React/Next patterns. Extract small reusable UI helpers only where they improve consistency. Keep data and domain logic server-side; client components own local interaction state only.

## Acceptance criteria

- A first-time administrator can find the primary next action on dashboard, organization and election pages.
- Election status and lifecycle controls use plain-language labels and explain prerequisites.
- Voter CSV template is visible before file selection; requirements and upload limits are explained; validation and commit are clearly distinct; duplicate submissions are prevented; success appears only after server confirmation.
- Audit activity is human-readable; no raw serialized payload is exposed in the normal view; any technical detail is optional and readable.
- Forms provide persistent, actionable errors and clear pending/success feedback.
- Ballot choices have equal prominence, accessible selection controls and truthful final confirmation.
- Layout works at 360, 390, 768, 1024 and 1440px without horizontal page overflow.
- Keyboard focus, screen-reader status announcements, reduced motion and contrast are checked.
- Existing business/security tests remain green; new UI contract tests cover the highest-risk presentation rules.
