import test from "node:test";
import assert from "node:assert/strict";

const { formatStatusLabel, formatVotingMode, formatAuditAction, formatAuditMetadata } = await import("../lib/ui/presentation.ts");

test("status labels use plain language for election lifecycle states", () => {
  assert.equal(formatStatusLabel("draft"), "Draft");
  assert.equal(formatStatusLabel("tallying"), "Reconciliation in progress");
  assert.equal(formatStatusLabel("results_published"), "Published results");
  assert.equal(formatStatusLabel("some_new_state"), "Some new state");
});

test("voting modes are expressed in language voters and administrators understand", () => {
  assert.equal(formatVotingMode("registered_single"), "One person, one vote");
  assert.equal(formatVotingMode("registered_weighted"), "Weighted voting");
  assert.equal(formatVotingMode("public_paid"), "Public paid voting");
});

test("audit actions are translated into concise human-readable events", () => {
  assert.equal(formatAuditAction("election.setup_confirmed"), "Election setup confirmed");
  assert.equal(formatAuditAction("voter_import.staged"), "Voter import validated");
  assert.equal(formatAuditAction("voter_invitation.batch_dispatched"), "Voter invitation batch processed");
});

test("audit metadata exposes only safe, readable scalar details", () => {
  const details = formatAuditMetadata({
    configurationHash: "18d1e148abcdef0123456789",
    votingMode: "registered_single",
    totalRows: 12,
    importedRows: 9,
    requiresResolution: true,
    privateObjectPath: "org/election/private.csv",
    reason: "private internal note",
    nested: { secret: "never render" },
  });
  assert.deepEqual(details, [
    { label: "Verification reference", value: "18d1e148…" },
    { label: "Voting method", value: "One person, one vote" },
    { label: "Rows checked", value: "12" },
    { label: "Voters added", value: "9" },
    { label: "Tie needs resolution", value: "Yes" },
  ]);
});

test("audit metadata safely handles empty and malformed values", () => {
  assert.deepEqual(formatAuditMetadata({ startsAt: null, timezone: {}, endsAt: "not-a-date" }), []);
  assert.deepEqual(formatAuditMetadata(null), []);
});

test("result visibility, tie policy and organization roles use plain language", async () => {
  const { formatDateTime, formatResultVisibility, formatTiePolicy, formatRoleLabel } = await import("../lib/ui/presentation.ts");
  assert.equal(formatResultVisibility("private"), "Election administrators only");
  assert.equal(formatResultVisibility("members"), "Organization members");
  assert.equal(formatResultVisibility("public"), "Public aggregate results");
  assert.equal(formatTiePolicy("declared_tie"), "Declare a tie");
  assert.equal(formatTiePolicy("external_resolution"), "External resolution");
  assert.equal(formatRoleLabel("election_manager"), "Election manager");
  assert.match(formatDateTime("2026-11-27T08:00:00.000Z", "Not/A_Timezone"), /2026/);
  assert.equal(formatDateTime("not-a-date"), "Not set");
  assert.match(formatDateTime(0, "UTC"), /1970/);
});

test("Civic Forest UI foundation includes responsive and accessible interaction defaults", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(css, /--forest:\s*#1F3D32/i);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /max-width:\s*720px/);
  assert.match(css, /max-width:\s*480px/);
  assert.match(layout, /Skip to main content/);
});
