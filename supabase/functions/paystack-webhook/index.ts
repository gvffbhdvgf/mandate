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
      processing_status: "processing",
    }, { onConflict: "provider_event_key", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();

  if (insertError) return json(500, { error: "WEBHOOK_EVENT_PERSIST_FAILED" });
  if (!inserted) return json(200, { received: true, duplicate: true });

  if (eventType !== "charge.success" || !reference) {
    await admin.from("payment_events").update({
      processing_status: "processed",
      processed_at: new Date().toISOString(),
    }).eq("id", inserted.id);
    return json(200, { received: true, processed: false });
  }

  try {
    const verified = await paystackRequest<PaystackVerifyResponse>(`/transaction/verify/${encodeURIComponent(reference)}`);
    const payment = verified.data;
    const { data: intent, error: intentError } = await admin
      .from("payment_intents")
      .select("id,provider_reference,amount_minor,currency,status")
      .eq("provider_reference", reference)
      .maybeSingle();

    if (intentError || !intent) {
      await admin.from("payment_events").update({ processing_status: "failed", processed_at: new Date().toISOString() }).eq("id", inserted.id);
      return json(200, { received: true, processed: false });
    }

    const matches = payment.status === "success"
      && payment.reference === intent.provider_reference
      && Number(payment.amount) === Number(intent.amount_minor)
      && payment.currency === intent.currency;

    await admin.from("payment_intents").update({
      status: matches ? "success" : "exception",
      provider_transaction_id: String(payment.id),
      verified_at: new Date().toISOString(),
    }).eq("id", intent.id);

    await admin.from("payment_events").update({
      processing_status: matches ? "processed" : "failed",
      processed_at: new Date().toISOString(),
    }).eq("id", inserted.id);

    return json(200, { received: true, processed: matches });
  } catch {
    await admin.from("payment_events").update({ processing_status: "failed", processed_at: new Date().toISOString() }).eq("id", inserted.id);
    return json(200, { received: true, processed: false });
  }
});
