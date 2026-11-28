#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "csv-parse/sync";
import { getSupabaseConfig } from "./paystack-settlement-import.mjs";

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const SETTLEMENT_ID = /^[0-9]{1,32}$/;
const SELECT_COLUMNS = [
  "settlement_id",
  "provider_settlement_id",
  "environment",
  "settlement_status",
  "settlement_currency",
  "provider_effective_amount_minor",
  "settled_at",
].join(",");

export function parseArgs(argv) {
  const options = {};
  const valueOptions = [
    "--environment",
    "--bank-csv",
    "--date-column",
    "--credit-column",
    "--debit-column",
    "--currency-column",
    "--reference-column",
    "--description-column",
    "--settlement-id",
    "--date-window-days",
    "--output",
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-live") {
      options.allowLive = true;
    } else if (valueOptions.includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + argument);
      const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = value;
      index += 1;
    } else {
      throw new Error("Unknown argument: " + argument);
    }
  }
  if (options.dateWindowDays != null) options.dateWindowDays = Number(options.dateWindowDays);
  return options;
}

export function validateOptions(options) {
  if (!options || !["test", "live"].includes(options.environment)) {
    throw new Error("Expected environment must be test or live.");
  }
  for (const key of ["bankCsv", "dateColumn", "creditColumn", "debitColumn"]) {
    if (typeof options[key] !== "string" || !options[key].trim()) throw new Error("Missing required option: --" + key.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()));
  }
  if (options.settlementId != null && !SETTLEMENT_ID.test(String(options.settlementId))) {
    throw new Error("Settlement ID must contain 1–32 digits.");
  }
  const days = options.dateWindowDays == null ? 5 : options.dateWindowDays;
  if (!Number.isInteger(days) || days < 0 || days > 14) throw new Error("Date window must be a whole number from 0 to 14 days.");
  if (options.environment === "live" && options.allowLive !== true) {
    throw new Error("Live bank reconciliation requires --allow-live.");
  }
  return { ...options, dateWindowDays: days, output: options.output || "paystack-bank-reconciliation-report.csv" };
}

export function parseBankDate(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("Bank statement date is blank.");
  let date;
  const dayFirst = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (dayFirst) {
    date = new Date(Date.UTC(Number(dayFirst[3]), Number(dayFirst[2]) - 1, Number(dayFirst[1])));
  } else {
    date = new Date(text);
  }
  if (!Number.isFinite(date.getTime())) throw new Error("Bank statement date is not a supported date: " + text);
  return date.toISOString();
}

export function parseAmountToMinorUnits(value, columnName, rowNumber) {
  let text = String(value ?? "").trim();
  if (!text) return 0;
  text = text.replace(/^(?:KES|KSH)\s*/i, "").replace(/[ ,]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error("Invalid non-negative amount in " + columnName + " at CSV row " + rowNumber + ".");
  }
  const [whole, fraction = ""] = text.split(".");
  const minor = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount exceeds safe integer range at CSV row " + rowNumber + ".");
  return Number(minor);
}

export function parseBankCsv(csvText, options) {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_column_count: false,
    max_record_size: 20_000,
  });
  if (records.length === 0) throw new Error("Bank statement CSV contains no transaction rows.");
  const headers = Object.keys(records[0]);
  const required = [options.dateColumn, options.creditColumn, options.debitColumn];
  for (const column of required) {
    if (!headers.includes(column)) throw new Error("Bank statement CSV is missing the configured column: " + column);
  }
  for (const optional of [options.currencyColumn, options.referenceColumn, options.descriptionColumn]) {
    if (optional && !headers.includes(optional)) throw new Error("Bank statement CSV is missing the configured column: " + optional);
  }

  const rows = [];
  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const creditMinor = parseAmountToMinorUnits(record[options.creditColumn], options.creditColumn, rowNumber);
    const debitMinor = parseAmountToMinorUnits(record[options.debitColumn], options.debitColumn, rowNumber);
    if (creditMinor > 0 && debitMinor > 0) throw new Error("CSV row " + rowNumber + " has both a credit and a debit amount.");
    if (creditMinor === 0 && debitMinor === 0) return;
    const currency = options.currencyColumn
      ? String(record[options.currencyColumn] ?? "").trim().toUpperCase()
      : "KES";
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Invalid currency at CSV row " + rowNumber + ".");
    rows.push({
      rowNumber,
      postedAt: parseBankDate(record[options.dateColumn]),
      currency,
      creditMinor,
      debitMinor,
      reference: options.referenceColumn ? String(record[options.referenceColumn] ?? "").trim() : "",
      description: options.descriptionColumn ? String(record[options.descriptionColumn] ?? "").trim() : "",
    });
  });
  return rows;
}

function dayNumber(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000;
}

function containsText(haystack, needle) {
  return Boolean(needle) && String(haystack ?? "").toLowerCase().includes(String(needle).toLowerCase());
}

function candidateEvidence(bankRow, settlementId) {
  const combined = bankRow.reference + " " + bankRow.description;
  if (containsText(combined, settlementId)) return "settlement_id_in_bank_reference";
  if (containsText(combined, "paystack")) return "paystack_bank_descriptor";
  return "amount_currency_date_only";
}

export function buildBankReconciliationReport(settlementRows, bankRows, dateWindowDays = 5) {
  const grouped = new Map();
  for (const row of settlementRows) {
    const key = String(row.settlement_id ?? row.provider_settlement_id ?? "unknown");
    if (!grouped.has(key)) {
      grouped.set(key, {
        providerSettlementId: String(row.provider_settlement_id ?? "unknown"),
        status: String(row.settlement_status ?? "unknown"),
        currency: String(row.settlement_currency ?? "unknown"),
        expectedNetMinor: Number(row.provider_effective_amount_minor),
        settledAt: row.settled_at ?? null,
      });
    }
  }

  const candidatesBySettlement = [];
  for (const settlement of grouped.values()) {
    if (settlement.status !== "success") {
      candidatesBySettlement.push({ settlement, candidates: [], chosen: null, reviewStatus: "not_settled", evidence: "" });
      continue;
    }
    if (!Number.isSafeInteger(settlement.expectedNetMinor) || settlement.expectedNetMinor < 0) {
      candidatesBySettlement.push({ settlement, candidates: [], chosen: null, reviewStatus: "missing_expected_net_amount", evidence: "" });
      continue;
    }
    if (!settlement.settledAt || !Number.isFinite(Date.parse(settlement.settledAt))) {
      candidatesBySettlement.push({ settlement, candidates: [], chosen: null, reviewStatus: "missing_settlement_date", evidence: "" });
      continue;
    }
    const candidates = bankRows.filter((bankRow) =>
      bankRow.creditMinor > 0
      && bankRow.debitMinor === 0
      && bankRow.currency === settlement.currency
      && bankRow.creditMinor === settlement.expectedNetMinor
      && Math.abs(dayNumber(bankRow.postedAt) - dayNumber(settlement.settledAt)) <= dateWindowDays
    );
    const strong = candidates.filter((bankRow) => {
      const evidence = candidateEvidence(bankRow, settlement.providerSettlementId);
      return evidence !== "amount_currency_date_only";
    });
    let chosen = null;
    let evidence = "";
    let reviewStatus = "missing_bank_credit";
    if (strong.length === 1) {
      chosen = strong[0];
      evidence = candidateEvidence(chosen, settlement.providerSettlementId);
      reviewStatus = "candidate_requires_manual_confirmation";
    } else if (strong.length > 1 || candidates.length > 1) {
      reviewStatus = "ambiguous_candidates";
    } else if (candidates.length === 1) {
      chosen = candidates[0];
      evidence = "amount_currency_date_only";
      reviewStatus = "candidate_requires_manual_confirmation";
    }
    candidatesBySettlement.push({ settlement, candidates, chosen, reviewStatus, evidence });
  }

  const candidateUsage = new Map();
  for (const item of candidatesBySettlement) {
    if (item.chosen) candidateUsage.set(item.chosen.rowNumber, (candidateUsage.get(item.chosen.rowNumber) ?? 0) + 1);
  }

  return candidatesBySettlement.map((item) => {
    const contested = item.chosen && candidateUsage.get(item.chosen.rowNumber) > 1;
    const chosen = item.chosen && !contested ? item.chosen : null;
    return {
      providerSettlementId: item.settlement.providerSettlementId,
      settlementStatus: item.settlement.status,
      settlementDate: item.settlement.settledAt ? item.settlement.settledAt.slice(0, 10) : "",
      currency: item.settlement.currency,
      expectedNetMinor: Number.isSafeInteger(item.settlement.expectedNetMinor) ? item.settlement.expectedNetMinor : "",
      candidateCount: item.candidates.length,
      bankRowNumber: chosen ? chosen.rowNumber : "",
      bankPostedAt: chosen ? chosen.postedAt.slice(0, 10) : "",
      bankCreditMinor: chosen ? chosen.creditMinor : "",
      matchEvidence: chosen ? item.evidence : "",
      reviewStatus: contested ? "ambiguous_candidates" : item.reviewStatus,
      requiresManualConfirmation: true,
    };
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function reportToCsv(rows) {
  const columns = [
    "provider_settlement_id",
    "settlement_status",
    "settlement_date",
    "currency",
    "expected_net_minor",
    "candidate_count",
    "bank_row_number",
    "bank_posted_at",
    "bank_credit_minor",
    "match_evidence",
    "review_status",
    "requires_manual_confirmation",
  ];
  return [columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())])).join(","))].join("\n") + "\n";
}

async function fetchSettlementRows(baseUrl, serviceRoleKey, options, fetchImpl) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(baseUrl + "/rest/v1/paystack_settlement_reconciliation");
    url.searchParams.set("select", SELECT_COLUMNS);
    url.searchParams.set("environment", "eq." + options.environment);
    url.searchParams.set("order", "settlement_id.asc,provider_settlement_id.asc");
    if (options.settlementId) url.searchParams.set("provider_settlement_id", "eq." + options.settlementId);
    const start = page * PAGE_SIZE;
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
      throw new Error("Settlement reconciliation view returned a non-JSON response (HTTP " + response.status + ").");
    }
    if (!response.ok || !Array.isArray(body)) {
      const code = typeof body?.message === "string" ? body.message : "SETTLEMENT_RECONCILIATION_HTTP_" + response.status;
      throw new Error(code + " (HTTP " + response.status + ").");
    }
    rows.push(...body);
    if (body.length < PAGE_SIZE) return rows;
  }
  throw new Error("Settlement reconciliation view exceeded the 100,000-row safety limit.");
}

export async function runBankReconciliation({
  options,
  environment = process.env,
  fetchImpl = fetch,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  output = console.log,
}) {
  const validated = validateOptions(options);
  const config = getSupabaseConfig(environment);
  const inputPath = resolve(validated.bankCsv);
  const outputPath = resolve(validated.output);
  if (inputPath === outputPath) throw new Error("Report output path must not overwrite the bank statement CSV.");
  const csvText = await readFileImpl(inputPath, "utf8");
  const bankRows = parseBankCsv(csvText, validated);
  const settlementRows = await fetchSettlementRows(config.baseUrl, config.serviceRoleKey, validated, fetchImpl);
  const reportRows = buildBankReconciliationReport(settlementRows, bankRows, validated.dateWindowDays);
  const csv = reportToCsv(reportRows);
  await writeFileImpl(outputPath, csv, { encoding: "utf8", flag: "wx" });
  const reviewCounts = new Map();
  for (const row of reportRows) reviewCounts.set(row.reviewStatus, (reviewCounts.get(row.reviewStatus) ?? 0) + 1);
  output("Bank reconciliation candidate report written to " + outputPath + ".");
  output("Environment: " + validated.environment + "; provider settlements: " + reportRows.length + "; bank statement rows: " + bankRows.length + ".");
  for (const [status, count] of reviewCounts) output(status + ": " + count);
  output("No row is marked reconciled automatically. Every candidate requires human confirmation against the original bank statement.");
  output("This report is local only. No bank statement was uploaded and no database record was changed.");
  return { outputPath, settlementCount: reportRows.length, bankRowCount: bankRows.length, rows: reportRows };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    await runBankReconciliation({ options });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown bank reconciliation error.";
    console.error("Bank reconciliation failed: " + message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
