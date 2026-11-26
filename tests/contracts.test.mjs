import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Cloudflare runtime uses the selected edge-ready adapters", async () => {
  const vite = await read("../vite.config.ts");
  const cloudflare = await read("../cloudflare.config.ts");
  assert.match(vite, /workersCacheCdnAdapter/);
  assert.match(vite, /kvDataAdapter/);
  assert.match(vite, /imagesOptimizer/);
  assert.match(cloudflare, /bindings\.images\(\)/);
  assert.match(cloudflare, /bindings\.kv\(\{ id:/);
  assert.match(cloudflare, /8df55d8d27e74f058c2ae3013ae71ded/);
});

test("ballot storage remains separated from voter and participant identity", async () => {
  const migration = await read("../supabase/migrations/20261126090336_0005_participants_and_ballots.sql");
  const ballotBlock = migration.split("create table public.ballots (")[1]?.split(");")[0] ?? "";
  assert.ok(ballotBlock.length > 0);
  assert.doesNotMatch(ballotBlock, /voter_id|participant_id|phone|email|payment_id|token/i);
  assert.match(migration, /create table public\.ballot_submission_controls/);
  assert.match(migration, /revoke all on public\.public_participants[\s\S]*?from anon,authenticated/);
});

test("paid voting is explicitly feature-gated", async () => {
  const migration = await read("../supabase/migrations/20261126090424_0009_transaction_functions_and_guards.sql");
  assert.match(migration, /PAID_VOTING_FEATURE_GATED/);
  assert.match(migration, /public_paid/);
});

test("privileged ballot RPC is not granted to browser roles", async () => {
  const migration = await read("../supabase/migrations/20261126090424_0009_transaction_functions_and_guards.sql");
  assert.match(migration, /revoke all on function public\.cast_registered_ballot[\s\S]*?from public,anon,authenticated/);
  assert.match(migration, /grant execute on function public\.cast_registered_ballot[\s\S]*?to service_role/);
});

test("election setup is atomic and cannot enable paid voting", async () => {
  const migration = await read("../supabase/migrations/20261126091620_0017_atomic_election_setup_rpc.sql");
  assert.match(migration, /create function public\.create_election_setup/);
  assert.match(migration, /mandate_private\.create_election\(/);
  assert.match(migration, /mandate_private\.create_contest\(/);
  assert.match(migration, /mandate_private\.create_option\(/);
  assert.match(migration, /jsonb_array_length\(p_contests\)<1/);
});

test("voter imports use private storage and election opening requires issued access", async () => {
  const imports = await read("../supabase/migrations/20261126092010_0019_private_voter_import_storage_and_transactions.sql");
  const opening = await read("../supabase/migrations/20261126092140_0020_require_voter_access_before_election_open.sql");
  assert.match(imports, /public=false/);
  assert.match(imports, /mandate-voter-imports/);
  assert.match(imports, /stage_voter_import/);
  assert.match(imports, /commit_voter_import/);
  assert.match(opening, /VOTER_ACCESS_NOT_ISSUED/);
  assert.match(opening, /access_token_hash is null or v\.invited_at is null/);
});

test("voter register import is private, bounded and requires access issuance before opening", async () => {
  const imports = await read("../supabase/migrations/20261126092010_0019_private_voter_import_storage_and_transactions.sql");
  const opening = await read("../supabase/migrations/20261126092140_0020_require_voter_access_before_election_open.sql");
  assert.match(imports, /file_size_limit=10485760/);
  assert.match(imports, /v_count>25000/);
  assert.match(imports, /mandate-voter-imports/);
  assert.match(imports, /stage_voter_import/);
  assert.match(imports, /commit_voter_import/);
  assert.match(opening, /VOTER_ACCESS_NOT_ISSUED/);
});

test("browser-safe CSV parser handles quoted voter fields", async () => {
  const { parse } = await import("csv-parse/browser/esm/sync");
  const rows = parse(`voter_ref,name,email
V-1,"Voter, One",one@example.org
`, {
    columns: true, skip_empty_lines: true, bom: true, trim: true,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Voter, One");
});

test("registered ballot access does not expose voter identity", async () => {
  const migration = await read("../supabase/migrations/20261126092410_0021_registered_voter_ballot_context_and_public_cast.sql");
  const ballotPage = await read("../app/vote/page.tsx");
  const invitation = await read("../supabase/functions/send-voter-invitations/index.ts");
  assert.match(migration, /get_registered_ballot_context/);
  assert.match(migration, /alreadyVoted/);
  assert.match(migration, /grant execute on function public\.cast_registered_ballot.*to anon/);
  assert.match(ballotPage, /window\.location\.hash/);
  assert.match(ballotPage, /history\.replaceState/);
  assert.match(invitation, /#\$\{token\}/);
  assert.doesNotMatch(invitation, /receiptCode.*token/i);
});

test("invitation dispatcher uses recoverable claims and never returns raw tokens", async () => {
  const migration = await read("../supabase/migrations/20261126092940_0023_voter_invitation_claim_recovery.sql");
  const functionSource = await read("../supabase/functions/send-voter-invitations/index.ts");
  const functionConfig = await read("../supabase/config.toml");
  assert.match(migration, /invitation_attempted_at/);
  assert.match(functionSource, /pendingClaimFilter/);
  assert.match(functionSource, /15 \* 60 \* 1000/);
  assert.match(functionSource, /access_token_hash: tokenHash/);
  assert.match(functionSource, /sha256Hex/);
  assert.match(functionConfig, /verify_jwt = true/);
  assert.doesNotMatch(functionSource, /return json\(200,\s*\{[^}]*token\s*:/i);
});

test("election tally reconciles ballots before publishing aggregate results", async () => {
  const migration = await read("../supabase/migrations/20261126093220_0024_election_tally_reconciliation_and_results.sql");
  const summary = await read("../supabase/migrations/20261126093540_0025_read_only_election_tally_summary.sql");
  const resultsPage = await read("../app/results/[electionId]/page.tsx");
  assert.match(migration, /BALLOT_CONTROL_RECONCILIATION_FAILED/);
  assert.match(migration, /ELECTION_SNAPSHOT_HASH_MISMATCH/);
  assert.match(migration, /RESULT_RESOLUTION_REQUIRED/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /public\.get_published_results/);
  assert.match(summary, /get_tally_summary/);
  assert.match(resultsPage, /get_published_results/);
});

test("election pause and resume transitions are reasoned and audited", async () => {
  const migration = await read("../supabase/migrations/20261126094720_0027_pause_and_resume_election.sql");
  const actions = await read("../app/actions/lifecycle.ts");
  assert.match(migration, /ELECTION_NOT_OPEN/);
  assert.match(migration, /ELECTION_NOT_PAUSED/);
  assert.match(migration, /ELECTION_WINDOW_ENDED/);
  assert.match(migration, /election\.paused/);
  assert.match(migration, /election\.resumed/);
  assert.match(actions, /rpc\("pause_election"/);
  assert.match(actions, /rpc\("resume_election"/);
});

test("election audit timeline exposes only redacted non-ballot activity", async () => {
  const migration = await read("../supabase/migrations/20261126094950_0028_redacted_election_audit_timeline_rpc.sql");
  const component = await read("../app/organizations/[organizationId]/elections/[electionId]/audit-timeline.tsx");
  assert.match(migration, /action not like 'ballot\.%'/);
  assert.match(migration, /action not like 'payment\.%'/);
  assert.match(migration, /action not like 'wallet\.%'/);
  assert.match(migration, /redacted_metadata/);
  assert.match(migration, /grant execute on function public\.get_election_audit_trail.*to authenticated/);
  assert.match(component, /Event details/);
});

test("audit timeline uses a strict action allowlist and removes free-text metadata", async () => {
  const migration = await read("../supabase/migrations/20261126095110_0029_allowlist_audit_timeline_metadata.sql");
  assert.match(migration, /action=any\(array\[/);
  assert.match(migration, /'voter_invitation\.batch_dispatched'/);
  assert.match(migration, /- 'reason'|- 'reason'|-'reason'/);
  assert.match(migration, /'privateObjectPath'/);
});


test("organization invitations are single-use, role-scoped and email-bound", async () => {
  const migration = await read("../supabase/migrations/20261126150000_0031_organization_membership_invitations.sql");
  const dispatcher = await read("../supabase/functions/send-organization-invitation/index.ts");
  const actions = await read("../app/actions/organization-members.ts");
  const acceptance = await read("../app/invitations/accept/page.tsx");
  assert.match(migration, /token_hash text not null unique/);
  assert.match(migration, /expires_at timestamptz not null/);
  assert.match(migration, /INVITATION_EMAIL_MISMATCH/);
  assert.match(migration, /INVITATION_EMAIL_NOT_VERIFIED/);
  assert.match(migration, /email_confirmed_at/);
  assert.match(migration, /INVITATION_NOT_AVAILABLE/);
  assert.match(migration, /ROLE_ASSIGNMENT_REQUIRES_OWNER/);
  assert.match(migration, /OWNER_TRANSFER_REQUIRED/);
  assert.match(migration, /organization\.member\.joined/);
  assert.match(dispatcher, /RESEND_API_KEY/);
  assert.match(dispatcher, /sha256Hex/);
  assert.match(dispatcher, /INVITATION_DELIVERY_NOT_CONFIGURED/);
  assert.match(dispatcher, /invitationUrl\.hash/);
  assert.doesNotMatch(dispatcher, /searchParams\.set\(["']token/);
  assert.doesNotMatch(dispatcher, /return json\(200,[\s\S]*?token\s*:/i);
  assert.match(actions, /accept_organization_invitation/);
  assert.match(actions, /httpOnly:\s*true/);
  assert.match(acceptance, /Sign in to accept/);
  const tokenCapture = await read("../app/invitations/accept/invitation-token-capture.tsx");
  assert.match(tokenCapture, /window\.location\.hash/);
  assert.match(tokenCapture, /history\.replaceState/);
});

test("invitation authentication redirects are restricted to the signed invitation path", async () => {
  const navigation = await read("../lib/navigation.ts");
  const auth = await read("../app/actions/auth.ts");
  const callback = await read("../app/auth/callback/route.ts");
  assert.match(navigation, /startsWith\("\/\/"\)/);
  assert.match(navigation, /resolved\.pathname !== "\/invitations\/accept"/);
  assert.match(navigation, /resolved\.search !== ""/);
  assert.match(navigation, /resolved\.hash !== ""/);
  assert.match(auth, /safeInternalPath/);
  assert.match(callback, /safeInternalPath/);
});


test("M2 election setup drafts are resumable and authority confirmation is enforced in the database", async () => {
  const drafts = await read("../supabase/migrations/20261126204535_m2_election_draft_editor.sql");
  const listing = await read("../supabase/migrations/20261126204653_m2_election_draft_listing.sql");
  const wizard = await read("../app/organizations/[organizationId]/create-election-form.tsx");
  const actions = await read("../app/actions/elections.ts");
  const organization = await read("../app/organizations/[organizationId]/page.tsx");
  const smoke = await read("../supabase/tests/election_setup_draft_smoke.sql");
  const audit = await read("../supabase/migrations/20261126205024_m2_election_setup_audit_event.sql");
  const electionPage = await read("../app/organizations/[organizationId]/elections/[electionId]/page.tsx");
  assert.match(drafts, /create table public\.election_setup_drafts/);
  assert.match(drafts, /enable row level security/);
  assert.match(drafts, /save_election_setup_draft/);
  assert.match(drafts, /finalize_election_setup_draft/);
  assert.match(drafts, /confirm_election_setup/);
  assert.match(drafts, /setup_confirmation_hash/);
  assert.match(drafts, /ELECTION_SETUP_NOT_CONFIRMED/);
  assert.match(drafts, /ELECTION_SETUP_CHANGED_RECONFIRM/);
  assert.equal((drafts.match(/'profile',o\.profile/g) ?? []).length, 2);
  assert.match(drafts, /public\.get_election_setup_draft\(p_draft_id uuid\)[\s\S]*?security invoker/);
  assert.match(drafts, /public\.finalize_election_setup_draft\(p_draft_id uuid\)[\s\S]*?security invoker/);
  assert.match(drafts, /public\.confirm_election_setup\(p_election_id uuid\)[\s\S]*?security invoker/);
  assert.match(listing, /mandate_private\.list_election_setup_drafts/);
  assert.match(listing, /security invoker/);
  assert.doesNotMatch(listing, /payload jsonb/);
  assert.match(wizard, /Step \{step\} of 6/);
  assert.match(wizard, /I confirm that I am authorized/);
  assert.match(wizard, /Election timezone/);
  assert.match(wizard, /isoFromLocalDateTime/);
  assert.match(electionPage, /option\.profile/);
  assert.match(actions, /authorityConfirmed: z\.literal\(true\)/);
  assert.match(organization, /list_election_setup_drafts/);
  assert.match(smoke, /select id into v_org from public\.organizations/);
  assert.match(smoke, /DRAFT_NOT_RESUMABLE/);
  assert.match(smoke, /UNAUTHORIZED_DRAFT_EDIT_SHOULD_FAIL/);
  assert.match(smoke, /UNCONFIRMED_SETUP_MUST_NOT_OPEN/);
  assert.match(smoke, /AUTHORITY_CONFIRMATION_NOT_RECORDED/);
  assert.match(smoke, /CONFIGURATION_DRIFT_MUST_REQUIRE_RECONFIRMATION/);
  assert.match(smoke, /PUBLIC_RPC_WRAPPER_MUST_BE_SECURITY_INVOKER/);
  assert.match(smoke, /PRIVATE_RPC_IMPLEMENTATION_MUST_BE_SECURITY_DEFINER/);
  assert.match(audit, /election\.setup_confirmed/);
  assert.match(audit, /action=any\(array\[/);
});
