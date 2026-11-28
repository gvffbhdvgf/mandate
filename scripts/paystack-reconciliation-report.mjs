#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { getSupabaseConfig } from "./paystack-settlement-import.mjs";

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const SETTLEMENT_ID = /^[0-9]{1,32}$/;
const SETTLEMENT_COLUMNS = [
  "settlement_id",
  "provider_settlement_id",
  "environment",
  "settlement_status",
  "settlement_currency",
  "provider_total_amount_minor",
  "provider_effective_amount_minor",
  "provider_total_processed_minor",
  "provider_total_fees_minor",
  "provider_transaction_count",
  "settled_transaction_amount_minor",
  "fee_minor",
  "reconciliation_status",
].join(",");
const EXCEPTION_COLUMNS = [
  "environment",
  "payment_intent_status",
  "provider_status",
  "receipt_posted",
  "event_count",
  "event_types",
  "settlement_reconciliation_statuses",
].join(",");

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-live") {
      options.allowLive = true;
    } else if (["--environment", "--settlement-id"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + argument);
      const key = argument === "--settlement-id" ? "settlementId" : "environment";
      options[key] = value;
      index += 1;
    } else {
      throw new Error("Unknown argument: " + argument);
    }
  }
  return options;
}

export function validateOptions(options) {
  if (!options || !["test", "live"].includes(options.environment)) {
    throw new Error("Expected environment must be test or live.");
  }
  if (options.settlementId != null && !SETTLEMENT_ID.test(String(options.settlementId))) {
    throw new Error("Settlement ID must contain 1–32 digits.");
  }
  if (options.environment === "live" && options.allowLive !== true) {
    throw new Error("Live reconciliation report requires --allow-live.");
  }
  return options;
}

function buildViewUrl(baseUrl, view, columns, options) {
  const url = new URL(baseUrl + "/rest/v1/" + view);
  url.searchParams.set("select", columns);
  url.searchParams.set("environment", "eq." + options.environment);
  if (options.settlementId && view === "paystack_settlement_reconciliation") {
    url.searchParams.set("provider_settlement_id", "eq." + options.settlementId);
  }
  return url;
}

async function fetchRows(baseUrl, serviceRoleKey, view, columns, options, fetchImpl) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = buildViewUrl(baseUrl, view, columns, options);
    const start = page * PAGE_SIZE;
    url.searchParams.set("order", view === "paystack_settlement_reconciliation"
      ? "settlement_id.asc,provider_settlement_id.asc"
      : "payment_intent_id.asc");
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + serviceRoleKey,
        apikey: serviceRoleKey,
        Range: start + "-" + (start + PAGE_SIZE - 1),
        Prefer: "count=exact",
      },
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(view + " returned a non-JSON response (HTTP " + response.status + ").");
    }
    if (!response.ok || !Array.isArray(body)) {
      const code = typeof body?.message === "string" ? body.message : view + "_HTTP_" + response.status;
      throw new Error(code + " (HTTP " + response.status + ").");
    }
    rows.push(...body);
    if (body.length < PAGE_SIZE) return rows;
  }
  throw new Error(view + " exceeded the 100,000-row safety limit.");
}

function safeInteger(value) {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) ? number : 0;
}

export function formatReport(settlementRows, exceptionRows, environment) {
  const settlements = new Map();
  const statusCounts = new Map();
  for (const row of settlementRows) {
    const key = String(row.settlement_id ?? row.provider_settlement_id ?? "unknown");
    let settlement = settlements.get(key);
    if (!settlement) {
      settlement = {
        providerSettlementId: String(row.provider_settlement_id ?? "unknown"),
        status: String(row.settlement_status ?? "unknown"),
        currency: String(row.settlement_currency ?? "unknown"),
        providerTotalMinor: safeInteger(row.provider_total_amount_minor),
        providerEffectiveMinor: safeInteger(row.provider_effective_amount_minor),
        providerProcessedMinor: safeInteger(row.provider_total_processed_minor),
        providerFeesMinor: safeInteger(row.provider_total_fees_minor),
        providerTransactionCount: safeInteger(row.provider_transaction_count),
        importedRows: 0,
        matchedRows: 0,
        unresolvedRows: 0,
        importedAmountMinor: 0,
        importedFeesMinor: 0,
      };
      settlements.set(key, settlement);
    }
    settlement.importedRows += 1;
    settlement.importedAmountMinor += safeInteger(row.settled_transaction_amount_minor);
    settlement.importedFeesMinor += safeInteger(row.fee_minor);
    const status = String(row.reconciliation_status ?? "unknown");
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    if (status === "matched_to_receipt") settlement.matchedRows += 1;
    else settlement.unresolvedRows += 1;
  }

  const exceptionTypes = new Map();
  let exceptionEvents = 0;
  let receiptsPosted = 0;
  let receiptsMissing = 0;
  for (const row of exceptionRows) {
    exceptionEvents += safeInteger(row.event_count);
    if (row.receipt_posted === true) receiptsPosted += 1;
    else receiptsMissing += 1;
    for (const type of Array.isArray(row.event_types) ? row.event_types : []) {
      exceptionTypes.set(String(type), (exceptionTypes.get(String(type)) ?? 0) + 1);
    }
  }

  return {
    environment,
    settlementCount: settlements.size,
    transactionRows: settlementRows.length,
    settlements: [...settlements.values()].sort((a, b) => a.providerSettlementId.localeCompare(b.providerSettlementId)),
    reconciliationStatuses: [...statusCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    exceptionRecords: exceptionRows.length,
    exceptionEvents,
    receiptsPosted,
    receiptsMissing,
    exceptionTypes: [...exceptionTypes.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  };
}

function renderReport(report, output) {
  output("Paystack settlement evidence report");
  output("Environment: " + report.environment);
  output("Imported settlements: " + report.settlementCount);
  output("Imported provider transaction rows: " + report.transactionRows);
  if (report.settlementCount === 0) output("No settlement rows found. Import a settlement first.");
  for (const settlement of report.settlements) {
    output(
      "Settlement " + settlement.providerSettlementId
      + ": " + settlement.status + " " + settlement.currency
      + "; provider total " + settlement.providerTotalMinor + " minor units"
      + "; provider fees " + settlement.providerFeesMinor + " minor units"
      + "; imported rows " + settlement.importedRows
      + "; matched receipts " + settlement.matchedRows
      + "; unresolved rows " + settlement.unresolvedRows
      + "; imported transaction amount " + settlement.importedAmountMinor + " minor units"
      + "; imported fees " + settlement.importedFeesMinor + " minor units.",
    );
  }
  output("Reconciliation status counts:");
  if (report.reconciliationStatuses.length === 0) output("  none");
  for (const [status, count] of report.reconciliationStatuses) output("  " + status + ": " + count);
  output("Payment exception records: " + report.exceptionRecords + "; provider events: " + report.exceptionEvents
    + "; receipt posted: " + report.receiptsPosted + "; receipt missing: " + report.receiptsMissing + ".");
  for (const [type, count] of report.exceptionTypes) output("  exception " + type + ": " + count);
  output("Bank reconciliation: NOT VERIFIED. These views compare provider settlement facts to verified Mandate receipts; they do not prove bank credit or final revenue allocation.");
  output("No payment, refund, transfer, payout or database mutation was performed.");
}

export async function runReport({
  options,
  environment = process.env,
  fetchImpl = fetch,
  output = console.log,
}) {
  const validated = validateOptions(options);
  const config = getSupabaseConfig(environment);
  const [settlementRows, exceptionRows] = await Promise.all([
    fetchRows(config.baseUrl, config.serviceRoleKey, "paystack_settlement_reconciliation", SETTLEMENT_COLUMNS, validated, fetchImpl),
    fetchRows(config.baseUrl, config.serviceRoleKey, "paystack_payment_exception_queue", EXCEPTION_COLUMNS, validated, fetchImpl),
  ]);
  const report = formatReport(settlementRows, exceptionRows, validated.environment);
  renderReport(report, output);
  return report;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    await runReport({ options });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown reconciliation report error.";
    console.error("Reconciliation report failed: " + message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
