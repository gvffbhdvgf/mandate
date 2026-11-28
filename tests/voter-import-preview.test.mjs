import test from "node:test";
import assert from "node:assert/strict";
import { previewVoterCsv } from "../lib/ui/voter-import-preview.ts";

test("voter CSV preview accepts valid rows and preserves quoted names", () => {
  const result = previewVoterCsv('voter_ref,name,email,phone_e164,weight\nV-1,"Voter, One",one@example.org,,1\nV-2,Voter Two,,+254712345678,1\n', "registered_single");
  assert.equal(result.totalRows, 2);
  assert.equal(result.acceptedRows, 2);
  assert.equal(result.rejectedRows, 0);
  assert.equal(result.valid, true);
  assert.equal(result.previewRows[0].name, "Voter, One");
});

test("voter CSV preview reports every invalid row with its spreadsheet row number", () => {
  const result = previewVoterCsv('voter_ref,name,email,phone_e164,weight\nV-1,,bad-email,,1\nV-1,Duplicate,dup@example.org,,1\nV-3,No contact,,,1\n', "registered_single");
  assert.equal(result.totalRows, 3);
  assert.equal(result.acceptedRows, 0);
  assert.equal(result.rejectedRows, 3);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.row === 2));
  assert.ok(result.errors.some((error) => error.row === 3 && error.message.includes("duplicate")));
  assert.ok(result.errors.some((error) => error.row === 4 && error.message.includes("contact")));
});

test("single-vote elections reject weighted rows before upload", () => {
  const csv = "voter_ref,name,email,phone_e164,weight\nV-1,One,one@example.org,,2\n";
  const result = previewVoterCsv(csv, "registered_single");
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /weight must be 1/i);
});

test("CSV preview rejects missing required columns and empty files, but explains ignored extras", () => {
  assert.match(previewVoterCsv("name,email\nA,a@example.org\n", "registered_single").errors[0].message, /required columns/i);
  const extra = previewVoterCsv("voter_ref,name,email,secret\nV-1,A,a@example.org,x\n", "registered_single");
  assert.equal(extra.valid, true);
  assert.match(extra.warnings[0], /will be ignored/i);
  assert.match(previewVoterCsv("voter_ref,name,email\n", "registered_single").errors[0].message, /no voter rows/i);
});
