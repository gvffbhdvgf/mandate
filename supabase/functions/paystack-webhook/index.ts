import { adminClient, json, paystackRequest, paymentsModeEnabled, verifyPaystackWebhookSignature } from "../_shared/paystack.ts";

type PaystackEvent = {
  event?: string;
  data?: {
    id?: number | string;
    reference?: string;
    transaction_reference?: string;
    transaction?: { reference?: string; id?: number | string };
    refund_reference?: string | null;
    dispute?: { id?: number | string };
    amount?: number | string;
    currency?: string;
    status?: string;
    fees_split?: { paystack?: number | string; integration?: number | string; subaccount?: number | string };
    subaccount?: { subaccount_code?: string; percentage_charge?: number | string };
  };
};
type PaystackVerifyResponse = {
  status: boolean;
  data: {
    id: number | string;
    status: string;
    reference: string;
    amount: number;
    currency: string;
    fees_split?: { paystack?: number | string; integration?: number | string; subaccount?: number | string };
    subaccount?: { subaccount_code?: string; percentage_charge?: number | string };
  };
};

const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
  if (!paymentsModeEnabled()) {
    return json(503, { error: "PAYMENTS_DISABLED", message: "Webhook processing is restricted to configured Paystack test credentials. Live transactions remain disabled." });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("Paystack-Signature");
  if (!await verifyPaystackWebhookSignature(rawBody, signature)) {
    return json(401, { error: "INVALID_WEBHOOK_SIGNATURE" });
  }

  let event: PaystackEvent;
  try {
    event = JSON.parse(rawBody) as PaystackEvent;
  } catch {
    return json(400, { error: "INVALID_WEBHOOK_BODY" });
  }

  const eventType = event.event ?? "unknown";
  const data = event.data ?? {};
  const reference = data.reference ?? data.transaction_reference ?? data.transaction?.reference ?? null;
  const transactionId = eventType === "charge.success"
    ? (data.id == null ? null : String(data.id))
    : (data.transaction?.id == null ? null : String(data.transaction.id));
  const resourceId = data.id ?? data.refund_reference ?? data.dispute?.id ?? null;
  const eventIdentity = resourceId == null ? await sha256Hex(rawBody) : String(resourceId);
  const eventKey = `paystack:${eventType}:${eventIdentity}`;
  const admin = adminClient();

  const { data: inserted, error: insertError } = await admin
    .from("payment_events")
    .upsert({
      provider: "paystack",
      provider_event_key: eventKey,
      provider_reference: reference,
      event_type: eventType,
      signature_verified: true,
      redacted_payload: {
        status: data.status ?? null,
        amount: data.amount == null ? null : String(data.amount),
        currency: data.currency ?? null,
        transaction_id: transactionId,
        resource_id: resourceId == null ? null : String(resourceId),
        refund_reference: data.refund_reference ?? null,
      },
      processing_status: "received",
    }, { onConflict: "provider_event_key", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();

  if (insertError) return json(500, { error: "WEBHOOK_EVENT_PERSIST_FAILED" });

  let eventId = inserted?.id as string | undefined;
  if (!eventId) {
    const { data: existing, error: existingError } = await admin
      .from("payment_events")
      .select("id,processing_status")
      .eq("provider_event_key", eventKey)
      .maybeSingle();
    if (existingError || !existing) return json(500, { error: "WEBHOOK_EVENT_LOOKUP_FAILED" });
    if (existing.processing_status === "processed") {
      return json(200, { received: true, duplicate: true });
    }
    eventId = existing.id;
  }

  // Refunds may be partial and disputes may resolve without a refund. A signed
  // notification therefore freezes the payment for reconciliation; it does not
  // automatically reverse the receipt or revoke already-consumed entitlements.
  if (eventType.startsWith("refund.") || eventType.startsWith("charge.dispute.")) {
    if (!reference) {
      await admin.from("payment_events").update({
        processing_status: "failed",
        processed_at: null,
      }).eq("id", eventId);
      return json(503, { error: "PAYSTACK_EXCEPTION_REFERENCE_MISSING" });
    }

    let verifiedException: PaystackVerifyResponse;
    try {
      verifiedException = await paystackRequest<PaystackVerifyResponse>(
        `/transaction/verify/${encodeURIComponent(reference)}`,
      );
    } catch {
      await admin.from("payment_events").update({
        processing_status: "failed",
        processed_at: null,
      }).eq("id", eventId);
      return json(503, { error: "PAYSTACK_EXCEPTION_VERIFICATION_UNAVAILABLE" });
    }

    const exceptionAmountMinor = Number(verifiedException.data.amount);
    if (!Number.isSafeInteger(exceptionAmountMinor) || exceptionAmountMinor <= 0) {
      await admin.from("payment_events").update({
        processing_status: "failed",
        processed_at: null,
      }).eq("id", eventId);
      return json(503, { error: "PAYSTACK_EXCEPTION_AMOUNT_INVALID" });
    }

    if (verifiedException.data.reference !== reference) {
      const { error } = await admin.from("payment_events").update({
        processing_status: "failed",
        processed_at: null,
        redacted_payload: {
          status: verifiedException.data.status,
          amount: String(verifiedException.data.amount),
          currency: verifiedException.data.currency,
          transaction_id: String(verifiedException.data.id),
          verified_reference: verifiedException.data.reference,
          reason: "PAYSTACK_REFERENCE_MISMATCH",
        },
      }).eq("id", eventId);
      if (error) return json(500, { error: "PAYMENT_EXCEPTION_RECONCILIATION_PERSIST_FAILED" });
      return json(200, { received: true, processed: false, reconciliationRequired: true, reason: "PAYSTACK_REFERENCE_MISMATCH" });
    }

    const { data: result, error } = await admin.rpc("apply_verified_paystack_payment_exception_event", {
      p_event_id: eventId,
      p_provider_reference: reference,
      p_provider_transaction_id: String(verifiedException.data.id),
      p_provider_status: verifiedException.data.status,
      p_amount_minor: exceptionAmountMinor,
      p_currency: verifiedException.data.currency,
    });
    if (error || !result) return json(500, { error: "PAYMENT_EXCEPTION_PROCESSING_FAILED" });
    if (result.processed !== true) return json(503, { error: "PAYMENT_EXCEPTION_RECONCILIATION_REQUIRED" });
    return json(200, {
      received: true,
      processed: true,
      duplicate: result.duplicate === true,
      status: typeof result.status === "string" ? result.status : "exception",
      providerStatus: typeof result.provider_status === "string" ? result.provider_status : undefined,
      reconciliationRequired: true,
    });
  }

  if (eventType !== "charge.success" || !reference) {
    const { error } = await admin.from("payment_events").update({
      processing_status: "processed",
      processed_at: new Date().toISOString(),
    }).eq("id", eventId);
    if (error) return json(500, { error: "WEBHOOK_EVENT_FINALIZE_FAILED" });
    return json(200, { received: true, processed: false });
  }

  const { data: intent, error: intentError } = await admin
    .from("payment_intents")
    .select("purpose")
    .eq("provider_reference", reference)
    .maybeSingle();
  if (intentError) return json(500, { error: "PAYMENT_INTENT_LOOKUP_FAILED" });
  if (!intent) return json(404, { error: "PAYMENT_INTENT_NOT_FOUND" });
  // A purpose gate controls creation of new checkouts, never settlement of an
  // already-created intent. Verify every signed success event and let the
  // database fulfillment trigger issue public credits atomically when eligible.

  let verified: PaystackVerifyResponse;
  try {
    verified = await paystackRequest<PaystackVerifyResponse>(`/transaction/verify/${encodeURIComponent(reference)}`);
  } catch {
    const { error } = await admin.from("payment_events").update({
      processing_status: "failed",
      processed_at: null,
    }).eq("id", eventId);
    if (error) return json(500, { error: "WEBHOOK_RETRY_STATE_PERSIST_FAILED" });
    return json(503, { error: "PAYSTACK_VERIFICATION_UNAVAILABLE" });
  }

  const amountMinor = Number(verified.data.amount);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return json(409, { error: "PAYSTACK_AMOUNT_INVALID" });
  }

  if (verified.data.reference !== reference) {
    const { error } = await admin.from("payment_events").update({
      processing_status: "failed",
      processed_at: null,
      redacted_payload: {
        status: verified.data.status,
        amount: String(verified.data.amount),
        currency: verified.data.currency,
        transaction_id: String(verified.data.id),
        verified_reference: verified.data.reference,
        reason: "PAYSTACK_REFERENCE_MISMATCH",
      },
    }).eq("id", eventId);
    if (error) return json(500, { error: "WEBHOOK_RECONCILIATION_STATE_PERSIST_FAILED" });
    return json(200, { received: true, processed: false, reconciliationRequired: true, reason: "PAYSTACK_REFERENCE_MISMATCH" });
  }

  if (intent.purpose === "public_vote_credits") {
    const feesSplit = verified.data.fees_split;
    const subaccount = verified.data.subaccount;
    const paystackFee = Number(feesSplit?.paystack);
    const integrationShare = Number(feesSplit?.integration);
    const organizerShare = Number(feesSplit?.subaccount);
    const subaccountPercentageCharge = subaccount?.percentage_charge == null ? null : Number(subaccount.percentage_charge);
    if (!feesSplit || feesSplit.paystack == null || feesSplit.integration == null || feesSplit.subaccount == null
      || (subaccountPercentageCharge !== null
        && (!Number.isFinite(subaccountPercentageCharge) || subaccountPercentageCharge < 0))
      || !Number.isSafeInteger(paystackFee) || paystackFee < 0
      || !Number.isSafeInteger(integrationShare) || integrationShare < 0
      || !Number.isSafeInteger(organizerShare) || organizerShare < 0
      || !subaccount?.subaccount_code) {
      const { error } = await admin.from("payment_events").update({ processing_status: "failed", processed_at: null }).eq("id", eventId);
      if (error) return json(500, { error: "WEBHOOK_RETRY_STATE_PERSIST_FAILED" });
      return json(503, { error: "PAYSTACK_SPLIT_FACTS_UNAVAILABLE" });
    }
    const { data: splitResult, error: splitError } = await admin.rpc("apply_verified_paystack_public_vote_split", {
      p_event_id: eventId,
      p_provider_reference: reference,
      p_provider_transaction_id: String(verified.data.id),
      p_provider_status: verified.data.status,
      p_amount_minor: amountMinor,
      p_currency: verified.data.currency,
      p_fees_split: { paystack: paystackFee, integration: integrationShare, subaccount: organizerShare },
      p_subaccount_code: subaccount.subaccount_code,
      p_subaccount_percentage_charge: subaccountPercentageCharge,
    });
    if (splitError || !splitResult) return json(500, { error: "PUBLIC_VOTE_SPLIT_PROCESSING_FAILED" });
    return json(200, {
      received: true,
      processed: splitResult.processed === true,
      duplicate: splitResult.duplicate === true,
      matched: splitResult.matched === true,
      status: typeof splitResult.status === "string" ? splitResult.status : undefined,
      reason: typeof splitResult.reason === "string" ? splitResult.reason : undefined,
    });
  }

  const { data: result, error: applyError } = await admin.rpc("apply_verified_paystack_webhook_event", {
    p_event_id: eventId,
    p_provider_reference: reference,
    p_provider_transaction_id: String(verified.data.id),
    p_provider_status: verified.data.status,
    p_amount_minor: amountMinor,
    p_currency: verified.data.currency,
  });

  if (applyError || !result) return json(500, { error: "WEBHOOK_PROCESSING_FAILED" });
  return json(200, {
    received: true,
    processed: result.processed === true,
    duplicate: result.duplicate === true,
    matched: result.matched === true,
    status: typeof result.status === "string" ? result.status : undefined,
  });
});
