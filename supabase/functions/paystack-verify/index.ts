import { adminClient, assertOrganizationManager, authenticate, corsHeaders, json, paystackRequest, paymentPurposeEnabled, paymentsModeEnabled } from "../_shared/paystack.ts";

type PaystackVerifyResponse = {
  status: boolean;
  data: {
    id: number | string;
    status: string;
    reference: string;
    amount: number;
    currency: string;
  };
};

Deno.serve(async (request: Request) => {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" }, cors);

  try {
    if (!paymentsModeEnabled()) {
      return json(503, { error: "PAYMENTS_DISABLED", message: "A valid mode-specific Paystack configuration is required." }, cors);
    }

    const { user, caller } = await authenticate(request);
    const body = await request.json().catch(() => null) as { reference?: string } | null;
    if (!body?.reference || !/^[A-Za-z0-9.=-]{8,100}$/.test(body.reference)) {
      return json(400, { error: "INVALID_PAYMENT_REFERENCE" }, cors);
    }

    const admin = adminClient();
    const { data: intent, error } = await admin
      .from("payment_intents")
      .select("id,organization_id,purpose,provider_reference,amount_minor,currency,status")
      .eq("provider_reference", body.reference)
      .maybeSingle();
    if (error || !intent) return json(404, { error: "PAYMENT_INTENT_NOT_FOUND" }, cors);
    if (!intent.organization_id) return json(409, { error: "PAYMENT_INTENT_REQUIRES_ORGANIZATION" }, cors);
    if (!paymentPurposeEnabled(intent.purpose)) return json(503, { error: "PAYMENT_PURPOSE_DISABLED" }, cors);
    if (intent.purpose === "public_vote_credits") return json(409, { error: "PAID_VOTING_FEATURE_GATED" }, cors);
    await assertOrganizationManager(caller, intent.organization_id, user.id);

    const result = await paystackRequest<PaystackVerifyResponse>(`/transaction/verify/${encodeURIComponent(body.reference)}`);
    const payment = result.data;
    const amountMatches = Number(payment.amount) === Number(intent.amount_minor);
    const currencyMatches = payment.currency === intent.currency;
    const referenceMatches = payment.reference === intent.provider_reference;
    const isSuccess = payment.status === "success" && amountMatches && currencyMatches && referenceMatches;

    const nextStatus = payment.status === "success" && !isSuccess ? "exception"
      : payment.status === "success" ? "success"
      : payment.status === "failed" ? "failed"
      : payment.status === "abandoned" ? "abandoned"
      : "pending";

    const { error: updateError } = await admin
      .from("payment_intents")
      .update({
        status: nextStatus,
        provider_transaction_id: String(payment.id),
        verified_at: new Date().toISOString(),
      })
      .eq("id", intent.id);
    if (updateError) return json(500, { error: "PAYMENT_VERIFICATION_PERSIST_FAILED" }, cors);

    if (payment.status === "success" && !isSuccess) {
      return json(409, { error: "PAYMENT_MISMATCH", status: nextStatus }, cors);
    }
    return json(200, { status: nextStatus, reference: payment.reference, verified: isSuccess });
  } catch (error) {
    const code = error instanceof Error ? error.message : "PAYMENT_VERIFICATION_FAILED";
    const status = code === "AUTHENTICATION_REQUIRED" || code === "INVALID_SESSION" ? 401
      : code === "FORBIDDEN" ? 403
      : code === "PAYSTACK_MODE_CONFIG_INVALID" || code === "SUPABASE_FUNCTION_CONFIG_MISSING" ? 503
      : 500;
    return json(status, { error: code }, cors);
  }
});
