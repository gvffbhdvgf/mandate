import test from "node:test";
import assert from "node:assert/strict";
import { buildElectionOpeningChecks } from "../lib/ui/election-readiness.ts";

const base = {
  setupConfirmed: true,
  eligibleVoterCount: 12,
  invitedVoterCount: 12,
  activeOptionCounts: [2, 3],
  startsAt: "2026-11-27T08:00:00.000Z",
  endsAt: "2026-11-27T12:00:00.000Z",
  timezone: "Africa/Nairobi",
  now: Date.parse("2026-11-27T09:00:00.000Z"),
};

test("opening checklist is complete only when all trusted prerequisites are met", () => {
  const checks = buildElectionOpeningChecks(base);
  assert.equal(checks.length, 7);
  assert.ok(checks.every((check) => check.complete));
});

test("future start time prevents opening and explains when to refresh", () => {
  const checks = buildElectionOpeningChecks({ ...base, now: Date.parse("2026-11-27T07:00:00.000Z") });
  assert.equal(checks.find((check) => check.label === "Scheduled start time reached")?.complete, false);
  assert.match(checks.find((check) => check.label === "Scheduled start time reached")?.detail ?? "", /Refresh this page/);
});

test("expired or invalid voting windows prevent opening", () => {
  const expired = buildElectionOpeningChecks({ ...base, now: Date.parse("2026-11-27T13:00:00.000Z") });
  assert.equal(expired.find((check) => check.label === "Voting window has not expired")?.complete, false);
  assert.match(expired.find((check) => check.label === "Voting window has not expired")?.detail ?? "", /end time has passed/);
  const invalid = buildElectionOpeningChecks({ ...base, endsAt: "2026-11-27T07:00:00.000Z" });
  assert.equal(invalid.find((check) => check.label === "Voting dates scheduled")?.complete, false);
});

test("missing invitations, voters, approval or active options remain visible as blockers", () => {
  const checks = buildElectionOpeningChecks({ ...base, setupConfirmed: false, eligibleVoterCount: 0, invitedVoterCount: 0, activeOptionCounts: [1] });
  assert.equal(checks.find((check) => check.label === "Election rules approved")?.complete, false);
  assert.equal(checks.find((check) => check.label === "Eligible voter register added")?.complete, false);
  assert.equal(checks.find((check) => check.label === "Voter invitations issued")?.complete, false);
  assert.equal(checks.find((check) => check.label === "Contests and options configured")?.complete, false);
});
