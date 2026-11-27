import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Cloudflare runtime uses free-tier cache adapters without an Images dependency", async () => {
  const vite = await read("../vite.config.ts");
  const cloudflare = await read("../cloudflare.config.ts");
  assert.match(vite, /workersCacheCdnAdapter/);
  assert.match(vite, /kvDataAdapter/);
  assert.doesNotMatch(vite, /imagesOptimizer/);
  assert.doesNotMatch(cloudflare, /bindings\.images\(\)/);
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
  assert.match(component, /View event information/);
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

test("authentication redirects allow only invitation and payment callback return paths", async () => {
  const navigation = await read("../lib/navigation.ts");
  const auth = await read("../app/actions/auth.ts");
  const authCallback = await read("../app/auth/callback/route.ts");
  const paymentCallback = await read("../app/payments/paystack/callback/route.ts");
  assert.match(navigation, /startsWith\("\/\/"\)/);
  assert.match(navigation, /resolved\.pathname === "\/invitations\/accept"/);
  assert.match(navigation, /resolved\.pathname === "\/payments\/paystack\/callback"/);
  assert.match(navigation, /entries\.length !== 1/);
  assert.match(navigation, /referencePattern|A-Za-z0-9/);
  assert.match(auth, /safeInternalPath/);
  assert.match(authCallback, /safeInternalPath/);
  assert.match(paymentCallback, /functions\.invoke\("paystack-verify"/);
  assert.match(paymentCallback, /getUser\(\)/);
  assert.match(paymentCallback, /do not pay again/i);
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
  assert.match(wizard, /new Date\(election\.ends_at\)\.toLocaleString\("en-KE", \{ timeZone: election\.timezone \}\)/);
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


test("signup failures return safe guidance and log provider diagnostics", async () => {
  const auth = await read("../app/actions/auth.ts");
  assert.match(auth, /function signUpErrorMessage/);
  assert.match(auth, /email_exists/);
  assert.match(auth, /weak_password/);
  assert.match(auth, /over_email_send_rate_limit/);
  assert.match(auth, /redirect_to_not_allowed/);
  assert.match(auth, /\[auth\.signup\] Supabase rejected sign-up/);
  assert.doesNotMatch(auth, /return \{ error: error\.message/);
});

test("Paystack webhook application is atomic, idempotent and retryable", async () => {
  const migration = await read("../supabase/migrations/20261126121209_0030_atomic_paystack_webhook_processing.sql");
  const webhook = await read("../supabase/functions/paystack-webhook/index.ts");
  assert.match(migration, /apply_verified_paystack_webhook_event/);
  assert.match(migration, /for update/);
  assert.match(migration, /v_event\.processing_status = 'processed'/);
  assert.match(migration, /p_amount_minor = v_intent\.amount_minor/);
  assert.match(migration, /p_currency = v_intent\.currency/);
  assert.match(migration, /grant execute[\s\S]*to service_role/);
  assert.match(webhook, /processing_status: "received"/);
  assert.match(webhook, /existing\.processing_status === "processed"/);
  assert.match(webhook, /PAYSTACK_VERIFICATION_UNAVAILABLE/);
  assert.match(webhook, /apply_verified_paystack_webhook_event/);
  assert.doesNotMatch(webhook, /vote_credit_lots|ledger_entries/);
});

test("Paystack initialization, verification and webhooks enforce explicit mode and purpose gates", async () => {
  const shared = await read("../supabase/functions/_shared/paystack.ts");
  const initialize = await read("../supabase/functions/paystack-initialize/index.ts");
  const verify = await read("../supabase/functions/paystack-verify/index.ts");
  const webhook = await read("../supabase/functions/paystack-webhook/index.ts");
  assert.match(shared, /assertOrganizationFinanceManager/);
  assert.match(shared, /\["owner", "admin", "finance_manager"\]/);
  assert.doesNotMatch(shared, /\["owner", "admin", "election_manager"\]/);
  assert.match(shared, /PAYSTACK_TEST_SECRET_KEY/);
  assert.match(shared, /PAYSTACK_LIVE_SECRET_KEY/);
  assert.match(shared, /PAYSTACK_LIVE_TRANSACTIONS_ENABLED/);
  assert.match(shared, /PAYSTACK_LIVE_SETTLEMENT_PIPELINE_ENABLED/);
  assert.match(shared, /PAYSTACK_TEST_WEBHOOK_SECRET/);
  assert.match(shared, /PAYSTACK_LIVE_WEBHOOK_SECRET/);
  assert.match(shared, /PAYSTACK_\$\{config\.mode\.toUpperCase\(\)\}_\$\{purposeKey\}_ENABLED/);
  assert.match(initialize, /paymentPurposeEnabled\(intent\.purpose\)/);
  assert.doesNotMatch(verify, /paymentPurposeEnabled\(intent\.purpose\)/);
  assert.match(verify, /intent\.purpose === "public_vote_credits"/);
  assert.doesNotMatch(webhook, /paymentPurposeEnabled\(intent\.purpose\)/);
  assert.match(verify, /PAYMENT_STATE_TERMINAL/);
  assert.doesNotMatch(webhook, /PUBLIC_VOTE_CREDIT_FULFILLMENT_NOT_READY/);
  assert.match(webhook, /database fulfillment trigger issue public credits atomically/);
  assert.match(initialize, /if \(!paymentsModeEnabled\(\)\)/);
  assert.match(verify, /if \(!paymentsModeEnabled\(\)\)/);
  assert.match(webhook, /if \(!paymentsModeEnabled\(\)\)/);
});




test("ledger posting is balanced, append-only and idempotent", async () => {
  const migration = await read("../supabase/migrations/20261127120000_0034_idempotent_ledger_posting.sql");
  const baseline = await read("../supabase/migrations/20261126090353_0007_audit_and_outbox.sql");
  const smoke = await read("../supabase/tests/ledger_posting_smoke.sql");
  assert.match(migration, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(migration, /on conflict \(idempotency_key\) do nothing/);
  assert.match(migration, /LEDGER_IDEMPOTENCY_CONFLICT/);
  assert.match(migration, /LEDGER_TRANSACTION_UNBALANCED/);
  assert.match(migration, /ledger_entries_pending_insert_guard/);
  assert.match(baseline, /create trigger ledger_entries_append_only/);
  assert.match(baseline, /ledger_transactions_posted_immutable/);
  assert.match(migration, /grant execute[\s\S]*to service_role/);
  assert.match(smoke, /LEDGER_DUPLICATE_NOT_IDEMPOTENT/);
  assert.match(smoke, /LEDGER_IDEMPOTENCY_CONFLICT_MUST_FAIL/);
  assert.match(smoke, /UNBALANCED_LEDGER_POST_MUST_FAIL/);
  assert.match(smoke, /POSTED_LEDGER_ENTRY_MUTATION_MUST_FAIL/);
  assert.match(smoke, /POSTED_LEDGER_TRANSACTION_MUST_REJECT_NEW_ENTRIES/);
});

test("concurrency fixtures record authority confirmation before opening", async () => {
  const concurrency = await read("../scripts/concurrency.acceptance.mjs");
  assert.match(concurrency, /public[.]confirm_election_setup/);
  assert.match(concurrency, /public[.]open_election/);
});


test("manual Paystack verification cannot overwrite terminal payment states or race a webhook", async () => {
  const verify = await read("../supabase/functions/paystack-verify/index.ts");
  assert.match(verify, /Terminal states are immutable/);
  assert.match(verify, /if \(intent\.status === "success"\)/);
  assert.match(verify, /PAYMENT_STATE_TERMINAL/);
  assert.match(verify, /\.in\("status", \["initialized", "pending"\]\)/);
  assert.match(verify, /\.select\("id"\)\s*\.maybeSingle\(\)/);
  assert.match(verify, /PAYMENT_STATE_CHANGED/);
  assert.match(verify, /current\.status === "success" && isSuccess/);
});


test("Paystack webhook processing cannot resurrect refunded or reversed payment intents", async () => {
  const migration = await read("../supabase/migrations/20261127130000_0035_paystack_terminal_state_guard.sql");
  const smoke = await read("../supabase/tests/payment_terminal_state_smoke.sql");
  assert.match(migration, /v_intent\.status not in \('initialized', 'pending'\)/);
  assert.match(migration, /PAYMENT_INTENT_TERMINAL/);
  assert.match(migration, /processing_status = 'processed'/);
  assert.match(smoke, /'refunded'/);
  assert.match(smoke, /REFUNDED_PAYMENT_MUST_NOT_BE_RESURRECTED/);
  assert.match(smoke, /set local role service_role/);
  assert.match(smoke, /rollback;/);
});


test("Paystack initialization is one-shot, idempotent and fails closed on uncertain outcomes", async () => {
  const migration = await read("../supabase/migrations/20261127140000_0036_paystack_initialization_claims.sql");
  const initialize = await read("../supabase/functions/paystack-initialize/index.ts");
  const smoke = await read("../supabase/tests/payment_initialization_claim_smoke.sql");
  assert.match(migration, /payment_initialization_attempts/);
  assert.match(migration, /payment_intent_id uuid not null unique/);
  assert.match(migration, /'initializing', 'unknown', 'initialized'/);
  assert.match(migration, /revoke all[\s\S]*from public, anon, authenticated/);
  assert.match(initialize, /payment_initialization_attempts/);
  assert.match(initialize, /PAYMENT_INITIALIZATION_OUTCOME_UNKNOWN/);
  assert.match(initialize, /Reconcile it before retrying/);
  assert.match(initialize, /duplicate: true/);
  assert.match(initialize, /result\.data\.reference !== intent\.provider_reference/);
  assert.match(smoke, /DUPLICATE_INITIALIZATION_CLAIM_MUST_FAIL/);
  assert.match(smoke, /INITIALIZATION_ATTEMPTS_MUST_BE_PRIVATE/);
  assert.match(smoke, /rollback;/);
});


test("verified Paystack success atomically posts an unallocated balanced suspense receipt", async () => {
  const migration = await read("../supabase/migrations/20261127150000_0037_verified_payment_receipt_suspense.sql");
  const smoke = await read("../supabase/tests/verified_payment_receipt_suspense_smoke.sql");
  assert.match(migration, /payment_intents_capture_verified_receipt/);
  assert.match(migration, /old\.status is distinct from new\.status/);
  assert.match(migration, /provider_clearing/);
  assert.match(migration, /unallocated-payment-receipts/);
  assert.match(migration, /payment_receipt_pending_allocation/);
  assert.match(migration, /mandate_private\.post_ledger_transaction/);
  assert.match(migration, /grant select, update on public\.payment_intents to service_role/);
  assert.match(migration, /grant select, insert, update on public\.payment_events to service_role/);
  assert.match(migration, /does not classify revenue/i);
  assert.match(smoke, /PAYMENT_EDGE_SERVICE_ROLE_GRANTS_MISSING/);
  assert.match(smoke, /PAYMENT_TABLES_MUST_REMAIN_PRIVATE_TO_BROWSER_ROLES/);
  assert.ok(smoke.includes("$;"));
  assert.match(smoke, /VERIFIED_RECEIPT_LEDGER_MUST_BE_BALANCED/);
  assert.match(smoke, /VERIFIED_RECEIPT_LEDGER_POSTING_MUST_BE_IDEMPOTENT/);
  assert.match(smoke, /rollback;/);
});


test("Paystack refund and dispute webhooks freeze payments for explicit reconciliation", async () => {
  const migration = await read("../supabase/migrations/20261127160000_0038_paystack_refund_dispute_exceptions.sql");
  const verifiedMigration = await read("../supabase/migrations/20261127170000_0039_verified_provider_amount_capture.sql");
  const smoke = await read("../supabase/tests/paystack_refund_dispute_exception_smoke.sql");
  const webhook = await read("../supabase/functions/paystack-webhook/index.ts");
  assert.match(migration, /apply_paystack_payment_exception_event/);
  assert.match(migration, /charge\.dispute\./);
  assert.match(migration, /set status = 'exception'/);
  assert.match(migration, /does not infer final refund settlement/i);
  assert.match(smoke, /REFUND_EVENT_MUST_FREEZE_PAYMENT/);
  assert.match(smoke, /REFUND_EVENT_FIRST_MUST_CAPTURE_ORIGINAL_RECEIPT_ONCE/);
  assert.match(webhook, /eventType\.startsWith\("refund\."\)/);
  assert.match(webhook, /eventType\.startsWith\("charge\.dispute\."\)/);
  assert.match(webhook, /apply_verified_paystack_payment_exception_event/);
  assert.match(webhook, /PAYSTACK_EXCEPTION_VERIFICATION_UNAVAILABLE/);
  assert.match(verifiedMigration, /apply_verified_paystack_payment_exception_event/);
  assert.match(verifiedMigration, /reversal pending/);
  assert.match(webhook, /verified\.data\.reference !== reference/);
  assert.match(webhook, /PAYSTACK_REFERENCE_MISMATCH/);
  assert.match(webhook, /reconciliationRequired: true/);
  assert.match(smoke, /rollback;/);
});


test("verified provider amounts are captured even when they mismatch the intent", async () => {
  const migration = await read("../supabase/migrations/20261127170000_0039_verified_provider_amount_capture.sql");
  const smoke = await read("../supabase/tests/verified_provider_amount_mismatch_smoke.sql");
  const verify = await read("../supabase/functions/paystack-verify/index.ts");
  assert.match(migration, /provider_amount_minor bigint/);
  assert.match(migration, /provider_currency text/);
  assert.match(migration, /new\.provider_status in \('success', 'reversal pending', 'reversed'\)/);
  assert.match(migration, /new\.provider_amount_minor/);
  assert.match(migration, /payment_receipt_pending_allocation/);
  assert.match(smoke, /MISMATCHED_PROVIDER_SUCCESS_MUST_CAPTURE_ACTUAL_AMOUNT_ONCE/);
  assert.match(smoke, /7900/);
  assert.match(verify, /provider_amount_minor: providerAmountMinor/);
  assert.match(verify, /provider_status: payment\.status/);
  assert.match(smoke, /rollback;/);
});


test("public participant verification uses email OTP and keeps identity out of ballots", async () => {
  const migration = await read("../supabase/migrations/20261127180000_0040_public_participant_email_identity.sql");
  const smoke = await read("../supabase/tests/public_participant_email_identity_smoke.sql");
  const details = await read("../supabase/functions/public-election-details/index.ts");
  const session = await read("../supabase/functions/public-participant-session/index.ts");
  const actions = await read("../app/actions/public-vote.ts");
  const page = await read("../app/public-vote/[slug]/page.tsx");
  const form = await read("../app/public-vote/[slug]/participant-verification-form.tsx");
  const config = await read("../supabase/config.toml");
  assert.match(migration, /auth_user_id uuid references auth\.users/);
  assert.match(migration, /unique \(election_id, auth_user_id\)/);
  assert.match(smoke, /BALLOT_MUST_NOT_CONTAIN_PARTICIPANT_OR_CONTACT_IDENTITY/);
  assert.match(details, /\.eq\("voting_mode", "public_paid"\)/);
  assert.match(session, /user\.email_confirmed_at/);
  assert.match(session, /checkoutEnabled/);
  assert.match(session, /platform_payment_feature_flags/);
  assert.match(session, /verification_status: "verified"/);
  assert.match(form, /New voting-credit purchases are temporarily paused/);
  assert.match(session, /\.eq\("auth_user_id", user\.id\)/);
  assert.match(actions, /signInWithOtp/);
  assert.match(actions, /shouldCreateUser: true/);
  assert.match(actions, /verifyOtp/);
  assert.match(form, /Six-digit email code/);
  assert.match(page, /ParticipantVerificationForm/);
  assert.match(config, /\[functions\.public-election-details\]\nverify_jwt = false/);
  assert.match(config, /\[functions\.public-participant-session\]\nverify_jwt = true/);
});


test("public vote credits reserve quantities, fulfill only verified payments and cast anonymous ballots", async () => {
  const reservations = await read("../supabase/migrations/20261127190000_0041_public_vote_credit_reservations_and_fulfillment.sql");
  const ballot = await read("../supabase/migrations/20261127200000_0042_public_paid_ballot_casting.sql");
  const smoke = await read("../supabase/tests/public_vote_credit_lifecycle_smoke.sql");
  const intent = await read("../supabase/functions/public-vote-credit-intent/index.ts");
  const initialize = await read("../supabase/functions/paystack-initialize/index.ts");
  const verify = await read("../supabase/functions/paystack-verify/index.ts");
  const actions = await read("../app/actions/public-vote.ts");
  const form = await read("../app/public-vote/[slug]/participant-verification-form.tsx");
  assert.match(reservations, /create_public_vote_credit_payment_intent/);
  assert.match(reservations, /PARTICIPANT_CREDIT_CAP_EXCEEDED/);
  assert.match(reservations, /status in \('reserved','exception'\)/);
  assert.match(reservations, /provider_amount_minor is distinct from new.amount_minor/);
  assert.match(reservations, /insert into public.vote_credit_lots/);
  assert.match(reservations, /entitlement_status = 'suspended'/);
  assert.match(ballot, /cast_public_paid_ballot/);
  assert.match(ballot, /submission_key_hash/);
  assert.match(ballot, /INSUFFICIENT_VOTE_CREDITS/);
  assert.match(ballot, /vote_credit_consumptions/);
  assert.match(intent, /paymentPurposeEnabled\("public_vote_credits"\)/);
  assert.match(intent, /Idempotency-Key/);
  assert.match(initialize, /VERIFIED_PARTICIPANT_REQUIRED/);
  assert.match(verify, /VERIFIED_PARTICIPANT_REQUIRED/);
  assert.match(actions, /public-vote-credit-intent/);
  assert.match(actions, /paystack-initialize/);
  assert.match(form, /Continue to Paystack/);
  assert.match(smoke, /ACTIVE_CREDIT_RESERVATIONS_MUST_ENFORCE_PARTICIPANT_CAP/);
  assert.match(smoke, /PUBLIC_PAID_BALLOT_RETRY_MUST_RETURN_SAME_RECEIPT/);
  assert.match(smoke, /PUBLIC_PAID_BALLOT_MUST_CONSUME_CREDITS_ONCE_AND_KEEP_BALLOT_ANONYMOUS/);
});


test("public paid elections require platform release and freeze pricing before opening", async () => {
  const release = await read("../supabase/migrations/20261127210000_0043_paid_voting_release_gate.sql");
  const releaseSmoke = await read("../supabase/tests/paid_voting_release_gate_smoke.sql");
  const lifecycle = await read("../supabase/tests/public_vote_credit_lifecycle_smoke.sql");
  const setupForm = await read("../app/organizations/[organizationId]/create-election-form.tsx");
  const electionPage = await read("../app/organizations/[organizationId]/elections/[electionId]/page.tsx");
  const lifecycleControls = await read("../app/organizations/[organizationId]/elections/[electionId]/lifecycle-controls.tsx");
  assert.match(release, /public_vote_credits_enabled boolean not null default false/);
  assert.match(release, /PAID_VOTING_AUTHORIZATION_REQUIRED/);
  assert.match(release, /pricePerCreditMinor/);
  assert.match(release, /maxCreditsPerParticipant/);
  assert.match(release, /new\.price_per_credit_minor is distinct from old\.price_per_credit_minor/);
  assert.match(release, /new\.public_slug is distinct from old\.public_slug/);
  assert.match(release, /public_paid/);
  assert.match(release, /verified_participants/);
  assert.doesNotMatch(release, /create trigger ballots_public_paid_feature_guard/);
  assert.match(lifecycle, /set public_vote_credits_enabled=false/);
  assert.match(releaseSmoke, /PUBLIC_VOTE_CREDITS_MUST_DEFAULT_DISABLED/);
  assert.match(lifecycle, /public-credit-acceptance/);
  assert.match(setupForm, /public_paid/);
  assert.match(setupForm, /price_per_credit_minor/);
  assert.match(setupForm, /max_credits_per_participant/);
  assert.match(setupForm, /Number\.isSafeInteger\(amountMinor\)/);
  assert.match(setupForm, /Number\(election\.price_per_credit_minor\) \/ 100/);
  assert.match(electionPage, /PLATFORM AUTHORIZATION PENDING/);
  assert.match(lifecycleControls, /public price, participant cap/);
});

test("public paid voting uses Mandate single-merchant collection and readable audit details", async () => {
  const migration = await read("../supabase/migrations/20261128010000_0049_single_merchant_public_vote_payments.sql");
  const initialize = await read("../supabase/functions/paystack-initialize/index.ts");
  const verify = await read("../supabase/functions/paystack-verify/index.ts");
  const webhook = await read("../supabase/functions/paystack-webhook/index.ts");
  const audit = await read("../app/organizations/[organizationId]/elections/[electionId]/audit-timeline.tsx");
  const lifecycle = await read("../app/organizations/[organizationId]/elections/[electionId]/lifecycle-controls.tsx");
  assert.match(migration, /apply_verified_paystack_public_vote_payment/);
  assert.match(migration, /split_status <> 'not_configured'/);
  assert.match(migration, /provider_fee_minor/);
  assert.match(migration, /platform_revenue/);
  assert.match(migration, /processor_fee/);
  assert.match(migration, /public_vote_provider_processing_fee/);
  assert.match(migration, /payment_intents_require_verified_public_vote_split/);
  assert.match(initialize, /public_vote_credits_enabled/);
  assert.doesNotMatch(initialize, /PAYSTACK_SPLIT_NOT_CONFIGURED|VERIFIED_ORGANIZER_SUBACCOUNT_REQUIRED|splitInitialization/);
  assert.match(verify, /apply_verified_paystack_public_vote_payment/);
  assert.doesNotMatch(verify, /apply_verified_paystack_public_vote_split|fees_split/);
  assert.match(webhook, /apply_verified_paystack_public_vote_payment/);
  assert.doesNotMatch(webhook, /apply_verified_paystack_public_vote_split|fees_split/);
  assert.match(audit, /formatMetadataValue/);
  assert.match(audit, /audit-metadata-row/);
  assert.doesNotMatch(audit, /JSON\.stringify/);
  assert.match(lifecycle, /public participant access and credit limits/);
  assert.match(lifecycle, /Mandate merchant authorization/);
});

test("Paystack settlement importer is service-role-only and safely paginated", async () => {
  const importer = await read("../supabase/functions/paystack-settlement-import/index.ts");
  const config = await read("../supabase/config.toml");
  const migration = await read("../supabase/migrations/20261127220000_0044_paystack_settlement_reconciliation.sql");
  const smoke = await read("../supabase/tests/paystack_settlement_reconciliation_smoke.sql");
  assert.match(importer, /SERVICE_ROLE_REQUIRED/);
  assert.match(importer, /PAYSTACK_MODE/);
  assert.match(importer, /settlementModeEnabled\(\)/);
  assert.match(importer, /PAYSTACK_SETTLEMENT_PIPELINE_DISABLED/);
  assert.match(await read("../supabase/functions/_shared/paystack.ts"), /config\.mode === "test" \|\| config\.settlementReady/);
  assert.match(importer, /MAX_SETTLEMENT_PAGES/);
  assert.match(importer, /response\.status !== true/);
  assert.match(importer, /transactionResponse\.status !== true/);
  assert.match(importer, /nextTransactionPage/);
  assert.match(importer, /onConflict: "environment,provider_transaction_id"/);
  assert.match(importer, /31 \* 24 \* 60 \* 60 \* 1000/);
  assert.doesNotMatch(importer, /customer\.email|customer\.phone|metadata/);
  assert.match(config, /\[functions\.paystack-settlement-import\]\nverify_jwt = true/);
  assert.match(migration, /security_invoker = true/);
  assert.match(migration, /matched_to_receipt/);
  assert.match(smoke, /PAYSTACK_SETTLEMENT_RECEIPT_MATCH_FAILED/);
  assert.match(smoke, /PAYSTACK_SETTLEMENT_RECONCILIATION_MUST_REMAIN_SERVER_ONLY/);
});



test("Paystack payment exceptions are exposed through a private read-only evidence queue", async () => {
  const migration = await read("../supabase/migrations/20261127230000_0045_paystack_payment_exception_queue.sql");
  const smoke = await read("../supabase/tests/paystack_payment_exception_queue_smoke.sql");
  assert.match(migration, /create or replace view public\.paystack_payment_exception_queue/);
  assert.match(migration, /refund\./);
  assert.match(migration, /charge\.dispute\./);
  assert.match(migration, /settlement_reconciliation_statuses/);
  assert.match(migration, /receipt_posted/);
  assert.match(migration, /security_invoker = true/);
  assert.match(migration, /no automatic refund|no automatic reversals|Does not automatically reverse/i);
  assert.match(smoke, /PAYSTACK_EXCEPTION_QUEUE_EVIDENCE_MISSING/);
  assert.match(smoke, /PAYSTACK_EXCEPTION_QUEUE_MUST_REMAIN_SERVER_ONLY/);
  assert.match(smoke, /rollback;/);
});


test("registered elections use a versioned server-priced platform fee before invitations and opening", async () => {
  const migration = await read("../supabase/migrations/20261127240000_0046_platform_fee_pricing_policy.sql");
  const smoke = await read("../supabase/tests/platform_fee_pricing_smoke.sql");
  const action = await read("../app/actions/payments.ts");
  const component = await read("../app/organizations/[organizationId]/elections/[electionId]/platform-fee-checkout.tsx");
  const page = await read("../app/organizations/[organizationId]/elections/[electionId]/page.tsx");
  const invitations = await read("../supabase/functions/send-voter-invitations/index.ts");
  const verify = await read("../supabase/functions/paystack-verify/index.ts");
  const callback = await read("../app/payments/paystack/callback/route.ts");
  const docs = await read("../docs/payments/paystack-integration.md");

  assert.match(migration, /amount_per_eligible_voter_minor bigint/);
  assert.match(migration, /minimum_fee_minor bigint/);
  assert.match(migration, /values \(1,'KES',2000,50000,true\)/);
  assert.match(migration, /get_platform_fee_quote/);
  assert.match(migration, /create_platform_fee_payment_intent/);
  assert.match(migration, /PLATFORM_FEE_QUOTE_CHANGED/);
  assert.match(migration, /VOTER_REGISTER_FROZEN_BY_PLATFORM_FEE_QUOTE/);
  assert.match(migration, /PLATFORM_FEE_FIELDS_SERVER_MANAGED/);
  assert.match(migration, /PLATFORM_FEE_PAYMENT_REQUIRED/);
  assert.match(migration, /sync_platform_fee_payment_status/);
  assert.match(smoke, /PLATFORM_FEE_SERVER_PRICING_OR_IDEMPOTENCY_FAILED/);
  assert.match(smoke, /CLIENT_MUST_NOT_WRITE_PLATFORM_FEE_STATUS/);
  assert.match(smoke, /VOTER_REGISTER_MUST_FREEZE_AFTER_FEE_QUOTE/);
  assert.match(smoke, /ELECTION_OPEN_MUST_REQUIRE_PAID_PLATFORM_FEE/);
  assert.match(smoke, /VERIFIED_PLATFORM_FEE_PAYMENT_MUST_MARK_ELECTION_PAID/);
  assert.match(action, /create_platform_fee_payment_intent/);
  assert.match(action, /paystack-initialize/);
  assert.match(action, /validatePaystackAuthorizationUrl/);
  assert.match(component, /KSh 20 per voter · KSh 500 minimum/);
  assert.match(component, /Continue to secure payment/);
  assert.match(page, /get_platform_fee_quote/);
  assert.match(page, /PlatformFeeCheckout/);
  assert.match(invitations, /PLATFORM_FEE_PAYMENT_REQUIRED/);
  assert.match(verify, /intent\.purpose === "platform_fee"/);
  assert.match(callback, /safeReturnPath/);
  assert.match(docs, /KES 2,000 per eligible voter and KES 50,000 minimum/);
});


test("manual voter entry reuses private staging, server validation and the existing review/commit workflow", async () => {
  const actions = await read("../app/actions/voters.ts");
  const form = await read("../app/organizations/[organizationId]/elections/[electionId]/manual-voter-form.tsx");
  const page = await read("../app/organizations/[organizationId]/elections/[electionId]/page.tsx");
  assert.match(actions, /stageManualVoterAction/);
  assert.match(actions, /createSupabaseServerClient/);
  assert.match(actions, /mandate-voter-imports/);
  assert.match(actions, /stage_voter_import/);
  assert.match(actions, /p_original_filename: "manual-voter-entry\.csv"/);
  assert.match(actions, /commit_voter_import/);
  assert.match(actions, /registered_single/);
  assert.match(actions, /weight !== 1/);
  assert.match(form, /Add one voter manually/);
  assert.match(form, /at least one contact address/);
  assert.match(form, /Validate manual entry/);
  assert.match(page, /ManualVoterForm/);
  assert.match(page, /CommitImportForm/);
});


test("unconfirmed accounts receive explicit sign-in guidance and can request a safe resend", async () => {
  const actions = await read("../app/actions/auth.ts");
  const form = await read("../app/login/login-form.tsx");
  assert.match(actions, /email_not_confirmed/);
  assert.match(actions, /needsConfirmation: true/);
  assert.match(actions, /resendConfirmationAction/);
  assert.match(actions, /type: "signup"/);
  assert.match(actions, /If this address is eligible for confirmation/);
  assert.match(actions, /safeInternalPath/);
  assert.match(form, /waiting for email confirmation/);
  assert.match(form, /Resend confirmation email/);
  assert.match(form, /state\.needsConfirmation/);
  assert.match(form, /role="status"/);
});


test("election lifecycle actions explain successful transitions and the next step", async () => {
  const actions = await read("../app/actions/lifecycle.ts");
  const controls = await read("../app/organizations/[organizationId]/elections/[electionId]/lifecycle-controls.tsx");
  assert.match(actions, /eligible voters can now vote until the scheduled close/);
  assert.match(actions, /authorized manager resumes voting/);
  assert.match(actions, /active again until the scheduled close/);
  assert.match(actions, /next step is to run tally reconciliation/);
  assert.match(controls, /openState\.message/);
  assert.match(controls, /pauseState\.message/);
  assert.match(controls, /resumeState\.message/);
  assert.match(controls, /closeState\.message/);
  assert.match(controls, /lifecycleStatusLabels/);
  assert.match(controls, /role="status"/);
});


test("organization member actions confirm revocations and explain successful access changes", async () => {
  const actions = await read("../app/actions/organization-members.ts");
  const page = await read("../app/organizations/[organizationId]/page.tsx");
  const panel = await read("../app/organizations/[organizationId]/members-panel.tsx");
  assert.match(actions, /confirmRevokeMember/);
  assert.match(actions, /confirmRevokeInvitation/);
  assert.match(actions, /memberNotice=role-updated/);
  assert.match(actions, /memberNotice=member-revoked/);
  assert.match(actions, /memberNotice=invitation-revoked/);
  assert.match(actions, /role-update-failed/);
  assert.match(page, /memberNotice\?:/);
  assert.match(page, /memberError\?:/);
  assert.match(panel, /Confirm revoke access/);
  assert.match(panel, /Confirm revoke invitation/);
  assert.match(panel, /Their new permissions are now active/);
  assert.match(panel, /can no longer access this organization/);
  assert.match(panel, /role="status"/);
});


test("closing elections, publishing results and sending voter invitations require explicit confirmation", async () => {
  const lifecycle = await read("../app/actions/lifecycle.ts");
  const lifecycleForm = await read("../app/organizations/[organizationId]/elections/[electionId]/lifecycle-controls.tsx");
  const invitations = await read("../app/actions/invitations.ts");
  const invitationForm = await read("../app/organizations/[organizationId]/elections/[electionId]/dispatch-invitations-form.tsx");
  assert.match(lifecycle, /confirmClose/);
  assert.match(lifecycle, /confirmPublish/);
  assert.match(lifecycleForm, /name="confirmClose"/);
  assert.match(lifecycleForm, /name="confirmPublish"/);
  assert.match(invitations, /confirmInvitations/);
  assert.match(invitationForm, /name="confirmInvitations"/);
});


test("registered-election fees and public vote credits share the same Paystack checkout and callback pipeline", async () => {
  const platformFee = await read("../app/actions/payments.ts");
  const publicVote = await read("../app/actions/public-vote.ts");
  const callback = await read("../app/payments/paystack/callback/route.ts");
  const initialize = await read("../supabase/functions/paystack-initialize/index.ts");
  const verify = await read("../supabase/functions/paystack-verify/index.ts");
  assert.match(platformFee, /functions\.invoke\("paystack-initialize"/);
  assert.match(publicVote, /functions\.invoke\("paystack-initialize"/);
  assert.match(platformFee, /authorizationUrl/);
  assert.match(publicVote, /authorizationUrl/);
  assert.match(callback, /functions\.invoke\("paystack-verify"/);
  assert.match(initialize, /public_vote_credits/);
  assert.match(verify, /intent\.purpose === "platform_fee"/);
  assert.match(verify, /intent\.purpose === "public_vote_credits"/);
  assert.match(verify, /apply_verified_paystack_public_vote_payment/);
});


test("all Paystack checkout purposes share trusted hosted-redirect validation", async () => {
  const { validatePaystackAuthorizationUrl } = await import("../lib/payments/paystack.ts");
  const platformFee = await read("../app/actions/payments.ts");
  const publicVote = await read("../app/actions/public-vote.ts");
  assert.equal(validatePaystackAuthorizationUrl("https://checkout.paystack.com/example"), "https://checkout.paystack.com/example");
  assert.equal(validatePaystackAuthorizationUrl("http://checkout.paystack.com/example"), null);
  assert.equal(validatePaystackAuthorizationUrl("https://paystack.com.example.org/fake"), null);
  assert.equal(validatePaystackAuthorizationUrl("javascript:alert(1)"), null);
  assert.equal(validatePaystackAuthorizationUrl(null), null);
  assert.match(platformFee, /validatePaystackAuthorizationUrl/);
  assert.match(publicVote, /validatePaystackAuthorizationUrl/);
});
