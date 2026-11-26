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
  assert.match(migration, /invitation_attempted_at/);
  assert.match(functionSource, /pendingClaimFilter/);
  assert.match(functionSource, /15 \* 60 \* 1000/);
  assert.match(functionSource, /access_token_hash: tokenHash/);
  assert.match(functionSource, /sha256Hex/);
  assert.match(functionSource, /verify_jwt/);
  assert.doesNotMatch(functionSource, /return json\(200,\s*\{[^}]*token\s*:/i);
});
