import {
  adminClient, assertOrganizationFinanceManager, authenticate, corsHeaders, env, json,
  paystackRequest, paymentsModeEnabled,
} from "../_shared/paystack.ts";

type PaystackTransferResponse = {
  status: boolean;
  message?: string;
  data: {
    id?: number | string;
    reference: string;
    transfer_code?: string;
    status: string;
    amount: number | string;
    currency: string;
    fee_charged?: number | string | null;
  };
};

const safeString = (value: unknown, max = 160) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const amountMinor = (value: unknown): number | null => {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 100_000_000_000 ? amount : null;
};

async function recordVerifiedTransfer(
  admin: ReturnType<typeof adminClient>,
  transfer: PaystackTransferResponse["data"],
  source: "api_verify",
) {
  const reference = safeString(transfer.reference, 120);
  const transferCode = safeString(transfer.transfer_code, 120);
  const status = safeString(transfer.status, 32).toLowerCase();
  const amount = amountMinor(transfer.amount);
  const currency = safeString(transfer.currency, 3).toUpperCase();
  const fee = transfer.fee_charged == null ? null : Number(transfer.fee_charged);
  if (!reference || !transferCode || !["success", "failed", "reversed"].includes(status)
    || amount == null || currency !== "KES"
    || (fee !== null && (!Number.isSafeInteger(fee) || fee < 0))) {
    return { processed: false, reason: "TRANSFER_VERIFICATION_FIELDS_INVALID" };
  }

  const eventKey = `paystack-transfer-api:${status}:${transferCode}`;
  const { data: event, error: eventError } = await admin.from("paystack_transfer_events")
    .upsert({
      provider_event_key: eventKey,
      transfer_reference: reference,
      event_type: `transfer.${status}`,
      provider_transfer_code: transferCode,
      provider_status: status,
      amount_minor: amount,
      currency,
      signature_verified: false,
      verification_source: source,
      redacted_payload: { status, amountMinor: amount, currency, transferCode },
      processing_status: "received",
    }, { onConflict: "provider_event_key", ignoreDuplicates: true })
    .select("id,processing_status")
    .maybeSingle();
  if (eventError) return { processed: false, reason: "TRANSFER_EVENT_PERSIST_FAILED" };

  let eventId = event?.id as string | undefined;
  if (!eventId) {
    const { data: existing, error } = await admin.from("paystack_transfer_events")
      .select("id,processing_status")
      .eq("provider_event_key", eventKey)
      .maybeSingle();
    if (error || !existing) return { processed: false, reason: "TRANSFER_EVENT_LOOKUP_FAILED" };
    if (existing.processing_status === "processed") return { processed: true, duplicate: true, status };
    eventId = existing.id;
  }

  const { data: result, error } = await admin.rpc("apply_paystack_transfer_status", {
    p_event_id: eventId,
    p_transfer_reference: reference,
    p_provider_transfer_code: transferCode,
    p_provider_status: status,
    p_amount_minor: amount,
    p_currency: currency,
    p_provider_fee_minor: fee,
  });
  if (error || !result) return { processed: false, reason: "TRANSFER_LEDGER_RECONCILIATION_FAILED" };
  return result as Record<string, unknown>;
}

function transferCapabilityEnabled() {
  const mode = env("PAYSTACK_MODE");
  if (!paymentsModeEnabled()) return false;
  if (mode === "live") return env("PAYSTACK_LIVE_TRANSACTIONS_ENABLED").toLowerCase() === "true";
  return mode === "test";
}

Deno.serve(async (request: Request) => {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" }, cors);

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json(400, { error: "INVALID_REQUEST_BODY" }, cors); }

  try {
    const { user, caller } = await authenticate(request);
    const action = safeString(body.action, 40);
    const organizationId = safeString(body.organizationId, 64);
    const admin = adminClient();

    if (action === "create_recipient") {
      await assertOrganizationFinanceManager(caller, organizationId, user.id);
      const type = safeString(body.type, 32);
      const name = safeString(body.name, 160);
      const accountNumber = safeString(body.accountNumber, 40).replace(/[\\s-]/g, "");
      const bankCode = safeString(body.bankCode, 32);
      if (!["mobile_money", "mobile_money_business", "kepss"].includes(type)
        || !name || !/^[+0-9]{6,32}$/.test(accountNumber) || !bankCode
        || (type === "mobile_money_business" && bankCode !== "MPTILL")) {
        return json(400, { error: "RECIPIENT_DETAILS_INVALID_OR_UNSUPPORTED" }, cors);
      }
      const created = await paystackRequest<{
        status: boolean;
        data: { recipient_code: string; active: boolean; name: string; type: string; details?: { bank_code?: string } };
      }>("/transferrecipient", {
        method: "POST",
        body: JSON.stringify({
          type, name, account_number: accountNumber, bank_code: bankCode, currency: "KES",
          description: `Mandate organization beneficiary ${organizationId}`,
        }),
      });
      const recipientCode = safeString(created.data?.recipient_code, 128);
      if (!recipientCode || created.data?.active !== true || !/^RCP_[A-Za-z0-9]+$/.test(recipientCode)) {
        return json(502, { error: "PAYSTACK_RECIPIENT_RESPONSE_INVALID" }, cors);
      }
      const { data: recipient, error } = await admin.from("organization_payout_recipients")
        .upsert({
          organization_id: organizationId,
          provider: "paystack",
          recipient_code: recipientCode,
          recipient_type: type,
          currency: "KES",
          beneficiary_name: name,
          bank_code: bankCode,
          masked_account: `••••${accountNumber.slice(-4)}`,
          active: true,
          created_by: user.id,
        }, { onConflict: "recipient_code" })
        .select("id,recipient_code,recipient_type,beneficiary_name,bank_code,masked_account,active,created_at")
        .single();
      if (error || !recipient) return json(500, { error: "RECIPIENT_RECORD_PERSIST_FAILED" }, cors);
      return json(200, { recipient }, cors);
    }

    if (action === "list_recipients") {
      await assertOrganizationFinanceManager(caller, organizationId, user.id);
      const { data, error } = await admin.from("organization_payout_recipients")
        .select("id,recipient_type,beneficiary_name,bank_code,masked_account,active,created_at")
        .eq("organization_id", organizationId).eq("active", true).order("created_at", { ascending: false });
      if (error) return json(500, { error: "RECIPIENT_LIST_FAILED" }, cors);
      return json(200, { recipients: data ?? [] }, cors);
    }

    if (action === "request_payout") {
      const recipientId = safeString(body.recipientId, 64);
      const amount = amountMinor(body.amountMinor);
      if (!recipientId || !amount) return json(400, { error: "PAYOUT_REQUEST_INVALID" }, cors);
      const { data, error } = await caller.rpc("request_organization_payout", {
        p_organization_id: organizationId,
        p_recipient_id: recipientId,
        p_amount_minor: amount,
      });
      if (error) return json(409, { error: safeString(error.message, 120) || "PAYOUT_REQUEST_REJECTED" }, cors);
      return json(200, { payout: data }, cors);
    }

    if (action === "approve_payout") {
      const payoutRequestId = safeString(body.payoutRequestId, 64);
      if (!payoutRequestId) return json(400, { error: "PAYOUT_REQUEST_ID_REQUIRED" }, cors);
      const { data: payout, error: payoutError } = await admin.from("payout_requests")
        .select("organization_id").eq("id", payoutRequestId).maybeSingle();
      if (payoutError || !payout) return json(404, { error: "PAYOUT_REQUEST_NOT_FOUND" }, cors);
      await assertOrganizationFinanceManager(caller, payout.organization_id, user.id);
      const { data, error } = await caller.rpc("approve_organization_payout", {
        p_payout_request_id: payoutRequestId,
      });
      if (error) return json(409, { error: safeString(error.message, 120) || "PAYOUT_APPROVAL_REJECTED" }, cors);
      return json(200, { payout: data }, cors);
    }

    if (action === "initiate_payout" || action === "verify_payout") {
      if (!transferCapabilityEnabled()) return json(503, { error: "PAYSTACK_TRANSFERS_DISABLED" }, cors);
      const payoutRequestId = safeString(body.payoutRequestId, 64);
      if (!payoutRequestId) return json(400, { error: "PAYOUT_REQUEST_ID_REQUIRED" }, cors);
      const { data: payout, error: payoutError } = await admin.from("payout_requests")
        .select("id,organization_id,status,provider_reference,amount_minor,currency")
        .eq("id", payoutRequestId).maybeSingle();
      if (payoutError || !payout) return json(404, { error: "PAYOUT_REQUEST_NOT_FOUND" }, cors);
      await assertOrganizationFinanceManager(caller, payout.organization_id, user.id);

      let reference = safeString(payout.provider_reference, 120);
      if (action === "initiate_payout") {
        const { data: claim, error: claimError } = await admin.rpc("claim_organization_payout", {
          p_payout_request_id: payoutRequestId,
        });
        if (claimError || !claim) return json(409, { error: "PAYOUT_NOT_READY_FOR_TRANSFER" }, cors);
        reference = safeString(claim.reference, 120);
        if (!reference || !claim.recipientCode) return json(500, { error: "PAYOUT_CLAIM_INVALID" }, cors);
        let started: PaystackTransferResponse;
        try {
          started = await paystackRequest<PaystackTransferResponse>("/transfer", {
            method: "POST",
            body: JSON.stringify({
              source: "balance",
              amount: Number(claim.amountMinor),
              recipient: String(claim.recipientCode),
              reference,
              reason: `Mandate organization payout ${payoutRequestId}`,
              currency: "KES",
            }),
          });
        } catch {
          // Keep the same reference and processing reservation. The caller may
          // retry safely with this reference; never create a second payout ref.
          return json(503, { error: "TRANSFER_OUTCOME_UNKNOWN", reference, retryWithSameRequest: true }, cors);
        }
        const transferCode = safeString(started.data?.transfer_code, 120);
        const providerStatus = safeString(started.data?.status, 32).toLowerCase();
        if (!started.status || !transferCode || !providerStatus) {
          return json(502, { error: "PAYSTACK_TRANSFER_RESPONSE_INVALID", reference }, cors);
        }
        const { error: persistError } = await admin.from("payout_requests").update({
          provider_transfer_code: transferCode,
          provider_status: providerStatus,
        }).eq("id", payoutRequestId);
        if (persistError) return json(500, { error: "TRANSFER_REFERENCE_PERSIST_FAILED", reference }, cors);
        if (!["success", "failed", "reversed"].includes(providerStatus)) {
          return json(200, { reference, transferCode, status: providerStatus, final: false }, cors);
        }
      }

      let verified: PaystackTransferResponse;
      try {
        verified = await paystackRequest<PaystackTransferResponse>(
          `/transfer/verify/${encodeURIComponent(reference)}`,
        );
      } catch {
        return json(202, { reference, status: "processing", final: false, reconciliationPending: true }, cors);
      }
      if (verified.data?.reference !== reference) {
        return json(409, { error: "TRANSFER_REFERENCE_MISMATCH", reference }, cors);
      }
      const result = await recordVerifiedTransfer(admin, verified.data, "api_verify");
      return json(200, { reference, transfer: result, providerStatus: verified.data.status }, cors);
    }

    return json(400, { error: "UNSUPPORTED_ACTION" }, cors);
  } catch (error) {
    const code = error instanceof Error ? error.message : "DISBURSEMENT_REQUEST_FAILED";
    const status = code === "AUTHENTICATION_REQUIRED" || code === "INVALID_SESSION" ? 401
      : code === "FORBIDDEN" ? 403
      : code === "PAYSTACK_MODE_CONFIG_INVALID" ? 503
      : 400;
    return json(status, { error: code }, cors);
  }
});
