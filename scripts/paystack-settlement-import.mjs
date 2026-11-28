#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const EXPECTED_SUPABASE_HOST = "yhdosrhtzcsfqfuuqhsk.supabase.co";
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SETTLEMENT_ID = /^[0-9]{1,32}$/;

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-import") {
      options.confirmImport = true;
    } else if (argument === "--allow-live") {
      options.allowLive = true;
    } else if (["--settlement-id", "--from", "--to", "--environment"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + argument);
      const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = value;
      index += 1;
    } else {
      throw new Error("Unknown argument: " + argument);
    }
  }
  return options;
}

export function validateOptions(options) {
  if (!options || typeof options !== "object") throw new Error("Import options are required.");
  if (!SETTLEMENT_ID.test(String(options.settlementId ?? ""))) throw new Error("Settlement ID must contain 1–32 digits.");
  if (!ISO_UTC.test(String(options.from ?? "")) || !Number.isFinite(Date.parse(options.from))) {
    throw new Error("From must be an ISO UTC timestamp, for example 2026-11-01T00:00:00Z.");
  }
  if (!ISO_UTC.test(String(options.to ?? "")) || !Number.isFinite(Date.parse(options.to))) {
    throw new Error("To must be an ISO UTC timestamp, for example 2026-11-30T23:59:59Z.");
  }
  if (Date.parse(options.from) > Date.parse(options.to)
    || Date.parse(options.to) - Date.parse(options.from) > 31 * 24 * 60 * 60 * 1000) {
    throw new Error("Settlement date range must be ordered and no longer than 31 days.");
  }
  if (!["test", "live"].includes(options.environment)) throw new Error("Expected environment must be test or live.");
  if (options.confirmImport !== true) throw new Error("Pass --confirm-import to authorize importing provider settlement evidence.");
  if (options.environment === "live" && options.allowLive !== true) {
    throw new Error("Live import requires the additional --allow-live confirmation.");
  }
  return options;
}

export function getSupabaseConfig(environment) {
  const rawUrl = environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!rawUrl || !serviceRoleKey) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the process environment.");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("SUPABASE_URL is invalid.");
  }
  if (url.protocol !== "https:" || url.hostname !== EXPECTED_SUPABASE_HOST || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SUPABASE_URL must be the Mandate production Supabase project URL.");
  }
  return { baseUrl: url.origin, serviceRoleKey };
}

async function postImportRequest(endpoint, serviceRoleKey, payload, fetchImpl) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + serviceRoleKey,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Settlement importer returned a non-JSON response (HTTP " + response.status + ").");
  }
  if (!response.ok) {
    const code = typeof body?.error === "string" ? body.error : "SETTLEMENT_IMPORT_HTTP_" + response.status;
    throw new Error(code + " (HTTP " + response.status + ").");
  }
  return body;
}

export async function runImport({
  options,
  environment = process.env,
  fetchImpl = fetch,
  output = console.log,
}) {
  const validated = validateOptions(options);
  const config = getSupabaseConfig(environment);
  const endpoint = config.baseUrl + "/functions/v1/paystack-settlement-import";
  const common = {
    from: validated.from,
    to: validated.to,
    settlementId: validated.settlementId,
    transactionPage: 1,
  };

  const preflight = await postImportRequest(endpoint, config.serviceRoleKey, { ...common, preflight: true }, fetchImpl);
  if (preflight.ready !== true || !["test", "live"].includes(preflight.environment)
    || String(preflight.settlementId) !== validated.settlementId || preflight.from !== validated.from || preflight.to !== validated.to) {
    throw new Error("Settlement importer preflight did not confirm readiness.");
  }
  if (preflight.environment !== validated.environment) {
    throw new Error("Environment mismatch: expected " + validated.environment + " but Supabase is configured for " + preflight.environment + ". No settlement data was imported.");
  }
  if (preflight.environment === "live" && validated.allowLive !== true) {
    throw new Error("Supabase is configured for live mode. Re-run only with --environment live --allow-live --confirm-import.");
  }

  output("Preflight passed. Environment: " + preflight.environment + "; settlement: " + validated.settlementId + ".");
  let page = 1;
  let pageCount = null;
  let importedTotal = 0;
  let settlementStatus = null;

  for (let attempts = 0; attempts < 1000; attempts += 1) {
    const result = await postImportRequest(endpoint, config.serviceRoleKey, { ...common, transactionPage: page }, fetchImpl);
    if (result.environment !== preflight.environment || String(result.settlementId) !== validated.settlementId) {
      throw new Error("Importer response identity did not match preflight; stop and inspect the settlement records.");
    }
    if (result.imported !== true || typeof result.settlementStatus !== "string"
      || !Number.isSafeInteger(result.importedTransactions) || result.importedTransactions < 0
      || !Number.isSafeInteger(result.transactionPageCount) || result.transactionPageCount < 1
      || result.transactionPageCount > 1000 || result.transactionPage !== page
      || typeof result.complete !== "boolean") {
      throw new Error("Importer returned invalid pagination data.");
    }
    if (pageCount != null && pageCount !== result.transactionPageCount) {
      throw new Error("Settlement page count changed during import; rerun after checking the provider settlement.");
    }
    if (settlementStatus != null && settlementStatus !== result.settlementStatus) {
      throw new Error("Settlement status changed during import; stop and reconcile before continuing.");
    }
    pageCount = result.transactionPageCount;
    settlementStatus = result.settlementStatus;
    importedTotal += result.importedTransactions;
    output("Imported " + result.importedTransactions + " transactions from page " + page + " of " + pageCount + ".");
    if (result.complete) {
      if (page !== pageCount) throw new Error("Importer marked an incomplete page sequence as complete.");
      output("Import complete: " + importedTotal + " transactions; settlement " + validated.settlementId
        + " (" + settlementStatus + ", " + preflight.environment + ").");
      output("This imports provider settlement evidence only. It does not prove bank credit, post final revenue, resolve exceptions or authorize payouts.");
      return { environment: preflight.environment, settlementId: validated.settlementId, settlementStatus, pageCount, importedTransactions: importedTotal };
    }
    if (result.nextTransactionPage !== page + 1) {
      throw new Error("Importer returned an invalid next-page cursor. Rerun from page 1; imports are idempotent.");
    }
    page = result.nextTransactionPage;
  }

  throw new Error("Settlement import exceeded the 1,000-page safety limit.");
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    await runImport({ options });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown settlement import error.";
    console.error("Settlement import failed: " + message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
