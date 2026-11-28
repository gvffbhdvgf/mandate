import test from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  validateOptions,
  parseBankDate,
  parseAmountToMinorUnits,
  parseBankCsv,
  buildBankReconciliationReport,
  reportToCsv,
  runBankReconciliation,
} from "../scripts/paystack-bank-reconciliation.mjs";

const baseOptions = {
  environment: "test",
  bankCsv: "statement.csv",
  dateColumn: "Date",
  creditColumn: "Credit",
  debitColumn: "Debit",
  currencyColumn: "Currency",
  referenceColumn: "Reference",
  descriptionColumn: "Description",
  dateWindowDays: 5,
};

test("bank reconciliation CLI parses explicit column mappings and live guard", () => {
  const options = parseArgs([
    "--environment", "test",
    "--bank-csv", "bank.csv",
    "--date-column", "Posting Date",
    "--credit-column", "Credit",
    "--debit-column", "Debit",
    "--currency-column", "Currency",
    "--reference-column", "Reference",
    "--description-column", "Narrative",
    "--date-window-days", "3",
    "--output", "report.csv",
  ]);
  assert.equal(options.dateColumn, "Posting Date");
  assert.equal(options.dateWindowDays, 3);
  assert.equal(validateOptions(options).output, "report.csv");
  assert.throws(() => validateOptions({ ...baseOptions, environment: "live" }), /--allow-live/);
  assert.throws(() => validateOptions({ ...baseOptions, settlementId: "bad-id" }), /Settlement ID/);
});

test("bank dates and decimal amounts are parsed into UTC and minor units", () => {
  assert.equal(parseBankDate("28/11/2026"), "2026-11-28T00:00:00.000Z");
  assert.equal(parseBankDate("2026-11-28T14:30:00Z"), "2026-11-28T14:30:00.000Z");
  assert.equal(parseAmountToMinorUnits("1,234.56", "Credit", 2), 123456);
  assert.equal(parseAmountToMinorUnits("KES 500.00", "Credit", 2), 50000);
  assert.equal(parseAmountToMinorUnits("-", "Debit", 2), 0);
  assert.throws(() => parseAmountToMinorUnits("-50.00", "Credit", 2), /Invalid non-negative amount/);\n  assert.throws(() => parseAmountToMinorUnits("12,34.56", "Credit", 2), /Invalid non-negative amount/);\n  assert.throws(() => parseBankDate("31/11/2026"), /date is invalid/);
});

test("bank CSV parser maps bank-specific columns without uploading source data", () => {
  const csv = [
    "Date,Description,Reference,Currency,Credit,Debit",
    '28/11/2026,"PAYSTACK settlement 123456","123456",KES,"995.00",""',
    '29/11/2026,"ATM withdrawal","",KES,"","50.00"',
  ].join("\n");
  const rows = parseBankCsv(csv, baseOptions);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(rows[0].creditMinor, 99500);
  assert.equal(rows[0].debitMinor, 0);
  assert.equal(rows[1].creditMinor, 0);
  assert.equal(rows[1].debitMinor, 5000);
  assert.throws(() => parseBankCsv(
    "Date,Credit,Debit\n28/11/2026,100.00,20.00",
    { ...baseOptions, descriptionColumn: undefined, referenceColumn: undefined, currencyColumn: undefined },
  ), /both a credit and a debit/);\n  assert.throws(() => parseBankCsv(
    "Date,Currency,Credit,Debit\n28/11/2026,,100.00,",
    { ...baseOptions, descriptionColumn: undefined, referenceColumn: undefined },
  ), /Only KES/);
});

test("bank candidate report requires manual confirmation and identifies exact reference evidence", () => {
  const settlementRows = [{
    settlement_id: "s1",
    provider_settlement_id: "123456",
    settlement_status: "success",
    settlement_currency: "KES",
    provider_total_amount_minor: 100000,
    provider_total_processed_minor: 100000,
    provider_total_fees_minor: 500,
    provider_effective_amount_minor: 99500,
    settled_at: "2026-11-28T00:00:00.000Z",
  }];
  const bankRows = [{
    rowNumber: 2,
    postedAt: "2026-11-28T00:00:00.000Z",
    currency: "KES",
    creditMinor: 99500,
    debitMinor: 0,
    reference: "123456",
    description: "PAYSTACK SETTLEMENT",
  }];
  const report = buildBankReconciliationReport(settlementRows, bankRows, 5);
  assert.equal(report.length, 1);
  assert.equal(report[0].expectedNetMinor, 99500);
  assert.equal(report[0].providerTotalProcessedMinor, 100000);
  assert.equal(report[0].providerTotalFeesMinor, 500);
  assert.equal(report[0].bankRowNumber, 2);
  assert.equal(report[0].matchEvidence, "settlement_id_in_bank_reference");
  assert.equal(report[0].reviewStatus, "candidate_requires_manual_confirmation");
  assert.equal(report[0].requiresManualConfirmation, true);
});

test("bank candidate report detects ambiguous matches, missing credits and non-success settlements", () => {
  const settlements = [
    { settlement_id: "s1", provider_settlement_id: "111", settlement_status: "success", settlement_currency: "KES", provider_effective_amount_minor: 10000, settled_at: "2026-11-28T00:00:00Z" },
    { settlement_id: "s2", provider_settlement_id: "222", settlement_status: "success", settlement_currency: "KES", provider_effective_amount_minor: 10000, settled_at: "2026-11-28T00:00:00Z" },
    { settlement_id: "s3", provider_settlement_id: "333", settlement_status: "success", settlement_currency: "KES", provider_effective_amount_minor: 20000, settled_at: "2026-11-28T00:00:00Z" },
    { settlement_id: "s4", provider_settlement_id: "444", settlement_status: "pending", settlement_currency: "KES", provider_effective_amount_minor: 30000, settled_at: "2026-11-28T00:00:00Z" },
  ];
  const bankRows = [{
    rowNumber: 2, postedAt: "2026-11-28T00:00:00Z", currency: "KES",
    creditMinor: 10000, debitMinor: 0, reference: "", description: "PAYSTACK",
  }];
  const report = buildBankReconciliationReport(settlements, bankRows, 5);
  assert.equal(report[0].reviewStatus, "ambiguous_candidates");
  assert.equal(report[1].reviewStatus, "ambiguous_candidates");
  assert.equal(report[2].reviewStatus, "missing_bank_credit");
  assert.equal(report[3].reviewStatus, "not_settled");
  assert.ok(report.every(row => row.requiresManualConfirmation));
});


test("unsupported settlement currencies fail closed", () => {
  const report = buildBankReconciliationReport([{
    settlement_id: "s-usd",
    provider_settlement_id: "888",
    settlement_status: "success",
    settlement_currency: "USD",
    provider_effective_amount_minor: 10000,
    settled_at: "2026-11-28T00:00:00Z",
  }], [], 5);
  assert.equal(report[0].reviewStatus, "unsupported_currency");
});

test("zero-net provider settlements do not generate false missing-bank-credit exceptions", () => {
  const report = buildBankReconciliationReport([{
    settlement_id: "s-zero",
    provider_settlement_id: "987",
    settlement_status: "success",
    settlement_currency: "KES",
    provider_effective_amount_minor: 0,
    settled_at: "2026-11-28T00:00:00Z",
  }], [], 5);
  assert.equal(report[0].reviewStatus, "zero_net_no_bank_credit_expected");
});
\ntest("bank candidate report rejects amount, currency and date mismatches", () => {
  const settlement = [{
    settlement_id: "s1",
    provider_settlement_id: "123456",
    settlement_status: "success",
    settlement_currency: "KES",
    provider_effective_amount_minor: 99500,
    settled_at: "2026-11-28T00:00:00Z",
  }];
  const bankRows = [
    { rowNumber: 2, postedAt: "2026-11-28T00:00:00Z", currency: "USD", creditMinor: 99500, debitMinor: 0, reference: "", description: "" },
    { rowNumber: 3, postedAt: "2026-11-28T00:00:00Z", currency: "KES", creditMinor: 99000, debitMinor: 0, reference: "", description: "" },
    { rowNumber: 4, postedAt: "2026-12-20T00:00:00Z", currency: "KES", creditMinor: 99500, debitMinor: 0, reference: "", description: "" },
  ];
  const report = buildBankReconciliationReport(settlement, bankRows, 5);
  assert.equal(report[0].reviewStatus, "missing_bank_credit");
});

test("bank report CSV escapes cells and retains manual-review status", () => {
  const csv = reportToCsv([{
    providerSettlementId: "123456",
    settlementStatus: "success",
    settlementDate: "2026-11-28",
    currency: "KES",
    providerTotalAmountMinor: 99500,
    providerTotalProcessedMinor: 100000,
    providerTotalFeesMinor: 500,
    expectedNetMinor: 99500,
    candidateCount: 1,
    bankRowNumber: 2,
    bankPostedAt: "2026-11-28",
    bankCreditMinor: 99500,
    matchEvidence: "amount_date_only",
    reviewStatus: "candidate_requires_manual_confirmation",
    requiresManualConfirmation: true,
  }]);
  assert.match(csv, /provider_total_processed_minor/);
  assert.match(csv, /candidate_requires_manual_confirmation/);
  assert.match(csv, /true/);
});

test("bank reconciliation command performs GET-only provider reads and writes a new local report", async () => {
  const options = validateOptions(baseOptions);
  const calls = [];
  const writes = [];
  const settlementRows = [{
    settlement_id: "s1",
    provider_settlement_id: "123456",
    settlement_status: "success",
    settlement_currency: "KES",
    provider_total_amount_minor: 100000,
    provider_total_processed_minor: 100000,
    provider_total_fees_minor: 500,
    provider_effective_amount_minor: 99500,
    settled_at: "2026-11-28T00:00:00Z",
  }];
  const result = await runBankReconciliation({
    options,
    environment: {
      SUPABASE_URL: "https://yhdosrhtzcsfqfuuqhsk.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "secret-not-to-log",
    },
    readFileImpl: async () => [
      "Date,Description,Reference,Currency,Credit,Debit",
      '28/11/2026,"PAYSTACK settlement 123456","123456",KES,"995.00",""',
    ].join("\n"),
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => settlementRows,
      };
    },
    writeFileImpl: async (path, data, options) => writes.push({ path, data, options }),
    output: () => {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].url.hostname, "yhdosrhtzcsfqfuuqhsk.supabase.co");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.flag, "wx");
  assert.equal(result.rows[0].reviewStatus, "candidate_requires_manual_confirmation");
  assert.doesNotMatch(writes[0].data, /secret-not-to-log/);
});
