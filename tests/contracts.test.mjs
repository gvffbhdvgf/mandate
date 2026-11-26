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
