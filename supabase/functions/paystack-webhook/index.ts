import { adminClient, env, json, paystackRequest, verifyPaystackWebhookSignature } from "../_shared/paystack.ts";

type PaystackEvent = {
  event?: string;
  data?: {
    id?: number | string;
    reference?: string;
    amount?: number;
    currency?: string;
    status?: string;
  };
};
type PaystackVerifyResponse = {
  status: boolean;
  data: { id: number | string; status: string; reference: string; amount: number; currency: string };
};

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
  if (!env("PAYSTACK_WEBHOOK_SECRET")) return json(503, { error: "PAYSTACK_WEBHOOK_SECRET_MISSING" });

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
  const reference = event.data?.reference ?? null;
  const transactionId = event.data?.id == null ? null : String(event.data.id);
  const eventKey = `paystack:${eventType}:${transactionId ?? reference ?? crypto.randomUUID()}`;
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
        status: event.data?.status ?? null,
        amount: event.data?.amount ?? null,
        currency: event.data?.currency ?? null,
        transaction_id: transactionId,
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

  if (eventType !== "charge.success" || !reference) {
    const { error } = await admin.from("payment_events").update({
      processing_status: "processed",
      processed_at: new Date().toISOString(),
    }).eq("id", eventId);
    if (error) return json(500, { error: "WEBHOOK_EVENT_FINALIZE_FAILED" });
    return json(200, { received: true, processed: false });
  }

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
