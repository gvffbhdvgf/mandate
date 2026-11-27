import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("published result exports are role-gated, aggregate-only, formula-safe and audited", async () => {
  const route = await read("../app/organizations/[organizationId]/elections/[electionId]/report/route.ts");
  const electionPage = await read("../app/organizations/[organizationId]/elections/[electionId]/page.tsx");
  const migration = await read("../supabase/migrations/20261127090000_0032_results_reports_and_rpc_boundary.sql");
  const lifecycle = await read("../supabase/tests/registered_election_lifecycle_acceptance.sql");
  assert.match(route, /exportRoles = \["owner", "admin", "returning_officer"\]/);
  assert.match(route, /get_published_results/);
  assert.match(route, /record_results_export/);
  assert.match(route, /csvCell/);
  assert.match(route, /pdfReport/);
  assert.match(route, /%PDF-1\.4/);
  assert.match(route, /Cache-Control.*private, no-store/);
  assert.match(electionPage, /report\?format=csv/);
  assert.match(electionPage, /report\?format=pdf/);
  assert.match(migration, /election\.results\.exported/);
  assert.match(migration, /election\.setup_confirmed/);
  assert.match(migration, /p_format not in \('csv','pdf'\)/);
  assert.match(lifecycle, /public\.record_results_export/);
  assert.match(lifecycle, /election\.results\.exported/);
  assert.doesNotMatch(route, /voter_id|participant_id|email|phone|access_token|payment_id/i);
});
