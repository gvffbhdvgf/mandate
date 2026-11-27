import { adminClient, env, json, paystackRequest, settlementModeEnabled } from "../_shared/paystack.ts";

type PaystackPage<T> = {
  status: boolean;
  data: T[];
  meta?: { pageCount?: number };
};
type Settlement = {
  id: number | string;
  status: string;
  currency: string;
  total_amount?: number | string;
  effective_amount?: number | string;
  total_processed?: number | string;
  total_fees?: number | string;
  settlement_date?: string | null;
};
type SettlementTransaction = {
  id: number | string;
  reference: string;
  status: string;
  amount: number | string;
  currency: string;
  fees?: number | string | null;
  paid_at?: string | null;
};

const PAGE_SIZE = 100;
const MAX_SETTLEMENT_PAGES = 20;
const validIso = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value));
const minorUnits = (value: unknown, allowZero = true): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) return null;
  return parsed;
};
const sameSecret = (candidate: string, expected: string) => {
  const left = new TextEncoder().encode(candidate);
  const right = new TextEncoder().encode(expected);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
};

async function findSettlement(from: string, to: string, wantedId: string): Promise<Settlement | null> {
  for (let page = 1; page <= MAX_SETTLEMENT_PAGES; page++) {
    const params = new URLSearchParams({ from, to, perPage: String(PAGE_SIZE), page: String(page) });
    const response = await paystackRequest<PaystackPage<Settlement>>(`/settlement?${params.toString()}`);
    if (!Array.isArray(response.data)) throw new Error("PAYSTACK_SETTLEMENT_RESPONSE_INVALID");
    const found = response.data.find((item) => String(item.id) === wantedId);
    if (found) return found;
    const pageCount = Number(response.meta?.pageCount ?? 1);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error("PAYSTACK_SETTLEMENT_PAGINATION_INVALID");
    if (page >= pageCount) return null;
  }
  throw new Error("PAYSTACK_SETTLEMENT_SEARCH_LIMIT_EXCEEDED");
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = request.headers.get("Authorization") ?? "";
  if (!serviceKey || !sameSecret(authorization.startsWith("Bearer ") ? authorization.slice(7) : "", serviceKey)) {
    return json(403, { error: "SERVICE_ROLE_REQUIRED" });
  }

  const mode = env("PAYSTACK_MODE");
  if (!settlementModeEnabled()) return json(503, { error: "PAYSTACK_SETTLEMENT_PIPELINE_DISABLED" });

  let input: { from?: unknown; to?: unknown; settlementId?: unknown; transactionPage?: unknown };
  try {
    input = await request.json();
  } catch {
    return json(400, { error: "INVALID_REQUEST_BODY" });
  }
  const { from, to } = input;
  const settlementId = typeof input.settlementId === "string" ? input.settlementId.trim() : "";
  const transactionPage = input.transactionPage == null ? 1 : Number(input.transactionPage);
  if (!validIso(from) || !validIso(to) || Date.parse(from) > Date.parse(to)
    || Date.parse(to) - Date.parse(from) > 31 * 24 * 60 * 60 * 1000
    || !/^[0-9]{1,32}$/.test(settlementId)
    || !Number.isSafeInteger(transactionPage) || transactionPage < 1 || transactionPage > 1000) {
    return json(400, { error: "INVALID_SETTLEMENT_IMPORT_RANGE_OR_CURSOR" });
  }

  try {
    const settlement = await findSettlement(from, to, settlementId);
    if (!settlement) return json(404, { error: "PAYSTACK_SETTLEMENT_NOT_FOUND" });
    const currency = String(settlement.currency ?? "").toUpperCase();
    const status = String(settlement.status ?? "");
    if (!/^[A-Z]{3}$/.test(currency) || !["pending", "processing", "success", "failed"].includes(status)) {
      return json(502, { error: "PAYSTACK_SETTLEMENT_FIELDS_INVALID" });
    }

    const totalAmount = minorUnits(settlement.total_amount);
    const effectiveAmount = minorUnits(settlement.effective_amount);
    const totalProcessed = minorUnits(settlement.total_processed);
    const totalFees = minorUnits(settlement.total_fees);
    if ([settlement.total_amount, settlement.effective_amount, settlement.total_processed, settlement.total_fees]
      .some((value) => value != null && minorUnits(value) == null)) {
      return json(502, { error: "PAYSTACK_SETTLEMENT_AMOUNTS_INVALID" });
    }

    const admin = adminClient();
    const { data: stored, error: settlementError } = await admin
      .from("paystack_settlements")
      .upsert({
        environment: mode,
        provider_settlement_id: String(settlement.id),
        status,
        currency,
        provider_total_amount_minor: totalAmount,
        provider_effective_amount_minor: effectiveAmount,
        provider_total_processed_minor: totalProcessed,
        provider_total_fees_minor: totalFees,
        settled_at: settlement.settlement_date && Number.isFinite(Date.parse(settlement.settlement_date))
          ? new Date(settlement.settlement_date).toISOString() : null,
      }, { onConflict: "environment,provider_settlement_id" })
      .select("id")
      .single();
    if (settlementError || !stored) return json(500, { error: "SETTLEMENT_BATCH_PERSIST_FAILED" });

    const params = new URLSearchParams({ perPage: String(PAGE_SIZE), page: String(transactionPage) });
    const transactionResponse = await paystackRequest<PaystackPage<SettlementTransaction>>(
      `/settlement/${encodeURIComponent(settlementId)}/transactions?${params.toString()}`,
    );
    if (!Array.isArray(transactionResponse.data)) return json(502, { error: "PAYSTACK_SETTLEMENT_TRANSACTIONS_INVALID" });
    const pageCount = Number(transactionResponse.meta?.pageCount ?? 1);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 1000 || transactionPage > pageCount) {
      return json(502, { error: "PAYSTACK_SETTLEMENT_PAGINATION_INVALID" });
    }

    const rows = [];
    for (const item of transactionResponse.data) {
      const amount = minorUnits(item.amount, false);
      const fee = minorUnits(item.fees);
      const transactionCurrency = String(item.currency ?? "").toUpperCase();
      if (item.id == null || typeof item.reference !== "string" || !item.reference
        || typeof item.status !== "string" || !item.status
        || amount == null || (item.fees != null && fee == null)
        || !/^[A-Z]{3}$/.test(transactionCurrency)) {
        return json(502, { error: "PAYSTACK_SETTLEMENT_TRANSACTION_FIELDS_INVALID" });
      }
      rows.push({
        settlement_id: stored.id,
        environment: mode,
        provider_transaction_id: String(item.id),
        provider_reference: item.reference,
        provider_status: item.status,
        amount_minor: amount,
        currency: transactionCurrency,
        fee_minor: fee,
        paid_at: item.paid_at && Number.isFinite(Date.parse(item.paid_at))
          ? new Date(item.paid_at).toISOString() : null,
      });
    }

    if (rows.length > 0) {
      const { error } = await admin.from("paystack_settlement_transactions")
        .upsert(rows, { onConflict: "environment,provider_transaction_id" });
      if (error) return json(500, { error: "SETTLEMENT_TRANSACTION_PERSIST_FAILED" });
    }

    return json(200, {
      imported: true,
      environment: mode,
      settlementId: String(settlement.id),
      settlementStatus: status,
      importedTransactions: rows.length,
      transactionPage,
      transactionPageCount: pageCount,
      nextTransactionPage: transactionPage < pageCount ? transactionPage + 1 : null,
      complete: transactionPage === pageCount,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "SETTLEMENT_IMPORT_FAILED";
    const status = code === "PAYSTACK_MODE_CONFIG_INVALID" ? 503
      : code === "PAYSTACK_SETTLEMENT_NOT_FOUND" ? 404
      : 502;
    return json(status, { error: code });
  }
});
