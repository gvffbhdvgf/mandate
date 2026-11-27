# SDD ledger — plan: docs/superpowers/plans/2026-11-27-mandate-human-centered-ui.md

- Base commit: `01ba0a9` (origin/main at branch creation).
- Branch: `fix/mandate-human-centered-ui`.
- Isolated workspace: fresh cloned repository in cloud box `real-dassie-23918`; unrelated existing workspaces were left untouched.
- Spec: `docs/superpowers/specs/2026-11-27-mandate-human-centered-ui-design.md`.
- Plan: `docs/superpowers/plans/2026-11-27-mandate-human-centered-ui.md`.

## Pre-flight conflict scan

| Task pair / task | Shared file or interface | What producer supplies / consumer expects | Finding and ruling |
|---|---|---|---|
| Task 1 → Task 2 | `lib/ui/presentation.ts` | Task 1 supplies status, voting mode, audit action and safe metadata formatting; Task 2 consumes these in election timeline and lifecycle UI. | Signatures implemented as specified. No conflict. |
| Task 1 → Task 2 | `app/organizations/[organizationId]/elections/[electionId]/page.tsx` | Task 1 wraps the page in the shared shell; Task 2 adds readiness/import presentation to the same page. | Sequential integration required; shell was added first, operational UI second. No conflicting ownership. |
| Task 1 → Task 3 | `app/components/workspace-shell.tsx`, `app/globals.css` | Task 1 supplies shell and design tokens; Task 3 applies the same system to remaining routes. | Shared shell is server-rendered; CSS tokens are global. No conflict. |
| Task 2 → Task 3 | `app/actions/voters.ts`, `app/actions/lifecycle.ts`, `app/actions/invitations.ts` | Task 2 adds server-validated confirmations; Task 3 does not change these actions. | No overlapping changes. Existing business rules remain authoritative. |
| Task 1 self-check | Helper tests vs helper interfaces | Tests exercise each exported formatter and metadata allowlist. | Consistent; tests assert exact output and safe omission of unknown/object values. |
| Task 2 self-check | CSV preview, readiness, audit, confirmations | UI previews client-side, server validates/stages again; readiness is derived from existing counts and lifecycle action rechecks. | Consistent. No database/schema/RLS changes. |
| Task 3 self-check | Shared shell, forms and ballot | Existing routes consume shared visual tokens; ballot retains equal candidate prominence and transaction-confirmed submission. | Consistent. No new unsupported payment/wallet surfaces were invented. |
| Task 4 self-check | Verification and integration | Test/build and browser checks precede any shared push or deployment. | No merge, push, PR or production deployment without the user's integration choice. |

## Rulings

- Ruling: Keep the existing Civic Forest identity and improve its hierarchy, typography, whitespace, navigation, controls and feedback rather than introduce a new brand — preserves the accepted UX specification; cost if wrong: visual direction rework.
- Ruling: Perform CSV row preview and error reporting locally in the browser, then retain server-side validation as the source of truth — avoids schema/RPC changes and prevents preview from becoming authoritative; cost if wrong: client/server validation drift, mitigated by server revalidation and matching rules/tests.
- Ruling: The existing invitation dispatcher sends email only; phone-only voter rows remain importable but cannot satisfy the invitation gate. Explain this limitation in the UI instead of changing eligibility or inventing SMS delivery — preserves actual provider behavior; cost if wrong: some organizations may need a different delivery workflow.
- Ruling: Keep payment, wallet, payout and platform-operations screens out of this visual redesign because they are not present in the current `main` application routes — avoids inventing capabilities; cost if wrong: those screens need a separate scope once implemented.
- Ruling: Keep all work on an isolated feature branch and do not push, merge or deploy — repository sharing and production deployment are side effects requiring the user's integration choice; cost if wrong: delivery is delayed until the user selects the next step.

## Progress

- Task 1: complete; helper tests, shared shell and design tokens implemented. Final verification passed.
- Task 2: complete; audit details humanized, opening checklist tested, CSV preview/error report added, and import/invitation/close/publish/member-revocation confirmations validated server-side. Final verification passed.
- Task 3: complete for existing routes; landing/auth/workspace/member/wizard/ballot/results UI aligned; focus, skip links, announcements, reduced motion and responsive rules added. Local browser screenshots reviewed for landing, sign-in and sign-up; authenticated admin screens and real narrow-viewport rendering remain unverified.
- Task 4: tests, typecheck, compatibility, build, route smoke checks and manual diff review complete. 44 tests passed; vinext reports 100% compatibility; production build completes. Build emits existing/toolchain sourcemap and dynamic-import warnings, with no build failure. No independent reviewer subagent tool is available in this chat. Notion spec and decision record updated and verified. Commit/push/PR remains pending user approval to share the branch; no merge or deployment.
