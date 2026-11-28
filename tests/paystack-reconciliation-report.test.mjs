import test from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  validateOptions,
  formatReport,
  runReport,
} from "../scripts/paystack-reconciliation-report.mjs";

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("reconciliation report requires an explicit environment and live-read confirmation", () => {
  assert.throws(() => validateOptions({}), /environment must be test or live/);
  assert.throws(() => validateOptions({ environment: "live" }), /--allow-live/);
  const testOptions = parseArgs(["--environment", "test", "--settlement-id", "123456"]);
  assert.deepEqual(testOptions, { environment: "test", settlementId: "123456" });
  assert.equal(validateOptions(testOptions), testOptions);
  const liveOptions = parseArgs(["--environment", "live", "--allow-live"]);
  assert.equal(validateOptions(liveOptions).allowLive, true);
});

test("reconciliation report aggregates settlement rows and cross-environment exception evidence", () => {
  const settlementRows = [
    {
      settlement_id: "settlement-uuid",
      provider_settlement_id: "123456",
      settlement_status: "success",
      settlement_currency: "KES",
      provider_total_amount_minor: 1000,
      provider_effective_amount_minor: 900,
      provider_total_processed_minor: 1000,
      provider_total_fees_minor: 100,
      settled_transaction_amount_minor: 500,
      fee_minor: 50,
      reconciliation_status: "matched_to_receipt",
    },
    {
      settlement_id: "settlement-uuid",
      provider_settlement_id: "123456",
      settlement_status: "success",
      settlement_currency: "KES",
      provider_total_amount_minor: 1000,
      provider_effective_amount_minor: 900,
      provider_total_processed_minor: 1000,
      provider_total_fees_minor: 100,
      settled_transaction_amount_minor: 500,
      fee_minor: 50,
      reconciliation_status: "payment_intent_not_found",
    },
  ];
  const exceptionRows = [{
    payment_intent_status: "exception",
    provider_status: "success",
    receipt_posted: false,
    event_count: 2,
    event_types: ["refund.processed", "charge.dispute.created"],
    settlement_reconciliation_statuses: ["payment_intent_not_found"],
  }];
  const report = formatReport(settlementRows, exceptionRows, "test");
  assert.equal(report.environment, "test");
  assert.equal(report.settlementCount, 1);
  assert.equal(report.transactionRows, 2);
  assert.equal(report.settlements[0].matchedRows, 1);
  assert.equal(report.settlements[0].unresolvedRows, 1);
  assert.equal(report.settlements[0].importedAmountMinor, 1000);
  assert.equal(report.settlements[0].importedFeesMinor, 100);
  assert.deepEqual(report.reconciliationStatuses, [
    ["matched_to_receipt", 1],
    ["payment_intent_not_found", 1],
  ]);
  assert.equal(report.exceptionScope, "all environments");
  assert.equal(report.exceptionRecords, 1);
  assert.equal(report.exceptionEvents, 2);
  assert.equal(report.receiptsMissing, 1);
  assert.deepEqual(report.exceptionTypes, [
    ["charge.dispute.created", 1],
    ["refund.processed", 1],
  ]);
});

test("report reads only the Mandate project and labels exception scope honestly", async () => {
  const options = validateOptions(parseArgs(["--environment", "test"]));
  const secret = "service-role-secret-that-must-not-be-logged";
  const calls = [];
  const output = [];
  const settlementRows = [{
    settlement_id: "settlement-uuid",
    provider_settlement_id: "123456",
    settlement_status: "success",
    settlement_currency: "KES",
    provider_total_amount_minor: 1000,
    provider_effective_amount_minor: 900,
    provider_total_processed_minor: 1000,
    provider_total_fees_minor: 100,
    settled_transaction_amount_minor: 1000,
    fee_minor: 100,
    reconciliation_status: "matched_to_receipt",
  }];
  const exceptionRows = [{
    payment_intent_status: "exception",
    provider_status: "success",
    receipt_posted: true,
    event_count: 1,
    event_types: ["refund.processed"],
    settlement_reconciliation_statuses: ["matched_to_receipt"],
  }];

  const report = await runReport({
    options,
    environment: {
      SUPABASE_URL: "https://yhdosrhtzcsfqfuuqhsk.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: secret,
    },
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ url: parsed, init });
      return response(parsed.pathname.endsWith("/paystack_settlement_reconciliation") ? settlementRows : exceptionRows);
    },
    output: (line) => output.push(line),
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[0].url.searchParams.get("environment"), "eq.test");
  assert.equal(calls[1].url.searchParams.has("environment"), false);
  assert.ok(calls.every((call) => call.url.hostname === "yhdosrhtzcsfqfuuqhsk.supabase.co"));
  assert.ok(calls.every((call) => call.init.headers.Authorization === "Bearer " + secret));
  assert.equal(report.settlementCount, 1);
  assert.equal(report.exceptionRecords, 1);
  assert.equal(output.some((line) => line.includes(secret)), false);
  assert.ok(output.some((line) => line.includes("all environments")));
  assert.ok(output.some((line) => line.includes("Bank reconciliation: NOT VERIFIED")));
  assert.ok(output.some((line) => line.includes("No payment, refund, transfer, payout or database mutation")));
});

test("reconciliation report rejects nonnumeric settlement IDs and unexpected flags", () => {
  assert.throws(() => validateOptions(parseArgs(["--environment", "test", "--settlement-id", "12x"])), /Settlement ID/);
  assert.throws(() => parseArgs(["--environment", "test", "--unknown"]), /Unknown argument/);
});
