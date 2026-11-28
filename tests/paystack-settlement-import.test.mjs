import test from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  validateOptions,
  getSupabaseConfig,
  runImport,
} from "../scripts/paystack-settlement-import.mjs";

const validArguments = [
  "--settlement-id", "123456",
  "--from", "2026-11-01T00:00:00Z",
  "--to", "2026-11-02T00:00:00Z",
  "--environment", "test",
  "--confirm-import",
];

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("settlement CLI parses explicit environment and confirmation flags", () => {
  const options = parseArgs(validArguments);
  assert.equal(options.settlementId, "123456");
  assert.equal(options.environment, "test");
  assert.equal(options.confirmImport, true);
  assert.equal(options.allowLive, undefined);
  assert.equal(validateOptions(options), options);
});

test("settlement CLI rejects missing confirmation and unapproved live mode", () => {
  const noConfirmation = parseArgs(validArguments.filter((value) => value !== "--confirm-import"));
  assert.throws(() => validateOptions(noConfirmation), /--confirm-import/);

  const live = parseArgs([
    "--settlement-id", "123456",
    "--from", "2026-11-01T00:00:00Z",
    "--to", "2026-11-02T00:00:00Z",
    "--environment", "live",
    "--confirm-import",
  ]);
  assert.throws(() => validateOptions(live), /--allow-live/);
});

test("settlement CLI rejects invalid IDs, timestamps and ranges", () => {
  const options = parseArgs(validArguments);
  assert.throws(() => validateOptions({ ...options, settlementId: "123x" }), /Settlement ID/);
  assert.throws(() => validateOptions({ ...options, from: "2026-11-01" }), /ISO UTC timestamp/);
  assert.throws(() => validateOptions({ ...options, to: "2026-12-10T00:00:00Z" }), /no longer than 31 days/);
});

test("settlement CLI restricts service-role credentials to the Mandate Supabase project", () => {
  assert.deepEqual(
    getSupabaseConfig({
      SUPABASE_URL: "https://yhdosrhtzcsfqfuuqhsk.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "local-test-secret",
    }),
    {
      baseUrl: "https://yhdosrhtzcsfqfuuqhsk.supabase.co",
      serviceRoleKey: "local-test-secret",
    },
  );
  assert.throws(() => getSupabaseConfig({
    SUPABASE_URL: "https://attacker.example",
    SUPABASE_SERVICE_ROLE_KEY: "local-test-secret",
  }), /Mandate production Supabase project URL/);
});

test("environment mismatch stops after read-only preflight without importing data", async () => {
  const options = validateOptions(parseArgs(validArguments));
  let calls = 0;
  await assert.rejects(
    runImport({
      options,
      environment: {
        SUPABASE_URL: "https://yhdosrhtzcsfqfuuqhsk.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "do-not-log-this",
      },
      fetchImpl: async () => {
        calls += 1;
        return response({ ready: true, environment: "live", settlementId: "123456" });
      },
      output: () => {},
    }),
    /Environment mismatch/,
  );
  assert.equal(calls, 1);
});

test("settlement CLI imports every provider page idempotently and never prints credentials", async () => {
  const options = validateOptions(parseArgs(validArguments));
  const secret = "service-role-secret-that-must-not-be-logged";
  const calls = [];
  const output = [];
  const responses = [
    { ready: true, environment: "test", settlementId: "123456" },
    {
      imported: true, environment: "test", settlementId: "123456", settlementStatus: "success",
      importedTransactions: 100, transactionPage: 1, transactionPageCount: 2,
      nextTransactionPage: 2, complete: false,
    },
    {
      imported: true, environment: "test", settlementId: "123456", settlementStatus: "success",
      importedTransactions: 5, transactionPage: 2, transactionPageCount: 2,
      nextTransactionPage: null, complete: true,
    },
  ];

  const summary = await runImport({
    options,
    environment: {
      SUPABASE_URL: "https://yhdosrhtzcsfqfuuqhsk.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: secret,
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return response(responses.shift());
    },
    output: (line) => output.push(line),
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.preflight, true);
  assert.equal(calls[1].body.transactionPage, 1);
  assert.equal(calls[2].body.transactionPage, 2);
  assert.ok(calls.every((call) => call.url.endsWith("/functions/v1/paystack-settlement-import")));
  assert.ok(calls.every((call) => call.init.headers.Authorization === "Bearer " + secret));
  assert.deepEqual(summary, {
    environment: "test",
    settlementId: "123456",
    settlementStatus: "success",
    pageCount: 2,
    importedTransactions: 105,
  });
  assert.equal(output.some((line) => line.includes(secret)), false);
  assert.match(output.at(-1), /does not prove bank credit/);
});

test("live settlement import requires explicit live confirmation before any request", async () => {
  const options = parseArgs([
    "--settlement-id", "123456",
    "--from", "2026-11-01T00:00:00Z",
    "--to", "2026-11-02T00:00:00Z",
    "--environment", "live",
    "--confirm-import",
  ]);
  let calls = 0;
  await assert.rejects(
    runImport({
      options,
      environment: {
        SUPABASE_URL: "https://yhdosrhtzcsfqfuuqhsk.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "do-not-log-this",
      },
      fetchImpl: async () => {
        calls += 1;
        return response({ ready: true, environment: "live", settlementId: "123456" });
      },
      output: () => {},
    }),
    /--allow-live/,
  );
  assert.equal(calls, 0);
});
